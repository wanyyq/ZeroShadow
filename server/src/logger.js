import fs from "node:fs"
import path from "node:path"
import { LOGS_DIR, NOLOG } from "./env.js"

function dateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function fileFor(key) {
  return path.join(LOGS_DIR, `zs-${key}.log`)
}

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

export async function queryLogs({ limit = 200, level = "", q = "" } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  const search = String(q || "").toLowerCase()
  let names = []
  try {
    names = (await fs.promises.readdir(LOGS_DIR))
      .filter((n) => /^zs-\d{4}-\d{2}-\d{2}\.log$/.test(n))
      .sort()
      .slice(-5)
  } catch {
    return []
  }
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
  if (search) {
    out = out.filter((r) =>
      [r.ev, r.msg, r.user, r.ip, r.role].some((v) => v && String(v).toLowerCase().includes(search))
    )
  }
  return out.slice(-limit).reverse()
}

export async function clearLogs() {
  const names = await fs.promises.readdir(LOGS_DIR)
  await Promise.all(
    names
      .filter((n) => n.endsWith(".log"))
      .map((n) => fs.promises.rm(path.join(LOGS_DIR, n), { force: true }))
  )
}
