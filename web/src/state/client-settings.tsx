/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

export type ViewMode = "list" | "grid"
export type SortBy = "name" | "size" | "mtime"
export type SortDir = "asc" | "desc"
export type Density = "comfortable" | "compact"
export type FontScale = "sm" | "base" | "lg"

export interface ClientSettings {
  /** 文件列表默认视图 */
  view: ViewMode
  sortBy: SortBy
  sortDir: SortDir
  foldersFirst: boolean
  /** 界面密度：紧凑会收紧列表行高与各处的内边距 */
  density: Density
  /** 全局字号：通过 html 的 font-size 缩放（Tailwind 的尺寸都是 rem） */
  fontScale: FontScale
  /** 减少动画：关闭 GSAP 入场与 CSS 过渡 */
  reduceMotion: boolean
  /** 背景噪点纹理 */
  noise: boolean
  /** 桌面侧边栏默认折叠 */
  sidebarCollapsed: boolean
}

const DEFAULTS: ClientSettings = {
  view: "list",
  sortBy: "name",
  sortDir: "asc",
  foldersFirst: true,
  density: "comfortable",
  fontScale: "base",
  reduceMotion: false,
  noise: true,
  sidebarCollapsed: false,
}

const STORAGE_KEY = "zs-client-settings"
/** 侧边栏折叠状态曾经单独存在这个键里，读取时迁移过来，避免升级后偏好丢失 */
const LEGACY_SIDEBAR_KEY = "zs-sidebar-collapsed"

const FONT_SCALES: FontScale[] = ["sm", "base", "lg"]

function load(): ClientSettings {
  const next = { ...DEFAULTS }
  try {
    const legacy = localStorage.getItem(LEGACY_SIDEBAR_KEY)
    if (legacy !== null) next.sidebarCollapsed = legacy === "1"
  } catch {
    /* 存储不可用时只用默认值 */
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return next
    const parsed = JSON.parse(raw) as Partial<ClientSettings>
    return {
      view: parsed.view === "grid" ? "grid" : "list",
      sortBy: ["name", "size", "mtime"].includes(parsed.sortBy as string)
        ? (parsed.sortBy as SortBy)
        : "name",
      sortDir: parsed.sortDir === "desc" ? "desc" : "asc",
      foldersFirst: parsed.foldersFirst !== false,
      density: parsed.density === "compact" ? "compact" : "comfortable",
      fontScale: FONT_SCALES.includes(parsed.fontScale as FontScale)
        ? (parsed.fontScale as FontScale)
        : "base",
      reduceMotion: parsed.reduceMotion === true,
      noise: parsed.noise !== false,
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === "boolean"
          ? parsed.sidebarCollapsed
          : next.sidebarCollapsed,
    }
  } catch {
    return next
  }
}

function persist(settings: ClientSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* 存储不可用时仅保留内存状态 */
  }
}

/**
 * 把外观类偏好同步到 <html> 的 data-* 属性，交给 index.css 里的选择器统一生效。
 * 放在 Provider 里做，任何入口（设置页、顶栏、快捷键）改动偏好都会立刻反映到界面。
 */
function applyToDocument(s: ClientSettings) {
  const el = document.documentElement
  el.dataset.density = s.density
  el.dataset.fontScale = s.fontScale
  el.dataset.noise = s.noise ? "on" : "off"
  el.dataset.reduceMotion = s.reduceMotion ? "1" : "0"
}

interface ClientSettingsState extends ClientSettings {
  update: (partial: Partial<ClientSettings>) => void
  reset: () => void
}

const Ctx = React.createContext<ClientSettingsState | undefined>(undefined)

export function ClientSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<ClientSettings>(load)

  React.useEffect(() => {
    applyToDocument(settings)
  }, [settings])

  const update = React.useCallback((partial: Partial<ClientSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial }
      persist(next)
      return next
    })
  }, [])

  const reset = React.useCallback(() => {
    setSettings(() => {
      persist(DEFAULTS)
      return DEFAULTS
    })
  }, [])

  const value = React.useMemo(
    () => ({ ...settings, update, reset }),
    [settings, update, reset]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useClientSettings() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useClientSettings must be used within ClientSettingsProvider")
  return ctx
}
