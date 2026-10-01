import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR } from "./env.js"
import { readJsonTyped, withLock, writeJsonAtomic } from "./store.js"
import { getConfig, MEMBER_PERM_KEYS } from "./config.js"
import { isSameOrInside } from "./safety.js"

// ============================================================================
//  groups.js - 小组（含权限收窄与可见范围）
//
//  小组不改变"超级管理员/成员/访客"三角色，而是给成员提供一个"上下文"：
//    - perms：对全局 memberPerms 的收窄（与服务端 effectivePerms 取与）；
//    - whitelist：可见白名单（相对 FILES_DIR）；为空表示不限制；
//    - blacklist：可见黑名单，优先级高于白名单；
//    - leaderCaps：超管可下放给组长的能力开关。
// ============================================================================

const GROUPS_FILE = path.join(DATA_DIR, "groups.json")
const MAX_GROUPS = 200
const MAX_MEMBERS_PER_GROUP = 500
const NAME_RE = /^[\w\u4e00-\u9fff\u3400-\u4dbf .-]{1,40}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

export const LEADER_CAPS = ["viewMembers", "manageTodo", "editMemberAvatar", "manageMembers"]

const DEFAULT_LEADER_CAPS = {
  viewMembers: true,
  manageTodo: true,
  editMemberAvatar: false,
  manageMembers: false,
}

function defaultPerms() {
  const out = {}
  for (const key of MEMBER_PERM_KEYS) out[key] = true
  return out
}

function cleanPathList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const rel = String(item || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim()
    if (!rel) continue
    if (rel === "." || rel === "..") continue
    if (rel.split("/").some((p) => p === "..")) continue
    if (!out.includes(rel)) out.push(rel)
    if (out.length >= 200) break
  }
  return out
}

function sanitizePerms(raw) {
  const out = defaultPerms()
  if (raw && typeof raw === "object") {
    for (const key of MEMBER_PERM_KEYS) {
      if (key in raw) out[key] = !!raw[key]
    }
  }
  return out
}

function sanitizeLeaderCaps(raw) {
  const out = { ...DEFAULT_LEADER_CAPS }
  if (raw && typeof raw === "object") {
    for (const key of LEADER_CAPS) {
      if (key in raw) out[key] = !!raw[key]
    }
  }
  return out
}

function sanitizeGroup(raw) {
  const members = Array.isArray(raw.members) ? [...new Set(raw.members.map(String))].slice(0, MAX_MEMBERS_PER_GROUP) : []
  const memberSet = new Set(members)
  const leaders = Array.isArray(raw.leaders)
    ? [...new Set(raw.leaders.map(String))].filter((id) => memberSet.has(id)).slice(0, 100)
    : []
  return {
    id: String(raw.id),
    name: String(raw.name || "").slice(0, 40),
    color: COLOR_RE.test(String(raw.color)) ? raw.color : "#6b7280",
    members,
    leaders,
    perms: sanitizePerms(raw.perms),
    whitelist: cleanPathList(raw.whitelist),
    blacklist: cleanPathList(raw.blacklist),
    leaderCaps: sanitizeLeaderCaps(raw.leaderCaps),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  }
}

let groups = readJsonTyped(GROUPS_FILE, [], "array")
  .filter((g) => g && typeof g === "object" && g.id && g.name)
  .map(sanitizeGroup)

export function reloadGroups() {
  groups = readJsonTyped(GROUPS_FILE, [], "array")
    .filter((g) => g && typeof g === "object" && g.id && g.name)
    .map(sanitizeGroup)
  return groups
}

export function listGroups() {
  return groups
}

export function getGroup(id) {
  return groups.find((g) => g.id === id) || null
}

export function groupsForUser(userId) {
  if (!userId) return []
  return groups.filter((g) => g.members.includes(userId))
}

export function isGroupLeader(group, userId) {
  return !!group && !!userId && group.leaders.includes(userId)
}

/** 该用户是否能对某小组行使组长能力 */
export function leaderHasCap(group, userId, cap) {
  if (!group || !userId) return false
  if (!group.leaders.includes(userId)) return false
  return !!group.leaderCaps?.[cap]
}

function persist() {
  return writeJsonAtomic(GROUPS_FILE, groups)
}

function validateName(name) {
  if (typeof name !== "string") return "名称无效"
  const trimmed = name.trim()
  if (!trimmed) return "名称不能为空"
  if (!NAME_RE.test(trimmed)) return "名称仅支持中英文、数字、空格与 _ . -（1-40 位）"
  return null
}

export async function createGroup({ name, color, perms, whitelist, blacklist, leaderCaps, members, leaders }) {
  return withLock("groups", async () => {
    const trimmed = String(name || "").trim()
    const err = validateName(trimmed)
    if (err) {
      const e = new Error(err)
      e.status = 400
      throw e
    }
    if (groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
      const e = new Error("小组名称已存在")
      e.status = 400
      throw e
    }
    if (groups.length >= MAX_GROUPS) {
      const e = new Error(`小组数量已达上限 ${MAX_GROUPS}`)
      e.status = 400
      throw e
    }
    const now = new Date().toISOString()
    const group = sanitizeGroup({
      id: crypto.randomUUID(),
      name: trimmed,
      color: color || "#6b7280",
      members: Array.isArray(members) ? members : [],
      leaders: Array.isArray(leaders) ? leaders : [],
      perms,
      whitelist,
      blacklist,
      leaderCaps,
      createdAt: now,
      updatedAt: now,
    })
    groups.push(group)
    await persist()
    return group
  })
}

/** 部分更新；members/leaders 也允许直接覆盖（用于设置页整体保存） */
export async function updateGroup(id, patch = {}) {
  return withLock("groups", async () => {
    const group = getGroup(id)
    if (!group) {
      const e = new Error("小组不存在")
      e.status = 404
      throw e
    }
    if (patch.name !== undefined) {
      const trimmed = String(patch.name).trim()
      const err = validateName(trimmed)
      if (err) {
        const e = new Error(err)
        e.status = 400
        throw e
      }
      if (groups.some((g) => g.id !== id && g.name.toLowerCase() === trimmed.toLowerCase())) {
        const e = new Error("小组名称已存在")
        e.status = 400
        throw e
      }
      group.name = trimmed
    }
    if (patch.color !== undefined && COLOR_RE.test(String(patch.color))) group.color = String(patch.color)
    if (patch.perms !== undefined) group.perms = sanitizePerms({ ...group.perms, ...patch.perms })
    if (patch.whitelist !== undefined) group.whitelist = cleanPathList(patch.whitelist)
    if (patch.blacklist !== undefined) group.blacklist = cleanPathList(patch.blacklist)
    if (patch.leaderCaps !== undefined) group.leaderCaps = sanitizeLeaderCaps({ ...group.leaderCaps, ...patch.leaderCaps })
    if (patch.members !== undefined) {
      group.members = Array.isArray(patch.members) ? [...new Set(patch.members.map(String))].slice(0, MAX_MEMBERS_PER_GROUP) : group.members
      // 被移出小组的人自动卸任组长
      group.leaders = group.leaders.filter((lid) => group.members.includes(lid))
    }
    if (patch.leaders !== undefined) {
      const wanted = Array.isArray(patch.leaders) ? [...new Set(patch.leaders.map(String))] : group.leaders
      group.leaders = wanted.filter((lid) => group.members.includes(lid)).slice(0, 100)
    }
    group.updatedAt = new Date().toISOString()
    await persist()
    return group
  })
}

export async function addMembers(groupId, userIds, action = "add") {
  return withLock("groups", async () => {
    const group = getGroup(groupId)
    if (!group) {
      const e = new Error("小组不存在")
      e.status = 404
      throw e
    }
    const ids = Array.isArray(userIds) ? userIds.map(String) : []
    if (action === "remove") {
      const set = new Set(ids)
      group.members = group.members.filter((m) => !set.has(m))
      group.leaders = group.leaders.filter((l) => !set.has(l))
    } else {
      const merged = new Set(group.members)
      for (const id of ids) merged.add(id)
      group.members = [...merged].slice(0, MAX_MEMBERS_PER_GROUP)
    }
    group.updatedAt = new Date().toISOString()
    await persist()
    return group
  })
}

export async function deleteGroup(id) {
  return withLock("groups", async () => {
    const before = groups.length
    groups = groups.filter((g) => g.id !== id)
    await persist()
    return before - groups.length
  })
}

/** 当成员被删除时，从所有小组里移除 */
export async function removeUserFromAllGroups(userId) {
  return withLock("groups", async () => {
    let changed = false
    for (const group of groups) {
      if (group.members.includes(userId)) {
        group.members = group.members.filter((m) => m !== userId)
        group.leaders = group.leaders.filter((l) => l !== userId)
        changed = true
      }
    }
    if (changed) await persist()
    return changed
  })
}

// ---------------------------------------------------------------- 可见范围 --
function inList(rel, list) {
  return list.some((base) => isSameOrInside(rel, base))
}

/** 返回某上下文（小组或默认）的 { whitelist, blacklist } */
export function visibilityFor(group) {
  if (group) return { whitelist: group.whitelist, blacklist: group.blacklist }
  const dv = getConfig().defaultVisibility || { whitelist: [], blacklist: [] }
  return { whitelist: cleanPathList(dv.whitelist), blacklist: cleanPathList(dv.blacklist) }
}

/**
 * 相对路径在给定可见范围下是否可见。
 * 规则：黑名单优先；白名单为空表示不限制；否则必须落在白名单内。
 */
export function isVisibleInVisibility(rel, visibility) {
  const path = String(rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const { whitelist, blacklist } = visibility
  if (inList(path, blacklist)) return false
  if (!whitelist.length) return true
  return inList(path, whitelist)
}

/**
 * 上下文可见性总入口。
 * @param {string} rel 相对 FILES_DIR 的路径
 * @param {{role:string, group?:object|null, userId?:string|null}} ctx
 */
export function isVisibleForContext(rel, ctx) {
  if (!ctx) return true
  if (ctx.role === "superadmin") return true
  if (ctx.role !== "member") return true // 访客走 guestHiddenPaths，不套用小组规则
  return isVisibleInVisibility(rel, visibilityFor(ctx.group))
}

/** 判断某成员是否属于给定小组（含超管视为可切换任意组） */
export function canUseGroupContext(role, userId, group) {
  if (!group) return true
  if (role === "superadmin") return true
  if (role === "member" && userId) return group.members.includes(userId)
  return false
}

/** 从请求解析并校验小组上下文（无效则回退默认上下文） */
export function resolveGroupContext(req) {
  const raw = req.headers["x-zs-group"]
  let id = typeof raw === "string" ? raw.trim() : ""
  // 原生 <img>/<video> 等无法携带自定义头，允许用 ?group= 兜底（仍会校验成员归属）
  if (!id && req.query && typeof req.query.group === "string") id = req.query.group.trim()
  if (!id || id === "default") return { group: null, groupId: "default" }
  const group = getGroup(id)
  if (!group) return { group: null, groupId: "default" }
  if (!canUseGroupContext(req.auth.role, req.auth.userId, group)) {
    return { group: null, groupId: "default" }
  }
  return { group, groupId: group.id }
}
