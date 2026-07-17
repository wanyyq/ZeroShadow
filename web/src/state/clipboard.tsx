/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

export interface ClipboardItem {
  path: string
  name: string
  type: "dir" | "file"
}

interface ClipboardState {
  mode: "copy" | "cut" | null
  items: ClipboardItem[]
  set: (mode: "copy" | "cut", items: ClipboardItem[]) => void
  clear: () => void
}

const Ctx = React.createContext<ClipboardState | undefined>(undefined)

export function ClipboardProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = React.useState<"copy" | "cut" | null>(null)
  const [items, setItems] = React.useState<ClipboardItem[]>([])

  const set = React.useCallback((m: "copy" | "cut", list: ClipboardItem[]) => {
    setMode(m)
    setItems(list)
  }, [])

  const clear = React.useCallback(() => {
    setMode(null)
    setItems([])
  }, [])

  const value = React.useMemo(() => ({ mode, items, set, clear }), [mode, items, set, clear])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useClipboard() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useClipboard must be used within ClipboardProvider")
  return ctx
}
