export type Role = "superadmin" | "member" | "guest"

export interface Perms {
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
  /**
   * 服务端所在文件系统是否不区分大小写（win32 / darwin 为 true）。
   * 前端的同名冲突检测必须用它，不能用浏览器 UA 猜——两者可能不在同一台机器上。
   */
  caseInsensitive?: boolean
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

/** 在线编辑：读取文本文件的结果（编码与换行风格由服务端识别） */
export interface FileTextResponse {
  path: string
  name: string
  size: number
  mtime: number
  /**
   * 内容版本串（`mtime-size-内容哈希`）。保存时必须原样带回：
   * 服务端比对不一致会返回 409，从而避免覆盖别人在你打开之后的改动。
   */
  baseVersion: string
  /** 识别出的编码 id，见服务端 EDITOR_ENCODINGS */
  encoding: string
  /** false 表示编码是猜的，界面应提示「乱码可手动切换编码」 */
  encodingConfident: boolean
  eol: "crlf" | "lf" | "cr"
  /** 换行已统一成 \n（textarea 只认 \n） */
  content: string
  softReadOnly: boolean
  encodings: { id: string; label: string; bom: string }[]
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
  /**
   * 完整路径（相对网盘根）。普通目录列表里不需要，按「当前目录 + name」推导即可；
   * 搜索结果来自不同目录，必须带上它，否则右键 / 下载 / 重命名都会作用到错误路径。
   */
  fullPath?: string
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

/**
 * 服务端元数据里的一行「字段名 / 值」。
 *
 * 键的用法（服务端不持有字典，只多带一个键，见 fileinfo.js）：
 * - `key`     字段名的命名键，前端 `t(key)` 查不到译文就回落到 `label`；
 * - `label`   字段名的**中文原文**兜底，保证任何语言下都不会显示成 `meta.exif.make`；
 * - `value`   值的文本，**不含单位**；
 * - `unitKey` 可选，单位文案的键：前端按 `${value} ${t(unitKey)}` 拼接；
 * - `valueKey` / `valueParams` 可选，值本身是服务端枚举文案时（如方向「正常」、
 *   时长「3:05（185 秒）」）用它查字典，查不到同样回落到 `value`。
 */
export interface DetailPair {
  key: string
  label: string
  value: string
  unitKey?: string
  valueKey?: string
  valueParams?: Record<string, string | number>
}

/** /fs/details：需要读文件才能拿到的扩展元数据（签名 / 哈希 / EXIF / 作者 …） */
export interface EntryDetails {
  path: string
  size: number
  softReadOnly: boolean
  magic: {
    /** 识别结果的中文原文（兜底） */
    label: string
    /** 识别结果的命名键，查不到译文就用 label */
    labelKey?: string
    /** labelKey 的插值参数（如 ISO BMFF 的品牌名、RIFF 的子类型） */
    labelParams?: Record<string, string | number>
    mime: string | null
    kind: string
    signature: string
  } | null
  hashes: { md5: string; sha1: string; sha256: string } | null
  /** 跳过校验和的原因（中文原文兜底） */
  hashNote: string | null
  /** 原因文案的命名键，查不到译文就用 hashNote */
  hashNoteKey?: string | null
  hashNoteParams?: Record<string, string | number> | null
  contentVersion: string | null
  image:
    | {
        width: number
        height: number
        bitDepth?: number
        /** 色彩模式的中文原文（兜底） */
        colorType?: string
        /** 色彩模式的命名键，查不到译文就用 colorType */
        colorTypeKey?: string
        interlaced?: boolean
        megapixels?: number
        aspect?: string
      }
    | null
  /** 顺序由服务端决定，前端只负责显示 */
  exif: DetailPair[] | null
  doc: DetailPair[] | null
  media: DetailPair[] | null
  text: {
    encoding?: string
    /** 编码名本身就是 ASCII（如 UTF-8），不需要翻译 */
    encodingLabel?: string
    encodingConfident?: boolean
    bom?: boolean
    eol?: string
    /** 换行风格的中文原文（兜底） */
    eolLabel?: string
    /** 换行风格的命名键，查不到译文就用 eolLabel */
    eolKey?: string
    lines?: number
    chars?: number
    truncated?: boolean
  } | null
  timestamps: { mtime: number; created: number; atime: number; ctime: number }
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
  /** 删除时是否移入回收站（关闭后删除立即生效） */
  trashEnabled: boolean
  /** 回收站保留天数，超期由服务端维护任务清理 */
  trashRetentionDays: number
  metricsRetentionDays: number
  metricsMemMinutes: number
  requestMetricsEnabled: boolean
  slowRequestMs: number
  /** 分享总开关（v1.2.1）：关掉后既有链接一律失效，也不能新建 */
  shareEnabled: boolean
  /** 允许匿名访问分享链接；false 表示必须先登录网盘账号 */
  sharePublicAccess: boolean
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

/** 回收站条目（由服务端 data/trash/<id>/meta.json 得到） */
export interface TrashItem {
  id: string
  /** 原位置（相对网盘根目录） */
  rel: string
  name: string
  type: "dir" | "file"
  /** 目录为 -1（不做递归统计），文件为字节数 */
  size: number
  deletedAt: string
  deletedBy: string | null
  deletedByRole: string | null
}

export interface TrashResponse {
  items: TrashItem[]
  stats: { files: number; bytes: number; newest: number | null; count: number }
  /** 后台是否启用了回收站 */
  enabled: boolean
  /** 回收站目录是否真的可用（data/ 只读等情况下为 false，此时删除直接生效） */
  available: boolean
  retentionDays: number
}

export interface UploadResult {
  results: { name: string; ok: boolean; savedAs?: string; error?: string }[]
  limitMB: number
  /** 命中「单请求文件数上限」时由服务端置位（前端据此提示并分片上传） */
  truncated?: boolean
  /** 服务端当前的单请求文件数上限，前端分片大小与它保持一致 */
  maxFilesPerRequest?: number
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
