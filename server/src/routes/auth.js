import { Router } from "express"
import { env } from "../env.js"
import {
  COOKIE_NAME,
  cookieOptions,
  isSuperUser,
  loginLocked,
  recordLoginFail,
  recordLoginSuccess,
  requirePerm,
  requireRole,
  signToken,
  verifySuperPassword,
} from "../auth.js"
import { effectivePerms, saveConfig, uploadLimitMB } from "../config.js"
import bcrypt from "bcryptjs"
import { verifyLogin, findById, resetPassword, revokeSessions } from "../users.js"
import { groupsForUser, listGroups } from "../groups.js"
import { filesystemCaseInsensitive } from "../safety.js"
import { rateLimit } from "../ratelimit.js"
import { info, warn } from "../logger.js"
import { httpError } from "../http.js"

const router = Router()

// 登录也要限流：账户锁定表虽然已经有了硬上限（见 auth.js 的 evictOldest），
// 但没有限流时仍可被用于制造大量无效请求 / 反复触发 bcrypt 比对。
// 上限沿用后台可调的 rateLimitPerMin（默认 120/分钟，按 IP 计），
// 对"整个局域网共用一个出口 IP"的场景也足够宽松。
router.post("/login", rateLimit, async (req, res) => {
  const username = String(req.body?.username || "").trim()
  const password = String(req.body?.password || "")
  if (!username || !password) {
    return res.status(400).json({ error: "请输入用户名和密码", errorKey: "api.auth.login_missing_credentials" })
  }
  if (username.length > 64 || password.length > 256) {
    return res.status(400).json({ error: "用户名或密码格式不正确", errorKey: "api.auth.login_format_invalid" })
  }

  const lockedResponse = (minutes) =>
    res.status(429).json({
      error: `尝试次数过多，请约 ${minutes} 分钟后再试`,
      errorKey: "api.auth.login_locked",
      errorParams: { minutes },
    })

  // ---- 超管：先验口令，再判锁定 ----
  // 顺序反过来的话，任何人用**错误的**密码打 10 次就能把唯一的超管账号锁死
  // 5→30 分钟且可无限续期，而超管是唯一能改配置的人 —— 一次匿名 DoS 就让后台
  // 彻底不可用（安全审计 M9）。先验口令保证"口令正确永远能进"，猜错的照旧会被
  // IP 与账号两个维度锁定（账号维度与 IP 无关，伪造 X-Forwarded-For 也绕不过）。
  // 注意这里只对超管调整顺序：成员路径若先跑 bcrypt，锁定期间每个请求都会
  // 触发一次 cost-10 哈希，反而成了 CPU DoS 放大器。
  const superUser = isSuperUser(username)
  if (superUser) {
    if (!verifySuperPassword(password)) {
      const lockedMinutes = loginLocked(req.ip, username)
      if (lockedMinutes) return lockedResponse(lockedMinutes)
      recordLoginFail(req.ip, username)
      warn("login_fail", { msg: "超管口令错误", user: username, ip: req.ip })
      return res.status(401).json({ error: "用户名或密码错误", errorKey: "api.auth.login_invalid_credentials" })
    }
  } else {
    const lockedMinutes = loginLocked(req.ip, username)
    if (lockedMinutes) return lockedResponse(lockedMinutes)
  }

  let auth = null
  if (superUser) {
    auth = { role: "superadmin", username: env.superUser }
  } else {
    const result = await verifyLogin(username, password)
    if (result.ok) {
      auth = {
        role: "member",
        username: result.user.username,
        userId: result.user.id,
        tokenVersion: result.user.tokenVersion,
      }
    } else if (result.reason === "disabled") {
      warn("login_fail", { msg: "账户已被禁用", user: username, ip: req.ip })
      return res.status(403).json({ error: "该账户已被禁用", errorKey: "api.auth.account_disabled" })
    }
  }

  if (!auth) {
    recordLoginFail(req.ip, username)
    warn("login_fail", { msg: "用户名或密码错误", user: username, ip: req.ip })
    return res.status(401).json({ error: "用户名或密码错误", errorKey: "api.auth.login_invalid_credentials" })
  }

  recordLoginSuccess(req.ip, username)
  res.cookie(COOKIE_NAME, signToken(auth), cookieOptions(req))
  info("login_success", { user: auth.username, role: auth.role, ip: req.ip })
  res.json({ role: auth.role, username: auth.username })
})

router.post("/change-password", requireRole("superadmin", "member"), requirePerm("changePassword"), async (req, res, next) => {
  try {
    const oldPwd = String(req.body?.oldPassword || "")
    const newPwd = String(req.body?.newPassword || "")
    if (!oldPwd || !newPwd) {
      throw httpError(400, "请输入旧密码和新密码", { errorKey: "api.auth.change_password_missing" })
    }
    if (newPwd.length < 6 || newPwd.length > 128) {
      throw httpError(400, "新密码长度需为 6-128 位", { errorKey: "api.auth.new_password_length_invalid" })
    }

    if (req.auth.role === "superadmin") {
      throw httpError(400, "超级管理员密码请直接编辑 .env 中 SUPER_ADMIN_PASSWORD，改后重启服务生效", {
        errorKey: "api.auth.superadmin_password_env",
      })
    }

    const user = findById(req.auth.userId)
    if (!user) throw httpError(404, "用户不存在", { errorKey: "api.auth.user_not_found" })
    const ok = await bcrypt.compare(oldPwd, user.passwordHash)
    if (!ok) throw httpError(403, "旧密码错误", { errorKey: "api.auth.old_password_incorrect" })

    // resetPassword() 返回 { key, message }：文案由 users.js 一处拥有
    const error = await resetPassword(req.auth.userId, newPwd)
    if (error) throw httpError(400, error.message, { errorKey: error.key })
    res.clearCookie(COOKIE_NAME, { path: "/" })
    info("password_change", { user: req.auth.username, role: req.auth.role })
    res.json({ ok: true, message: "密码已修改，请重新登录" })
  } catch (err) {
    next(err)
  }
})

router.post("/logout", requireRole("superadmin", "member"), async (req, res, next) => {
  try {
    // 只清 Cookie 是不够的：JWT 是无状态的，已经发出去的令牌在有效期内
    // （默认 72 小时）仍然可用，被窃取后"登出"等于无效操作。这里做真正的吊销：
    //   - 成员：tokenVersion + 1（与改密/禁用共用同一条吊销路径）；
    //   - 超管：会话代次 + 1，旧令牌的 `se` 对不上即失效。
    if (req.auth.role === "superadmin") {
      await saveConfig((draft) => {
        draft.superSessionEpoch = (Number(draft.superSessionEpoch) || 0) + 1
      })
    } else if (req.auth.userId) {
      await revokeSessions(req.auth.userId)
    }
    res.clearCookie(COOKIE_NAME, { path: "/" })
    info("logout", { user: req.auth.username, role: req.auth.role, ip: req.ip })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

function publicGroup(g) {
  return { id: g.id, name: g.name, color: g.color, leaders: g.leaders }
}

/** 当前用户可切换的小组上下文（超管可切换全部） */
router.get("/groups", (req, res) => {
  if (req.auth.role === "superadmin") {
    res.json({ groups: listGroups().map(publicGroup) })
  } else if (req.auth.role === "member") {
    res.json({ groups: groupsForUser(req.auth.userId).map(publicGroup) })
  } else {
    res.json({ groups: [] })
  }
})

router.get("/me", (req, res) => {
  const { role, username } = req.auth
  res.json({
    role,
    username,
    userId: req.auth.userId || null,
    perms: req.perms || effectivePerms(role, req.group),
    uploadLimitMB: uploadLimitMB(role),
    groupId: req.groupId || "default",
    group: req.group ? publicGroup(req.group) : null,
    // 文件系统是否不区分大小写：前端做同名冲突检测时必须用与服务端一致的规则，
    // 否则跨平台部署时会出现"界面说冲突、服务端不冲突"这类分叉（见 safety.js）。
    caseInsensitive: filesystemCaseInsensitive(),
  })
})

export default router
