/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { toast } from "sonner"
import { api, setOnPermissionDenied } from "@/lib/api"
import type { Me } from "@/lib/types"

const GUEST: Me = {
  role: "guest",
  username: null,
  perms: {
    fileWrite: false,
    upload: false,
    uploadFolders: false,
    download: true,
    copy: false,
    move: false,
    rename: false,
    delete: false,
    mkdir: false,
    manageGuestVisibility: false,
    details: false,
    zip: true,
    htmlPreview: false,
    editFiles: false,
    compressZip: false,
    extractZip: false,
    changePassword: false,
  },
  uploadLimitMB: 0,
}

interface AuthState {
  me: Me
  ready: boolean
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<Me>
  logout: () => Promise<void>
}

const AuthContext = React.createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = React.useState<Me>(GUEST)
  const [ready, setReady] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      setMe(await api.get<Me>("/auth/me"))
    } catch {
      setMe(GUEST)
    }
  }, [])

  React.useEffect(() => {
    refresh().finally(() => setReady(true))
  }, [refresh])

  React.useEffect(() => {
    setOnPermissionDenied(() => {
      toast.warning("此功能您没权限")
      refresh()
    })
    return () => setOnPermissionDenied(null)
  }, [refresh])

  React.useEffect(() => {
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  const login = React.useCallback(
    async (username: string, password: string) => {
      await api.post("/auth/login", { username, password })
      const next = await api.get<Me>("/auth/me")
      setMe(next)
      return next
    },
    []
  )

  const logout = React.useCallback(async () => {
    try {
      await api.post("/auth/logout")
    } catch {
      /* 即使失败也重置本地状态 */
    }
    await refresh()
  }, [refresh])

  const value = React.useMemo(
    () => ({ me, ready, refresh, login, logout }),
    [me, ready, refresh, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
