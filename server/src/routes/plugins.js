import { Router } from "express"
import express from "express"
import { requireRole } from "../auth.js"
import { getConfig } from "../config.js"
import { httpError } from "../http.js"
import { info } from "../logger.js"
import { themeCss } from "../plugins/manifest.js"
import { callPluginAction, logActionCall } from "../plugins/runner.js"
import {
  activeThemeManifest,
  enabledRuntimePlugins,
  installPlugin,
  listPlugins,
  pluginEntryFile,
  pluginsSummary,
  runtimeSettings,
  savePluginSettings,
  setActiveTheme,
  setPluginEnabled,
  uninstallPlugin,
} from "../plugins/store.js"

// ============================================================================
//  routes/plugins.js - 插件相关的 HTTP 接口
//
//  两组路由：
//    - `/api/plugins/theme`（**公开**）：当前生效的主题插件 CSS。
//      主题是视觉信息、不含用户数据，公开返回才能让访客也看到同一套主题。
//    - `/api/admin/plugins`（**仅超管**）：安装 / 启停 / 卸载 / 私有设置 / 选主题。
//
//  为什么单独成文件：插件是"不受信任的第三方内容"，把它和成员管理、日志那些
//  管理接口混在一个文件里，评审时很容易漏看某个 handler 忘了 requireRole。
// ============================================================================

export const publicPluginRouter = Router()

/**
 * 总开关（`data/config.json` 的 `pluginsEnabled`）。
 *
 * 三条**公开**路由（theme / list / entry）也必须看它：它们的产物正是插件真正
 * 作用于浏览器的那部分（主题 CSS、运行时清单、插件 HTML）。旧实现只在 admin
 * 路由里检查，于是"关闭插件"之后主题照样生效、已启用插件的预览器照样能被加载
 * —— 与文档承诺的"关闭后已装插件不再生效（主题自动撤销）"相反，
 * 也让"一键停用插件"这个应急手段失效。
 */
function runtimePluginsEnabled() {
  try {
    return getConfig().pluginsEnabled === true
  } catch {
    return false
  }
}

/** 当前主题（CSS 已由服务端拼好并做过值校验，前端只负责注入 <style>） */
publicPluginRouter.get("/theme", (_req, res) => {
  if (!runtimePluginsEnabled()) return res.json({ id: "", name: "", css: "" })
  const manifest = activeThemeManifest()
  if (!manifest) return res.json({ id: "", name: "", css: "" })
  res.setHeader("Cache-Control", "no-cache")
  res.json({ id: manifest.id, name: manifest.name, css: themeCss(manifest) })
})

/**
 * 已启用的「前端运行时」插件清单。
 *
 * 给预览页用：它只知道"这个后缀交给哪个插件渲染"，不需要任何管理信息。
 * 唯一的例外是 `permissions` —— 那是**能力声明**而不是管理数据：宿主在替插件
 * 读写文件前必须依据它放行/拒绝（见 components/plugins/plugin-frame.tsx）。
 * 未启用的插件、主题插件、损坏的插件都不会出现在这里。
 */
publicPluginRouter.get("/list", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache")
  // 总开关关掉时清单必须为空：否则预览页仍会按后缀去加载"已启用"的插件
  if (!runtimePluginsEnabled()) return res.json({ plugins: [] })
  res.json({ plugins: enabledRuntimePlugins() })
})

/**
 * 插件的入口 HTML（被 `sandbox="allow-scripts"` 的 iframe 加载）。
 *
 * 这里的安全约束是**"自包含 + 零网络"**：
 *   - 只返回 manifest 里声明的 **entry 文件**，不接受任意路径（防路径穿越）；
 *   - 响应头 CSP 把文档锁死：`default-src 'none'`，只允许内联脚本/样式与 data: 图片，
 *     `connect-src 'none'`（插件发不出任何请求）、`form-action 'none'`、`base-uri 'none'`；
 *   - `sandbox allow-scripts` 让它成为**不透明源**：拿不到本站 Cookie、读不到父页面、
 *     也算不上同源（所以即使有人在插件里写 `fetch('/api/...')` 也会被 CORS 拦下）。
 *     插件要读写文件，只能 `postMessage` 回来让宿主代执行（宿主再走 `req.perms`）。
 */
publicPluginRouter.get("/entry/:id", async (req, res, next) => {
  try {
    // 总开关关掉时入口也不再提供：能取到这份 HTML 就等于插件仍能被执行
    if (!runtimePluginsEnabled()) throw httpError(404, "插件不存在或未启用", { errorKey: "api.plugins.not_found" })
    const id = String(req.params.id)
    const entry = pluginEntryFile(id)
    if (!entry) throw httpError(404, "插件不存在或未启用", { errorKey: "api.plugins.not_found" })
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "connect-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "sandbox allow-scripts",
      ].join("; ")
    )
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.sendFile(entry.file, { cacheControl: false }, (err) => {
      if (err && !res.headersSent) next(err)
    })
  } catch (err) {
    next(err)
  }
})

/** 插件自己的设置值（只给已启用的运行时插件，供 init 消息使用） */
export function pluginRuntimeSettings(id) {
  return runtimeSettings(id)
}

export const adminPluginRouter = Router()
adminPluginRouter.use(requireRole("superadmin"))

function ensurePluginsEnabled() {
  if (getConfig().pluginsEnabled !== true) {
    throw httpError(403, "插件功能已关闭（默认关闭，请在「设置 → 插件」中开启）", {
      errorKey: "api.plugins.disabled",
    })
  }
}

adminPluginRouter.get("/", (_req, res) => {
  res.json({
    enabled: getConfig().pluginsEnabled === true,
    summary: pluginsSummary(),
    plugins: listPlugins(),
  })
})

/**
 * 安装插件：请求体就是 zip 的原始字节（`Content-Type: application/zip`）。
 *
 * 不用 multipart：省掉一层解析，且前端可以直接把用户选的文件读成 ArrayBuffer 发过来。
 * 上限 2 MB（见 plugins/store.js 的 MAX_PACKAGE_BYTES），raw 解析器再兜一层。
 */
adminPluginRouter.post(
  "/",
  express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "3mb" }),
  async (req, res, next) => {
    try {
      ensurePluginsEnabled()
      const buffer = Buffer.isBuffer(req.body) ? req.body : null
      if (!buffer?.length) throw httpError(400, "请求体为空，请以 application/zip 上传插件包", { errorKey: "api.plugins.empty_package" })
      const plugin = await installPlugin(buffer, { filename: String(req.query.filename || "plugin.zip") })
      info("plugin_installed", { msg: plugin.id, user: req.auth.username, ip: req.ip })
      res.status(201).json({ ok: true, plugin })
    } catch (err) {
      next(err)
    }
  }
)

/** 启停 + 保存私有设置 */
adminPluginRouter.patch("/:id", async (req, res, next) => {
  try {
    ensurePluginsEnabled()
    const id = String(req.params.id)
    const body = req.body || {}
    if (body.enabled !== undefined) {
      await setPluginEnabled(id, !!body.enabled)
    }
    if (body.settings !== undefined) {
      await savePluginSettings(id, body.settings)
    }
    const row = listPlugins().find((p) => p.id === id)
    if (!row) throw httpError(404, "插件不存在", { errorKey: "api.plugins.not_found" })
    res.json({ ok: true, plugin: row })
  } catch (err) {
    next(err)
  }
})

/** 应用 / 取消应用某个主题插件 */
adminPluginRouter.post("/:id/theme", async (req, res, next) => {
  try {
    ensurePluginsEnabled()
    const id = String(req.params.id)
    const active = req.body?.active !== false
    const manifest = active ? await setActiveTheme(id) : (await setActiveTheme(""), null)
    res.json({ ok: true, activeTheme: active ? id : "", theme: manifest ? { id: manifest.id, name: manifest.name } : null })
  } catch (err) {
    next(err)
  }
})

adminPluginRouter.delete("/:id", async (req, res, next) => {
  try {
    ensurePluginsEnabled()
    await uninstallPlugin(String(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/** 恢复默认主题（不卸载插件） */
adminPluginRouter.delete("/theme/active", async (_req, res, next) => {
  try {
    ensurePluginsEnabled()
    await setActiveTheme("")
    res.json({ ok: true, activeTheme: "" })
  } catch (err) {
    next(err)
  }
})

/**
 * 调用 `server` 插件的某个动作（**仅超管**）。
 *
 * 两道白名单：
 *   1. 插件自身必须已启用（未启用的插件连进程都不该起）；
 *   2. `action` 必须出现在 manifest 的 `actions` 里 —— 宿主不会把任意方法名转发给插件。
 *
 * 真正的隔离来自 `plugins/runner.js`：独立子进程、清洗过的环境变量、
 * 5 秒默认超时（上限 30 秒）、输出上限。**它不是操作系统级沙箱**，
 * 所以"只装可信插件"仍然是前提。
 */
adminPluginRouter.post("/:id/action", async (req, res, next) => {
  try {
    ensurePluginsEnabled()
    const id = String(req.params.id)
    const action = String(req.body?.action || "")
    const row = listPlugins().find((p) => p.id === id)
    if (!row) throw httpError(404, "插件不存在", { errorKey: "api.plugins.not_found" })
    if (row.broken) throw httpError(400, "插件清单已损坏", { errorKey: "api.plugins.manifest_broken" })
    if (!row.enabled) throw httpError(400, "请先启用插件", { errorKey: "api.plugins.not_enabled" })
    if (row.manifest?.kind !== "server") {
      throw httpError(400, "只有 server 类插件支持动作调用", { errorKey: "api.plugins.not_server" })
    }
    const allowed = row.manifest.actions || []
    if (!action || !allowed.includes(action)) {
      throw httpError(400, "未声明的动作", { errorKey: "api.plugins.action_not_allowed" })
    }
    const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {}
    logActionCall(id, action)
    const data = await callPluginAction(id, action, params)
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})
