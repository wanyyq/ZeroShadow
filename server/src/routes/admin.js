import { Router } from "express"
import { env } from "../env.js"
import { requireRole } from "../auth.js"
import { reloadConfig, getConfig, saveConfig } from "../config.js"
import { batchMembers, createMembers, findById, findByUsername, listMembers, persist, reloadUsers, resetPassword } from "../users.js"
import { getStatus } from "../status.js"
import { applyTunnelConfig, tunnelStatus, validateCustomHost } from "../tunnel.js"
import { aggregateLogs, clearLogs, info, logsExportName, logsToCsv, logsToJsonl, queryLogs } from "../logger.js"
import { contentDisposition, httpError } from "../http.js"
import { samePath, normRel, resolveAny } from "../safety.js"
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
import { emptyTrash, getTrash, listTrash, purgeTrash, restoreTrash, trashAvailable, trashStats } from "../trash.js"
import { getMetrics, readMetricsHistory } from "../metrics.js"
import { reloadShares, removeSharesByOwner, renameShareOwner } from "../shares.js"
import { availableLangs } from "../i18n.js"

const router = Router()

router.use(requireRole("superadmin"))

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
  trashRetentionDays: [1, 3650],
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
  "trashEnabled",
  "requestMetricsEnabled",
  // v1.2.1 分享（分享板块里的两个开关）
  "shareEnabled",
  "sharePublicAccess",
  // 访客写权限总开关（默认关）：关掉时 guestPerms 里的 editFiles / compressZip /
  // extractZip 一律不生效，防止"顺手勾一个子项"就给了匿名访客写盘能力
  "guestWrite",
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
          throw httpError(400, `${key} 需为 ${min}-${max} 之间的整数`, {
            errorKey: "api.admin.numeric_range",
            errorParams: { key, min, max },
          })
        }
        updates[key] = n
      }
    }
    for (const key of BOOLEAN_KEYS) {
      if (body[key] !== undefined) updates[key] = !!body[key]
    }
    if (body.defaultLang !== undefined) {
      // 必须是当前真实可用的语言（内置 zh/en 或 data/lang 里存在的文件），
      // 否则站点会指向一个不存在的语言，前端只能反复回落到中文
      const code = String(body.defaultLang || "").trim()
      if (!availableLangs().some((l) => l.code === code)) {
        throw httpError(400, "defaultLang 必须是当前可用的语言代码", {
          errorKey: "api.admin.default_lang_invalid",
        })
      }
      updates.defaultLang = code
    }
    if (body.defaultVisibility !== undefined) {
      if (typeof body.defaultVisibility !== "object" || body.defaultVisibility === null) {
        throw httpError(400, "defaultVisibility 参数格式错误", {
          errorKey: "api.admin.default_visibility_invalid",
        })
      }
      updates.defaultVisibility = {
        whitelist: cleanVisibilityPathList(body.defaultVisibility.whitelist),
        blacklist: cleanVisibilityPathList(body.defaultVisibility.blacklist),
      }
    }
    for (const group of ["memberPerms", "guestPerms"]) {
      if (body[group] !== undefined) {
        if (typeof body[group] !== "object" || body[group] === null) {
          throw httpError(400, "参数格式错误", { errorKey: "api.admin.invalid_params" })
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
      throw httpError(400, "参数格式错误（单次最多 200 个）", {
        errorKey: "api.admin.members_create_params_invalid",
      })
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
      throw httpError(400, "参数格式错误", { errorKey: "api.admin.invalid_params" })
    }
    const idList = ids.map(String)
    // 删除与禁用都要先记下身份：分享改按 userId 归属（用户名可能被改名或重建），
    // 删除/禁用之后 findById 就查不到了，必须提前取。
    const affected =
      action === "delete" || action === "disable"
        ? idList
            .map((id) => ({ id, username: findById(id)?.username || "" }))
            .filter((u) => u.username)
        : []
    const count = await batchMembers(action, idList)
    if (action === "delete") {
      for (const id of idList) {
        await removeUserFromAllGroups(id)
        await removeUserFromTodos(id)
        deleteAvatar(ownerForUser(id))
      }
    }
    // 离职成员的分享链接必须同时失效，否则链接会一直有效到过期；
    // 被禁用的账号同理（禁用的意思就是"停用这个人的一切访问"）。
    for (const u of affected) await removeSharesByOwner(u.username, u.id)
    info("members_batch", { msg: `${action} × ${count}`, ...actor(req) })
    res.json({ count })
  } catch (err) {
    next(err)
  }
})

router.post("/members/:id/password", async (req, res, next) => {
  try {
    // resetPassword() 返回 { key, message }：文案由 users.js 一处拥有
    const error = await resetPassword(String(req.params.id), String(req.body?.password || ""))
    if (error) throw httpError(400, error.message, { errorKey: error.key })
    info("members_reset_password", { msg: req.params.id, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.patch("/members/:id", async (req, res, next) => {
  try {
    const user = findById(String(req.params.id))
    if (!user) throw httpError(404, "用户不存在", { errorKey: "api.admin.user_not_found" })
    if (req.body?.username) {
      const newName = String(req.body.username).trim()
      const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/
      if (!USERNAME_RE.test(newName)) {
        throw httpError(400, "用户名需为 2-32 位字母、数字、_ . -", {
          errorKey: "api.admin.username_invalid",
        })
      }
      if (newName.toLowerCase() === env.superUser.toLowerCase()) {
        throw httpError(400, "该用户名已被超级管理员占用", { errorKey: "api.admin.username_reserved" })
      }
      const existing = findByUsername(newName)
      if (existing && existing.id !== user.id) {
        throw httpError(400, "用户名已存在", { errorKey: "api.admin.username_taken" })
      }
      user.username = newName
      await persist()
      // 分享记录上的所有者名字同步更新：链接继续有效，创建者仍然能列出/取消它
      await renameShareOwner(user.id, newName)
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
    if (!Array.isArray(ids)) throw httpError(400, "参数格式错误", { errorKey: "api.admin.invalid_params" })
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

/**
 * 导出日志。
 * 与 GET /logs 的区别：不截断（unlimited），并以附件形式下载。
 * 这也是"操作日志"从"只能在线看"变成"能交给审计/同事"的关键一步。
 */
router.get("/logs/export", async (req, res, next) => {
  try {
    const format = String(req.query.format || "jsonl").toLowerCase()
    if (format !== "jsonl" && format !== "csv") {
      throw httpError(400, "format 只能是 jsonl 或 csv", { errorKey: "api.admin.logs_format_invalid" })
    }
    const days = Math.min(Math.max(Number(req.query.days) || 5, 1), 90)
    const auditOnly = req.query.audit === "1" || req.query.audit === "true"
    const rows = await queryLogs({
      level: String(req.query.level || ""),
      q: String(req.query.q || ""),
      days,
      auditOnly,
      unlimited: true,
    })
    const body = format === "csv" ? logsToCsv(rows) : logsToJsonl(rows)
    const name = logsExportName(format, { auditOnly, days })
    res.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8")
    res.setHeader("Content-Disposition", contentDisposition("attachment", name))
    res.setHeader("Cache-Control", "no-store")
    info("logs_export", { msg: `${format} ${rows.length} 条 / ${days} 天`, ...actor(req) })
    res.send(body)
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
  "shares.json": reloadShares,
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
      // validateCustomHost() 返回 { key, message }：message 是中文原文（照搬进 error），
      // key 是命名键。这样文案由 tunnel.js 一处拥有，不需要在这里维护"文案 → 键"的映射表。
      const invalid = validateCustomHost(customHost)
      if (invalid) throw httpError(400, invalid.message, { errorKey: invalid.key })
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

// ================================================================ 回收站 =====
// 为什么放在 requireRole("superadmin") 之下：
//   删除是把内容移进一个"能还原"的暂存区，谁能看这个暂存区、谁能彻底销毁，
//   属于管理动作。成员只要有 delete 权限就照常能删（内容进回收站），
//   但浏览与还原统一由超管负责——权限面更小，也避免成员之间互相看到
//   对方删掉的文件内容。真要开放给成员，再单独加权限点，不要顺手放开。
router.get("/trash", async (_req, res, next) => {
  try {
    const items = listTrash()
    const stats = await trashStats()
    res.json({
      items,
      stats,
      enabled: getConfig().trashEnabled !== false,
      // 目录建不出来时（data/ 只读等）如实告知：此时删除不会进回收站
      available: trashAvailable(),
      retentionDays: getConfig().trashRetentionDays ?? 30,
    })
  } catch (err) {
    next(err)
  }
})

router.post("/trash/restore", async (req, res, next) => {
  try {
    const id = String(req.body?.id || "")
    const meta = getTrash(id)
    if (!meta) throw httpError(404, "回收站里找不到这个项目", { errorKey: "api.fs.trash_not_found" })
    // 还原到原路径；也可以传 dest 还原到别处（前端暂未用到，但接口留出余地）
    const targetRel = String(req.body?.dest ?? meta.rel)
    const resolved = resolveAny(normRel(targetRel))
    if (resolved.isSoft) {
      // 与 fs.js 里"只读映射目录"用同一个键：文案只有一份，避免两处各建一个同文案的键
      throw httpError(403, "外部映射目录仅支持只读操作", { errorKey: "api.fs.soft_read_only" })
    }
    const result = await restoreTrash(id, resolved, !!req.body?.overwrite)
    if (result && result.conflict) {
      return res.status(409).json({
        error: `「${meta.rel}」的位置上已经有一个同名项目。请先改名或删除它，或者选择覆盖。`,
        errorKey: "api.admin.trash_restore_conflict",
        errorParams: { name: meta.rel },
        code: "RESTORE_CONFLICT",
      })
    }
    info("backup_restore", { msg: `回收站还原 ${meta.rel}`, ...actor(req) })
    res.json({ ok: true, restored: resolved.rel })
  } catch (err) {
    next(err)
  }
})

router.post("/trash/purge", async (req, res, next) => {
  try {
    const id = String(req.body?.id || "")
    const meta = getTrash(id)
    if (!meta) throw httpError(404, "回收站里找不到这个项目", { errorKey: "api.fs.trash_not_found" })
    await purgeTrash(id)
    info("trash_purge", { msg: meta.rel, ...actor(req) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.post("/trash/empty", async (req, res, next) => {
  try {
    const n = await emptyTrash()
    info("trash_empty", { msg: `${n} 项`, ...actor(req) })
    res.json({ ok: true, removed: n })
  } catch (err) {
    next(err)
  }
})

export default router
