import path from "node:path"
import crypto from "node:crypto"
import bcrypt from "bcryptjs"
import { DATA_DIR, env } from "./env.js"
import { readJsonSync, withLock, writeJsonAtomic } from "./store.js"

const USERS_FILE = path.join(DATA_DIR, "users.json")
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/
const MAX_MEMBERS = 500

let users = readJsonSync(USERS_FILE, [])
if (!Array.isArray(users)) users = []
users = users.filter((u) => u && typeof u === "object" && u.id && u.username)

export function reloadUsers() {
  users = readJsonSync(USERS_FILE, [])
  if (!Array.isArray(users)) users = []
  users = users.filter((u) => u && typeof u === "object" && u.id && u.username)
  return users
}

export function persist() {
  return writeJsonAtomic(USERS_FILE, users)
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
  }
}

export function listMembers() {
  return users.map(publicUser)
}

export function findById(id) {
  return users.find((u) => u.id === id) || null
}

export function findByUsername(username) {
  const lower = String(username || "").toLowerCase()
  return users.find((u) => u.username.toLowerCase() === lower) || null
}

/**
 * 校验新成员的用户名/密码。
 *
 * 返回 null（通过）或 `{ message, errorKey, errorParams? }`：`message` 仍是中文原文，
 * 命名键给前端按界面语言渲染用（见 http.js 的说明）。
 * `validateNewUser` 保留"只返回中文字符串"的旧签名给外部调用方，两者共用同一份判断。
 */
function checkNewUser(username, password) {
  if (!USERNAME_RE.test(username)) {
    return { message: "用户名需为 2-32 位字母、数字、_ . -", errorKey: "api.admin.username_invalid" }
  }
  if (username.toLowerCase() === env.superUser.toLowerCase()) {
    return { message: "该用户名已被超级管理员占用", errorKey: "api.admin.username_reserved" }
  }
  if (findByUsername(username)) {
    return { message: "用户名已存在", errorKey: "api.admin.username_taken" }
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    return { message: "密码长度需为 6-128 位", errorKey: "api.admin.password_length_invalid" }
  }
  return null
}

/** 只返回中文错误文案（或 null，表示通过）；命名键见 checkNewUser */
export function validateNewUser(username, password) {
  return checkNewUser(username, password)?.message ?? null
}

export async function createMembers(entries) {
  return withLock("users", async () => {
    const results = []
    const seen = new Set()
    for (const entry of entries) {
      const username = String(entry.username || "").trim()
      const password = String(entry.password || "")
      let check = checkNewUser(username, password)
      if (!check && seen.has(username.toLowerCase())) {
        check = { message: "本次提交中用户名重复", errorKey: "api.admin.username_duplicate" }
      }
      if (!check && users.length >= MAX_MEMBERS) {
        check = {
          message: `成员数量已达上限 ${MAX_MEMBERS}`,
          errorKey: "api.admin.member_limit_reached",
          errorParams: { max: MAX_MEMBERS },
        }
      }
      if (check) {
        // error/errorKey 一起返回：error 是中文原文（旧前端与脚本照旧），
        // errorKey 让界面能按当前语言渲染这一行的失败原因。
        results.push({
          username,
          ok: false,
          error: check.message,
          errorKey: check.errorKey,
          ...(check.errorParams ? { errorParams: check.errorParams } : {}),
        })
        continue
      }
      seen.add(username.toLowerCase())
      const hash = await bcrypt.hash(password, 10)
      users.push({
        id: crypto.randomUUID(),
        username,
        passwordHash: hash,
        disabled: false,
        tokenVersion: 0,
        createdAt: new Date().toISOString(),
      })
      results.push({ username, ok: true })
    }
    await persist()
    return results
  })
}

export async function verifyLogin(username, password) {
  const user = findByUsername(username)
  if (!user) {
    await bcrypt.compare(password, "$2a$10$C6UzMDM.H6dfI/f/IKcEeO7lD7cJIbQ2xUyGqrr8x1rG1cGnkGdGm")
    return { ok: false, reason: "invalid" }
  }
  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) return { ok: false, reason: "invalid" }
  if (user.disabled) return { ok: false, reason: "disabled" }
  return { ok: true, user }
}

export async function batchMembers(action, ids) {
  return withLock("users", async () => {
    const idSet = new Set(ids)
    let count = 0
    if (action === "delete") {
      const before = users.length
      users = users.filter((u) => !idSet.has(u.id))
      count = before - users.length
    } else {
      for (const u of users) {
        if (!idSet.has(u.id)) continue
        if (action === "disable" && !u.disabled) {
          u.disabled = true
          u.tokenVersion += 1
          count += 1
        } else if (action === "enable" && u.disabled) {
          u.disabled = false
          count += 1
        }
      }
    }
    await persist()
    return count
  })
}

/**
 * 吊销某成员的全部会话（tokenVersion +1）。
 *
 * JWT 是无状态的：只清 Cookie 的话，已经发出去的令牌在有效期内（默认 72 小时）
 * 仍然可用。登出、改密、禁用都走这条路径，保证"我现在要下线"是真的下线。
 * 代价是同一账号在其他设备/标签页上的会话也会一起失效 —— 对网盘这种场景
 * 这反而是期望行为（"登出所有设备"）。
 */
export async function revokeSessions(id) {
  return withLock("users", async () => {
    const user = findById(id)
    if (!user) return false
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1
    await persist()
    return true
  })
}

/**
 * 重置成员密码。
 *
 * 失败时返回 `{ key, message }`：`message` 是中文原文（调用方照搬进 error 字段），
 * `key` 是命名键（前端据此按当前界面语言渲染）。这样文案由本文件一处拥有，
 * 调用方不必维护"文案 → 键"的映射表（中文一改，映射会静默失效）。
 */
export async function resetPassword(id, password) {
  return withLock("users", async () => {
    const user = findById(id)
    if (!user) return { key: "api.admin.user_not_found", message: "用户不存在" }
    if (typeof password !== "string" || password.length < 6 || password.length > 128)
      return { key: "api.admin.password_length_invalid", message: "密码长度需为 6-128 位" }
    user.passwordHash = await bcrypt.hash(password, 10)
    user.tokenVersion += 1
    await persist()
    return null
  })
}
