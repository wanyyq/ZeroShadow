export type ConflictAction = "rename" | "skip" | "overwrite" | "merge"

export interface ConflictItem {
  name: string
  action: ConflictAction
  resolvedName?: string
}

export function resolveDuplicateName(name: string, existingNames: Set<string>): string {
  const dot = name.lastIndexOf(".")
  const hasExt = dot > 0
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ""
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base} (${i})${ext}`
    if (!existingNames.has(candidate)) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

export function detectConflicts(names: string[], existing: Set<string>): string[] {
  return names.filter((n) => existing.has(n))
}
