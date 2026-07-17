import { spawn } from "node:child_process"
import { env } from "./env.js"
import { info, warn } from "./logger.js"

const HOST_RE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?$/

const state = {
  proc: null,
  running: false,
  desired: false,
  url: null,
  output: [],
  startedAt: null,
  restarts: 0,
  lastExit: null,
  restartTimer: null,
  backoffMs: 5000,
}

function pushOutput(line) {
  const text = line.trim()
  if (!text) return
  state.output.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${text}`)
  if (state.output.length > 120) state.output.splice(0, state.output.length - 120)
  const match = text.match(/https?:\/\/[^\s"']+/)
  if (match && /serveo|forward|tunnel/i.test(text)) {
    state.url = match[0]
    info("tunnel_url", { msg: `公网地址: ${state.url}` })
  }
}

export function validateCustomHost(host) {
  const value = String(host || "").trim()
  if (!value) return "请填写 SSH 目标，例如 user@example.com"
  if (value.startsWith("-")) return "SSH 目标格式无效"
  if (!HOST_RE.test(value)) return "SSH 目标格式无效，仅支持 user@host 或 user@host:端口"
  return null
}

function buildArgs(tunnelCfg) {
  const args = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=60",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "BatchMode=yes",
    "-N",
    "-R", `80:localhost:${env.port}`,
  ]
  if (tunnelCfg.mode === "custom") {
    let target = tunnelCfg.customHost.trim()
    const portMatch = target.match(/^(.*):(\d{1,5})$/)
    if (portMatch) {
      target = portMatch[1]
      args.push("-p", portMatch[2])
    }
    args.push(target)
  } else {
    args.push("serveo.net")
  }
  return args
}

function clearRestartTimer() {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer)
    state.restartTimer = null
  }
}

function scheduleRestart(tunnelCfg) {
  clearRestartTimer()
  if (!state.desired) return
  state.restartTimer = setTimeout(() => {
    state.restarts += 1
    state.backoffMs = Math.min(state.backoffMs * 2, 60000)
    launch(tunnelCfg)
  }, state.backoffMs)
}

function launch(tunnelCfg) {
  if (!state.desired || state.proc) return
  const args = buildArgs(tunnelCfg)
  let proc
  try {
    proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  } catch (err) {
    pushOutput(`无法启动 ssh: ${err.message}`)
    warn("tunnel_error", { msg: `无法启动 ssh: ${err.message}` })
    scheduleRestart(tunnelCfg)
    return
  }
  state.proc = proc
  state.running = true
  state.startedAt = Date.now()
  state.url = tunnelCfg.mode === "serveo" ? null : state.url
  pushOutput(`ssh ${args.join(" ")}`)
  info("tunnel_start", { msg: `模式: ${tunnelCfg.mode}` })

  const onData = (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) pushOutput(line)
  }
  proc.stdout.on("data", onData)
  proc.stderr.on("data", onData)
  proc.on("error", (err) => {
    pushOutput(`ssh 错误: ${err.message}`)
  })
  proc.on("exit", (code, signal) => {
    state.proc = null
    state.running = false
    state.url = null
    state.lastExit = { code, signal, at: Date.now() }
    pushOutput(`ssh 已退出 (code=${code ?? "-"} signal=${signal ?? "-"})`)
    if (state.desired) {
      warn("tunnel_exit", { msg: `隧道断开，${Math.round(state.backoffMs / 1000)}s 后重连` })
      scheduleRestart(tunnelCfg)
    } else {
      info("tunnel_stop", {})
    }
  })
}

export function applyTunnelConfig(tunnelCfg) {
  const shouldRun = !!tunnelCfg.enabled
  state.desired = shouldRun
  clearRestartTimer()
  if (!shouldRun) {
    if (state.proc) {
      const proc = state.proc
      state.proc = null
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
    }
    state.running = false
    state.url = null
    return
  }
  state.backoffMs = 5000
  if (state.proc) {
    const proc = state.proc
    state.proc = null
    proc.removeAllListeners("exit")
    proc.on("exit", () => {
      state.running = false
      launch(tunnelCfg)
    })
    try {
      proc.kill()
    } catch {
      state.running = false
      launch(tunnelCfg)
    }
  } else {
    launch(tunnelCfg)
  }
}

export function tunnelStatus() {
  return {
    running: state.running,
    url: state.url,
    output: state.output.slice(-40),
    startedAt: state.startedAt,
    restarts: state.restarts,
    lastExit: state.lastExit,
  }
}

export function stopTunnel() {
  state.desired = false
  clearRestartTimer()
  if (state.proc) {
    try {
      state.proc.kill()
    } catch {
      /* ignore */
    }
    state.proc = null
  }
  state.running = false
}
