import fs from "node:fs"
import path from "node:path"
import { restrictFileMode } from "./env.js"
import { snapshotBeforeWrite } from "./backup.js"

const queues = new Map()

export function withLock(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    key,
    next.catch(() => {})
  )
  return next
}

export function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

/**
 * 读取 JSON 并保证顶层类型符合预期；不符合时返回 fallback。
 * expect 可为 "array"、"object" 或省略。
 */
export function readJsonTyped(file, fallback, expect) {
  const value = readJsonSync(file, fallback)
  if (expect === "array" && !Array.isArray(value)) return fallback
  if (expect === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return fallback
  }
  return value
}

export async function writeJsonAtomic(file, value) {
  // 覆盖写之前先快照旧文件（data/backups/<name>/），保证可回滚
  snapshotBeforeWrite(file)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), "utf8")
  try {
    await fs.promises.rename(tmp, file)
  } catch {
    await fs.promises.rm(file, { force: true })
    await fs.promises.rename(tmp, file)
  }
  // users.json / config.json 含口令哈希与配置，POSIX 下收紧为仅属主可读写
  restrictFileMode(file)
}
