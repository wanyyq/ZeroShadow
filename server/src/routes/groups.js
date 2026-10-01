import { Router } from "express"
import { requireRole } from "../auth.js"
import { findById, listMembers } from "../users.js"
import { addMembers, getGroup, groupsForUser, leaderHasCap, listGroups, updateGroup } from "../groups.js"
import { info } from "../logger.js"

// ============================================================================
//  routes/groups.js - 组长自助管理（受超管为小组勾选的 leaderCaps 约束）
//
//    GET    /api/groups                 我作为组长（或超管）可管理的小组
//    GET    /api/groups/:id/members     查看本组成员（viewMembers）
//    POST   /api/groups/:id/members     增删本组成员（manageMembers）
//    PATCH  /api/groups/:id             调整本组可见范围（manageMembers）
// ============================================================================

const router = Router()
router.use(requireRole("superadmin", "member"))

function actor(req) {
  return { user: req.auth.username || "guest", role: req.auth.role, ip: req.ip }
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function isLeader(req, group) {
  return !!group && req.auth.userId && group.leaders.includes(req.auth.userId)
}

function publicMember(id) {
  const u = findById(id)
  return u ? { id: u.id, username: u.username, disabled: !!u.disabled, createdAt: u.createdAt } : null
}

/** 请求者可管理的小组（超管可管理全部） */
function manageableGroups(req) {
  if (req.auth.role === "superadmin") return listGroups()
  const led = groupsForUser(req.auth.userId).filter((g) => g.leaders.includes(req.auth.userId))
  return led.filter((g) => g.leaderCaps.viewMembers || g.leaderCaps.manageMembers || g.leaderCaps.manageTodo)
}

function serialize(req, group) {
  const isSuper = req.auth.role === "superadmin"
  const canView = isSuper || !!group.leaderCaps.viewMembers
  const canManage = isSuper || !!group.leaderCaps.manageMembers
  return {
    id: group.id,
    name: group.name,
    color: group.color,
    leaderCaps: group.leaderCaps,
    isLeader: isLeader(req, group),
    canViewMembers: canView,
    canManageMembers: canManage,
    canManageTodo: isSuper || !!group.leaderCaps.manageTodo,
    whitelist: group.whitelist,
    blacklist: group.blacklist,
    memberCount: group.members.length,
    members: canView ? group.members.map(publicMember).filter(Boolean) : [],
  }
}

router.get("/", (req, res) => {
  res.json({
    groups: manageableGroups(req).map((g) => serialize(req, g)),
    allMembers: listMembers(),
  })
})

router.get("/:id/members", (req, res, next) => {
  try {
    const group = getGroup(String(req.params.id))
    if (!group) throw httpError(404, "小组不存在")
    const isSuper = req.auth.role === "superadmin"
    if (!isSuper && !isLeader(req, group)) throw httpError(403, "没有权限")
    if (!isSuper && !group.leaderCaps.viewMembers) throw httpError(403, "组长未获授权查看成员")
    res.json({ members: group.members.map(publicMember).filter(Boolean) })
  } catch (err) {
    next(err)
  }
})

router.post("/:id/members", async (req, res, next) => {
  try {
    const group = getGroup(String(req.params.id))
    if (!group) throw httpError(404, "小组不存在")
    const isSuper = req.auth.role === "superadmin"
    if (!isSuper && !(isLeader(req, group) && group.leaderCaps.manageMembers)) {
      throw httpError(403, "没有权限管理该小组成员")
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []
    const action = req.body?.action === "remove" ? "remove" : "add"
    if (action === "add") {
      for (const id of ids) {
        if (!findById(id)) throw httpError(400, "包含不存在的成员")
      }
    }
    const updated = await addMembers(group.id, ids, action)
    info("group_update", { msg: `${updated.name} 成员${action === "add" ? "新增" : "移除"}`, ...actor(req) })
    res.json({ group: serialize(req, updated) })
  } catch (err) {
    next(err)
  }
})

router.patch("/:id", async (req, res, next) => {
  try {
    const group = getGroup(String(req.params.id))
    if (!group) throw httpError(404, "小组不存在")
    const isSuper = req.auth.role === "superadmin"
    if (!isSuper && !(isLeader(req, group) && group.leaderCaps.manageMembers)) {
      throw httpError(403, "没有权限调整该小组可见范围")
    }
    // 组长只能改可见范围；名称/颜色/权限等仍归超管
    const patch = {}
    if (req.body?.whitelist !== undefined) patch.whitelist = req.body.whitelist
    if (req.body?.blacklist !== undefined) patch.blacklist = req.body.blacklist
    if (!Object.keys(patch).length) throw httpError(400, "没有可更新的字段")
    const updated = await updateGroup(group.id, patch)
    info("group_update", { msg: `${updated.name} 可见范围调整`, ...actor(req) })
    res.json({ group: serialize(req, updated) })
  } catch (err) {
    next(err)
  }
})

export default router
