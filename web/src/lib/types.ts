export type Role = "superadmin" | "member" | "guest"

export interface Perms {
  upload: boolean
  download: boolean
  copy: boolean
  move: boolean
  rename: boolean
  delete: boolean
  mkdir: boolean
  manageGuestVisibility: boolean
  details: boolean
  zip: boolean
}

export interface Me {
  role: Role
  username: string | null
  perms: Perms
  uploadLimitMB: number
}

export interface Entry {
  name: string
  type: "dir" | "file"
  size: number
  mtime: number
  hiddenFromGuest?: boolean
}

export interface SearchResult extends Entry {
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
  memberPerms: {
    upload: boolean
    download: boolean
    copy: boolean
    move: boolean
    rename: boolean
    delete: boolean
    mkdir: boolean
    manageGuestVisibility: boolean
  }
  guestPerms: {
    download: boolean
    zip: boolean
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
}

export interface UploadResult {
  results: { name: string; ok: boolean; savedAs?: string; error?: string }[]
  limitMB: number
}
