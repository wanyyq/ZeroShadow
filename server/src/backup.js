import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR } from "./env.js"
import { getConfig } from "./config.js"

// ============================================================================
//  backup.js - 数据快照与回滚
//
//  策略（定时 + 变更双管）：
//   1. 变更：store.writeJsonAtomic 覆盖写之前，先把旧文件快照到
//      data/backups/<文件名>/<时间戳>-<随机>.json（保证总能回到上一个好状态）；
//   2. 定时：每天首次访问/启动时对全部受管文件做一次快照；
//   3. 轮转：每个文件保留最近 N 份（默认 20，可在后台调整）。
//
//  说明：backup 模块只依赖 env.js，不反向依赖 store.js，避免循环引用。
// ============================================================================

export const BACKUP_DIR = path.join(DATA_DIR, "backups")

// 受管文件（相对 data/ 的文件名）。只有这些名字允许被回滚。
export const MANAGED_FILES = ["config.json", "users.json", "groups.json", "todos.json"]

function managedNames() {
  return new Set(MANAGED_FILES)
}

function dirFor(name) {
  return path.join(BACKUP_DIR, name)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(2).toString("hex")}`
}

function keepCount() {
  try {
    const n = Number(getConfig().backupKeep)
    return Number.isInteger(n) && n >= 1 && n <= 500 ? n : 20
  } catch {
    return 20
  }
}

function rotate(name) {
  const dir = dirFor(name)
  let entries
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => /\.json$/.test(f))
      .map((f) => {
        const abs = path.join(dir, f)
        let mtime = 0
        try {
          mtime = fs.statSync(abs).mtimeMs
        } catch {
          /* ignore */
        }
        return { f, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return
  }
  const keep = keepCount()
  for (const item of entries.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, item.f), { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 把一个已存在的文件快照进备份目录（不存在则跳过，绝不抛错） */
export function snapshotFileAbs(absFile) {
  try {
    // 后台可整体关闭备份（data/config.json: backupEnabled）
    if (getConfig().backupEnabled === false) return false
    const name = path.basename(absFile)
    if (!managedNames().has(name)) return false
    if (!fs.existsSync(absFile)) return false
    const dir = dirFor(name)
    ensureDir(dir)
    const dest = path.join(dir, `${stamp()}.json`)
    fs.copyFileSync(absFile, dest)
    rotate(name)
    return true
  } catch {
    return false
  }
}

/** 覆盖写之前调用：先备份旧内容 */
export function snapshotBeforeWrite(absFile) {
  return snapshotFileAbs(absFile)
}

/** 对全部受管文件做一次快照（每日定时/启动时） */
export function snapshotAll() {
  let count = 0
  for (const name of MANAGED_FILES) {
    if (snapshotFileAbs(path.join(DATA_DIR, name))) count += 1
  }
  return count
}

function lastDailyStampPath() {
  return path.join(BACKUP_DIR, ".last-daily")
}

/** 每天最多做一次全量快照（启动与运行期都可安全调用） */
export function runDailySnapshot() {
  try {
    const today = new Date().toISOString().slice(0, 10)
    let last = ""
    try {
      last = fs.readFileSync(lastDailyStampPath(), "utf8").trim()
    } catch {
      /* first run */
    }
    if (last === today) return false
    snapshotAll()
    ensureDir(BACKUP_DIR)
    fs.writeFileSync(lastDailyStampPath(), today, "utf8")
    return true
  } catch {
    return false
  }
}

/** 列出所有备份：{ config.json: [{ id, size, mtime }], ... } */
export function listBackups() {
  const out = {}
  for (const name of MANAGED_FILES) {
    const dir = dirFor(name)
    const rows = []
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue
        const abs = path.join(dir, f)
        try {
          const st = fs.statSync(abs)
          rows.push({ id: f, size: st.size, mtime: st.mtimeMs })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no backups yet */
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    out[name] = rows
  }
  return out
}

/**
 * 回滚到某一份快照。调用方负责重载内存态（reloadConfig/reloadUsers/...）。
 * 返回被恢复的文件绝对路径。
 */
export function restoreBackup(name, id) {
  if (!managedNames().has(name)) {
    const err = new Error("不支持恢复该文件")
    err.status = 400
    throw err
  }
  const safeId = path.basename(String(id || ""))
  if (!/\.json$/.test(safeId)) {
    const err = new Error("备份标识无效")
    err.status = 400
    throw err
  }
  const src = path.join(dirFor(name), safeId)
  if (!fs.existsSync(src)) {
    const err = new Error("备份不存在")
    err.status = 404
    throw err
  }
  // 校验 JSON 合法性，避免把损坏备份写回去
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(src, "utf8"))
  } catch {
    const err = new Error("该备份已损坏，无法恢复")
    err.status = 400
    throw err
  }
  const dest = path.join(DATA_DIR, name)
  // 覆盖前先把当前状态也存一份，方便反悔
  snapshotFileAbs(dest)
  const tmp = `${dest}.restore-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf8")
  fs.renameSync(tmp, dest)
  return dest
}
