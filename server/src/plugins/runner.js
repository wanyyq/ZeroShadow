import { spawn } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { DATA_DIR } from "../env.js"
import { httpError } from "../http.js"
import { warn, info } from "../logger.js"

/** 插件包根目录。这里自己拼而不从 store.js 导入，避免 runner ↔ store 循环依赖。 */
const PLUGIN_DIR = path.join(DATA_DIR, "plugins")

// ============================================================================
//  plugins/runner.js - `server` 类插件的运行时（**独立子进程**）
//
//  这里必须说清楚一件事：**这不是安全沙箱，而是故障隔离**。
//  子进程与主进程同一个操作系统用户，一个恶意插件理论上能读写它能碰到的任何文件。
//  因此本文件的定位是：
//     - 崩溃不进主进程：插件抛错/挂死/内存爆掉，主进程只看到"子进程退出了"；
//     - 环境变量**白名单**：只给 PATH / TEMP 这类必需项，绝不给 JWT_SECRET 与配置；
//     - 只认清单里声明的 `actions`：宿主不会把任意方法名转给插件；
//     - 有超时与输出上限，挂住的动作会被杀掉而不是拖死请求。
//  真正的安全边界是"只安装你信任的插件"，文档里也这么写。
//
//  协议（stdin/stdout 各一行 JSON，`apiVersion: 1`）：
//      host → plugin  {"type":"init","apiVersion":1,"settings":{...}}
//      plugin → host  {"type":"ready"}
//      host → plugin  {"type":"action","id":1,"action":"foo","params":{...}}
//      plugin → host  {"type":"result","id":1,"ok":true,"data":{...}}   （失败时 ok:false,error:"..."）
//      host → plugin  {"type":"shutdown"}
// ============================================================================

/** 单次动作的默认/最大超时（毫秒） */
const ACTION_TIMEOUT_MS = 5000
const ACTION_TIMEOUT_MAX_MS = 30000
/** 启动（等 ready）超时 */
const READY_TIMEOUT_MS = 10000
/** 单行输出上限：防止插件往 stdout 灌垃圾把内存吃光 */
const MAX_LINE_BYTES = 256 * 1024
/** 空闲多久后回收子进程 */
const IDLE_STOP_MS = 60 * 1000
/** stderr 只留最后这么多行做诊断 */
const STDERR_KEEP = 20

/** 传给子进程的环境变量白名单（别的一律不带） */
function childEnv(id) {
  const allow = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]
  const env = { ZS_PLUGIN: "1", ZS_PLUGIN_ID: id, ZS_PLUGIN_API_VERSION: "1" }
  for (const key of allow) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

/** @type {Map<string, Instance>} */
const running = new Map()

function alive(inst) {
  return !!inst?.proc && inst.proc.exitCode === null && !inst.proc.killed
}

function rejectAll(inst, message) {
  for (const [, pending] of inst.pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
  }
  inst.pending.clear()
}

function kill(inst, reason) {
  if (!inst) return
  rejectAll(inst, reason || "插件进程已停止")
  clearTimeout(inst.idleTimer)
  try {
    inst.proc?.kill()
  } catch {
    /* 已经退出 */
  }
  running.delete(inst.id)
  if (inst.stderr.length) {
    warn("plugin_process_exit", { msg: `${inst.id}: ${reason || "exit"} | ${inst.stderr.slice(-3).join(" / ")}` })
  }
}

/**
 * 启动插件进程（幂等）。返回的 Promise 在收到 `ready` 后完成。
 */
function start(id) {
  const existing = running.get(id)
  if (existing) return existing.ready

  const manifestPath = path.join(PLUGIN_DIR, id, "manifest.json")
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return Promise.reject(httpError(400, "插件清单已损坏", { errorKey: "api.plugins.manifest_broken" }))
  }
  const entryAbs = path.join(PLUGIN_DIR, id, ...String(manifest.entry || "").split("/"))
  if (!fs.existsSync(entryAbs)) {
    return Promise.reject(httpError(400, "插件入口文件不存在", { errorKey: "api.plugins.entry_missing" }))
  }

  const proc = spawn(process.execPath, [entryAbs], {
    cwd: path.join(PLUGIN_DIR, id),
    env: childEnv(id),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  const inst = {
    id,
    proc,
    buffer: "",
    seq: 0,
    pending: new Map(),
    stderr: [],
    idleTimer: null,
    ready: null,
  }
  running.set(id, inst)

  inst.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kill(inst, "启动超时（10 秒内没有 ready）")
      reject(httpError(504, "插件启动超时", { errorKey: "api.plugins.start_timeout" }))
    }, READY_TIMEOUT_MS)
    inst.onReady = () => {
      clearTimeout(timer)
      resolve()
    }
    inst.onReadyFail = (message) => {
      clearTimeout(timer)
      reject(new Error(message))
    }
  })
  // 避免没人 await 时出现 unhandled rejection（真正的错误会在 await 处抛出）
  inst.ready.catch(() => {})

  proc.stdout.setEncoding("utf8")
  proc.stdout.on("data", (chunk) => {
    inst.buffer += chunk
    if (inst.buffer.length > MAX_LINE_BYTES) {
      kill(inst, "插件输出超长（疑似死循环打印）")
      return
    }
    let index
    while ((index = inst.buffer.indexOf("\n")) >= 0) {
      const line = inst.buffer.slice(0, index).trim()
      inst.buffer = inst.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // 插件往 stdout 打了非 JSON 的调试信息：忽略，但记下来便于排查
        inst.stderr.push(`stdout: ${line.slice(0, 200)}`)
        if (inst.stderr.length > STDERR_KEEP) inst.stderr.shift()
        continue
      }
      handleMessage(inst, message)
    }
  })
  proc.stderr.setEncoding("utf8")
  proc.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      const text = line.trim()
      if (!text) continue
      inst.stderr.push(text.slice(0, 300))
      if (inst.stderr.length > STDERR_KEEP) inst.stderr.shift()
    }
  })
  proc.on("exit", (code) => {
    if (running.get(id) === inst) {
      kill(inst, `插件进程退出（code=${code}）`)
    }
  })
  proc.on("error", (err) => {
    inst.onReadyFail?.(`无法启动插件进程：${err.message}`)
    kill(inst, `插件进程错误：${err.message}`)
  })

  proc.stdin.write(`${JSON.stringify({ type: "init", apiVersion: 1, settings: {} })}\n`)
  return inst.ready
}

function handleMessage(inst, message) {
  if (message?.type === "ready") {
    inst.onReady?.()
    return
  }
  if (message?.type === "result" && typeof message.id === "number") {
    const pending = inst.pending.get(message.id)
    if (!pending) return
    inst.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.data ?? null)
    else pending.reject(new Error(String(message.error || "插件返回了错误")))
  }
}

function touchIdle(inst) {
  clearTimeout(inst.idleTimer)
  inst.idleTimer = setTimeout(() => {
    if (inst.pending.size === 0) kill(inst, "空闲回收")
  }, IDLE_STOP_MS)
  inst.idleTimer.unref?.()
}

/**
 * 调用插件的某个 action。
 *
 * @param {string} id 插件 id
 * @param {string} action 必须出现在清单的 `actions` 里
 * @param {Record<string, unknown>} params 原样以 JSON 传给插件
 * @param {number} timeoutMs 超时（上限 30 秒）
 */
export async function callPluginAction(id, action, params = {}, timeoutMs = ACTION_TIMEOUT_MS) {
  await start(id)
  const inst = running.get(id)
  if (!inst || !alive(inst)) {
    throw httpError(502, "插件进程不可用", { errorKey: "api.plugins.process_gone" })
  }
  const limit = Math.min(Math.max(Number(timeoutMs) || ACTION_TIMEOUT_MS, 500), ACTION_TIMEOUT_MAX_MS)
  const seq = ++inst.seq

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inst.pending.delete(seq)
      // 超时直接杀进程：挂住的插件不该继续占用 CPU，也不该攒下更多请求
      kill(inst, `动作 ${action} 超时（${limit}ms）`)
      reject(httpError(504, "插件执行超时", { errorKey: "api.plugins.action_timeout" }))
    }, limit)
    inst.pending.set(seq, { resolve, reject, timer })
    touchIdle(inst)
    try {
      inst.proc.stdin.write(`${JSON.stringify({ type: "action", id: seq, action, params })}\n`)
    } catch (err) {
      inst.pending.delete(seq)
      clearTimeout(timer)
      reject(new Error(`写入插件进程失败：${err.message}`))
    }
  })
}

/** 主动停止某个插件的进程（禁用 / 卸载 / 改设置后调用） */
export function stopPlugin(id, reason = "手动停止") {
  const inst = running.get(id)
  if (!inst) return
  try {
    inst.proc.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`)
  } catch {
    /* 管道已断 */
  }
  kill(inst, reason)
}

/** 进程退出前统一收尾（index.js 的 shutdown 会调用） */
export function stopAllPlugins() {
  for (const id of [...running.keys()]) stopPlugin(id, "服务退出")
}

/** 运行时状态（后台/排查用） */
export function runnerStatus() {
  return [...running.values()].map((inst) => ({
    id: inst.id,
    pid: inst.proc?.pid ?? 0,
    pending: inst.pending.size,
    stderr: inst.stderr.slice(-3),
  }))
}

/** 启动过一次的插件数量（info 日志用） */
export function runnerCount() {
  return running.size
}

/** 记录一次动作调用（便于审计日志） */
export function logActionCall(id, action) {
  info("plugin_action", { msg: `${id}:${action}` })
}
