import type {
  OperationStatus,
  AvatarMeta,
  Group,
  LeaderCapKey,
  TodosResponse,
  MetricsResponse,
  BackupsResponse,
  TrashResponse,
  UploadResult,
  FileTextResponse,
} from "@/lib/types"
import { translate } from "@/lib/i18n"

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 保存时发现文件已被他人改动（409 VERSION_CONFLICT）时抛出的错误 */
export class VersionConflictError extends ApiError {
  currentVersion: string | null
  constructor(message: string, currentVersion: string | null) {
    super(409, message)
    this.currentVersion = currentVersion
  }
}

/** 判断某个异常是不是"并发编辑冲突" */
export function isVersionConflict(err: unknown): err is VersionConflictError {
  return err instanceof VersionConflictError
}

/**
 * 从任意抛出物里取出可展示的错误信息。
 *
 * 为什么不能只写 `err.message`：抛出来的不一定是 Error —— 原生 confirm/alert 被
 * 某些扩展改写、或某处 reject 了字符串时，`.message` 是 undefined，界面会显示
 * 空白。这里统一兜底成一句中文，避免"点了确定，什么都没发生也没提示"。
 */
export function getErrorMessage(err: unknown, fallback = translate("ui.common.operation_failed")): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err) return err
  if (err && typeof err === "object" && "message" in err) {
    const message = String((err as { message: unknown }).message || "")
    if (message) return message
  }
  return fallback
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
    throw new ApiError(0, translate("ui.common.network_error"))
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
    const detail = (data && typeof data === "object" ? data : {}) as {
      error?: string
      errorKey?: string
      errorParams?: Record<string, string | number>
      code?: string
      currentVersion?: string | null
    }
    /**
     * 服务端返回的提示优先按 `errorKey` 本地化（见 server/src/http.js 的 httpError）：
     * `error` 始终是中文原文，既做兜底也让 curl / 第三方脚本保持旧行为。
     * 这里用 translate() 而不是 useT()：本模块不是组件，语言状态在 i18n 单例里。
     */
    const message = detail.errorKey
      ? translate(detail.errorKey, detail.errorParams)
      : detail.error
        ? String(detail.error)
        : translate("ui.common.request_failed", { status: res.status })
    // 并发编辑冲突要带上服务端当前版本，前端才能提示"重新加载"
    if (res.status === 409 && detail.code === "VERSION_CONFLICT") {
      throw new VersionConflictError(message, detail.currentVersion ?? null)
    }
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

/**
 * 网格视图缩略图地址（v2.0）。
 *
 * 为什么不是 downloadUrl：原图动辄几 MB，弱网 / 内网穿透下滚动会卡死。
 * 服务端按 `rel + 大小 + mtime + 宽度` 做内容寻址缓存，所以这里可以放心
 * 让浏览器长期缓存（响应带 `max-age`）。`w` 只接受服务端白名单里的档位。
 */
export function thumbUrl(path: string, w = 256) {
  return `/api/fs/thumb?path=${encodeURIComponent(path)}&w=${w}${groupQuery()}`
}

export function zipUrl(paths: string[]) {
  return `/api/fs/zip?paths=${encodeURIComponent(JSON.stringify(paths))}${groupQuery()}`
}

/**
 * 在线编辑：按服务端识别出的编码读取文本。
 * 不传 encoding 就是「自动识别」；传了就按指定编码强制解码（用户手动改编码时用）。
 */
export function fetchFileText(path: string, encoding?: string) {
  return api.get<FileTextResponse>("/fs/file", encoding ? { path, encoding } : { path })
}

/**
 * 在线编辑：保存。encoding/eol 决定写回磁盘的字节，服务端会拒绝目标编码表示不了的字符。
 *
 * `baseVersion` 必须是读取时服务端给的版本串。服务端比对不一致会返回 409
 * （`code: "VERSION_CONFLICT"`），不会覆盖别人在你打开之后保存的改动。
 */
export function saveFileText(body: {
  path: string
  content: string
  encoding: string
  eol: string
  baseVersion?: string
}) {
  return api.post<{ ok: boolean; bytes: number; encoding: string; eol: string }>("/fs/save-file", body)
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
    let message = translate("ui.api.download_failed", { status: res.status })
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
      const data = xhr.response as
        | { error?: string; results?: UploadResult["results"]; limitMB?: number }
        | null
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response)
        return
      }
      // 413 的响应体是 { results, limitMB }，没有 error 字段。原样只报「上传失败 (413)」
      // 会把「超出大小限制 (512MB)」这个真正有用的原因丢掉。
      const detail = data?.results?.find((r) => !r.ok && r.error)?.error
      reject(
        new ApiError(
          xhr.status,
          data?.error || detail || translate("ui.api.upload_failed", { status: xhr.status })
        )
      )
    }
    xhr.onerror = () => reject(new ApiError(0, translate("ui.api.upload_network_error")))
    xhr.onabort = () => reject(new ApiError(0, translate("ui.api.upload_cancelled")))
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
    // 服务端的 LEADER_CAPS 清单，给界面渲染用。用真实联合类型而不是 string[]，
    // 免得把任意字符串当能力键传回去（服务端会静默忽略未知键）。
    leaderCaps: LeaderCapKey[]
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
  if (!res.ok) throw new ApiError(res.status, translate("ui.api.avatar_fetch_failed", { status: res.status }))
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
        : translate("ui.api.avatar_upload_failed", { status: res.status })
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

// ------------------------------------------------------------- 回收站 --
export function fetchTrash() {
  return api.get<TrashResponse>("/admin/trash")
}

/** 还原到原路径（或 dest 指定的位置）。目标同名且 overwrite=false 时抛 409。 */
export function restoreTrash(id: string, dest?: string, overwrite = false) {
  return api.post<{ ok: boolean; restored: string }>("/admin/trash/restore", { id, dest, overwrite })
}

export function purgeTrash(id: string) {
  return api.post<{ ok: boolean }>("/admin/trash/purge", { id })
}

export function emptyTrash() {
  return api.post<{ ok: boolean; removed: number }>("/admin/trash/empty")
}

/** 日志导出的下载直链（GET，无需请求头） */
export function logsExportUrl(opts: { format: "jsonl" | "csv"; days?: number; auditOnly?: boolean; level?: string; q?: string }) {
  const params = new URLSearchParams()
  params.set("format", opts.format)
  params.set("days", String(opts.days ?? 5))
  if (opts.auditOnly) params.set("audit", "1")
  if (opts.level) params.set("level", opts.level)
  if (opts.q) params.set("q", opts.q)
  return `/api/admin/logs/export?${params.toString()}`
}

// ------------------------------------------------------------------ 新建 --
/**
 * 新建空文件（v1.2.1）。只创建空文件；默认在已存在同名时返回 409。
 * `unique = true` 时由服务端自动改名（`新建文本文档 (1).txt`），用于"新建文本文档"这类
 * 反复点击也不该报错的场景。`path` 是所在目录（相对网盘根，根目录传 ""）。
 */
export function createEmptyFile(path: string, name: string, content = "", unique = false) {
  return api.post<{ name: string; path: string }>("/fs/create-file", { path, name, content, unique })
}

// ------------------------------------------------------------------ 分享 --

export interface ShareExpiryOption {
  /** i18n 键后缀：`ui.share.expire.<key>` */
  key: string
  seconds: number
}

export interface ShareOptions {
  enabled: boolean
  publicAccess: boolean
  expiry: ShareExpiryOption[]
  password: { min: number; max: number }
}

export interface SharePrecheck {
  path: string
  name: string
  isFolder: boolean
  size: number
  files: number
  /** 对访客不可见 → 必须设密码 */
  guestHidden: boolean
  needPassword: boolean
  softReadOnly: boolean
}

export interface ShareRow {
  id: string
  token: string
  name: string
  path: string
  isFolder: boolean
  createdAt: number
  expiresAt: number
  expired: boolean
  requirePassword: boolean
  downloads: number
  lastAccessAt: number | null
  url: string
}

export interface AdminShareRow extends ShareRow {
  owner: string
  ownerRole: string
}

export interface AdminSharesResponse {
  shares: AdminShareRow[]
  total: number
  active: number
  expired: number
  enabled: boolean
  publicAccess: boolean
}

export function fetchShareOptions() {
  return api.get<ShareOptions>("/shares/options")
}

export function precheckShare(path: string) {
  return api.get<SharePrecheck>("/shares/precheck", { path })
}

export function createShare(body: { path: string; expireSeconds: number; password?: string }) {
  return api.post<ShareRow>("/shares", body)
}

export function fetchMyShares() {
  return api.get<{ shares: ShareRow[]; publicAccess: boolean }>("/shares")
}

export function deleteShare(id: string) {
  return api.del<{ ok: boolean }>(`/shares/${encodeURIComponent(id)}`)
}

export function fetchAllShares(query?: { q?: string; status?: string }) {
  return api.get<AdminSharesResponse>("/admin/shares", query)
}

export function adminDeleteShare(id: string) {
  return api.del<{ ok: boolean }>(`/admin/shares/${encodeURIComponent(id)}`)
}

// ---------------------------------------------------------- 公开分享访问 --
/**
 * 公开分享页用的一组请求。
 *
 * 刻意**不走** `request()`：那个函数在 401/403 时会触发 onPermissionDenied
 * （把当前会话当成失效、跳登录），而分享页的 403 是"需要密码"，属于正常分支。
 */
async function publicShareRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/share${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, translate("ui.common.network_error"))
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const detail = (data && typeof data === "object" ? data : {}) as {
      error?: string
      errorKey?: string
      errorParams?: Record<string, string | number>
      code?: string
    }
    const message = detail.errorKey
      ? translate(detail.errorKey, detail.errorParams)
      : detail.error || translate("ui.common.request_failed", { status: res.status })
    const err = new ApiError(res.status, message) as ApiError & { code?: string }
    err.code = detail.code
    throw err
  }
  return data as T
}

export interface PublicShareMeta {
  token: string
  name: string
  isFolder: boolean
  exists: boolean
  size: number
  files: number
  dirs: number
  partial: boolean
  createdAt: number
  expiresAt: number
  expired: boolean
  requirePassword: boolean
  unlocked: boolean
  ownerRole: string
  downloads: number
  publicAccess: boolean
  mode: "public" | "login"
}

export interface PublicShareEntry {
  name: string
  type: "file" | "dir"
  size: number
  mtime: number
}

export function fetchPublicShare(token: string) {
  return publicShareRequest<PublicShareMeta>("GET", `/${encodeURIComponent(token)}`)
}

export function verifySharePassword(token: string, password: string) {
  return publicShareRequest<{ ok: boolean; ticket: string | null; expiresAt: number }>(
    "POST",
    `/${encodeURIComponent(token)}/verify`,
    { password }
  )
}

export function fetchPublicShareList(token: string, path: string, ticket: string) {
  const params = new URLSearchParams()
  if (path) params.set("path", path)
  if (ticket) params.set("t", ticket)
  const qs = params.toString()
  return publicShareRequest<{ path: string; entries: PublicShareEntry[] }>(
    "GET",
    `/${encodeURIComponent(token)}/list${qs ? `?${qs}` : ""}`
  )
}

/** 分享下载直链（票据走查询参数，<a download> 也能带） */
export function shareDownloadUrl(token: string, path: string, ticket: string, inline = false) {
  const params = new URLSearchParams()
  if (path) params.set("path", path)
  if (ticket) params.set("t", ticket)
  if (inline) params.set("inline", "1")
  return `/api/share/${encodeURIComponent(token)}/download?${params.toString()}`
}

