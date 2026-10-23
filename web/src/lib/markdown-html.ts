/**
 * lib/markdown-html.ts —— Markdown 预览里「少量安全 HTML 标签」的白名单
 *
 * 背景：`lib/markdown.ts` 的安全前提是**先整体转义、再解析**，所以 `.md` 里
 * 手写的 HTML 一律当纯文本显示 —— 这挡住了 XSS，但 `<br>` / `<sub>` / `<kbd>`
 * 这类纯排版标签在真实文档里极其常见，把它们显示成 `&lt;br&gt;` 属于明显的
 * 体验缺陷（用户的原话是"无法渲染简单的 <br> 等内容"）。
 *
 * 取舍：
 *   - **只放行一张固定白名单**，别的一律按纯文本显示（`<script>`、`<iframe>`、
 *     `<a>`、`<style>`、`<img>` 都不在其中）；
 *   - **标签本身是唯一被放行的东西，属性一律丢弃**：`<div align="center">`
 *     渲染成 `<div>`。属性是 XSS / 样式注入 / 外链追踪的主要入口（`on*`、
 *     `style`、`href`、`src`），白名单里干脆一个都不解析；
 *   - 属性必须写成 `name=value`（值可带引号或 `&quot;`）。`<span and more text>`
 *     这种"不是属性、更像正文"的残句不会被当成标签，避免把正文吞掉；
 *   - 输出串只可能是下面这些字面标签、且不含任何属性，因此仍然可以安全地交给
 *     `dangerouslySetInnerHTML`。
 *
 * 纯函数、零 import：和 `markdown-urls.ts` 一样可以用
 * `node --experimental-strip-types` 直接单测（scripts/markdown-html-test.mjs）。
 */

/** 允许透传的标签（小写）。改这里等于改安全边界，务必同步单测与文档。 */
export const SAFE_HTML_TAGS = [
  "br",
  "hr",
  "sub",
  "sup",
  "kbd",
  "u",
  "s",
  "mark",
  "small",
  "span",
  "div",
  "p",
  "center",
] as const

const SAFE = new Set<string>(SAFE_HTML_TAGS)
/** 自闭合标签：`<br>` / `<br/>` / `</br>` 都输出成 `<br />` */
const VOID = new Set(["br", "hr"])

/**
 * 属性文法：零个或多个 `name=value`，末尾允许一个 `/`。
 *
 * 值接受三种写法：
 *   - 双引号 / 单引号包裹（源文本未转义时，如 `align="center"`）
 *   - `&quot;…&quot;`（文本已经过 escapeHtml，引号变成了实体）
 *   - 裸值（`hidden=x`、`width=100`）
 *
 * 之所以要求 `=`，是为了让 `<span and more text>` 落回"纯文本"分支：
 * 若允许裸属性名，那么一句普通的正文也可能被误判成标签并被吞掉。
 */
const ATTR = String.raw`\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)`
const ATTRS_RE = new RegExp(`^(?:${ATTR})*\\s*\\/?$`)

/** 标签名：字母开头，最长 10 位（`center` / `small` / `mark` 都够用） */
const NAME = String.raw`([a-zA-Z][a-zA-Z0-9]{0,9})`

/** 在**已转义**的文本里找 `<tag …>` / `</tag>`（`<` `>` 此时是 `&lt;` `&gt;`） */
const ESCAPED_TAG = new RegExp(String.raw`&lt;(\/?)${NAME}([\s\S]*?)&gt;`, "g")
/** 在**原始**文本里找同样的标签（只用于"还有哪些 HTML 没被渲染"的提示判定） */
const RAW_TAG = new RegExp(String.raw`<(\/?)${NAME}([^<>]*)>`, "g")

/** 标签是否在白名单内、且属性写法可接受（属性只用于判定，不会被输出） */
function isAllowedTag(name: string, attrs: string): boolean {
  if (!SAFE.has(name.toLowerCase())) return false
  // 闭合标签后面不该有属性：`</div>` 的 attrs 是空串
  return ATTRS_RE.test(attrs)
}

/**
 * 把**已转义**文本里的白名单标签还原成真标签，其余原样保留。
 *
 * 之所以要求"已转义"：`markdown.ts` 先 `escapeHtml()` 再解析，这里接在转义之后
 * 运行，于是 `<script>` 早已变成 `&lt;script&gt;`，不在白名单里就自然留在文本中。
 */
export function renderSafeTags(escaped: string): string {
  return String(escaped ?? "").replace(
    ESCAPED_TAG,
    (whole: string, close: string, rawName: string, attrs: string) => {
      const name = rawName.toLowerCase()
      if (!isAllowedTag(name, attrs)) return whole
      if (VOID.has(name)) return close ? "" : `<${name} />`
      return close ? `</${name}>` : `<${name}>`
    }
  )
}

/**
 * 源文本里是否还存在**不会被渲染**的 HTML（给预览页顶部的提示条用）。
 *
 * 围栏代码块与行内代码里的标签只是示例代码，不该触发提示，所以先抠掉。
 */
export function hasUnsupportedHtml(src: string): boolean {
  // 逐行剔掉围栏代码块（未闭合的围栏按"一直到文件末尾"处理）
  const kept: string[] = []
  let fence: string | null = null
  for (const line of String(src ?? "").split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      continue
    }
    if (m) {
      fence = m[1]
      continue
    }
    kept.push(line)
  }
  const text = kept.join("\n").replace(/`[^`\n]*`/g, " ")
  let hit = false
  text.replace(RAW_TAG, (whole: string, close: string, rawName: string, attrs: string) => {
    // `<br/>` 这类自闭合写法里 attrs 是 "/"，归一化后再判定
    const tail = /^\s*\/?$/.test(attrs) ? "" : attrs
    if (!close && isAllowedTag(rawName, tail)) return whole
    if (close && isAllowedTag(rawName, "")) return whole
    hit = true
    return whole
  })
  // HTML 注释也属于"显示了源码"，但它的 `<` 后面不是字母，上面的正则抓不到
  if (!hit) hit = /<!--/.test(text)
  return hit
}
