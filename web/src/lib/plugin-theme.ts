/**
 * lib/plugin-theme.ts —— 应用「主题插件」下发的 CSS
 *
 * 为什么不做成 React 组件：主题要在**首屏渲染前**就生效（否则会先闪一下默认配色），
 * 而且它只做两件事——往 <head> 里塞一个 <style>、给 <html> 打个 data 属性——
 * 用模块级函数比套一层 Provider 更直接。
 *
 * 安全前提：CSS 文本由**服务端**拼好（`server/src/plugins/manifest.js` 的
 * `themeCss()`，令牌名与值都在那里白名单校验过）。前端不做二次拼接，
 * 避免"前端信任插件内容"的漏洞。
 */

let styleEl: HTMLStyleElement | null = null

function ensureStyle(): HTMLStyleElement {
  if (styleEl && styleEl.isConnected) return styleEl
  styleEl = document.createElement("style")
  styleEl.id = "zs-plugin-theme"
  document.head.appendChild(styleEl)
  return styleEl
}

/** 拉取并应用当前主题；`id` 为空表示恢复默认 */
export async function loadPluginTheme(): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch("/api/plugins/theme", {
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: string; name?: string; css?: string }
    const css = typeof data.css === "string" ? data.css : ""
    const id = typeof data.id === "string" ? data.id.replace(/[^a-z0-9.-]/gi, "") : ""
    ensureStyle().textContent = css
    if (id) document.documentElement.dataset.themePlugin = id
    else delete document.documentElement.dataset.themePlugin
    return id ? { id, name: data.name || id } : null
  } catch {
    // 离线或接口异常：保持当前主题，不影响使用
    return null
  }
}
