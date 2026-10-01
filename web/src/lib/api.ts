import type {
  OperationStatus,
  AvatarMeta,
  Group,
  TodosResponse,
  MetricsResponse,
  BackupsResponse,
} from "@/lib/types"

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Query = Record<string, string | number | undefined>

// 顶栏所选小组上下文：非默认时随所有请求发送，服务端据此收窄权限与可见范围。
let groupContext = "default"

export function setGroupContext(groupId: string) {
  groupContext = groupId || "default"
}

export function getGroupContext() {
  return groupContext
}

function contextHeaders(): Record<string, string> {
  return groupContext && groupContext !== "default" ? { "X-ZS-Group": groupContext } : {}
}

function buildUrl(path: string, query?: Query) {
  const url = `/api${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

async function request<T>(
  method: string,
  path: string,
  options: { query?: Query; body?: unknown } = {}
): Promise<T> {
  let res: Response
  try {
    res = await fetch(buildUrl(path, options.query), {
      method,
      credentials: "same-origin",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        ...contextHeaders(),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new ApiError(0, "网络连接失败，请检查服务是否在线")
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* non-json response */
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      onPermissionDenied?.()
    }
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: string }).error)
        : `请求失败 (${res.status})`
    throw new ApiError(res.status, message)
  }
  return data as T
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, { query }),
  post: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>("POST", path, { body, query }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
}

let onPermissionDenied: (() => void) | null = null

export function setOnPermissionDenied(cb: (() => void) | null) {
  onPermissionDenied = cb
}

// 原生媒体标签无法携带自定义头，用查询参数携带小组上下文（服务端仍会校验归属）
function groupQuery() {
  return groupContext && groupContext !== "default" ? `&group=${encodeURIComponent(groupContext)}` : ""
}

export function downloadUrl(path: string, inline = false) {
  return `/api/fs/download?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}${groupQuery()}`
}

export function zipUrl(paths: string[]) {
  return `/api/fs/zip?paths=${encodeURIComponent(JSON.stringify(paths))}${groupQuery()}`
}

export function startCompressJob(paths: string[]): Promise<{ jobId: string }> {
  return api.post("/fs/compress", { paths })
}

export function compressJobStatus(jobId: string) {
  return api.get<OperationStatus>("/fs/compress/status", { job: jobId })
}

export function startExtractJob(path: string, dest?: string): Promise<{ jobId: string }> {
  return api.post("/fs/extract", { path, dest })
}

export function extractJobStatus(jobId: string) {
  return api.get<OperationStatus>("/fs/extract/status", { job: jobId })
}

export function startDownloadUrlJob(url: string, dest: string, filename?: string): Promise<{ jobId: string }> {
  return api.post("/fs/download-url", { url, dest, filename })
}

export function downloadUrlJobStatus(jobId: string) {
  return api.get<OperationStatus>("/fs/download-url/status", { job: jobId })
}

export async function triggerDownload(url: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", headers: contextHeaders() })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      onPermissionDenied?.()
    }
    let message = `下载失败 (${res.status})`
    try {
      const data = await res.json()
      if (data && typeof data === "object" && "error" in data) {
        message = String((data as { error: string }).error)
      }
    } catch { /* ignore parse errors */ }
    throw new ApiError(res.status, message)
  }
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objUrl
  const disposition = res.headers.get("Content-Disposition")
  if (disposition) {
    // 优先解析 RFC 5987 的 filename*（UTF-8 编码，支持中文名）
    const star = disposition.match(/filename\*\s*=\s*UTF-8''([^;\n]*)/i)
    if (star && star[1]) {
      try {
        a.download = decodeURIComponent(star[1])
      } catch {
        /* ignore malformed */
      }
    } else {
      const plain = disposition.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;\s]+)/i)
      if (plain) a.download = plain[1] || plain[2] || ""
    }
  }
  document.body.appendChild(a)
  a.click()
  requestAnimationFrame(() => {
    a.remove()
    URL.revokeObjectURL(objUrl)
  })
}

export interface UploadTask {
  promise: Promise<unknown>
  abort: () => void
}

export interface UploadOptions {
  overwrite?: string[]
}

export function uploadFiles(
  destPath: string,
  files: File[],
  onProgress: (loaded: number, total: number) => void,
  options?: UploadOptions
): UploadTask {
  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve, reject) => {
    const form = new FormData()
    for (const file of files) form.append("files", file, file.name)
    let url = `/api/fs/upload?path=${encodeURIComponent(destPath)}`
    if (options?.overwrite?.length) {
      url += `&overwrite=${encodeURIComponent(JSON.stringify(options.overwrite))}`
    }
    xhr.open("POST", url)
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest")
    if (groupContext && groupContext !== "default") xhr.setRequestHeader("X-ZS-Group", groupContext)
    xhr.responseType = "json"
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      const data = xhr.response as { error?: string } | null
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response)
      else reject(new ApiError(xhr.status, data?.error || `上传失败 (${xhr.status})`))
    }
    xhr.onerror = () => reject(new ApiError(0, "网络错误，上传中断"))
    xhr.onabort = () => reject(new ApiError(0, "已取消上传"))
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}

// ------------------------------------------------------------------ 小组 --
export function fetchMyGroups() {
  return api.get<{ groups: { id: string; name: string; color: string; leaders: string[] }[] }>("/auth/groups")
}

export function fetchAdminGroups() {
  return api.get<{
    groups: Group[]
    leaderCaps: string[]
    members: { id: string; username: string; disabled: boolean; createdAt: string }[]
  }>("/admin/groups")
}

export function createGroup(body: Record<string, unknown>) {
  return api.post<{ group: Group }>("/admin/groups", body)
}

export function updateGroup(id: string, body: Record<string, unknown>) {
  return api.patch<{ group: Group }>(`/admin/groups/${encodeURIComponent(id)}`, body)
}

export function deleteGroup(id: string) {
  return api.del<{ ok: boolean }>(`/admin/groups/${encodeURIComponent(id)}`)
}

// 组长自助管理（受 leaderCaps 约束）
export function fetchLeaderGroups() {
  return api.get<{ groups: import("@/lib/types").LeaderGroup[]; allMembers: import("@/lib/types").Member[] }>("/groups")
}

export function addGroupMembers(id: string, ids: string[], action: "add" | "remove" = "add") {
  return api.post<{ group: import("@/lib/types").LeaderGroup }>(`/groups/${encodeURIComponent(id)}/members`, { ids, action })
}

export function patchLeaderGroup(id: string, body: Record<string, unknown>) {
  return api.patch<{ group: import("@/lib/types").LeaderGroup }>(`/groups/${encodeURIComponent(id)}`, body)
}

// ------------------------------------------------------------------ 头像 --
export function fetchAvatarList() {
  return api.get<{ avatars: AvatarMeta[]; enabled: boolean }>("/avatars")
}

export async function fetchAvatarBlob(owner: string): Promise<Blob> {
  const res = await fetch(`/api/avatars/${encodeURIComponent(owner)}`, {
    credentials: "same-origin",
    headers: contextHeaders(),
  })
  if (!res.ok) throw new ApiError(res.status, `头像获取失败 (${res.status})`)
  return res.blob()
}

export async function uploadAvatar(owner: string, blob: Blob): Promise<AvatarMeta> {
  const path = owner === "me" ? "/api/avatars/me" : `/api/avatars/${encodeURIComponent(owner)}`
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "image/webp", ...contextHeaders() },
    body: blob,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) onPermissionDenied?.()
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: string }).error)
        : `头像上传失败 (${res.status})`
    throw new ApiError(res.status, message)
  }
  return data as AvatarMeta
}

export async function deleteAvatar(owner: string): Promise<void> {
  await api.del(`/avatars/${encodeURIComponent(owner)}`)
}

// ------------------------------------------------------------------ Todo --
export function fetchTodos(query?: { status?: string; scope?: string; q?: string }) {
  return api.get<TodosResponse>("/todos", query)
}

export function createTodo(body: Record<string, unknown>) {
  return api.post<{ todo: unknown }>("/todos", body)
}

export function patchTodo(id: string, body: Record<string, unknown>) {
  return api.patch<{ todo: unknown }>(`/todos/${encodeURIComponent(id)}`, body)
}

export function setTodoDone(id: string, done: boolean) {
  return api.post<{ todo: unknown }>(`/todos/${encodeURIComponent(id)}/done`, { done })
}

export function deleteTodo(id: string) {
  return api.del<{ ok: boolean }>(`/todos/${encodeURIComponent(id)}`)
}

// ------------------------------------------------------ 管理：指标/备份 --
export function fetchMetrics() {
  return api.get<MetricsResponse>("/admin/metrics")
}

export function fetchBackups() {
  return api.get<{ backups: BackupsResponse }>("/admin/backups")
}

export function createBackup() {
  return api.post<{ ok: boolean; count: number; backups: BackupsResponse }>("/admin/backups")
}

export function restoreBackup(name: string, id: string) {
  return api.post<{ ok: boolean }>("/admin/backups/restore", { name, id })
}
