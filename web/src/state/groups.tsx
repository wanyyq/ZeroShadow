/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { fetchMyGroups, getGroupContext, setGroupContext } from "@/lib/api"
import type { PublicGroup } from "@/lib/types"
import { useAuth } from "@/state/auth"

interface GroupsState {
  groups: PublicGroup[]
  currentId: string
  current: PublicGroup | null
  setCurrent: (id: string) => void
  refresh: () => Promise<void>
}

const STORAGE_KEY = "zs-group-context"
const GroupsContext = createContext<GroupsState | null>(null)

function loadStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "default"
  } catch {
    return "default"
  }
}

export function GroupsProvider({ children }: { children: ReactNode }) {
  const { me, ready } = useAuth()
  const [groups, setGroups] = useState<PublicGroup[]>([])
  const [currentId, setCurrentId] = useState<string>(() => {
    const stored = loadStored()
    setGroupContext(stored)
    return stored
  })

  const refresh = useCallback(async () => {
    if (!ready || me.role === "guest") {
      setGroups([])
      return
    }
    try {
      const data = await fetchMyGroups()
      setGroups(data.groups || [])
    } catch {
      setGroups([])
    }
  }, [ready, me.role])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 若当前所选小组已不存在或不可用（含登出），回退到"默认"
  useEffect(() => {
    if (currentId === "default") return
    const unavailable = me.role === "guest" || (groups.length && !groups.some((g) => g.id === currentId))
    if (unavailable) {
      setCurrentId("default")
      setGroupContext("default")
      try {
        localStorage.setItem(STORAGE_KEY, "default")
      } catch {
        /* ignore */
      }
    }
  }, [groups, currentId, me.role])

  const setCurrent = useCallback((id: string) => {
    const next = id || "default"
    setCurrentId(next)
    setGroupContext(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo<GroupsState>(() => {
    const current = groups.find((g) => g.id === (currentId === "default" ? getGroupContext() : currentId)) || null
    return {
      groups,
      currentId,
      current: currentId === "default" ? null : current,
      setCurrent,
      refresh,
    }
  }, [groups, currentId, setCurrent, refresh])

  return <GroupsContext.Provider value={value}>{children}</GroupsContext.Provider>
}

export function useGroups() {
  const ctx = useContext(GroupsContext)
  if (!ctx) throw new Error("useGroups 必须在 GroupsProvider 内使用")
  return ctx
}
