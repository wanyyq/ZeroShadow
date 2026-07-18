import { Router } from "express"
import { env } from "../env.js"
import { requireRole } from "../auth.js"
import { getConfig, saveConfig } from "../config.js"
import { batchMembers, createMembers, findById, findByUsername, listMembers, persist, resetPassword } from "../users.js"
import { getStatus } from "../status.js"
import { applyTunnelConfig, tunnelStatus, validateCustomHost } from "../tunnel.js"
import { clearLogs, info, queryLogs } from "../logger.js"

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

router.get("/config", (_req, res) => {
  res.json(getConfig())
})

router.patch("/config", async (req, res, next) => {
  try {
    const body = req.body || {}
    const updates = {}
    for (const key of ["superUploadLimitMB", "memberUploadLimitMB"]) {
      if (body[key] !== undefined) {
        const n = Number(body[key])
        if (!Number.isInteger(n) || n < 1 || n > 1048576) {
          throw httpError(400, "上传限制需为 1-1048576 之间的整数 (MB)")
        }
        updates[key] = n
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
      if (updates.superUploadLimitMB) draft.superUploadLimitMB = updates.superUploadLimitMB
      if (updates.memberUploadLimitMB) draft.memberUploadLimitMB = updates.memberUploadLimitMB
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
      draft.guestHiddenPaths = draft.guestHiddenPaths.filter(
        (h) => h.toLowerCase() !== target.toLowerCase()
      )
    })
    info("guest_visibility", { msg: `${target} 已对访客可见`, ...actor(req) })
    res.json(config)
  } catch (err) {
    next(err)
  }
})

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
    const count = await batchMembers(action, ids.map(String))
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
      // 仅校验用户名格式（密码已存在，无需重复校验）
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

router.get("/logs", async (req, res, next) => {
  try {
    const rows = await queryLogs({
      limit: req.query.limit,
      level: String(req.query.level || ""),
      q: String(req.query.q || ""),
    })
    res.json({ logs: rows })
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
    const mode = body.mode === "custom" ? "custom" : body.mode === "localhostrun" ? "localhostrun" : "serveo"
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
