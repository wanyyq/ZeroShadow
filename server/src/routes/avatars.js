import express, { Router } from "express"
import { requireRole } from "../auth.js"
import { getConfig } from "../config.js"
import {
  SUPER_OWNER,
  avatarPath,
  deleteAvatar,
  getAvatar,
  isValidOwner,
  listAvatars,
  ownerForUser,
  saveAvatar,
} from "../avatars.js"
import { findById } from "../users.js"
import { groupsForUser, leaderHasCap } from "../groups.js"
import { info } from "../logger.js"

const router = Router()

function actor(req) {
  return { user: req.auth.username || "guest", role: req.auth.role, ip: req.ip }
}

function ownerForRequest(req) {
  if (req.auth.role === "superadmin") return SUPER_OWNER
  return req.auth.userId ? ownerForUser(req.auth.userId) : null
}

/** 判断请求者是否有权修改某 owner 的头像 */
function canEditOwner(req, owner) {
  if (req.auth.role === "superadmin") return true
  if (req.auth.role !== "member") return false
  if (owner === ownerForUser(req.auth.userId)) return true
  const targetId = owner.startsWith("u-") ? owner.slice(2) : null
  if (!targetId) return false
  if (!findById(targetId)) return false
  // 组长：在其作为组长且开启 editMemberAvatar 的小组内，可修改本组成员头像
  const groups = groupsForUser(req.auth.userId)
  return groups.some((g) => g.members.includes(targetId) && leaderHasCap(g, req.auth.userId, "editMemberAvatar"))
}

router.get("/", requireRole("superadmin", "member"), (_req, res) => {
  res.json({ avatars: listAvatars(), enabled: getConfig().avatarEnabled !== false })
})

router.get("/:owner", requireRole("superadmin", "member"), (req, res, next) => {
  try {
    const owner = String(req.params.owner || "")
    if (!isValidOwner(owner)) return res.status(400).json({ error: "头像标识无效" })
    const meta = getAvatar(owner)
    if (!meta) return res.status(404).json({ error: "头像不存在" })
    res.setHeader("Content-Type", "image/webp")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("ETag", `"${meta.md5}"`)
    // 条件请求命中则回 304，避免重复传输
    if (req.headers["if-none-match"] === `"${meta.md5}"`) return res.status(304).end()
    res.sendFile(avatarPath(owner), (err) => {
      if (err && !res.headersSent) next(err)
    })
  } catch (err) {
    next(err)
  }
})

const rawImage = express.raw({ type: ["image/webp", "application/octet-stream"], limit: "2mb" })

router.post("/me", requireRole("superadmin", "member"), rawImage, (req, res, next) => {
  try {
    if (getConfig().avatarEnabled === false) return res.status(403).json({ error: "头像功能已关闭" })
    const owner = ownerForRequest(req)
    if (!owner) return res.status(400).json({ error: "无法确定账户标识" })
    const meta = saveAvatar(owner, req.body)
    info("avatar_update", { msg: owner, ...actor(req) })
    res.json({ owner: meta.owner, md5: meta.md5, size: meta.size })
  } catch (err) {
    next(err)
  }
})

router.post("/:owner", requireRole("superadmin", "member"), rawImage, (req, res, next) => {
  try {
    if (getConfig().avatarEnabled === false) return res.status(403).json({ error: "头像功能已关闭" })
    const owner = String(req.params.owner || "")
    if (!isValidOwner(owner)) return res.status(400).json({ error: "头像标识无效" })
    if (!canEditOwner(req, owner)) return res.status(403).json({ error: "没有权限修改该头像" })
    const meta = saveAvatar(owner, req.body)
    info("avatar_update", { msg: owner, ...actor(req) })
    res.json({ owner: meta.owner, md5: meta.md5, size: meta.size })
  } catch (err) {
    next(err)
  }
})

router.delete("/:owner", requireRole("superadmin", "member"), (req, res, next) => {
  try {
    const owner = String(req.params.owner || "")
    if (!isValidOwner(owner)) return res.status(400).json({ error: "头像标识无效" })
    if (!canEditOwner(req, owner)) return res.status(403).json({ error: "没有权限修改该头像" })
    deleteAvatar(owner)
    info("avatar_delete", { msg: owner, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
