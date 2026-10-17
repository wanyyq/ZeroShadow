import crypto from "node:crypto"
import path from "node:path"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { DATA_DIR, JWT_SECRET } from "./env.js"
import { readJsonSync, withLock, writeJsonAtomic } from "./store.js"
import { httpError } from "./http.js"

// ============================================================================
//  shares.js —— 分享链接（v1.2.1 新增）
//
//  设计要点（对应需求）：
//   1. **只有登录用户能创建**，且只能分享"自己看得见"的路径（可见性校验在路由层，
//      因为要拿到 req.group / req.perms）；访客不可见的路径**必须**设 6~10 位密码。
//   2. **有效期只有 9 档**：30 分钟 / 1 / 6 / 12 小时 / 1 / 3 / 7 / 14 / 21 天。
//      服务端白名单校验，不信前端传秒数；到点即失效（每次访问都查一次）。
//   3. **密码建档后不可改**（只能删了重建）—— 所以这里没有 PATCH。
//   4. **向下兼容**：shares.json 不存在、是纯数组、字段缺失都能正常加载；
//      未知字段原样保留，不认识的条目按缺失字段补默认值。
//   5. 过期记录不立刻删（管理员还能看到"已过期"），保留 30 天后自动清理，
//      避免长期运行把 shares.json 撑大。
//
//  安全细节：
//   - token 用 crypto.randomBytes(18).base64url（24 字符），碰撞概率可忽略；
//   - 密码 bcrypt(10) 存储，明文永不落盘；校验按 IP + token 双维度限速；
//   - 通过密码后发一枚短时效 JWT 票据（不是 Cookie），作用域锁死在单个 token 上，
//     伪造/挪用别的票据都过不了签名与 token 绑定校验。
// ============================================================================

const FILE = path.join(DATA_DIR, "shares.json")

/** 硬上限，防止恶意刷分享把内存/磁盘撑爆 */
const MAX_SHARES = 5000
/** 密码规则：6~10 位，不含空白字符 */
export const PASSWORD_MIN = 6
export const PASSWORD_MAX = 10
/** 过期后保留多久再物理清理（管理员在这段时间内仍能看到"已过期"记录） */
const EXPIRE_KEEP_MS = 30 * 24 * 3600 * 1000
/** 票据最长寿命：即使分享还剩 21 天，票据也只活 2 小时，避免链接被长期复用 */
const TICKET_MAX_MS = 2 * 3600 * 1000

/**
 * 允许的有效期档位。**键名是前端 i18n 键的后缀**（`ui.share.expire.30m`），
 * 前端不自己算秒数，直接用服务端返回的清单，避免两边规则漂移。
 */
export const EXPIRY_OPTIONS = [
  { key: "30m", seconds: 30 * 60 },
  { key: "1h", seconds: 3600 },
  { key: "6h", seconds: 6 * 3600 },
  { key: "12h", seconds: 12 * 3600 },
  { key: "1d", seconds: 24 * 3600 },
  { key: "3d", seconds: 3 * 24 * 3600 },
  { key: "7d", seconds: 7 * 24 * 3600 },
  { key: "14d", seconds: 14 * 24 * 3600 },
  { key: "21d", seconds: 21 * 24 * 3600 },
]

const EXPIRY_SECONDS = new Set(EXPIRY_OPTIONS.map((o) => o.seconds))

/** 密码合法性：6~10 位、不含空白；允许字母数字与常见符号 */
export function validateSharePassword(value) {
  const pw = String(value ?? "")
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
    return { ok: false, errorKey: "api.share.password_length", message: `分享密码需为 ${PASSWORD_MIN}~${PASSWORD_MAX} 位` }
  }
  if (/\s/.test(pw)) {
    return { ok: false, errorKey: "api.share.password_space", message: "分享密码不能包含空格" }
  }
  if (/[\u0000-\u001f\u007f]/.test(pw)) {
    return { ok: false, errorKey: "api.share.password_invalid", message: "分享密码包含非法字符" }
  }
  return { ok: true }
}

function newToken() {
  return crypto.randomBytes(18).toString("base64url")
}

function newId() {
  return `shr_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("base64url")}`
}

let state = null

/**
 * 归一化单个条目：旧数据/手改数据缺字段时补默认值，未知字段原样保留。
 * 返回 null 表示这条记录无法使用（没有 token 或 path 就没法定位资源）。
 */
function normalizeShare(raw, index) {
  if (!raw || typeof raw !== "object") return null
  const token = typeof raw.token === "string" ? raw.token.trim() : ""
  const rel = typeof raw.path === "string" ? raw.path.replace(/\\/g, "/") : ""
  if (!token || !rel) return null
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  const expiresAt = Number.isFinite(raw.expiresAt) ? raw.expiresAt : createdAt
  return {
    ...raw,
    id: typeof raw.id === "string" && raw.id ? raw.id : `shr_legacy_${index}_${token.slice(0, 6)}`,
    token,
    path: rel,
    name: typeof raw.name === "string" && raw.name ? raw.name : rel.split("/").pop() || rel,
    isFolder: !!raw.isFolder,
    owner: typeof raw.owner === "string" ? raw.owner : "",
    ownerRole: typeof raw.ownerRole === "string" ? raw.ownerRole : "member",
    createdAt,
    expiresAt,
    // 访客不可见的路径必须带密码；老数据没有这个标记时按"有密码就算需要"推断
    requirePassword: raw.requirePassword === undefined ? !!raw.passwordHash : !!raw.requirePassword,
    passwordHash: typeof raw.passwordHash === "string" ? raw.passwordHash : null,
    downloads: Number.isFinite(raw.downloads) ? raw.downloads : 0,
    lastAccessAt: Number.isFinite(raw.lastAccessAt) ? raw.lastAccessAt : null,
    note: typeof raw.note === "string" ? raw.note.slice(0, 200) : "",
  }
}

function load() {
  if (state) return state
  const raw = readJsonSync(FILE, null)
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === "object" && Array.isArray(raw.shares)) list = raw.shares
  const shares = []
  list.forEach((item, index) => {
    const normalized = normalizeShare(item, index)
    if (normalized) shares.push(normalized)
  })
  state = { version: 1, shares }
  return state
}

/** 备份回滚 / 外部修改后重新从磁盘加载（与 reloadConfig 等同级） */
export function reloadShares() {
  state = null
  return load()
}

async function persist() {
  const current = load()
  await withLock("shares", async () => {
    await writeJsonAtomic(FILE, { version: 1, shares: current.shares })
  })
}

export function listAllShares() {
  return [...load().shares]
}

export function listSharesByOwner(owner) {
  return load().shares.filter((s) => s.owner === owner)
}

export function findByToken(token) {
  const value = String(token || "")
  if (!value) return null
  return load().shares.find((s) => s.token === value) || null
}

export function findById(id) {
  const value = String(id || "")
  if (!value) return null
  return load().shares.find((s) => s.id === value) || null
}

export function isExpired(share) {
  return !share || Date.now() >= share.expiresAt
}

/**
 * 创建分享。
 *
 * @param {object} input
 * @param {string} input.rel 相对网盘根的路径（非空，不能是根目录）
 * @param {string} input.name 展示名
 * @param {boolean} input.isFolder
 * @param {string} input.owner 创建者用户名
 * @param {string} input.ownerRole superadmin | member
 * @param {number} input.expireSeconds 必须是 EXPIRY_OPTIONS 里的一档
 * @param {string} [input.password] 密码（requirePassword 为真时必填）
 * @param {boolean} input.requirePassword 是否强制密码（= 该路径对访客不可见）
 */
export async function createShare(input) {
  const current = load()
  if (current.shares.length >= MAX_SHARES) {
    throw httpError(429, `分享数量已达上限（${MAX_SHARES}），请先清理旧分享`, {
      errorKey: "api.share.too_many",
      errorParams: { limit: MAX_SHARES },
    })
  }

  const rel = String(input.rel || "").replace(/\\/g, "/")
  if (!rel) {
    throw httpError(400, "不能分享网盘根目录", { errorKey: "api.share.path_required" })
  }
  const expireSeconds = Number(input.expireSeconds)
  if (!EXPIRY_SECONDS.has(expireSeconds)) {
    throw httpError(400, "分享有效期只能从固定档位中选择", { errorKey: "api.share.expire_invalid" })
  }

  const requirePassword = !!input.requirePassword
  const password = input.password === undefined || input.password === null ? "" : String(input.password)
  let passwordHash = null
  if (requirePassword && !password) {
    throw httpError(400, `该内容对访客不可见，必须设置 ${PASSWORD_MIN}~${PASSWORD_MAX} 位分享密码`, {
      errorKey: "api.share.password_required",
      errorParams: { min: PASSWORD_MIN, max: PASSWORD_MAX },
    })
  }
  if (password) {
    const check = validateSharePassword(password)
    if (!check.ok) {
      throw httpError(400, check.message, { errorKey: check.errorKey, errorParams: { min: PASSWORD_MIN, max: PASSWORD_MAX } })
    }
    passwordHash = await bcrypt.hash(password, 10)
  }

  const now = Date.now()
  const share = {
    id: newId(),
    token: newToken(),
    path: rel,
    name: String(input.name || rel.split("/").pop() || rel).slice(0, 200),
    isFolder: !!input.isFolder,
    owner: String(input.owner || ""),
    ownerRole: String(input.ownerRole || "member"),
    createdAt: now,
    expiresAt: now + expireSeconds * 1000,
    requirePassword: requirePassword || !!passwordHash,
    passwordHash,
    downloads: 0,
    lastAccessAt: null,
    note: String(input.note || "").slice(0, 200),
  }
  current.shares.push(share)
  await persist()
  return share
}

/**
 * 删除分享（创建者本人或超管）。
 * @returns {boolean} 是否真的删掉了
 */
export async function revokeShare(id, { owner = null, role = null } = {}) {
  const current = load()
  const index = current.shares.findIndex((s) => s.id === id)
  if (index < 0) return false
  const share = current.shares[index]
  if (role !== "superadmin" && owner !== null && share.owner !== owner) {
    throw httpError(403, "只能取消自己创建的分享", { errorKey: "api.share.revoke_forbidden" })
  }
  current.shares.splice(index, 1)
  await persist()
  return true
}

/**
 * 记录一次成功访问（下载/浏览），用于管理员视角的统计。
 *
 * **刻意做了落盘节流**：`writeJsonAtomic` 会在覆盖前给受管文件做一份快照，
 * 如果每次下载都落盘，一个热门链接几分钟就能把 data/backups/shares.json/
 * 冲掉 20 轮、并产生大量磁盘写。这里内存里实时更新，最多每 30 秒落盘一次；
 * 统计数字略微滞后完全可以接受（它只用于后台展示）。
 */
const STATS_FLUSH_MS = 30 * 1000
let statsFlushedAt = 0

export async function touchShare(id, { download = false } = {}) {
  const share = findById(id)
  if (!share) return
  share.lastAccessAt = Date.now()
  if (download) share.downloads = (share.downloads || 0) + 1
  const now = Date.now()
  if (now - statsFlushedAt < STATS_FLUSH_MS) return
  statsFlushedAt = now
  await persist()
}

/** 进程退出前把统计落盘（由 index.js 的优雅退出调用，失败忽略） */
export async function flushShareStats() {
  try {
    await persist()
  } catch {
    /* 退出路径上失败不再抛 */
  }
}

/**
 * 清理：过期超过 30 天的记录物理删除。
 * 返回删除条数。启动时与每 6 小时的维护任务里各跑一次。
 */
export async function pruneShares() {
  const current = load()
  const now = Date.now()
  const before = current.shares.length
  current.shares = current.shares.filter((s) => now - s.expiresAt < EXPIRE_KEEP_MS)
  const removed = before - current.shares.length
  if (removed > 0) await persist()
  return removed
}

// ============================================================================
//  票据（通过密码后发给前端，后续请求带回）
// ============================================================================

export function issueTicket(share) {
  const ttl = Math.max(60 * 1000, Math.min(TICKET_MAX_MS, share.expiresAt - Date.now()))
  const token = jwt.sign({ sh: share.token, scope: "share" }, JWT_SECRET, {
    expiresIn: Math.floor(ttl / 1000),
  })
  return { ticket: token, expiresAt: Date.now() + ttl }
}

export function verifyTicket(ticket, shareToken) {
  const value = String(ticket || "")
  if (!value) return false
  try {
    const payload = jwt.verify(value, JWT_SECRET, { algorithms: ["HS256"] })
    return payload?.scope === "share" && payload?.sh === shareToken
  } catch {
    return false
  }
}

// ============================================================================
//  密码尝试限速（按 IP + token）
//
//  6~10 位密码的搜索空间不大，光靠 bcrypt 不够：必须限制尝试次数。
//  规则：同一 IP 对同一分享 15 分钟内最多错 8 次，然后锁 15 分钟；
//  另外同一 IP 对**所有**分享合计 15 分钟最多 20 次失败（防止换 token 刷）。
// ============================================================================

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const PER_SHARE_MAX = 8
const PER_IP_MAX = 20
const ATTEMPT_CAP = 3000
const attempts = new Map()

function bucket(key, now) {
  let b = attempts.get(key)
  if (!b) {
    if (attempts.size >= ATTEMPT_CAP) {
      // 有界：先清过期，再按最早时间淘汰
      for (const [k, v] of attempts) {
        if (now - v.first > ATTEMPT_WINDOW_MS && v.lockedUntil < now) attempts.delete(k)
      }
      if (attempts.size >= ATTEMPT_CAP) {
        const oldest = [...attempts.entries()].sort((a, b2) => a[1].first - b2[1].first)[0]
        if (oldest) attempts.delete(oldest[0])
      }
    }
    b = { count: 0, first: now, lockedUntil: 0 }
    attempts.set(key, b)
    return b
  }
  if (now - b.first > ATTEMPT_WINDOW_MS) {
    b.count = 0
    b.first = now
  }
  return b
}

/** @returns {number} 剩余锁定分钟数（0 表示未锁定） */
export function passwordLocked(ip, token) {
  const now = Date.now()
  const a = attempts.get(`s:${ip}:${token}`)
  const b = attempts.get(`i:${ip}`)
  const until = Math.max(a?.lockedUntil || 0, b?.lockedUntil || 0)
  return until > now ? Math.ceil((until - now) / 60000) : 0
}

export function recordPasswordFail(ip, token) {
  const now = Date.now()
  const perShare = bucket(`s:${ip}:${token}`, now)
  perShare.count += 1
  if (perShare.count >= PER_SHARE_MAX) {
    perShare.lockedUntil = now + ATTEMPT_WINDOW_MS
    perShare.count = 0
    perShare.first = now
  }
  const perIp = bucket(`i:${ip}`, now)
  perIp.count += 1
  if (perIp.count >= PER_IP_MAX) {
    perIp.lockedUntil = now + ATTEMPT_WINDOW_MS
    perIp.count = 0
    perIp.first = now
  }
}

export function clearPasswordFails(ip, token) {
  attempts.delete(`s:${ip}:${token}`)
}

/** 供测试/诊断：当前限速表大小 */
export function shareAttemptBuckets() {
  return attempts.size
}
