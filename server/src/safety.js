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
  // SOFT_DIRS 是无原型对象（见 env.js），因此这里不会命中 constructor/toString
  // 之类的继承属性；再做一次类型校验作为双保险
  const softDirAbs = typeof SOFT_DIRS[first] === "string" ? SOFT_DIRS[first] : null
  if (softDirAbs) {
    const base = path.resolve(softDirAbs)
    const sub = rel.slice(first.length)
    const subRel = sub.startsWith("/") ? sub.slice(1) : sub
    const resolved = subRel ? path.resolve(base, subRel) : base
    // 必须按路径分隔符判断边界，否则 "D:\soft" 会误认为 "D:\soft-secret" 在内部
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw badPath()
    return { abs: resolved, rel, isSoft: true, softName: first, softBase: base }
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

/** 路径比较：Windows/macOS 下不区分大小写，与访客可见性判定保持一致 */
export function samePath(a, b) {
  return comparable(String(a)) === comparable(String(b))
}

/** target 是否等于 base 或位于 base 之内（用于清理被删除/移动的隐藏项） */
export function isSameOrInside(target, base) {
  const t = comparable(String(target))
  const b = comparable(String(base))
  return t === b || t.startsWith(b + "/")
}

export function isHiddenFromGuest(rel) {
  const hidden = getConfig().guestHiddenPaths
  if (!hidden.length) return false
  return hidden.some((h) => isSameOrInside(rel, h))
}

export function isExactHidden(rel) {
  return getConfig().guestHiddenPaths.some((h) => samePath(h, rel))
}

export function guestBlocked(req, rel) {
  return req.auth.role === "guest" && isHiddenFromGuest(rel)
}

export function joinRel(rel, name) {
  return rel ? `${rel}/${name}` : name
}
