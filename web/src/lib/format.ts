import { translate } from "@/lib/i18n"

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = ""
  for (const u of units) {
    value /= 1024
    unit = u
    if (value < 1024) break
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

export function formatDate(ms: number): string {
  if (!ms) return "-"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  if (days > 0) return translate("ui.format.uptime_days_hours", { days, hours })
  if (hours > 0) return translate("ui.format.uptime_hours_minutes", { hours, minutes })
  return translate("ui.format.uptime_minutes_seconds", { minutes, seconds: sec % 60 })
}

/**
 * 扩展名 → {图标, 文案键}。
 * 这里存的是**键**而不是译文：模块只在加载时执行一次，若在此处调 translate()，
 * 切换语言后这张表不会刷新。真正取文案在 fileKind() 里做。
 */
const EXT_KIND: Record<string, { icon: string; label: string }> = {
  jpg: { icon: "image", label: "ui.format.kind.image" },
  jpeg: { icon: "image", label: "ui.format.kind.image" },
  png: { icon: "image", label: "ui.format.kind.image" },
  gif: { icon: "image", label: "ui.format.kind.image" },
  webp: { icon: "image", label: "ui.format.kind.image" },
  bmp: { icon: "image", label: "ui.format.kind.image" },
  avif: { icon: "image", label: "ui.format.kind.image" },
  tiff: { icon: "image", label: "ui.format.kind.image" },
  tif: { icon: "image", label: "ui.format.kind.image" },
  heic: { icon: "image", label: "ui.format.kind.image" },
  svg: { icon: "image", label: "ui.format.kind.image" },
  ico: { icon: "image", label: "ui.format.kind.image" },
  mp4: { icon: "film", label: "ui.format.kind.video" },
  webm: { icon: "film", label: "ui.format.kind.video" },
  mkv: { icon: "film", label: "ui.format.kind.video" },
  avi: { icon: "film", label: "ui.format.kind.video" },
  mov: { icon: "film", label: "ui.format.kind.video" },
  wmv: { icon: "film", label: "ui.format.kind.video" },
  flv: { icon: "film", label: "ui.format.kind.video" },
  "3gp": { icon: "film", label: "ui.format.kind.video" },
  m4v: { icon: "film", label: "ui.format.kind.video" },
  mp3: { icon: "music", label: "ui.format.kind.audio" },
  wav: { icon: "music", label: "ui.format.kind.audio" },
  flac: { icon: "music", label: "ui.format.kind.audio" },
  m4a: { icon: "music", label: "ui.format.kind.audio" },
  ogg: { icon: "music", label: "ui.format.kind.audio" },
  aac: { icon: "music", label: "ui.format.kind.audio" },
  zip: { icon: "folder-archive", label: "ui.format.kind.archive" },
  rar: { icon: "folder-archive", label: "ui.format.kind.archive" },
  "7z": { icon: "folder-archive", label: "ui.format.kind.archive" },
  tar: { icon: "folder-archive", label: "ui.format.kind.archive" },
  gz: { icon: "folder-archive", label: "ui.format.kind.archive" },
  pdf: { icon: "file-text", label: "ui.format.kind.pdf" },
  doc: { icon: "file-text", label: "ui.format.kind.document" },
  docx: { icon: "file-text", label: "ui.format.kind.document" },
  xls: { icon: "table", label: "ui.format.kind.spreadsheet" },
  xlsx: { icon: "table", label: "ui.format.kind.spreadsheet" },
  csv: { icon: "table", label: "ui.format.kind.spreadsheet" },
  ppt: { icon: "presentation", label: "ui.format.kind.presentation" },
  pptx: { icon: "presentation", label: "ui.format.kind.presentation" },
  txt: { icon: "file-text", label: "ui.format.kind.text" },
  md: { icon: "file-text", label: "ui.format.kind.text" },
  log: { icon: "file-text", label: "ui.format.kind.text" },
  json: { icon: "file-code", label: "ui.format.kind.code" },
  js: { icon: "file-code", label: "ui.format.kind.code" },
  ts: { icon: "file-code", label: "ui.format.kind.code" },
  tsx: { icon: "file-code", label: "ui.format.kind.code" },
  jsx: { icon: "file-code", label: "ui.format.kind.code" },
  css: { icon: "file-code", label: "ui.format.kind.code" },
  html: { icon: "file-code", label: "ui.format.kind.code" },
  py: { icon: "file-code", label: "ui.format.kind.code" },
  java: { icon: "file-code", label: "ui.format.kind.code" },
  c: { icon: "file-code", label: "ui.format.kind.code" },
  cpp: { icon: "file-code", label: "ui.format.kind.code" },
  sh: { icon: "file-code", label: "ui.format.kind.code" },
  yml: { icon: "file-code", label: "ui.format.kind.code" },
  yaml: { icon: "file-code", label: "ui.format.kind.code" },
  rst: { icon: "file-text", label: "ui.format.kind.document" },
  adoc: { icon: "file-text", label: "ui.format.kind.document" },
  tex: { icon: "file-text", label: "ui.format.kind.document" },
  rtf: { icon: "file-text", label: "ui.format.kind.document" },
  org: { icon: "file-text", label: "ui.format.kind.document" },
  bat: { icon: "file-code", label: "ui.format.kind.script" },
  ps1: { icon: "file-code", label: "ui.format.kind.script" },
  vbs: { icon: "file-code", label: "ui.format.kind.script" },
  lua: { icon: "file-code", label: "ui.format.kind.code" },
  rb: { icon: "file-code", label: "ui.format.kind.code" },
  php: { icon: "file-code", label: "ui.format.kind.code" },
  pl: { icon: "file-code", label: "ui.format.kind.code" },
  sql: { icon: "file-code", label: "ui.format.kind.code" },
  toml: { icon: "file-code", label: "ui.format.kind.config" },
  properties: { icon: "file-code", label: "ui.format.kind.config" },
  graphql: { icon: "file-code", label: "ui.format.kind.code" },
  cmake: { icon: "file-code", label: "ui.format.kind.config" },
  gradle: { icon: "file-code", label: "ui.format.kind.config" },
  ".gitignore": { icon: "file-code", label: "ui.format.kind.config" },
  ".env": { icon: "file-text", label: "ui.format.kind.config" },
  dockerfile: { icon: "file-code", label: "ui.format.kind.config" },
  makefile: { icon: "file-code", label: "ui.format.kind.config" },
  exe: { icon: "app-window", label: "ui.format.kind.app" },
  msi: { icon: "app-window", label: "ui.format.kind.app" },
  apk: { icon: "app-window", label: "ui.format.kind.app" },
  iso: { icon: "disc", label: "ui.format.kind.disc" },
}

export function ext(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : name.toLowerCase()
}

export function fileKind(name: string, type: string, softReadOnly?: boolean, shortcutLogo?: string | null) {
  if (type === "shortcut") {
    return { icon: shortcutLogo || "external-link", label: translate("ui.format.kind.shortcut") }
  }
  if (type === "dir") {
    return {
      icon: softReadOnly ? "folder-lock" : "folder",
      label: softReadOnly ? translate("ui.format.kind.folder_readonly") : translate("ui.common.folder"),
    }
  }
  const hit = EXT_KIND[ext(name)]
  return hit
    ? { icon: hit.icon, label: translate(hit.label) }
    : { icon: "file", label: translate("ui.common.file") }
}

const PREVIEWABLE = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "tiff", "tif", "heic", "ico", "svg",
  "mp4", "webm", "mov", "mkv", "wmv", "flv", "3gp", "m4v",
  "mp3", "wav", "ogg", "flac", "m4a", "aac",
  "pdf",
  // html/htm 必须在这里：browser-page 双击时先判 previewType()，再分流到 /html-preview。
  // 漏了它们会让那条分支变成死代码 —— 有下载权限的人双击 html 会直接开始下载。
  "html", "htm",
  "txt", "md", "json", "log", "csv", "js", "ts", "css", "py", "yml", "yaml", "xml", "ini", "conf",
  "rst", "adoc", "tex", "bat", "ps1", "vbs", "lua", "rb", "php", "pl", "sql",
  "toml", "properties", "graphql", "rtf", "org", "cmake", "gradle",
  "dockerfile", "makefile", ".gitignore", ".env",
])

export function previewType(name: string): "image" | "video" | "audio" | "pdf" | "text" | null {
  const e = ext(name)
  if (!PREVIEWABLE.has(e)) return null
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "tiff", "tif", "heic", "ico", "svg"].includes(e)) return "image"
  if (["mp4", "webm", "mov", "mkv", "wmv", "flv", "3gp", "m4v"].includes(e)) return "video"
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(e)) return "audio"
  if (e === "pdf") return "pdf"
  return "text"
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i > 0 ? path.slice(0, i) : ""
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

let uidCounter = 0
export function uid(): string {
  uidCounter += 1
  return `${Date.now().toString(36)}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`
}
