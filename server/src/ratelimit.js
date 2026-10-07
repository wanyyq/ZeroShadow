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

  if (buckets.size > MAX_TRACKED_IPS) evict(now)

  next()
}

/**
 * 淘汰多余桶。
 *
 * 旧实现只删"窗口已过期"的条目，而刚被写入的正是新条目 —— 于是当请求来自大量
 * 不同 IP 时（伪造 X-Forwarded-For，或真实的大局域网），buckets 可以无限增长，
 * 这个"上限"实际不起作用。这里补一层"按窗口起点从早到晚淘汰"，保证有界。
 */
function evict(now) {
  for (const [k, v] of buckets) {
    if (now - v.windowStart >= WINDOW_MS) buckets.delete(k)
  }
  if (buckets.size <= MAX_TRACKED_IPS) return
  const byAge = [...buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)
  const drop = buckets.size - Math.floor(MAX_TRACKED_IPS * 0.9)
  for (let i = 0; i < drop && i < byAge.length; i += 1) buckets.delete(byAge[i][0])
}
