export type ConflictAction = "rename" | "skip" | "overwrite" | "merge"

export interface ConflictItem {
  name: string
  action: ConflictAction
  resolvedName?: string
}

/**
 * 「用户取消了冲突处理」的专用信号。
 *
 * 不能用空数组代替：调用方一律把 `[]` 理解为「没有冲突，照原样执行」，
 * 于是点「取消」/按 Esc/点遮罩关闭反而会把操作原封不动发出去 ——
 * 剪切模式下文件是真的会被移走的。
 */
export const CONFLICT_CANCELLED = Symbol("conflict-cancelled")

export type ConflictResolution = ConflictItem[] | typeof CONFLICT_CANCELLED

// 大小写是否敏感，必须与**服务端实际所在的操作系统**一致：
// 服务端 safety.js 是按 process.platform 判定的（win32 / darwin 不区分大小写）。
// 这里原先用 navigator.userAgent 猜，于是「Windows 上的浏览器访问 Linux 服务端」
// 必然分叉 —— 要么把 A.txt 误判成与 a.txt 冲突，要么静默生成 A (1).txt。
//
// 现在以服务端返回的 caseInsensitive 为准（见 server 的 /api/auth/me）。
// 在身份拿到之前先用一个保守的初始值，拿到后由 auth 状态调用
// setCaseInsensitive() 覆盖。
let CASE_INSENSITIVE =
  typeof navigator !== "undefined" && /Windows|Mac OS X|Macintosh/i.test(navigator.userAgent || "")

/** 由服务端告知"文件系统是否不区分大小写"；传 undefined/null 则忽略（保留旧值） */
export function setCaseInsensitive(value: boolean | undefined | null) {
  if (typeof value === "boolean") CASE_INSENSITIVE = value
}

/** 供测试与调试查看当前生效的判定 */
export function isCaseInsensitive() {
  return CASE_INSENSITIVE
}

function norm(name: string): string {
  return CASE_INSENSITIVE ? name.toLowerCase() : name
}

export function resolveDuplicateName(name: string, existingNames: Set<string>): string {
  const taken = new Set([...existingNames].map(norm))
  const dot = name.lastIndexOf(".")
  const hasExt = dot > 0
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ""
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base} (${i})${ext}`
    if (!taken.has(norm(candidate))) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

export function detectConflicts(names: string[], existing: Set<string>): string[] {
  const taken = new Set([...existing].map(norm))
  return names.filter((n) => taken.has(norm(n)))
}
