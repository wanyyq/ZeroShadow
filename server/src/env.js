import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const isPkg = typeof process.pkg !== "undefined"
const ROOT_DIR = isPkg ? path.dirname(process.execPath) : process.cwd()
const ENV_FILE = path.join(ROOT_DIR, ".env")

function randomPassword() {
  return crypto.randomBytes(12).toString("base64url")
}

/** POSIX 下收紧敏感文件权限（Windows 上无效果，出错一律忽略） */
export function restrictFileMode(file, mode = 0o600) {
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* 平台不支持或文件暂不存在：忽略 */
  }
}

function envTemplate(password) {
  return [
    "# ===== ZeroShadow 服务配置 =====",
    "PORT=12345",
    "HOST=0.0.0.0",
    "",
    "# ===== 超级管理员（唯一，修改密码只能在此处，改后需重启服务）=====",
    "SUPER_ADMIN_USER=admin",
    `SUPER_ADMIN_PASSWORD=${password}`,
    "",
    "# 登录会话有效期（小时）",
    "SESSION_HOURS=72",
    "",
    "# 反向代理 / SSH 隧道场景下取真实客户端 IP（默认关闭，保持直连行为）。",
    "# 只有服务**仅**经可信代理暴露时才开启，例如只通过 SSH 隧道访问：",
    "# TRUST_PROXY=loopback",
    "# 也可填跳数（如 1）或网段（如 10.0.0.0/8）。",
    "# 提醒：开启后 X-Forwarded-For 可被伪造，若服务同时能被直连访问就不要开启。",
    "",
    "# 网盘文件根目录（留空则使用 ./data/files）",
    "# FILES_DIR=D:\\ZeroShadowFiles",
    "",
    "# 外部映射目录（只读虚拟文件夹）JSON 格式：将服务器其他路径映射为网盘根目录只读文件夹",
    '# FILES_SOFT_DIR={"软件文件夹":"./","工作目录":"D:/Program/xxx/xxx"}',
    "",
    "# ===== 链接下载工具（download-url）安全开关 =====",
    "# 默认禁止下载内网 / 回环 / 链路本地地址（防 SSRF）。确有需要再显式放开：",
    "# DOWNLOAD_URL_ALLOW_PRIVATE=1                       放开全部内网地址（谨慎）",
    "# DOWNLOAD_URL_ALLOW_HOSTS=nas.local,192.168.1.10    仅放开指定主机",
    "# DOWNLOAD_URL_INSECURE_TLS=1                        跳过 TLS 证书校验（不推荐）",
    "",
  ].join("\n")
}

let generatedPassword = null

if (!fs.existsSync(ENV_FILE)) {
  generatedPassword = randomPassword()
  fs.writeFileSync(ENV_FILE, envTemplate(generatedPassword), "utf8")
  restrictFileMode(ENV_FILE)
}

try {
  const raw = fs.readFileSync(ENV_FILE, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx < 1) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
} catch {
  /* .env unreadable -> defaults below */
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

// TRUST_PROXY：只有前面确实存在可信代理（例如只经隧道/反代访问）时才应开启。
// 开启后按 X-Forwarded-For 解析真实客户端 IP，否则 IP 限速与日志里的 IP 永远
// 是 127.0.0.1。可取值：true/false、跳数（如 1）、预设名（loopback）、
// 或逗号分隔的网段列表。默认 false，保持旧行为。
function parseTrustProxy(raw) {
  const value = String(raw ?? "").trim()
  if (!value || /^(0|false|no|off)$/i.test(value)) return false
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^\d+$/.test(value)) return Number(value)
  if (/^(loopback|linklocal|uniquelocal)$/i.test(value)) return value.toLowerCase()
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return list.length ? list : true
}

let superPassword = (process.env.SUPER_ADMIN_PASSWORD || "").trim()
if (!superPassword || superPassword === "change-me") {
  generatedPassword = generatedPassword || randomPassword()
  superPassword = generatedPassword
  try {
    let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : envTemplate(superPassword)
    if (/^SUPER_ADMIN_PASSWORD=.*$/m.test(content)) {
      content = content.replace(/^SUPER_ADMIN_PASSWORD=.*$/m, `SUPER_ADMIN_PASSWORD=${superPassword}`)
    } else {
      content += `\nSUPER_ADMIN_PASSWORD=${superPassword}\n`
    }
    fs.writeFileSync(ENV_FILE, content, "utf8")
    restrictFileMode(ENV_FILE)
  } catch {
    /* keep in-memory password for this run */
  }
}

export const env = {
  port: clamp(toInt(process.env.PORT, 12345), 1, 65535),
  host: (process.env.HOST || "0.0.0.0").trim(),
  superUser: (process.env.SUPER_ADMIN_USER || "admin").trim(),
  superPassword,
  sessionHours: clamp(toInt(process.env.SESSION_HOURS, 72), 1, 24 * 365),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  generatedPassword,
}

export const DATA_DIR = path.join(ROOT_DIR, "data")
export const FILES_DIR = process.env.FILES_DIR?.trim()
  ? path.resolve(process.env.FILES_DIR.trim())
  : path.join(DATA_DIR, "files")

let softDirs = Object.create(null)
try {
  const raw = (process.env.FILES_SOFT_DIR || "").trim()
  if (raw) {
    // 路径使用 / 或 \\ 均可（Windows 反斜杠自动转换）
    const parsed = JSON.parse(raw.replace(/\\/g, "/"))
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const next = Object.create(null)
      let valid = true
      for (const [name, target] of Object.entries(parsed)) {
        if (typeof target !== "string") { valid = false; break }
        if (!/^[\w\u4e00-\u9fff\u3400-\u4dbf.-]{1,100}$/.test(name)) { valid = false; break }
        if (name === "." || name === "..") { valid = false; break }
        next[name] = path.resolve(target)
      }
      if (valid) softDirs = next
    }
  }
} catch {
  softDirs = Object.create(null)
}
export const SOFT_DIRS = softDirs
export const SOFT_DIR_NAMES = Object.keys(softDirs)

export const TMP_DIR = path.join(DATA_DIR, "tmp")
export const LOGS_DIR = path.join(DATA_DIR, "logs")
export const WEB_DIST = path.join(ROOT_DIR, "web", "dist")

for (const dir of [DATA_DIR, FILES_DIR, TMP_DIR, LOGS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

const SECRET_FILE = path.join(DATA_DIR, ".jwt-secret")

function loadSecret() {
  try {
    const existing = fs.readFileSync(SECRET_FILE, "utf8").trim()
    if (existing.length >= 64) return existing
  } catch {
    /* generate below */
  }
  const secret = crypto.randomBytes(48).toString("hex")
  fs.writeFileSync(SECRET_FILE, secret, "utf8")
  restrictFileMode(SECRET_FILE)
  return secret
}

export const NOLOG = process.argv.includes("-nolog") || /^(true|1|yes)$/i.test(String(process.env.NOLOG || ""))

export const JWT_SECRET = loadSecret()
