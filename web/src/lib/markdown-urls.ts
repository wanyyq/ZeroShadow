/**
 * lib/markdown-urls.ts —— Markdown 里相对路径的解析（纯函数，无任何 import）
 *
 * 单独拆出来的两个原因：
 *  1. 这是"图片不显示 / 链接点不开"的根因所在（相对路径被当成站点根路径）；
 *  2. 它不依赖 i18n / 组件，因此可以用 `node --experimental-strip-types`
 *     直接跑单测（见 scripts/markdown-url-test.mjs），改完立刻能验证。
 */

export interface ResolvedRef {
  /** 带协议的（http/https/mailto/…）或协议相对（//host）地址：保持原样 */
  external: boolean
  /** external=true 时是原地址；否则是网盘内的相对路径（已折叠 . / ..） */
  path: string
}

/**
 * 解析 Markdown 里的图片 / 链接地址。
 *
 * 规则：
 *   - `#anchor`：原样保留（页内跳转）
 *   - `http(s)://…`、`mailto:`、`//host/…`：原样保留
 *   - `/xxx`：按"网盘根相对"处理（去掉前导斜杠）
 *   - 其余：相对 `.md` 所在目录（baseDir）解析，并折叠 `.` / `..`
 */
export function resolveRef(baseDir: string, rawUrl: string): ResolvedRef {
  const url = String(rawUrl ?? "").trim()
  if (!url) return { external: false, path: "" }
  if (url.startsWith("#")) return { external: false, path: url }
  if (/^[a-z][\w+.-]*:/i.test(url) || url.startsWith("//")) return { external: true, path: url }

  const clean = url.split("#")[0].split("?")[0]
  const segments = (clean.startsWith("/") ? [] : baseDir ? baseDir.split("/") : []).concat(clean.split("/"))
  const out: string[] = []
  for (const seg of segments) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return { external: false, path: out.join("/") }
}

/** 网盘文件的内联预览地址（图片用） */
export function inlineFileUrl(path: string): string {
  return `/api/fs/download?path=${encodeURIComponent(path)}&inline=1`
}

/** 网盘文件的下载地址 */
export function downloadFileUrl(path: string): string {
  return `/api/fs/download?path=${encodeURIComponent(path)}`
}

/** 判断一个网盘路径"看起来是文件"（最后一段有扩展名），否则当成目录 */
export function looksLikeFile(path: string): boolean {
  const last = path.split("/").pop() || ""
  return last.includes(".") && !last.startsWith(".")
}
