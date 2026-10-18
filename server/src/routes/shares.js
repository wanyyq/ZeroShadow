import path from "node:path"
import bcrypt from "bcryptjs"
import { Router } from "express"
import { getConfig } from "../config.js"
import { requireRole } from "../auth.js"
import { contentDisposition, httpError } from "../http.js"
import { isHiddenFromGuest, isSameOrInside, joinRel, normRel, resolveAny } from "../safety.js"
import { assertDir, assertExists, dirStats, listDir, statSafe } from "../files.js"
import { isVisibleForContext } from "../groups.js"
import { info, warn } from "../logger.js"
import { rateLimit } from "../ratelimit.js"
import {
  EXPIRY_OPTIONS,
  PASSWORD_MAX,
  PASSWORD_MIN,
  clearPasswordFails,
  createShare,
  findById,
  findByToken,
  isExpired,
  issueTicket,
  listAllShares,
  listSharesByOwner,
  passwordLocked,
  recordPasswordFail,
  revokeShare,
  touchShare,
  validateSharePassword,
  verifyTicket,
} from "../shares.js"

// ============================================================================
//  routes/shares.js —— 分享链接的三组接口
//
//   1. `publicShareRouter`  挂在 /api/share     —— 公开访问（匿名可用，可被管理员收成仅登录）
//   2. `manageShareRouter`  挂在 /api/shares    —— 登录用户：创建 / 列出我的 / 删除
//   3. `adminShareRouter`   挂在 /api/admin/shares —— 超管：查看全部 / 强制取消
//
//  安全边界（重要的几条，改代码时别破坏）：
//   - **路径永远锁在分享根之内**：请求里的 `path` 是"相对分享根"的子路径，先 normRel
//     挡掉 `..`/空字节，再拼成完整 rel，最后用 isSameOrInside 再做一次边界断言。
//     resolveAny 仍会挡掉软目录越界与服务自身文件（.env / data/）。
//   - **无密码分享不过滤隐藏目录就会泄密**：分享根对访客可见、但里面可能有对访客隐藏
//     的子目录。所以无密码分享的目录浏览按"访客视角"过滤（forGuest）；
//     有密码的（= 已验证身份）按完整视角列出。
//   - **票据不是 Cookie**：JWT 里绑定了 token，换一个分享的票据无效；有效期最多 2 小时。
// ============================================================================

const PUBLIC_ROOT_MAX = 2000

/** 内联预览的类型白名单（其余一律按附件下载，避免浏览器把上传内容当页面跑） */
const INLINE_TYPES = new Map(
  Object.entries({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4v: "video/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    csv: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    md: "text/plain; charset=utf-8",
  })
)
const SCRIPTABLE_EXT = new Set(["html", "htm", "svg"])

function ticketFrom(req) {
  return (
    (typeof req.query?.t === "string" && req.query.t) ||
    (typeof req.headers["x-share-ticket"] === "string" && req.headers["x-share-ticket"]) ||
    (typeof req.body?.t === "string" && req.body.t) ||
    ""
  )
}

function shareError(status, message, errorKey, extra = {}) {
  return httpError(status, message, { errorKey, ...extra })
}

/**
 * 取一个可用（未删除、未过期）的分享。
 * 过期返回 410，前端据此显示"链接已失效"，不再尝试下载。
 */
function loadShare(req) {
  const share = findByToken(req.params.token)
  if (!share) throw shareError(404, "分享不存在或已被取消", "api.share.not_found", { code: "SHARE_NOT_FOUND" })
  if (isExpired(share)) throw shareError(410, "分享链接已过期", "api.share.expired", { code: "SHARE_EXPIRED" })
  return share
}

/** 管理员可以把分享收成"仅登录可访问" */
function assertPublicAccess(req) {
  if (getConfig().shareEnabled === false) {
    throw shareError(403, "分享功能已被管理员关闭", "api.share.disabled", { code: "SHARE_DISABLED" })
  }
  if (getConfig().sharePublicAccess === false && req.auth.role === "guest") {
    throw shareError(401, "该分享仅限登录用户访问", "api.share.login_required", { code: "SHARE_LOGIN_REQUIRED" })
  }
}

function assertUnlocked(req, share) {
  if (!share.requirePassword) return
  if (verifyTicket(ticketFrom(req), share.token)) return
  throw shareError(403, "需要分享密码", "api.share.password_needed", { code: "SHARE_LOCKED" })
}

/**
 * 把"相对分享根的子路径"解析成绝对路径，并断言仍在分享范围内。
 * @returns {{abs:string, rel:string, sub:string, isSoft:boolean}}
 */
function resolveSharePath(share, requested) {
  const sub = normRel(requested || "")
  const rel = sub ? joinRel(share.path, sub) : share.path
  if (!isSameOrInside(rel, share.path)) {
    throw shareError(400, "非法路径", "api.fs.path_invalid")
  }
  let resolved
  try {
    resolved = resolveAny(rel)
  } catch {
    throw shareError(410, "分享的内容已被移动或删除", "api.share.target_missing", { code: "SHARE_TARGET_MISSING" })
  }
  // 无密码分享按「访客视角」处理：与 /api/fs/* 的 guestBlocked 保持同一条规则。
  // 只在 list 里过滤条目是不够的 —— 知道文件名就能用 ?path= 直接下载。
  if (!share.requirePassword && isHiddenFromGuest(rel)) {
    throw shareError(404, "文件或目录不存在", "api.fs.not_found")
  }
  return { ...resolved, sub }
}

async function shareMeta(share, req) {
  const { abs } = resolveSharePath(share, "")
  const stat = await statSafe(abs)
  // 目标被删除/改名/挪走后，不要再返回一个"存在但没有大小"的空壳：
  // 明确 410 + SHARE_TARGET_MISSING，前端据此显示"内容已被移动或删除"。
  if (!stat) {
    throw shareError(410, "分享的内容已被移动或删除", "api.share.target_missing", { code: "SHARE_TARGET_MISSING" })
  }
  let size = 0
  let files = 0
  let dirs = 0
  let partial = false
  if (stat.isDirectory()) {
    const stats = await dirStats(abs, { maxEntries: 20000 }).catch(() => ({ files: 0, dirs: 0, bytes: 0, partial: true }))
    size = stats.bytes
    files = stats.files
    dirs = stats.dirs
    partial = stats.partial
  } else if (stat.isFile()) {
    size = stat.size
    files = 1
  }
  return {
    token: share.token,
    name: share.name,
    isFolder: share.isFolder,
    exists: !!stat,
    size,
    files,
    dirs,
    partial,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    expired: isExpired(share),
    requirePassword: !!share.requirePassword,
    unlocked: !share.requirePassword || verifyTicket(ticketFrom(req), share.token),
    // 分享者名字对匿名访问者也算敏感信息，这里只给角色，不给用户名
    ownerRole: share.ownerRole === "superadmin" ? "superadmin" : "member",
    downloads: share.downloads || 0,
    publicAccess: getConfig().sharePublicAccess !== false,
    mode: getConfig().sharePublicAccess === false ? "login" : "public",
  }
}

// ============================================================================
//  公开访问
// ============================================================================

export const publicShareRouter = Router()

publicShareRouter.get("/:token", async (req, res, next) => {
  try {
    assertPublicAccess(req)
    const share = loadShare(req)
    res.setHeader("Cache-Control", "no-store")
    res.json(await shareMeta(share, req))
  } catch (err) {
    next(err)
  }
})

/** 校验密码 → 发票据。失败次数按 IP + token 双维度限制。 */
publicShareRouter.post("/:token/verify", async (req, res, next) => {
  try {
    assertPublicAccess(req)
    const share = loadShare(req)
    if (!share.requirePassword) {
      return res.json({ ok: true, ticket: null, expiresAt: share.expiresAt })
    }
    const locked = passwordLocked(req.ip, share.token)
    if (locked > 0) {
      throw shareError(429, `密码尝试次数过多，请 ${locked} 分钟后再试`, "api.share.password_locked", {
        errorParams: { minutes: locked },
        code: "SHARE_PASSWORD_LOCKED",
      })
    }
    const password = String(req.body?.password ?? "")
    const ok = share.passwordHash ? await bcrypt.compare(password, share.passwordHash) : false
    if (!ok) {
      recordPasswordFail(req.ip, share.token)
      warn("share_password_fail", { msg: `分享 ${share.id} 密码错误`, ip: req.ip })
      throw shareError(403, "分享密码不正确", "api.share.password_wrong", { code: "SHARE_PASSWORD_WRONG" })
    }
    clearPasswordFails(req.ip, share.token)
    const issued = issueTicket(share)
    info("share_unlock", { msg: share.name, ip: req.ip, user: req.auth.username || "guest", role: req.auth.role })
    res.json({ ok: true, ...issued })
  } catch (err) {
    next(err)
  }
})

/** 目录浏览（仅文件夹分享）。path 是相对分享根的子路径。 */
publicShareRouter.get("/:token/list", async (req, res, next) => {
  try {
    assertPublicAccess(req)
    const share = loadShare(req)
    assertUnlocked(req, share)
    if (!share.isFolder) {
      throw shareError(400, "该分享不是文件夹", "api.share.not_folder")
    }
    const { abs, rel, sub } = resolveSharePath(share, req.query.path)
    // 子目录被删掉时给 410（而不是 404），语义是"这个分享指向的东西已经没了"
    await assertDir(abs).catch(() => {
      throw shareError(410, "分享的内容已被移动或删除", "api.share.target_missing", { code: "SHARE_TARGET_MISSING" })
    })
    // 无密码分享按访客视角过滤（隐藏目录不外泄）；有密码分享是已验证的，全量列出
    const forGuest = !share.requirePassword
    const entries = (await listDir(abs, rel, { forGuest }))
      .slice(0, PUBLIC_ROOT_MAX)
      .map((e) => ({
        name: e.name,
        type: e.type === "dir" ? "dir" : "file",
        size: e.size,
        mtime: e.mtime,
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh-CN") : a.type === "dir" ? -1 : 1))
    res.setHeader("Cache-Control", "no-store")
    info("share_browse", { msg: `${share.name}/${sub}`, ip: req.ip, user: req.auth.username || "guest" })
    res.json({ path: sub, entries })
  } catch (err) {
    next(err)
  }
})

/** 单文件下载 / 内联预览。path 是相对分享根的子路径。 */
publicShareRouter.get("/:token/download", async (req, res, next) => {
  try {
    assertPublicAccess(req)
    const share = loadShare(req)
    assertUnlocked(req, share)
    const { abs, rel } = resolveSharePath(share, req.query.path)
    const stat = await assertExists(abs).catch(() => {
      throw shareError(410, "分享的内容已被移动或删除", "api.share.target_missing", { code: "SHARE_TARGET_MISSING" })
    })
    if (!stat.isFile()) {
      throw shareError(400, "文件夹请进入分享页面浏览下载", "api.share.folder_download")
    }
    const name = path.basename(abs)
    const ext = path.extname(name).slice(1).toLowerCase()
    const inline = req.query.inline === "1" && INLINE_TYPES.has(ext)
    res.setHeader("Content-Type", inline ? INLINE_TYPES.get(ext) : "application/octet-stream")
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", name))
    res.setHeader("Cache-Control", "no-store")
    // 与 /api/fs/download 同一条规则：用户上传的 HTML/SVG 绝不能在本站源下执行
    if (inline && SCRIPTABLE_EXT.has(ext)) {
      res.setHeader("Content-Security-Policy", "sandbox allow-scripts")
    }
    info("share_download", { msg: `${share.name}: ${rel}`, ip: req.ip, user: req.auth.username || "guest" })
    touchShare(share.id, { download: true }).catch(() => {})
    res.sendFile(abs, { dotfiles: "deny", cacheControl: false }, (err) => {
      if (!err) return
      if (res.headersSent) res.destroy()
      else next(err)
    })
  } catch (err) {
    next(err)
  }
})

// ============================================================================
//  登录用户管理自己的分享
// ============================================================================

export const manageShareRouter = Router()

manageShareRouter.use(requireRole("superadmin", "member"))

function requireShareFeature() {
  if (getConfig().shareEnabled === false) {
    throw shareError(403, "分享功能已被管理员关闭", "api.share.disabled", { code: "SHARE_DISABLED" })
  }
}

/** 前端用它渲染下拉框与密码输入框，避免两边各自维护一份档位表 */
manageShareRouter.get("/options", (req, res) => {
  res.json({
    enabled: getConfig().shareEnabled !== false,
    publicAccess: getConfig().sharePublicAccess !== false,
    expiry: EXPIRY_OPTIONS,
    password: { min: PASSWORD_MIN, max: PASSWORD_MAX },
  })
})

/**
 * 创建前的预检：告诉前端这个路径是否"对访客不可见"（决定密码是否必填）、
 * 是文件还是文件夹、多大。前端据此把密码框标成"必填"。
 */
manageShareRouter.get("/precheck", rateLimit, async (req, res, next) => {
  try {
    requireShareFeature()
    const rel = normRel(req.query.path)
    if (!rel) throw shareError(400, "不能分享网盘根目录", "api.share.path_required")
    if (!isVisibleForContext(rel, { role: req.auth.role, group: req.group, userId: req.auth.userId })) {
      throw shareError(404, "文件或目录不存在", "api.fs.not_found")
    }
    const resolved = resolveAny(rel)
    const stat = await statSafe(resolved.abs)
    if (!stat) throw shareError(404, "文件或目录不存在", "api.fs.not_found")
    const hidden = isHiddenFromGuest(rel)
    const isFolder = stat.isDirectory()
    let size = 0
    let files = 0
    if (isFolder) {
      const stats = await dirStats(resolved.abs, { maxEntries: 20000 })
      size = stats.bytes
      files = stats.files
    } else {
      size = stat.size
      files = 1
    }
    res.json({
      path: rel,
      name: path.basename(resolved.abs),
      isFolder,
      size,
      files,
      guestHidden: hidden,
      needPassword: hidden,
      softReadOnly: !!resolved.isSoft,
    })
  } catch (err) {
    next(err)
  }
})

manageShareRouter.post("/", rateLimit, async (req, res, next) => {
  try {
    requireShareFeature()
    const rel = normRel(req.body?.path)
    if (!rel) throw shareError(400, "不能分享网盘根目录", "api.share.path_required")
    if (!isVisibleForContext(rel, { role: req.auth.role, group: req.group, userId: req.auth.userId })) {
      throw shareError(404, "文件或目录不存在", "api.fs.not_found")
    }
    const resolved = resolveAny(rel)
    const stat = await statSafe(resolved.abs)
    if (!stat) throw shareError(404, "文件或目录不存在", "api.fs.not_found")

    // 不能分享超过自身下载权限的内容：否则关掉 downloadFile 的成员
    // 仍能把文件"分享出去"再自己下载，权限开关就形同虚设。
    const perms = req.perms || {}
    const isDir = stat.isDirectory()
    if (isDir ? !perms.downloadFolder : !perms.downloadFile) {
      throw shareError(403, "没有权限分享该内容", "api.auth.forbidden")
    }

    const hidden = isHiddenFromGuest(rel)
    const password = req.body?.password
    if (password !== undefined && password !== null && String(password).length > 0) {
      const check = validateSharePassword(password)
      if (!check.ok) {
        throw shareError(400, check.message, check.errorKey, { errorParams: { min: PASSWORD_MIN, max: PASSWORD_MAX } })
      }
    }
    const share = await createShare({
      rel,
      name: path.basename(resolved.abs),
      isFolder: stat.isDirectory(),
      owner: req.auth.username,
      ownerRole: req.auth.role,
      expireSeconds: req.body?.expireSeconds,
      password,
      requirePassword: hidden,
    })
    info("share_create", {
      msg: `${share.name} → ${share.token}`,
      user: req.auth.username,
      role: req.auth.role,
      ip: req.ip,
    })
    res.status(201).json({
      id: share.id,
      token: share.token,
      name: share.name,
      isFolder: share.isFolder,
      path: share.path,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      requirePassword: share.requirePassword,
      url: `/s/${share.token}`,
    })
  } catch (err) {
    next(err)
  }
})

manageShareRouter.get("/", (req, res) => {
  const list = listSharesByOwner(req.auth.username)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => ({
      id: s.id,
      token: s.token,
      name: s.name,
      path: s.path,
      isFolder: s.isFolder,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      expired: isExpired(s),
      requirePassword: s.requirePassword,
      downloads: s.downloads || 0,
      lastAccessAt: s.lastAccessAt,
      url: `/s/${s.token}`,
    }))
  res.json({ shares: list, publicAccess: getConfig().sharePublicAccess !== false })
})

manageShareRouter.delete("/:id", async (req, res, next) => {
  try {
    const ok = await revokeShare(String(req.params.id), { owner: req.auth.username, role: req.auth.role })
    if (!ok) throw shareError(404, "分享不存在", "api.share.not_found")
    info("share_revoke", { msg: String(req.params.id), user: req.auth.username, role: req.auth.role, ip: req.ip })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ============================================================================
//  超管：全部分享
// ============================================================================

export const adminShareRouter = Router()

adminShareRouter.use(requireRole("superadmin"))

adminShareRouter.get("/", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase()
  const status = String(req.query.status || "all")
  const now = Date.now()
  let list = listAllShares()
  if (q) {
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q) ||
        s.owner.toLowerCase().includes(q) ||
        s.token.toLowerCase().includes(q)
    )
  }
  if (status === "active") list = list.filter((s) => now < s.expiresAt)
  else if (status === "expired") list = list.filter((s) => now >= s.expiresAt)
  const shares = list
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => ({
      id: s.id,
      token: s.token,
      name: s.name,
      path: s.path,
      isFolder: s.isFolder,
      owner: s.owner,
      ownerRole: s.ownerRole,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      expired: now >= s.expiresAt,
      requirePassword: s.requirePassword,
      downloads: s.downloads || 0,
      lastAccessAt: s.lastAccessAt,
      url: `/s/${s.token}`,
    }))
  res.json({
    shares,
    total: shares.length,
    active: shares.filter((s) => !s.expired).length,
    expired: shares.filter((s) => s.expired).length,
    enabled: getConfig().shareEnabled !== false,
    publicAccess: getConfig().sharePublicAccess !== false,
  })
})

adminShareRouter.delete("/:id", async (req, res, next) => {
  try {
    const share = findById(String(req.params.id))
    if (!share) throw shareError(404, "分享不存在", "api.share.not_found")
    await revokeShare(share.id, { role: "superadmin" })
    info("share_admin_revoke", { msg: `${share.name}（${share.owner}）`, user: req.auth.username, ip: req.ip })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
