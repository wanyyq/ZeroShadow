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
import { lanAddresses } from "./src/status.js"
import { runIntegrityCheck } from "./src/integrity.js"
import { reloadUsers } from "./src/users.js"
import { reloadGroups } from "./src/groups.js"
import { reloadTodos } from "./src/todos.js"
import { initAvatars } from "./src/avatars.js"
import { runDailySnapshot } from "./src/backup.js"
import { metricsMiddleware, startMetrics, stopMetrics } from "./src/metrics.js"
import authRoutes from "./src/routes/auth.js"
import fsRoutes from "./src/routes/fs.js"
import adminRoutes from "./src/routes/admin.js"
import avatarRoutes from "./src/routes/avatars.js"
import todoRoutes from "./src/routes/todos.js"
import groupRoutes from "./src/routes/groups.js"

// 启动自检：隔离损坏的 JSON、清理 tmp 残留，然后重载内存态
const integrity = runIntegrityCheck()
reloadConfig()
reloadUsers()
reloadGroups()
reloadTodos()
const avatarInit = initAvatars()
runDailySnapshot()

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
app.use(express.json({ limit: "1mb" }))

// 全局限流：防止隧道代理场景下的 TCP 缓冲问题
app.use((req, _res, next) => {
  if (req.socket) req.socket.setNoDelay(true)
  next()
})

// 请求指标采集（不阻塞请求，异常一律吞掉）
app.use(metricsMiddleware)

app.use(attachAuth)
app.use(attachContext)
app.use("/api", csrfGuard)

app.get("/api/meta", (_req, res) => {
  res.json({ name: "ZeroShadow", version: "1.1.0" })
})

app.use("/api/auth", authRoutes)
app.use("/api/fs", fsRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/avatars", avatarRoutes)
app.use("/api/todos", todoRoutes)
app.use("/api/groups", groupRoutes)

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "接口不存在" })
})

// 应用外壳的 CSP：脚本只允许同源文件（构建产物 index.html 无内联脚本），样式
// 保留 inline 以兼容 UI 库注入的 <style>；允许本站把预览页放进 iframe。
// 注意：这里只作用于前端文档，/api 响应不受影响（上传内容走 fs.js 里独立的
// sandbox 策略）。
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ")

if (fs.existsSync(WEB_DIST)) {
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
  res.status(status).json({ error: status >= 500 ? "服务器内部错误" : err.message })
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
    runDailySnapshot()
  }, 6 * 60 * 60 * 1000)
  maintenance.unref?.()
  if (!NOLOG) {
    console.log("")
    console.log("  ZeroShadow 网盘已启动")
    console.log(`  本机访问:   http://localhost:${env.port}`)
    for (const addr of lanAddresses()) {
      console.log(`  局域网访问: http://${addr}:${env.port}`)
    }
    console.log(`  文件目录:   ${FILES_DIR}`)
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

function shutdown() {
  stopTunnel()
  stopMetrics()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
