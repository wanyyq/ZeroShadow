import fs from "node:fs"
import path from "node:path"

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

export async function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), "utf8")
  try {
    await fs.promises.rename(tmp, file)
  } catch {
    await fs.promises.rm(file, { force: true })
    await fs.promises.rename(tmp, file)
  }
}
