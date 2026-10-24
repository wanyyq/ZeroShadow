import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { WEBDAV_PATH } from "./env.js"
import { verifyLogin, findById } from "./users.js"
import { isSuperUser, loginLocked, recordLoginFail, recordLoginSuccess } from "./auth.js"
import { getConfig, uploadLimitBytes } from "./config.js"
import { normRel, resolveAny, joinRel, isSameOrInside } from "./safety.js"
import { contentDisposition } from "./http.js"
import { copyEntry, listDir, moveEntry, statSafe } from "./files.js"
import { permsForContext, resolveGroupContext, visibilityForContext, isVisibleForContext } from "./groups.js"
import { moveToTrash } from "./trash.js"
import { info, warn } from "./logger.js"

// ============================================================================
//  webdav.js - WebDAV 挂载（v2.0 起为正式功能）
//
//  开关与挂载点都在后台「设置 → 公网 → WebDAV」里，实时生效、不需要重启：
//      webdavEnabled : 是否启用（默认 false）
//      webdavPath    : 挂载路径（默认 /dav）
//  兼容旧配置：这两个字段的**默认值**取自 .env 的 WEBDAV / WEBDAV_PATH，
//  但后台一旦保存过就以 config.json 为准（见 config.js 的说明）。
//
//  正式化之后仍然保留的三条硬约束（它们不是"实验性"的痕迹，而是协议本身的代价）：
//    1. WebDAV 客户端普遍只支持 **HTTP Basic 认证** —— 用户名密码会在**每一个
//       请求**里重复发送。在 HTTP（非 HTTPS）下等于把凭据反复明文扔到网络上。
//       → 因此后台开关旁会明确提示"请只在 HTTPS 或完全可信的内网使用"。
//    2. 挂载后文件可以被资源管理器/第三方客户端任意读写，权限判定必须与
//       Web 端完全一致，任何遗漏都是越权读写。
//    3. 各家客户端（Windows 资源管理器 / macOS Finder / RaiDrive / rclone /
//       Office）对协议细节的实现差异很大，行为无法像 HTTP 接口那样被完整覆盖。
//
//  安全设计（逐条对应上面的风险）：
//    - **只接受 Basic 认证，绝不认 Cookie**。如果 DAV 也接受会话 Cookie，那么任意
//      网页都能借用户浏览器里已有的登录态发起 `PROPFIND`/`PUT` —— 相当于一个
//      绕过 CSRF 校验的后门。
//    - **不接受超级管理员账号**：超管密码只应出现在 .env 与本机，不该被任何
//      客户端反复发送。DAV 只对成员账号（bcrypt）开放。
//    - **凭据缓存**：Basic 凭据每个请求都来，若每次都跑 bcrypt，一个脚本就能把
//      单核 CPU 打满（bcrypt 成本 10 ≈ 100ms）。这里按
//      `sha256(username + 口令) → 校验结果` 缓存 60 秒，并在用户的
//      `tokenVersion` 变化（改密码 / 禁用 / 删除）时立即失效。
//    - 权限判定复用 `effectivePerms(role, group)`，与 Web 端同一套；
//      路径解析复用 `normRel` / `resolveAny`，穿越与越界同样被拦。
//    - 写操作（PUT/MKCOL/DELETE/MOVE/COPY）先过对应的权限点，再执行；
//      覆盖 = 删除，因此还要 `delete` 权限并进回收站。
//    - 单文件上传受 `uploadLimitBytes(role)` 限制，与 Web 端一致。
//    - 访客隐藏目录 / 小组可见范围同样生效，被隐藏的路径返回 **404**（不是 403），
//      避免通过状态码探测出"这里有什么"。
//    - 只读映射目录（FILES_SOFT_DIR）一律只读。
//    - 拒绝 `Depth: infinity` 的 PROPFIND（否则一次请求就能把整棵树扫一遍）、
//      限制单次列出的子项数量、限制锁表规模、限制非 PUT 请求体大小。
// ============================================================================

const DAV_METHODS = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK"

/** 单次 PROPFIND 最多返回多少个子项（防"一次请求扫全盘"） */
const MAX_PROPFIND_CHILDREN = 5000
/** 锁表上限：仅供客户端"以为锁生效"，不能当免费存储用 */
const MAX_LOCKS = 2000
/** 非 PUT 请求（PROPFIND/PROPPATCH/LOCK）的请求体上限：我们根本不读它，直接拒 */
const MAX_META_BODY = 64 * 1024
/** 每个 IP 每分钟的 DAV 请求上限（读多写少，给足余量；真正防的是 bcrypt 洪水） */
const DAV_RATE_PER_MIN = 1200

/** 内存锁表：只做到"让客户端以为锁生效"的程度，不做真实的排他控制 */
const locks = new Map()
const LOCK_TTL_MS = 30 * 60 * 1000

function sweepLocks() {
  const now = Date.now()
  for (const [token, lock] of locks) {
    if (lock.expiresAt < now) locks.delete(token)
  }
}

function xmlEscape(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * DAV 里统一的 ETag：`"s-<mtimeMs>-<size>"`。
 *
 * 为什么 DAV 不用在线编辑器那套"内容哈希"（`versionOf`）：
 *   - PROPFIND 是**批量**的（一次列 5000 个子项），逐个读文件算哈希等于把整棵目录
 *     读一遍，弱网下反而卡死；而客户端只拿 ETag 做"变没变"的判断。
 *   - 更要紧的是**一致性**：Windows 资源管理器 / Office 会先用 PROPFIND 拿到
 *     `getetag`，保存时再用它做 `If-Match`。旧实现 PROPFIND 给的是
 *     `"d-<mtime>"`（还是给了目录、漏了文件），而 PUT 比对的是内容哈希 ——
 *     两边永远不相等，于是每次保存都被判成 412「文件已被他人修改」。
 *     现在 PROPFIND / GET / HEAD / PUT 用的是同一个函数、同一个值。
 */
function davEtag(stat) {
  return `"s-${Math.trunc(stat?.mtimeMs || 0)}-${stat?.size || 0}"`
}

/**
 * RFC 1123 的 Last-Modified —— `Date.prototype.toUTCString()` 的输出正好合规，
 * 但它对无效日期会给出 "Invalid Date"，所以先兜一下底。
 */
function httpDate(ms) {
  const d = new Date(Number(ms) || 0)
  return Number.isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString()
}

/** ISO 8601（creationdate 用），DAV 要求带 Z */
function isoDate(ms) {
  const d = new Date(Number(ms) || 0)
  return Number.isNaN(d.getTime()) ? "1970-01-01T00:00:00Z" : d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * 解析 PROPFIND 的请求体，得出客户端**到底要哪些属性**。
 *
 * 为什么要解析：RFC 4918 规定服务端要么把请求的属性都给出（200），要么在
 * **第二个 propstat 里用 404 说明"这个属性我没有"**。旧实现无视请求体、永远返回
 * 自己那固定几项，于是客户端要 `creationdate` / `lockdiscovery` 时什么也拿不到 ——
 * 资源管理器与 Office 对此的容忍度差别很大（Office 会认为文件"不可编辑"）。
 *
 * 返回：
 *   - `null`：客户端发的是 `<D:allprop/>`、空体或解析失败 → 全部属性都给
 *   - 否则是属性名的数组（不含 `D:` 前缀，统一小写），可能为空数组
 */
function parsePropfindBody(body) {
  const text = String(body || "")
  if (!text.trim()) return null
  if (/allprop/i.test(text)) return null
  const names = []
  // 只认 <D:xxx/> 这种自闭合或成对标签里的属性名；先剥掉外层 propfind
  const re = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)\s*\/?>/g
  let m
  let insideProp = false
  const propStart = /<(?:[A-Za-z0-9_.-]+:)?prop\b[^>]*>/i.exec(text)
  const propEnd = /<\/(?:[A-Za-z0-9_.-]+:)?prop\s*>/i.exec(text)
  if (!propStart) return null
  const inner = propEnd
    ? text.slice(propStart.index + propStart[0].length, propEnd.index)
    : text.slice(propStart.index + propStart[0].length)
  insideProp = true
  while ((m = re.exec(inner)) !== null) {
    const name = m[1].toLowerCase()
    // 过滤掉集合类容器名（prop / propfind 本身不会出现在 inner 里，但防御一下）
    if (name === "prop" || name === "propfind" || name === "allprop") continue
    if (!names.includes(name)) names.push(name)
  }
  return insideProp ? names : null
}

/** 一个属性节点的名字（用于把"属性名 → XML 片段"的表拼出来） */
const PROP_ORDER = [
  "resourcetype",
  "displayname",
  "getcontentlength",
  "getcontenttype",
  "getlastmodified",
  "creationdate",
  "getetag",
  "supportedlock",
  "lockdiscovery",
]

/**
 * 极简扩展名 → MIME 映射。
 *
 * 只用于 DAV 的 `Content-Type` 与 PROPFIND 的 `getcontenttype`：客户端（尤其是
 * Windows 资源管理器 / Office）会按类型决定"用什么打开"，全给
 * `application/octet-stream` 会让双击行为变成"未知文件"。
 * 注意 GET 仍然强制 `Content-Disposition: attachment`，所以 html/svg 不会被当页面执行。
 */
const DAV_MIME = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

function mimeOf(name) {
  return DAV_MIME[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream"
}

/** 保留的路径前缀：既是后端接口，也是前端路由与静态目录 */
const RESERVED_PREFIXES = new Set([
  "api",
  "ping",
  "s", // 分享页 /s/<token>
  "assets",
  "resources",
  "robustness",
  "login",
  "settings",
  "team",
  "preview",
  "editor",
  "html-preview",
  "tools",
  "about",
])

/** 规范化挂载路径：必须以 / 开头、去掉结尾斜杠、只允许安全字符 */
export function normalizeDavPath(raw) {
  let p = String(raw || "").trim()
  if (!p) return "/dav"
  if (!p.startsWith("/")) p = `/${p}`
  p = p.replace(/\/+$/, "")
  // 只允许 URL 安全字符：避免把挂载点写成 "/.."、"//x" 这类会打架的路径
  if (!/^\/[A-Za-z0-9._~\-/]{0,63}$/.test(p)) return "/dav"
  if (p === "/" || p.includes("//")) return "/dav"
  // 不能占用接口前缀、前端路由或静态目录：否则挂载点会把它们整个遮住
  // （例如把挂载点设成 /assets，前端所有 JS 都会变成 DAV 请求）。
  const first = p.slice(1).split("/")[0].toLowerCase()
  if (RESERVED_PREFIXES.has(first)) return "/dav"
  return p
}

/** 当前生效的挂载点（后台可改，实时生效） */
export function davPath() {
  let configured = WEBDAV_PATH
  try {
    configured = getConfig().webdavPath || WEBDAV_PATH
  } catch {
    /* 配置读不到（极端情况）就退回 .env 的值 */
  }
  return normalizeDavPath(configured)
}

function enabledNow() {
  try {
    return getConfig().webdavEnabled === true
  } catch {
    return false
  }
}

/** 供后台「设置 → 公网」展示的启用信息 */
export function webdavStatus() {
  const p = davPath()
  return {
    enabled: enabledNow(),
    path: p,
    experimental: false,
    lockCount: locks.size,
    mountPath: `${p}/`,
  }
}

/* ====================================================== 轻量限流（按 IP） == */

const davBuckets = new Map()
const DAV_WINDOW_MS = 60 * 1000

function davRateLimited(ip) {
  const now = Date.now()
  let bucket = davBuckets.get(ip)
  if (!bucket || now - bucket.start > DAV_WINDOW_MS) {
    bucket = { start: now, count: 0 }
    davBuckets.set(ip, bucket)
    // 有界：条目太多时按最早开始时间淘汰，避免被换 IP 撑爆内存
    if (davBuckets.size > 5000) {
      const oldest = [...davBuckets.entries()].sort((a, b) => a[1].start - b[1].start).slice(0, 500)
      for (const [key] of oldest) davBuckets.delete(key)
    }
  }
  bucket.count += 1
  return bucket.count > DAV_RATE_PER_MIN
}

/* ================================================ Basic 凭据校验结果缓存 == */

/**
 * Basic 凭据每个请求都会重复发送。每次都跑 bcrypt（成本 10 ≈ 100ms）的话，
 * 一个脚本就能把单核 CPU 打满；缓存 60 秒后，日常挂载的文件浏览几乎不再有
 * bcrypt 开销（这也是"弱网/穿透链路下更好用"的一部分）。
 *
 * 缓存键是 sha256(username + 口令)，**不存明文口令**；命中后仍会校验该账号的
 * `tokenVersion`，所以改密码 / 禁用 / 删除会立即让缓存失效。
 */
const CRED_TTL_MS = 60 * 1000
const CRED_MAX = 500
const credCache = new Map()

function credKey(username, password) {
  return crypto.createHash("sha256").update(`${username}\u0000${password}`).digest("base64url")
}

function credLookup(key) {
  const hit = credCache.get(key)
  if (!hit) return null
  if (hit.expiresAt < Date.now()) {
    credCache.delete(key)
    return null
  }
  const user = findById(hit.userId)
  if (!user || user.disabled || user.tokenVersion !== hit.tv) {
    credCache.delete(key)
    return null
  }
  return user
}

function credStore(key, user) {
  if (credCache.size >= CRED_MAX) {
    // 有界：先清过期，再淘汰最早写入的一批
    const now = Date.now()
    for (const [k, v] of credCache) if (v.expiresAt < now) credCache.delete(k)
    if (credCache.size >= CRED_MAX) {
      const drop = [...credCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, 50)
      for (const [k] of drop) credCache.delete(k)
    }
  }
  credCache.set(key, { userId: user.id, tv: user.tokenVersion, expiresAt: Date.now() + CRED_TTL_MS })
}

/* ============================================================ Basic 认证 == */

function unauthorized(res, message = "需要 WebDAV 账号密码", errorKey = "api.webdav.auth_required") {
  // Basic realm 用中文会触发部分客户端的编码问题，保持 ASCII
  res.setHeader("WWW-Authenticate", 'Basic realm="ZeroShadow WebDAV", charset="UTF-8"')
  // errorKey/errorParams 与 HTTP 接口同一套命名键（见 http.js）：
  // `error` 仍是中文原文，客户端不认这两个字段时行为不变。
  res.status(401).json({ error: message, errorKey })
}

function parseBasic(header) {
  if (!header || !/^Basic\s+/i.test(header)) return null
  let decoded = ""
  try {
    decoded = Buffer.from(header.replace(/^Basic\s+/i, "").trim(), "base64").toString("utf8")
  } catch {
    return null
  }
  const idx = decoded.indexOf(":")
  if (idx < 0) return null
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

/**
 * 认证中间件。
 * 只认 Basic —— 刻意**不**回落到 Cookie 会话，原因见文件头。
 */
async function basicAuth(req, res, next) {
  const creds = parseBasic(req.headers.authorization)
  if (!creds || !creds.username || !creds.password) return unauthorized(res)

  // 与 Web 登录共用同一套失败计数：Basic 凭据每个请求都会重复发送，没有锁定
  // 就等于把成员口令暴露给无限次离线/在线猜测，还会被用来打满 bcrypt 的 CPU。
  const locked = loginLocked(req.ip, creds.username)
  if (locked > 0) {
    res.setHeader("Retry-After", String(locked * 60))
    return res.status(429).json({
      error: `尝试次数过多，请 ${locked} 分钟后再试`,
      errorKey: "api.auth.too_many_attempts",
      errorParams: { minutes: locked },
    })
  }

  // 超管账号不接受（密码只应留在 .env 与本机，不该被客户端反复发送）。
  // 显式判断而不是靠"查不到用户"：一是省掉一次 dummy bcrypt，二是给客户端一个
  // 明确的原因，否则用户只会看到反复弹密码框。
  if (isSuperUser(creds.username)) {
    warn("webdav_auth_superadmin", { msg: creds.username, ip: req.ip })
    return res.status(403).json({
      error: "WebDAV 不接受超级管理员账号，请改用团队成员账号",
      errorKey: "api.webdav.superadmin_denied",
    })
  }

  const key = credKey(creds.username, creds.password)
  let user = credLookup(key)
  if (!user) {
    const result = await verifyLogin(creds.username, creds.password)
    if (!result.ok) {
      recordLoginFail(req.ip, creds.username)
      warn("webdav_auth_fail", { msg: creds.username, ip: req.ip })
      return unauthorized(res, "用户名或密码错误", "api.webdav.invalid_credentials")
    }
    recordLoginSuccess(req.ip, creds.username)
    user = result.user
    credStore(key, user)
  }
  // 与 Web 端一致：小组上下文走 ?group= 或 X-ZS-Group（DAV 客户端一般不发头，
  // 因此默认落在「默认上下文」上，权限即全局 memberPerms）
  const groupCtx = resolveGroupContext({
    auth: { role: "member", userId: user.id, username: user.username },
    headers: req.headers,
    query: req.query,
  })
  req.dav = {
    username: user.username,
    userId: user.id,
    group: groupCtx.group,
    // 与 Web 端同一套"缺省上下文"规则：没带小组头时权限取所属组交集，
    // 而不是回落到全局 memberPerms（DAV 客户端默认就不发这个头）
    perms: permsForContext("member", user.id, groupCtx.group),
    visibility: visibilityForContext("member", user.id, groupCtx.group),
  }
  next()
}

/* ============================================================== 路径处理 == */

function davBase() {
  return davPath()
}

/** 把 DAV 请求路径转成网盘内的相对路径；不合法时返回 null */
function relFromUrl(req) {
  let p = req.path || "/"
  // 去掉前缀（挂载点既可能是 /dav 也可能是 /dav/xxx）
  const base = davBase()
  if (p === base) p = "/"
  else if (p.startsWith(base + "/")) p = p.slice(base.length)
  // DA V 路径按 URL 编码，先解码再交给 normRel 做穿越校验
  try {
    p = decodeURIComponent(p)
  } catch {
    return null
  }
  try {
    return normRel(p.replace(/^\/+/, ""))
  } catch {
    return null
  }
}

/** 相对路径是否对当前身份可见（隐藏目录按"不存在"处理） */
function visible(req, rel) {
  if (!rel) return true
  // DAV 只接受成员账号，而「对访客隐藏」只应约束访客；套在成员身上会让成员
  // 在 Web 端看得到的目录在挂载盘里变成 404（与文档「成员一切正常」相反）。
  return isVisibleForContext(rel, {
    role: "member",
    group: req.dav.group,
    userId: req.dav.userId,
    visibility: req.dav.visibility,
  })
}

function deny(res, perm) {
  res.status(403).json({
    error: `没有权限执行此操作（需要 ${perm}）`,
    errorKey: "api.webdav.permission_denied",
    errorParams: { perm },
  })
}

/** 解析目标并做全部校验；不通过时已经写好响应，返回 null */
function resolveOrReply(req, res) {
  const rel = relFromUrl(req)
  if (rel === null) {
    res.status(400).json({ error: "非法路径", errorKey: "api.webdav.path_invalid" })
    return null
  }
  // **必须先 resolveAny 再判可见性**，并且用 resolveAny 返回的规范化相对路径去判。
  // 可见性（对访客隐藏 / 小组可见范围）本质是字符串比较，而同一个目录至少有三种
  // 写法：长名、8.3 短名（`web` / `WEB~1`）、经 junction 的路径。拿 URL 里的原串
  // 去比，`WEB~1` 不等于配置里的 `web`，判定就放行，而读盘落到真正的 web 上 ——
  // 与 routes/fs.js 的 collectZipItems 是同一类问题（见 safety.js:130-132 的契约）。
  const resolved = resolveAny(rel)
  if (!visible(req, resolved.rel)) {
    // 隐藏路径故意用 404：用 403 等于告诉对方"这里确实有东西"
    res.status(404).json({ error: "文件或目录不存在", errorKey: "api.webdav.not_found" })
    return null
  }
  return resolved
}

/* ================================================================= 方法 == */

function hrefFor(req, rel, isDir) {
  const encoded = String(rel || "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
  const base = davBase()
  const href = `/${encoded}`.replace(/^\/+/, "/")
  const full = `${base}${href === "/" ? "/" : href}`
  return isDir && !full.endsWith("/") ? full + "/" : full
}

/**
 * 一个 `<D:response>` 元素。
 *
 * @param {object} req
 * @param {string} rel 相对路径（"" = 挂载点根）
 * @param {{mtimeMs:number,size:number}} stat
 * @param {boolean} isDir
 * @param {string[]|null} wanted 客户端点名的属性（null = 全给）
 */
function propResponse(req, rel, stat, isDir, wanted = null) {
  const name = rel ? rel.split("/").pop() : davBase().split("/").filter(Boolean).pop() || "dav"
  // 属性名 → XML 片段。**每个属性都必须能拼出来**，缺谁就进第二个 propstat 的 404。
  const available = {
    resourcetype: isDir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>",
    displayname: `<D:displayname>${xmlEscape(name)}</D:displayname>`,
    getcontentlength: isDir ? null : `<D:getcontentlength>${stat.size || 0}</D:getcontentlength>`,
    getcontenttype: isDir ? null : `<D:getcontenttype>${xmlEscape(mimeOf(name))}</D:getcontenttype>`,
    getlastmodified: `<D:getlastmodified>${httpDate(stat.mtimeMs)}</D:getlastmodified>`,
    creationdate: `<D:creationdate>${isoDate(stat.mtimeMs)}</D:creationdate>`,
    // ETag 只给文件：集合没有内容，编一个假 ETag 只会让客户端做无意义的重取
    getetag: isDir ? null : `<D:getetag>${xmlEscape(davEtag(stat))}</D:getetag>`,
    supportedlock:
      "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>",
    // 空元素 = "当前没有锁"。资源管理器 / Office 会主动问这一项，
    // 完全不给的话有些客户端会认为服务器不支持锁、进而放弃写入。
    lockdiscovery: "<D:lockdiscovery/>",
  }

  const names = wanted && wanted.length ? wanted : PROP_ORDER
  const okParts = []
  const missing = []
  for (const key of names) {
    const xml = available[key]
    if (xml) okParts.push(xml)
    else if (wanted && wanted.length) missing.push(key)
  }

  const out = ["<D:response>", `<D:href>${xmlEscape(hrefFor(req, rel, isDir))}</D:href>`]
  if (okParts.length || !wanted || !wanted.length) {
    out.push("<D:propstat><D:prop>", okParts.join(""), "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>")
  }
  if (missing.length) {
    // 客户端点名要了但我们没有的属性：按 RFC 4918 用 404 明确回答，
    // 而不是"静默少给"。Office 对"问 lockdiscovery 却啥也没回"很敏感。
    out.push(
      "<D:propstat><D:prop>",
      missing.map((key) => `<D:${key}/>`).join(""),
      "</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>"
    )
  }
  out.push("</D:response>")
  return out.join("")
}

/** 207 响应的统一出口：头部齐全（DAV / Allow / no-cache）才算合规 */
function sendMultistatus(res, body) {
  res.status(207)
  res.setHeader("Content-Type", 'application/xml; charset="utf-8"')
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
  res.setHeader("DAV", "1, 2")
  res.send(body)
}

/** 统一的 DAV 错误体（XML 形式，客户端才看得懂 precondition） */
function sendDavError(res, status, key, message) {
  res.status(status)
  res.setHeader("Content-Type", 'application/xml; charset="utf-8"')
  res.setHeader("DAV", "1, 2")
  res.send(
    '<?xml version="1.0" encoding="utf-8"?>' +
      `<D:error xmlns:D="DAV:"><D:${key}/></D:error>` +
      (message ? `<!-- ${xmlEscape(message)} -->` : "")
  )
}


async function handlePropfind(req, res) {
  if (!req.dav.perms.browse) return deny(res, "browse")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  const stat = await statSafe(resolved.abs)
  if (!stat || stat.isSymbolicLink()) {
    return res.status(404).json({ error: "文件或目录不存在", errorKey: "api.webdav.not_found" })
  }

  const isDir = stat.isDirectory()
  const depth = String(req.headers.depth ?? "1").trim().toLowerCase()
  // 拒绝 Depth: infinity：一次请求就能让服务递归扫描整棵目录树（资源管理器
  // 挂载时并不会发它，只有刻意构造的请求才会）。按 RFC 4918 §9.1 用
  // `<D:propfind-finite-depth/>` 明确表达"我只支持有限深度"——
  // 旧实现回了一段 JSON，客户端解析不出 precondition，只能当成未知错误。
  if (depth === "infinity") {
    return sendDavError(res, 403, "propfind-finite-depth", "只支持 Depth: 0 或 1")
  }
  // 客户端点名的属性（null = 全给）
  const wanted = parsePropfindBody(req.rawBody)
  const parts = [propResponse(req, resolved.rel, stat, isDir, wanted)]

  if (isDir && depth !== "0") {
    let entries = []
    try {
      entries = await listDir(resolved.abs, resolved.rel, { forGuest: false })
    } catch {
      entries = []
    }
    // 单次列出的子项上限：超大目录直接拒绝，而不是拼一个几十 MB 的 XML 回去
    if (entries.length > MAX_PROPFIND_CHILDREN) {
      return res.status(507).json({
        error: `目录内项目过多（超过 ${MAX_PROPFIND_CHILDREN} 项），请改用 Web 界面浏览`,
        errorKey: "api.webdav.too_many_children",
        errorParams: { limit: MAX_PROPFIND_CHILDREN },
      })
    }
    for (const entry of entries) {
      const childRel = joinRel(resolved.rel, entry.name)
      // 逐项过滤可见性：不可见的子项不能出现在列表里
      if (!visible(req, childRel)) continue
      const childIsDir = entry.type === "dir"
      parts.push(
        propResponse(
          req,
          childRel,
          { mtimeMs: entry.mtime || 0, size: childIsDir ? 0 : entry.size || 0 },
          childIsDir,
          wanted
        )
      )
    }
  }

  sendMultistatus(res, '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' + parts.join("") + "</D:multistatus>")
}

/**
 * PROPPATCH —— 资源管理器与 Office 会用它写 Win32 属性。
 *
 * 旧实现直接回了一段 `<D:multivaluedate .../>`：既不是 multistatus、也不是合法的
 * DAV 元素，任何认真解析响应的客户端都会判定"属性写入失败"（Office 保存后
 * 弹"文档已被修改"就是这么来的）。
 *
 * 现在按 RFC 的形状回 `207 multistatus`，每个被点名的属性给一个 200；其中
 * `Win32LastModifiedTime` 会**真的应用**（`utimes`）—— 这是复制/另存为时
 * 客户端最在意的一项，其余属性（文件属性位、扩展属性）如实忽略。
 */
async function handleProppatch(req, res) {
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) {
    return res.status(403).json({ error: "外部映射目录仅支持只读操作", errorKey: "api.webdav.soft_readonly" })
  }
  const stat = await statSafe(resolved.abs)
  if (!stat) return res.status(404).json({ error: "文件或目录不存在", errorKey: "api.webdav.not_found" })
  if (!req.dav.perms.fileWrite) return deny(res, "fileWrite")

  const body = String(req.rawBody || "")
  const props = []
  const re = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?\1\s*>/g
  let m
  while ((m = re.exec(body)) !== null) {
    const name = m[1]
    if (/^(propertyupdate|set|remove|prop)$/i.test(name)) continue
    props.push({ name, value: m[2].trim() })
  }

  // 时间戳是真的能落地的：Win32LastModifiedTime 的取值是 RFC1123 字符串
  const mtimeProp = props.find((p) => /^win32lastmodifiedtime$/i.test(p.name))
  if (mtimeProp) {
    const ts = Date.parse(mtimeProp.value)
    if (Number.isFinite(ts)) {
      try {
        await fs.promises.utimes(resolved.abs, new Date(), new Date(ts))
        info("webdav_proppatch_mtime", { msg: `${resolved.rel} → ${new Date(ts).toISOString()}`, user: req.dav.username, ip: req.ip })
      } catch {
        /* 时间戳写不进去不影响属性写入的结论 */
      }
    }
  }

  const names = props.length ? props.map((p) => p.name) : ["Win32LastModifiedTime"]
  const propXml = names.map((name) => `<D:${xmlEscape(name)}/>`).join("")
  sendMultistatus(
    res,
    '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' +
      "<D:response>" +
      `<D:href>${xmlEscape(hrefFor(req, resolved.rel, stat.isDirectory()))}</D:href>` +
      `<D:propstat><D:prop>${propXml}</D:prop>` +
      "<D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
      "</D:response></D:multistatus>"
  )
}

async function handleGet(req, res, headOnly) {
  if (!req.dav.perms.downloadFile) return deny(res, "downloadFile")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  const stat = await statSafe(resolved.abs)
  if (!stat || !stat.isFile()) {
    return res.status(404).json({ error: "文件不存在", errorKey: "api.webdav.file_not_found" })
  }

  // ETag 必须与 PROPFIND 的 `getetag` 完全一致：客户端会拿列表里的 ETag 做
  // If-Match / If-None-Match，两边算法一旦不同，每次保存都会被判成版本冲突。
  const etag = davEtag(stat)
  res.setHeader("ETag", etag)
  res.setHeader("Last-Modified", httpDate(stat.mtimeMs))
  // 条件 GET：客户端（rclone / 资源管理器缩略图）会带 If-None-Match 复用缓存，
  // 命中直接 304，不再重传文件内容 —— 弱网 / 穿透链路上这一条最省流量。
  const inm = req.headers["if-none-match"]
  if (inm && String(inm).split(",").some((v) => v.trim() === etag)) {
    return res.status(304).end()
  }
  res.setHeader("Accept-Ranges", "bytes")
  res.setHeader("Content-Type", mimeOf(resolved.abs))
  // 强制下载：DAV 内容里包含用户上传的 HTML/SVG，不该在浏览器里当作页面执行
  res.setHeader("Content-Disposition", contentDisposition("attachment", path.basename(resolved.abs)))
  if (headOnly) {
    res.setHeader("Content-Length", String(stat.size))
    return res.status(200).end()
  }
  // sendFile 自带 Range 支持（视频拖进度条、断点续传都靠它）
  res.sendFile(resolved.abs, { dotfiles: "allow", cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end()
  })
}

async function handlePut(req, res) {
  if (!req.dav.perms.fileWrite || !req.dav.perms.upload) return deny(res, "upload")
  // 请求体若已被 express.json() 解析过，流已经到底了：继续 pipe 只会在目标位置
  // 写出一份 0 字节文件并返回 204（静默数据丢失）。这里明确拒绝，逼客户端换
  // Content-Type（真正的修法是把 DAV 挂在 body parser 之前，见 index.js）。
  if (req._body) {
    return res.status(415).json({
      error: "该 Content-Type 的请求体已被应用层解析，WebDAV 无法读取；请改用 application/octet-stream",
      errorKey: "api.webdav.body_consumed",
    })
  }
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作", errorKey: "api.webdav.soft_readonly" })
  if (!resolved.rel) {
    return res.status(405).json({ error: "不能写入根目录", errorKey: "api.webdav.root_write_denied" })
  }

  const limit = uploadLimitBytes("member")
  const parentStat = await statSafe(path.dirname(resolved.abs))
  if (!parentStat || !parentStat.isDirectory()) {
    return res.status(409).json({ error: "上级目录不存在", errorKey: "api.webdav.parent_missing" })
  }

  const existing = await statSafe(resolved.abs)
  if (existing && existing.isDirectory()) {
    return res.status(405).json({ error: "目标是目录，不能用 PUT 覆盖", errorKey: "api.webdav.put_on_directory" })
  }
  // If-Match 不一致 → 412；这让支持它的客户端能做乐观并发控制
  // If-Match 必须拿**客户端手上那个值**来比：客户端是从 PROPFIND/GET 的
  // `getetag` 拿到它的，所以这里也只能用 davEtag。旧实现用的是内容哈希，
  // 于是"列表里拿到的 ETag → 保存"这条最正常的路径永远 412。
  if (existing && req.headers["if-match"]) {
    const current = davEtag(existing)
    if (req.headers["if-match"] !== current) {
      return res.status(412).json({ error: "文件已被其他人修改", errorKey: "api.webdav.version_conflict" })
    }
  }

  const tmp = path.join(path.dirname(resolved.abs), `.${path.basename(resolved.abs)}.${process.pid}.${Date.now()}.davtmp`)
  let written = 0
  let tooBig = false
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp)
      req.on("data", (chunk) => {
        written += chunk.length
        if (limit > 0 && written > limit) {
          tooBig = true
          req.destroy()
          ws.destroy()
          reject(new Error("__TOO_BIG__"))
        }
      })
      req.on("error", reject)
      ws.on("error", reject)
      ws.on("finish", resolve)
      req.pipe(ws)
    })
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    if (tooBig) {
      // 大小上限是变量，放进 errorParams 让译文里的 {limit} 能正确插值
      return res.status(413).json({
        error: `超出上传大小限制（${Math.round(limit / 1024 / 1024)}MB）`,
        errorKey: "api.webdav.upload_too_large",
        errorParams: { limit: `${Math.round(limit / 1024 / 1024)}MB` },
      })
    }
    return res.status(500).json({ error: "写入失败", errorKey: "api.webdav.write_failed" })
  }

  // 覆盖 = 删除。与 /api/fs/upload、/rename 的 removeForOverwrite 保持同一套规则：
  //   1. 需要 **delete** 权限 —— 否则只有 upload 权限的成员写一次同名文件，
  //      就能永久销毁别人的数据；
  //   2. 旧文件要进**回收站** —— 否则一次误覆盖就彻底没了。
  // 旧实现直接 rename(tmp, dest)，这两条都不满足（而本文件头部注释与
  // docs/安全设计.md 却都写着"覆盖类操作还要 delete 权限并进回收站"）。
  //
  // 顺序刻意放在**请求体收完之后**：先收进 tmp 再动原文件，中途失败/断流时
  // 旧文件仍然完好，不会出现"删了旧的、新的没写进来"。
  if (existing) {
    if (!req.dav.perms.delete) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
      return res.status(403).json({
        error: "覆盖会删除已有的同名文件，需要「删除」权限",
        errorKey: "api.fs.overwrite_needs_delete",
      })
    }
    const trashed = await moveToTrash(
      { abs: resolved.abs, rel: resolved.rel },
      { user: req.dav.username, role: "member", ip: req.ip }
    )
    // 回收站不可用（目录只读 / 磁盘满）时才退回彻底删除 —— 与 COPY/MOVE 的覆盖分支一致
    if (!trashed && (await statSafe(resolved.abs))) {
      await fs.promises.rm(resolved.abs, { recursive: true, force: true })
    }
  }

  try {
    // 原子替换：与在线编辑器同一套做法，避免写盘中断留下半个文件
    await fs.promises.rename(tmp, resolved.abs).catch(async () => {
      await fs.promises.rm(resolved.abs, { force: true })
      await fs.promises.rename(tmp, resolved.abs)
    })
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    return res.status(500).json({ error: "保存失败", errorKey: "api.webdav.save_failed" })
  }
  info("webdav_put", { msg: `${resolved.rel} (${written} bytes)`, user: req.dav.username, ip: req.ip })
  res.status(existing ? 204 : 201).end()
}

async function handleMkcol(req, res) {
  if (!req.dav.perms.fileWrite || !req.dav.perms.mkdir) return deny(res, "mkdir")
  // RFC 4918：MKCOL 不接受请求体（带 body 的应当 415）
  if (Number(req.headers["content-length"] || 0) > 0) {
    return res.status(415).json({ error: "MKCOL 不接受请求体", errorKey: "api.webdav.mkcol_body_unsupported" })
  }
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作", errorKey: "api.webdav.soft_readonly" })
  if (!resolved.rel) return res.status(405).json({ error: "根目录已存在", errorKey: "api.webdav.root_exists" })
  if (await statSafe(resolved.abs)) {
    return res.status(405).json({ error: "已存在同名项目", errorKey: "api.webdav.already_exists" })
  }
  // 上级目录必须真实存在（RFC 要求缺失时返回 409，而不是"顺手建一条目录链"：
  // 后者会让一次 MKCOL /a/b/c 在 /a 根本不存在时也成功，客户端会以为是别的问题）
  const parent = await statSafe(path.dirname(resolved.abs))
  if (!parent || !parent.isDirectory()) {
    return res.status(409).json({ error: "上级目录不存在", errorKey: "api.webdav.parent_missing" })
  }
  await fs.promises.mkdir(resolved.abs, { recursive: false })
  info("webdav_mkcol", { msg: resolved.rel, user: req.dav.username, ip: req.ip })
  res.status(201).end()
}

async function handleDelete(req, res) {
  if (!req.dav.perms.fileWrite || !req.dav.perms.delete) return deny(res, "delete")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作", errorKey: "api.webdav.soft_readonly" })
  if (!resolved.rel) {
    return res.status(403).json({ error: "不能删除根目录", errorKey: "api.webdav.root_delete_denied" })
  }
  const stat = await statSafe(resolved.abs)
  if (!stat) return res.status(404).json({ error: "文件或目录不存在", errorKey: "api.webdav.not_found" })

  // 与 Web 端保持一致：删除进回收站（可用时）
  const trashed = await moveToTrash(resolved, { user: req.dav.username, role: "member", ip: req.ip })
  if (!trashed) {
    await fs.promises.rm(resolved.abs, { recursive: true, force: true })
  }
  info("webdav_delete", { msg: resolved.rel, user: req.dav.username, ip: req.ip })
  res.status(204).end()
}

async function handleCopyMove(req, res, isMove) {
  const perm = isMove ? "move" : "copy"
  if (!req.dav.perms.fileWrite || !req.dav.perms[perm]) return deny(res, perm)
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作", errorKey: "api.webdav.soft_readonly" })
  const destination = req.headers.destination
  if (!destination) {
    return res.status(400).json({ error: "缺少 Destination 头", errorKey: "api.webdav.destination_required" })
  }

  // Destination 是完整 URL，取出其中的路径部分再套用前缀剥离
  let destPath = destination
  try {
    const parsed = new URL(destination)
    // 目标主机必须是本站：否则等于让服务按客户端的指示去操作另一个主机。
    // 只比 **hostname**、不比端口 —— 反代（Caddy / Nginx）后面，客户端拼出的
    // Destination 带的是它自己看到的端口（可能是 443，也可能带 :8443），
    // 而 Node 收到的 Host 头可能已被改写。旧实现连端口一起比，于是"反向代理 +
    // WebDAV"下所有复制/重命名都回 502，而资源管理器只会说"操作无法完成"。
    const destHost = parsed.hostname.toLowerCase()
    const selfHosts = new Set()
    for (const raw of [req.headers.host, req.headers["x-forwarded-host"]]) {
      const value = String(raw || "").split(",")[0].trim()
      if (!value) continue
      try {
        selfHosts.add(new URL(`http://${value}`).hostname.toLowerCase())
      } catch {
        selfHosts.add(value.toLowerCase())
      }
    }
    if (destHost && selfHosts.size && !selfHosts.has(destHost)) {
      return res.status(502).json({ error: "目标地址不属于本站点", errorKey: "api.webdav.destination_host_mismatch" })
    }
    destPath = parsed.pathname
  } catch {
    /* 也可能是相对路径，直接用 */
  }
  const base = davBase()
  if (destPath === base) destPath = "/"
  else if (destPath.startsWith(base + "/")) destPath = destPath.slice(base.length)
  let destRel
  try {
    destRel = normRel(decodeURIComponent(destPath).replace(/^\/+/, ""))
  } catch {
    return res.status(400).json({ error: "目标路径非法", errorKey: "api.webdav.destination_invalid" })
  }
  // 目标同样**先解析再判可见性**，判定用规范化后的相对路径（理由同 resolveOrReply）
  const dest = resolveAny(destRel)
  if (!visible(req, dest.rel)) {
    return res.status(404).json({ error: "目标不存在", errorKey: "api.webdav.destination_missing" })
  }
  if (dest.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作", errorKey: "api.webdav.soft_readonly" })
  if (!dest.rel) {
    return res.status(400).json({ error: "目标不能是根目录", errorKey: "api.webdav.destination_root_denied" })
  }
  // 下面一律用 dest.rel（规范化）做比较与入库：用词法 destRel 会让
  // 「A → a/x」这种只差大小写/短名的写法绕过自嵌套检查。
  // 不能把目录移动/复制到它自己内部。
  // 必须用 isSameOrInside（Windows/macOS 下大小写不敏感），裸串 startsWith 会让
  // "/A" → "/a/x" 这类只差大小写的目标绕过检查（与 fs.js 的 transfer 保持一致）。
  if (isSameOrInside(dest.rel, resolved.rel)) {
    return res.status(400).json({ error: "目标不能是自身或其子目录", errorKey: "api.webdav.destination_self_denied" })
  }
  // 反向也要拦：把子目录搬到它自己的祖先位置（MOVE a/b → a）时，下面的"目标已存在"
  // 会先把 a 连同源一起删掉。旧实现只查了"目标在源内部"这一个方向。
  if (isSameOrInside(resolved.rel, dest.rel)) {
    return res.status(400).json({ error: "目标不能是自身的上级目录", errorKey: "api.webdav.destination_ancestor_denied" })
  }

  // 来源必须先真实存在。旧实现只做词法解析（resolveAny 不访问磁盘），于是
  // `COPY /dav/__nope__ → Destination: /dav/projects, Overwrite: T` 会先删掉
  // projects 再报 ENOENT —— 一次请求永久销毁一整个目录树。
  const srcStat = await statSafe(resolved.abs)
  if (!srcStat) {
    return res.status(404).json({ error: "源文件或目录不存在", errorKey: "api.webdav.source_missing" })
  }

  const overwrite = String(req.headers.overwrite || "").toUpperCase() === "T"
  const destExisting = await statSafe(dest.abs)
  if (destExisting) {
    if (!overwrite) return res.status(412).json({ error: "目标已存在", errorKey: "api.webdav.destination_exists" })
    // 覆盖 = 删除目标。DELETE 需要 delete 权限、且进回收站，这里必须一致：
    // 否则只有 copy/move 权限的成员也能用 COPY+MOVE 递归销毁数据，且无从恢复。
    if (!req.dav.perms.delete) return deny(res, "delete")
    const trashed = await moveToTrash({ abs: dest.abs, rel: dest.rel }, { user: req.dav.username, role: "member", ip: req.ip })
    // 回收站不可用（或该条目入站失败）时才退回彻底删除 —— 与 /api/fs/delete 一致
    if (!trashed && (await statSafe(dest.abs))) {
      await fs.promises.rm(dest.abs, { recursive: true, force: true })
    }
  }
  await fs.promises.mkdir(path.dirname(dest.abs), { recursive: true })

  if (isMove) await moveEntry(resolved.abs, dest.abs)
  else await copyEntry(resolved.abs, dest.abs)
  info(isMove ? "webdav_move" : "webdav_copy", {
    msg: `${resolved.rel} -> ${dest.rel}`,
    user: req.dav.username,
    ip: req.ip,
  })
  res.status(destExisting ? 204 : 201).end()
}

async function handleLock(req, res) {
  // 不实现真正的排他控制：只要让 Office / 资源管理器认为锁住了即可。
  // 这里如实说明——本项目的并发保护是靠版本比对（见 version.js），不是靠锁。
  // 但"要不要锁"仍要过权限：否则任何成员（哪怕 browse=false）都能对任意路径
  // 无限写锁条目，把内存当免费存储用。
  const rel = relFromUrl(req)
  if (rel === null) return res.status(400).json({ error: "路径无效", errorKey: "api.fs.path_invalid" })
  if (!req.dav.perms.browse) return deny(res, "browse")
  if (!req.dav.perms.fileWrite) return deny(res, "fileWrite")
  // 锁记录里存规范化路径：判定（visible）与入库（locks.set）必须用同一个值，
  // 否则 `WEB~1` 能过可见性判定、却以短名进锁表，后续 UNLOCK/去重都对不上。
  const locked = resolveAny(rel)
  if (locked.rel && !visible(req, locked.rel)) {
    return res.status(404).json({ error: "文件或目录不存在", errorKey: "api.fs.not_found" })
  }
  sweepLocks()
  // 锁表有界：第三方客户端偶尔会忘记 UNLOCK，长跑实例不能因此无限增长
  if (locks.size >= MAX_LOCKS) {
    const evict = [...locks.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, Math.max(1, Math.floor(MAX_LOCKS / 10)))
    for (const [key] of evict) locks.delete(key)
  }
  const mine = [...locks.values()].filter((l) => l.username === req.dav.username).length
  if (mine >= 200) {
    return res.status(507).json({ error: "锁数量过多，请先解锁", errorKey: "api.webdav.too_many_locks" })
  }
  const token = `opaquelocktoken:${crypto.randomUUID()}`
  locks.set(token, { rel: locked.rel, username: req.dav.username, expiresAt: Date.now() + LOCK_TTL_MS })
  // 锁的是"还不存在的文件"（lock-null）时，RFC 4918 要求回 **201**：
  // 资源管理器/Word 新建文件后会先 LOCK 再 PUT，回 200 让部分客户端认为
  // "文件已存在"，随后 PUT 就变成了覆盖（在我们这里还要 delete 权限）。
  const exists = await statSafe(locked.abs)
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    "<D:locktype><D:write/></D:locktype>" +
    "<D:lockscope><D:exclusive/></D:lockscope>" +
    `<D:depth>${xmlEscape(String(req.headers.depth || "infinity"))}</D:depth>` +
    `<D:timeout>Second-${Math.floor(LOCK_TTL_MS / 1000)}</D:timeout>` +
    `<D:locktoken><D:href>${xmlEscape(token)}</D:href></D:locktoken>` +
    "</D:activelock></D:lockdiscovery></D:prop>"
  res.status(exists ? 200 : 201)
  res.setHeader("Content-Type", 'application/xml; charset="utf-8"')
  res.setHeader("Lock-Token", `<${token}>`)
  res.setHeader("Timeout", `Second-${Math.floor(LOCK_TTL_MS / 1000)}`)
  res.send(body)
}

function handleUnlock(req, res) {
  const header = String(req.headers["lock-token"] || "")
  const token = header.replace(/^<|>$/g, "")
  if (token) {
    const lock = locks.get(token)
    // 只能解自己的锁：锁 token 会出现在响应头里，不校验归属等于谁都能解
    if (lock && lock.username !== req.dav.username) {
      return res.status(403).json({ error: "不能解除他人的锁", errorKey: "api.auth.forbidden" })
    }
    locks.delete(token)
  }
  res.status(204).end()
}

/* ============================================================== 挂载入口 == */

/** 把请求体读进内存（上限已被前面的 content-length 检查挡过一道，这里再兜一次） */
async function readBodyLimited(req, limit) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const err = new Error("请求体过大")
      err.status = 413
      err.errorKey = "api.webdav.body_too_large"
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** DAV 响应统一要带的头（能力声明 + 禁缓存） */
function setDavHeaders(res) {
  res.setHeader("DAV", "1, 2")
  res.setHeader("Allow", DAV_METHODS)
  res.setHeader("MS-Author-Via", "DAV")
  // 目录列表绝不能进缓存：Windows WebClient 的缓存很激进，删掉的文件会一直显示
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
}

/**
 * 生成 WebDAV 中间件。
 *
 * **总是返回中间件**（不再返回 null）：挂载点可以在后台改，所以由中间件自己
 * 每个请求判断"是否命中挂载点"与"是否启用"。调用方在 `server/index.js` 里
 * 用 `app.use(createWebdavRouter())` 挂在 body parser **之前**。
 */
export function createWebdavRouter() {
  const mw = async (req, res, next) => {
    const base = davBase()
    const p = req.path || "/"

    // 站点根的 OPTIONS 也要认（与挂载点无关）：
    // 资源管理器 / 部分客户端在挂载前会先探测 authority 根（`OPTIONS /`）。
    // 根上不声明 DAV 的话，它给出的结论是"这台服务器不是 WebDAV"，
    // 于是连后面的 /dav 都不会再试 —— 表现就是"填对了地址也挂不上"。
    // 只接管 OPTIONS，其它方法在根上仍然走正常流程（前端页面不受影响）。
    if (req.method === "OPTIONS" && p === "/") {
      if (!enabledNow()) return next()
      setDavHeaders(res)
      return res.status(200).end()
    }

    // 没命中挂载点：交给后续中间件（静态托管 / SPA / 其它 API）
    if (p !== base && !p.startsWith(base + "/")) return next()

    // 未启用时明确 404 —— 绝不能落到 SPA fallback 返回前端首页：
    // 用户把 /dav 填进客户端后拿到网页，是最难排查的一种"故障"。
    if (!enabledNow()) {
      res.setHeader("Allow", "OPTIONS")
      return res.status(404).json({
        error:
          "WebDAV 未启用（默认关闭）。如需使用，请在「设置 → 公网 → WebDAV」中开启并保存，" +
          "或在 .env 中设置 WEBDAV=1 后重启服务",
        errorKey: "api.webdav.disabled",
      })
    }

    // 按 IP 限流：Basic 凭据每个请求都会重发，真正的目的是挡住"用请求洪水刷 bcrypt"
    if (davRateLimited(req.ip)) {
      res.setHeader("Retry-After", "60")
      return res.status(429).json({ error: "WebDAV 请求过于频繁，请稍后再试", errorKey: "api.webdav.rate_limited" })
    }

    // 元数据类请求（PROPFIND / PROPPATCH / LOCK）的请求体我们根本不读，
    // 直接按长度拒绝，避免有人拿它当上传通道塞大包。
    if (req.method !== "PUT" && Number(req.headers["content-length"] || 0) > MAX_META_BODY) {
      return res.status(413).json({ error: "请求体过大", errorKey: "api.webdav.body_too_large" })
    }

    // OPTIONS 不需要认证：客户端用它探测能力
    if (req.method === "OPTIONS") {
      setDavHeaders(res)
      return res.status(200).end()
    }
    // 所有 DAV 响应都带上能力头与 no-cache：Windows WebClient 会缓存目录列表，
    // 且部分客户端在 207 上也会检查 DAV / Allow。
    setDavHeaders(res)
    try {
      await basicAuth(req, res, (err) => { if (err) next(err) })
      if (!req.dav) return // basicAuth 已经响应了 401
      const method = req.method.toUpperCase()
      // PROPFIND / PROPPATCH / LOCK 需要请求体（客户端靠它点名属性 / 传锁信息）。
      // 这几个请求我们平时根本不读，但**必须把流读干净**：不读就走的话，
      // Node 会在响应后丢弃未读的请求体，部分客户端会看到连接被重置
      // （表现是"保存失败"但服务端日志里只有一条 200）。
      if (method === "PROPFIND" || method === "PROPPATCH" || method === "LOCK") {
        req.rawBody = await readBodyLimited(req, MAX_META_BODY)
      }
      switch (method) {
        case "PROPFIND": return await handlePropfind(req, res)
        case "PROPPATCH": return await handleProppatch(req, res)
        case "GET": return await handleGet(req, res, false)
        case "HEAD": return await handleGet(req, res, true)
        case "PUT": return await handlePut(req, res)
        case "MKCOL": return await handleMkcol(req, res)
        case "DELETE": return await handleDelete(req, res)
        case "COPY": return await handleCopyMove(req, res, false)
        case "MOVE": return await handleCopyMove(req, res, true)
        case "LOCK": return await handleLock(req, res)
        case "UNLOCK": return handleUnlock(req, res)
        default:
          res.setHeader("Allow", DAV_METHODS)
          return res.status(405).json({
            error: `不支持的方法 ${method}`,
            errorKey: "api.webdav.method_not_allowed",
            errorParams: { method },
          })
      }
    } catch (err) {
      // DAV 客户端读不懂我们的 JSON 错误，但仍然给一个明确状态码
      const status = err.status || 500
      if (status >= 500) warn("webdav_error", { msg: `${req.method} ${req.path}: ${err.message}`, ip: req.ip })
      if (!res.headersSent) {
        const body = { error: status >= 500 ? "服务器内部错误" : err.message }
        // 5xx 的文案已被统一替换，只能配通用键；4xx 若上游错误本身就带了命名键
        // （如 safety.js 的 api.fs.*），原样透传——`error` 依旧是中文原文。
        if (status >= 500) {
          body.errorKey = "api.common.server_error"
        } else if (err.errorKey) {
          body.errorKey = String(err.errorKey)
          if (err.errorParams && typeof err.errorParams === "object") body.errorParams = err.errorParams
        }
        res.status(status).json(body)
      }
    }
  }
  return mw
}

/** 启动时打印一行提示（让部署者知道自己开了什么） */
export function webdavStartupNotice() {
  if (!enabledNow()) return null
  return `WebDAV 已启用：${davPath()}/ —— 仅成员账号可用（不接受超管），建议只在 HTTPS 或完全可信的内网下使用`
}
