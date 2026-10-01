import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR, FILES_DIR } from "./env.js"
import { dirStats } from "./files.js"
import { getConfig } from "./config.js"
import { info, warn } from "./logger.js"

// ============================================================================
//  metrics.js - 系统指标 + 请求指标采集
//
//   - 系统指标：每分钟采样一次（CPU/内存/磁盘/文件数），内存环形保留最近
//     N 分钟（默认 15），同时追加写入 data/metrics/YYYY-MM-DD.jsonl（保留 7 天）。
//   - 请求指标：按分钟聚合计入环形桶，统计 QPS/状态码分布/慢请求。
//   - 为控制占用：文件数统计最多每 5 分钟重算一次（复用 dirStats 缓存）。
// ============================================================================

export const METRICS_DIR = path.join(DATA_DIR, "metrics")
fs.mkdirSync(METRICS_DIR, { recursive: true })

const SAMPLE_MS = 60 * 1000
const STORAGE_CACHE_MS = 5 * 60 * 1000
const MAX_SLOW = 50
const MB = 1024 * 1024

let prevCpu = readCpu()
const memSamples = []
const slowRequests = []
let currentBucket = newBucket(Date.now())
const buckets = []
let storageCache = { at: 0, value: null }
let timer = null
let totals = { requests: 0, errors: 0 }

function readCpu() {
  const cpus = os.cpus() || []
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    for (const key of Object.keys(cpu.times)) total += cpu.times[key]
    idle += cpu.times.idle
  }
  return { idle, total }
}

function cpuPercent() {
  const now = readCpu()
  const idleDelta = now.idle - prevCpu.idle
  const totalDelta = now.total - prevCpu.total
  prevCpu = now
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10))
}

function newBucket(now) {
  return { t: now, total: 0, s2: 0, s3: 0, s4: 0, s5: 0, slow: 0 }
}

function memMinutes() {
  try {
    const n = Number(getConfig().metricsMemMinutes)
    return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : 15
  } catch {
    return 15
  }
}

async function storageUsage() {
  const now = Date.now()
  if (storageCache.value && now - storageCache.at < STORAGE_CACHE_MS) return storageCache.value
  let usage = { files: 0, dirs: 0, bytes: 0, partial: false }
  try {
    usage = await dirStats(FILES_DIR)
  } catch {
    /* keep zeros */
  }
  storageCache = { at: now, value: usage }
  return usage
}

async function diskUsage() {
  try {
    const stat = await fs.promises.statfs(FILES_DIR)
    return { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) }
  } catch {
    return null
  }
}

function flushBucket(now) {
  if (now - currentBucket.t >= 60 * 1000) {
    buckets.push(currentBucket)
    currentBucket = newBucket(now)
    const keep = memMinutes()
    while (buckets.length > keep) buckets.shift()
  }
}

export function recordRequest(req, res, durationMs) {
  const now = Date.now()
  flushBucket(now)
  const status = res.statusCode || 0
  currentBucket.total += 1
  totals.requests += 1
  if (status >= 500) {
    currentBucket.s5 += 1
    totals.errors += 1
  } else if (status >= 400) currentBucket.s4 += 1
  else if (status >= 300) currentBucket.s3 += 1
  else currentBucket.s2 += 1

  let slowMs = 1000
  try {
    const cfg = getConfig()
    if (cfg.requestMetricsEnabled === false) return
    slowMs = Number(cfg.slowRequestMs) || 1000
  } catch {
    /* default */
  }
  if (durationMs >= slowMs) {
    currentBucket.slow += 1
    slowRequests.push({
      method: req.method,
      path: req.path,
      status,
      ms: Math.round(durationMs),
      at: new Date().toISOString(),
    })
    if (slowRequests.length > MAX_SLOW) slowRequests.splice(0, slowRequests.length - MAX_SLOW)
  }
}

/** express 中间件：统计每个请求的耗时与状态 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint()
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    try {
      recordRequest(req, res, ms)
    } catch {
      /* metrics must never crash requests */
    }
  })
  next()
}

function dateKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function cleanupOldMetrics() {
  let days = 7
  try {
    days = Number(getConfig().metricsRetentionDays) || 7
  } catch {
    /* default */
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  try {
    const names = await fs.promises.readdir(METRICS_DIR)
    for (const name of names) {
      if (!/^zs-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
      const abs = path.join(METRICS_DIR, name)
      try {
        const st = await fs.promises.stat(abs)
        if (st.mtimeMs < cutoff) await fs.promises.rm(abs, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** 采集一个系统指标样本 */
export async function sampleMetrics() {
  const now = Date.now()
  flushBucket(now)
  const usage = await storageUsage()
  const disk = await diskUsage()
  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const sample = {
    t: now,
    cpu: cpuPercent(),
    memUsedPct: totalMem ? Math.round(((totalMem - os.freemem()) / totalMem) * 1000) / 10 : 0,
    rssMB: Math.round(mem.rss / MB),
    heapUsedMB: Math.round(mem.heapUsed / MB),
    freeMB: Math.round(os.freemem() / MB),
    totalMB: Math.round(totalMem / MB),
    diskFreeMB: disk ? Math.round(disk.free / MB) : null,
    diskTotalMB: disk ? Math.round(disk.total / MB) : null,
    files: usage.files,
    dirs: usage.dirs,
    bytes: usage.bytes,
  }
  memSamples.push(sample)
  const keep = memMinutes()
  while (memSamples.length > keep) memSamples.shift()
  try {
    await fs.promises.appendFile(path.join(METRICS_DIR, `zs-${dateKey()}.jsonl`), JSON.stringify(sample) + "\n", "utf8")
  } catch {
    /* ignore disk write errors */
  }
  return sample
}

export async function startMetrics() {
  // 启动即采一次，避免首屏空白
  try {
    await sampleMetrics()
  } catch (err) {
    warn("metrics_sample_fail", { msg: String(err?.message || err) })
  }
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    sampleMetrics().catch(() => {})
    cleanupOldMetrics().catch(() => {})
  }, SAMPLE_MS)
  timer.unref?.()
  info("metrics_start", { msg: `采样间隔 ${SAMPLE_MS / 1000}s` })
}

export function stopMetrics() {
  if (timer) clearInterval(timer)
  timer = null
}

function requestSnapshot() {
  flushBucket(Date.now())
  const last = currentBucket
  const recent = [...buckets, currentBucket]
  const totalRecent = recent.reduce((s, b) => s + b.total, 0)
  const qps = Math.round((totalRecent / (memMinutes() * 60)) * 100) / 100
  return {
    qps,
    lastMinute: { total: last.total, s2: last.s2, s3: last.s3, s4: last.s4, s5: last.s5, slow: last.slow },
    series: recent.map((b) => ({ t: b.t, total: b.total, s4: b.s4, s5: b.s5, slow: b.slow })),
    slow: [...slowRequests].reverse(),
    totals,
  }
}

export function getMetrics() {
  return {
    mem: [...memSamples],
    latest: memSamples[memSamples.length - 1] || null,
    requests: requestSnapshot(),
    config: {
      memMinutes: memMinutes(),
      sampleMs: SAMPLE_MS,
    },
  }
}

/** 读取某天的历史指标（用于较长时间范围查看） */
export async function readMetricsHistory(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) {
    const err = new Error("日期格式无效")
    err.status = 400
    throw err
  }
  const abs = path.join(METRICS_DIR, `zs-${dateStr}.jsonl`)
  let text
  try {
    text = await fs.promises.readFile(abs, "utf8")
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* skip malformed */
    }
  }
  return rows.slice(-1440)
}
