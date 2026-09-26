import { getConfig } from "./config.js"

// ============================================================================
//  ratelimit.js - 重型接口的按 IP 限流
//
//  只挂在"单次调用代价高"的接口上（打包下载、在线压缩/解压、递归搜索、
//  目录详情统计、链接下载），避免匿名或低权限用户用极少的请求把 CPU/IO/磁盘
//  打满。按 IP 固定窗口计数（默认每分钟 120 次），可在后台调整或整体关闭。
//
//  刻意不限制普通列目录与单文件下载：画廊预览、连续下载等正常操作会产生大量
//  请求，限流会直接伤害体验。
// ============================================================================

const WINDOW_MS = 60 * 1000
const MAX_TRACKED_IPS = 5000

const buckets = new Map()

export function rateLimit(req, res, next) {
  const config = getConfig()
  if (!config.rateLimitEnabled) return next()

  const limit = Math.max(1, Number(config.rateLimitPerMin) || 120)
  const now = Date.now()
  const key = String(req.ip || req.socket?.remoteAddress || "unknown")

  let bucket = buckets.get(key)
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now }
    buckets.set(key, bucket)
  }

  bucket.count += 1
  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000))
    res.setHeader("Retry-After", String(retryAfter))
    return res.status(429).json({ error: `操作过于频繁，请 ${retryAfter} 秒后再试` })
  }

  if (buckets.size > MAX_TRACKED_IPS) {
    for (const [k, v] of buckets) {
      if (now - v.windowStart >= WINDOW_MS) buckets.delete(k)
    }
  }

  next()
}
