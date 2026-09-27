#!/usr/bin/env node
/**
 * validate-mdx.mjs —— ZeroShadow 文档（Fumadocs）的 MDX 安全校验器
 *
 * 为什么需要它：
 *   MDX 同时按 Markdown 和 JSX 解析。正文里裸写 `{` `}` 会被当成 JavaScript
 *   表达式求值，裸写 `<abc` 会被当成 JSX 标签——两者都会让 Fumadocs **构建直接失败**，
 *   而且报错位置往往离真正的问题很远。人工通读几千行中文文档极易漏，
 *   所以把检查写成脚本。
 *
 *   关键点：**组件标签内部的 `{}` 是合法的**（`<Tabs items={['a','b']}>` 就是这么写的），
 *   所以校验时必须先把组件标签整体掩码掉，否则会满屏误报。
 *
 * 检查项：
 *   1. frontmatter 必须有 title 与 description
 *   2. 正文出现裸 `{` / `}`（不在代码、不在组件标签内）
 *   3. 正文出现可疑的 `<`（后面紧跟字母/下划线，且不是允许的组件标签）
 *   4. 每个代码围栏必须标语言
 *   5. 正文不应出现 H1（标题由 frontmatter 渲染）
 *   6. 用到的组件必须在白名单内（用户站点不一定装了别的组件）
 *   7. 站内链接 /docs/... 必须指向真实存在的页面（含组件 href 属性）
 *   8. 图片引用必须能在 public/img 里找到
 *   9. meta.json 里列出的页面必须存在，且目录下没有漏列的页面
 *
 * 用法：
 *   node docs/mdx/.authoring/validate-mdx.mjs [docs/mdx]
 * 退出码 = 问题数量（0 表示全部通过）。
 */

import fs from "node:fs"
import path from "node:path"

const bundleRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."))
const contentRoot = path.join(bundleRoot, "content", "docs")
const publicRoot = path.join(bundleRoot, "public")

const ALLOWED_COMPONENTS = new Set([
  "Callout",
  "Cards", "Card",
  "Steps", "Step",
  "Tabs", "Tab",
  "Files", "File", "Folder",
  "Accordions", "Accordion",
])

const problems = []
const warnings = []

function report(file, line, kind, message) {
  problems.push({ file, line, kind, message })
}
function warn(file, message) {
  warnings.push({ file, message })
}

// ---------------------------------------------------------------------------
// 收集所有页面
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith(".mdx")) out.push(full)
  }
  return out
}

if (!fs.existsSync(contentRoot)) {
  console.error(`找不到内容目录：${contentRoot}`)
  process.exit(1)
}
const files = walk(contentRoot).sort()

// 站点路径 -> 文件，用于校验站内链接
const routeToFile = new Map()
for (const file of files) {
  let rel = path.relative(contentRoot, file).replace(/\\/g, "/").replace(/\.mdx$/, "")
  if (rel === "index") rel = ""
  routeToFile.set(`/docs${rel ? "/" + rel : ""}`, file)
}

// ---------------------------------------------------------------------------
// 掩码工具：把「MDX 不解析的区域」替换成等长空格，保留换行以维持行号
// ---------------------------------------------------------------------------
function blank(chars, from, to, source) {
  for (let k = from; k <= to; k++) chars[k] = source[k] === "\n" ? "\n" : " "
}

/** 掩码围栏代码块与行内代码；同时报告未标语言的围栏与未闭合围栏 */
function maskCode(text, file, lineOf) {
  const chars = text.split("")
  const fenceRe = /^([ \t]*)(```+|~~~+)(.*)$/gm
  const fences = []
  let m
  while ((m = fenceRe.exec(text))) fences.push({ index: m.index, end: m.index + m[0].length, lang: m[3].trim() })

  for (let i = 0; i < fences.length; i += 2) {
    const open = fences[i]
    const close = fences[i + 1]
    const from = open.index
    const to = close ? close.end : text.length
    blank(chars, from, to - 1, text)
    if (!open.lang.split(/\s+/)[0]) {
      report(file, lineOf(open.index), "code-fence", "代码围栏没有标语言（请用 ```bash / ```json / ```text 等）")
    }
  }
  if (fences.length % 2 !== 0) {
    const last = fences[fences.length - 1]
    report(file, lineOf(last.index), "code-fence", "代码围栏没有闭合")
  }

  // 行内代码（支持 ``...``），在上一步的掩码之上继续处理
  const partial = chars.join("")
  const inlineRe = /(`+)([\s\S]*?)\1/g
  let im
  while ((im = inlineRe.exec(partial))) {
    blank(chars, im.index, im.index + im[0].length - 1, text)
  }
  return chars.join("")
}

/**
 * 掩码「允许的组件标签」整体（含其属性里的 {}）。
 * 用方括号/引号配对扫描，正确处理多行标签与 `items={[...]}` 这类表达式。
 */
function maskComponentTags(text) {
  const chars = text.split("")
  const re = /<\/?([A-Za-z][A-Za-z0-9]*)/g
  let m
  while ((m = re.exec(text))) {
    if (!ALLOWED_COMPONENTS.has(m[1])) continue
    let i = m.index + m[0].length
    let braceDepth = 0
    let quote = null
    let end = -1
    for (; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue }
      if (ch === "{") { braceDepth++; continue }
      if (ch === "}") { braceDepth--; continue }
      if (ch === ">" && braceDepth === 0) { end = i; break }
    }
    if (end === -1) {
      warn("(未知文件)", `组件标签可能未闭合，起始偏移 ${m.index}`)
      continue
    }
    blank(chars, m.index, end, text)
    re.lastIndex = end + 1
  }
  return chars.join("")
}

function makeLineOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1)
  return (offset) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

function lineStartOffsets(text) {
  const set = new Set([0])
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") set.add(i + 1)
  return set
}

// ---------------------------------------------------------------------------
// 逐文件检查
// ---------------------------------------------------------------------------
for (const file of files) {
  const relFile = path.relative(bundleRoot, file).replace(/\\/g, "/")
  const raw = fs.readFileSync(file, "utf8")
  const lines = raw.split(/\r?\n/)

  // ---- frontmatter ----
  let frontmatter = null
  let bodyStartLine = 0
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1)
    if (end > 0) {
      frontmatter = lines.slice(1, end).join("\n")
      bodyStartLine = end + 1
    }
  }
  if (frontmatter === null) {
    report(relFile, 1, "frontmatter", "缺少 frontmatter（第一行应为 ---）")
  } else {
    for (const key of ["title", "description"]) {
      if (!new RegExp(`^${key}\\s*:\\s*\\S`, "m").test(frontmatter)) {
        report(relFile, 1, "frontmatter", `frontmatter 缺少必填字段 ${key}`)
      }
    }
  }

  const lineOf = makeLineOf(raw)
  const bodyText = lines.slice(bodyStartLine).join("\n")

  // 只对正文做掩码，行号要加回 frontmatter 的偏移
  const bodyLineOf = (offset) => bodyStartLine + lineOf(offset)

  const noCode = maskCode(bodyText, relFile, bodyLineOf)
  const noCodeNoTags = maskComponentTags(noCode)

  // ---- 裸花括号 / 可疑尖括号 ----
  for (const m of noCodeNoTags.matchAll(/[{}]/g)) {
    report(relFile, bodyLineOf(m.index), "bare-brace",
      `正文里有裸的 '${m[0]}'——MDX 会当作 JS 表达式，必须裹进反引号`)
  }
  for (const m of noCodeNoTags.matchAll(/<([A-Za-z_][A-Za-z0-9_.-]*)/g)) {
    report(relFile, bodyLineOf(m.index), "angle-bracket",
      `可疑的 '<${m[1]}'——既不是允许的组件标签，也不在反引号里`)
  }

  // ---- H1 ----
  const starts = lineStartOffsets(bodyText)
  for (const m of noCodeNoTags.matchAll(/^#\s+\S.*$/gm)) {
    if (starts.has(m.index)) {
      report(relFile, bodyLineOf(m.index), "h1",
        "正文里出现 H1（# ）——标题由 frontmatter 渲染，请从 ## 开始")
    }
  }

  // ---- 组件白名单（在未掩码标签的版本上找）----
  for (const m of noCode.matchAll(/<\/?([A-Z][A-Za-z0-9]*)/g)) {
    if (!ALLOWED_COMPONENTS.has(m[1])) {
      warn(relFile, `第 ${bodyLineOf(m.index)} 行使用了白名单外的组件 <${m[1]}>`)
    }
  }

  // ---- 站内链接：Markdown 形式 + 组件 href 属性 ----
  for (const m of noCode.matchAll(/\]\((\/docs[^)\s#]*)(#[^)\s]*)?\)/g)) {
    const target = m[1].replace(/\/$/, "")
    if (!routeToFile.has(target)) {
      report(relFile, bodyLineOf(m.index), "link", `站内链接指向不存在的页面：${m[1]}`)
    }
  }
  for (const m of noCode.matchAll(/href\s*=\s*"(\/docs[^"\s#]*)(#[^"\s]*)?"/g)) {
    const target = m[1].replace(/\/$/, "")
    if (!routeToFile.has(target)) {
      report(relFile, bodyLineOf(m.index), "link", `组件 href 指向不存在的页面：${m[1]}`)
    }
  }
  for (const m of noCode.matchAll(/\]\(([^)\s]+\.mdx?)(#[^)\s]*)?\)/g)) {
    report(relFile, bodyLineOf(m.index), "link",
      `残留的相对 Markdown 链接：${m[1]}（应改成 /docs/... 形式的站点路径）`)
  }

  // ---- 图片 ----
  for (const m of noCode.matchAll(/!\[[^\]]*\]\((\/[^)\s]+)\)/g)) {
    const src = decodeURIComponent(m[1])
    if (src.startsWith("/img/")) {
      const target = path.join(publicRoot, src.replace(/^\//, ""))
      if (!fs.existsSync(target)) {
        report(relFile, bodyLineOf(m.index), "image", `图片不存在：${src}（应位于 public${src}）`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// meta.json 校验
// ---------------------------------------------------------------------------
function checkMeta(dir) {
  const metaPath = path.join(dir, "meta.json")
  if (!fs.existsSync(metaPath)) return
  const relMeta = path.relative(bundleRoot, metaPath).replace(/\\/g, "/")
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"))
  } catch (err) {
    report(relMeta, 0, "meta", `JSON 解析失败：${err.message}`)
    return
  }
  if (!Array.isArray(meta.pages)) return

  for (const page of meta.pages) {
    if (page === "...") continue
    const asDir = path.join(dir, page)
    const asFile = path.join(dir, `${page}.mdx`)
    if (!fs.existsSync(asFile) && !fs.existsSync(asDir)) {
      report(relMeta, 0, "meta", `meta.json 里列出的 "${page}" 既不是页面也不是目录`)
    }
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    if (!entry.name.endsWith(".mdx")) continue
    const slug = entry.name.replace(/\.mdx$/, "")
    if (!meta.pages.includes(slug)) {
      warn(relMeta, `"${slug}.mdx" 没有被 meta.json 的 pages 列出，侧边栏可能不显示`)
    }
  }
}

function walkDirs(dir) {
  checkMeta(dir)
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walkDirs(path.join(dir, entry.name))
  }
}
walkDirs(contentRoot)

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log(`校验 ${files.length} 个 MDX 页面\n`)

if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：\n`)
  const byFile = new Map()
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, [])
    byFile.get(p.file).push(p)
  }
  for (const [file, list] of byFile) {
    console.log(`  ${file}`)
    for (const p of list) {
      const where = p.line ? `第 ${p.line} 行` : "（文件级）"
      console.log(`    [${p.kind}] ${where}  ${p.message}`)
    }
    console.log("")
  }
} else {
  console.log("没有发现问题。\n")
}

if (warnings.length) {
  console.log(`另有 ${warnings.length} 条提醒（不阻断构建）：\n`)
  for (const w of warnings) console.log(`  ${w.file}: ${w.message}`)
  console.log("")
}

process.exit(problems.length)
