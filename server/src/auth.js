import crypto from "node:crypto"
import jwt from "jsonwebtoken"
import { env, JWT_SECRET } from "./env.js"
import { effectivePerms, getConfig } from "./config.js"
import { findById } from "./users.js"
import { warn } from "./logger.js"

export const COOKIE_NAME = "zs_token"

const superPasswordVersion = crypto
  .createHash("sha256")
  .update(env.superPassword)
  .digest("hex")
  .slice(0, 16)

export function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: req ? (req.secure || req.get("x-forwarded-proto") === "https") : false,
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

  // 第一道：必须带自定义头（表单/简单请求无法携带）
  if (req.headers["x-requested-with"] !== "XMLHttpRequest") {
    return res.status(403).json({ error: "请求校验失败" })
  }

  // 第二道：现代浏览器会附带来源信息，若存在则必须指回本站。
  // 反向代理若改写了 Host 头可能造成误拦，可在后台「安全」页关闭本项。
  if (getConfig().csrfOriginCheck !== false) {
    const fetchSite = req.headers["sec-fetch-site"]
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return res.status(403).json({ error: "请求校验失败" })
    }
    const origin = req.headers.origin
    if (origin) {
      const host = req.headers.host
      let originHost = null
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = null
      }
      if (!originHost || originHost !== host) {
        return res.status(403).json({ error: "请求校验失败" })
      }
    }
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
const IP_MAX_FAILS = 30
const IP_LOCK_MS = 15 * 60 * 1000
const USER_MAX_FAILS = 10
// 账户锁定时长故意设得比 IP 短：单靠"锁账户"挡不住恶意者（他只要每隔几分钟
// 试 10 次就能一直把超管挡在门外），所以用"短锁 + 连续触发递增"来兼顾可用性；
// 真正的猜测成本由 IP 维度与递增时长共同承担。
const USER_LOCK_MS = 5 * 60 * 1000
const USER_LOCK_MAX_MS = 30 * 60 * 1000
const STRIKE_WINDOW_MS = 60 * 60 * 1000
const attempts = new Map()

function bucket(key) {
  const now = Date.now()
  let b = attempts.get(key)
  if (!b) {
    b = { count: 0, first: now, lockedUntil: 0, strikes: 0, lastStrikeAt: 0 }
    attempts.set(key, b)
    return b
  }
  // 只重置计数窗口，保留 lockedUntil 与 strikes（旧实现在窗口过期时整块重建，
  // 会顺带丢掉尚未到期的锁定状态）
  if (now - b.first > WINDOW_MS) {
    b.count = 0
    b.first = now
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
  const now = Date.now()
  const byIp = bucket(`ip:${ip}`)
  const byUser = bucket(`user:${String(username).toLowerCase()}`)
  byIp.count += 1
  byUser.count += 1
  if (byIp.count >= IP_MAX_FAILS) byIp.lockedUntil = now + IP_LOCK_MS
  if (byUser.count >= USER_MAX_FAILS) {
    // 连续触发时逐次加倍，直到上限：偶发输错代价很小，持续猜测越来越贵
    const strikes = now - byUser.lastStrikeAt > STRIKE_WINDOW_MS ? 1 : byUser.strikes + 1
    byUser.strikes = strikes
    byUser.lastStrikeAt = now
    const lockMs = Math.min(USER_LOCK_MS * 2 ** (strikes - 1), USER_LOCK_MAX_MS)
    byUser.lockedUntil = now + lockMs
    byUser.count = 0
    byUser.first = now
    warn("login_locked", { msg: `账户 ${username} 已临时锁定 ${Math.round(lockMs / 60000)} 分钟`, ip })
  }
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (now - v.first > WINDOW_MS && v.lockedUntil < now) attempts.delete(k)
    }
  }
}

export function recordLoginSuccess(_ip, username) {
  // 只清账户自身的失败计数；IP 维度故意保留，否则攻击者只要持有一个有效账户，
  // 就能用成功登录无限重置 IP 限速。
  const byUser = attempts.get(`user:${String(username).toLowerCase()}`)
  if (byUser) {
    byUser.count = 0
    byUser.lockedUntil = 0
    byUser.strikes = 0
  }
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
