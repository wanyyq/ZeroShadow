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

// Windows / macOS 的文件系统不区分大小写，服务端 safety.js 也用同一规则判定，
// 因此冲突检测与重名生成都必须忽略大小写，否则会把 A.txt 静默存成 A (1).txt。
const CASE_INSENSITIVE =
  typeof navigator !== "undefined" && /Windows|Mac OS X|Macintosh/i.test(navigator.userAgent || "")

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
