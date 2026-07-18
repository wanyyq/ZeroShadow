/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

export type ViewMode = "list" | "grid"
export type SortBy = "name" | "size" | "mtime"
export type SortDir = "asc" | "desc"

interface ClientSettings {
  view: ViewMode
  sortBy: SortBy
  sortDir: SortDir
  foldersFirst: boolean
}

const DEFAULTS: ClientSettings = {
  view: "list",
  sortBy: "name",
  sortDir: "asc",
  foldersFirst: true,
}

const STORAGE_KEY = "zs-client-settings"

interface ClientSettingsState extends ClientSettings {
  update: (partial: Partial<ClientSettings>) => void
}

const Ctx = React.createContext<ClientSettingsState | undefined>(undefined)

function load(): ClientSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<ClientSettings>
    return {
      view: parsed.view === "grid" ? "grid" : "list",
      sortBy: ["name", "size", "mtime"].includes(parsed.sortBy as string)
        ? (parsed.sortBy as SortBy)
        : "name",
      sortDir: parsed.sortDir === "desc" ? "desc" : "asc",
      foldersFirst: parsed.foldersFirst !== false,
    }
  } catch {
    return DEFAULTS
  }
}

export function ClientSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<ClientSettings>(load)

  const update = React.useCallback((partial: Partial<ClientSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* 存储不可用时仅保留内存状态 */
      }
      return next
    })
  }, [])

  const value = React.useMemo(() => ({ ...settings, update }), [settings, update])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useClientSettings() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useClientSettings must be used within ClientSettingsProvider")
  return ctx
}
