export type Role = "superadmin" | "member" | "guest"

export interface Perms {
  fileWrite: boolean
  upload: boolean
  uploadFolders: boolean
  downloadFile: boolean
  downloadFolder: boolean
  preview: boolean
  copy: boolean
  move: boolean
  rename: boolean
  delete: boolean
  mkdir: boolean
  manageGuestVisibility: boolean
  details: boolean
  htmlPreview: boolean
  editFiles: boolean
  compressZip: boolean
  extractZip: boolean
  downloadUrl: boolean
  changePassword: boolean
}

export interface PublicGroup {
  id: string
  name: string
  color: string
  leaders: string[]
}

export interface Me {
  role: Role
  username: string | null
  userId: string | null
  perms: Perms
  uploadLimitMB: number
  groupId: string
  group: PublicGroup | null
}

export interface Group {
  id: string
  name: string
  color: string
  members: string[]
  leaders: string[]
  perms: Record<string, boolean>
  whitelist: string[]
  blacklist: string[]
  leaderCaps: {
    viewMembers: boolean
    manageTodo: boolean
    editMemberAvatar: boolean
    manageMembers: boolean
  }
  createdAt: string
  updatedAt: string
}

export type LeaderCapKey = "viewMembers" | "manageTodo" | "editMemberAvatar" | "manageMembers"

export interface Todo {
  id: string
  title: string
  note: string
  priority: "low" | "normal" | "high"
  dueAt: string | null
  scope: "all" | "group" | "member"
  groupId: string
  memberId: string
  done: boolean
  doneAt: string | null
  doneBy: string | null
  allowAssigneeEdit: boolean
  createdBy: string
  createdById: string | null
  createdByRole: string
  createdAt: string
  updatedAt: string
  groupName: string
  memberName: string
  canEdit: boolean
  canComplete: boolean
  canManage: boolean
}

export interface TodosResponse {
  todos: Todo[]
  enabled: boolean
  canCreateAll: boolean
  leaderGroups: { id: string; name: string }[]
  members: { id: string; username: string }[]
}

export interface LeaderGroup {
  id: string
  name: string
  color: string
  leaderCaps: Group["leaderCaps"]
  isLeader: boolean
  canViewMembers: boolean
  canManageMembers: boolean
  canManageTodo: boolean
  whitelist: string[]
  blacklist: string[]
  memberCount: number
  members: Member[]
}

export interface AvatarMeta {
  owner: string
  md5: string
  size: number
  updatedAt: number
}

export interface ShortcutInfo {
  targetType: "file" | "path" | "soft_file" | "soft_path"
  targetUrl: string
  logo: string | null
  displayName?: string
}

export interface Entry {
  name: string
  type: "dir" | "file" | "shortcut"
  size: number
  mtime: number
  hiddenFromGuest?: boolean
  softReadOnly?: boolean
  shortcut?: ShortcutInfo
}

export interface SearchResult {
  name: string
  type: "dir" | "file"
  size: number
  mtime: number
  softReadOnly?: boolean
  path: string
  parent: string
}

export interface EntryStat {
  name: string
  path: string
  type: "dir" | "file"
  size: number
  mtime: number
  created: number
  hiddenFromGuest: boolean
  files?: number
  dirs?: number
  partial?: boolean
}

export interface Member {
  id: string
  username: string
  disabled: boolean
  createdAt: string
}

export interface AdminConfig {
  superUploadLimitMB: number
  memberUploadLimitMB: number
  zipMaxFiles: number
  zipMaxSingleMB: number
  zipMaxTotalMB: number
  extractMaxZipMB: number
  extractMaxTotalMB: number
  downloadUrlMaxMB: number
  rateLimitEnabled: boolean
  rateLimitPerMin: number
  softDirAllowCopyOut: boolean
  jobStatusOwnerOnly: boolean
  downloadUrlAllowPrivate: boolean
  csrfOriginCheck: boolean
  avatarEnabled: boolean
  avatarMaxKB: number
  todoEnabled: boolean
  backupEnabled: boolean
  backupKeep: number
  logRetentionDays: number
  metricsRetentionDays: number
  metricsMemMinutes: number
  requestMetricsEnabled: boolean
  slowRequestMs: number
  defaultVisibility: { whitelist: string[]; blacklist: string[] }
  memberPerms: {
    fileWrite: boolean
    browse: boolean
    upload: boolean
    uploadFolders: boolean
    downloadFile: boolean
    downloadFolder: boolean
    preview: boolean
    copy: boolean
    move: boolean
    rename: boolean
    delete: boolean
    mkdir: boolean
    manageGuestVisibility: boolean
    htmlPreview: boolean
    editFiles: boolean
    compressZip: boolean
    extractZip: boolean
    downloadUrl: boolean
    changePassword: boolean
  }
  guestPerms: {
    browse: boolean
    downloadFile: boolean
    downloadFolder: boolean
    preview: boolean
    htmlPreview: boolean
    editFiles: boolean
    compressZip: boolean
    extractZip: boolean
  }
  guestHiddenPaths: string[]
  tunnel: TunnelConfig
}

export interface TunnelConfig {
  enabled: boolean
  mode: "serveo" | "localhostrun" | "pinggy" | "custom"
  customHost: string
}

export interface TunnelStatus {
  running: boolean
  url: string | null
  output: string[]
  startedAt: number | null
  restarts: number
  lastExit: { code: number | null; signal: string | null; at: number } | null
}

export interface ServerStatus {
  startedAt: number
  uptimeSec: number
  node: string
  platform: string
  hostname: string
  port: number
  host: string
  trustProxy: boolean | number | string | string[]
  lan: string[]
  memory: { rss: number; heapUsed: number; systemFree: number; systemTotal: number }
  storage: { files: number; dirs: number; bytes: number; partial: boolean; root: string }
  disk: { free: number; total: number } | null
  tunnel: TunnelStatus
}

export interface LogRow {
  t: string
  lvl: "info" | "warn" | "error"
  ev: string
  msg: string
  user: string | null
  role: string | null
  ip: string | null
  audit?: boolean
}

export interface LogStats {
  total: number
  byLevel: Record<string, number>
  topEvents: { event: string; count: number }[]
  byDay: Record<string, number>
  users: Record<string, number>
}

export interface MetricsSample {
  t: number
  cpu: number
  memUsedPct: number
  rssMB: number
  heapUsedMB: number
  freeMB: number
  totalMB: number
  diskFreeMB: number | null
  diskTotalMB: number | null
  files: number
  dirs: number
  bytes: number
}

export interface MetricsResponse {
  mem: MetricsSample[]
  latest: MetricsSample | null
  requests: {
    qps: number
    lastMinute: { total: number; s2: number; s3: number; s4: number; s5: number; slow: number }
    series: { t: number; total: number; s4: number; s5: number; slow: number }[]
    slow: { method: string; path: string; status: number; ms: number; at: string }[]
    totals: { requests: number; errors: number }
  }
  config: { memMinutes: number; sampleMs: number }
}

export interface BackupEntry {
  id: string
  size: number
  mtime: number
}

export type BackupsResponse = Record<string, BackupEntry[]>

export interface UploadResult {
  results: { name: string; ok: boolean; savedAs?: string; error?: string }[]
  limitMB: number
}

export type OpType = "compress" | "extract" | "download"

export interface OperationStatus {
  id: string
  state: "running" | "done" | "error" | "gone"
  type: OpType
  label: string
  percent: number
  processed: number
  total: number
  processedBytes: number
  totalBytes: number
  error: string | null
  count?: number
}
