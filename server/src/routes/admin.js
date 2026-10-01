import { Router } from "express"
import { env } from "../env.js"
import { requireRole } from "../auth.js"
import { reloadConfig, getConfig, saveConfig } from "../config.js"
import { batchMembers, createMembers, findById, findByUsername, listMembers, persist, reloadUsers, resetPassword } from "../users.js"
import { getStatus } from "../status.js"
import { applyTunnelConfig, tunnelStatus, validateCustomHost } from "../tunnel.js"
import { aggregateLogs, clearLogs, info, queryLogs } from "../logger.js"
import { samePath } from "../safety.js"
import {
  LEADER_CAPS,
  addMembers,
  createGroup,
  deleteGroup,
  listGroups,
  reloadGroups,
  removeUserFromAllGroups,
  updateGroup,
} from "../groups.js"
import { reloadTodos, removeGroupFromTodos, removeUserFromTodos } from "../todos.js"
import { deleteAvatar, ownerForUser } from "../avatars.js"
import { listBackups, restoreBackup, snapshotAll } from "../backup.js"
import { getMetrics, readMetricsHistory } from "../metrics.js"

const router = Router()

router.use(requireRole("superadmin"))

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function actor(req) {
  return { user: req.auth.username, role: req.auth.role, ip: req.ip }
}

// 数值型配置：键 -> [min, max]
const NUMERIC_KEYS = {
  superUploadLimitMB: [1, 1048576],
  memberUploadLimitMB: [1, 1048576],
  zipMaxFiles: [1, 100000],
  zipMaxSingleMB: [1, 1048576],
  zipMaxTotalMB: [1, 1048576],
  extractMaxZipMB: [1, 1048576],
  extractMaxTotalMB: [1, 1048576],
  downloadUrlMaxMB: [1, 1048576],
  rateLimitPerMin: [1, 100000],
  avatarMaxKB: [1, 10240],
  backupKeep: [1, 500],
  logRetentionDays: [1, 3650],
  metricsRetentionDays: [1, 365],
  metricsMemMinutes: [1, 1440],
  slowRequestMs: [1, 600000],
}

const BOOLEAN_KEYS = [
  "rateLimitEnabled",
  "softDirAllowCopyOut",
  "jobStatusOwnerOnly",
  "downloadUrlAllowPrivate",
  "csrfOriginCheck",
  "avatarEnabled",
  "todoEnabled",
  "backupEnabled",
  "requestMetricsEnabled",
]

function cleanVisibilityPathList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const rel = String(item || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim()
    if (!rel || rel === "." || rel === "..") continue
    if (rel.split("/").some((p) => p === "..")) continue
    if (!out.includes(rel)) out.push(rel)
    if (out.length >= 200) break
  }
  return out
}

router.get("/config", (_req, res) => {
  res.json(getConfig())
})

router.patch("/config", async (req, res, next) => {
  try {
    const body = req.body || {}
    const updates = {}
    for (const [key, [min, max]] of Object.entries(NUMERIC_KEYS)) {
      if (body[key] !== undefined) {
        const n = Number(body[key])
        if (!Number.isInteger(n) || n < min || n > max) {
          throw httpError(400, `${key} 需为 ${min}-${max} 之间的整数`)
        }
        updates[key] = n
      }
    }
    for (const key of BOOLEAN_KEYS) {
      if (body[key] !== undefined) updates[key] = !!body[key]
    }
    if (body.defaultVisibility !== undefined) {
      if (typeof body.defaultVisibility !== "object" || body.defaultVisibility === null) {
        throw httpError(400, "defaultVisibility 参数格式错误")
      }
      updates.defaultVisibility = {
        whitelist: cleanVisibilityPathList(body.defaultVisibility.whitelist),
        blacklist: cleanVisibilityPathList(body.defaultVisibility.blacklist),
      }
    }
    for (const group of ["memberPerms", "guestPerms"]) {
      if (body[group] !== undefined) {
        if (typeof body[group] !== "object" || body[group] === null) {
          throw httpError(400, "参数格式错误")
        }
        updates[group] = {}
        for (const [k, v] of Object.entries(body[group])) {
          updates[group][k] = !!v
        }
      }
    }
    const config = await saveConfig((draft) => {
      for (const key of Object.keys(NUMERIC_KEYS)) {
        if (updates[key] !== undefined) draft[key] = updates[key]
      }
      for (const key of BOOLEAN_KEYS) {
        if (updates[key] !== undefined) draft[key] = updates[key]
      }
      if (updates.defaultVisibility) draft.defaultVisibility = updates.defaultVisibility
      if (updates.memberPerms) Object.assign(draft.memberPerms, updates.memberPerms)
      if (updates.guestPerms) Object.assign(draft.guestPerms, updates.guestPerms)
    })
    info("config_update", { msg: JSON.stringify(updates), ...actor(req) })
    res.json(config)
  } catch (err) {
    next(err)
  }
})

router.delete("/hidden-paths", async (req, res, next) => {
  try {
    const target = String(req.body?.path || "")
    const config = await saveConfig((draft) => {
      draft.guestHiddenPaths = draft.guestHiddenPaths.filter((h) => !samePath(h, target))
    })
    info("guest_visibility", { msg: `${target} 已对访客可见`, ...actor(req) })
    res.json(config)
  } catch (err) {
    next(err)
  }
})

// ================================================================ 成员 =====
router.get("/members", (_req, res) => {
  res.json({ members: listMembers() })
})

router.post("/members", async (req, res, next) => {
  try {
    const users = req.body?.users
    if (!Array.isArray(users) || !users.length || users.length > 200) {
      throw httpError(400, "参数格式错误（单次最多 200 个）")
    }
    const results = await createMembers(users)
    const created = results.filter((r) => r.ok).map((r) => r.username)
    if (created.length) {
      info("members_create", { msg: created.join(", "), ...actor(req) })
    }
    res.json({ results })
  } catch (err) {
    next(err)
  }
})

router.post("/members/batch", async (req, res, next) => {
  try {
    const { action, ids } = req.body || {}
    if (!["enable", "disable", "delete"].includes(action) || !Array.isArray(ids) || !ids.length) {
      throw httpError(400, "参数格式错误")
    }
    const idList = ids.map(String)
    const count = await batchMembers(action, idList)
    if (action === "delete") {
      for (const id of idList) {
        await removeUserFromAllGroups(id)
        await removeUserFromTodos(id)
        deleteAvatar(ownerForUser(id))
      }
    }
    info("members_batch", { msg: `${action} × ${count}`, ...actor(req) })
    res.json({ count })
  } catch (err) {
    next(err)
  }
})

router.post("/members/:id/password", async (req, res, next) => {
  try {
    const error = await resetPassword(String(req.params.id), String(req.body?.password || ""))
    if (error) throw httpError(400, error)
    info("members_reset_password", { msg: req.params.id, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.patch("/members/:id", async (req, res, next) => {
  try {
    const user = findById(String(req.params.id))
    if (!user) throw httpError(404, "用户不存在")
    if (req.body?.username) {
      const newName = String(req.body.username).trim()
      const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/
      if (!USERNAME_RE.test(newName)) throw httpError(400, "用户名需为 2-32 位字母、数字、_ . -")
      if (newName.toLowerCase() === env.superUser.toLowerCase()) throw httpError(400, "该用户名已被超级管理员占用")
      const existing = findByUsername(newName)
      if (existing && existing.id !== user.id) throw httpError(400, "用户名已存在")
      user.username = newName
      await persist()
      info("members_rename", { msg: `${req.params.id} → ${newName}`, ...actor(req) })
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ================================================================ 小组 =====
router.get("/groups", (_req, res) => {
  res.json({
    groups: listGroups(),
    leaderCaps: LEADER_CAPS,
    members: listMembers(),
  })
})

router.post("/groups", async (req, res, next) => {
  try {
    const group = await createGroup(req.body || {})
    info("group_create", { msg: group.name, ...actor(req) })
    res.json({ group })
  } catch (err) {
    next(err)
  }
})

router.patch("/groups/:id", async (req, res, next) => {
  try {
    const group = await updateGroup(String(req.params.id), req.body || {})
    info("group_update", { msg: group.name, ...actor(req) })
    res.json({ group })
  } catch (err) {
    next(err)
  }
})

router.post("/groups/:id/members", async (req, res, next) => {
  try {
    const ids = req.body?.ids
    if (!Array.isArray(ids)) throw httpError(400, "参数格式错误")
    const group = await addMembers(String(req.params.id), ids, req.body?.action === "remove" ? "remove" : "add")
    info("group_update", { msg: `${group.name} 成员调整`, ...actor(req) })
    res.json({ group })
  } catch (err) {
    next(err)
  }
})

router.delete("/groups/:id", async (req, res, next) => {
  try {
    await deleteGroup(String(req.params.id))
    await removeGroupFromTodos(String(req.params.id))
    info("group_delete", { msg: String(req.params.id), ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ================================================================ 日志 =====
router.get("/logs", async (req, res, next) => {
  try {
    const rows = await queryLogs({
      limit: req.query.limit,
      level: String(req.query.level || ""),
      q: String(req.query.q || ""),
      days: req.query.days,
      auditOnly: req.query.audit === "1" || req.query.audit === "true",
    })
    // stats=0 时省掉聚合统计。除了省算力，也让只关心日志行的调用方拿到更小的响应：
    // stats.users 以用户名为键，而用户名可能仅大小写不同（如 Wangyq 与 wangyq），
    // Windows PowerShell 的 ConvertFrom-Json 会把它们判成重复键并直接抛错。
    if (req.query.stats === "0" || req.query.stats === "false") {
      return res.json({ logs: rows })
    }
    res.json({ logs: rows, stats: aggregateLogs(rows) })
  } catch (err) {
    next(err)
  }
})

router.delete("/logs", async (req, res, next) => {
  try {
    await clearLogs()
    info("logs_clear", actor(req))
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ================================================================ 指标 =====
router.get("/metrics", (_req, res) => {
  res.json(getMetrics())
})

router.get("/metrics/history", async (req, res, next) => {
  try {
    const rows = await readMetricsHistory(String(req.query.date || ""))
    res.json({ date: String(req.query.date || ""), samples: rows })
  } catch (err) {
    next(err)
  }
})

// ================================================================ 备份 =====
router.get("/backups", (_req, res) => {
  res.json({ backups: listBackups() })
})

router.post("/backups", async (req, res, next) => {
  try {
    const count = snapshotAll()
    info("backup_create", { msg: `手动快照 ${count} 个文件`, ...actor(req) })
    res.json({ ok: true, count, backups: listBackups() })
  } catch (err) {
    next(err)
  }
})

const RESTORE_RELOAD = {
  "config.json": reloadConfig,
  "users.json": reloadUsers,
  "groups.json": reloadGroups,
  "todos.json": reloadTodos,
}

router.post("/backups/restore", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "")
    const id = String(req.body?.id || "")
    restoreBackup(name, id)
    const reload = RESTORE_RELOAD[name]
    if (reload) reload()
    info("backup_restore", { msg: `${name} ← ${id}`, ...actor(req) })
    res.json({ ok: true, name, id })
  } catch (err) {
    next(err)
  }
})

// ================================================================ 状态/隧道 =
router.get("/status", async (_req, res, next) => {
  try {
    res.json(await getStatus())
  } catch (err) {
    next(err)
  }
})

router.get("/tunnel", (_req, res) => {
  res.json({ config: getConfig().tunnel, status: tunnelStatus() })
})

router.post("/tunnel", async (req, res, next) => {
  try {
    const body = req.body || {}
    const enabled = !!body.enabled
    const mode = body.mode === "custom" ? "custom" : body.mode === "localhostrun" ? "localhostrun" : body.mode === "pinggy" ? "pinggy" : "serveo"
    const customHost = String(body.customHost || "").trim()
    if (enabled && mode === "custom") {
      const invalid = validateCustomHost(customHost)
      if (invalid) throw httpError(400, invalid)
    }
    const config = await saveConfig((draft) => {
      draft.tunnel = { enabled, mode, customHost }
    })
    applyTunnelConfig(config.tunnel)
    info(enabled ? "tunnel_enable" : "tunnel_disable", { msg: mode, ...actor(req) })
    setTimeout(() => {
      res.json({ config: config.tunnel, status: tunnelStatus() })
    }, 600)
  } catch (err) {
    next(err)
  }
})

export default router
