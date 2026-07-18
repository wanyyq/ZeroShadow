import fs from "node:fs"
import path from "node:path"
import express from "express"
import cookieParser from "cookie-parser"
import { env, FILES_DIR, TMP_DIR, WEB_DIST } from "./src/env.js"
import { attachAuth, csrfGuard } from "./src/auth.js"
import { getConfig } from "./src/config.js"
import { error as logError, info } from "./src/logger.js"
import { applyTunnelConfig, stopTunnel } from "./src/tunnel.js"
import { lanAddresses } from "./src/status.js"
import authRoutes from "./src/routes/auth.js"
import fsRoutes from "./src/routes/fs.js"
import adminRoutes from "./src/routes/admin.js"

for (const name of fs.readdirSync(TMP_DIR)) {
  try {
    fs.rmSync(path.join(TMP_DIR, name), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const app = express()
app.disable("x-powered-by")

// 健康检查：最简裸响应，验证隧道代理可达
app.get("/ping", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.end("pong")
})

// 请求日志：诊断隧道请求
app.use((req, _res, next) => {
  if (req.path !== "/favicon.ico" && req.path !== "/resources/lucide.min.js") {
    console.log(`[REQ] ${req.method} ${req.path} host=${req.headers.host} ua=${(req.headers["user-agent"] || "").slice(0, 40)}`)
  }
  next()
})

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "SAMEORIGIN")
  res.setHeader("Referrer-Policy", "no-referrer")
  next()
})

app.use(cookieParser())
app.use(express.json({ limit: "1mb" }))

// 全局限流：防止隧道代理场景下的 TCP 缓冲问题
app.use((req, _res, next) => {
  if (req.socket) req.socket.setNoDelay(true)
  next()
})

app.use(attachAuth)
app.use("/api", csrfGuard)

app.get("/api/meta", (_req, res) => {
  res.json({ name: "ZeroShadow", version: "1.0.0" })
})

app.use("/api/auth", authRoutes)
app.use("/api/fs", fsRoutes)
app.use("/api/admin", adminRoutes)

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "接口不存在" })
})

if (fs.existsSync(WEB_DIST)) {
  app.use(
    express.static(WEB_DIST, {
      index: false,
      setHeaders(res, filePath) {
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
  console.log("")
  console.log("  ZeroShadow 网盘已启动")
  console.log(`  本机访问:   http://localhost:${env.port}`)
  for (const addr of lanAddresses()) {
    console.log(`  局域网访问: http://${addr}:${env.port}`)
  }
  console.log(`  文件目录:   ${FILES_DIR}`)
  if (env.generatedPassword) {
    console.log("")
    console.log(`  [重要] 已自动生成超级管理员密码并写入 .env：`)
    console.log(`         用户名: ${env.superUser}`)
    console.log(`         密码:   ${env.generatedPassword}`)
  }
  console.log("")
  const tunnel = getConfig().tunnel
  if (tunnel.enabled) applyTunnelConfig(tunnel)
})

function shutdown() {
  stopTunnel()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
