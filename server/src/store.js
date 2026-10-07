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

/**
 * 读取 JSON。
 *
 * 必须先剥掉 UTF-8 BOM：`JSON.parse` 不接受开头的 U+FEFF，而 Windows 记事本的
 * "UTF-8 带 BOM" 以及 PowerShell 的 `Set-Content -Encoding utf8`（5.1 默认带 BOM）
 * 都会写入 BOM。旧实现会因此判定配置"损坏"，配合 integrity.js 的隔离逻辑，
 * 结果是：config.json 被移走并以**默认值**运行（guestHiddenPaths 被清空 → 隐藏
 * 目录重新对访客可见），users.json 被移走则全体成员账号消失。
 */
export function readJsonSync(file, fallback) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
    return JSON.parse(text)
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
