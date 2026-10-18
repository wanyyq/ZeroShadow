/**
 * 应用外壳（前端 HTML）的 CSP。
 *
 * 单独成一个模块，是因为它必须同时作用于三条出口：
 *   1. `express.static` 的 `.html`（index.js 的 setHeaders）
 *   2. SPA fallback 返回的 index.html
 *   3. `compress.js` 的静态压缩中间件（它挂在 static 之前，命中后自己 res.end）
 * 如果只在第 1、2 处设置，直连 `/index.html` 且带 `Accept-Encoding` 的请求会拿到
 * 一份**没有 CSP** 的页面 —— 同一页面两套安全策略，属于回归。
 *
 * 注意：这里只作用于前端文档，`/api` 响应不受影响；用户上传的 HTML/SVG 走
 * `routes/fs.js` 里独立的 `sandbox allow-scripts` 策略。
 */
export const SHELL_CSP = [
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
