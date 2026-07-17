import path from "node:path"
import { FILES_DIR } from "./env.js"
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
  const abs = rel ? path.join(FILES_DIR, ...rel.split("/")) : FILES_DIR
  const resolved = path.resolve(abs)
  const root = path.resolve(FILES_DIR)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw badPath()
  return { abs: resolved, rel }
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
