import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR } from "./env.js"
import { warn } from "./logger.js"

// ============================================================================
//  thumbs.js - 图片缩略图（v2.0）
//
//  为什么需要：网格视图原来直接 `<img src="/api/fs/download?...">` 拉原图，
//  一个 4K 照片就是好几 MB。弱网 / 内网穿透下这是首屏和滚动的最大负担。
//
//  设计要点：
//    1. **内容寻址缓存**：键 = sha1(相对路径 | 大小 | mtime | 宽度)。
//       文件一变，键就变，天然不会拿到旧缩略图；缓存文件永久可缓存。
//    2. **原子写**：先写临时文件再 rename，并发请求不会读到写了一半的 webp。
//    3. **并发与队列有上限**：sharp 是原生库，会吃 CPU/内存；这里最多同时 2 个
//       解码任务，排队超过 64 个直接回 503（让前端退回原图），避免把服务压垮。
//    4. **可降级**：sharp 是原生模块，**pkg 打出来的单文件 exe 里没有它**
//       （原生 .node 无法内联）。加载失败时这里返回 null，路由回 501，
//       前端自动退回原图 —— 功能降级，但服务照常跑。
//    5. **只处理"确定是图片"的文件**：按扩展名白名单 + `limitInputPixels` 限制
//       解码像素数（防"一个 1 亿像素的 png 把内存吃光"）。
// ============================================================================

/** 缩略图缓存目录（放在 data/ 下，与 trash / lang 同理：不能被网盘接口读到） */
export const THUMB_DIR = path.join(DATA_DIR, "thumbs")

/** 允许的输入扩展名。刻意不含 .svg：复杂 SVG 光栅化可能长时间占用 CPU。 */
const INPUT_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".tiff", ".tif", ".bmp"])

/** 允许的输出宽度（前端只会用其中几档，这里收敛成白名单） */
export const THUMB_WIDTHS = [96, 128, 192, 256, 384, 512]
export const DEFAULT_THUMB_WIDTH = 256

/** 单个输入文件上限：再大就不做缩略图（网格里直接显示原图，或干脆只显示图标） */
const MAX_INPUT_BYTES = 64 * 1024 * 1024
/** 解码像素上限（宽 × 高） */
const MAX_INPUT_PIXELS = 80_000_000
/** 同时解码的任务数 */
const MAX_CONCURRENT = 2
/** 排队上限：超过就让调用方退回原图 */
const MAX_QUEUE = 64
/** 缓存总预算：超过后按最旧优先清理 */
const MAX_CACHE_BYTES = 512 * 1024 * 1024
/** 缓存条目保留天数 */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000

let sharpLib = null
let sharpState = "unknown" // unknown | ok | missing

/** 懒加载 sharp；失败只记一次 warn，之后直接判定"不可用" */
async function loadSharp() {
  if (sharpState === "ok") return sharpLib
  if (sharpState === "missing") return null
  try {
    const mod = await import("sharp")
    sharpLib = mod.default ?? mod
    sharpState = "ok"
    return sharpLib
  } catch (err) {
    sharpState = "missing"
    warn("thumb_unavailable", {
      msg: `缩略图不可用（sharp 未安装或无法加载：${err?.message || err}）—— 网格视图将退回原图`,
    })
    return null
  }
}

/** 供路由/状态页查询：当前是否真的能生成缩略图 */
export function thumbAvailable() {
  return sharpState !== "missing"
}

/** 扩展名是否属于"可以做缩略图"的图片 */
export function isThumbSource(name) {
  return INPUT_EXTS.has(path.extname(String(name || "")).toLowerCase())
}

/** 把请求的宽度收敛到白名单里（就近取大），非法值退回默认 */
export function normalizeThumbWidth(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_THUMB_WIDTH
  for (const w of THUMB_WIDTHS) if (n <= w) return w
  return THUMB_WIDTHS[THUMB_WIDTHS.length - 1]
}

function cacheKey(rel, stat, width) {
  return crypto
    .createHash("sha1")
    .update(`${rel}\u0000${stat.size}\u0000${Math.trunc(stat.mtimeMs)}\u0000${width}`)
    .digest("hex")
}

/* ------------------------------------------------------------- 并发闸门 -- */

let active = 0
const waiting = []

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1
    return Promise.resolve(true)
  }
  if (waiting.length >= MAX_QUEUE) return Promise.resolve(false)
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next(true)
  else active -= 1
}

/* ------------------------------------------------------------------ 主流程 -- */

/**
 * 取（或生成）一个缩略图。
 *
 * @param {{ abs: string, rel: string, stat: { size: number, mtimeMs: number }, width?: number }} args
 * @returns {Promise<{ ok: true, file: string, key: string } | { ok: false, reason: string }>}
 *   `reason` 取值：`unsupported`（不是支持的图片）、`too_large`、`no_sharp`、
 *   `busy`（队列满）、`broken`（解码失败）
 */
export async function ensureThumb({ abs, rel, stat, width = DEFAULT_THUMB_WIDTH }) {
  if (!isThumbSource(rel)) return { ok: false, reason: "unsupported" }
  if (stat.size > MAX_INPUT_BYTES) return { ok: false, reason: "too_large" }

  const lib = await loadSharp()
  if (!lib) return { ok: false, reason: "no_sharp" }

  const w = normalizeThumbWidth(width)
  const key = cacheKey(rel, stat, w)
  const file = path.join(THUMB_DIR, `${key}.webp`)

  // 命中缓存：直接返回（stat 里带了 mtime/size，文件改了键就变了）
  try {
    const cached = await fs.promises.stat(file)
    if (cached.size > 0) return { ok: true, file, key }
  } catch {
    /* 未命中，继续生成 */
  }

  const slot = await acquire()
  if (!slot) return { ok: false, reason: "busy" }
  try {
    await fs.promises.mkdir(THUMB_DIR, { recursive: true })
    const tmp = path.join(THUMB_DIR, `.${key}.${process.pid}.${Date.now()}.tmp`)
    await lib(abs, { failOn: "none", limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate() // 按 EXIF 方向摆正
      .resize({ width: w, height: w, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72, effort: 3 })
      .toFile(tmp)
    // 原子落位：并发请求要么看到旧文件、要么看到完整的新文件
    await fs.promises.rename(tmp, file).catch(async (err) => {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
      // Windows 上目标被占用时 rename 可能失败；此时让调用方退回原图即可
      if (err?.code !== "EEXIST" && err?.code !== "EPERM") throw err
    })
    return { ok: true, file, key }
  } catch (err) {
    warn("thumb_failed", { msg: `${rel}: ${err?.message || err}` })
    return { ok: false, reason: "broken" }
  } finally {
    release()
  }
}

/* ------------------------------------------------------------ 缓存维护 -- */

/** 启动时与每 6 小时的维护任务调用：清过期、再按总大小从旧到新淘汰 */
export async function sweepThumbs() {
  let entries = []
  try {
    entries = await fs.promises.readdir(THUMB_DIR)
  } catch {
    return { removed: 0, bytes: 0 }
  }
  const now = Date.now()
  let removed = 0
  const alive = []
  for (const name of entries) {
    const full = path.join(THUMB_DIR, name)
    try {
      const st = await fs.promises.stat(full)
      if (!st.isFile()) continue
      // 残留的临时文件（进程被杀时留下的）一并清掉
      if (name.endsWith(".tmp") || now - st.mtimeMs > MAX_AGE_MS) {
        await fs.promises.rm(full, { force: true })
        removed += 1
        continue
      }
      alive.push({ full, size: st.size, mtime: st.mtimeMs })
    } catch {
      /* 并发删除 / 权限问题：跳过 */
    }
  }
  let total = alive.reduce((sum, f) => sum + f.size, 0)
  if (total > MAX_CACHE_BYTES) {
    alive.sort((a, b) => a.mtime - b.mtime)
    for (const f of alive) {
      if (total <= MAX_CACHE_BYTES) break
      await fs.promises.rm(f.full, { force: true }).catch(() => {})
      total -= f.size
      removed += 1
    }
  }
  return { removed, bytes: total }
}

/** 缓存占用（后台状态页可展示） */
export async function thumbsStats() {
  let files = 0
  let bytes = 0
  try {
    for (const name of await fs.promises.readdir(THUMB_DIR)) {
      try {
        const st = await fs.promises.stat(path.join(THUMB_DIR, name))
        if (st.isFile()) {
          files += 1
          bytes += st.size
        }
      } catch {
        /* 跳过 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return { files, bytes, available: thumbAvailable() }
}
