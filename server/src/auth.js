import crypto from "node:crypto"
import jwt from "jsonwebtoken"
import { env, JWT_SECRET } from "./env.js"
import { effectivePerms, getConfig } from "./config.js"
import { findById } from "./users.js"
import { warn } from "./logger.js"

export const COOKIE_NAME = "zs_token"

/**
 * 超管口令的"版本标识"，用来在改密码后让旧会话失效。
 *
 * 旧实现是 `sha256(口令)[:16]` 直接写进 JWT 载荷 —— 而 JWT 载荷是 Base64Url
 * 编码、客户端可解码的，等于把一个"离线猜口令的校验值"随着登录态发给了浏览器。
 * 现在改成以 JWT_SECRET 为密钥的 HMAC：没有密钥就算拿到载荷也无法离线验证猜测。
 */
const superPasswordVersion = crypto
  .createHmac("sha256", JWT_SECRET)
  .update(`zs-super-pwd:${env.superPassword}`)
  .digest("hex")
  .slice(0, 16)

/** 超管是否有会话代次（登出一次全部失效，见 routes/auth.js 的 logout） */
function superSessionEpoch() {
  try {
    return Number(getConfig().superSessionEpoch) || 0
  } catch {
    return 0
  }
}

/** 是否是超管账号（用户名比较不区分大小写，与登录逻辑保持一致） */
export function isSuperUser(name) {
  return String(name || "").toLowerCase() === String(env.superUser).toLowerCase()
}

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
      ? { role: "superadmin", sub: env.superUser, pv: superPasswordVersion, se: superSessionEpoch() }
      : { role: "member", sub: auth.username, uid: auth.userId, tv: auth.tokenVersion }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${env.sessionHours}h` })
}

export function attachAuth(req, _res, next) {
  req.auth = { role: "guest", username: null, userId: null }
  const token = req.cookies?.[COOKIE_NAME]
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] })
      if (payload.role === "superadmin" && payload.pv === superPasswordVersion && (payload.se || 0) === superSessionEpoch()) {
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
    return res.status(403).json({ error: "请求校验失败", errorKey: "api.auth.csrf_failed" })
  }

  // 第二道：现代浏览器会附带来源信息，若存在则必须指回本站。
  // 反向代理若改写了 Host 头可能造成误拦，可在后台「安全」页关闭本项。
  if (getConfig().csrfOriginCheck !== false) {
    const fetchSite = req.headers["sec-fetch-site"]
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return res.status(403).json({ error: "请求校验失败", errorKey: "api.auth.csrf_failed" })
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
        return res.status(403).json({ error: "请求校验失败", errorKey: "api.auth.csrf_failed" })
      }
    }
  }

  next()
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.auth.role)) {
      if (req.auth.role === "guest") {
        return res.status(401).json({ error: "请先登录", errorKey: "api.auth.login_required" })
      }
      return res.status(403).json({ error: "没有权限执行此操作", errorKey: "api.auth.forbidden" })
    }
    next()
  }
}

export function requirePerm(perm) {
  return (req, res, next) => {
    const perms = req.perms || effectivePerms(req.auth.role, req.group)
    if (!perms[perm]) {
      if (req.auth.role === "guest") {
        return res.status(401).json({ error: "请先登录", errorKey: "api.auth.login_required" })
      }
      return res.status(403).json({ error: "没有权限执行此操作", errorKey: "api.auth.forbidden" })
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
/** 计数表硬上限：超过就按"最早出现"淘汰，保证内存有界 */
const MAX_BUCKETS = 5000
const attempts = new Map()

/** 只读查询：不存在就返回 null，**不创建**条目（见 loginLocked 的说明） */
function peek(key) {
  return attempts.get(key) || null
}

function bucket(key) {
  const now = Date.now()
  let b = attempts.get(key)
  if (!b) {
    b = { count: 0, first: now, lockedUntil: 0, strikes: 0, lastStrikeAt: 0 }
    attempts.set(key, b)
    if (attempts.size > MAX_BUCKETS) evictOldest(now)
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

/**
 * 淘汰过期条目；仍然超限时按 first 从早到晚淘汰。
 *
 * 旧实现只在 recordLoginFail 里做一次"删过期条目"，而那个函数在 IP 被锁之后
 * 根本不会被调用（请求直接 429 返回），于是攻击者只要用**不同用户名**持续请求，
 * 就能无限往 attempts 里塞条目 —— 一个不需要任何凭据的内存耗尽。这里把淘汰
 * 做成"插入即保证有界"，与请求走哪条分支无关。
 */
function evictOldest(now) {
  for (const [k, v] of attempts) {
    if (now - v.first > WINDOW_MS && v.lockedUntil < now) attempts.delete(k)
  }
  if (attempts.size <= MAX_BUCKETS) return
  const byAge = [...attempts.entries()].sort((a, b) => a[1].first - b[1].first)
  const drop = attempts.size - Math.floor(MAX_BUCKETS * 0.9)
  for (let i = 0; i < drop && i < byAge.length; i += 1) attempts.delete(byAge[i][0])
}

export function loginLocked(ip, username) {
  const now = Date.now()
  // 注意：这里必须用只读的 peek。旧实现调用 bucket()，于是**每一个**登录请求
  // （包括已被限流、立刻 429 的那些）都会为任意用户名创建一个新条目。
  const byIp = peek(`ip:${ip}`)
  const byUser = peek(`user:${String(username).toLowerCase()}`)
  const until = Math.max(byIp?.lockedUntil || 0, byUser?.lockedUntil || 0)
  if (until > now) return Math.ceil((until - now) / 60000)
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
  evictOldest(now)
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
