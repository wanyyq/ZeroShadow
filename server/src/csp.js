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
  /**
   * `http:` / `https:` 是**有意放开**的：Markdown 预览要显示 `.md` 里引用的
   * 外链图片（`![](https://某CDN/x.jpg)`），而 `img-src 'self'` 会把它们全部拦掉，
   * 用户看到的只是一片破图。
   *
   * 放开 img-src 的代价与边界：
   *   - `<img>` 只能解码图片，**不能执行脚本**，也不受 `script-src` 影响；
   *   - 但加载本身会把访问者的 IP 与 UA 暴露给图片服务器，等于可以被用来做
   *     追踪像素。站内已设 `Referrer-Policy: no-referrer`，不额外泄露来源页面；
   *   - 因此这里**只放开图片**：`script-src` / `connect-src` / `frame-src`
   *     （未声明，回落 `default-src 'self'`）仍然是同源白名单，
   *     第三方脚本与第三方请求依旧进不来。
   */
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ")
