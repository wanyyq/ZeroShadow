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
  exposesServiceFiles,
  getSoftDirEntries,
  guestBlocked,
  isHiddenFromGuest,
  isSameOrInside,
  isSensitiveAbs,
  isSoftPath,
  joinRel,
  nameErrorKey,
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
import { info, warn } from "../logger.js"
import {
  EDITOR_MAX_BYTES,
  applyEol,
  decodeBuffer,
  detectEncoding,
  detectEol,
  encodeText,
  encodingLabel,
  encodingList,
  isSupportedEncoding,
  looksBinary,
} from "../encoding.js"
import { isVisibleForContext } from "../groups.js"
import { compareVersion, versionOf } from "../version.js"
import { inspectFile } from "../fileinfo.js"
import { moveToTrash, trashAvailable } from "../trash.js"
import { contentDisposition, httpError } from "../http.js"
import { MAX_REDIRECTS, REDIRECT_CODES, insecureTlsAllowed, pinnedLookup, resolveDownloadTarget } from "../netguard.js"
import { rateLimit } from "../ratelimit.js"
import { createJob, failJob, finishJob, jobCreatedBy, jobStatus, patchJob } from "../jobs.js"
import { DEFAULT_THUMB_WIDTH, ensureThumb, isThumbSource, normalizeThumbWidth } from "../thumbs.js"

const router = Router()

function actor(req) {
  return { user: req.auth.username || "guest", role: req.auth.role, ip: req.ip }
}

function blockSoft(rel) {
  if (isSoftPath(rel)) {
    const err = new Error("外部映射目录仅支持只读操作")
    err.status = 403
    err.errorKey = "api.fs.soft_read_only"
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
    err.errorKey = "api.fs.soft_copy_out_forbidden"
    throw err
  }
}

/**
 * 复制来源的"祖先目录"预检（安全复检 D-1）。
 *
 * `blockSoftCopyOut` 只是一道**开关**（默认关，管理员可在后台放开），而
 * `isSensitiveAbs` 只能拦被点名的那个路径：它拦得住「复制 软件/data」，
 * 却拦不住「复制 软件/proj」—— proj 自己不敏感，但子树里有 proj\.env 与
 * proj\data\，而复制走的是 `fs.cp(recursive)`，不做逐条过滤。
 * 打包路径（scanDirForZip / addDirToArchive）有逐条过滤，复制路径没有，这里补齐。
 *
 * 注意：这条与开关无关、始终生效 —— 管理员放开"允许复制出去"的意思是
 * "可以把映射目录里的普通文件搬进来"，不该等于"可以把凭据搬进来"。
 */
function assertCopySourceSafe(abs) {
  if (!exposesServiceFiles(abs)) return
  throw httpError(403, "该目录包含服务自身的配置或运行数据（.env / data/），不允许复制到网盘内", {
    errorKey: "api.fs.copy_source_sensitive",
  })
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
  // 访客隐藏（guestHiddenPaths）必须在这里**统一**生效，不能依赖各端点自己记得调
  // guestBlocked：旧实现只在 /list、/download、/search、/zip 里单独调了它，而
  // /file（在线编辑读取）与 /save-file 只调用了本函数，于是它们完全绕过了隐藏规则
  // —— 未登录访客能读取、甚至覆盖隐藏目录里的文件。
  // 根目录（rel === ""）不会被判定为隐藏，因此列表接口不受影响。
  if (guestBlocked(req, rel) || !contextVisible(req, rel)) {
    const err = new Error("文件或目录不存在")
    err.status = 404
    err.errorKey = "api.fs.not_found"
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

router.get("/list", requirePerm("browse"), async (req, res, next) => {
  try {
    const { abs, rel, isSoft } = resolveSafe(req.query.path)
    if (!isSoft && guestBlocked(req, rel)) throw httpError(404, "目录不存在", { errorKey: "api.fs.dir_not_found" })
    assertContextVisible(req, rel)
    if (isSoft) {
      if (guestBlocked(req, rel)) throw httpError(404, "目录不存在", { errorKey: "api.fs.dir_not_found" })
      const resolved = resolveAny(rel)
      await assertDir(resolved.abs)
      const entries = await listDir(resolved.abs, rel, { forGuest: req.auth.role === "guest" })
      const marked = entries
        .filter((e) => contextVisible(req, joinRel(rel, e.name)))
        // 软目录可能映射到项目根目录（例如 FILES_SOFT_DIR={"软件":"./"}），
        // 那里有 .env 与 data/ —— 服务自身的凭据、会话密钥、日志一律不出现在列表里。
        .filter((e) => !isSensitiveAbs(path.join(resolved.abs, e.name)))
        .map((e) => ({ ...e, softReadOnly: true }))
      res.json({ path: rel, entries: marked })
    } else {
      await assertDir(abs)
      const entries = (await listDir(abs, rel, { forGuest: req.auth.role === "guest" }))
        .filter((e) => !isSensitiveAbs(path.join(abs, e.name)))
        .filter((e) => contextVisible(req, joinRel(rel, e.name)))
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
    if (!resolved.rel) throw httpError(400, "非法路径", { errorKey: "api.fs.path_invalid" })
    // 只读映射目录同样要尊重「对访客隐藏」：旧实现用 `!isSoft` 跳过了这一步，
    // 于是访客只要猜到隐藏软目录里的完整文件名就能下载。
    if (guestBlocked(req, resolved.rel)) throw httpError(404, "文件不存在", { errorKey: "api.fs.file_not_found" })
    assertContextVisible(req, resolved.rel)
    const stat = await assertExists(resolved.abs)
    if (!stat.isFile()) throw httpError(400, "只能下载文件，文件夹请使用打包下载", { errorKey: "api.fs.download_files_only" })

    const name = path.basename(resolved.abs)
    const ext = path.extname(name).slice(1).toLowerCase()
    const extKey = ext || name.toLowerCase()
    // 必须用 attachContext 算好的 req.perms：它已经把当前小组的收窄算进去了。
    // 旧实现重新调用 effectivePerms(role) 且漏传 req.group，导致小组关掉
    // downloadFile/preview 后这里仍然按全局权限放行。
    const perms = req.perms || effectivePerms(req.auth.role, req.group)

    // HTML/SVG 的"内联渲染"受独立权限点 htmlPreview 约束（默认访客为 false）。
    // 管理员关掉它的用意就是"不要在网盘里把上传的网页当页面打开"，而旧实现只在
    // 前端拦（browser-page 里判 htmlPreview 才跳预览页），直接构造
    // `/api/fs/download?path=x.html&inline=1` 就绕过去了。这里改成服务端强判：
    // 没有该权限就一律按附件下发（连"只能预览不能下载"的角色也不再内联）。
    const scriptable = SCRIPTABLE_EXT.has(extKey)
    const inlineAllowed = !scriptable || !!perms.htmlPreview

    if (!perms.downloadFile) {
      if (!perms.preview || !INLINE_TYPES.has(extKey) || !inlineAllowed) {
        if (req.auth.role === "guest") {
          return res.status(401).json({ error: "请先登录", errorKey: "api.auth.login_required" })
        }
        return res.status(403).json({ error: "没有权限下载文件", errorKey: "api.fs.download_forbidden" })
      }
    }

    const inline = req.query.inline === "1" && INLINE_TYPES.has(extKey) && inlineAllowed
    const forceInline = !perms.downloadFile && perms.preview && inlineAllowed
    const useInline = inline || forceInline
    const mime = useInline ? INLINE_TYPES.get(extKey) : "application/octet-stream"
    res.setHeader("Content-Type", mime)
    res.setHeader("Content-Disposition", contentDisposition(useInline ? "inline" : "attachment", name))
    res.setHeader("Cache-Control", "no-store")
    // 上传的 HTML/SVG 属于用户内容，绝不能让它在网盘自身的源下执行：CSP 的
    // sandbox 指令把它强制为不透明源，即使被直接打开（新标签页/第三方内嵌）
    // 也拿不到本站 Cookie、父页面与 /api 会话；脚本仍可运行，静态页面不受影响。
    // 这是 htmlPreview **之外**的第二道防线，两道都要保留。
    if (useInline && scriptable) {
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
    if (isSensitiveAbs(resolved.abs)) continue
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
    // 递归扫描也必须执行同样的「服务自身文件」判定：只校验被点名的目录是不够的，
    // 软目录映射到项目根时，.env / data/ 就在它下面一层。
    if (isSensitiveAbs(abs)) continue
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
    throw httpError(400, `打包文件数 (${fileCount}) 超出限制 (最多 ${limits.maxFiles} 个)`, {
      errorKey: "api.fs.zip_too_many_files",
      errorParams: { count: fileCount, max: limits.maxFiles },
    })
  }
  if (totalSize > limits.maxTotalBytes) {
    throw httpError(
      400,
      `打包总大小 (${Math.round(totalSize / 1024 / 1024)}MB) 超出限制 (${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB)`,
      {
        errorKey: "api.fs.zip_total_too_large",
        errorParams: {
          size: `${Math.round(totalSize / 1024 / 1024)}MB`,
          limit: `${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB`,
        },
      }
    )
  }
  for (const item of items) {
    if (!item.isDir && item.size > limits.maxSingleBytes) {
      throw httpError(
        400,
        `文件 "${item.name}" 大小 (${Math.round(item.size / 1024 / 1024)}MB) 超出单文件限制 (${Math.round(limits.maxSingleBytes / 1024 / 1024)}MB)`,
        {
          errorKey: "api.fs.zip_single_too_large",
          errorParams: {
            name: item.name,
            size: `${Math.round(item.size / 1024 / 1024)}MB`,
            limit: `${Math.round(limits.maxSingleBytes / 1024 / 1024)}MB`,
          },
        }
      )
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
    if (isSensitiveAbs(abs)) continue
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
        throw httpError(400, "参数格式错误", { errorKey: "api.fs.invalid_params" })
      }
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200) {
        throw httpError(400, "参数格式错误", { errorKey: "api.fs.invalid_params" })
      }
      rels = parsed.map((p) => normRel(p))
    } else {
      rels = [normRel(req.query.path)]
    }

    const vis = zipVisibility(req)
    const items = await collectZipItems(rels, vis)
    if (!items.length) throw httpError(404, "没有可下载的内容", { errorKey: "api.fs.zip_nothing_to_download" })
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
    if (invalid) throw httpError(400, invalid, { errorKey: nameErrorKey(invalid) })
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

/**
 * 新建空文件（v1.2.1）。
 *
 * 用于右键「新建 → 新建文本文档 / 新建自定义后缀文件」：只创建**空文件**，
 * 内容一律为空（要写字就走在线编辑器）。刻意不提供"覆盖"语义：
 * 已存在同名时返回 409，让前端提示换名字，避免误删别人的文件。
 *
 * 权限沿用上传（`upload`）：能够新增内容的角色才应该能新增文件。
 */
const CREATE_FILE_MAX_BYTES = 1024 * 1024

router.post("/create-file", requirePerm("upload"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    await assertDir(abs)
    const name = String(req.body?.name || "").trim()
    const invalid = validateName(name)
    if (invalid) throw httpError(400, invalid, { errorKey: nameErrorKey(invalid) })
    const content = typeof req.body?.content === "string" ? req.body.content : ""
    if (Buffer.byteLength(content, "utf8") > CREATE_FILE_MAX_BYTES) {
      throw httpError(413, "初始内容过大", { errorKey: "api.fs.create_file_too_large" })
    }
    // unique=true：自动改名（新建文本文档 (1).txt），反复点击不报错；
    // 否则同名一律 409，避免"再点一次就把别人的文件清空"这种事。
    const unique = req.body?.unique === true
    const finalName = unique ? await uniqueName(abs, name) : name
    const target = path.join(abs, finalName)
    // 先用 lstat 判断，既给出友好提示，也避免 "wx" 的 EEXIST 被当成 500
    if (!unique && (await statSafe(target))) {
      throw httpError(409, "同名文件已存在", { errorKey: "api.fs.create_file_exists" })
    }
    try {
      await fs.promises.writeFile(target, content, { encoding: "utf8", flag: "wx" })
    } catch (err) {
      if (err?.code === "EEXIST") {
        throw httpError(409, "同名文件已存在", { errorKey: "api.fs.create_file_exists" })
      }
      throw err
    }
    info("create_file", { msg: joinRel(rel, finalName), ...actor(req) })
    res.status(201).json({ name: finalName, path: joinRel(rel, finalName) })
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
          // 「覆盖上传」同样是删除：与 rename/copy 走同一条规则（delete 权限 + 回收站），
          // 否则只有 upload 权限的成员也能直接抹掉别人的文件，且无从恢复。
          await removeForOverwrite(req, targetPath, item.relDir ? `${item.relDir}/${item.name}` : item.name)
          await moveEntry(item.tmp, targetPath)
          finalName = item.name
        } else {
          finalName = await uniqueName(item.uploadDir, item.name)
          await moveEntry(item.tmp, path.join(item.uploadDir, finalName))
        }
        const savedRel = item.relDir ? `${item.relDir}/${finalName}` : finalName
        saved.push(savedRel)
        results.push({ name: displayName, ok: true, savedAs: savedRel })
      } catch (err) {
        // 4xx 是"能解释的拒绝"（没有 delete 权限、目标非法…），把原因透给用户；
        // 其余一律按"保存失败"处理，不泄露内部错误。
        const status = Number(err?.status) || 0
        results.push({ name: displayName, ok: false, error: status >= 400 && status < 500 ? err.message : "保存失败" })
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
    return next(httpError(400, "上传请求格式错误", { errorKey: "api.fs.upload_request_invalid" }))
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
    // 「上传文件夹」是独立权限点，旧实现从未校验过它（除 config.js 外全库没有引用），
    // 于是关掉它的角色照样能把整棵目录树塞进一个 multipart 请求传上来。
    // 这里不落盘、但必须把流读完，否则 busboy 会卡住整个请求。
    if (relDir && !req.perms.uploadFolders) {
      item.saveError = "没有上传文件夹的权限"
      stream.resume()
      pending.push(
        new Promise((resolve) => {
          stream.on("end", resolve)
          stream.on("error", resolve)
        })
      )
      return
    }
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

/**
 * 「覆盖」写操作在删除已存在目标时统一走这里。
 *
 * 覆盖的本质就是把目标删掉，因此它必须和 `/api/fs/delete` 用同一套规则：
 *   1. 需要 **delete** 权限 —— 否则只有 rename / move / copy 权限的成员也能
 *      递归销毁任意目录树（`rename` 到已存在的目录 + overwrite 即可）；
 *   2. 目标要进**回收站** —— 旧实现直接 `fs.rm`，一次误覆盖就永久丢失。
 * 回收站不可用（目录建不出来 / 跨设备复制失败）时才退回彻底删除；但那种情况下
 * moveToTrash 会抛 TRASH_FAILED，这里不会静默降级（与 /delete 的承诺一致）。
 */
async function removeForOverwrite(req, targetAbs, targetRel) {
  const perms = req.perms || effectivePerms(req.auth.role, req.group)
  if (!perms.delete) {
    throw httpError(403, "覆盖会删除已有的同名项目，需要「删除」权限", {
      errorKey: "api.fs.overwrite_needs_delete",
    })
  }
  const useTrash = getConfig().trashEnabled !== false && trashAvailable()
  if (useTrash) {
    const meta = await moveToTrash({ abs: targetAbs, rel: targetRel }, actor(req))
    if (meta) return
  }
  await fs.promises.rm(targetAbs, { recursive: true, force: true })
}

router.post("/rename", requirePerm("rename"), async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径", { errorKey: "api.fs.path_invalid" })
    await assertExists(abs)
    const newName = String(req.body?.newName || "").trim()
    const invalid = validateName(newName)
    if (invalid) throw httpError(400, invalid, { errorKey: nameErrorKey(invalid) })
    const parentAbs = path.dirname(abs)
    const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""
    const target = path.join(parentAbs, newName)
    const existing = await statSafe(target)
    let merged = false
    if (existing && path.basename(abs).toLowerCase() !== newName.toLowerCase()) {
      const sourceStat = await statSafe(abs)
      if (req.body?.merge && sourceStat?.isDirectory() && existing.isDirectory()) {
        await mergeFolder(abs, target, "move", req, joinRel(parentRel, newName))
        merged = true
      } else if (req.body?.overwrite) {
        await removeForOverwrite(req, target, joinRel(parentRel, newName))
      } else {
        throw httpError(409, "已存在同名文件或文件夹", { errorKey: "api.fs.name_conflict" })
      }
    }
    if (!merged) {
      await fs.promises.rename(abs, target)
    }
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
      throw httpError(400, "参数格式错误", { errorKey: "api.fs.invalid_params" })
    }
    const useTrash = getConfig().trashEnabled !== false && trashAvailable()
    const deleted = []
    // 回收站不可用（跨设备复制失败等）时记录原因，但仍继续删剩下的，
    // 否则一个坏条目会让整批删除停在中途。
    const trashed = []
    const failedToTrash = []
    // 回收站可用、但**这一项**没能入站的条目：绝不能回落到彻底删除（旧实现就是这样，
    // 于是路径过长 / rename 失败的条目会无声消失，与"删除 = 可还原"的承诺不符）。
    const failed = []
    for (const p of paths) {
      const resolved = resolveAny(normRel(p))
      blockSoft(resolved.rel)
      assertContextVisible(req, resolved.rel)
      if (!resolved.rel) throw httpError(400, "不能删除根目录", { errorKey: "api.fs.cannot_delete_root" })
      if (useTrash) {
        let meta = null
        try {
          meta = await moveToTrash(resolved, actor(req))
        } catch (err) {
          failed.push({ path: resolved.rel, error: err?.message || "无法移入回收站" })
          continue
        }
        if (meta) {
          trashed.push(resolved.rel)
          continue
        }
        failed.push({ path: resolved.rel, error: "无法移入回收站" })
        continue
      }
      failedToTrash.push(resolved.rel)
      await fs.promises.rm(resolved.abs, { recursive: true, force: true })
      deleted.push(resolved.rel)
    }
    await saveConfig((draft) => {
      draft.guestHiddenPaths = draft.guestHiddenPaths.filter(
        (h) => !deleted.concat(trashed).some((d) => isSameOrInside(h, d))
      )
    })
    info("delete", {
      msg: useTrash
        ? `${trashed.length} 项移入回收站${deleted.length ? `，${deleted.length} 项彻底删除` : ""}：${trashed.concat(deleted).join(", ")}`
        : deleted.join(", "),
      ...actor(req),
    })
    if (failedToTrash.length) {
      warn("trash_unavailable_fallback", { msg: `未能移入回收站，已彻底删除：${failedToTrash.join(", ")}` })
    }
    if (failed.length) {
      warn("trash_failed_skipped", { msg: `未能移入回收站，已跳过（未删除）：${failed.map((f) => f.path).join(", ")}` })
    }
    res.json({
      deleted: deleted.length,
      trashed: trashed.length,
      // 回收站没兜住的那部分：前端应当明确告知用户"这些是彻底删掉的"
      permanentlyDeleted: failedToTrash,
      // 回收站可用但入站失败：这些项目**原样保留**，前端要明确报错而不是当成功
      failed,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 合并两个同名目录（移动/复制）。
 *
 * 冲突项同样是"覆盖"：一律走 removeForOverwrite（delete 权限 + 回收站），
 * 否则「合并」就成了绕过 delete 权限递归删文件的第二条路。
 * @param {string} destRel 目标目录在网盘内的相对路径（供回收站记录原路径）
 */
async function mergeFolder(srcAbs, destAbs, mode, req, destRel) {
  const entries = await fs.promises.readdir(srcAbs, { withFileTypes: true })
  for (const dirent of entries) {
    const srcChild = path.join(srcAbs, dirent.name)
    const destChild = path.join(destAbs, dirent.name)
    const childRel = joinRel(destRel, dirent.name)
    if (dirent.isDirectory()) {
      const destStat = await statSafe(destChild)
      if (destStat && destStat.isDirectory()) {
        await mergeFolder(srcChild, destChild, mode, req, childRel)
      } else {
        if (destStat) await removeForOverwrite(req, destChild, childRel)
        if (mode === "copy") await copyEntry(srcChild, destChild)
        else await moveEntry(srcChild, destChild)
      }
    } else if (dirent.isFile()) {
      if (await statSafe(destChild)) {
        await removeForOverwrite(req, destChild, childRel)
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
      throw httpError(400, "参数格式错误", { errorKey: "api.fs.invalid_params" })
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
      if (mode === "copy") {
        blockSoftCopyOut(src.rel)
        assertCopySourceSafe(src.abs)
      }
      assertContextVisible(req, src.rel)
      if (!src.rel) throw httpError(400, "非法来源", { errorKey: "api.fs.source_invalid" })
      const stat = await assertExists(src.abs)
      // 用大小写不敏感比较：Windows 上 URL 里的路径大小写常与磁盘不一致，
      // 裸串比较会漏判，导致「把文件夹复制进它自己」。
      if (stat.isDirectory() && isSameOrInside(dest.rel, src.rel)) {
        throw httpError(400, "不能将文件夹移动/复制到其自身内部", { errorKey: "api.fs.transfer_into_self" })
      }
      const srcName = path.basename(src.abs)
      let wanted = srcName
      const wantRaw = targetNames[src.rel]
      if (typeof wantRaw === "string" && wantRaw.trim() && !samePath(wantRaw.trim(), srcName)) {
        const invalid = validateName(wantRaw.trim())
        if (invalid) throw httpError(400, invalid, { errorKey: nameErrorKey(invalid) })
        wanted = wantRaw.trim()
      }
      const srcParent = src.rel.includes("/") ? src.rel.slice(0, src.rel.lastIndexOf("/")) : ""
      // 同目录内移动且没有要求改名 → 空操作（旧实现会生成一个 "x (1)" 副本）
      if (mode === "move" && samePath(wanted, srcName) && samePath(srcParent, dest.rel)) {
        done.push(srcName)
        continue
      }
      const target = path.join(dest.abs, wanted)
      // 目标与来源是同一个路径时，下面的 overwrite 会先 rm 掉目标 == 源，
      // 文件永久消失（rm 不经过回收站）。同目录「复制 → 粘贴 → 覆盖」就能触发。
      if (samePath(joinRel(dest.rel, wanted), src.rel)) {
        throw httpError(400, "目标与来源相同", { errorKey: "api.fs.transfer_same_target" })
      }
      const destStat = await statSafe(target)
      if (merge && stat.isDirectory() && destStat && destStat.isDirectory()) {
        await mergeFolder(src.abs, target, mode, req, joinRel(dest.rel, wanted))
        done.push(wanted)
        continue
      }
      if (overwrite) {
        await removeForOverwrite(req, target, joinRel(dest.rel, wanted))
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

/**
 * 文件「详细信息」的扩展元数据：签名（magic）、校验和、EXIF、文档作者、
 * 音视频时长、文本编码……
 *
 * 为什么不并进 /stat：
 *   ① /stat 是"秒回"的基础字段（名称/大小/时间），而这个端点要真的读文件
 *      （最多 64KB 头尾 + 流式哈希），两者拆开前端才能先渲染基础信息、再补详情；
 *   ② 目录本来就没有这些信息，混在一起会让 /stat 多出一堆 null 字段。
 */
router.get("/details", requirePerm("details"), rateLimit, async (req, res, next) => {
  try {
    const resolved = resolveAny(normRel(req.query.path))
    assertContextVisible(req, resolved.rel)
    const stat = await assertExists(resolved.abs)
    if (!stat.isFile()) throw httpError(400, "只有文件才有这些详细信息", { errorKey: "api.fs.details_files_only" })
    const details = await inspectFile(resolved.abs, stat)
    res.json({ path: resolved.rel, softReadOnly: !!resolved.isSoft, ...details })
  } catch (err) {
    next(err)
  }
})

/**
 * 缩略图（v2.0）：网格视图用的等比小图。
 *
 * 为什么要单独一个端点：原来网格直接拉 `/api/fs/download` 的原图，一张 4K 照片
 * 就是好几 MB，弱网 / 内网穿透下滚动直接卡死。这里统一出 webp 小图，
 * 内容是**内容寻址缓存**（rel + 大小 + mtime + 宽度），所以：
 *   - 文件改了 → 键变了 → 自动重新生成，不会拿到旧图；
 *   - 同一个图重复请求 → 直接读缓存文件；
 *   - 前端可以给 <img> 加 `loading="lazy"`，不需要它参与 JS 逻辑。
 *
 * 权限跟 `preview` 走（能预览才谈得上缩略图）；路径照样过 `resolveAny` +
 * 上下文可见性校验，所以隐藏目录 / 小组范围外拿不到。
 * `sharp` 不可用时回 501，前端退回原图（功能降级，不影响可用性）。
 */
router.get("/thumb", requirePerm("preview"), rateLimit, async (req, res, next) => {
  try {
    const resolved = resolveAny(normRel(req.query.path))
    assertContextVisible(req, resolved.rel)
    if (!resolved.rel) throw httpError(400, "不能为根目录生成缩略图", { errorKey: "api.fs.thumb_root" })
    const stat = await assertExists(resolved.abs)
    if (!stat.isFile()) throw httpError(400, "只有文件才有缩略图", { errorKey: "api.fs.thumb_files_only" })
    if (!isThumbSource(resolved.rel)) {
      throw httpError(415, "该格式不支持缩略图", { errorKey: "api.fs.thumb_unsupported" })
    }
    const width = normalizeThumbWidth(req.query.w ?? DEFAULT_THUMB_WIDTH)
    const result = await ensureThumb({ abs: resolved.abs, rel: resolved.rel, stat, width })
    if (!result.ok) {
      if (result.reason === "no_sharp") {
        throw httpError(501, "服务端未安装 sharp，缩略图不可用（可继续使用原图）", {
          errorKey: "api.fs.thumb_unavailable",
        })
      }
      if (result.reason === "busy") {
        throw httpError(503, "缩略图生成队列已满，请稍后再试", { errorKey: "api.fs.thumb_busy" })
      }
      if (result.reason === "too_large") {
        throw httpError(413, "图片过大，暂不生成缩略图", { errorKey: "api.fs.thumb_too_large" })
      }
      throw httpError(415, "无法解析该图片", { errorKey: "api.fs.thumb_broken" })
    }
    res.setHeader("Content-Type", "image/webp")
    res.setHeader("Cache-Control", "public, max-age=604800")
    res.setHeader("ETag", `"${result.key}"`)
    res.sendFile(result.file, { cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).end()
    })
  } catch (err) {
    next(err)
  }
})

router.get("/search", requirePerm("browse"), rateLimit, async (req, res, next) => {  try {
    const q = String(req.query.q || "").trim()
    if (!q || q.length > 100) throw httpError(400, "请输入搜索关键词", { errorKey: "api.fs.search_query_required" })
    const resolved = resolveAny(normRel(req.query.path))
    if (!resolved.isSoft && guestBlocked(req, resolved.rel)) throw httpError(404, "目录不存在", { errorKey: "api.fs.dir_not_found" })
    assertContextVisible(req, resolved.rel)
    await assertDir(resolved.abs)
    let results = await searchFiles(resolved.abs, resolved.rel, q, { forGuest: req.auth.role === "guest" })
    results = results.filter((r) => {
      if (!contextVisible(req, r.path)) return false
      // 搜索结果同样不能把服务自身文件（.env、data/**）的名字与大小吐出去
      try {
        return !isSensitiveAbs(resolveAny(r.path).abs)
      } catch {
        return false
      }
    })
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
      if (!rel) throw httpError(400, "不能隐藏根目录", { errorKey: "api.fs.cannot_hide_root" })
      // 小组可见范围之外的目录不该被设置访客隐藏标记：与其它写端点保持一致
      assertContextVisible(req, rel)
      const stat = await assertExists(abs)
      if (!stat.isDirectory()) throw httpError(400, "只能对文件夹设置访客可见性", { errorKey: "api.fs.guest_visibility_folder_only" })
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
      throw httpError(400, "参数格式错误", { errorKey: "api.fs.invalid_params" })
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
    if (!items.length) throw httpError(404, "没有可压缩的内容", { errorKey: "api.fs.compress_nothing" })
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

/**
 * 边解压边计数地把一个 zip 条目读进内存，超过 maxBytes 立刻停手。
 *
 * 为什么不能直接用 unzipper 的 file.buffer()：它内部是无上限累积分片再
 * Buffer.concat，而 zip 中央目录里声明的 uncompressedSize 由压缩包作者完全控制
 * （unzipper/lib/Open/directory.js 直接读该字段）。旧实现先用声明值做体积判断、
 * 再整块读进内存，于是"声明 1000 字节、实际解压 40MB"的包能畅通无阻；按 deflate
 * 的极限压缩比构造，可以让进程直接 OOM。这里只信实际读出来的字节数。
 */
async function readZipEntryLimited(entry, maxBytes) {
  const chunks = []
  let size = 0
  const stream = entry.stream()
  try {
    for await (const chunk of stream) {
      size += chunk.length
      if (size > maxBytes) {
        stream.destroy()
        return { buffer: null, size, tooLarge: true }
      }
      chunks.push(chunk)
    }
  } catch (err) {
    stream.destroy()
    throw err
  }
  return { buffer: Buffer.concat(chunks), size, tooLarge: false }
}

router.post("/extract", requirePerm("extractZip"), rateLimit, async (req, res, next) => {
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径", { errorKey: "api.fs.path_invalid" })
    const destResolved = req.body?.dest ? resolveSafe(req.body.dest) : null
    const destAbs = destResolved ? destResolved.abs : path.dirname(abs)
    blockSoft(req.body?.dest || rel)
    if (destResolved) assertContextVisible(req, destResolved.rel)
    await assertDir(destAbs)
    const stat = await assertExists(abs)
    if (!stat.isFile() || !rel.toLowerCase().endsWith(".zip")) {
      throw httpError(400, "只能解压 zip 文件", { errorKey: "api.fs.extract_zip_only" })
    }
    const limits = zipLimits()
    if (stat.size > limits.extractMaxBytes) {
      throw httpError(
        400,
        `ZIP 文件超出解压大小限制 (${Math.round(limits.extractMaxBytes / 1024 / 1024)}MB)`,
        {
          errorKey: "api.fs.zip_file_too_large",
          errorParams: { limit: `${Math.round(limits.extractMaxBytes / 1024 / 1024)}MB` },
        }
      )
    }
    const unzipper = await import("unzipper")
    const directory = await unzipper.Open.file(abs)
    if (directory.files.length > limits.maxFiles) {
      throw httpError(400, `ZIP 内文件数超出限制 (最多 ${limits.maxFiles} 个)`, {
        errorKey: "api.fs.zip_too_many_entries",
        errorParams: { max: limits.maxFiles },
      })
    }
    // 先按包头声明值快速拒绝；真正的防护在解压循环里边写边累计
    const declaredTotal = directory.files.reduce((sum, f) => sum + (Number(f.uncompressedSize) || 0), 0)
    if (declaredTotal > limits.extractMaxTotalBytes) {
      throw httpError(
        400,
        `ZIP 解压后总大小 (${Math.round(declaredTotal / 1024 / 1024)}MB) 超出限制 (${Math.round(limits.extractMaxTotalBytes / 1024 / 1024)}MB)`,
        {
          errorKey: "api.fs.zip_extract_total_too_large",
          errorParams: {
            size: `${Math.round(declaredTotal / 1024 / 1024)}MB`,
            limit: `${Math.round(limits.extractMaxTotalBytes / 1024 / 1024)}MB`,
          },
        }
      )
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
      // 所有条目**实际**解压出的字节，含被跳过的超大条目：只统计"写出去的部分"
      // 会让攻击者用一串被跳过的炸弹条目无限消耗 CPU。
      let consumed = 0
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
          // 声明值只用来"提前跳过明显超标的条目"，绝不能当作限额依据
          if (file.uncompressedSize > limits.maxSingleBytes) continue
          const read = await readZipEntryLimited(file, limits.maxSingleBytes)
          consumed += read.size
          if (consumed > limits.extractMaxTotalBytes) {
            throw new Error(`解压后总大小超出限制 (${Math.round(limits.extractMaxTotalBytes / 1024 / 1024)}MB)`)
          }
          // 声明值和实际不符（伪造包头 / 压缩炸弹）：丢弃该条目，不写盘
          if (read.tooLarge) continue
          const dirName = path.dirname(outPath)
          if (dirName && dirName !== ".") {
            fs.mkdirSync(dirName, { recursive: true })
          }
          await fs.promises.writeFile(outPath, read.buffer)
          written += read.size
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

/**
 * 在线编辑：按识别出的编码把文本读出来。
 *
 * 旧实现是前端直接 fetch 下载地址再 .text()，也就是一律按 UTF-8 解，
 * 于是 GBK/Big5 的文件打开就是乱码。这里改成服务端识别编码后回 JSON，
 * 同时把原始换行风格一起带回，保存时再还原。
 */
router.get("/file", requirePerm("browse"), rateLimit, async (req, res, next) => {
  try {
    const { abs, rel, isSoft } = resolveSafe(req.query?.path)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径", { errorKey: "api.fs.path_invalid" })
    // 「能看目录」不等于「能读全文」。旧实现只要 browse 就把整个文件（最大 8MB
    // 文本）作为 JSON 返回，于是管理员关掉访客的 downloadFile / preview 之后，
    // 访客仍能通过 /api/fs/file 读到任意文本文件的正文 —— 权限等于没关。
    const perms = req.perms || effectivePerms(req.auth.role, req.group)
    if (!perms.preview && !perms.downloadFile) {
      if (req.auth.role === "guest") {
        return res.status(401).json({ error: "请先登录", errorKey: "api.auth.login_required" })
      }
      return res.status(403).json({ error: "没有权限读取文件内容", errorKey: "api.fs.read_forbidden" })
    }
    const stat = await fs.promises.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) throw httpError(404, "文件不存在", { errorKey: "api.fs.file_not_found" })
    if (stat.size > EDITOR_MAX_BYTES) {
      throw httpError(
        413,
        `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），在线编辑上限 ${EDITOR_MAX_BYTES / 1024 / 1024}MB`,
        {
          errorKey: "api.fs.file_too_large_for_editor",
          errorParams: {
            size: `${(stat.size / 1024 / 1024).toFixed(1)}MB`,
            limit: `${EDITOR_MAX_BYTES / 1024 / 1024}MB`,
          },
        }
      )
    }

    const buf = await fs.promises.readFile(abs)
    const forced = String(req.query?.encoding || "")
    const detected = isSupportedEncoding(forced)
      ? { encoding: forced, bom: forced === "utf8bom", confident: true }
      : detectEncoding(buf)

    // UTF-16 文本天然含 NUL 字节，不能按二进制拦掉
    const isUtf16 = detected.encoding === "utf16le" || detected.encoding === "utf16be"
    if (!isUtf16 && looksBinary(buf)) {
      throw httpError(415, "这看起来是二进制文件，不能当文本编辑", { errorKey: "api.fs.binary_not_editable" })
    }

    const raw = decodeBuffer(buf, detected.encoding)
    res.json({
      path: rel,
      name: path.basename(abs),
      size: stat.size,
      mtime: stat.mtimeMs,
      // 内容版本：编辑器保存时必须原样带回，服务端据此判断"我手里的这份是不是
      // 还是最新的"。没有它就无法发现"别人已经改过、你正要覆盖"。
      baseVersion: versionOf(buf, stat),
      encoding: detected.encoding,
      // false 表示编码是猜的，前端会提示「乱码就手动换编码」
      encodingConfident: detected.confident,
      eol: detectEol(raw),
      content: raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      softReadOnly: !!isSoft,
      encodings: encodingList(),
    })
  } catch (err) {
    next(err)
  }
})

router.post("/save-file", requirePerm("editFiles"), rateLimit, async (req, res, next) => {
  let tmp = null
  try {
    const { abs, rel } = resolveSafe(req.body?.path)
    blockSoft(rel)
    assertContextVisible(req, rel)
    if (!rel) throw httpError(400, "非法路径", { errorKey: "api.fs.path_invalid" })

    const content = String(req.body?.content ?? "")
    const encoding = String(req.body?.encoding || "utf8")
    if (!isSupportedEncoding(encoding)) {
      throw httpError(400, `不支持的编码：${encoding}`, {
        errorKey: "api.fs.encoding_unsupported",
        errorParams: { encoding },
      })
    }
    const rawEol = String(req.body?.eol || "lf")
    const eol = ["crlf", "lf", "cr"].includes(rawEol) ? rawEol : "lf"

    // ---- 并发编辑保护 ----
    // 编辑器打开时拿到了 baseVersion，保存时带回来。这里读一次当前内容比对：
    // 不一致就拒绝写入（409），而不是把别人刚保存的内容静默覆盖掉。
    // 读一次是必要的成本：文件上限 8MB，而一次覆盖的数据丢失是不可逆的。
    const existingBuf = await fs.promises.readFile(abs).catch(() => null)
    const existingStat = existingBuf ? await fs.promises.stat(abs).catch(() => null) : null
    const currentVersion = existingBuf && existingStat ? versionOf(existingBuf, existingStat) : null
    const verdict = compareVersion(req.body?.baseVersion, currentVersion)
    if (verdict === "conflict") {
      const err = httpError(
        409,
        "这个文件在您打开之后已被其他人修改。为避免覆盖对方的改动，本次保存未执行。请重新打开（或刷新页面）查看最新内容后再决定怎么合并。",
        { errorKey: "api.fs.version_conflict" }
      )
      // 把服务器上的当前版本一并回传，前端可以据此提示"重新加载"
      err.code = "VERSION_CONFLICT"
      err.currentVersion = currentVersion
      throw err
    }
    if (verdict === "no-base" && currentVersion) {
      // 第三方脚本 / 老客户端没带版本：放行，但留一条记录便于事后追查
      warn("save_file_without_version", { msg: rel, ...actor(req) })
    }

    const text = applyEol(content, eol)
    const encoded = encodeText(text, encoding)
    if (encoded.error) {
      throw httpError(400, encoded.error, { errorKey: encoded.errorKey, errorParams: encoded.errorParams })
    }
    // 目标编码表示不了的字符会被 iconv 静默写成「?」——宁可拒绝保存，也不要悄悄改坏内容
    if (encoded.unmappable?.length) {
      const shown = encoded.unmappable.slice(0, 12).join(" ")
      const chars = `${shown}${encoded.unmappable.length > 12 ? " …" : ""}`
      throw httpError(
        400,
        `这些字符无法用 ${encodingLabel(encoding)} 表示：${chars}。请改用 UTF-8 保存。`,
        {
          errorKey: "api.fs.unmappable_chars",
          errorParams: { encoding: encodingLabel(encoding), chars },
        }
      )
    }
    const buffer = encoded.buffer
    if (buffer.length > SAVE_FILE_MAX_BYTES) {
      throw httpError(
        413,
        `内容过大（${Math.round(buffer.length / 1024 / 1024)}MB），在线编辑上限 ${SAVE_FILE_MAX_BYTES / 1024 / 1024}MB`,
        {
          errorKey: "api.fs.save_content_too_large",
          errorParams: {
            size: `${Math.round(buffer.length / 1024 / 1024)}MB`,
            limit: `${SAVE_FILE_MAX_BYTES / 1024 / 1024}MB`,
          },
        }
      )
    }

    // 原子替换：先写同目录临时文件再 rename。直接 writeFile 到目标时，
    // 写盘中断（进程被杀/断电/磁盘满）会把原文件截断成半个。
    tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`)
    await fs.promises.writeFile(tmp, buffer)
    try {
      await fs.promises.rename(tmp, abs)
    } catch {
      // Windows 上 rename 覆盖已存在文件可能失败，退化为先删目标再改名
      await fs.promises.rm(abs, { force: true })
      await fs.promises.rename(tmp, abs)
    }
    tmp = null
    info("save_file", { msg: `${rel} (${encoding}, ${eol})`, ...actor(req) })
    res.json({ ok: true, bytes: buffer.length, encoding, eol })
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
    if (!urlStr) throw httpError(400, "请输入下载链接", { errorKey: "api.fs.download_url_required" })
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
