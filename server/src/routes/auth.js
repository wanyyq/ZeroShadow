import { Router } from "express"
import { env } from "../env.js"
import {
  COOKIE_NAME,
  cookieOptions,
  loginLocked,
  recordLoginFail,
  recordLoginSuccess,
  requireRole,
  signToken,
  verifySuperPassword,
} from "../auth.js"
import { effectivePerms, uploadLimitMB } from "../config.js"
import { verifyLogin } from "../users.js"
import { info, warn } from "../logger.js"

const router = Router()

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
  res.cookie(COOKIE_NAME, signToken(auth), cookieOptions())
  info("login_success", { user: auth.username, role: auth.role, ip: req.ip })
  res.json({ role: auth.role, username: auth.username })
})

router.post("/logout", requireRole("superadmin", "member"), (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" })
  info("logout", { user: req.auth.username, role: req.auth.role, ip: req.ip })
  res.json({ ok: true })
})

router.get("/me", (req, res) => {
  const { role, username } = req.auth
  res.json({
    role,
    username,
    perms: effectivePerms(role),
    uploadLimitMB: uploadLimitMB(role),
  })
})

export default router
