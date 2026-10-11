/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { toast } from "sonner"
import { api, setOnPermissionDenied } from "@/lib/api"
import { setCaseInsensitive } from "@/lib/conflict"
import { useT } from "@/lib/i18n"
import type { Me } from "@/lib/types"

const GUEST: Me = {
  role: "guest",
  username: null,
  userId: null,
  groupId: "default",
  group: null,
  perms: {
    fileWrite: false,
    upload: false,
    uploadFolders: false,
    downloadFile: true,
    downloadFolder: true,
    preview: true,
    copy: false,
    move: false,
    rename: false,
    delete: false,
    mkdir: false,
    manageGuestVisibility: false,
    details: false,
    htmlPreview: false,
    editFiles: false,
    compressZip: false,
    extractZip: false,
    downloadUrl: false,
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
  const t = useT()
  const [me, setMe] = React.useState<Me>(GUEST)
  const [ready, setReady] = React.useState(false)

  /** 把服务端告知的"文件系统是否区分大小写"同步给冲突检测模块 */
  const applyMe = React.useCallback((next: Me) => {
    setCaseInsensitive(next.caseInsensitive)
    setMe(next)
  }, [])

  const refresh = React.useCallback(async () => {
    try {
      applyMe(await api.get<Me>("/auth/me"))
    } catch {
      setMe(GUEST)
    }
  }, [applyMe])

  React.useEffect(() => {
    refresh().finally(() => setReady(true))
  }, [refresh])

  React.useEffect(() => {
    setOnPermissionDenied(() => {
      toast.warning(t("ui.common.no_permission"))
      refresh()
    })
    return () => setOnPermissionDenied(null)
  }, [refresh, t])

  React.useEffect(() => {
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  const login = React.useCallback(
    async (username: string, password: string) => {
      await api.post("/auth/login", { username, password })
      const next = await api.get<Me>("/auth/me")
      applyMe(next)
      return next
    },
    [applyMe]
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
