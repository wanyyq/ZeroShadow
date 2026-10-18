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
  "share_create",
  "share_unlock",
  "share_browse",
  "share_download",
  "share_revoke",
  "share_admin_revoke",
  "share_password_fail",
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
  // 控制台行里的 user/msg 来自请求（登录名甚至未经字符集校验），必须清掉换行，
  // 否则可以伪造出一整行看起来像系统输出的日志。磁盘上的 JSON 行不受影响
  // （JSON.stringify 会转义）。
  const oneLine = (v) => String(v).replace(/[\r\n\u2028\u2029]+/g, " ")
  const line = `[${entry.t}] ${level.toUpperCase()} ${event}${entry.user ? ` user=${oneLine(entry.user)}` : ""}${entry.ip ? ` ip=${entry.ip}` : ""}${entry.msg ? ` ${oneLine(entry.msg)}` : ""}`
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

/**
 * 查询日志。
 * @param {{limit?:number, level?:string, q?:string, days?:number, auditOnly?:boolean, unlimited?:boolean}} options
 *   `unlimited` 只给导出用：不截断到 limit，直接返回范围内的全部行。
 *   界面查询必须保留 limit 上限，否则一次日志页刷新会把几万行读进内存并
 *   塞进响应体。
 */
export async function queryLogs({ limit = 200, level = "", q = "", days = 5, auditOnly = false, unlimited = false } = {}) {
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
  if (unlimited) return out
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

// ============================================================ 日志导出 =====

/**
 * CSV 字段转义：含分隔符 / 引号 / 换行时用双引号包裹，内部引号翻倍；
 * 以 `= + - @ 制表符 回车` 开头的值额外加一个前导单引号。
 *
 * 最后这条是防"公式注入"：Excel / LibreOffice / Google Sheets 会把以 = 开头的
 * 单元格当公式求值（DDE 可导致命令执行），而加引号并不能阻止它求值。而日志里
 * 有大量攻击者可控内容 —— 未登录的登录名（routes/auth.js 里仅校验长度）会直接
 * 进入 user 列，成员也能用 `=...` 当文件名。
 */
function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (!/[",\r\n]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

const CSV_COLUMNS = [
  ["t", "时间"],
  ["lvl", "级别"],
  ["ev", "事件"],
  ["user", "用户"],
  ["role", "角色"],
  ["ip", "IP"],
  ["audit", "审计"],
  ["msg", "详情"],
]

/**
 * 把日志行序列化成 CSV。
 *
 * 细节（都是踩过的坑）：
 *   - 开头加 **UTF-8 BOM**：Excel（尤其中文 Windows）不加 BOM 会把 UTF-8
 *     当成 ANSI 读，中文全变乱码；
 *   - 用 **CRLF** 换行：同样是 Excel 的兼容性要求；
 *   - audit 列输出 `是`/`否` 而不是 true/false，给非技术同事看更直观。
 */
export function logsToCsv(rows) {
  const lines = [CSV_COLUMNS.map((c) => c[1]).join(",")]
  for (const row of rows) {
    lines.push(
      CSV_COLUMNS.map(([key]) => {
        if (key === "audit") return row.audit ? "是" : "否"
        return csvCell(row[key])
      })
        .join(",")
        .replace(/\r?\n/g, " ")
    )
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n"
}

/** 把日志行序列化成 JSONL（与磁盘上的格式一致，便于直接喂给脚本） */
export function logsToJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
}

/** 导出文件名：带上筛选条件与时间戳，多个导出文件不会互相覆盖 */
export function logsExportName(format, { auditOnly, days }) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const scope = auditOnly ? "audit" : "all"
  return `zeroshadow-logs-${scope}-${days}d-${stamp}.${format === "csv" ? "csv" : "jsonl"}`
}

/**
 * ASCII 回退文件名（给非 RFC 5987 的老客户端）。
 * 因为导出名里只有 ASCII 字符，直接复用同一个名字即可，不需要音译。
 */
export function logsExportNameAscii(format, opts) {
  return logsExportName(format, opts)
}

/** 按保留天数清理过期日志文件 */export async function sweepLogs() {
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
