import { Router } from "express"
import { env } from "../env.js"
import {
  COOKIE_NAME,
  cookieOptions,
  loginLocked,
  recordLoginFail,
  recordLoginSuccess,
  requirePerm,
  requireRole,
  signToken,
  verifySuperPassword,
} from "../auth.js"
import { effectivePerms, uploadLimitMB } from "../config.js"
import bcrypt from "bcryptjs"
import { verifyLogin, findById, resetPassword } from "../users.js"
import { groupsForUser, listGroups } from "../groups.js"
import { info, warn } from "../logger.js"

const router = Router()

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

router.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim()
  const password = String(req.body?.password || "")
  if (!username || !password) return res.status(400).json({ error: "请输入用户名和密码" })
  if (username.length > 64 || password.length > 256) {
    return res.status(400).json({ error: "用户名或密码格式不正确" })
  }

  const lockedMinutes = loginLocked(req.ip, username)
  if (lockedMinutes) {
    return res.status(429).json({ error: `尝试次数过多，请约 ${lockedMinutes} 分钟后再试` })
  }

  let auth = null
  if (username === env.superUser && verifySuperPassword(password)) {
    auth = { role: "superadmin", username: env.superUser }
  } else if (username !== env.superUser) {
    const result = await verifyLogin(username, password)
    if (result.ok) {
      auth = {
        role: "member",
        username: result.user.username,
        userId: result.user.id,
        tokenVersion: result.user.tokenVersion,
      }
    } else if (result.reason === "disabled") {
      warn("login_fail", { msg: "账户已被禁用", user: username, ip: req.ip })
      return res.status(403).json({ error: "该账户已被禁用" })
    }
  }

  if (!auth) {
    recordLoginFail(req.ip, username)
    warn("login_fail", { msg: "用户名或密码错误", user: username, ip: req.ip })
    return res.status(401).json({ error: "用户名或密码错误" })
  }

  recordLoginSuccess(req.ip, username)
  res.cookie(COOKIE_NAME, signToken(auth), cookieOptions(req))
  info("login_success", { user: auth.username, role: auth.role, ip: req.ip })
  res.json({ role: auth.role, username: auth.username })
})

router.post("/change-password", requireRole("superadmin", "member"), requirePerm("changePassword"), async (req, res, next) => {
  try {
    const oldPwd = String(req.body?.oldPassword || "")
    const newPwd = String(req.body?.newPassword || "")
    if (!oldPwd || !newPwd) throw httpError(400, "请输入旧密码和新密码")
    if (newPwd.length < 6 || newPwd.length > 128) throw httpError(400, "新密码长度需为 6-128 位")

    if (req.auth.role === "superadmin") {
      throw httpError(400, "超级管理员密码请直接编辑 .env 中 SUPER_ADMIN_PASSWORD，改后重启服务生效")
    }

    const user = findById(req.auth.userId)
    if (!user) throw httpError(404, "用户不存在")
    const ok = await bcrypt.compare(oldPwd, user.passwordHash)
    if (!ok) throw httpError(403, "旧密码错误")

    const error = await resetPassword(req.auth.userId, newPwd)
    if (error) throw httpError(400, error)
    res.clearCookie(COOKIE_NAME, { path: "/" })
    info("password_change", { user: req.auth.username, role: req.auth.role })
    res.json({ ok: true, message: "密码已修改，请重新登录" })
  } catch (err) {
    next(err)
  }
})

router.post("/logout", requireRole("superadmin", "member"), (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" })
  info("logout", { user: req.auth.username, role: req.auth.role, ip: req.ip })
  res.json({ ok: true })
})

function publicGroup(g) {
  return { id: g.id, name: g.name, color: g.color, leaders: g.leaders }
}

/** 当前用户可切换的小组上下文（超管可切换全部） */
router.get("/groups", (req, res) => {
  if (req.auth.role === "superadmin") {
    res.json({ groups: listGroups().map(publicGroup) })
  } else if (req.auth.role === "member") {
    res.json({ groups: groupsForUser(req.auth.userId).map(publicGroup) })
  } else {
    res.json({ groups: [] })
  }
})

router.get("/me", (req, res) => {
  const { role, username } = req.auth
  res.json({
    role,
    username,
    userId: req.auth.userId || null,
    perms: req.perms || effectivePerms(role, req.group),
    uploadLimitMB: uploadLimitMB(role),
    groupId: req.groupId || "default",
    group: req.group ? publicGroup(req.group) : null,
  })
})

export default router
