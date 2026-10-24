import fs from "node:fs"
import path from "node:path"
import express from "express"
import cookieParser from "cookie-parser"
import { env, FILES_DIR, NOLOG, SOFT_DIR_NAMES, WEB_DIST } from "./src/env.js"
import { attachAuth, csrfGuard } from "./src/auth.js"
import { attachContext } from "./src/context.js"
import { getConfig, reloadConfig } from "./src/config.js"
import { error as logError, info, sweepLogs, warn } from "./src/logger.js"
import { applyTunnelConfig, stopTunnel } from "./src/tunnel.js"
import { createWebdavRouter, webdavStartupNotice } from "./src/webdav.js"
import { lanAddresses } from "./src/status.js"
import { runIntegrityCheck } from "./src/integrity.js"
import { sweepTrash } from "./src/trash.js"
import { reloadUsers } from "./src/users.js"
import { reloadGroups } from "./src/groups.js"
import { reloadTodos } from "./src/todos.js"
import { initAvatars } from "./src/avatars.js"
import { runDailySnapshot } from "./src/backup.js"
import { metricsMiddleware, startMetrics, stopMetrics } from "./src/metrics.js"
import authRoutes from "./src/routes/auth.js"
import fsRoutes, { SAVE_FILE_MAX_BYTES } from "./src/routes/fs.js"
import adminRoutes from "./src/routes/admin.js"
import avatarRoutes from "./src/routes/avatars.js"
import todoRoutes from "./src/routes/todos.js"
import groupRoutes from "./src/routes/groups.js"
import i18nRoutes from "./src/routes/i18n.js"
import { customLangCodes, ensureLangDir } from "./src/i18n.js"
import { flushShareStats, pruneShares, reloadShares } from "./src/shares.js"
import { createStaticCompressor } from "./src/compress.js"
import { SHELL_CSP } from "./src/csp.js"
import { adminShareRouter, manageShareRouter, publicShareRouter } from "./src/routes/shares.js"

// 启动自检：隔离损坏的 JSON、清理 tmp 残留，然后重载内存态
const integrity = runIntegrityCheck()
reloadConfig()
reloadUsers()
reloadGroups()
reloadTodos()
reloadShares()
const avatarInit = initAvatars()
// 界面语言目录（data/lang）：首次运行时建目录并写入格式说明
ensureLangDir()
runDailySnapshot()
// 分享记录：过期 30 天以上的物理清理（失败不影响启动）
pruneShares().catch(() => {})

const app = express()
app.disable("x-powered-by")

// 反向代理 / SSH 隧道场景下取真实客户端 IP。默认不信任代理头（与旧行为一致）：
// 只有确认服务只经可信代理暴露时才设置 TRUST_PROXY，否则客户端可伪造
// X-Forwarded-For 绕过 IP 限速、污染日志。
if (env.trustProxy !== false) {
  app.set("trust proxy", env.trustProxy)
}

// 健康检查：最简裸响应，验证隧道代理可达
app.get("/ping", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.end("pong")
})

// 请求日志：诊断隧道请求（-nolog 时只写文件不打印到控制台）
app.use((req, _res, next) => {
  if (!NOLOG && req.path !== "/favicon.ico" && req.path !== "/resources/lucide.min.js") {
    console.log(`[REQ] ${req.method} ${req.path} host=${req.headers.host} ip=${req.ip} ua=${(req.headers["user-agent"] || "").slice(0, 40)}`)
  }
  next()
})

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "SAMEORIGIN")
  res.setHeader("Referrer-Policy", "no-referrer")
  // 网盘不需要摄像头/麦克风/定位等能力，一律关闭（不影响剪贴板复制等既有功能）
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()")
  next()
})

app.use(cookieParser())

// 全局限流：防止隧道代理场景下的 TCP 缓冲问题
app.use((req, _res, next) => {
  if (req.socket) req.socket.setNoDelay(true)
  next()
})

// 请求指标采集（不阻塞请求，异常一律吞掉）
app.use(metricsMiddleware)

// ===== WebDAV（v2.0 起为正式功能；开关与挂载点在后台「设置 → 公网 → WebDAV」，实时生效）=====
// 位置很关键，三个约束同时成立：
//   1. 必须挂在 body parser **之前**。WebDAV 的 PUT 是原始请求体，而 body-parser
//      对 PUT 同样生效：一旦被 express.json() 读完，req 流就到底了，DAV 的
//      `req.pipe(ws)` 只会写出 0 字节并以 204 成功返回 —— 用户看到"保存成功"，
//      文件却被清空（静默数据丢失）。
//   2. 必须挂在静态托管与 SPA fallback **之前**，否则 /dav/ 会被 fallback 吞掉、
//      返回前端首页（浏览器里表现为"打开 /dav/ 看到网盘界面"）。
//   3. 中间件本身负责"是否命中挂载点"与"是否启用"的判断（挂载点可在后台改），
//      所以这里**无条件挂载**；未启用时它自己回 404，不会落到 fallback。
app.use(createWebdavRouter())

app.use(attachAuth)
app.use(attachContext)
app.use("/api", csrfGuard)

// body 解析刻意放在鉴权与 CSRF 之后：否则任何**未登录**者都能强迫服务把 16MB
// 请求体解析成 JSON（/api/fs/save-file 是单独放宽的端点），几个并发请求就能把
// 单核 CPU 打满。放到 csrfGuard 之后，未带自定义头的跨站请求连解析都触发不了。
// body-parser 解析成功后会标记 req._body，后面的解析器不会重复解析。
app.use("/api/fs/save-file", express.json({ limit: SAVE_FILE_MAX_BYTES }))
app.use(express.json({ limit: "1mb" }))

app.get("/api/meta", (_req, res) => {
  res.json({ name: "ZeroShadow", version: "2.0.0-beta" })
})

app.use("/api/auth", authRoutes)
app.use("/api/fs", fsRoutes)
// 分享：公开访问（/api/share）与登录用户管理（/api/shares）分开挂载，
// 管理员总览（/api/admin/shares）必须放在 /api/admin 之前，否则会被超管守卫拦下后
// 落进 adminRoutes 的 404 分支（Router 里没有匹配的路由并不会自动继续往下找）。
app.use("/api/share", publicShareRouter)
app.use("/api/shares", manageShareRouter)
app.use("/api/admin/shares", adminShareRouter)
app.use("/api/admin", adminRoutes)
app.use("/api/avatars", avatarRoutes)
app.use("/api/todos", todoRoutes)
app.use("/api/groups", groupRoutes)
// 界面语言清单与语言文件：必须免登录（登录页自己也要显示语言选择器）
app.use("/api/i18n", i18nRoutes)

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "接口不存在", errorKey: "api.common.not_found" })
})

// ===== WebDAV 已在上方（body parser 之前）挂载 =====
// 之所以不在这个位置挂：见前面对 "PUT 被 body parser 吃掉" 的说明。

// 应用外壳的 CSP：脚本只允许同源文件（构建产物 index.html 无内联脚本），样式
// 保留 inline 以兼容 UI 库注入的 <style>；允许本站把预览页放进 iframe。
// 常量放在 csp.js，压缩中间件那条出口也要用同一份（见 compress.js）。


if (fs.existsSync(WEB_DIST)) {
  // 兼容模式（web/public/robustness/）是独立于前端的静态页，这里必须显式处理：
  //   1. 它是个目录，而 express.static 配了 index:false，直接访问 /robustness/
  //      拿不到 index.html，会落到下面的 SPA fallback —— 表现就是"打开兼容模式
  //      却跳回了首页"，非常难查。所以把目录形式重定向到具体文件。
  //   2. 文件还不存在时（public/ 的改动尚未 pnpm build，没被复制进 dist），
  //      旧行为同样是静默回落到 SPA 首页。这里改成明确的 503 提示。
  const ROBUSTNESS_FILE = path.join(WEB_DIST, "robustness", "index.html")
  app.get(["/robustness", "/robustness/"], (_req, res) => {
    res.redirect(302, "/robustness/index.html")
  })
  app.get("/robustness/index.html", (_req, res, next) => {
    if (fs.existsSync(ROBUSTNESS_FILE)) return next()
    res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send("兼容模式页面尚未生成：请先运行 pnpm build（会把 web/public/robustness/ 复制到 web/dist/），然后重启服务。")
  })

  // 文本资源压缩（gzip / brotli）：必须挂在 express.static 之前。
  // 只接管"能压缩的静态文件"，其余请求 next() 交回静态托管，既有行为不变。
  app.use(createStaticCompressor(WEB_DIST))

  app.use(
    express.static(WEB_DIST, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.toLowerCase().endsWith(".html")) {
          res.setHeader("Content-Security-Policy", SHELL_CSP)
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
        } else if (filePath.includes(`${path.sep}resources${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=86400")
        } else {
          res.setHeader("Cache-Control", "no-cache")
        }
      },
    })
  )
  // 说明：WebDAV 的"未启用时 404"已经由前面的 createWebdavRouter() 中间件处理
  // （它挂在 body parser 之前，未启用时会在命中挂载点时直接回 404 JSON），
  // 因此这里**不再需要**一段静态的 404 兜底 —— 也就不会出现"改了后台开关但仍
  // 旧行为"的两套逻辑。

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next()
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Content-Security-Policy", SHELL_CSP)
    res.sendFile(path.join(WEB_DIST, "index.html"))
  })
} else {
  app.get("*", (_req, res) => {
    res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send("前端尚未构建：请先运行 pnpm build，然后重启服务。")
  })
}

app.use((err, req, res, _next) => {
  const status = err.status || 500
  if (status >= 500) {
    logError("server_error", { msg: `${req.method} ${req.path}: ${err.message}`, ip: req.ip })
  }
  if (res.headersSent) return res.destroy()
  const body = { error: status >= 500 ? "服务器内部错误" : err.message }
  if (status >= 500) body.errorKey = "api.common.server_error"
  // 少数错误需要带上结构化信息让前端能做后续动作，例如并发编辑冲突要告诉
  // 客户端"服务器上的当前版本是哪个"（前端据此提供"重新加载"）。
  // 这里刻意只在 err.code 存在时透传，避免把任意错误对象的字段泄漏出去。
  if (err.code) {
    body.code = String(err.code)
    if (err.currentVersion !== undefined) body.currentVersion = err.currentVersion
  }
  // errorKey / errorParams 是给前端做本地化用的（见 src/http.js 的 httpError）：
  // 有了它们，界面能把 "文件过大（…）" 这类提示按当前语言渲染，
  // 同时 error 字段仍然是中文原文，老客户端与脚本不受影响。
  if (err.errorKey) {
    body.errorKey = String(err.errorKey)
    if (err.errorParams && typeof err.errorParams === "object") body.errorParams = err.errorParams
  }
  res.status(status).json(body)
})

const server = app.listen(env.port, env.host, () => {
  info("server_start", { msg: `ZeroShadow 已启动，端口 ${env.port}` })
  if (integrity.issues.length) {
    info("integrity_summary", { msg: integrity.issues.map((i) => `${i.name}:${i.status}`).join(", ") })
  }
  startMetrics().catch(() => {})
  sweepLogs().catch(() => {})
  const maintenance = setInterval(() => {
    sweepLogs().catch(() => {})
    sweepTrash().catch(() => {})
    pruneShares().catch(() => {})
    runDailySnapshot()
  }, 6 * 60 * 60 * 1000)
  maintenance.unref?.()
  // 启动时也清一次回收站：长时间不重启的实例靠定时器，频繁重启的实例靠这里
  sweepTrash().catch(() => {})
  if (!NOLOG) {
    console.log("")
    console.log("  ZeroShadow 网盘已启动")
    console.log(`  本机访问:   http://localhost:${env.port}`)
    for (const addr of lanAddresses()) {
      console.log(`  局域网访问: http://${addr}:${env.port}`)
    }
    console.log(`  文件目录:   ${FILES_DIR}`)
    const davNotice = webdavStartupNotice()
    if (davNotice) console.log(`  ${davNotice}`)
    if (avatarInit.removed) console.log(`  头像清理:   移除 ${avatarInit.removed} 个不合规文件`)
    if (env.trustProxy === false) {
      console.log("  客户端 IP:  直连（不信任代理头）")
    } else {
      const shown = typeof env.trustProxy === "string" ? env.trustProxy : String(env.trustProxy)
      console.log(`  客户端 IP:  信任代理头 ${shown}`)
      info("trust_proxy", { msg: `信任代理头: ${shown}` })
    }
    if (SOFT_DIR_NAMES.length) {
      console.log(`  外部映射:   ${SOFT_DIR_NAMES.join(", ")}（只读）`)
    }
    const customLangs = customLangCodes()
    if (customLangs.length) {
      console.log(`  界面语言:   zh, en, ${customLangs.join(", ")}（data/lang）`)
    }
    // 放宽了 SSRF 防护时显式提醒，避免"以为还拦着内网"
    const relaxed = []
    const TRUE_RE = /^(1|true|yes|on)$/i
    if (TRUE_RE.test(String(process.env.DOWNLOAD_URL_ALLOW_PRIVATE || "").trim())) relaxed.push("允许链接下载访问内网地址")
    if (TRUE_RE.test(String(process.env.DOWNLOAD_URL_INSECURE_TLS || "").trim())) relaxed.push("跳过下载时的 TLS 证书校验")
    if (relaxed.length) {
      console.log(`  [注意] 链接下载工具已放宽限制: ${relaxed.join("、")}`)
      warn("download_url_relaxed", { msg: relaxed.join("、") })
    }
    if (env.generatedPassword) {
      console.log("")
      console.log(`  [重要] 已自动生成超级管理员密码并写入 .env：`)
      console.log(`         用户名: ${env.superUser}`)
      console.log(`         密码:   ${env.generatedPassword}`)
    }
    console.log("")
  }
  const tunnel = getConfig().tunnel
  if (tunnel.enabled) applyTunnelConfig(tunnel)
})

// 进程级兜底：未处理的 Promise 拒绝在 Node 15+ 默认是致命错误 —— 一次失败的上传
// 清理（例如磁盘写满后 rm 也失败）就足以让局域网里所有人的网盘同时断线。
// 这里只记录、不退出，优先保证服务可用性。
process.on("unhandledRejection", (reason) => {
  try {
    logError("unhandled_rejection", { msg: reason instanceof Error ? reason.message : String(reason) })
  } catch { /* 日志失败也不能再抛 */ }
})
process.on("uncaughtException", (err) => {
  // 刻意不退出：本项目没有进程管理器（无 Docker / 无 pm2），退出即全员断线。
  // 详情写进日志，便于通过后台「日志与指标」排查。
  try {
    logError("uncaught_exception", { msg: err?.message || String(err), stack: err?.stack })
  } catch { /* 同上 */ }
})

function shutdown() {
  stopTunnel()
  stopMetrics()
  // 分享访问统计是节流落盘的：退出前补一次，避免最后几十秒的计数丢失
  void flushShareStats()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
