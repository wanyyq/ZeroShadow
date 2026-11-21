/**
 * lib/download-mode.ts —— 下载该怎么走（纯函数，零依赖，可用 node --experimental-strip-types 直接单测）
 *
 * 背景（v2.1.0 修的 bug）：下载原来是 `fetch` 整个文件 → `res.blob()` → 点一个 `blob:`
 * 链接。两个后果：
 *   1. **内置浏览器拦 blob 下载**：微信 / QQ / 微博 / 钉钉这类 WebView 普遍只认
 *      "响应带 `Content-Disposition: attachment` 的原生导航"，blob 一律拦掉 ——
 *      表现就是"点了没反应"（用户看到的提示往往就是"请用浏览器打开"）；
 *   2. **大文件会把内存吃爆**：`res.blob()` 是整个读进内存，几百 MB 在手机上直接失败。
 *
 * 所以决策拆成三步：先看探路结果、再看环境，最后才决定用哪种方式。
 * 这个文件只放"判断"，DOM 操作留给 api.ts —— 这样判断本身能被单测钉死。
 */

/** 内置浏览器的 UA 特征（命中即视为 WebView） */
export const IN_APP_UA_RE =
  /MicroMessenger|QQ\/|Weibo|DingTalk|AlipayClient|UCBrowser|Quark|baiduboxapp|FBAN|FBAV|Instagram|Line\/|Snapchat/i

/** 是否是内置浏览器（WebView）。`ua` 为空视为普通浏览器。 */
export function isInAppUserAgent(ua: string | null | undefined): boolean {
  return IN_APP_UA_RE.test(String(ua ?? ""))
}

/** 超过这个体积就不在内存里缓冲（blob），直接交给浏览器下载 */
export const BLOB_DOWNLOAD_MAX = 32 * 1024 * 1024

export type DownloadMode = "error" | "blob" | "native"

/**
 * 决定下载方式。
 *
 * @param probe `HEAD` 探路的结果：`status` 是 HTTP 状态码（0 / 未提供表示"探路没做成"），
 *              `size` 是 `Content-Length`（未知按 0 计）
 * @param env `inApp` = 内置浏览器；`maxBlob` 可覆盖阈值（测试用）
 */
export function pickDownloadMode(
  probe: { status?: number; size?: number },
  env: { inApp?: boolean; maxBlob?: number } = {}
): DownloadMode {
  const status = Number(probe.status ?? 0)
  // 探路得到 4xx：这是**确定的失败**（没权限 / 文件不在 / 会话过期），必须报错，
  // 不能"硬下"—— 否则会把一段 JSON 错误体当文件存下来。
  if (status >= 400 && status < 500) return "error"
  // 内置浏览器或大文件：走原生导航下载
  if (env.inApp) return "native"
  const size = Number(probe.size ?? 0)
  const maxBlob = env.maxBlob ?? BLOB_DOWNLOAD_MAX
  if (size > maxBlob) return "native"
  // 其余（普通浏览器 + 小文件 / 体积未知 / 5xx 探路失败）走 blob：
  //   小文件 blob 能精确控制文件名；体积未知时 blob 也够用（未知通常意味着压缩流）。
  return "blob"
}
