import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR } from "./env.js"
import { readJsonSync, writeJsonAtomic } from "./store.js"
import { getConfig } from "./config.js"
import { httpError } from "./http.js"
import { info, warn } from "./logger.js"

// ============================================================================
//  trash.js - 回收站
//
//  为什么需要它：
//    以前 POST /api/fs/delete 是 `fs.rm`，真删。十几个人共用一个网盘时，
//    误删一个文件夹就是不可恢复的事故 —— 而这恰恰是备份覆盖不到的场景
//    （备份只保护 config/users/groups/todos 四个文件，网盘内容不在内）。
//
//  磁盘布局：
//    data/trash/<时间戳>-<随机>/meta.json   ← 元数据（原路径、谁删的、何时）
//    data/trash/<时间戳>-<随机>/content     ← 内容本身（文件或整个目录）
//
//  关键设计：
//    1. 回收站放在 data/ 下，**不在 FILES_DIR 内** —— 否则它会出现在网盘根
//       目录里，被列目录、被搜索、被打包、还能被访客按路径直接下载。
//    2. 用 rename 移入（同一磁盘上是原子操作）。跨设备失败时退化为"复制后删"，
//       并且**先复制成功再删原件**，避免中途失败两边都没有。
//    3. 元数据写入用 store.js 的原子写，进程被杀也不会留下半个 JSON。
//    4. 名称走 FILES_DIR 内的相对路径（与 /api/fs/* 的语义一致），还原时按
//       resolveAny 重新解析，因此还原目标永远落在合法范围内。
// ============================================================================

export const TRASH_DIR = path.join(DATA_DIR, "trash")
const META_FILE = "meta.json"
const CONTENT_NAME = "content"
/**
 * 单条回收站记录的原路径长度上限（防御异常输入把 meta 撑爆）。
 * 1024 对深层目录偏小：超过它的条目以前会"入不了回收站 → 回落到彻底删除"，
 * 也就是无声销毁。现在入不了回收站会明确报错（见 moveToTrash），
 * 同时把上限放宽到 Windows/Linux 的常见路径上限 4096。
 */
const MAX_REL_LEN = 4096

// 不要在模块加载时就因为建不出目录而抛异常：那会让**整个服务起不来**。
// 真实部署里 data/ 可能只读、磁盘可能满、权限可能不对——回收站功能不可用时
// 应该降级（删除退回彻底删除），而不是连登录界面都打不开。
// 这里记一个 available 标志，写操作失败时再补一次懒创建。
let available = ensureDir()

function ensureDir() {
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true })
    return true
  } catch (err) {
    warn("trash_unavailable", { msg: `回收站目录不可用（${err.code || err.message}），删除将直接生效、不进入回收站` })
    return false
  }
}

/** 回收站当前是否可用（目录建不出来时为 false） */
export function trashAvailable() {
  if (!available) available = ensureDir()
  return available
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${crypto.randomBytes(3).toString("hex")}`
  )
}

function entryDir(id) {
  // id 来自我们自己的 stamp()，但仍然做一次 basename 收敛，防止它被当成路径用
  return path.join(TRASH_DIR, path.basename(String(id || "")))
}

function isInsideTrash(abs) {
  const root = path.resolve(TRASH_DIR)
  const target = path.resolve(abs)
  return target === root || target.startsWith(root + path.sep)
}

/**
 * 把一个路径移入回收站。
 *
 * 返回值语义（调用方必须区分，否则会无声销毁数据）：
 *   - 元数据对象：已成功入站；
 *   - `null`：**这一项不需要入站**（rel 为空、已在回收站里），调用方可以继续；
 *   - 抛出异常：回收站可用、但**这一项入站失败**（路径过长、rename/mkdir 失败）。
 *     调用方应当跳过该项并报错，绝不能回落到 fs.rm 彻底删除 —— 那与"删除 = 可
 *     还原"的承诺不符（旧实现正是如此，深层路径会被永久删除）。
 *
 * @param {{abs:string, rel:string, isSoft?:boolean}} target resolveAny 的结果
 * @param {{user?:string, role?:string, ip?:string}} actor 执行删除的人
 * @returns {Promise<object|null>} 元数据或 null
 */
export async function moveToTrash(target, actor = {}) {
  const { abs, rel } = target
  if (!rel) return null
  // 不把回收站自己的东西再收进回收站（防止路径被拼出递归）
  if (isInsideTrash(abs)) return null
  const fail = (message) => {
    const err = new Error(message)
    err.status = 500
    err.code = "TRASH_FAILED"
    return err
  }
  if (rel.length > MAX_REL_LEN) {
    throw fail(`路径过长（超过 ${MAX_REL_LEN} 字符），未能移入回收站，因此没有删除`)
  }
  if (!trashAvailable()) return null

  const stat = await fs.promises.lstat(abs).catch(() => null)
  if (!stat) return null

  const id = stamp()
  const dir = entryDir(id)
  const contentPath = path.join(dir, CONTENT_NAME)

  await fs.promises.mkdir(dir, { recursive: true })
  try {
    await fs.promises.rename(abs, contentPath)
  } catch (err) {
    if (err.code === "EXDEV") {
      // 跨设备（data/ 与 FILES_DIR 不在同一盘）：先复制，成功后再删原件
      await fs.promises.cp(abs, contentPath, { recursive: true, dereference: false, verbatimSymlinks: true })
      await fs.promises.rm(abs, { recursive: true, force: true })
    } else {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      warn("trash_failed", { msg: `${rel}: ${err.message}` })
      throw fail(`未能移入回收站（${err.code || err.message}），因此没有删除`)
    }
  }

  const meta = {
    id,
    rel,
    name: path.basename(rel),
    type: stat.isDirectory() ? "dir" : "file",
    size: stat.isDirectory() ? -1 : stat.size,
    deletedAt: new Date().toISOString(),
    deletedBy: actor.user || null,
    deletedByRole: actor.role || null,
    deletedByIp: actor.ip || null,
  }
  await writeJsonAtomic(path.join(dir, META_FILE), meta)
  info("trash_add", { msg: rel, user: actor.user || undefined, role: actor.role || undefined, ip: actor.ip || undefined })
  return meta
}

/** 列出回收站（最近删除的在前） */
export function listTrash() {
  let ids = []
  try {
    ids = fs.readdirSync(TRASH_DIR)
  } catch {
    return []
  }
  const rows = []
  for (const id of ids) {
    if (id.startsWith(".")) continue
    const dir = entryDir(id)
    let stat
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const meta = readJsonSync(path.join(dir, META_FILE), null)
    if (!meta || !meta.id || !meta.rel) continue
    rows.push({ ...meta })
  }
  rows.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
  return rows
}

export function getTrash(id) {
  const dir = entryDir(id)
  if (!isInsideTrash(dir)) return null
  const meta = readJsonSync(path.join(dir, META_FILE), null)
  if (!meta || !meta.id) return null
  return meta
}

function trashContentPath(id) {
  return path.join(entryDir(id), CONTENT_NAME)
}

/**
 * 还原一条记录。
 * 目标位置已被占用时**不覆盖**：返回 { conflict: true }，由前端决定改名还是放弃。
 * @param {string} id
 * @param {{abs:string, rel:string}} dest resolveAny 的结果（通常是原路径）
 * @param {boolean} overwrite 目标已存在时是否覆盖
 */
export async function restoreTrash(id, dest, overwrite = false) {
  const meta = getTrash(id)
  if (!meta) {
    throw httpError(404, "回收站里找不到这个项目", { errorKey: "api.fs.trash_not_found" })
  }
  const contentPath = trashContentPath(id)
  const srcStat = await fs.promises.lstat(contentPath).catch(() => null)
  if (!srcStat) {
    throw httpError(410, "回收站内容已丢失，无法还原", { errorKey: "api.fs.trash_content_missing" })
  }
  if (!dest || !dest.rel) {
    // 必须 throw：调用方（admin.js）只看 result.conflict，return 一个 Error 对象
    // 会被当成"成功"，于是返回 200 {ok:true} 但其实什么都没还原。
    throw httpError(400, "还原目标无效", { errorKey: "api.fs.trash_invalid_target" })
  }
  if (dest.isSoft) {
    throw httpError(403, "外部映射目录仅支持只读操作", { errorKey: "api.fs.soft_read_only" })
  }

  const existing = await fs.promises.lstat(dest.abs).catch(() => null)
  if (existing) {
    if (!overwrite) return { conflict: true, meta }
    await fs.promises.rm(dest.abs, { recursive: true, force: true })
  }

  // 目标父目录可能已经被删掉了，按需补建
  await fs.promises.mkdir(path.dirname(dest.abs), { recursive: true })
  try {
    await fs.promises.rename(contentPath, dest.abs)
  } catch (err) {
    if (err.code === "EXDEV") {
      await fs.promises.cp(contentPath, dest.abs, { recursive: true, dereference: false, verbatimSymlinks: true })
      await fs.promises.rm(contentPath, { recursive: true, force: true })
    } else {
      throw err
    }
  }
  await fs.promises.rm(entryDir(id), { recursive: true, force: true }).catch(() => {})
  info("trash_restore", { msg: dest.rel })
  return { conflict: false, meta: { ...meta, restoredTo: dest.rel } }
}

/** 彻底删除一条（不可恢复） */
export async function purgeTrash(id) {
  const meta = getTrash(id)
  if (!meta) return 0
  await fs.promises.rm(entryDir(id), { recursive: true, force: true })
  info("trash_purge", { msg: meta.rel })
  return 1
}

/** 清空回收站 */
export async function emptyTrash() {
  let n = 0
  for (const row of listTrash()) {
    await fs.promises.rm(entryDir(row.id), { recursive: true, force: true }).catch(() => {})
    n += 1
  }
  if (n) info("trash_empty", { msg: `清空 ${n} 项` })
  return n
}

/** 回收站占用（文件数与字节数）。目录递归统计，条目很多时按上限截断。 */
export async function trashStats({ maxEntries = 200000 } = {}) {
  let files = 0
  let bytes = 0
  let newest = null
  const stack = [TRASH_DIR]
  while (stack.length) {
    if (files > maxEntries) break
    const current = stack.pop()
    let dirents = []
    try {
      dirents = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const child = path.join(current, dirent.name)
      if (dirent.isDirectory()) {
        stack.push(child)
      } else if (dirent.isFile()) {
        try {
          const st = await fs.promises.stat(child)
          files += 1
          bytes += st.size
          if (!newest || st.mtimeMs > newest) newest = st.mtimeMs
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  }
  return { files, bytes, newest, count: listTrash().length }
}

/** 按保留天数清理过期条目（由 index.js 的维护定时器调用） */
export async function sweepTrash() {
  let days = 30
  try {
    const n = Number(getConfig().trashRetentionDays)
    if (Number.isInteger(n) && n >= 1 && n <= 3650) days = n
  } catch {
    /* 用默认值 */
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let removed = 0
  for (const row of listTrash()) {
    const at = Date.parse(row.deletedAt)
    if (!Number.isFinite(at) || at >= cutoff) continue
    await fs.promises.rm(entryDir(row.id), { recursive: true, force: true }).catch(() => {})
    removed += 1
  }
  if (removed) info("trash_sweep", { msg: `清理 ${removed} 项（超过 ${days} 天）` })
  return removed
}
