import { useEffect, useState, useSyncExternalStore } from "react"
import { fetchAvatarBlob, fetchAvatarList } from "@/lib/api"
import type { Me } from "@/lib/types"

// ============================================================================
//  avatar-cache.ts - 头像本地缓存（IndexedDB）
//
//  机制：
//   1. 登录/进入应用时调 syncAvatars()：先取服务端头像列表（仅 owner+md5，
//      极轻量），与 IndexedDB 中缓存的 md5 对比——未变的直接用本地缓存，
//      只有 md5 变动的才下载新头像；服务端已删除的本地缓存一并清理。
//   2. 组件通过 useAvatar(owner) 订阅；缓存同步后自动重新渲染。
//   3. 为控制内存，仅在需要时为头像创建 objectURL，并在更新时回收旧的。
// ============================================================================

const DB_NAME = "zeroshadow-avatars"
const DB_VERSION = 1
const STORE = "avatars"

export const SUPER_OWNER = "_superadmin"

export function ownerForUser(userId: string | null | undefined) {
  return userId ? `u-${userId}` : SUPER_OWNER
}

export function ownerForMe(me: Me | null | undefined) {
  if (!me) return null
  if (me.role === "superadmin") return SUPER_OWNER
  return me.userId ? `u-${me.userId}` : null
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null)
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "owner" })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function tx<T>(fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(STORE, "readwrite")
          const store = t.objectStore(STORE)
          const req = fn(store)
          req.onsuccess = () => resolve(req.result as T)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        } finally {
          db.close()
        }
      })
  )
}

interface CachedAvatar {
  owner: string
  md5: string
  blob: Blob
  updatedAt: number
}

async function idbGet(owner: string): Promise<CachedAvatar | null> {
  return tx<CachedAvatar | undefined>((s) => s.get(owner)).then((v) => v || null)
}

async function idbPut(entry: CachedAvatar): Promise<void> {
  await tx((s) => s.put(entry))
}

async function idbDelete(owner: string): Promise<void> {
  await tx((s) => s.delete(owner))
}

// --------------------------------------------------------------- 运行时状态 --
const objectUrls = new Map<string, { md5: string; url: string }>()
let version = 0
const listeners = new Set<() => void>()
let syncing: Promise<void> | null = null

function emit() {
  version += 1
  for (const l of listeners) l()
}

function releaseAll() {
  for (const { url } of objectUrls.values()) URL.revokeObjectURL(url)
  objectUrls.clear()
}

/** 强制下一次 getAvatarUrl 重新从缓存/服务端取 */
export function invalidateAvatars() {
  releaseAll()
  emit()
}

async function buildUrl(entry: CachedAvatar): Promise<string> {
  const existing = objectUrls.get(entry.owner)
  if (existing && existing.md5 === entry.md5) return existing.url
  if (existing) URL.revokeObjectURL(existing.url)
  const url = URL.createObjectURL(entry.blob)
  objectUrls.set(entry.owner, { md5: entry.md5, url })
  return url
}

/** 按需获取头像 objectURL；无缓存则返回 null（不主动下载，避免请求风暴） */
export async function getAvatarUrl(owner: string): Promise<string | null> {
  const cached = objectUrls.get(owner)
  if (cached) return cached.url
  const entry = await idbGet(owner)
  if (!entry) return null
  return buildUrl(entry)
}

/** 同步头像列表：仅下载 md5 变动的头像，清理已删除的 */
export async function syncAvatars(): Promise<void> {
  if (syncing) return syncing
  syncing = (async () => {
    let list: { owner: string; md5: string }[]
    try {
      const data = await fetchAvatarList()
      list = data.avatars || []
    } catch {
      return
    }
    const wanted = new Map(list.map((a) => [a.owner, a.md5]))
    let changed = false
    for (const meta of list) {
      const cached = await idbGet(meta.owner)
      if (cached && cached.md5 === meta.md5) continue
      try {
        const blob = await fetchAvatarBlob(meta.owner)
        await idbPut({ owner: meta.owner, md5: meta.md5, blob, updatedAt: Date.now() })
        const existing = objectUrls.get(meta.owner)
        if (existing) {
          URL.revokeObjectURL(existing.url)
          objectUrls.delete(meta.owner)
        }
        changed = true
      } catch {
        /* 单个失败不影响整体 */
      }
    }
    // 清理服务端已不存在的缓存
    for (const owner of objectUrls.keys()) {
      if (!wanted.has(owner)) {
        await idbDelete(owner)
        const existing = objectUrls.get(owner)
        if (existing) URL.revokeObjectURL(existing.url)
        objectUrls.delete(owner)
        changed = true
      }
    }
    if (changed) emit()
  })().finally(() => {
    syncing = null
  })
  return syncing
}

/** 删除某头像的本地缓存（服务端删除后调用，避免回退时读到旧缓存） */
export async function forgetAvatar(owner: string) {
  await idbDelete(owner)
  const existing = objectUrls.get(owner)
  if (existing) {
    URL.revokeObjectURL(existing.url)
    objectUrls.delete(owner)
  }
  emit()
}

/** 上传成功后立刻把新头像写入缓存，避免再次下载 */
export async function primeAvatar(owner: string, md5: string, blob: Blob) {
  await idbPut({ owner, md5, blob, updatedAt: Date.now() })
  const existing = objectUrls.get(owner)
  if (existing) URL.revokeObjectURL(existing.url)
  objectUrls.delete(owner)
  emit()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getVersion() {
  return version
}

/** React hook：订阅头像变化；返回当前 objectURL（可能为 null，此时显示占位） */
export function useAvatar(owner: string | null | undefined): string | null {
  const version = useSyncExternalStore(subscribe, getVersion, getVersion)
  const [url, setUrl] = useState<string | null>(() => {
    if (!owner) return null
    return objectUrls.get(owner)?.url ?? null
  })
  useEffect(() => {
    let alive = true
    if (!owner) {
      setUrl(null)
      return
    }
    const immediate = objectUrls.get(owner)?.url ?? null
    if (immediate) setUrl(immediate)
    getAvatarUrl(owner).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [owner, version])
  return url
}
