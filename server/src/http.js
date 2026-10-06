// ============================================================================
//  http.js - HTTP 响应小工具（被多个路由共用）
// ============================================================================

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
