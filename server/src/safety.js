import path from "node:path"
import fs from "node:fs"
import { FILES_DIR, SOFT_DIRS } from "./env.js"
import { getConfig } from "./config.js"

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin"

export function normRel(input = "") {
  const raw = String(input).replace(/\\/g, "/")
  if (raw.includes("\0")) throw badPath()
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".")
  for (const part of parts) {
    if (part === "..") throw badPath()
  }
  return parts.join("/")
}

function badPath() {
  const err = new Error("非法路径")
  err.status = 400
  return err
}

export function resolveSafe(input = "") {
  const rel = normRel(input)
  if (!rel) return { abs: FILES_DIR, rel: "", isSoft: false }
  return resolveAny(rel)
}

export function resolveAny(rel) {
  const first = rel.split("/")[0]
  const softDirAbs = SOFT_DIRS[first]
  if (softDirAbs) {
    const sub = rel.slice(first.length)
    const subRel = sub.startsWith("/") ? sub.slice(1) : sub
    const resolved = subRel ? path.resolve(softDirAbs, subRel) : softDirAbs
    if (!resolved.startsWith(softDirAbs) && resolved !== softDirAbs) throw badPath()
    return { abs: resolved, rel, isSoft: true, softName: first, softBase: softDirAbs }
  }
  const abs = rel ? path.join(FILES_DIR, ...rel.split("/")) : FILES_DIR
  const resolved = path.resolve(abs)
  const root = path.resolve(FILES_DIR)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw badPath()
  return { abs: resolved, rel, isSoft: false }
}

export function getSoftDirEntries() {
  const entries = []
  for (const [name, absPath] of Object.entries(SOFT_DIRS)) {
    try {
      const stat = fs.statSync(absPath, { throwIfNoEntry: false })
      entries.push({
        name,
        type: "dir",
        size: 0,
        mtime: stat?.mtimeMs ?? 0,
        softReadOnly: true,
        hiddenFromGuest: isHiddenFromGuest(name),
      })
    } catch {
      entries.push({
        name,
        type: "dir",
        size: 0,
        mtime: 0,
        softReadOnly: true,
        hiddenFromGuest: isHiddenFromGuest(name),
      })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
}

export function isSoftPath(rel) {
  if (!rel) return false
  const first = rel.split("/")[0]
  return first in SOFT_DIRS
}

const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

export function validateName(name) {
  if (typeof name !== "string") return "名称无效"
  const trimmed = name.trim()
  if (!trimmed) return "名称不能为空"
  if (trimmed.length > 200) return "名称过长"
  if (trimmed === "." || trimmed === "..") return "名称无效"
  if (INVALID_NAME_CHARS.test(trimmed)) return '名称不能包含 \\ / : * ? " < > | 等字符'
  if (/[. ]$/.test(trimmed)) return "名称不能以空格或点结尾"
  return null
}

export function sanitizeFileName(name) {
  const base = path.basename(String(name || "file")).trim()
  const cleaned = base.replace(INVALID_NAME_CHARS, "_").replace(/[. ]+$/, "")
  return cleaned || "file"
}

function comparable(rel) {
  return CASE_INSENSITIVE ? rel.toLowerCase() : rel
}

export function isHiddenFromGuest(rel) {
  const hidden = getConfig().guestHiddenPaths
  if (!hidden.length) return false
  const target = comparable(rel)
  return hidden.some((h) => {
    const hc = comparable(h)
    return target === hc || target.startsWith(hc + "/")
  })
}

export function isExactHidden(rel) {
  const target = comparable(rel)
  return getConfig().guestHiddenPaths.some((h) => comparable(h) === target)
}

export function guestBlocked(req, rel) {
  return req.auth.role === "guest" && isHiddenFromGuest(rel)
}

export function joinRel(rel, name) {
  return rel ? `${rel}/${name}` : name
}
