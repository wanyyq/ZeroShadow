import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR } from "./env.js"
import { readJsonTyped, withLock, writeJsonAtomic } from "./store.js"
import { getConfig, MEMBER_PERM_KEYS, effectivePerms, narrowPerms } from "./config.js"
import { isSameOrInside } from "./safety.js"
import { httpError } from "./http.js"

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

/**
 * 组长能力。
 *
 * `manageVisibility` 是单独一项，**默认关**：它曾经混在 `manageMembers` 里，
 * 于是"能增删成员"顺手就获得了"改本组可见范围"的权力 —— 组长把自己组的白名单
 * 清空就等于放宽了全组的可见范围，超管划定的边界被绕开。
 */
export const LEADER_CAPS = ["viewMembers", "manageTodo", "editMemberAvatar", "manageMembers", "manageVisibility"]

const DEFAULT_LEADER_CAPS = {
  viewMembers: true,
  manageTodo: true,
  editMemberAvatar: false,
  manageMembers: false,
  manageVisibility: false,
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
  if (typeof name !== "string") {
    return httpError(400, "名称无效", { errorKey: "api.groups.name_invalid" })
  }
  const trimmed = name.trim()
  if (!trimmed) return httpError(400, "名称不能为空", { errorKey: "api.groups.name_empty" })
  if (!NAME_RE.test(trimmed)) {
    return httpError(400, "名称仅支持中英文、数字、空格与 _ . -（1-40 位）", {
      errorKey: "api.groups.name_charset",
    })
  }
  return null
}

export async function createGroup({ name, color, perms, whitelist, blacklist, leaderCaps, members, leaders }) {
  return withLock("groups", async () => {
    const trimmed = String(name || "").trim()
    const err = validateName(trimmed)
    if (err) throw err
    if (groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
      throw httpError(400, "小组名称已存在", { errorKey: "api.groups.name_taken" })
    }
    if (groups.length >= MAX_GROUPS) {
      throw httpError(400, `小组数量已达上限 ${MAX_GROUPS}`, {
        errorKey: "api.groups.limit_reached",
        errorParams: { max: MAX_GROUPS },
      })
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
      throw httpError(404, "小组不存在", { errorKey: "api.groups.not_found" })
    }
    if (patch.name !== undefined) {
      const trimmed = String(patch.name).trim()
      const err = validateName(trimmed)
      if (err) throw err
      if (groups.some((g) => g.id !== id && g.name.toLowerCase() === trimmed.toLowerCase())) {
        throw httpError(400, "小组名称已存在", { errorKey: "api.groups.name_taken" })
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
      throw httpError(404, "小组不存在", { errorKey: "api.groups.not_found" })
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
 * 合并多个小组的可见范围（**并集**语义）。
 *
 * 为什么"缺省上下文"用并集而不是交集：小组的本质是"分区"——一个成员可以同时在
 * 「项目 A」组（白名单 ["projA"]）和「项目 B」组（["projB"]），他本来就该同时看到
 * 两个项目。取交集会让这种常见用法直接变成"什么都看不到"。
 * 而"去掉请求头就能看到全盘"才是要堵的洞：并集保证他最多只能看到**所属组能看到的
 * 范围之和**，看不到任何没被任何组授予的目录。
 *
 * 黑名单同组内是 deny 优先，跨组同样取并集（任何一个组禁掉的目录就不可见）。
 * 只要有一个组不限制白名单（留空 = 不限），合并结果也不限制 —— 这与"该组允许全部"
 * 一致。
 */
export function unionVisibility(list = []) {
  const whitelist = []
  const blacklist = []
  let unrestricted = false
  for (const group of list) {
    if (!group) continue
    const w = cleanPathList(group.whitelist)
    const b = cleanPathList(group.blacklist)
    if (!w.length) unrestricted = true
    for (const p of w) if (!whitelist.includes(p)) whitelist.push(p)
    for (const p of b) if (!blacklist.includes(p)) blacklist.push(p)
  }
  return { whitelist: unrestricted ? [] : whitelist, blacklist }
}

/**
 * 某身份的可见范围。
 * @returns {{whitelist:string[],blacklist:string[]}|null} null 表示不受限（超管/访客）
 *
 * 小组上下文是**自选**的：指定了小组就用该组；没指定（或指定了不属于自己的组）时，
 * 不能回落到"默认不限"，而是取所属各组的并集 —— 否则成员不发 X-ZS-Group 就能
 * 绕开小组可见范围（WebDAV 客户端默认就不发这个头）。
 */
export function visibilityForContext(role, userId, group) {
  if (role !== "member") return null
  if (group) return visibilityFor(group)
  const mine = userId ? groupsForUser(userId) : []
  if (!mine.length) return visibilityFor(null)
  return unionVisibility(mine)
}

/**
 * 某身份的有效权限（与 visibilityForContext 同一套"缺省上下文"规则）。
 *
 * 权限与可见范围的取舍不同：权限是**交集**（deny 优先）—— 少给权限只会让成员
 * 更安全，而"缺省上下文拿到全局权限"正是原来的绕过点。
 */
export function permsForContext(role, userId, group) {
  const base = effectivePerms(role, group)
  if (role !== "member" || group || !userId) return base
  const mine = groupsForUser(userId)
  if (!mine.length) return base
  return narrowPerms(base, mine.map((g) => g.perms))
}

/**
 * 新的可见范围是否**只收窄**了旧的（组长自助修改时必须满足）。
 *
 * 收窄 = 新白名单内的目录都能被旧白名单覆盖（旧不限则恒真），且新黑名单包含
 * 旧黑名单的所有条目。反过来（清空白名单、删掉黑名单、加白名单）一律拒绝。
 */
export function isVisibilityNarrower(next, prev) {
  const nextWhite = cleanPathList(next?.whitelist)
  const prevWhite = cleanPathList(prev?.whitelist)
  const nextBlack = cleanPathList(next?.blacklist)
  const prevBlack = cleanPathList(prev?.blacklist)
  // 白名单：旧的为空（不限）时新的可以任意；旧的有内容时**不能清空**
  // （清空 = 从"只能看这几个目录"变成"不限"，是放宽的极端情形），
  // 且新加的每一项都必须落在旧范围内。
  if (prevWhite.length) {
    if (!nextWhite.length) return false
    for (const p of nextWhite) {
      if (!prevWhite.some((base) => isSameOrInside(p, base))) return false
    }
  }
  // 黑名单：旧的每一条都必须还在（删掉一条就是放宽）
  for (const p of prevBlack) {
    if (!nextBlack.some((item) => samePathish(item, p))) return false
  }
  return true
}

function samePathish(a, b) {
  return isSameOrInside(String(a), String(b)) && isSameOrInside(String(b), String(a))
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
  // ctx.visibility 由 attachContext 预先算好（列目录时每个条目都要判一次，
  // 反复合并小组范围没有必要）；没有预计算时按同一套规则现算。
  const vis = ctx.visibility !== undefined ? ctx.visibility : visibilityForContext(ctx.role, ctx.userId, ctx.group)
  if (!vis) return true
  return isVisibleInVisibility(rel, vis)
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
