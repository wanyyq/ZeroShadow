import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import http from "node:http"
import https from "node:https"
import { Router } from "express"
import Busboy from "busboy"
import archiver from "archiver"
import { TMP_DIR } from "../env.js"
import { requirePerm, requireRole } from "../auth.js"
import { effectivePerms, downloadUrlLimitBytes, getConfig, saveConfig, uploadLimitBytes, uploadLimitMB, zipLimits } from "../config.js"
import {
  getSoftDirEntries,
  guestBlocked,
  isHiddenFromGuest,
  isSameOrInside,
  isSoftPath,
  joinRel,
  normRel,
  resolveAny,
  resolveSafe,
  samePath,
  sanitizeFileName,
  validateName,
} from "../safety.js"
import {
  assertDir,
  assertExists,
  copyEntry,
  dirStats,
  listDir,
  moveEntry,
  searchFiles,
  statSafe,
  uniqueName,
} from "../files.js"
import { info } from "../logger.js"
import { isVisibleForContext } from "../groups.js"
import { MAX_REDIRECTS, REDIRECT_CODES, insecureTlsAllowed, pinnedLookup, resolveDownloadTarget } from "../netguard.js"
import { rateLimit } from "../ratelimit.js"
import { createJob, failJob, finishJob, jobCreatedBy, jobStatus, patchJob } from "../jobs.js"

const router = Router()

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function actor(req) {
  return { user: req.auth.username || "guest", role: req.auth.role, ip: req.ip }
}

function blockSoft(rel) {
  if (isSoftPath(rel)) {
    const err = new Error("外部映射目录仅支持只读操作")
    err.status = 403
    throw err
  }
}

// 只读映射目录的内容默认不允许"搬进"网盘主目录：否则映射了项目根目录等敏感
// 路径时，低权限成员能把 .env、data/.jwt-secret 复制到公开目录里再下载。
// 超管可在后台放开（softDirAllowCopyOut）。
function blockSoftCopyOut(rel) {
  if (isSoftPath(rel) && !getConfig().softDirAllowCopyOut) {
    const err = new Error("只读映射目录的内容不允许复制到网盘目录（可在后台设置中放开）")
    err.status = 403
    throw err
  }
}

// 小组上下文可见性：选中小组后，只有白名单内且不在黑名单的目录可见。
// 对不可见路径一律按"不存在"处理，避免暴露路径结构。
function contextVisible(req, rel) {
  // 根目录始终允许列出（否则白名单模式下无法展示"可见的子目录"），
  // 具体子项在列表里逐个过滤。
  if (!rel) return true
  return isVisibleForContext(rel, { role: req.auth.role, group: req.group, userId: req.auth.userId })
}

function assertContextVisible(req, rel) {
  if (!contextVisible(req, rel)) {
    const err = new Error("文件或目录不存在")
    err.status = 404
    throw err
  }
}

// 作业进度只对创建者与超管可见（后台可关闭该限制）
function visibleJobStatus(req, jobId) {
  const owner = jobCreatedBy(jobId)
  if (owner === undefined) return null
  if (getConfig().jobStatusOwnerOnly && req.auth.role !== "superadmin") {
    if (owner !== (req.auth.username || "guest")) return null
  }
  return jobStatus(jobId)
}

const INLINE_TYPES = new Map(
  Object.entries({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    tiff: "image/tiff",
    tif: "image/tiff",
    heic: "image/heic",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    wmv: "video/x-ms-wmv",
    flv: "video/x-flv",
    "3gp": "video/3gpp",
    m4v: "video/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    json: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    csv: "text/plain; charset=utf-8",
    js: "text/plain; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    css: "text/plain; charset=utf-8",
    py: "text/plain; charset=utf-8",
    yml: "text/plain; charset=utf-8",
    yaml: "text/plain; charset=utf-8",
    xml: "text/plain; charset=utf-8",
    ini: "text/plain; charset=utf-8",
    conf: "text/plain; charset=utf-8",
    htm: "text/html; charset=utf-8",
    html: "text/html; charset=utf-8",
    rst: "text/plain; charset=utf-8",
    adoc: "text/plain; charset=utf-8",
    tex: "text/plain; charset=utf-8",
    bat: "text/plain; charset=utf-8",
    ps1: "text/plain; charset=utf-8",
    vbs: "text/plain; charset=utf-8",
    lua: "text/plain; charset=utf-8",
    rb: "text/plain; charset=utf-8",
    php: "text/plain; charset=utf-8",
    pl: "text/plain; charset=utf-8",
    sql: "text/plain; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    properties: "text/plain; charset=utf-8",
    graphql: "text/plain; charset=utf-8",
    rtf: "text/plain; charset=utf-8",
    org: "text/plain; charset=utf-8",
    cmake: "text/plain; charset=utf-8",
    gradle: "text/plain; charset=utf-8",
    dockerfile: "text/plain; charset=utf-8",
    makefile: "text/plain; charset=utf-8",
    ".gitignore": "text/plain; charset=utf-8",
    ".env": "text/plain; charset=utf-8",
  })
)

// 能在文档上下文中执行脚本的扩展名（HTML 与 SVG）：内联返回时必须用 CSP
// sandbox 隔离，否则等于把攻击者上传的脚本放进网盘自身的源里执行。
const SCRIPTABLE_EXT = new Set(["html", "htm", "svg"])

function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

router.get("/list", requirePerm("browse"), async (req, res, next) => {
  try {
    const { abs, rel, isSoft } = resolveSafe(req.query.path)
    if (!isSoft && guestBlocked(req, rel)) throw httpError(404, "目录不存在")
    assertContextVisible(req, rel)
    if (isSoft) {
      if (guestBlocked(req, rel)) throw httpError(404, "目录不存在")
      const resolved = resolveAny(rel)
      await assertDir(resolved.abs)
      const entries = await listDir(resolved.abs, rel, { forGuest: req.auth.role === "guest" })
      const marked = entries
        .filter((e) => contextVisible(req, joinRel(rel, e.name)))
        .map((e) => ({ ...e, softReadOnly: true }))
      res.json({ path: rel, entries: marked })
    } else {
      await assertDir(abs)
      const entries = (await listDir(abs, rel, { forGuest: req.auth.role === "guest" })).filter((e) =>
        contextVisible(req, joinRel(rel, e.name))
      )
      let all = entries
      if (!rel) {
        let softs = getSoftDirEntries().filter((s) => contextVisible(req, s.name))
        if (softs.length) {
          if (req.auth.role === "guest") {
            softs = softs.filter((s) => !isHiddenFromGuest(s.name))
          }
          all = [...softs, ...entries]
        }
      }
      res.json({ path: rel, entries: all })
    }
  } catch (err) {
    next(err)
  }
})

router.get("/download", async (req, res, next) => {
  try {
    const resolved = resolveAny(normRel(req.query.path))
    if (!resolved.rel) throw httpError(400, "非法路径")
    // 只读映射目录同样要尊重「对访客隐藏」：旧实现用 `!isSoft` 跳过了这一步，
    // 于是访客只要猜到隐藏软目录里的完整文件名就能下载。
    if (guestBlocked(req, resolved.rel)) throw httpError(404, "文件不存在")
    assertContextVisible(req, resolved.rel)
    const stat = await assertExists(resolved.abs)
    if (!stat.isFile()) throw httpError(400, "只能下载文件，文件夹请使用打包下载")

    const name = path.basename(resolved.abs)
    const ext = path.extname(name).slice(1).toLowerCase()
    const extKey = ext || name.toLowerCase()
    // 必须用 attachContext 算好的 req.perms：它已经把当前小组的收窄算进去了。
    // 旧实现重新调用 effectivePerms(role) 且漏传 req.group，导致小组关掉
    // downloadFile/preview 后这里仍然按全局权限放行。
    const perms = req.perms || effectivePerms(req.auth.role, req.group)

    if (!perms.downloadFile) {
      if (!perms.preview || !INLINE_TYPES.has(extKey)) {
        if (req.auth.role === "guest") return res.status(401).json({ error: "请先登录" })
        return res.status(403).json({ error: "没有权限下载文件" })
      }
    }

    const inline = req.query.inline === "1" && INLINE_TYPES.has(extKey)
    const forceInline = !perms.downloadFile && perms.preview
    const useInline = inline || forceInline
    const mime = useInline ? INLINE_TYPES.get(extKey) : "application/octet-stream"
    res.setHeader("Content-Type", mime)
    res.setHeader("Content-Disposition", contentDisposition(useInline ? "inline" : "attachment", name))
    res.setHeader("Cache-Control", "no-store")
    // 上传的 HTML/SVG 属于用户内容，绝不能让它在网盘自身的源下执行：CSP 的
    // sandbox 指令把它强制为不透明源，即使被直接打开（新标签页/第三方内嵌）
    // 也拿不到本站 Cookie、父页面与 /api 会话；脚本仍可运行，静态页面不受影响。
    if (useInline && SCRIPTABLE_EXT.has(extKey)) {
      res.setHeader("Content-Security-Policy", "sandbox allow-scripts")
    }
    if (!useInline) info("download", { msg: resolved.rel, ...actor(req) })
    res.sendFile(resolved.abs, { dotfiles: "allow", cacheControl: false }, (err) => {
      if (!err) return
      // 头已发出时不能再走错误中间件（会二次写头）；必须主动销毁连接，
      // 否则 send 只 emit('error') 而不结束响应，客户端会一直挂到超时。
      if (res.headersSent) res.destroy()
      else next(err)
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 打包/统计共用的可见性判定：访客看 guestHiddenPaths，登录用户看小组上下文可见范围
 * （含 defaultVisibility 与小组黑名单）。递归打包时必须逐层应用，否则被隐藏目录里的
 * 内容会照样被打进 zip —— /list 看不到、打包却能拿到，可见性就形同虚设。
 */
function zipVisibility(req) {
  const forGuest = req.auth.role === "guest"
  return {
    forGuest,
    visible(rel) {
      if (!rel) return true
      if (forGuest && isHiddenFromGuest(rel)) return false
      return contextVisible(req, rel)
    },
  }
}

/**
 * 重命名 / 移动之后同步 guestHiddenPaths：命中的条目（等于该路径或位于其内部）都要把
 * 前缀整体替换成新位置。旧实现只处理「精确等于」的条目，于是重命名父目录后配置里会
 * 残留旧路径，新位置对访客直接可见 —— 隐藏设置静默失效。
 */
async function remapHiddenPaths(fromRel, toRel) {
  if (!fromRel || samePath(fromRel, toRel)) return
  const hidden = getConfig().guestHiddenPaths || []
  if (!hidden.some((h) => isSameOrInside(h, fromRel))) return
  await saveConfig((draft) => {
    draft.guestHiddenPaths = draft.guestHiddenPaths.map((h) => {
      if (!isSameOrInside(h, fromRel)) return h
      const suffix = h.length > fromRel.length ? h.slice(fromRel.length).replace(/^\/+/, "") : ""
      return suffix ? joinRel(toRel, suffix) : toRel
    })
  })
}

async function collectZipItems(rels, vis) {
  const items = []
  for (const rel of rels) {
    if (!rel) continue
    if (!vis.visible(rel)) continue
    const resolved = resolveAny(rel)
    const stat = await statSafe(resolved.abs)
    if (!stat || stat.isSymbolicLink()) continue
    items.push({ abs: resolved.abs, rel, name: path.basename(resolved.abs), isDir: stat.isDirectory(), size: stat.isFile() ? stat.size : 0 })
  }
  return items
}

/**
 * 只累加文件数/字节数：与 archiver 的 entries.total 口径一致，
 * 旧实现把目录也算一个条目，导致进度条永远到不了上限、最后直接跳到 100%。
 */
async function scanDirForZip(dirAbs, dirRel, vis, acc) {
  let dirents
  try {
    dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of dirents) {
    const abs = path.join(dirAbs, d.name)
    const entryRel = joinRel(dirRel, d.name)
    if (!vis.visible(entryRel)) continue
    const stat = await statSafe(abs)
    if (!stat || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await scanDirForZip(abs, entryRel, vis, acc)
    } else if (stat.isFile()) {
      acc.count += 1
      acc.bytes += stat.size
    }
  }
}

async function countZipFilesAndSize(items, vis) {
  const acc = { count: 0, bytes: 0 }
  for (const item of items) {
    if (item.isDir) {
      await scanDirForZip(item.abs, item.rel, vis, acc)
    } else {
      acc.count += 1
      acc.bytes += item.size
    }
  }
  return { fileCount: acc.count, totalSize: acc.bytes }
}

async function validateZipLimits(items, vis) {
  const limits = zipLimits()
  const { fileCount, totalSize } = await countZipFilesAndSize(items, vis)
  if (fileCount > limits.maxFiles) {
    throw httpError(400, `打包文件数 (${fileCount}) 超出限制 (最多 ${limits.maxFiles} 个)`)
  }
  if (totalSize > limits.maxTotalBytes) {
    throw httpError(400, `打包总大小 (${Math.round(totalSize / 1024 / 1024)}MB) 超出限制 (${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB)`)
  }
  for (const item of items) {
    if (!item.isDir && item.size > limits.maxSingleBytes) {
      throw httpError(400, `文件 "${item.name}" 大小 (${Math.round(item.size / 1024 / 1024)}MB) 超出单文件限制 (${Math.round(limits.maxSingleBytes / 1024 / 1024)}MB)`)
    }
  }
}

async function addDirToArchive(archive, dirAbs, dirRel, zipBase, vis) {
  let dirents
  try {
    dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true })
  } catch {
    dirents = []
  }
  let added = 0
  for (const dirent of dirents) {
    const entryRel = joinRel(dirRel, dirent.name)
    if (!vis.visible(entryRel)) continue
    const abs = path.join(dirAbs, dirent.name)
    const stat = await statSafe(abs)
    if (!stat || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      added += 1
      await addDirToArchive(archive, abs, entryRel, `${zipBase}/${dirent.name}`, vis)
    } else if (stat.isFile()) {
      added += 1
      archive.file(abs, { name: `${zipBase}/${dirent.name}` })
    }
  }
  // 目录为空、或内容全被可见性过滤掉时补一个占位，避免该目录在 zip 里彻底消失
  if (added === 0) archive.append(Buffer.alloc(0), { name: `${zipBase}/.keep` })
}

router.get("/zip", requirePerm("downloadFolder"), rateLimit, async (req, res, next) => {
  try {
    let rels = []
    if (req.query.paths) {
      let parsed
      try {
        parsed = JSON.parse(String(req.query.paths))
      } catch {
        throw httpError(400, "参数格式错误")
      }
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200) {
        throw httpError(400, "参数格式错误")
      }
      rels = parsed.map((p) => normRel(p))
    } else {
      rels = [normRel(req.query.path)]
    }

    const vis = zipVisibility(req)
    const items = await collectZipItems(rels, vis)
    if (!items.length) throw httpError(404, "没有可下载的内容")
    await validateZipLimits(items, vis)

    const zipName =
      items.length === 1 ? `${items[0].name}.zip` : `ZeroShadow-${new Date().toISOString().slice(0, 10)}.zip`
    res.setHeader("Content-Type", "application/zip")
    res.setHeader("Content-Disposition", contentDisposition("attachment", zipName))
    res.setHeader("Cache-Control", "no-store")

    const archive = archiver("zip", { zlib: { level: 1 } })
    archive.on("error", (err) => {
      if (!res.headersSent) next(err)
      else res.destroy()
    })
    res.on("close", () => archive.destroy())
    archive.pipe(res)
    // 处理重名
    const nameCount = new Map()
    for (const item of items) {
      nameCount.set(item.name, (nameCount.get(item.name) || 0) + 1)
    }
    const usedNames = new Map()
    for (const item of items) {
      let entryName = item.name
      if (nameCount.get(item.name) > 1) {
        entryName = item.rel ? item.rel.replace(/\//g, "_") : item.name
        const idx = (usedNames.get(entryName) || 0) + 1
        usedNames.set(entryName, idx)
        if (idx > 1) {
          const ext = path.extname(entryName)
          const base = ext ? entryName.slice(0, -ext.length) : entryName
          entryName = `${base}_${idx}${ext}`
        }
      }
      if (item.isDir) {
        await addDirToArchive(archive, item.abs, item.rel, entryName, vis)
      } else {
        archive.file(item.abs, { name: entryName })
      }
    }
    info("download_zip", { msg: rels.join(", "), ...actor(req) })
    await archive.finalize()
  } catch (err) {
    next(err)
  }
})

router.post("/mkdir", requirePerm("mkdir"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    await assertDir(abs)
    const name = String(req.body?.name || "").trim()
    const invalid = validateName(name)
    if (invalid) throw httpError(400, invalid)
    const finalName = await uniqueName(abs, name)
    await fs.promises.mkdir(path.join(abs, finalName))
    info("mkdir", { msg: joinRel(rel, finalName), ...actor(req) })
    res.json({ name: finalName })
  } catch (err) {
    next(err)
  }
})

// 单次上传请求的文件数上限（busboy 的 files 限制）。超过的部分会被 busboy 直接跳过
// 且只发一次 filesLimit 事件，因此前端必须按这个值分片，否则文件会静默丢失。
const MAX_FILES_PER_REQUEST = 100

router.post("/upload", requirePerm("upload"), async (req, res, next) => {
  let destAbs
  let destRel
  let overwriteNames = []
  try {
    const resolved = resolveSafe(req.query.path)
    destAbs = resolved.abs
    destRel = resolved.rel
    blockSoft(destRel)
    assertContextVisible(req, destRel)
    await assertDir(destAbs)
    if (req.query.overwrite) {
      try {
        overwriteNames = JSON.parse(String(req.query.overwrite))
        if (!Array.isArray(overwriteNames)) overwriteNames = []
      } catch {
        overwriteNames = []
      }
    }
  } catch (err) {
    return next(err)
  }

  const limitBytes = uploadLimitBytes(req.auth.role)
  const limitMB = uploadLimitMB(req.auth.role)
  const tmpFiles = []
  const results = []
  let responded = false
  let hitFileLimit = false

  const finish = async (aborted) => {
    if (responded) return
    responded = true
    if (aborted) {
      await Promise.all(tmpFiles.map((t) => fs.promises.rm(t.tmp, { force: true }).catch(() => {})))
      return
    }
    const saved = []
    for (const item of tmpFiles) {
      const displayName = item.relDir ? `${item.relDir}/${item.name}` : item.name
      if (item.tooLarge) {
        results.push({ name: displayName, ok: false, error: `超出大小限制 (${limitMB}MB)` })
        await fs.promises.rm(item.tmp, { force: true }).catch(() => {})
        continue
      }
      if (item.saveError) {
        results.push({ name: displayName, ok: false, error: item.saveError })
        await fs.promises.rm(item.tmp, { force: true }).catch(() => {})
        continue
      }
      try {
        // 目录按需创建：中断或失败时不会留下空目录树（旧实现一收到文件就 mkdirSync）
        await fs.promises.mkdir(item.uploadDir, { recursive: true })
        // overwrite 既支持「文件 basename」（单文件上传），也支持「相对路径」
        // （文件夹级覆盖 —— 前端把整个目录下每个文件的相对路径都列出来）。
        const relPath = item.relDir ? `${item.relDir}/${item.name}` : item.name
        const shouldOverwrite = overwriteNames.includes(item.name) || overwriteNames.includes(relPath)
        let finalName
        if (shouldOverwrite) {
          const targetPath = path.join(item.uploadDir, item.name)
          await fs.promises.rm(targetPath, { force: true })
          await moveEntry(item.tmp, targetPath)
          finalName = item.name
        } else {
          finalName = await uniqueName(item.uploadDir, item.name)
          await moveEntry(item.tmp, path.join(item.uploadDir, finalName))
        }
        const savedRel = item.relDir ? `${item.relDir}/${finalName}` : finalName
        saved.push(savedRel)
        results.push({ name: displayName, ok: true, savedAs: savedRel })
      } catch {
        results.push({ name: displayName, ok: false, error: "保存失败" })
        await fs.promises.rm(item.tmp, { force: true }).catch(() => {})
      }
    }
    if (saved.length) {
      info("upload", {
        msg: `${destRel || "/"} ← ${saved.join(", ")}`,
        ...actor(req),
      })
    }
    const anyTooLarge = results.some((r) => !r.ok && r.error?.includes("超出"))
    res.status(anyTooLarge && !saved.length ? 413 : 200).json({
      results,
      limitMB,
      // 命中单请求文件数上限；busboy 不告知被跳过的具体数量
      truncated: hitFileLimit,
      maxFilesPerRequest: MAX_FILES_PER_REQUEST,
    })
  }

  let bb
  try {
    bb = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      // 必须开启：文件夹上传靠 filename 携带的相对路径还原目录结构，
      // busboy 默认会把它 basename 掉，下面的 dirParts/relDir 就成了死代码。
      preservePath: true,
      limits: { fileSize: limitBytes, files: MAX_FILES_PER_REQUEST, fields: 10 },
    })
  } catch {
    return next(httpError(400, "上传请求格式错误"))
  }

  const pending = []
  bb.on("file", (_field, stream, fileInfo) => {
    const rawName = String(fileInfo.filename)
    const dirParts = rawName.includes("/") ? rawName.split("/").slice(0, -1) : []
    const baseName = path.basename(rawName)
    const name = sanitizeFileName(baseName)
    const relDir = dirParts.map((d) => sanitizeFileName(d)).filter(Boolean).join("/")
    const uploadDir = relDir ? path.join(destAbs, relDir) : destAbs
    const tmp = path.join(TMP_DIR, `up-${crypto.randomBytes(8).toString("hex")}`)
    const item = { name, uploadDir, relDir, tmp, tooLarge: false, saveError: null }
    tmpFiles.push(item)
    const ws = fs.createWriteStream(tmp)
    let writeFailed = false
    // 目标流出错（磁盘写满 ENOSPC、权限不足、TMP_DIR 被删）必须在这里吞掉：
    // pipe 不会自动关闭出错的目标流，未处理的 'error' 事件会升级成未捕获异常并
    // 直接终止整个进程，局域网内所有人同时断线。
    ws.on("error", (err) => {
      writeFailed = true
      item.saveError = err && err.code === "ENOSPC" ? "服务器磁盘空间不足" : "写入失败"
      stream.unpipe(ws)
      ws.destroy()
      stream.resume()
      fs.promises.rm(tmp, { force: true }).catch(() => {})
    })
    stream.on("limit", () => {
      item.tooLarge = true
      stream.unpipe(ws)
      ws.destroy()
      fs.promises.rm(tmp, { force: true }).catch(() => {})
      stream.resume()
    })
    const done = new Promise((resolve) => {
      let settled = false
      const settle = () => { if (!settled) { settled = true; resolve() } }
      stream.on("end", () => {
        if (item.tooLarge || writeFailed) settle()
        else ws.end(settle)
      })
      stream.on("error", () => {
        ws.destroy()
        settle()
      })
      ws.on("close", settle)
    })
    stream.pipe(ws)
    pending.push(done)
  })
  bb.on("filesLimit", () => { hitFileLimit = true })
  bb.on("close", async () => {
    await Promise.all(pending)
    finish(false).catch(next)
  })
  // 清理失败不能变成未捕获异常，客户端也不能干等到超时
  bb.on("error", () => { finish(true).catch(() => {}) })
  req.on("aborted", () => { finish(true).catch(() => {}) })
  req.pipe(bb)
})

router.post("/rename", requirePerm("rename"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径")
    await assertExists(abs)
    const newName = String(req.body?.newName || "").trim()
    const invalid = validateName(newName)
    if (invalid) throw httpError(400, invalid)
    const parentAbs = path.dirname(abs)
    const target = path.join(parentAbs, newName)
    const existing = await statSafe(target)
    let merged = false
    if (existing && path.basename(abs).toLowerCase() !== newName.toLowerCase()) {
      const sourceStat = await statSafe(abs)
      if (req.body?.merge && sourceStat?.isDirectory() && existing.isDirectory()) {
        await mergeFolder(abs, target, "move")
        merged = true
      } else if (req.body?.overwrite) {
        await fs.promises.rm(target, { recursive: true, force: true })
      } else {
        throw httpError(409, "已存在同名文件或文件夹")
      }
    }
    if (!merged) {
      await fs.promises.rename(abs, target)
    }
    const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""
    await remapHiddenPaths(rel, joinRel(parentRel, newName))
    info("rename", { msg: `${rel} → ${newName}`, ...actor(req) })
    res.json({ name: newName })
  } catch (err) {
    next(err)
  }
})

router.post("/delete", requirePerm("delete"), async (req, res, next) => {
  try {
    const paths = req.body?.paths
    if (!Array.isArray(paths) || !paths.length || paths.length > 500) {
      throw httpError(400, "参数格式错误")
    }
    const deleted = []
    for (const p of paths) {
      const { abs, rel } = resolveSafe(p)
      blockSoft(rel)
      assertContextVisible(req, rel)
      if (!rel) throw httpError(400, "不能删除根目录")
      await fs.promises.rm(abs, { recursive: true, force: true })
      deleted.push(rel)
    }
    await saveConfig((draft) => {
      draft.guestHiddenPaths = draft.guestHiddenPaths.filter(
        (h) => !deleted.some((d) => isSameOrInside(h, d))
      )
    })
    info("delete", { msg: deleted.join(", "), ...actor(req) })
    res.json({ deleted: deleted.length })
  } catch (err) {
    next(err)
  }
})

async function mergeFolder(srcAbs, destAbs, mode) {
  const entries = await fs.promises.readdir(srcAbs, { withFileTypes: true })
  for (const dirent of entries) {
    const srcChild = path.join(srcAbs, dirent.name)
    const destChild = path.join(destAbs, dirent.name)
    if (dirent.isDirectory()) {
      const destStat = await statSafe(destChild)
      if (destStat && destStat.isDirectory()) {
        await mergeFolder(srcChild, destChild, mode)
      } else {
        if (destStat) await fs.promises.rm(destChild, { recursive: true, force: true })
        if (mode === "copy") await copyEntry(srcChild, destChild)
        else await moveEntry(srcChild, destChild)
      }
    } else if (dirent.isFile()) {
      if (await statSafe(destChild)) {
        await fs.promises.rm(destChild, { force: true })
      }
      if (mode === "copy") await copyEntry(srcChild, destChild)
      else await moveEntry(srcChild, destChild)
    }
    if (dirent.isSymbolicLink()) continue
  }
  if (mode === "move") await fs.promises.rm(srcAbs, { recursive: true, force: true })
}

async function transfer(req, res, next, mode) {
  try {
    const sources = req.body?.sources
    if (!Array.isArray(sources) || !sources.length || sources.length > 500) {
      throw httpError(400, "参数格式错误")
    }
    const overwrite = !!req.body?.overwrite
    const merge = !!req.body?.merge
    // 冲突处理里选「重命名」时，前端传的是「原始来源路径 + 期望的目标名」。
    // 旧实现把来源路径直接改成新名字再发过来，服务端 assertExists 必然 404，
    // 于是「重命名」这个选项 100% 失败，还会留下一半已完成的结果。
    const rawTargets = req.body?.targetNames
    const targetNames =
      rawTargets && typeof rawTargets === "object" && !Array.isArray(rawTargets) ? rawTargets : {}
    const dest = resolveSafe(req.body?.dest)
    blockSoft(dest.rel)
    assertContextVisible(req, dest.rel)
    await assertDir(dest.abs)
    const done = []
    for (const p of sources) {
      const src = resolveSafe(p)
      if (mode === "move") blockSoft(src.rel)
      if (mode === "copy") blockSoftCopyOut(src.rel)
      assertContextVisible(req, src.rel)
      if (!src.rel) throw httpError(400, "非法来源")
      const stat = await assertExists(src.abs)
      // 用大小写不敏感比较：Windows 上 URL 里的路径大小写常与磁盘不一致，
      // 裸串比较会漏判，导致「把文件夹复制进它自己」。
      if (stat.isDirectory() && isSameOrInside(dest.rel, src.rel)) {
        throw httpError(400, "不能将文件夹移动/复制到其自身内部")
      }
      const srcName = path.basename(src.abs)
      let wanted = srcName
      const wantRaw = targetNames[src.rel]
      if (typeof wantRaw === "string" && wantRaw.trim() && !samePath(wantRaw.trim(), srcName)) {
        const invalid = validateName(wantRaw.trim())
        if (invalid) throw httpError(400, invalid)
        wanted = wantRaw.trim()
      }
      const srcParent = src.rel.includes("/") ? src.rel.slice(0, src.rel.lastIndexOf("/")) : ""
      // 同目录内移动且没有要求改名 → 空操作（旧实现会生成一个 "x (1)" 副本）
      if (mode === "move" && samePath(wanted, srcName) && samePath(srcParent, dest.rel)) {
        done.push(srcName)
        continue
      }
      const target = path.join(dest.abs, wanted)
      const destStat = await statSafe(target)
      if (merge && stat.isDirectory() && destStat && destStat.isDirectory()) {
        await mergeFolder(src.abs, target, mode)
        done.push(wanted)
        continue
      }
      if (overwrite) {
        await fs.promises.rm(target, { recursive: true, force: true })
      }
      const finalName = overwrite ? wanted : await uniqueName(dest.abs, wanted)
      const finalTarget = path.join(dest.abs, finalName)
      if (mode === "copy") await copyEntry(src.abs, finalTarget)
      else await moveEntry(src.abs, finalTarget)
      if (mode === "move") await remapHiddenPaths(src.rel, joinRel(dest.rel, finalName))
      done.push(finalName)
    }
    info(mode, { msg: `${done.join(", ")} → ${dest.rel || "/"}`, ...actor(req) })
    res.json({ done: done.length })
  } catch (err) {
    next(err)
  }
}

router.post("/copy", requirePerm("copy"), (req, res, next) => transfer(req, res, next, "copy"))
router.post("/move", requirePerm("move"), (req, res, next) => transfer(req, res, next, "move"))

router.get("/stat", requirePerm("details"), rateLimit, async (req, res, next) => {
  try {
    const resolved = resolveAny(normRel(req.query.path))
    assertContextVisible(req, resolved.rel)
    const stat = await assertExists(resolved.abs)
    const base = {
      name: resolved.rel ? path.basename(resolved.abs) : "根目录",
      path: resolved.rel,
      type: stat.isDirectory() ? "dir" : "file",
      size: stat.isFile() ? stat.size : 0,
      mtime: stat.mtimeMs,
      created: stat.birthtimeMs,
      hiddenFromGuest: resolved.rel ? isHiddenFromGuest(resolved.rel) : false,
    }
    if (stat.isDirectory()) {
      const usage = await dirStats(resolved.abs)
      base.size = usage.bytes
      base.files = usage.files
      base.dirs = usage.dirs
      base.partial = usage.partial
    }
    res.json(base)
  } catch (err) {
    next(err)
  }
})

router.get("/search", requirePerm("browse"), rateLimit, async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim()
    if (!q || q.length > 100) throw httpError(400, "请输入搜索关键词")
    const resolved = resolveAny(normRel(req.query.path))
    if (!resolved.isSoft && guestBlocked(req, resolved.rel)) throw httpError(404, "目录不存在")
    assertContextVisible(req, resolved.rel)
    await assertDir(resolved.abs)
    let results = await searchFiles(resolved.abs, resolved.rel, q, { forGuest: req.auth.role === "guest" })
    results = results.filter((r) => contextVisible(req, r.path))
    if (resolved.isSoft) {
      results.forEach((r) => { r.softReadOnly = true })
    }
    res.json({ results })
  } catch (err) {
    next(err)
  }
})

router.post(
  "/guest-visibility",
  requireRole("superadmin", "member"),
  requirePerm("manageGuestVisibility"),
  async (req, res, next) => {
    try {
      const { abs, rel } = resolveSafe(req.body?.path)
      if (!rel) throw httpError(400, "不能隐藏根目录")
      // 小组可见范围之外的目录不该被设置访客隐藏标记：与其它写端点保持一致
      assertContextVisible(req, rel)
      const stat = await assertExists(abs)
      if (!stat.isDirectory()) throw httpError(400, "只能对文件夹设置访客可见性")
      const hidden = !!req.body?.hidden
      await saveConfig((draft) => {
        const withoutCurrent = draft.guestHiddenPaths.filter((h) => !samePath(h, rel))
        draft.guestHiddenPaths = hidden ? [...withoutCurrent, rel] : withoutCurrent
      })
      info("guest_visibility", {
        msg: `${rel} ${hidden ? "已对访客隐藏" : "已对访客可见"}`,
        ...actor(req),
      })
      res.json({ path: rel, hidden })
    } catch (err) {
      next(err)
    }
  }
)

async function runCompressJob(job, items, paths, destAbs, req, vis) {
  const outName = items.length === 1 ? `${items[0].name}.zip` : `ZeroShadow-${new Date().toISOString().slice(0, 10)}.zip`
  const finalName = await uniqueName(destAbs, outName)
  const outFile = path.join(destAbs, finalName)
  const ws = fs.createWriteStream(outFile)
  const archive = archiver("zip", { zlib: { level: 5 } })
  // 失败标志：任一流的 error 都会让 finished 提前 resolve，旧实现因此仍然调用
  // finishJob({state:"done"})，前端提示「压缩完成」却留下损坏/0 字节的 zip。
  let failure = null
  const markFailure = (err) => { if (!failure) failure = err || new Error("压缩失败") }
  archive.on("progress", (p) => {
    patchJob(job.id, {
      processed: p.entries.processed,
      processedBytes: p.fs.processedBytes,
      percent: p.entries.total ? Math.min(99, Math.round((p.entries.processed / p.entries.total) * 100)) : 0,
    })
  })
  archive.on("error", (err) => { markFailure(err); failJob(job.id, err) })
  ws.on("error", (err) => { markFailure(err); failJob(job.id, err) })
  const finished = new Promise((resolve) => {
    ws.on("close", resolve)
    archive.on("error", resolve)
    ws.on("error", resolve)
  })
  archive.pipe(ws)
  // 处理同名文件：收集所有条目的名称，为重名项使用路径作为区分
  const nameCount = new Map()
  for (const item of items) {
    nameCount.set(item.name, (nameCount.get(item.name) || 0) + 1)
  }
  const usedNames = new Map()
  for (const item of items) {
    let entryName = item.name
    if (nameCount.get(item.name) > 1) {
      entryName = item.rel ? item.rel.replace(/\//g, "_") : item.name
      const idx = (usedNames.get(entryName) || 0) + 1
      usedNames.set(entryName, idx)
      if (idx > 1) {
        const ext = path.extname(entryName)
        const base = ext ? entryName.slice(0, -ext.length) : entryName
        entryName = `${base}_${idx}${ext}`
      }
    }
    if (item.isDir) {
      await addDirToArchive(archive, item.abs, item.rel, entryName, vis)
    } else {
      archive.file(item.abs, { name: entryName })
    }
  }
  await archive.finalize().catch((err) => { markFailure(err); failJob(job.id, err) })
  await finished
  if (failure) {
    // 删掉半成品：目标目录里不该出现一个打不开的 zip
    await ws.destroy()
    await fs.promises.rm(outFile, { force: true }).catch(() => {})
    failJob(job.id, failure)
    return
  }
  try {
    finishJob(job.id, { state: "done" })
    info("compress", { msg: `${joinRel(paths[0] ? path.dirname(paths[0]) : "", finalName)}`, ...actor(req) })
  } catch (err) {
    failJob(job.id, err)
  }
}

router.post("/compress", requirePerm("compressZip"), rateLimit, async (req, res, next) => {
  try {
    const paths = req.body?.paths
    if (!Array.isArray(paths) || !paths.length || paths.length > 200) {
      throw httpError(400, "参数格式错误")
    }
    const destRel = req.body?.dest || path.dirname(paths[0] || "")
    const dest = resolveSafe(destRel)
    blockSoft(dest.rel)
    assertContextVisible(req, dest.rel)
    await assertDir(dest.abs)
    const vis = zipVisibility(req)
    const sourceRels = paths.map((p) => normRel(p))
    for (const rel of sourceRels) blockSoftCopyOut(rel)
    const items = await collectZipItems(sourceRels, vis)
    if (!items.length) throw httpError(404, "没有可压缩的内容")
    await validateZipLimits(items, vis)
    const { fileCount, totalSize } = await countZipFilesAndSize(items, vis)
    const label = items.length === 1 ? `${items[0].name}.zip` : `ZeroShadow-${new Date().toISOString().slice(0, 10)}.zip`
    const job = createJob("compress", { label, total: fileCount, totalBytes: totalSize })
    job.createdBy = req.auth.username || "guest"
    res.json({ jobId: job.id })
    void runCompressJob(job, items, paths, dest.abs, req, vis).catch((err) => { failJob(job.id, err) })
  } catch (err) { next(err) }
})

router.get("/compress/status", requirePerm("compressZip"), (req, res, next) => {
  try {
    const status = visibleJobStatus(req, String(req.query.job || ""))
    if (!status) return res.json({ id: String(req.query.job || ""), state: "gone" })
    res.json(status)
  } catch (err) { next(err) }
})

router.post("/extract", requirePerm("extractZip"), rateLimit, async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径")
    const destResolved = req.body?.dest ? resolveSafe(req.body.dest) : null
    const destAbs = destResolved ? destResolved.abs : path.dirname(abs)
    blockSoft(req.body?.dest || rel)
    if (destResolved) assertContextVisible(req, destResolved.rel)
    await assertDir(destAbs)
    const stat = await assertExists(abs)
    if (!stat.isFile() || !rel.toLowerCase().endsWith(".zip")) {
      throw httpError(400, "只能解压 zip 文件")
    }
    const limits = zipLimits()
    if (stat.size > limits.extractMaxBytes) {
      throw httpError(400, `ZIP 文件超出解压大小限制 (${Math.round(limits.extractMaxBytes / 1024 / 1024)}MB)`)
    }
    const unzipper = await import("unzipper")
    const directory = await unzipper.Open.file(abs)
    if (directory.files.length > limits.maxFiles) {
      throw httpError(400, `ZIP 内文件数超出限制 (最多 ${limits.maxFiles} 个)`)
    }
    // 先按包头声明值快速拒绝；真正的防护在解压循环里边写边累计
    const declaredTotal = directory.files.reduce((sum, f) => sum + (Number(f.uncompressedSize) || 0), 0)
    if (declaredTotal > limits.extractMaxTotalBytes) {
      throw httpError(400, `ZIP 解压后总大小 (${Math.round(declaredTotal / 1024 / 1024)}MB) 超出限制 (${Math.round(limits.extractMaxTotalBytes / 1024 / 1024)}MB)`)
    }
    const job = createJob("extract", { label: path.basename(abs), total: directory.files.length })
    job.createdBy = req.auth.username || "guest"

    // 使用 zip 文件名（不含 .zip）作为解压目标文件夹
    const zipBaseName = path.basename(abs).replace(/\.zip$/i, "")
    const extractRoot = await uniqueName(destAbs, zipBaseName)
    const extractDestAbs = path.join(destAbs, extractRoot)
    fs.mkdirSync(extractDestAbs, { recursive: true })
    // 失败（含超出总量上限）时把半成品目录清掉，避免留下残缺结果与占满磁盘
    const abortExtract = async (err) => {
      await fs.promises.rm(extractDestAbs, { recursive: true, force: true }).catch(() => {})
      failJob(job.id, err)
    }

    res.json({ jobId: job.id })

    void (async () => {
      const destResolved = path.resolve(extractDestAbs)
      let count = 0
      let written = 0
      for (const file of directory.files) {
        try {
          const entryPath = file.path
          if (entryPath.length > 2048) continue
          const segments = entryPath.replace(/\\/g, "/").split("/")
          if (segments.some((s) => s.length > 200 || s === "..")) continue
          const outPath = path.resolve(extractDestAbs, entryPath)
          const relOut = path.relative(destResolved, outPath)
          if (!relOut || relOut.startsWith("..") || path.isAbsolute(relOut)) continue
          if (file.type === "Directory") {
            fs.mkdirSync(outPath, { recursive: true })
            continue
          }
          if (file.uncompressedSize > limits.maxSingleBytes) continue
          const dirName = path.dirname(outPath)
          if (dirName && dirName !== ".") {
            fs.mkdirSync(dirName, { recursive: true })
          }
          const buf = await file.buffer()
          if (buf.length > limits.maxSingleBytes) continue
          // 用实际写出的字节累计，压缩包头里声明的大小不可信
          written += buf.length
          if (written > limits.extractMaxTotalBytes) {
            throw new Error(`解压后总大小超出限制 (${Math.round(limits.extractMaxTotalBytes / 1024 / 1024)}MB)`)
          }
          await fs.promises.writeFile(outPath, buf)
          count += 1
        } catch (err) {
          await abortExtract(err)
          return
        }
        patchJob(job.id, {
          processed: count,
          processedBytes: written,
          percent: Math.min(99, Math.round((count / directory.files.length) * 100)),
        })
      }
      patchJob(job.id, { count })
      finishJob(job.id, { state: "done" })
      info("extract", { msg: `${rel} → ${count} 文件`, ...actor(req) })
    })().catch((err) => abortExtract(err))
  } catch (err) {
    if (err.message?.includes("Cannot find module 'unzipper'")) {
      return next(httpError(500, "服务端未安装 unzipper 模块，请联系管理员"))
    }
    next(err)
  }
})

router.get("/extract/status", requirePerm("extractZip"), (req, res, next) => {
  try {
    const status = visibleJobStatus(req, String(req.query.job || ""))
    if (!status) return res.json({ id: String(req.query.job || ""), state: "gone" })
    res.json(status)
  } catch (err) { next(err) }
})

/**
 * 在线编辑单次可提交的最大正文（字节）。index.js 用它给 /api/fs/save-file
 * 单独放宽 express.json 的 limit —— 其余接口仍然保持 1MB。
 */
export const SAVE_FILE_MAX_BYTES = 16 * 1024 * 1024

router.post("/save-file", requirePerm("editFiles"), async (req, res, next) => {
  let tmp = null
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径")
    const content = String(req.body?.content ?? "")
    const bytes = Buffer.byteLength(content, "utf8")
    if (bytes > SAVE_FILE_MAX_BYTES) {
      throw httpError(413, `内容过大（${Math.round(bytes / 1024 / 1024)}MB），在线编辑上限 ${SAVE_FILE_MAX_BYTES / 1024 / 1024}MB`)
    }
    // 原子替换：先写同目录临时文件再 rename。直接 writeFile 到目标时，
    // 写盘中断（进程被杀/断电/磁盘满）会把原文件截断成半个。
    tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`)
    await fs.promises.writeFile(tmp, content, "utf8")
    try {
      await fs.promises.rename(tmp, abs)
    } catch {
      // Windows 上 rename 覆盖已存在文件可能失败，退化为先删目标再改名
      await fs.promises.rm(abs, { force: true })
      await fs.promises.rename(tmp, abs)
    }
    tmp = null
    info("save_file", { msg: rel, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  } finally {
    if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => {})
  }
})

// ============ 链接下载器（download-url）============
// 单流顺序下载 + 逐跳重新校验重定向目标（不是多线程分段下载）。
// 出站目标校验（DNS 解析 + 地址段判断）与"固定已校验 IP"的连接方式都在
// netguard.js 中实现，详见该文件头部说明。
const DOWNLOAD_TIMEOUT_MS = 60000

function sizeLimitError(maxBytes) {
  const err = new Error(`下载体积超出限制（${Math.round(maxBytes / 1024 / 1024)}MB）`)
  err.status = 400
  return err
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fetchHop(target, { tempFile, job, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http
    let settled = false
    const done = (fn) => (value) => { if (!settled) { settled = true; fn(value) } }
    const ok = done(resolve)
    const fail = done(reject)

    const options = {
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      headers: {
        Host: target.url.host,
        "User-Agent": "ZeroShadow/1.0",
        Accept: "*/*",
      },
      // 连接只使用已校验的地址：检查之后不再解析 DNS，堵住 DNS rebinding
      lookup: pinnedLookup(target.addresses),
      // 默认严格校验证书；只有显式设置 DOWNLOAD_URL_INSECURE_TLS=1 才放开
      rejectUnauthorized: !insecureTlsAllowed(),
    }

    const req = transport.request(options, (res) => {
      const status = res.statusCode || 0

      if (REDIRECT_CODES.has(status)) {
        const location = res.headers.location
        res.resume()
        if (!location) return fail(new Error("下载失败：重定向缺少目标地址"))
        let nextUrl
        try {
          nextUrl = new URL(location, target.url).toString()
        } catch {
          return fail(new Error("重定向地址无效"))
        }
        return ok({ redirect: nextUrl })
      }

      if (status < 200 || status >= 400) {
        res.resume()
        return fail(new Error(`下载失败: HTTP ${status}`))
      }

      const declared = Number(res.headers["content-length"] || 0)
      if (maxBytes > 0 && declared > maxBytes) {
        res.resume()
        return fail(sizeLimitError(maxBytes))
      }
      if (declared > 0) patchJob(job.id, { totalBytes: declared, processedBytes: 0, percent: 0 })

      const ws = fs.createWriteStream(tempFile)
      let loaded = 0
      let tooBig = false

      res.on("data", (chunk) => {
        loaded += chunk.length
        if (maxBytes > 0 && loaded > maxBytes) {
          tooBig = true
          res.destroy()
          ws.destroy()
          return
        }
        if (declared > 0) {
          patchJob(job.id, { processedBytes: loaded, percent: Math.min(99, Math.round((loaded / declared) * 100)) })
        }
      })
      res.on("error", (err) => { ws.destroy(); fail(err) })
      ws.on("error", (err) => fail(err))
      ws.on("close", () => {
        if (tooBig) return fail(sizeLimitError(maxBytes))
        if (declared > 0 && loaded < declared * 0.95) return fail(new Error("下载未完成（网络中断）"))
        ok({ downloaded: loaded })
      })
      res.pipe(ws)
    })

    req.on("error", (err) => fail(err))
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy()
      fail(new Error("连接超时"))
    })
    // http.request 不会自动发送请求，必须 end()（漏掉会一直挂到超时）
    req.end()
  })
}

async function downloadFileFromUrl(job, firstTarget, destAbs, maxBytes) {
  const tempFile = path.join(TMP_DIR, `dl-${crypto.randomBytes(8).toString("hex")}`)
  try {
    let target = firstTarget
    for (let hop = 0; ; hop += 1) {
      if (hop > MAX_REDIRECTS) throw new Error(`重定向次数过多（最多 ${MAX_REDIRECTS} 次）`)
      const result = await fetchHop(target, { tempFile, job, maxBytes })
      if (result.redirect) {
        // 每一跳都重新解析并校验，避免"先公网后内网"的跳转绕过
        target = await resolveDownloadTarget(result.redirect)
        continue
      }
      const stat = await fs.promises.stat(tempFile)
      if (!stat.size) throw new Error("下载内容为空")
      await moveEntry(tempFile, destAbs)
      finishJob(job.id, { state: "done" })
      return
    }
  } catch (err) {
    await fs.promises.rm(tempFile, { force: true }).catch(() => {})
    failJob(job.id, err)
  }
}

router.post("/download-url", requirePerm("downloadUrl"), rateLimit, async (req, res, next) => {
  try {
    const urlStr = String(req.body?.url || "").trim()
    if (!urlStr) throw httpError(400, "请输入下载链接")
    // 先做目标校验：不合格的地址直接 400，不创建任务
    const target = await resolveDownloadTarget(urlStr)

    const lastSegment = target.url.pathname.split("/").filter(Boolean).pop() || ""
    const fallbackName = safeDecode(lastSegment) || "downloaded-file"
    const inputName = typeof req.body?.filename === "string" ? req.body.filename.trim() : null
    const safeName = sanitizeFileName(inputName || fallbackName)

    const destResolved = resolveSafe(String(req.body?.dest || ""))
    blockSoft(destResolved.rel)
    assertContextVisible(req, destResolved.rel)
    await assertDir(destResolved.abs)
    const uniqueOut = await uniqueName(destResolved.abs, safeName)
    const outPath = path.join(destResolved.abs, uniqueOut)

    const job = createJob("download", { label: uniqueOut, total: 100, totalBytes: 0 })
    job.createdBy = req.auth.username || "guest"
    res.json({ jobId: job.id })
    void downloadFileFromUrl(job, target, outPath, downloadUrlLimitBytes())
  } catch (err) { next(err) }
})

router.get("/download-url/status", requirePerm("downloadUrl"), (req, res, next) => {
  try {
    const status = visibleJobStatus(req, String(req.query.job || ""))
    if (!status) return res.json({ id: String(req.query.job || ""), state: "gone" })
    res.json(status)
  } catch (err) { next(err) }
})

export default router
