// ============================================================================
//  http.js - HTTP 响应小工具（被多个路由共用）
// ============================================================================

/**
 * 构造一个带状态码的业务错误。
 *
 * `extra` 用来携带"给前端本地化用"的信息：
 *   - `errorKey`    ：命名键（如 `api.fs.path_invalid`），前端按当前界面语言翻译它；
 *   - `errorParams` ：插值参数，如 `{ count: 3 }`，对应译文里的 `{count}`。
 * 两者都由 index.js 的错误处理中间件透传到响应体里；`message` 仍然是中文原文，
 * 这样第三方脚本/curl 拿到的行为与以前完全一致（向后兼容）。
 *
 * @param {number} status
 * @param {string} message 中文原文（同时作为前端缺键时的兜底）
 * @param {{errorKey?: string, errorParams?: Record<string, unknown>, code?: string}} [extra]
 */
export function httpError(status, message, extra = undefined) {
  const err = new Error(message)
  err.status = status
  if (extra) {
    if (extra.errorKey) err.errorKey = String(extra.errorKey)
    if (extra.errorParams) err.errorParams = extra.errorParams
    if (extra.code) err.code = String(extra.code)
  }
  return err
}

/**
 * 生成 Content-Disposition。
 *
 * 同时给出两种文件名，是为了让所有客户端都能拿到正确的名字：
 *   - `filename="..."`  ：老客户端用的 ASCII 回退。非 ASCII 字符（中文等）
 *                          会被替换成 `_`，否则整个头可能被浏览器拒绝或乱码；
 *   - `filename*=UTF-8''…`：RFC 5987 编码，现代浏览器优先用它，中文文件名原样保留。
 *
 * 注：`encodeURIComponent` 不会编码 `'`、`(`、`)`，而 RFC 5987 里这三个字符
 * 不允许直接出现，所以再走一遍 escape 换成百分号编码。
 *
 * @param {"inline"|"attachment"} type
 * @param {string} filename
 */
export function contentDisposition(type, filename) {
  const name = String(filename || "file")
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
