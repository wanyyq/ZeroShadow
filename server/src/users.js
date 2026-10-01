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

export function validateNewUser(username, password) {
  if (!USERNAME_RE.test(username)) return "用户名需为 2-32 位字母、数字、_ . -"
  if (username.toLowerCase() === env.superUser.toLowerCase()) return "该用户名已被超级管理员占用"
  if (findByUsername(username)) return "用户名已存在"
  if (typeof password !== "string" || password.length < 6 || password.length > 128)
    return "密码长度需为 6-128 位"
  return null
}

export async function createMembers(entries) {
  return withLock("users", async () => {
    const results = []
    const seen = new Set()
    for (const entry of entries) {
      const username = String(entry.username || "").trim()
      const password = String(entry.password || "")
      let err = validateNewUser(username, password)
      if (!err && seen.has(username.toLowerCase())) err = "本次提交中用户名重复"
      if (!err && users.length >= MAX_MEMBERS) err = `成员数量已达上限 ${MAX_MEMBERS}`
      if (err) {
        results.push({ username, ok: false, error: err })
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

export async function resetPassword(id, password) {
  return withLock("users", async () => {
    const user = findById(id)
    if (!user) return "用户不存在"
    if (typeof password !== "string" || password.length < 6 || password.length > 128)
      return "密码长度需为 6-128 位"
    user.passwordHash = await bcrypt.hash(password, 10)
    user.tokenVersion += 1
    await persist()
    return null
  })
}
