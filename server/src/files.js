import fs from "node:fs"
import path from "node:path"
import { isHiddenFromGuest, joinRel } from "./safety.js"

export async function entryInfo(dirAbs, dirent) {
  const abs = path.join(dirAbs, dirent.name)
  try {
    const stat = await fs.promises.lstat(abs)
    if (stat.isSymbolicLink()) return null
    if (stat.isDirectory()) {
      return { name: dirent.name, type: "dir", size: 0, mtime: stat.mtimeMs }
    }
    if (stat.isFile()) {
      // 快捷方式文件 (.zeropath)
      if (dirent.name.toLowerCase().endsWith(".zeropath")) {
        try {
          const raw = await fs.promises.readFile(abs, "utf8")
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === "object") {
            const rawType = String(parsed.type || "")
            const targetType = ["file", "path", "soft_file", "soft_path"].includes(rawType) ? rawType
              : rawType === "dir" ? "path"
              : rawType === "soft_dir" ? "soft_path"
              : "path"
            return {
              name: dirent.name,
              type: "shortcut",
              size: stat.size,
              mtime: stat.mtimeMs,
              shortcut: {
                targetType,
                targetUrl: String(parsed.url || ""),
                logo: typeof parsed.logo === "string" ? parsed.logo : null,
                displayName: parsed.name || dirent.name.replace(/\.zeropath$/i, ""),
              },
            }
          }
        } catch {
          /* invalid json, fall through to regular file */
        }
      }
      return { name: dirent.name, type: "file", size: stat.size, mtime: stat.mtimeMs }
    }
    return null
  } catch {
    return null
  }
}

export async function listDir(abs, rel, { forGuest = false } = {}) {
  const dirents = await fs.promises.readdir(abs, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    const entryRel = joinRel(rel, dirent.name)
    const hidden = isHiddenFromGuest(entryRel)
    if (forGuest && hidden) continue
    const info = await entryInfo(abs, dirent)
    if (!info) continue
    entries.push(forGuest ? info : { ...info, hiddenFromGuest: hidden })
  }
  return entries
}

export async function statSafe(abs) {
  try {
    return await fs.promises.lstat(abs)
  } catch {
    return null
  }
}

export async function assertDir(abs) {
  const stat = await statSafe(abs)
  if (!stat || !stat.isDirectory()) {
    const err = new Error("目录不存在")
    err.status = 404
    throw err
  }
}

export async function assertExists(abs) {
  const stat = await statSafe(abs)
  if (!stat || stat.isSymbolicLink()) {
    const err = new Error("文件或目录不存在")
    err.status = 404
    throw err
  }
  return stat
}

export async function uniqueName(dirAbs, name) {
  const exists = async (candidate) => (await statSafe(path.join(dirAbs, candidate))) !== null
  if (!(await exists(name))) return name
  const ext = path.extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base} (${i})${ext}`
    if (!(await exists(candidate))) return candidate
  }
  throw new Error("无法生成不重复的名称")
}

export async function dirStats(abs, { maxEntries = 200000 } = {}) {
  let files = 0
  let dirs = 0
  let bytes = 0
  let partial = false
  const stack = [abs]
  while (stack.length) {
    if (files + dirs > maxEntries) {
      partial = true
      break
    }
    const current = stack.pop()
    let dirents = []
    try {
      dirents = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const child = path.join(current, dirent.name)
      try {
        const stat = await fs.promises.lstat(child)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          dirs += 1
          stack.push(child)
        } else if (stat.isFile()) {
          files += 1
          bytes += stat.size
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  return { files, dirs, bytes, partial }
}

export async function copyEntry(srcAbs, destAbs) {
  await fs.promises.cp(srcAbs, destAbs, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: false,
    verbatimSymlinks: true,
  })
}

export async function moveEntry(srcAbs, destAbs) {
  try {
    await fs.promises.rename(srcAbs, destAbs)
  } catch (err) {
    if (err.code === "EXDEV") {
      await copyEntry(srcAbs, destAbs)
      await fs.promises.rm(srcAbs, { recursive: true, force: true })
    } else {
      throw err
    }
  }
}

export async function searchFiles(rootAbs, rootRel, query, { forGuest = false, limit = 200 } = {}) {
  const results = []
  const needle = query.toLowerCase()
  const deadline = Date.now() + 6000
  let visited = 0
  const stack = [{ abs: rootAbs, rel: rootRel }]
  while (stack.length && results.length < limit && visited < 30000 && Date.now() < deadline) {
    const { abs, rel } = stack.pop()
    let dirents = []
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      visited += 1
      const entryRel = joinRel(rel, dirent.name)
      if (forGuest && isHiddenFromGuest(entryRel)) continue
      const info = await entryInfo(abs, dirent)
      if (!info) continue
      if (dirent.name.toLowerCase().includes(needle)) {
        results.push({
          ...info,
          path: entryRel,
          parent: rel,
          ...(forGuest ? {} : { hiddenFromGuest: isHiddenFromGuest(entryRel) }),
        })
        if (results.length >= limit) break
      }
      if (info.type === "dir") stack.push({ abs: path.join(abs, dirent.name), rel: entryRel })
    }
  }
  return results
}
