import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const isPkg = typeof process.pkg !== "undefined"
const ROOT_DIR = isPkg ? path.dirname(process.execPath) : process.cwd()
const ENV_FILE = path.join(ROOT_DIR, ".env")

function randomPassword() {
  return crypto.randomBytes(12).toString("base64url")
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
    "# 网盘文件根目录（留空则使用 ./data/files）",
    "# FILES_DIR=D:\\ZeroShadowFiles",
    "",
  ].join("\n")
}

let generatedPassword = null

if (!fs.existsSync(ENV_FILE)) {
  generatedPassword = randomPassword()
  fs.writeFileSync(ENV_FILE, envTemplate(generatedPassword), "utf8")
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
  generatedPassword,
}

export const DATA_DIR = path.join(ROOT_DIR, "data")
export const FILES_DIR = process.env.FILES_DIR?.trim()
  ? path.resolve(process.env.FILES_DIR.trim())
  : path.join(DATA_DIR, "files")
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
  return secret
}

export const NOLOG = process.argv.includes("-nolog")

export const JWT_SECRET = loadSecret()
