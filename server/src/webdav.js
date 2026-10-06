import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { WEBDAV_PATH } from "./env.js"
import { verifyLogin } from "./users.js"
import { effectivePerms, getConfig, uploadLimitBytes } from "./config.js"
import { normRel, resolveAny, joinRel, isHiddenFromGuest } from "./safety.js"
import { copyEntry, listDir, moveEntry, statSafe } from "./files.js"
import { resolveGroupContext, isVisibleForContext } from "./groups.js"
import { moveToTrash } from "./trash.js"
import { versionOf } from "./version.js"
import { info, warn } from "./logger.js"

// ============================================================================
//  webdav.js - WebDAV 挂载（实验性 / Beta）
//
//  ⚠️ 默认关闭，只能在 .env 里显式打开：
//       WEBDAV=1
//       WEBDAV_PATH=/dav        # 可选，默认 /dav
//
//  为什么标为实验性：
//    1. WebDAV 客户端普遍只支持 **HTTP Basic 认证** —— 用户名密码会在**每一个
//       请求**里重复发送。在 HTTP（非 HTTPS）下这等于把凭据反复明文扔到网络上，
//       而浏览器的正常登录用的是 httpOnly Cookie，不会被这样反复暴露。
//    2. 挂载后文件可以被资源管理器/第三方客户端任意读写，权限判定必须与
//       Web 端完全一致，任何遗漏都是越权读写。
//    3. 各家客户端（Windows 资源管理器 / macOS Finder / RaiDrive / rclone /
//       Office）对协议细节的实现差异很大，行为无法像 HTTP 接口那样被完整覆盖。
//
//  安全设计（逐条对应上面的风险）：
//    - **只接受 Basic 认证，绝不认 Cookie**。这一点至关重要：如果 DAV 也接受
//      会话 Cookie，那么任意网页都能借用户浏览器里已有的登录态发起
//      `PROPFIND`/`PUT` —— 相当于一个绕过 CSRF 校验的后门。
//    - **不接受超级管理员账号**：超管密码只应出现在 .env 与本机，不该被任何
//      客户端反复发送。DAV 只对成员账号（bcrypt）开放。
//    - 权限判定复用 `effectivePerms(role, group)`，与 Web 端同一套；
//      路径解析复用 `normRel` / `resolveAny`，穿越与越界同样被拦。
//    - 写操作（PUT/MKCOL/DELETE/MOVE/COPY）先过对应的权限点，再执行。
//    - 单文件上传受 `uploadLimitBytes(role)` 限制，与 Web 端一致。
//    - 访客隐藏目录 / 小组可见范围同样生效，被隐藏的路径返回 **404**（不是 403），
//      避免通过状态码探测出"这里有什么"。
//    - 只读映射目录（FILES_SOFT_DIR）一律只读。
// ============================================================================

const DAV_METHODS = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK"

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

/** 供前端/状态页展示的启用信息 */
export function webdavStatus() {
  const enabled = !!process.env.WEBDAV && /^(1|true|yes|on)$/i.test(String(process.env.WEBDAV).trim())
  return { enabled, path: WEBDAV_PATH, experimental: true, lockCount: locks.size }
}

function enabledNow() {
  return /^(1|true|yes|on)$/i.test(String(process.env.WEBDAV || "").trim())
}

/* ============================================================ Basic 认证 == */

function unauthorized(res, message = "需要 WebDAV 账号密码") {
  // Basic realm 用中文会触发部分客户端的编码问题，保持 ASCII
  res.setHeader("WWW-Authenticate", 'Basic realm="ZeroShadow WebDAV", charset="UTF-8"')
  res.status(401).json({ error: message })
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

  // 超管账号不接受（密码只应留在 .env 与本机，不该被客户端反复发送）
  const result = await verifyLogin(creds.username, creds.password)
  if (!result.ok) {
    warn("webdav_auth_fail", { msg: creds.username, ip: req.ip })
    return unauthorized(res, "用户名或密码错误")
  }
  const user = result.user
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
    perms: effectivePerms("member", groupCtx.group),
  }
  next()
}

/* ============================================================== 路径处理 == */

function davBase() {
  return WEBDAV_PATH
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
  if (isHiddenFromGuest(rel)) return false
  return isVisibleForContext(rel, {
    role: "member",
    group: req.dav.group,
    userId: req.dav.userId,
  })
}

function deny(res, perm) {
  res.status(403).json({ error: `没有权限执行此操作（需要 ${perm}）` })
}

/** 解析目标并做全部校验；不通过时已经写好响应，返回 null */
function resolveOrReply(req, res) {
  const rel = relFromUrl(req)
  if (rel === null) {
    res.status(400).json({ error: "非法路径" })
    return null
  }
  if (!visible(req, rel)) {
    // 隐藏路径故意用 404：用 403 等于告诉对方"这里确实有东西"
    res.status(404).json({ error: "文件或目录不存在" })
    return null
  }
  const resolved = resolveAny(rel)
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

function propResponse(req, rel, stat, isDir) {
  const name = rel ? rel.split("/").pop() : ""
  const etag = isDir ? `"d-${Math.trunc(stat.mtimeMs)}"` : null
  return [
    "<D:response>",
    `<D:href>${xmlEscape(hrefFor(req, rel, isDir))}</D:href>`,
    "<D:propstat>",
    "<D:prop>",
    isDir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>",
    `<D:displayname>${xmlEscape(name)}</D:displayname>`,
    `<D:getlastmodified>${new Date(stat.mtimeMs).toUTCString()}</D:getlastmodified>`,
    isDir ? "" : `<D:getcontentlength>${stat.size}</D:getcontentlength>`,
    isDir ? "" : `<D:getcontenttype>application/octet-stream</D:getcontenttype>`,
    etag ? `<D:getetag>${xmlEscape(etag)}</D:getetag>` : "",
    "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>",
    "</D:prop>",
    "<D:status>HTTP/1.1 200 OK</D:status>",
    "</D:propstat>",
    "</D:response>",
  ]
    .filter(Boolean)
    .join("")
}

async function handlePropfind(req, res) {
  if (!req.dav.perms.browse) return deny(res, "browse")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  const stat = await statSafe(resolved.abs)
  if (!stat || stat.isSymbolicLink()) return res.status(404).json({ error: "文件或目录不存在" })

  const isDir = stat.isDirectory()
  const depth = String(req.headers.depth ?? "1")
  const parts = [propResponse(req, resolved.rel, stat, isDir)]

  if (isDir && depth !== "0") {
    let entries = []
    try {
      entries = await listDir(resolved.abs, resolved.rel, { forGuest: false })
    } catch {
      entries = []
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
          childIsDir
        )
      )
    }
  }

  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:multistatus xmlns:D="DAV:">' +
    parts.join("") +
    "</D:multistatus>"
  res.status(207)
  res.setHeader("Content-Type", 'application/xml; charset="utf-8"')
  res.setHeader("DAV", "1, 2")
  res.send(body)
}

async function handleGet(req, res, headOnly) {
  if (!req.dav.perms.downloadFile) return deny(res, "downloadFile")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  const stat = await statSafe(resolved.abs)
  if (!stat || !stat.isFile()) return res.status(404).json({ error: "文件不存在" })

  // ETag = 内容版本（与在线编辑器的 baseVersion 同一套计算），
  // 客户端因此可以用 If-Match 做乐观锁，条件不满足时得到 412。
  let etag = null
  try {
    const buf = await fs.promises.readFile(resolved.abs)
    etag = `"${versionOf(buf, stat)}"`
  } catch {
    etag = `"s-${Math.trunc(stat.mtimeMs)}-${stat.size}"`
  }
  res.setHeader("ETag", etag)
  // 强制下载：DAV 内容里包含用户上传的 HTML/SVG，不该在浏览器里当作页面执行
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(path.basename(resolved.abs))}"`)
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
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作" })
  if (!resolved.rel) return res.status(405).json({ error: "不能写入根目录" })

  const limit = uploadLimitBytes("member")
  const parentStat = await statSafe(path.dirname(resolved.abs))
  if (!parentStat || !parentStat.isDirectory()) {
    return res.status(409).json({ error: "上级目录不存在" })
  }

  const existing = await statSafe(resolved.abs)
  // If-Match 不一致 → 412；这让支持它的客户端能做乐观并发控制
  if (existing && req.headers["if-match"]) {
    const buf = await fs.promises.readFile(resolved.abs).catch(() => null)
    const current = buf ? `"${versionOf(buf, existing)}"` : null
    if (current && req.headers["if-match"] !== current) {
      return res.status(412).json({ error: "文件已被其他人修改" })
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
      return res.status(413).json({ error: `超出上传大小限制（${Math.round(limit / 1024 / 1024)}MB）` })
    }
    return res.status(500).json({ error: "写入失败" })
  }

  try {
    // 原子替换：与在线编辑器同一套做法，避免写盘中断留下半个文件
    await fs.promises.rename(tmp, resolved.abs).catch(async () => {
      await fs.promises.rm(resolved.abs, { force: true })
      await fs.promises.rename(tmp, resolved.abs)
    })
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    return res.status(500).json({ error: "保存失败" })
  }
  info("webdav_put", { msg: `${resolved.rel} (${written} bytes)`, user: req.dav.username, ip: req.ip })
  res.status(existing ? 204 : 201).end()
}

async function handleMkcol(req, res) {
  if (!req.dav.perms.fileWrite || !req.dav.perms.mkdir) return deny(res, "mkdir")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作" })
  if (!resolved.rel) return res.status(405).json({ error: "根目录已存在" })
  if (await statSafe(resolved.abs)) return res.status(405).json({ error: "已存在同名项目" })
  await fs.promises.mkdir(resolved.abs, { recursive: true })
  info("webdav_mkcol", { msg: resolved.rel, user: req.dav.username, ip: req.ip })
  res.status(201).end()
}

async function handleDelete(req, res) {
  if (!req.dav.perms.fileWrite || !req.dav.perms.delete) return deny(res, "delete")
  const resolved = resolveOrReply(req, res)
  if (!resolved) return
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作" })
  if (!resolved.rel) return res.status(403).json({ error: "不能删除根目录" })
  const stat = await statSafe(resolved.abs)
  if (!stat) return res.status(404).json({ error: "文件或目录不存在" })

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
  if (resolved.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作" })
  const destination = req.headers.destination
  if (!destination) return res.status(400).json({ error: "缺少 Destination 头" })

  // Destination 是完整 URL，取出其中的路径部分再套用前缀剥离
  let destPath = destination
  try {
    destPath = new URL(destination).pathname
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
    return res.status(400).json({ error: "目标路径非法" })
  }
  if (!visible(req, destRel)) return res.status(404).json({ error: "目标不存在" })
  const dest = resolveAny(destRel)
  if (dest.isSoft) return res.status(403).json({ error: "外部映射目录仅支持只读操作" })
  if (!destRel) return res.status(400).json({ error: "目标不能是根目录" })
  // 不能把目录移动/复制到它自己内部
  if (destRel === resolved.rel || destRel.startsWith(resolved.rel + "/")) {
    return res.status(400).json({ error: "目标不能是自身或其子目录" })
  }

  const overwrite = String(req.headers.overwrite || "").toUpperCase() === "T"
  const destExisting = await statSafe(dest.abs)
  if (destExisting) {
    if (!overwrite) return res.status(412).json({ error: "目标已存在" })
    await fs.promises.rm(dest.abs, { recursive: true, force: true })
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
  sweepLocks()
  const token = `opaquelocktoken:${crypto.randomUUID()}`
  locks.set(token, { rel: relFromUrl(req), username: req.dav.username, expiresAt: Date.now() + LOCK_TTL_MS })
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    "<D:locktype><D:write/></D:locktype>" +
    "<D:lockscope><D:exclusive/></D:lockscope>" +
    `<D:depth>${xmlEscape(String(req.headers.depth || "infinity"))}</D:depth>` +
    `<D:timeout>Second-${Math.floor(LOCK_TTL_MS / 1000)}</D:timeout>` +
    `<D:locktoken><D:href>${xmlEscape(token)}</D:href></D:locktoken>` +
    "</D:activelock></D:lockdiscovery></D:prop>"
  res.status(200)
  res.setHeader("Content-Type", 'application/xml; charset="utf-8"')
  res.setHeader("Lock-Token", `<${token}>`)
  res.send(body)
}

function handleUnlock(req, res) {
  const header = String(req.headers["lock-token"] || "")
  const token = header.replace(/^<|>$/g, "")
  if (token) locks.delete(token)
  res.status(204).end()
}

/* ============================================================== 挂载入口 == */

/**
 * 生成 WebDAV 中间件。未启用时返回 null（调用方据此完全不挂载，
 * 于是 /dav/ 会像以前一样落到 404，而不是被 SPA fallback 吞掉返回首页）。
 */
export function createWebdavRouter() {
  if (!enabledNow()) return null
  const mw = async (req, res, next) => {
    // OPTIONS 不需要认证：客户端用它探测能力
    if (req.method === "OPTIONS") {
      res.setHeader("DAV", "1, 2")
      res.setHeader("Allow", DAV_METHODS)
      res.setHeader("MS-Author-Via", "DAV")
      return res.status(200).end()
    }
    try {
      if (!enabledNow()) return res.status(404).json({ error: "WebDAV 未启用" })
      await basicAuth(req, res, (err) => { if (err) next(err) })
      if (!req.dav) return // basicAuth 已经响应了 401
      const method = req.method.toUpperCase()
      switch (method) {
        case "PROPFIND": return await handlePropfind(req, res)
        case "PROPPATCH": return res.status(207).setHeader("Content-Type", 'application/xml; charset="utf-8"').send(
          '<?xml version="1.0" encoding="utf-8"?><D:multivaluedate xmlns:D="DAV:"/>'
        )
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
          return res.status(405).json({ error: `不支持的方法 ${method}` })
      }
    } catch (err) {
      // DAV 客户端读不懂我们的 JSON 错误，但仍然给一个明确状态码
      const status = err.status || 500
      if (status >= 500) warn("webdav_error", { msg: `${req.method} ${req.path}: ${err.message}`, ip: req.ip })
      if (!res.headersSent) res.status(status).json({ error: status >= 500 ? "服务器内部错误" : err.message })
    }
  }
  return mw
}

/** 启动时打印一行提示（让部署者知道自己开了什么） */
export function webdavStartupNotice() {
  if (!enabledNow()) return null
  return `WebDAV（实验性）已启用：${WEBDAV_PATH}/ —— 仅成员账号可用，建议只在 HTTPS 或内网下使用`
}
