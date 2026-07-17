import crypto from "node:crypto"
import jwt from "jsonwebtoken"
import { env, JWT_SECRET } from "./env.js"
import { effectivePerms } from "./config.js"
import { findById } from "./users.js"
import { warn } from "./logger.js"

export const COOKIE_NAME = "epan_token"

const superPasswordVersion = crypto
  .createHash("sha256")
  .update(env.superPassword)
  .digest("hex")
  .slice(0, 16)

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: env.sessionHours * 3600 * 1000,
  }
}

export function signToken(auth) {
  const payload =
    auth.role === "superadmin"
      ? { role: "superadmin", sub: env.superUser, pv: superPasswordVersion }
      : { role: "member", sub: auth.username, uid: auth.userId, tv: auth.tokenVersion }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${env.sessionHours}h` })
}

export function attachAuth(req, _res, next) {
  req.auth = { role: "guest", username: null, userId: null }
  const token = req.cookies?.[COOKIE_NAME]
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] })
      if (payload.role === "superadmin" && payload.pv === superPasswordVersion) {
        req.auth = { role: "superadmin", username: env.superUser, userId: null }
      } else if (payload.role === "member" && payload.uid) {
        const user = findById(payload.uid)
        if (user && !user.disabled && user.tokenVersion === payload.tv) {
          req.auth = { role: "member", username: user.username, userId: user.id }
        }
      }
    } catch {
      /* invalid/expired token -> guest */
    }
  }
  next()
}

export function csrfGuard(req, res, next) {
  const method = req.method.toUpperCase()
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next()
  if (req.headers["x-requested-with"] !== "XMLHttpRequest") {
    return res.status(403).json({ error: "请求校验失败" })
  }
  next()
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.auth.role)) {
      if (req.auth.role === "guest") return res.status(401).json({ error: "请先登录" })
      return res.status(403).json({ error: "没有权限执行此操作" })
    }
    next()
  }
}

export function requirePerm(perm) {
  return (req, res, next) => {
    const perms = effectivePerms(req.auth.role)
    if (!perms[perm]) {
      if (req.auth.role === "guest") return res.status(401).json({ error: "请先登录" })
      return res.status(403).json({ error: "没有权限执行此操作" })
    }
    next()
  }
}

const WINDOW_MS = 15 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000
const IP_MAX_FAILS = 30
const USER_MAX_FAILS = 10
const attempts = new Map()

function bucket(key) {
  let b = attempts.get(key)
  const now = Date.now()
  if (!b || now - b.first > WINDOW_MS) {
    b = { count: 0, first: now, lockedUntil: 0 }
    attempts.set(key, b)
  }
  return b
}

export function loginLocked(ip, username) {
  const now = Date.now()
  const byIp = bucket(`ip:${ip}`)
  const byUser = bucket(`user:${String(username).toLowerCase()}`)
  if (byIp.lockedUntil > now || byUser.lockedUntil > now) {
    return Math.ceil((Math.max(byIp.lockedUntil, byUser.lockedUntil) - now) / 60000)
  }
  return 0
}

export function recordLoginFail(ip, username) {
  const byIp = bucket(`ip:${ip}`)
  const byUser = bucket(`user:${String(username).toLowerCase()}`)
  byIp.count += 1
  byUser.count += 1
  if (byIp.count >= IP_MAX_FAILS) byIp.lockedUntil = Date.now() + LOCK_MS
  if (byUser.count >= USER_MAX_FAILS) {
    byUser.lockedUntil = Date.now() + LOCK_MS
    warn("login_locked", { msg: `账户 ${username} 已被临时锁定`, ip })
  }
  if (attempts.size > 5000) {
    const now = Date.now()
    for (const [k, v] of attempts) {
      if (now - v.first > WINDOW_MS && v.lockedUntil < now) attempts.delete(k)
    }
  }
}

export function recordLoginSuccess(ip, username) {
  attempts.delete(`ip:${ip}`)
  attempts.delete(`user:${String(username).toLowerCase()}`)
}

export function verifySuperPassword(password) {
  const a = Buffer.from(String(password))
  const b = Buffer.from(env.superPassword)
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32))
    return false
  }
  return crypto.timingSafeEqual(a, b)
}
