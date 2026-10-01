import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR, restrictFileMode } from "./env.js"
import { avatarMaxBytes } from "./config.js"

// ============================================================================
//  avatars.js - 用户头像（统一 128×128 WebP）
//
//  存储：data/avatars/<owner>.webp
//    - 成员：owner = "u-<userId>"
//    - 超级管理员：owner = "_superadmin"（超管不在 users.json 中）
//
//  校验：服务端手写解析 WebP(VP8X/VP8/VP8L) 头，要求尺寸恰为 128×128，
//  并限制文件体积。不引入任何原生图像库，保证 pkg 多平台打包可用。
//
//  缓存：启动时扫描目录并计算 md5，列表接口只回传 md5；前端用 IndexedDB
//  缓存，md5 未变则不重新下载。
// ============================================================================

export const AVATAR_DIR = path.join(DATA_DIR, "avatars")
export const SUPER_OWNER = "_superadmin"
const OWNER_RE = /^[A-Za-z0-9_-]{1,72}$/
export const AVATAR_SIZE = 128

fs.mkdirSync(AVATAR_DIR, { recursive: true })

/** @type {Map<string, {owner:string, md5:string, size:number, updatedAt:number}>} */
let index = new Map()

export function ownerForUser(userId) {
  return `u-${String(userId)}`
}

export function isValidOwner(owner) {
  return OWNER_RE.test(String(owner || ""))
}

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex")
}

function indexPath(owner) {
  return path.join(AVATAR_DIR, `${owner}.webp`)
}

/** 手写解析 WebP 头，返回 { width, height } 或 null */
export function parseWebpSize(buf) {
  if (!buf || buf.length < 30) return null
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null
  const fourcc = buf.toString("ascii", 12, 16)
  if (fourcc === "VP8X") {
    // 24..26 = canvas width-1 (24bit LE)，27..29 = canvas height-1
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return { width: w, height: h }
  }
  if (fourcc === "VP8 ") {
    // 帧标签 3B + 起始码 3B 后：width(2B LE, 低14位)、height(2B LE, 低14位)
    const w = (buf[26] | (buf[27] << 8)) & 0x3fff
    const h = (buf[28] | (buf[29] << 8)) & 0x3fff
    return { width: w, height: h }
  }
  if (fourcc === "VP8L") {
    if (buf[20] !== 0x2f) return null
    const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24)
    const w = (bits & 0x3fff) + 1
    const h = ((bits >>> 14) & 0x3fff) + 1
    return { width: w, height: h }
  }
  return null
}

function scanOwner(owner) {
  const file = indexPath(owner)
  try {
    const buf = fs.readFileSync(file)
    const size = parseWebpSize(buf)
    if (!size || size.width !== AVATAR_SIZE || size.height !== AVATAR_SIZE) return null
    return { owner, md5: md5(buf), size: buf.length, updatedAt: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

/** 启动时构建索引；发现尺寸/格式不合法的文件直接清理 */
export function initAvatars() {
  index = new Map()
  let removed = 0
  let names = []
  try {
    names = fs.readdirSync(AVATAR_DIR).filter((f) => f.endsWith(".webp"))
  } catch {
    return { count: 0, removed: 0 }
  }
  for (const file of names) {
    const owner = file.slice(0, -".webp".length)
    if (!isValidOwner(owner)) continue
    const entry = scanOwner(owner)
    if (entry) index.set(owner, entry)
    else {
      try {
        fs.rmSync(path.join(AVATAR_DIR, file), { force: true })
        removed += 1
      } catch {
        /* ignore */
      }
    }
  }
  return { count: index.size, removed }
}

export function reloadAvatars() {
  return initAvatars()
}

export function listAvatars() {
  return [...index.values()].sort((a, b) => a.owner.localeCompare(b.owner))
}

export function getAvatar(owner) {
  return index.get(owner) || null
}

export function avatarPath(owner) {
  return indexPath(owner)
}

/**
 * 保存头像：校验体积与尺寸后原子写入，更新索引。
 * @returns {{owner:string, md5:string, size:number, updatedAt:number}}
 */
export function saveAvatar(owner, buffer) {
  if (!isValidOwner(owner)) {
    const err = new Error("头像标识无效")
    err.status = 400
    throw err
  }
  const max = avatarMaxBytes()
  if (!buffer || !buffer.length) {
    const err = new Error("头像内容为空")
    err.status = 400
    throw err
  }
  if (buffer.length > max) {
    const err = new Error(`头像体积超出限制（最大 ${Math.round(max / 1024)}KB）`)
    err.status = 413
    throw err
  }
  const size = parseWebpSize(buffer)
  if (!size) {
    const err = new Error("仅支持 WebP 格式头像")
    err.status = 400
    throw err
  }
  if (size.width !== AVATAR_SIZE || size.height !== AVATAR_SIZE) {
    const err = new Error(`头像尺寸必须为 ${AVATAR_SIZE}×${AVATAR_SIZE}（当前 ${size.width}×${size.height}）`)
    err.status = 400
    throw err
  }
  const file = indexPath(owner)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, file)
  restrictFileMode(file)
  const entry = { owner, md5: md5(buffer), size: buffer.length, updatedAt: Date.now() }
  index.set(owner, entry)
  return entry
}

export function deleteAvatar(owner) {
  const existed = index.delete(owner)
  try {
    fs.rmSync(indexPath(owner), { force: true })
  } catch {
    /* ignore */
  }
  return existed
}
