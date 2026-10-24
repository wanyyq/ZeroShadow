import { Router } from "express"
import express from "express"
import { requireRole } from "../auth.js"
import { getConfig } from "../config.js"
import { httpError } from "../http.js"
import { info } from "../logger.js"
import { themeCss } from "../plugins/manifest.js"
import {
  activeThemeManifest,
  installPlugin,
  listPlugins,
  pluginsSummary,
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

/** 当前主题（CSS 已由服务端拼好并做过值校验，前端只负责注入 <style>） */
publicPluginRouter.get("/theme", (_req, res) => {
  const manifest = activeThemeManifest()
  if (!manifest) return res.json({ id: "", name: "", css: "" })
  res.setHeader("Cache-Control", "no-cache")
  res.json({ id: manifest.id, name: manifest.name, css: themeCss(manifest) })
})

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
