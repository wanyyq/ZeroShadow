/**
 * convert/markdown.js —— 一个"够用就好"的 Markdown 解析器（服务端）。
 *
 * 为什么不用现成的库：项目的后端依赖清单是刻意保持精简的（见 docs/开发者指南.md），
 * 而这里需要的只是**块级结构 + 行内样式标记**，不需要 CommonMark 的全部边角语义。
 * 更重要的原因是：同一份解析结果要喂给两个转换器（纯文本、PDF），各有各的排版，
 * 一个扁平的中间表示比任何库的 AST 都更省事。
 *
 * 覆盖范围（都是实际 .md 文档里最常见的写法）：
 *   - YAML front matter（跳过，不参与排版）
 *   - ATX 标题（#）与 Setext 标题（=== / ---）
 *   - 段落（含硬换行：行尾两个空格或反斜杠）
 *   - 无序 / 有序列表、任务列表、两层以上缩进
 *   - 围栏代码块（``` / ~~~，含语言标注）
 *   - 引用（> 可嵌套）
 *   - 表格（含对齐分隔行）
 *   - 水平分割线
 *   - 行内：**粗体** / *斜体* / `代码` / [链接](url) / ![图片](src) / <自动链接> / 反斜杠转义
 *
 * 明确不做的：原始 HTML 会被当纯文本（标签剥掉）、脚注、定义列表、数学公式、
 * 引用式链接（[a][b]）、HTML 注释。这些都写进了使用手册的"转换限制"。
 */

/** 中日韩字符：用于判断"能否在任意位置断行" */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af\u3040-\u30ff]/

export function isWideChar(ch) {
  return CJK_RE.test(ch)
}

/**
 * 硬换行的占位符。
 *
 * 用 NUL 包起来的特殊字符：Markdown 正文里不可能出现，所以不会与内容撞车。
 * 段落先把"行尾两个空格 / 反斜杠"折叠成它，再由 parseInline 变成 `{ br: true }`。
 */
const SENTINEL = "\u0000\u000b\u0000"

/**
 * 预览放行的少量安全 HTML 标签（与 `web/src/lib/markdown-html.ts` 的
 * SAFE_HTML_TAGS 逐项一致）。**内容一致**的关键点：
 *   - 白名单标签 → PDF 里丢掉标签本身、保留里面的文字（预览也是显示文字）；
 *   - `<br>` / `<hr>` → 变成换行；
 *   - 白名单之外的标签（`<script>` / `<div>` 之类）→ 预览会把它**当纯文本显示**，
 *     所以这里也必须**原样保留**，不能悄悄删掉（老实现删掉了，导致 PDF 少了一截文字）。
 */
const SAFE_HTML_TAGS = new Set([
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
])

/** 匹配一个形如 `<tag>` / `</tag>` / `<tag ...>` 的片段（属性一律忽略） */
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]{0,9})((?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+))*)\s*\/?>/

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

/**
 * 把一行（或一段）Markdown 文本切成行内 run：
 *   { text, bold?, italic?, code?, link?, image?, strike? }
 *   或换行 run：{ br: true }
 *
 * 相邻同样式会合并（PDF 侧按 run 计算字宽，run 太多会拖慢排版）。
 */
export function parseInline(raw) {
  const runs = []
  const push = (text, style) => {
    // 换行 run 没有文字，必须放行（否则 <br> 与硬换行会被 `if (!text) return` 吃掉）
    if (!style?.br && !text) return
    const last = runs[runs.length - 1]
    if (
      last &&
      !last.br &&
      !style.br &&
      !style.link &&
      !last.link &&
      !!last.image === !!style.image &&
      !!last.bold === !!style.bold &&
      !!last.italic === !!style.italic &&
      !!last.code === !!style.code &&
      !!last.strike === !!style.strike
    ) {
      last.text += text
      return
    }
    runs.push(style.br ? { br: true } : { text, ...style })
  }

  let i = 0
  let buffer = ""
  const flush = () => {
    if (buffer) {
      push(buffer, {})
      buffer = ""
    }
  }
  const source = String(raw ?? "")

  while (i < source.length) {
    const ch = source[i]

    // 硬换行占位（段落拼接时写入）
    if (source.startsWith(SENTINEL, i)) {
      flush()
      push("", { br: true })
      i += SENTINEL.length
      continue
    }

    // 反斜杠转义：\* 之类按字面量输出
    if (ch === "\\" && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(source[i + 1])) {
      buffer += source[i + 1]
      i += 2
      continue
    }

    // 行内代码：`code` / ``code``
    if (ch === "`") {
      const fence = /^`+/.exec(source.slice(i))[0]
      const close = source.indexOf(fence, i + fence.length)
      if (close > 0) {
        flush()
        push(source.slice(i + fence.length, close).trim(), { code: true })
        i = close + fence.length
        continue
      }
    }

    // 图片：![alt](src) —— 保留 src，PDF 侧要真的把图嵌进去（预览里也是显示图片）
    if (ch === "!" && source[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(source.slice(i))
      if (m) {
        flush()
        push(m[1] || m[2] || "图片", { image: true, src: m[2] })
        i += m[0].length
        continue
      }
    }

    // 链接：[text](url) —— 允许链接文字里再带强调
    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)/.exec(source.slice(i))
      if (m) {
        flush()
        const label = m[1] || m[2]
        const inner = parseInline(label)
        for (const run of inner) push(run.text, { ...run, link: m[2] })
        i += m[0].length
        continue
      }
    }

    // 自动链接：<https://...>
    if (ch === "<") {
      const auto = /^<((?:https?|mailto|ftp):[^>\s]+)>/i.exec(source.slice(i))
      if (auto) {
        flush()
        push(auto[1], { link: auto[1] })
        i += auto[0].length
        continue
      }
      // 原始 HTML 标签：与预览的判定完全一致（见 SAFE_HTML_TAGS 的注释）。
      // <br> / <hr> 变成换行；白名单标签丢掉标签、保留内文；其余原样当文本。
      const tag = TAG_RE.exec(source.slice(i))
      if (tag) {
        const name = tag[2].toLowerCase()
        if (SAFE_HTML_TAGS.has(name)) {
          flush()
          if (name === "br" || name === "hr") push("", { br: true })
          i += tag[0].length
          continue
        }
        // 不在白名单：保留原样的字面文本（预览里也是这么显示的）
      }
    }

    // 删除线：~~text~~（预览渲染成 <del>，PDF 里画一条穿过的线）
    if (ch === "~" && source.startsWith("~~", i)) {
      const closeIdx = source.indexOf("~~", i + 2)
      if (closeIdx > i + 2) {
        flush()
        for (const run of parseInline(source.slice(i + 2, closeIdx))) {
          push(run.text, { ...run, strike: true })
        }
        i = closeIdx + 2
        continue
      }
    }

    // 强调：** __ * _
    if (ch === "*" || ch === "_") {
      const strong = source.startsWith(ch.repeat(2), i)
      const marker = strong ? ch.repeat(2) : ch
      const closeIdx = findEmphasisClose(source, i + marker.length, marker)
      if (closeIdx > 0) {
        flush()
        const innerText = source.slice(i + marker.length, closeIdx)
        for (const run of parseInline(innerText)) {
          if (run.br) {
            push("", { br: true })
            continue
          }
          push(run.text, { ...run, bold: run.bold || strong, italic: run.italic || !strong })
        }
        i = closeIdx + marker.length
        continue
      }
    }

    buffer += ch
    i += 1
  }
  flush()

  return runs.filter((run) => run.br || run.text.length > 0)
}

function findEmphasisClose(source, from, marker) {
  let i = from
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2
      continue
    }
    if (source.startsWith(marker, i)) {
      // 不把空内容当强调（"**" 单独出现时按字面量）
      if (i > from) return i
      return -1
    }
    i += 1
  }
  return -1
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

const RE_HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const RE_QUOTE = /^ {0,3}> ?(.*)$/
const RE_UL = /^(\s*)([-*+])\s+(.*)$/
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const RE_TABLE_SEP = /^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/
const RE_SETEXT = /^ {0,3}(=+|-+)\s*$/

/**
 * 解析整篇 Markdown。
 * @returns {Array<object>} 块列表（见文件头注释）
 */
export function parseMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n")
  let i = 0

  // YAML front matter：首行 --- 到下一个 --- 之间整段丢弃
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    for (let j = 1; j < lines.length; j += 1) {
      if (/^---\s*$/.test(lines[j])) {
        i = j + 1
        break
      }
    }
  }

  const blocks = []
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    // 围栏代码块
    const fence = RE_FENCE.exec(line)
    if (fence) {
      const marker = fence[1][0].repeat(3)
      const indent = Math.min(line.length - line.trimStart().length, 3)
      const body = []
      i += 1
      while (i < lines.length) {
        const cur = lines[i]
        if (new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{3,}\\s*$`).test(cur)) {
          i += 1
          break
        }
        body.push(cur.slice(Math.min(indent, cur.length - cur.trimStart().length)))
        i += 1
      }
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") })
      continue
    }

    // 水平分割线（必须在 setext / 列表之前判断，`---` 三者都像）
    if (RE_HR.test(line)) {
      blocks.push({ type: "hr" })
      i += 1
      continue
    }

    const heading = RE_HEADING.exec(line)
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inlines: parseInline(heading[2] ?? ""),
      })
      i += 1
      continue
    }

    // Setext 标题：文字行 + === / ---
    if (i + 1 < lines.length && RE_SETEXT.test(lines[i + 1]) && line.trim()) {
      blocks.push({
        type: "heading",
        level: lines[i + 1].trim()[0] === "=" ? 1 : 2,
        inlines: parseInline(line.trim()),
      })
      i += 2
      continue
    }

    // 引用：收集连续的 > 行，递归解析
    if (RE_QUOTE.test(line)) {
      const inner = []
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || !lines[i].trim())) {
        if (!lines[i].trim()) {
          // 引用块里的空行：只有下一行仍是引用才继续
          if (i + 1 < lines.length && RE_QUOTE.test(lines[i + 1])) {
            inner.push("")
            i += 1
            continue
          }
          break
        }
        inner.push(RE_QUOTE.exec(lines[i])[1])
        i += 1
      }
      blocks.push({ type: "quote", blocks: parseMarkdown(inner.join("\n")) })
      continue
    }

    // 表格：本行含 | 且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const header = splitTableRow(line)
      const align = splitTableRow(lines[i + 1]).map((cell) => {
        const t = cell.trim()
        if (t.startsWith(":") && t.endsWith(":")) return "center"
        if (t.endsWith(":")) return "right"
        return "left"
      })
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      blocks.push({
        type: "table",
        align,
        header: header.map((cell) => parseInline(cell)),
        rows: rows.map((row) => row.map((cell) => parseInline(cell))),
      })
      continue
    }

    // 列表
    const ul = RE_UL.exec(line)
    const ol = RE_OL.exec(line)
    if (ul || ol) {
      const parsed = parseList(lines, i)
      blocks.push(parsed.list)
      i = parsed.next
      continue
    }

    // 段落：一直吃到空行 / 其它块起始
    const paragraph = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
      paragraph.push(lines[i])
      i += 1
    }
    if (!paragraph.length) {
      // 兜底：这一行既不是任何已知块，也无法并入段落（理论上不会发生）
      paragraph.push(lines[i] ?? "")
      i += 1
    }
    blocks.push({ type: "para", inlines: parseInline(joinSoftLines(paragraph)) })
  }

  return blocks
}

/** 这一行是否开始了另一个块（段落收集时用来截断） */
function isBlockStart(lines, i) {
  const line = lines[i]
  if (RE_FENCE.test(line)) return true
  if (RE_HR.test(line)) return true
  if (RE_HEADING.test(line)) return true
  if (RE_QUOTE.test(line)) return true
  if (RE_UL.test(line) || RE_OL.test(line)) return true
  if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) return true
  return false
}

/**
 * 把段落的多个物理行拼成一行。
 *
 * Markdown 里一个段落内的换行是"软换行"，语义上是一个空格；但中文写作习惯下
 * 那个空格会跑进正文中间（"这是\n一句话" → "这是 一句话"），所以两侧都是全角字符
 * 时不加空格。行尾两个空格或反斜杠是硬换行，这里保留成空格（PDF 侧按段内折行处理，
 * 纯文本侧一个空格已经足够）。
 */
function joinSoftLines(lines) {
  // 与**预览完全一致**（web/src/lib/markdown.ts 的 inline()）：
  //   - 软换行（普通 \n）在浏览器里会折叠成**一个空格**，所以这里也补一个空格；
  //     以前对"CJK 两侧不加空格"的处理看起来更漂亮，但那会让 PDF 与预览出现
  //     "同一句话少了一个空格"的差异 —— 用户明确要求两者逐字一致，见
  //     scripts/markdown-parity-test.mjs；
  //   - 行尾两个以上空格或一个反斜杠 = **硬换行**（预览渲染成 <br />），
  //     这里用 SENTINEL 占位，交给 parseInline 变成 { br: true } 的换行 run。
  let out = ""
  lines.forEach((raw, index) => {
    const hardBreak = /( {2,}|\\)$/.test(raw)
    let line = raw.replace(/\s+$/, "")
    if (hardBreak) line = line.replace(/\\$/, "")
    if (index > 0) out += " "
    out += line
    if (hardBreak && index < lines.length - 1) out += SENTINEL
  })
  return out.replace(/[ \t]{2,}/g, " ").trim()
}

function splitTableRow(line) {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|")) body = body.slice(0, -1)
  const cells = []
  let cur = ""
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|"
      i += 1
      continue
    }
    if (ch === "|") {
      cells.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  cells.push(cur)
  // 单元格两侧的空白属于排版格式，不属于内容：`| md | → txt |` 的正文是 "md"
  return cells.map((cell) => cell.trim())
}

/**
 * 收集一个列表（可含多行条目、嵌套缩进、任务列表标记）。
 * 返回 { list, next }（next 指向列表之后的第一行）。
 */
function parseList(lines, start) {
  const first = RE_UL.exec(lines[start]) || RE_OL.exec(lines[start])
  const ordered = !RE_UL.test(lines[start])
  const list = { type: "list", ordered, start: ordered ? Number(first[2]) : 0, items: [] }
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      // 空行之后若还是同类型的列表条目就继续，否则列表结束
      const next = lines[i + 1]
      const nextSame = next && (ordered ? RE_OL.test(next) && !RE_UL.test(next) : RE_UL.test(next))
      if (nextSame) {
        i += 1
        continue
      }
      break
    }
    const ul = RE_UL.exec(line)
    const ol = RE_OL.exec(line)
    if (!ul && !ol) {
      // 续行：缩进足够就并入上一条目
      const indent = line.length - line.trimStart().length
      const last = list.items[list.items.length - 1]
      if (last && indent >= 2) {
        last.inlines = parseInline(`${runsToMarkdown(last.inlines)} ${line.trim()}`)
        i += 1
        continue
      }
      break
    }
    // 标记类型变了（无序里嵌了有序列表，或反之）就收手：交给外层当成一个新列表解析，
    // 否则 "1." 会被当成 "-" 渲染（两种标记在同一个 list 里没法区分）
    if (Boolean(ol) !== ordered) break
    const match = ul || ol
    const indent = match[1].length
    const level = indent >= 4 ? 2 : indent >= 2 ? 1 : 0
    let content = match[3]
    let task = null
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content)
    if (taskMatch) {
      task = taskMatch[1].toLowerCase() === "x"
      content = taskMatch[2]
    }
    list.items.push({ level, task, inlines: parseInline(content) })
    i += 1
  }

  return { list, next: i }
}

/** 把 run 还原成 Markdown 片段（续行合并时用，保持既有样式不丢） */
function runsToMarkdown(runs) {
  return runs
    .map((run) => {
      if (run.code) return `\`${run.text}\``
      if (run.link) return `[${run.text}](${run.link})`
      let out = run.text
      if (run.bold) out = `**${out}**`
      if (run.italic) out = `*${out}*`
      return out
    })
    .join("")
}

// ---------------------------------------------------------------------------
// 纯文本输出（.md → .txt）
// ---------------------------------------------------------------------------

/**
 * 把块列表渲染成纯文本。
 *
 * 目标是"用记事本打开也能读"：去掉所有 Markdown 标记，但保留层级感
 * （列表用 - / 1. 前缀、引用用 > 前缀、代码块原样）。刻意**不重新折行** ——
 * 纯文本阅读器自己有自动换行，硬折行反而在窄窗口里更难读。
 */
export function toPlainText(blocks, { indent = "" } = {}) {
  const out = []
  let listCounter = 0
  let prevType = null

  for (const block of blocks) {
    const top = out.length === 0
    switch (block.type) {
      case "heading": {
        if (!top) out.push("")
        out.push(`${indent}${inlineToText(block.inlines, { keepUrl: true })}`)
        out.push("")
        break
      }
      case "para": {
        // 段落之间空行，但紧跟在列表后面的段落不需要（视觉上已经分开）
        if (prevType && prevType !== "para" && prevType !== "list" && prevType !== "quote") out.push("")
        out.push(`${indent}${inlineToText(block.inlines, { keepUrl: true })}`)
        out.push("")
        break
      }
      case "list": {
        listCounter = block.start || 1
        for (const item of block.items) {
          const pad = indent + "  ".repeat(item.level || 0)
          const bullet = block.ordered ? `${listCounter}. ` : "- "
          if (block.ordered && (item.level || 0) === 0) listCounter += 1
          const task = item.task === null || item.task === undefined ? "" : item.task ? "[x] " : "[ ] "
          out.push(`${pad}${bullet}${task}${inlineToText(item.inlines, { keepUrl: true })}`)
        }
        out.push("")
        break
      }
      case "code": {
        out.push("")
        for (const line of block.text.split("\n")) out.push(`${indent}    ${line}`.trimEnd())
        out.push("")
        break
      }
      case "quote": {
        const inner = toPlainText(block.blocks, { indent: "" }).replace(/\n{3,}/g, "\n\n").trim()
        for (const line of inner.split("\n")) out.push(`${indent}> ${line}`.trimEnd())
        out.push("")
        break
      }
      case "table": {
        const width = block.header.length
        const sep = block.align.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : ":---"))
        const cells = (row) => {
          const padded = []
          for (let c = 0; c < width; c += 1) padded.push(inlineToText(row[c] ?? [], { keepUrl: true }))
          return `${indent}| ${padded.join(" | ")} |`
        }
        out.push(cells(block.header))
        out.push(`${indent}| ${sep.join(" | ")} |`)
        for (const row of block.rows) out.push(cells(row))
        out.push("")
        break
      }
      case "hr": {
        out.push(`${indent}----------------------------------------`)
        out.push("")
        break
      }
      default:
        break
    }
    prevType = block.type
  }

  // 收尾：去掉末尾多余空行，压掉连续 3 个以上空行
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n"
}

/**
 * 行内 run → 纯文本。
 * 链接默认保留 URL（纯文本里没有可点击的东西，丢掉 href 就等于丢信息），
 * 图片用 `[图片: alt]` 占位。
 */
export function inlineToText(runs, { keepUrl = true } = {}) {
  let out = ""
  for (const run of runs) {
    let text = run.text
    if (run.image) {
      out += `[图片: ${text}]`
      continue
    }
    if (run.link && keepUrl && run.link !== text) {
      text = `${text} (${run.link})`
    }
    out += text
  }
  return out
}
