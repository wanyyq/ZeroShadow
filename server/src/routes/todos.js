import { Router } from "express"
import { requireRole } from "../auth.js"
import { getConfig } from "../config.js"
import { createTodo, deleteTodo, getTodo, listTodos, setTodoDone, updateTodo } from "../todos.js"
import { findById, listMembers } from "../users.js"
import { getGroup, groupsForUser, leaderHasCap } from "../groups.js"
import { info } from "../logger.js"

const router = Router()

router.use(requireRole("superadmin", "member"))
// 访客不允许访问团队 Todo

function actor(req) {
  return { user: req.auth.username || "guest", role: req.auth.role, ip: req.ip }
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function memberName(id) {
  const user = findById(id)
  return user ? user.username : ""
}

/** 请求者作为组长（且开启 manageTodo）的小组列表 */
function leaderGroups(req) {
  if (req.auth.role !== "member" || !req.auth.userId) return []
  return groupsForUser(req.auth.userId).filter((g) => leaderHasCap(g, req.auth.userId, "manageTodo"))
}

function isCreator(todo, req) {
  if (!todo) return false
  if (todo.createdById && req.auth.userId && todo.createdById === req.auth.userId) return true
  return !!todo.createdBy && todo.createdBy === req.auth.username
}

/** 组长对某 Todo 是否有管理权（scope 组：本组；scope 成员：该成员所在且自己是组长的小组） */
function leaderCanManage(todo, req) {
  const groups = leaderGroups(req)
  if (!groups.length) return false
  if (todo.scope === "group") return groups.some((g) => g.id === todo.groupId)
  if (todo.scope === "member") return groups.some((g) => g.members.includes(todo.memberId))
  return false
}

function isInAudience(todo, req) {
  if (req.auth.role === "superadmin") return true
  if (req.auth.role !== "member") return false
  if (todo.scope === "all") return true
  if (todo.scope === "group") {
    const group = getGroup(todo.groupId)
    return !!group && group.members.includes(req.auth.userId)
  }
  if (todo.scope === "member") return todo.memberId === req.auth.userId
  return false
}

function canManage(todo, req) {
  return req.auth.role === "superadmin" || isCreator(todo, req) || leaderCanManage(todo, req)
}

function canEdit(todo, req) {
  if (canManage(todo, req)) return true
  return !!todo.allowAssigneeEdit && isInAudience(todo, req)
}

function canComplete(todo, req) {
  return canManage(todo, req) || isInAudience(todo, req)
}

function canView(todo, req) {
  return canManage(todo, req) || isInAudience(todo, req)
}

function decorate(todo, req) {
  return {
    ...todo,
    groupName: todo.groupId ? getGroup(todo.groupId)?.name || "" : "",
    memberName: todo.memberId ? memberName(todo.memberId) : "",
    canEdit: canEdit(todo, req),
    canComplete: canComplete(todo, req),
    canManage: canManage(todo, req),
  }
}

function validateTarget(data, req) {
  if (data.scope === "all") {
    if (req.auth.role !== "superadmin") throw httpError(403, "只有超级管理员可以创建全体 Todo")
    return { scope: "all", groupId: "", memberId: "" }
  }
  const leaders = leaderGroups(req)
  if (data.scope === "group") {
    const group = getGroup(String(data.groupId || ""))
    if (!group) throw httpError(400, "小组不存在")
    const allowed = req.auth.role === "superadmin" || leaders.some((g) => g.id === group.id)
    if (!allowed) throw httpError(403, "没有权限向该小组下发 Todo")
    return { scope: "group", groupId: group.id, memberId: "" }
  }
  if (data.scope === "member") {
    const memberId = String(data.memberId || "")
    const user = findById(memberId)
    if (!user) throw httpError(400, "成员不存在")
    const allowed =
      req.auth.role === "superadmin" || leaders.some((g) => g.members.includes(memberId))
    if (!allowed) throw httpError(403, "没有权限向该成员下发 Todo")
    return { scope: "member", groupId: "", memberId }
  }
  throw httpError(400, "作用域无效")
}

router.get("/", (req, res) => {
  if (getConfig().todoEnabled === false) return res.json({ todos: [], enabled: false })
  const status = String(req.query.status || "all")
  const scope = String(req.query.scope || "all")
  const q = String(req.query.q || "").trim().toLowerCase()
  let rows = listTodos().filter((t) => canView(t, req))
  if (status === "open") rows = rows.filter((t) => !t.done)
  else if (status === "done") rows = rows.filter((t) => t.done)
  if (["all", "group", "member"].includes(scope) && scope !== "all") {
    rows = rows.filter((t) => t.scope === scope)
  }
  if (q) rows = rows.filter((t) => t.title.toLowerCase().includes(q) || t.note.toLowerCase().includes(q))
  const priorityRank = { high: 0, normal: 1, low: 2 }
  rows = [...rows].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1
    if (a.dueAt && !b.dueAt) return -1
    if (!a.dueAt && b.dueAt) return 1
    return (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1)
  })
  res.json({
    todos: rows.map((t) => decorate(t, req)),
    enabled: true,
    canCreateAll: req.auth.role === "superadmin",
    leaderGroups: leaderGroups(req).map((g) => ({ id: g.id, name: g.name })),
    members: listMembers().map((m) => ({ id: m.id, username: m.username })),
  })
})

router.post("/", async (req, res, next) => {
  try {
    if (getConfig().todoEnabled === false) throw httpError(403, "Todo 功能已关闭")
    const title = String(req.body?.title || "").trim()
    if (!title || title.length > 200) throw httpError(400, "标题不能为空且不超过 200 字")
    const target = validateTarget(req.body || {}, req)
    const todo = await createTodo({
      title,
      note: String(req.body?.note || "").slice(0, 2000),
      priority: req.body?.priority,
      dueAt: req.body?.dueAt || null,
      allowAssigneeEdit: !!req.body?.allowAssigneeEdit,
      ...target,
      createdBy: req.auth.username || "",
      createdById: req.auth.userId || null,
      createdByRole: req.auth.role,
    })
    info("todo_create", { msg: `${todo.title} (${todo.scope})`, ...actor(req) })
    res.json({ todo: decorate(todo, req) })
  } catch (err) {
    next(err)
  }
})

router.patch("/:id", async (req, res, next) => {
  try {
    const todo = getTodo(String(req.params.id))
    if (!todo) throw httpError(404, "Todo 不存在")
    if (getConfig().todoEnabled === false) throw httpError(403, "Todo 功能已关闭")
    const patch = {}
    // 内容字段：有编辑权即可
    if (req.body?.title !== undefined) {
      const title = String(req.body.title).trim()
      if (!title || title.length > 200) throw httpError(400, "标题不能为空且不超过 200 字")
      patch.title = title
    }
    if (req.body?.note !== undefined) patch.note = String(req.body.note).slice(0, 2000)
    if (req.body?.priority !== undefined) patch.priority = req.body.priority
    if (req.body?.dueAt !== undefined) patch.dueAt = req.body.dueAt || null
    if (req.body?.allowAssigneeEdit !== undefined && canManage(todo, req)) {
      patch.allowAssigneeEdit = !!req.body.allowAssigneeEdit
    }
    // 作用域变更：仅管理者，且重新校验目标
    if (req.body?.scope !== undefined && canManage(todo, req)) {
      const target = validateTarget(req.body, req)
      Object.assign(patch, target)
    }
    if (!Object.keys(patch).length) throw httpError(400, "没有可更新的字段")
    if (!canEdit(todo, req)) throw httpError(403, "没有权限编辑该 Todo")
    const updated = await updateTodo(todo.id, patch)
    info("todo_update", { msg: updated.title, ...actor(req) })
    res.json({ todo: decorate(updated, req) })
  } catch (err) {
    next(err)
  }
})

router.post("/:id/done", async (req, res, next) => {
  try {
    const todo = getTodo(String(req.params.id))
    if (!todo) throw httpError(404, "Todo 不存在")
    if (!canComplete(todo, req)) throw httpError(403, "没有权限完成该 Todo")
    const done = req.body?.done === undefined ? !todo.done : !!req.body.done
    const updated = await setTodoDone(todo.id, done, req.auth.username || "guest")
    info("todo_done", { msg: `${updated.title} → ${done ? "完成" : "未完成"}`, ...actor(req) })
    res.json({ todo: decorate(updated, req) })
  } catch (err) {
    next(err)
  }
})

router.delete("/:id", async (req, res, next) => {
  try {
    const todo = getTodo(String(req.params.id))
    if (!todo) throw httpError(404, "Todo 不存在")
    if (!canManage(todo, req)) throw httpError(403, "没有权限删除该 Todo")
    await deleteTodo(todo.id)
    info("todo_delete", { msg: todo.title, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
