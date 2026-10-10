/**
 * lib/markdown.ts —— 极简 Markdown → HTML 渲染器（供 .md 预览使用）
 *
 * 为什么自己写而不引第三方库：本项目的需求只是「把 .md 排版出来 + 绝对安全」，
 * 而 marked / markdown-it 打进产物会让前端多出 30~110KB（未压缩）。
 * 这里用十几 KB 源码覆盖常用语法，且**先整体转义、再解析**：源文件里的原始
 * HTML 一律当纯文本显示，因此输出的字符串不可能包含用户提供的标签，
 * 可以安全地交给 dangerouslySetInnerHTML —— 不存在 XSS 通道。
 *
 * 支持：ATX / setext 标题、围栏代码块、引用（可嵌套）、有序 / 无序 / 嵌套列表、
 *       任务列表、表格（含对齐）、水平线、行内代码、粗体、斜体、删除线、
 *       链接、图片、`<自动链接>`、硬换行（行尾两个空格或反斜杠）。
 * 不支持（有意为之，见 docs/安全设计.md）：原始 HTML、参考式链接、脚注、数学公式、目录。
 */

/** HTML 转义表：只有这 4 个字符需要处理，属性值因此无法被闭合 */
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESC[ch])
}

/** 危险协议（含 data:）：命中即降级为纯文本，避免 Markdown 变成 XSS 通道 */
const BAD_URL = /^\s*(?:javascript|vbscript|data):/i

/** 占位符：NUL + 序号 + NUL。正文里不可能出现 NUL，所以不会与内容撞车。
 *  用 RegExp 构造函数而不是字面量：正则字面量里写控制字符会被 ESLint 的
 *  no-control-regex 判为错误。 */
const NUL = String.fromCharCode(0)
const TOKEN = new RegExp(`${NUL}(\\d+)${NUL}`, "g")

/* ============================== 行内 ============================== */

function inline(raw: string): string {
  const stash: string[] = []
  // push() 返回新长度，所以写入的下标是 length-1
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`

  // 1) 先整体转义（这是"输出可信"的前提）
  let s = escapeHtml(raw)

  // 2) 行内代码先抠走，避免其中的 * _ ~ 被后面的强调规则误伤
  s = s.replace(/(`+)([\s\S]*?)\1(?!`)/g, (_m, _t, code: string) =>
    keep(`<code>${code.replace(/^ | $/g, "")}</code>`)
  )

  // 3) 图片 / 链接：只把地址单独 keep，正文保持"可继续做强调"的状态。
  //    地址允许一层配对括号，否则维基百科这类 `.../A_(b)` 会被截断。
  s = s.replace(
    /!\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"|&quot;)([\s\S]*?)(?:"|&quot;))?\s*\)/g,
    (_m, alt: string, src: string, title?: string) =>
      BAD_URL.test(src)
        ? alt
        : `<img src="${keep(src)}" alt="${alt}"${title ? ` title="${keep(title)}"` : ""} loading="lazy" />`
  )
  s = s.replace(
    /\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"|&quot;)([\s\S]*?)(?:"|&quot;))?\s*\)/g,
    (_m, text: string, href: string, title?: string) => {
      if (BAD_URL.test(href)) return text
      const ext = /^[a-z][\w+.-]*:/i.test(href) && !/^mailto:/i.test(href)
      return (
        `<a href="${keep(href)}"${title ? ` title="${keep(title)}"` : ""}` +
        `${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text || href}</a>`
      )
    }
  )
  // 4) <https://…> / <a@b.com> 自动链接（URL 里的 & 此时已经是 &amp;，所以不能用 [^\s&]）
  s = s.replace(/&lt;(https?:\/\/[^\s]*?|[\w.+-]+@[\w-]+\.[\w.-]+)&gt;/g, (_m, url: string) =>
    `<a href="${keep(/^https?:/i.test(url) ? url : `mailto:${url}`)}" target="_blank" rel="noopener noreferrer">${url}</a>`
  )

  // 5) 强调。先长后短：** 必须在 * 之前处理掉
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<em>$2</em>")
  s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>")

  // 6) 硬换行：行尾两个空格或反斜杠
  s = s.replace(/ {2,}\n|\\\n/g, "<br />\n")

  // 7) 还原占位符。keep() 的产物里可能还嵌着别的占位符，所以多跑几轮。
  for (let pass = 0; pass < 4 && s.includes("\u0000"); pass++) {
    s = s.replace(TOKEN, (_m, n: string) => stash[Number(n)] ?? "")
  }
  return s
}

/* ============================== 块级 ============================== */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+([\s\S]*)$/
const DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/
const SETEXT = /^ {0,3}(=+|-{2,})[ \t]*$/

/** 标题锚点：只保留字母 / 数字 / 汉字，避免把不可信内容拼进属性 */
function slug(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 64)
}

function heading(level: number, text: string): string {
  const id = slug(text)
  return `<h${level}${id ? ` id="${id}"` : ""}>${inline(text)}</h${level}>`
}

/* -------- 表格 -------- */

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|")) s = s.slice(0, -1)
  // 注意：单元格里的 | 需要写成 \| ，与 GFM 一致（这里不做转义还原，属已知取舍）
  return s.split("|").map((c) => c.trim())
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && DELIM.test(lines[i + 1])
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const head = splitRow(lines[start])
  const align = splitRow(lines[start + 1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""
  )
  let i = start + 2
  const rows: string[][] = []
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]))
  const cell = (tag: string, text: string, n: number) =>
    `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(text)}</${tag}>`
  const body = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${head.map((_c, n) => cell("td", r[n] ?? "", n)).join("")}</tr>`).join("")}</tbody>`
    : ""
  const html =
    `<div class="md-table"><table><thead><tr>` +
    head.map((c, n) => cell("th", c, n)).join("") +
    `</tr></thead>${body}</table></div>`
  return { html, next: i }
}

/* -------- 列表 -------- */

function renderList(lines: string[], start: number): { html: string; next: number } {
  const first = ITEM.exec(lines[start])!
  const ordered = !/^[-*+]/.test(first[2])
  const base = first[1].length
  // 子内容列 = 缩进 + 项目符号 + 一个空格；比它更深的行按子内容递归处理
  const col = base + first[2].length + 1
  const dedent = (s: string) => s.slice(Math.min(/^( *)/.exec(s)![1].length, col))

  const items: { text: string; task?: string; rest: string[] }[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    const m = ITEM.exec(line)
    if (m && m[1].length <= base + 1) {
      // 同级：有序与无序切换时结束当前列表（交给外层重新开一个）
      if (/^[-*+]/.test(m[2]) !== !ordered) break
      const task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(m[3])
      items.push({ text: task ? task[2] : m[3], task: task ? task[1] : undefined, rest: [] })
      i++
      continue
    }
    if (m) {
      items[items.length - 1].rest.push(dedent(line))
      i++
      continue
    }
    if (!line.trim()) {
      const next = lines[i + 1]
      // 空行后如果还有同级项或缩进内容，说明是松散列表，继续；否则列表到此为止
      if (next === undefined || !next.trim()) break
      if (ITEM.test(next) || /^ +/.test(next)) {
        items[items.length - 1].rest.push("")
        i++
        continue
      }
      break
    }
    // 无项目符号的续行（懒续行）归到当前项
    items[items.length - 1].rest.push(dedent(line))
    i++
  }

  const body = items
    .map((it) => {
      const box =
        it.task === undefined
          ? ""
          : `<input type="checkbox" disabled${/[xX]/.test(it.task) ? " checked" : ""} /> `
      const nested = it.rest.length ? renderBlocks(it.rest) : ""
      return `<li${it.task === undefined ? "" : ' class="md-task"'}>${box}${inline(it.text)}${nested}</li>`
    })
    .join("")
  const tag = ordered ? "ol" : "ul"
  const startNo = ordered ? Number.parseInt(first[2], 10) : 1
  const attr = startNo > 1 ? ` start="${startNo}"` : ""
  return { html: `<${tag}${attr}>${body}</${tag}>`, next: i }
}

/* -------- 主循环 -------- */

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HR.test(line) || HEADING.test(line) || QUOTE.test(line) || ITEM.test(line)
}

function renderBlocks(lines: string[]): string {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // 围栏代码块
    const fence = FENCE.exec(line)
    if (fence) {
      const ch = fence[1][0]
      const close = new RegExp("^ {0,3}" + ch + "{" + fence[1].length + ",}[ \\t]*$")
      const buf: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++])
      i++ // 跳过收尾围栏；未闭合时也只是走到末尾
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ""
      out.push(`<pre><code${lang}>${escapeHtml(buf.join("\n"))}</code></pre>`)
      continue
    }

    if (HR.test(line)) {
      out.push("<hr />")
      i++
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      out.push(heading(h[1].length, h[2].replace(/[ \t]+#+[ \t]*$/, "")))
      i++
      continue
    }

    // setext 标题：下一行是 === / ---
    const next = lines[i + 1]
    const se = next === undefined ? null : SETEXT.exec(next)
    if (se && line.trim()) {
      out.push(heading(se[1][0] === "=" ? 1 : 2, line.trim()))
      i += 2
      continue
    }

    // 引用（支持 >> 嵌套与懒续行）
    if (QUOTE.test(line)) {
      const inner: string[] = []
      let j = i
      while (j < lines.length) {
        const q = QUOTE.exec(lines[j])
        if (q) {
          inner.push(q[1])
          j++
          continue
        }
        if (lines[j].trim() && !startsBlock(lines[j])) {
          inner.push(lines[j])
          j++
          continue
        }
        break
      }
      out.push(`<blockquote>${renderBlocks(inner)}</blockquote>`)
      i = j
      continue
    }

    if (isTableStart(lines, i)) {
      const t = renderTable(lines, i)
      out.push(t.html)
      i = t.next
      continue
    }

    if (ITEM.test(line)) {
      const l = renderList(lines, i)
      out.push(l.html)
      i = l.next
      continue
    }

    // 段落
    const buf = [line]
    i++
    while (i < lines.length) {
      const cur = lines[i]
      if (!cur.trim() || startsBlock(cur) || SETEXT.test(cur) || isTableStart(lines, i)) break
      buf.push(cur)
      i++
    }
    out.push(`<p>${inline(buf.join("\n"))}</p>`)
  }
  return out.join("\n")
}

/** 把 Markdown 源文本渲染成 HTML 片段（可安全用于 dangerouslySetInnerHTML） */
export function renderMarkdown(src: string): string {
  return renderBlocks(src.replace(/\r\n?/g, "\n").split("\n"))
}

/** 是否属于"按 Markdown 渲染"的文件名 */
export function isMarkdown(name: string): boolean {
  const i = name.lastIndexOf(".")
  if (i <= 0) return false
  const e = name.slice(i + 1).toLowerCase()
  return e === "md" || e === "markdown" || e === "mdown" || e === "mkd" || e === "mkdn"
}
