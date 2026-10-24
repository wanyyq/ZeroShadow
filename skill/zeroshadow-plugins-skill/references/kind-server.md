# server 插件：独立子进程 + stdio JSON

处理重计算、定时任务、调用外部 API 一类的活儿。宿主用 `process.execPath` 起一个 node 子进程，
通过 stdin/stdout 一行一个 JSON 通信。

> **这不是安全沙箱，是故障隔离。** 子进程与主进程同一个操作系统用户，能读写它能碰到的任何文件、
> 能起别的进程、能访问网络。唯一的收敛是：环境变量白名单（拿不到 `JWT_SECRET`）、
> 只转发清单里声明的动作、超时、输出上限。**只在明确信任插件作者时才安装。**

## 包结构

```
org.example.rebuilder.zip
├── manifest.json
└── main.mjs           ← entry，.js 或 .mjs
```

## manifest.json

```json
{
  "id": "org.example.rebuilder",
  "name": "索引重建器",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "server",
  "entry": "main.mjs",
  "actions": ["rebuild", "stats"],
  "settings": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "batchSize": { "type": "integer", "title": "批大小", "minimum": 1, "maximum": 5000, "default": 200 }
    }
  }
}
```

- `actions` **必填**，1~20 个，命名 `^[a-z][a-z0-9_-]{0,31}$`
- 宿主**只**转发这里声明过的名字，别的名字一律 400 `api.plugins.action_not_allowed`
- `entry` 必须是包内 `.js` / `.mjs`，不能含 `..`

## 协议（apiVersion: 1）

```
host   → plugin  {"type":"init","apiVersion":1,"settings":{}}
plugin → host    {"type":"ready"}                                  ← 10 秒内不发就杀进程
host   → plugin  {"type":"action","id":1,"action":"rebuild","params":{...}}
plugin → host    {"type":"result","id":1,"ok":true,"data":{...}}    ← 失败用 "ok":false,"error":"..."
host   → plugin  {"type":"shutdown"}
```

规则：

1. **stdout 只输出一行一个 JSON**。别的行会被丢弃（并记进最近 20 行 stderr 诊断里），
   累积超过 **256 KB** 未换行会直接杀进程。
2. 调试信息写 **stderr**（`console.error`）。宿主保留最近 20 行、每行截断 300 字符，进日志排查。
3. `id` 由宿主生成，原样回传。**可以并发**：宿主可能同时发多个 action，靠 id 区分。
4. 单动作**默认超时 5 秒**（宿主接口未暴露自定义值，上限 30 秒）。超时**直接杀进程** ——
   不是取消，是同进程里其他在途动作一起失败。长任务请自己切块，或把结果落文件后快速返回。
5. `ready` 之后宿主才发 action。`init` 里的 **`settings` 目前恒为 `{}`**（宿主尚未把后台设置接进来），
   需要配置时先让用户把值写进文件，或等宿主升级。
6. 进程空闲 **60 秒**被回收；禁用/卸载/服务退出都会先发 `shutdown` 再 `kill`。
7. 进程崩溃/退出 → 所有在途动作 `502 api.plugins.process_gone`；下次调用会自动重新拉起。

## 环境变量

子进程**只**能拿到这些：

```
PATH  Path  SystemRoot  TEMP  TMP  TMPDIR  LANG  LC_ALL
ZS_PLUGIN=1   ZS_PLUGIN_ID=<插件 id>   ZS_PLUGIN_API_VERSION=1
```

`JWT_SECRET`、`.env` 里的口令、其它进程环境一律不给。但**这只挡环境变量**，挡不住读文件。

## 完整示例（`main.mjs`）

```js
// main.mjs —— 一个可直接跑的最小 server 插件
import { createInterface } from "node:readline"

const API_VERSION = 1
let initialized = false

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function log(...args) {
  // 只进 stderr：stdout 是协议通道，混进去会被当噪音
  console.error("[rebuilder]", ...args)
}

/** 动作实现：同步或异步都行，返回值会被放进 result.data */
async function run(action, params) {
  switch (action) {
    case "ping":
      return { pong: Date.now() }

    case "stats": {
      const started = Date.now()
      // 这里可以做真正的活儿：读文件、算哈希、请求外部 API……
      return { ok: true, ms: Date.now() - started, pid: process.pid }
    }

    case "rebuild": {
      const batch = Number(params.batchSize) > 0 ? Number(params.batchSize) : 200
      // ⚠️ 超过 5 秒会被宿主杀掉，长任务务必切块或改成"启动任务 + 轮询进度"两步
      let done = 0
      for (let i = 0; i < batch; i++) done++
      return { done }
    }

    default:
      throw new Error(`unknown action: ${action}`)
  }
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return

  if (msg.type === "init") {
    if (msg.apiVersion !== API_VERSION) {
      log("unsupported apiVersion", msg.apiVersion)
      process.exit(1)              // 宿主会看到 ready 超时并报 504
    }
    initialized = true
    log("init, settings =", JSON.stringify(msg.settings || {}))
    send({ type: "ready" })        // ← 必须发
    return
  }

  if (msg.type === "action") {
    if (!initialized) {
      send({ type: "result", id: msg.id, ok: false, error: "not initialized" })
      return
    }
    // 立即回"受理"是不可能的（协议只有 result），所以动作必须足够快
    Promise.resolve()
      .then(() => run(msg.action, msg.params || {}))
      .then((data) => send({ type: "result", id: msg.id, ok: true, data: data ?? null }))
      .catch((err) => send({ type: "result", id: msg.id, ok: false, error: String((err && err.message) || err) }))
    return
  }

  if (msg.type === "shutdown") {
    log("shutdown")
    process.exit(0)
  }
}

/* ---------- 主循环：stdin 逐行解析 ---------- */
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch (err) {
    log("bad json from host:", text.slice(0, 200))
    return
  }
  try {
    handle(msg)
  } catch (err) {
    log("handler threw:", (err && err.stack) || err)
  }
})
rl.on("close", () => process.exit(0))

// 兜底：别让未捕获异常把进程带崩得毫无痕迹
process.on("uncaughtException", (err) => log("uncaught:", (err && err.stack) || err))
process.on("unhandledRejection", (err) => log("unhandled rejection:", err))
```

## 调用接口

```http
POST /api/admin/plugins/org.example.rebuilder/action
Content-Type: application/json
Cookie: zs_token=<超管会话>
X-Requested-With: XMLHttpRequest

{ "action": "rebuild", "params": { "batchSize": 100 } }
```

响应：`{ "ok": true, "data": { "done": 100 } }`

失败语义：

| 状态 | errorKey | 含义 |
|---|---|---|
| 400 | `api.plugins.not_enabled` | 插件没启用（未启用的插件连进程都不起） |
| 400 | `api.plugins.not_server` | 不是 server 类 |
| 400 | `api.plugins.action_not_allowed` | 动作名不在清单里 |
| 400 | `api.plugins.manifest_broken` | 清单坏了 |
| 502 | `api.plugins.process_gone` | 子进程不可用（启动失败/已退出） |
| 504 | `api.plugins.action_timeout` | 超时（进程已被杀） |
| 504 | `api.plugins.start_timeout` | 10 秒内没 ready |

## 常见坑

| 现象 | 原因 |
|---|---|
| 启动即 502 | entry 路径不对；或插件在 import 阶段就抛错 |
| 504 start_timeout | 忘了发 `{"type":"ready"}`；或 init 处理是异步的但没等 |
| 504 action_timeout | 动作超过 5 秒；超时会**杀进程**，后续请求要重新拉起 |
| stdout 是空的但日志有输出 | 用了 `console.error` 回结果；应当 `process.stdout.write(JSON.stringify(...)+"\n")` |
| 每次调用都是新 pid | 空闲 60 秒被回收，或上次超时被杀 —— 正常现象，别把状态存在进程内存里 |
| 结果里有 `undefined` | JSON 会丢字段；返回前确保数据可序列化 |
| 拿不到后台设置 | `init.settings` 目前恒为 `{}`（宿主未接线） |

## 自测清单

- [ ] 未启用时调 action → 400 `not_enabled`
- [ ] 启用后调未声明动作 → 400 `action_not_allowed`
- [ ] 调 `ping` → `{ok:true,data:{pong:...}}`，第一次约 100ms（冷启动）
- [ ] 连续调两次 → 第二次明显更快（进程复用，pid 相同）
- [ ] 造一个 `sleep(8000)` 的动作 → 504，且日志里出现"动作 … 超时"，再调一次能重新拉起
- [ ] 禁用后 `GET /api/admin/plugins` 里 `enabled:false`，且日志出现进程退出
- [ ] 卸载后目录 `data/plugins/<id>` 消失、`plugins.json` 里无残留
