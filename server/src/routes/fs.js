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
import { effectivePerms, saveConfig, uploadLimitBytes, uploadLimitMB, zipLimits } from "../config.js"
import {
  getSoftDirEntries,
  guestBlocked,
  isExactHidden,
  isHiddenFromGuest,
  isSoftPath,
  joinRel,
  normRel,
  resolveAny,
  resolveSafe,
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
import { createJob, failJob, finishJob, jobStatus, patchJob } from "../jobs.js"

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

function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

router.get("/list", async (req, res, next) => {
  try {
    const { abs, rel, isSoft } = resolveSafe(req.query.path)
    if (!isSoft && guestBlocked(req, rel)) throw httpError(404, "目录不存在")
    if (isSoft) {
      if (guestBlocked(req, rel)) throw httpError(404, "目录不存在")
      const resolved = resolveAny(rel)
      await assertDir(resolved.abs)
      const entries = await listDir(resolved.abs, rel, { forGuest: req.auth.role === "guest" })
      const marked = entries.map((e) => ({ ...e, softReadOnly: true }))
      res.json({ path: rel, entries: marked })
    } else {
      await assertDir(abs)
      const entries = await listDir(abs, rel, { forGuest: req.auth.role === "guest" })
      let all = entries
      if (!rel) {
        let softs = getSoftDirEntries()
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
    if (!resolved.isSoft && guestBlocked(req, resolved.rel)) throw httpError(404, "文件不存在")
    const stat = await assertExists(resolved.abs)
    if (!stat.isFile()) throw httpError(400, "只能下载文件，文件夹请使用打包下载")

    const name = path.basename(resolved.abs)
    const ext = path.extname(name).slice(1).toLowerCase()
    const extKey = ext || name.toLowerCase()
    const perms = effectivePerms(req.auth.role)

    if (!perms.downloadFile) {
      if (!perms.preview || !INLINE_TYPES.has(extKey)) {
        if (req.auth.role === "guest") return res.status(401).json({ error: "请先登录" })
        return res.status(403).json({ error: "没有权限下载文件" })
      }
    }

    const inline = req.query.inline === "1" && INLINE_TYPES.has(extKey)
    const forceInline = !perms.downloadFile && perms.preview
    const useInline = inline || forceInline
    res.setHeader("Content-Type", useInline ? INLINE_TYPES.get(extKey) : "application/octet-stream")
    res.setHeader("Content-Disposition", contentDisposition(useInline ? "inline" : "attachment", name))
    res.setHeader("Cache-Control", "no-store")
    if (!useInline) info("download", { msg: resolved.rel, ...actor(req) })
    res.sendFile(resolved.abs, { dotfiles: "allow", cacheControl: false }, (err) => {
      if (err && !res.headersSent) next(err)
    })
  } catch (err) {
    next(err)
  }
})

async function collectZipItems(rels, forGuest) {
  const items = []
  for (const rel of rels) {
    if (!rel) continue
    if (!isSoftPath(rel) && forGuest && isHiddenFromGuest(rel)) continue
    const resolved = resolveAny(rel)
    const stat = await statSafe(resolved.abs)
    if (!stat || stat.isSymbolicLink()) continue
    items.push({ abs: resolved.abs, rel, name: path.basename(resolved.abs), isDir: stat.isDirectory(), size: stat.isFile() ? stat.size : 0 })
  }
  return items
}

async function countZipFilesAndSize(items, forGuest) {
  let fileCount = 0
  let totalSize = 0
  for (const item of items) {
    if (item.isDir) {
      const scan = await scanDirForZip(item.abs, forGuest)
      fileCount += scan.count
      totalSize += scan.bytes
    } else {
      fileCount += 1
      totalSize += item.size
    }
  }
  return { fileCount, totalSize }
}

async function scanDirForZip(dirAbs, _forGuest) {
  let count = 0
  let bytes = 0
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let dirents
    try {
      dirents = await fs.promises.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      const abs = path.join(cur, d.name)
      if (d.isDirectory()) {
        stack.push(abs)
        count += 1
      } else if (d.isFile()) {
        count += 1
        try {
          const st = await statSafe(abs)
          if (st) bytes += st.size
        } catch { /* skip */ }
      }
    }
  }
  return { count, bytes }
}

async function validateZipLimits(items, forGuest) {
  const limits = zipLimits()
  const { fileCount, totalSize } = await countZipFilesAndSize(items, forGuest)
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

async function addDirToArchive(archive, dirAbs, dirRel, zipBase, forGuest) {
  const dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true })
  if (!dirents.length) archive.append(Buffer.alloc(0), { name: `${zipBase}/.keep` })
  for (const dirent of dirents) {
    const entryRel = joinRel(dirRel, dirent.name)
    if (forGuest && isHiddenFromGuest(entryRel)) continue
    const abs = path.join(dirAbs, dirent.name)
    const stat = await statSafe(abs)
    if (!stat || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await addDirToArchive(archive, abs, entryRel, `${zipBase}/${dirent.name}`, forGuest)
    } else if (stat.isFile()) {
      archive.file(abs, { name: `${zipBase}/${dirent.name}` })
    }
  }
}

router.get("/zip", requirePerm("downloadFolder"), async (req, res, next) => {
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

    const forGuest = req.auth.role === "guest"
    const items = await collectZipItems(rels, forGuest)
    if (!items.length) throw httpError(404, "没有可下载的内容")
    await validateZipLimits(items, forGuest)

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
        await addDirToArchive(archive, item.abs, item.rel, entryName, forGuest)
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

router.post("/upload", requirePerm("upload"), async (req, res, next) => {
  let destAbs
  let destRel
  let overwriteNames = []
  try {
    const resolved = resolveSafe(req.query.path)
    destAbs = resolved.abs
    destRel = resolved.rel
    blockSoft(destRel)
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

  const finish = async (aborted) => {
    if (responded) return
    responded = true
    if (aborted) {
      await Promise.all(tmpFiles.map((t) => fs.promises.rm(t.tmp, { force: true })))
      return
    }
    const saved = []
    for (const item of tmpFiles) {
      if (item.tooLarge) {
        const displayName = item.relDir ? `${item.relDir}/${item.name}` : item.name
        results.push({ name: displayName, ok: false, error: `超出大小限制 (${limitMB}MB)` })
        await fs.promises.rm(item.tmp, { force: true })
        continue
      }
      try {
        const shouldOverwrite = overwriteNames.includes(item.name)
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
        saved.push(item.relDir ? `${item.relDir}/${finalName}` : finalName)
        results.push({ name: item.relDir ? `${item.relDir}/${item.name}` : item.name, ok: true, savedAs: item.relDir ? `${item.relDir}/${finalName}` : finalName })
      } catch {
        results.push({ name: item.name, ok: false, error: "保存失败" })
        await fs.promises.rm(item.tmp, { force: true })
      }
    }
    if (saved.length) {
      info("upload", {
        msg: `${destRel || "/"} ← ${saved.join(", ")}`,
        ...actor(req),
      })
    }
    const anyTooLarge = results.some((r) => !r.ok && r.error?.includes("超出"))
    res.status(anyTooLarge && !saved.length ? 413 : 200).json({ results, limitMB })
  }

  let bb
  try {
    bb = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: { fileSize: limitBytes, files: 100, fields: 10 },
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
    fs.mkdirSync(uploadDir, { recursive: true })
    const tmp = path.join(TMP_DIR, `up-${crypto.randomBytes(8).toString("hex")}`)
    const item = { name, uploadDir, relDir, tmp, tooLarge: false }
    tmpFiles.push(item)
    const ws = fs.createWriteStream(tmp)
    stream.on("limit", () => {
      item.tooLarge = true
      stream.unpipe(ws)
      ws.destroy()
      fs.promises.rm(tmp, { force: true }).catch(() => {})
      stream.resume()
    })
    const done = new Promise((resolve) => {
      stream.on("end", () => {
        if (!item.tooLarge) ws.end(resolve)
        else resolve()
      })
      stream.on("error", () => {
        ws.destroy()
        resolve()
      })
    })
    stream.pipe(ws)
    pending.push(done)
  })
  bb.on("close", async () => {
    await Promise.all(pending)
    finish(false).catch(next)
  })
  bb.on("error", () => finish(true))
  req.on("aborted", () => finish(true))
  req.pipe(bb)
})

router.post("/rename", requirePerm("rename"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
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
    if (isExactHidden(rel)) {
      await saveConfig((draft) => {
        draft.guestHiddenPaths = draft.guestHiddenPaths.map((h) =>
          h === rel ? joinRel(parentRel, newName) : h
        )
      })
    }
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
      if (!rel) throw httpError(400, "不能删除根目录")
      await fs.promises.rm(abs, { recursive: true, force: true })
      deleted.push(rel)
    }
    await saveConfig((draft) => {
      draft.guestHiddenPaths = draft.guestHiddenPaths.filter(
        (h) => !deleted.some((d) => h === d || h.startsWith(d + "/"))
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
    const dest = resolveSafe(req.body?.dest)
    blockSoft(dest.rel)
    await assertDir(dest.abs)
    const done = []
    for (const p of sources) {
      const src = resolveSafe(p)
      if (mode === "move") blockSoft(src.rel)
      if (!src.rel) throw httpError(400, "非法来源")
      const stat = await assertExists(src.abs)
      if (
        stat.isDirectory() &&
        (dest.rel === src.rel || dest.rel.startsWith(src.rel + "/"))
      ) {
        throw httpError(400, "不能将文件夹移动/复制到其自身内部")
      }
      const srcParent = src.rel.includes("/") ? src.rel.slice(0, src.rel.lastIndexOf("/")) : ""
      if (mode === "move" && srcParent === dest.rel) {
        done.push(path.basename(src.abs))
        continue
      }
      const srcName = path.basename(src.abs)
      const target = path.join(dest.abs, srcName)
      const destStat = await statSafe(target)
      if (merge && stat.isDirectory() && destStat && destStat.isDirectory()) {
        await mergeFolder(src.abs, target, mode)
        done.push(srcName)
        continue
      }
      if (overwrite) {
        await fs.promises.rm(target, { recursive: true, force: true })
      }
      const finalName = overwrite ? srcName : await uniqueName(dest.abs, srcName)
      const finalTarget = path.join(dest.abs, finalName)
      if (mode === "copy") await copyEntry(src.abs, finalTarget)
      else await moveEntry(src.abs, finalTarget)
      if (mode === "move" && isExactHidden(src.rel)) {
        const newRel = joinRel(dest.rel, finalName)
        await saveConfig((draft) => {
          draft.guestHiddenPaths = draft.guestHiddenPaths.map((h) => (h === src.rel ? newRel : h))
        })
      }
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

router.get("/stat", requirePerm("details"), async (req, res, next) => {
  try {
    const resolved = resolveAny(normRel(req.query.path))
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

router.get("/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim()
    if (!q || q.length > 100) throw httpError(400, "请输入搜索关键词")
    const resolved = resolveAny(normRel(req.query.path))
    if (!resolved.isSoft && guestBlocked(req, resolved.rel)) throw httpError(404, "目录不存在")
    await assertDir(resolved.abs)
    const results = await searchFiles(resolved.abs, resolved.rel, q, { forGuest: req.auth.role === "guest" })
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
      const stat = await assertExists(abs)
      if (!stat.isDirectory()) throw httpError(400, "只能对文件夹设置访客可见性")
      const hidden = !!req.body?.hidden
      await saveConfig((draft) => {
        const withoutCurrent = draft.guestHiddenPaths.filter(
          (h) => h.toLowerCase() !== rel.toLowerCase()
        )
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

async function runCompressJob(job, items, paths, destAbs, req) {
  const outName = items.length === 1 ? `${items[0].name}.zip` : `ZeroShadow-${new Date().toISOString().slice(0, 10)}.zip`
  const finalName = await uniqueName(destAbs, outName)
  const outFile = path.join(destAbs, finalName)
  const ws = fs.createWriteStream(outFile)
  const archive = archiver("zip", { zlib: { level: 5 } })
  archive.on("progress", (p) => {
    patchJob(job.id, {
      processed: p.entries.processed,
      processedBytes: p.fs.processedBytes,
      percent: p.entries.total ? Math.min(99, Math.round((p.entries.processed / p.entries.total) * 100)) : 0,
    })
  })
  archive.on("error", (err) => failJob(job.id, err))
  ws.on("error", (err) => failJob(job.id, err))
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
      await addDirToArchive(archive, item.abs, item.rel, entryName, req.auth.role === "guest")
    } else {
      archive.file(item.abs, { name: entryName })
    }
  }
  await archive.finalize().catch((err) => failJob(job.id, err))
  await finished
  try {
    finishJob(job.id, { state: "done" })
    info("compress", { msg: `${joinRel(paths[0] ? path.dirname(paths[0]) : "", finalName)}`, ...actor(req) })
  } catch (err) {
    failJob(job.id, err)
  }
}

router.post("/compress", requirePerm("compressZip"), async (req, res, next) => {
  try {
    const paths = req.body?.paths
    if (!Array.isArray(paths) || !paths.length || paths.length > 200) {
      throw httpError(400, "参数格式错误")
    }
    const destRel = req.body?.dest || path.dirname(paths[0] || "")
    const dest = resolveSafe(destRel)
    blockSoft(dest.rel)
    await assertDir(dest.abs)
    const forGuest = req.auth.role === "guest"
    const items = await collectZipItems(paths.map((p) => normRel(p)), forGuest)
    if (!items.length) throw httpError(404, "没有可压缩的内容")
    await validateZipLimits(items, forGuest)
    const { fileCount, totalSize } = await countZipFilesAndSize(items, forGuest)
    const label = items.length === 1 ? `${items[0].name}.zip` : `ZeroShadow-${new Date().toISOString().slice(0, 10)}.zip`
    const job = createJob("compress", { label, total: fileCount, totalBytes: totalSize })
    job.createdBy = req.auth.username || "guest"
    res.json({ jobId: job.id })
    void runCompressJob(job, items, paths, dest.abs, req).catch((err) => { failJob(job.id, err) })
  } catch (err) { next(err) }
})

router.get("/compress/status", requirePerm("compressZip"), (req, res, next) => {
  try {
    const status = jobStatus(String(req.query.job || ""))
    if (!status) return res.json({ id: String(req.query.job || ""), state: "gone" })
    res.json(status)
  } catch (err) { next(err) }
})

router.post("/extract", requirePerm("extractZip"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    if (!rel) throw httpError(400, "非法路径")
    const destAbs = req.body?.dest ? resolveSafe(req.body.dest).abs : path.dirname(abs)
    blockSoft(req.body?.dest || rel)
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
    const job = createJob("extract", { label: path.basename(abs), total: directory.files.length })
    job.createdBy = req.auth.username || "guest"

    // 使用 zip 文件名（不含 .zip）作为解压目标文件夹
    const zipBaseName = path.basename(abs).replace(/\.zip$/i, "")
    const extractRoot = await uniqueName(destAbs, zipBaseName)
    const extractDestAbs = path.join(destAbs, extractRoot)
    fs.mkdirSync(extractDestAbs, { recursive: true })

    res.json({ jobId: job.id })

    void (async () => {
      const destResolved = path.resolve(extractDestAbs)
      let count = 0
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
          await fs.promises.writeFile(outPath, buf)
          count += 1
        } catch (err) {
          failJob(job.id, err)
          return
        }
        patchJob(job.id, {
          processed: count,
          percent: Math.min(99, Math.round((count / directory.files.length) * 100)),
        })
      }
      patchJob(job.id, { count })
      finishJob(job.id, { state: "done" })
      info("extract", { msg: `${rel} → ${count} 文件`, ...actor(req) })
    })().catch((err) => failJob(job.id, err))
  } catch (err) {
    if (err.message?.includes("Cannot find module 'unzipper'")) {
      return next(httpError(500, "服务端未安装 unzipper 模块，请联系管理员"))
    }
    next(err)
  }
})

router.get("/extract/status", requirePerm("extractZip"), (req, res, next) => {
  try {
    const status = jobStatus(String(req.query.job || ""))
    if (!status) return res.json({ id: String(req.query.job || ""), state: "gone" })
    res.json(status)
  } catch (err) { next(err) }
})

router.post("/save-file", requirePerm("editFiles"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    if (!rel) throw httpError(400, "非法路径")
    const content = String(req.body?.content || "")
    await fs.promises.writeFile(abs, content, "utf8")
    info("save_file", { msg: rel, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ============ 多线程下载器 ============
function validateHttpUrl(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.protocol !== "http:" && u.protocol !== "https:") return "仅支持 http/https 链接"
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") return "不允许下载本地地址"
    const privateRanges = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./]
    if (privateRanges.some((r) => r.test(u.hostname))) return "不允许下载内网地址"
    return null
  } catch {
    return "URL 格式无效"
  }
}

async function downloadFileFromUrl(job, urlStr, destAbs) {
  const parsed = new URL(urlStr)
  const transport = parsed.protocol === "https:" ? https : http
  const tempFile = path.join(TMP_DIR, `dl-${crypto.randomBytes(8).toString("hex")}`)

  return new Promise((resolve) => {
    const req = transport.get(parsed, { rejectUnauthorized: false }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location
        if (loc) {
          const err = validateHttpUrl(loc.startsWith("/") ? `${parsed.origin}${loc}` : loc)
          if (err) return resolve(failJob(job.id, new Error(err)))
          return resolve(downloadFileFromUrl(job, loc.startsWith("/") ? `${parsed.origin}${loc}` : loc, destAbs))
        }
        return resolve(failJob(job.id, new Error(`下载失败: 重定向无目标`)))
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        return resolve(failJob(job.id, new Error(`下载失败: HTTP ${res.statusCode}`)))
      }
      const total = Number(res.headers["content-length"] || 0)
      if (total > 0) patchJob(job.id, { totalBytes: total })
      const ws = fs.createWriteStream(tempFile)
      let loaded = 0
      res.on("data", (chunk) => {
        loaded += chunk.length
        if (total > 0) {
          patchJob(job.id, { processedBytes: loaded, percent: Math.min(99, Math.round((loaded / total) * 100)) })
        }
      })
      res.pipe(ws)
      ws.on("error", (err) => {
        ws.destroy(); resolve(failJob(job.id, err)); return
      })
      ws.on("close", async () => {
        try {
          const st = await fs.promises.stat(tempFile)
          if (total > 0 && st.size < total * 0.95) {
            await fs.promises.rm(tempFile, { force: true })
            return resolve(failJob(job.id, new Error("下载未完成（网络中断）")))
          }
          await moveEntry(tempFile, destAbs)
          finishJob(job.id, { state: "done" })
          resolve()
        } catch (err) {
          resolve(failJob(job.id, err))
        }
      })
    })
    req.on("error", (err) => { resolve(failJob(job.id, err)); return })
    req.setTimeout(60000, () => { req.destroy(); resolve(failJob(job.id, new Error("连接超时"))); return })
  })
}

router.post("/download-url", requirePerm("downloadUrl"), async (req, res, next) => {
  try {
    const urlStr = String(req.body?.url || "").trim()
    if (!urlStr) throw httpError(400, "请输入下载链接")
    const urlErr = validateHttpUrl(urlStr)
    if (urlErr) throw httpError(400, urlErr)
    const parts = typeof urlStr === "string" ? urlStr.split("/").filter(Boolean) : []
    const rawName = parts.length ? decodeURIComponent(parts[parts.length - 1]) : "downloaded-file"
    const fallbackName = rawName.split("?")[0].split("#")[0]
    const inputName = typeof req.body?.filename === "string" ? req.body.filename.trim() : null
    const finalName = inputName || fallbackName || "downloaded-file"
    const safeName = sanitizeFileName(finalName)
    const dest = String(req.body?.dest || "")
    const destResolved = resolveSafe(dest)
    blockSoft(destResolved.rel)
    await assertDir(destResolved.abs)
    const uniqueOut = await uniqueName(destResolved.abs, safeName)
    const outPath = path.join(destResolved.abs, uniqueOut)

    const label = uniqueOut
    const contentLength = 0  // unknown until HEAD
    const job = createJob("download", { label, total: 100, totalBytes: contentLength })
    job.createdBy = req.auth.username || "guest"
    res.json({ jobId: job.id })
    void downloadFileFromUrl(job, urlStr, outPath)
  } catch (err) { next(err) }
})

router.get("/download-url/status", requirePerm("downloadUrl"), (req, res, next) => {
  try {
    const status = jobStatus(String(req.query.job || ""))
    if (!status) return res.json({ id: String(req.query.job || ""), state: "gone" })
    res.json(status)
  } catch (err) { next(err) }
})

export default router
