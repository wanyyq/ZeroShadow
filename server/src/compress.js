import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { SHELL_CSP } from "./csp.js"

// ============================================================================
//  compress.js —— 静态文本资源的 gzip / brotli 压缩（v1.2.1）
//
//  为什么要有它：首屏一直是「前端产物原样裸传」——
//  web/dist/assets/index-*.js 约 900KB、lucide.min.js 约 400KB、CSS 约 140KB，
//  弱网下就是几秒钟白屏。文本资源压缩后通常只剩 1/4 ~ 1/5，
//  而且**前端代码一行都不用改**，UI 与交互完全不变。
//
//  实现取舍：
//   - 不引第三方依赖（本项目部署环境可能完全离线），直接用 Node 内置 zlib；
//   - 只处理**静态文件**（按扩展名白名单），不碰 /api（避免与流式下载、SSE 冲突）；
//   - 压缩结果按 (路径, mtime, size, 编码) 缓存在内存里：同一份资源只压一次，
//     之后就是内存拷贝，CPU 与延迟都可忽略；
//   - brotli 用质量 5（默认 11 在 900KB 上会阻塞几百毫秒到数秒，得不偿失），
//     gzip 用级别 6；两者都做，按 Accept-Encoding 协商；
//   - 压缩后仍然发 ETag 并支持 304，浏览器缓存行为与 express.static 一致。
//
//  注意：这个中间件必须挂在 express.static **之前**。它只接管"能压缩的静态文件"，
//  其余请求一律 next() 交回给 express.static，因此不会改变任何既有行为。
// ============================================================================

/** 值得压缩的扩展名 → Content-Type（与 express.static 的 mime 保持一致） */
const TYPES = new Map(
  Object.entries({
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
  })
)

/** 小于这个体积就不值得压（压缩头本身要几十字节） */
const MIN_BYTES = 1024
/** 缓存条目上限与总字节上限：超了按最久未用淘汰 */
const MAX_ENTRIES = 128
const MAX_CACHE_BYTES = 48 * 1024 * 1024

/** key -> { buf, encoding, etag, at } */
const cache = new Map()
let cacheBytes = 0

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  // LRU：命中后移到队尾
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key, value) {
  const prev = cache.get(key)
  if (prev) cacheBytes -= prev.buf.length
  cache.set(key, value)
  cacheBytes += value.buf.length
  while (cache.size > MAX_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    const entry = cache.get(oldest.value)
    cache.delete(oldest.value)
    if (entry) cacheBytes -= entry.buf.length
  }
}

function accepts(header, encoding) {
  if (!header) return false
  return String(header)
    .toLowerCase()
    .split(",")
    .some((part) => {
      const [name, ...params] = part.trim().split(";")
      if (name.trim() !== encoding) return false
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
      if (!q) return true
      const weight = Number.parseFloat(q.slice(2))
      return !Number.isFinite(weight) || weight > 0
    })
}

function chooseEncoding(header) {
  if (accepts(header, "br")) return "br"
  if (accepts(header, "gzip")) return "gzip"
  return null
}

function compress(buf, encoding) {
  if (encoding === "br") {
    return zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    })
  }
  return zlib.gzipSync(buf, { level: 6 })
}

/**
 * 依据文件路径推断 Cache-Control，与 index.js 里 express.static 的 setHeaders 保持一致。
 * 两边不一致会导致"第二次访问反而不走缓存"，所以这里刻意重复一遍。
 */
function cacheControlFor(filePath) {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) return "public, max-age=31536000, immutable"
  if (filePath.includes(`${path.sep}resources${path.sep}`)) return "public, max-age=86400"
  return "no-cache"
}

/**
 * @param {string} rootDir 静态托管根目录（web/dist）
 */
export function createStaticCompressor(rootDir) {
  const root = path.resolve(rootDir)

  return function compressStatic(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next()
    // 只处理静态资源；/api 与 /dav 走各自的路由，这里一概不碰
    const urlPath = (req.path || "/").split("?")[0]
    if (urlPath.startsWith("/api") || urlPath.startsWith("/dav")) return next()

    const ext = path.extname(urlPath).toLowerCase()
    const type = TYPES.get(ext)
    if (!type) return next()

    const encoding = chooseEncoding(req.headers["accept-encoding"])
    if (!encoding) return next()

    // 解析真实路径并确认仍在 dist 之内（防 ../ 穿越）
    const abs = path.resolve(root, `.${decodeURIComponent(urlPath)}`)
    if (abs !== root && !abs.startsWith(root + path.sep)) return next()

    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      return next()
    }
    if (!stat.isFile() || stat.size < MIN_BYTES) return next()
    // favicon 之类不重要，直接放行
    if (stat.size === 0) return next()

    const key = `${abs}|${stat.mtimeMs}|${stat.size}|${encoding}`
    let hit = cacheGet(key)
    if (!hit) {
      let raw
      try {
        raw = fs.readFileSync(abs)
      } catch {
        return next()
      }
      let buf
      try {
        buf = compress(raw, encoding)
      } catch {
        return next()
      }
      // 压缩没有收益（极小/已压缩内容）就交回 express.static
      if (buf.length >= raw.length) return next()
      hit = {
        buf,
        encoding,
        etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${encoding}"`,
        at: Date.now(),
      }
      cacheSet(key, hit)
    }

    res.setHeader("Content-Type", type)
    res.setHeader("Content-Encoding", hit.encoding)
    res.setHeader("Vary", "Accept-Encoding")
    res.setHeader("Content-Length", String(hit.buf.length))
    res.setHeader("ETag", hit.etag)
    res.setHeader("Cache-Control", cacheControlFor(abs))
    res.setHeader("X-Content-Type-Options", "nosniff")
    // 这个中间件挂在 express.static 之前，命中后自己 res.end；static 的 setHeaders
    // 不会再执行。不在这里补上，直连 /index.html（带 Accept-Encoding）就会拿到
    // 一份没有 CSP 的应用外壳。
    if (type.startsWith("text/html")) res.setHeader("Content-Security-Policy", SHELL_CSP)

    if (req.headers["if-none-match"] === hit.etag) {
      res.statusCode = 304
      res.removeHeader("Content-Length")
      return res.end()
    }

    if (req.method === "HEAD") {
      res.removeHeader("Content-Length")
      res.setHeader("Content-Length", String(hit.buf.length))
      return res.end()
    }
    res.end(hit.buf)
    return undefined
  }
}

/** 供测试/诊断：当前缓存占用 */
export function compressorStats() {
  return { entries: cache.size, bytes: cacheBytes }
}
