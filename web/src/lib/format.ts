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
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟 ${sec % 60} 秒`
}

const EXT_KIND: Record<string, { icon: string; label: string }> = {
  jpg: { icon: "image", label: "图片" },
  jpeg: { icon: "image", label: "图片" },
  png: { icon: "image", label: "图片" },
  gif: { icon: "image", label: "图片" },
  webp: { icon: "image", label: "图片" },
  bmp: { icon: "image", label: "图片" },
  avif: { icon: "image", label: "图片" },
  svg: { icon: "image", label: "图片" },
  ico: { icon: "image", label: "图片" },
  mp4: { icon: "film", label: "视频" },
  webm: { icon: "film", label: "视频" },
  mkv: { icon: "film", label: "视频" },
  avi: { icon: "film", label: "视频" },
  mov: { icon: "film", label: "视频" },
  mp3: { icon: "music", label: "音频" },
  wav: { icon: "music", label: "音频" },
  flac: { icon: "music", label: "音频" },
  m4a: { icon: "music", label: "音频" },
  ogg: { icon: "music", label: "音频" },
  aac: { icon: "music", label: "音频" },
  zip: { icon: "folder-archive", label: "压缩包" },
  rar: { icon: "folder-archive", label: "压缩包" },
  "7z": { icon: "folder-archive", label: "压缩包" },
  tar: { icon: "folder-archive", label: "压缩包" },
  gz: { icon: "folder-archive", label: "压缩包" },
  pdf: { icon: "file-text", label: "PDF" },
  doc: { icon: "file-text", label: "文档" },
  docx: { icon: "file-text", label: "文档" },
  xls: { icon: "table", label: "表格" },
  xlsx: { icon: "table", label: "表格" },
  csv: { icon: "table", label: "表格" },
  ppt: { icon: "presentation", label: "演示" },
  pptx: { icon: "presentation", label: "演示" },
  txt: { icon: "file-text", label: "文本" },
  md: { icon: "file-text", label: "文本" },
  log: { icon: "file-text", label: "文本" },
  json: { icon: "file-code", label: "代码" },
  js: { icon: "file-code", label: "代码" },
  ts: { icon: "file-code", label: "代码" },
  tsx: { icon: "file-code", label: "代码" },
  jsx: { icon: "file-code", label: "代码" },
  css: { icon: "file-code", label: "代码" },
  html: { icon: "file-code", label: "代码" },
  py: { icon: "file-code", label: "代码" },
  java: { icon: "file-code", label: "代码" },
  c: { icon: "file-code", label: "代码" },
  cpp: { icon: "file-code", label: "代码" },
  sh: { icon: "file-code", label: "代码" },
  yml: { icon: "file-code", label: "代码" },
  yaml: { icon: "file-code", label: "代码" },
  exe: { icon: "app-window", label: "程序" },
  msi: { icon: "app-window", label: "程序" },
  apk: { icon: "app-window", label: "程序" },
  iso: { icon: "disc", label: "镜像" },
}

export function ext(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

export function fileKind(name: string, type: "dir" | "file") {
  if (type === "dir") return { icon: "folder", label: "文件夹" }
  return EXT_KIND[ext(name)] || { icon: "file", label: "文件" }
}

const PREVIEWABLE = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif",
  "mp4", "webm", "mov",
  "mp3", "wav", "ogg", "flac", "m4a", "aac",
  "pdf",
  "txt", "md", "json", "log", "csv", "js", "ts", "css", "py", "yml", "yaml", "xml", "ini", "conf",
])

export function previewType(name: string): "image" | "video" | "audio" | "pdf" | "text" | null {
  const e = ext(name)
  if (!PREVIEWABLE.has(e)) return null
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"].includes(e)) return "image"
  if (["mp4", "webm", "mov"].includes(e)) return "video"
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
