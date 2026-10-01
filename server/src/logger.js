import fs from "node:fs"
import path from "node:path"
import { LOGS_DIR, NOLOG } from "./env.js"
import { getConfig } from "./config.js"

function dateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function fileFor(key) {
  return path.join(LOGS_DIR, `zs-${key}.log`)
}

// 需要进入"审计事件流"的关键事件
const AUDIT_EVENTS = new Set([
  "login_success",
  "login_fail",
  "login_locked",
  "logout",
  "password_change",
  "config_update",
  "backup_restore",
  "backup_create",
  "members_create",
  "members_batch",
  "members_rename",
  "members_reset_password",
  "group_create",
  "group_update",
  "group_delete",
  "avatar_update",
  "avatar_delete",
  "todo_create",
  "todo_update",
  "todo_done",
  "todo_delete",
  "guest_visibility",
  "delete",
  "rename",
  "upload",
  "compress",
  "extract",
  "save_file",
  "logs_clear",
  "tunnel_enable",
  "tunnel_disable",
])

export function log(level, event, details = {}) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  const localTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const entry = {
    t: localTime,
    lvl: level,
    ev: event,
    msg: details.msg || "",
    user: details.user || null,
    role: details.role || null,
    ip: details.ip || null,
  }
  if (AUDIT_EVENTS.has(event)) entry.audit = true
  try {
    fs.appendFileSync(fileFor(dateKey()), JSON.stringify(entry) + "\n", "utf8")
  } catch {
    /* logging must never crash the app */
  }
  if (NOLOG) return
  const line = `[${entry.t}] ${level.toUpperCase()} ${event}${entry.user ? ` user=${entry.user}` : ""}${entry.ip ? ` ip=${entry.ip}` : ""}${entry.msg ? ` ${entry.msg}` : ""}`
  if (level === "error") console.error(line)
  else console.log(line)
}

export const info = (event, details) => log("info", event, details)
export const warn = (event, details) => log("warn", event, details)
export const error = (event, details) => log("error", event, details)

function listLogFiles() {
  try {
    return fs
      .readdirSync(LOGS_DIR)
      .filter((n) => /^zs-\d{4}-\d{2}-\d{2}\.log$/.test(n))
      .sort()
  } catch {
    return []
  }
}

export async function queryLogs({ limit = 200, level = "", q = "", days = 5, auditOnly = false } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 2000)
  days = Math.min(Math.max(Number(days) || 5, 1), 90)
  const search = String(q || "").toLowerCase()
  const names = listLogFiles().slice(-days)
  const rows = []
  for (const name of names) {
    let text = ""
    try {
      text = await fs.promises.readFile(path.join(LOGS_DIR, name), "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* skip malformed line */
      }
    }
  }
  let out = rows
  if (level) out = out.filter((r) => r.lvl === level)
  if (auditOnly) out = out.filter((r) => r.audit)
  if (search) {
    out = out.filter((r) =>
      [r.ev, r.msg, r.user, r.ip, r.role].some((v) => v && String(v).toLowerCase().includes(search))
    )
  }
  return out.slice(-limit).reverse()
}

/** 对日志行做聚合统计（供日志页图表/概览使用） */
export function aggregateLogs(rows) {
  const byLevel = { info: 0, warn: 0, error: 0 }
  const byEvent = {}
  const byDay = {}
  const users = {}
  for (const r of rows) {
    if (r.lvl && byLevel[r.lvl] !== undefined) byLevel[r.lvl] += 1
    if (r.ev) byEvent[r.ev] = (byEvent[r.ev] || 0) + 1
    const day = String(r.t || "").slice(0, 10)
    if (day) byDay[day] = (byDay[day] || 0) + 1
    if (r.user) users[r.user] = (users[r.user] || 0) + 1
  }
  const topEvents = Object.entries(byEvent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([event, count]) => ({ event, count }))
  return { total: rows.length, byLevel, topEvents, byDay, users }
}

export async function clearLogs() {
  const names = listLogFiles()
  await Promise.all(names.map((n) => fs.promises.rm(path.join(LOGS_DIR, n), { force: true })))
}

/** 按保留天数清理过期日志文件 */
export async function sweepLogs() {
  let days = 30
  try {
    days = Number(getConfig().logRetentionDays) || 30
  } catch {
    /* default */
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of listLogFiles()) {
    const abs = path.join(LOGS_DIR, name)
    try {
      const st = await fs.promises.stat(abs)
      if (st.mtimeMs < cutoff) {
        await fs.promises.rm(abs, { force: true })
        removed += 1
      }
    } catch {
      /* ignore */
    }
  }
  return removed
}
