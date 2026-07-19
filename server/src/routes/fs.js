import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { Router } from "express"
import Busboy from "busboy"
import archiver from "archiver"
import { TMP_DIR } from "../env.js"
import { requirePerm, requireRole } from "../auth.js"
import { saveConfig, uploadLimitBytes, uploadLimitMB } from "../config.js"
import {
  guestBlocked,
  isExactHidden,
  isHiddenFromGuest,
  joinRel,
  normRel,
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

const router = Router()

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function actor(req) {
  return { user: req.auth.username || "guest", role: req.auth.role, ip: req.ip }
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
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
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
  })
)

function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

router.get("/list", async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.query.path)
    if (guestBlocked(req, rel)) throw httpError(404, "目录不存在")
    await assertDir(abs)
    const entries = await listDir(abs, rel, { forGuest: req.auth.role === "guest" })
    res.json({ path: rel, entries })
  } catch (err) {
    next(err)
  }
})

router.get("/download", requirePerm("download"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.query.path)
    if (!rel) throw httpError(400, "非法路径")
    if (guestBlocked(req, rel)) throw httpError(404, "文件不存在")
    const stat = await assertExists(abs)
    if (!stat.isFile()) throw httpError(400, "只能下载文件，文件夹请使用打包下载")

    const name = path.basename(abs)
    const ext = path.extname(name).slice(1).toLowerCase()
    const inline = req.query.inline === "1" && INLINE_TYPES.has(ext)
    res.setHeader("Content-Type", inline ? INLINE_TYPES.get(ext) : "application/octet-stream")
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", name))
    res.setHeader("Cache-Control", "no-store")
    if (!inline) info("download", { msg: rel, ...actor(req) })
    res.sendFile(abs, { dotfiles: "allow", cacheControl: false }, (err) => {
      if (err && !res.headersSent) next(err)
    })
  } catch (err) {
    next(err)
  }
})

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

router.get("/zip", requirePerm("zip"), async (req, res, next) => {
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
    const items = []
    for (const rel of rels) {
      if (!rel) throw httpError(400, "不能打包根目录")
      if (forGuest && isHiddenFromGuest(rel)) continue
      const { abs } = resolveSafe(rel)
      const stat = await statSafe(abs)
      if (!stat || stat.isSymbolicLink()) continue
      items.push({ abs, rel, name: path.basename(abs), isDir: stat.isDirectory() })
    }
    if (!items.length) throw httpError(404, "没有可下载的内容")

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
    for (const item of items) {
      if (item.isDir) {
        await addDirToArchive(archive, item.abs, item.rel, item.name, forGuest)
      } else {
        archive.file(item.abs, { name: item.name })
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
    await assertDir(dest.abs)
    const done = []
    for (const p of sources) {
      const src = resolveSafe(p)
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
    const { abs, rel } = resolveSafe(req.query.path)
    const stat = await assertExists(abs)
    const base = {
      name: rel ? path.basename(abs) : "根目录",
      path: rel,
      type: stat.isDirectory() ? "dir" : "file",
      size: stat.isFile() ? stat.size : 0,
      mtime: stat.mtimeMs,
      created: stat.birthtimeMs,
      hiddenFromGuest: rel ? isHiddenFromGuest(rel) : false,
    }
    if (stat.isDirectory()) {
      const usage = await dirStats(abs)
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
    const { abs, rel } = resolveSafe(req.query.path)
    if (guestBlocked(req, rel)) throw httpError(404, "目录不存在")
    await assertDir(abs)
    const results = await searchFiles(abs, rel, q, { forGuest: req.auth.role === "guest" })
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

async function compressCommon(req, res, paths) {
  const forGuest = req.auth.role === "guest"
  const archive = archiver("zip", { zlib: { level: 5 } })
  archive.on("error", () => { if (!res.headersSent) res.status(500).end(); else res.destroy() })
  const zipName = `ZeroShadow-${new Date().toISOString().slice(0, 10)}.zip`
  res.setHeader("Content-Type", "application/zip")
  res.setHeader("Content-Disposition", contentDisposition("attachment", zipName))
  res.setHeader("Cache-Control", "no-store")
  archive.pipe(res)
  for (const p of paths) {
    const { abs, rel } = resolveSafe(p)
    if (!rel) continue
    if (forGuest && isHiddenFromGuest(rel)) continue
    const stat = await statSafe(abs)
    if (!stat || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await addDirToArchive(archive, abs, rel, path.basename(abs), forGuest)
    } else if (stat.isFile()) {
      archive.file(abs, { name: path.basename(abs) })
    }
  }
  info("compress", { msg: paths.join(", "), ...actor(req) })
  await archive.finalize()
}

router.get("/compress", requirePerm("compressZip"), async (req, res, next) => {
  try {
    let paths = []
    if (req.query.paths) {
      try {
        const parsed = JSON.parse(String(req.query.paths))
        if (Array.isArray(parsed) && parsed.length && parsed.length <= 200) paths = parsed
      } catch { throw httpError(400, "参数格式错误") }
    }
    if (!paths.length) throw httpError(400, "参数格式错误")
    await compressCommon(req, res, paths)
  } catch (err) { next(err) }
})

router.post("/compress", requirePerm("compressZip"), async (req, res, next) => {
  try {
    const paths = req.body?.paths
    if (!Array.isArray(paths) || !paths.length || paths.length > 200) {
      throw httpError(400, "参数格式错误")
    }
    await compressCommon(req, res, paths)
  } catch (err) { next(err) }
})

router.post("/extract", requirePerm("extractZip"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    if (!rel) throw httpError(400, "非法路径")
    const destAbs = req.body?.dest ? resolveSafe(req.body.dest).abs : path.dirname(abs)
    await assertDir(destAbs)
    const stat = await assertExists(abs)
    if (!stat.isFile() || !rel.toLowerCase().endsWith(".zip")) {
      throw httpError(400, "只能解压 zip 文件")
    }
    const unzipper = await import("unzipper")
    const directory = await unzipper.Open.file(abs)
    let count = 0
    for (const file of directory.files) {
      const entryPath = file.path
      if (file.type === "Directory") {
        fs.mkdirSync(path.join(destAbs, entryPath), { recursive: true })
        continue
      }
      const dirName = path.dirname(entryPath)
      if (dirName && dirName !== ".") {
        fs.mkdirSync(path.join(destAbs, dirName), { recursive: true })
      }
      const outPath = path.join(destAbs, entryPath)
      const buf = await file.buffer()
      await fs.promises.writeFile(outPath, buf)
      count += 1
    }
    info("extract", { msg: `${rel} → ${count} 文件`, ...actor(req) })
    res.json({ count })
  } catch (err) {
    if (err.message?.includes("Cannot find module 'unzipper'")) {
      return next(httpError(500, "服务端未安装 unzipper 模块，请联系管理员"))
    }
    next(err)
  }
})

router.post("/save-file", requirePerm("editFiles"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    if (!rel) throw httpError(400, "非法路径")
    const content = String(req.body?.content || "")
    await fs.promises.writeFile(abs, content, "utf8")
    info("save_file", { msg: rel, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
