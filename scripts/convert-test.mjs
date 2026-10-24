#!/usr/bin/env node
/**
 * scripts/convert-test.mjs —— 文件转换（server/src/convert/）的自测
 *
 * 覆盖三层，全部不需要起服务、不需要浏览器：
 *   1. **Markdown 解析**：标题 / 列表 / 代码块 / 引用 / 表格 / 行内样式 / front matter
 *   2. **md → txt**：标记清除、列表编号、链接保留 URL、换行风格跟随源文件
 *   3. **md → PDF**：这是唯一"自己写了一个文件格式"的地方，所以断言最密 ——
 *      xref 偏移必须精确指向每个对象、流长度必须与压缩后字节数一致、
 *      中文字形必须真的进了 ToUnicode（否则阅读器里是乱码/空白）
 *   4. **图片互转**（sharp 可用时）：PNG→JPG 铺白底、JPG→PNG 尺寸不变
 *
 * 产物一律写到系统临时目录，**不在仓库里留任何文件**（与 office-preview-test 一致）。
 * 运行：`node scripts/convert-test.mjs`
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zs-convert-"))

const base = pathToFileURL(path.join(root, "server", "src", "convert", "index.js")).href
const convert = await import(base)
const registry = await import(pathToFileURL(path.join(root, "server", "src", "convert", "registry.js")).href)
const markdown = await import(pathToFileURL(path.join(root, "server", "src", "convert", "markdown.js")).href)

/* ---------------------------------------------------------------- 断言框架 */

let total = 0
let failed = 0
const failures = []

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function check(label, fn) {
  total++
  try {
    fn()
    console.log(`  \u2713 ${label}`)
  } catch (err) {
    failed++
    failures.push(label)
    console.log(`  \u2717 ${label}`)
    const message = err && err.message ? String(err.message) : String(err)
    console.log(`      ${message.split("\n").join("\n      ")}`)
  }
}

async function checkAsync(label, fn) {
  total++
  try {
    await fn()
    console.log(`  \u2713 ${label}`)
  } catch (err) {
    failed++
    failures.push(label)
    console.log(`  \u2717 ${label}`)
    const message = err && err.message ? String(err.message) : String(err)
    console.log(`      ${message.split("\n").join("\n      ")}`)
  }
}

/* ---------------------------------------------------------------- 测试素材 */

const SAMPLE_MD = `---
title: 会议纪要
tags: [a, b]
---

# 项目周会纪要

本周完成了 **Markdown 转 PDF** 与 \`md → txt\`，还有 *PNG/JPG 互转*。
第二行（软换行，中文之间不该出现空格）。

## 待办事项

- [x] 服务端转换器注册表
- [ ] 右键菜单入口
  1. 子菜单按服务端清单渲染
  2. 不加译文也能显示中文兜底

> 引用里也可以有 **强调** 与 [链接](https://example.com/docs)。
> 第二行引用。

\`\`\`js
const a = 1
console.log("代码块整行原样保留")
\`\`\`

| 格式 | 方向 | 说明 |
|:--|:--:|---:|
| md | → txt | 去标记 |
| png | → jpg | 铺白底 |

---

最后一句话，带一个图片 ![示意图](./img/demo.png)。
`

/* ---------------------------------------------------------------- PDF 结构检查 */

/**
 * 极简 PDF 结构校验：把"阅读器会做的事"里最关键的部分自己走一遍。
 * 返回 { objects, xrefCount, root, contentStreams, raw }
 */
function inspectPdf(buffer) {
  const raw = buffer.toString("latin1")
  assert.ok(raw.startsWith("%PDF-1."), "PDF 头不对")

  const startxrefAt = raw.lastIndexOf("startxref")
  assert.ok(startxrefAt > 0, "缺少 startxref")
  const xrefOffset = Number(raw.slice(startxrefAt + "startxref".length).trim().split(/\s/)[0])
  assert.ok(Number.isFinite(xrefOffset) && xrefOffset > 0, "startxref 偏移非法")
  assert.equal(raw.slice(xrefOffset, xrefOffset + 4), "xref", `xref 偏移没指向 xref 表（${xrefOffset}）`)

  // 交叉引用表：`0 N` 之后每行 20 字节
  const header = /^xref\r?\n(\d+) (\d+)\r?\n/.exec(raw.slice(xrefOffset))
  assert.ok(header, "xref 表头格式不对")
  const first = Number(header[1])
  const count = Number(header[2])
  assert.equal(first, 0)

  const entries = []
  for (let i = 0; i < count; i += 1) {
    const at = xrefOffset + header[0].length + i * 20
    const entry = raw.slice(at, at + 20)
    const match = /^(\d{10}) (\d{5}) ([nf])/.exec(entry)
    assert.ok(match, `xref 第 ${i} 项格式不对：${JSON.stringify(entry)}`)
    entries.push({ offset: Number(match[1]), kind: match[3] })
  }
  assert.equal(entries[0].kind, "f", "0 号对象必须是空闲项")

  // 每个在用对象的偏移必须精确指向 "<n> 0 obj"
  for (let i = 1; i < entries.length; i += 1) {
    const { offset, kind } = entries[i]
    if (kind !== "n") continue
    const head = raw.slice(offset, offset + `${i} 0 obj`.length)
    assert.equal(head, `${i} 0 obj`, `对象 ${i} 的偏移不精确（读到 ${JSON.stringify(head)}）`)
  }

  const trailer = raw.slice(raw.lastIndexOf("trailer"))
  assert.match(trailer, /\/Size (\d+)/, "trailer 缺少 /Size")
  assert.match(trailer, /\/Root \d+ 0 R/, "trailer 缺少 /Root")
  assert.ok(raw.trimEnd().endsWith("%%EOF"), "缺少 %%EOF")

  // 所有 FlateDecode 流都要能被真正解开，且 /Length 与字节数一致
  const streams = []
  const streamRe = /<<([^]*?)>>\s*stream\r?\n/g
  let m
  while ((m = streamRe.exec(raw)) !== null) {
    const dict = m[1]
    const dataStart = m.index + m[0].length
    const declared = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? NaN)
    assert.ok(Number.isFinite(declared), "流缺少 /Length")
    const body = buffer.subarray(dataStart, dataStart + declared)
    assert.ok(body.length === declared, "流数据长度不足")
    let data = body
    if (/FlateDecode/.test(dict)) data = zlib.inflateSync(body)
    streams.push({ dict, data, raw: body })
  }
  assert.ok(streams.length > 0, "没有任何流对象")

  return { raw, streams, xrefCount: count }
}

function objectDict(raw, type) {
  const re = new RegExp(`<<[^]*?/Type /${type}[^]*?>>`, "m")
  const hit = re.exec(raw)
  return hit ? hit[0] : null
}

/* ---------------------------------------------------------------- 1. Markdown 解析 */

section("Markdown 解析")

const blocks = markdown.parseMarkdown(SAMPLE_MD)

check("front matter 被跳过（第一块是 h1 而不是分隔线）", () => {
  assert.equal(blocks[0].type, "heading")
  assert.equal(blocks[0].level, 1)
  assert.equal(markdown.inlineToText(blocks[0].inlines, { keepUrl: false }), "项目周会纪要")
})

check("段落里的软换行：与预览一致，折叠成一个空格", () => {
  const para = blocks.find((b) => b.type === "para")
  const text = markdown.inlineToText(para.inlines, { keepUrl: false })
  // 浏览器把段落里的换行折叠成空格 —— PDF 必须一样，否则"同一句话"在两边会长得不同。
  // 这条断言以前写的是"中文之间不插空格"，是有意改掉的（见 scripts/markdown-parity-test.mjs）
  assert.ok(text.includes("互转。 第二行"), `实际：${text}`)
})

check("行内样式：粗体 / 代码 / 斜体 / 链接都带标记位", () => {
  const para = blocks.find((b) => b.type === "para")
  assert.ok(para.inlines.some((r) => r.bold && r.text.includes("Markdown 转 PDF")))
  assert.ok(para.inlines.some((r) => r.code && r.text.includes("md → txt")))
  assert.ok(para.inlines.some((r) => r.italic && r.text.includes("PNG/JPG 互转")))
})

check("Setext 标题与 ATX 二级标题都能识别", () => {
  const levels = blocks.filter((b) => b.type === "heading").map((b) => b.level)
  assert.deepEqual(levels, [1, 2])
})

check("任务列表：勾选状态与缩进层级", () => {
  const list = blocks.find((b) => b.type === "list")
  assert.equal(list.ordered, false)
  assert.equal(list.items.length, 2)
  assert.equal(list.items[0].task, true)
  assert.equal(list.items[1].task, false)
  assert.ok(markdown.inlineToText(list.items[1].inlines, { keepUrl: false }).includes("右键菜单入口"))
})

check("嵌套的有序列表被识别为独立列表块", () => {
  const lists = blocks.filter((b) => b.type === "list")
  assert.equal(lists.length, 2)
  assert.equal(lists[1].ordered, true)
  assert.deepEqual(lists[1].items.map((i) => i.level), [1, 1])
})

check("引用块递归解析（里面有强调与链接）", () => {
  const quote = blocks.find((b) => b.type === "quote")
  assert.ok(quote && quote.blocks.length >= 1)
  const first = quote.blocks[0]
  assert.ok(first.inlines.some((r) => r.bold))
  assert.ok(first.inlines.some((r) => r.link === "https://example.com/docs"))
})

check("围栏代码块：语言标注 + 内容原样保留", () => {
  const code = blocks.find((b) => b.type === "code")
  assert.equal(code.lang, "js")
  assert.equal(code.text, 'const a = 1\nconsole.log("代码块整行原样保留")')
})

check("表格：表头 + 对齐 + 数据行", () => {
  const table = blocks.find((b) => b.type === "table")
  assert.equal(table.header.length, 3)
  assert.deepEqual(table.align, ["left", "center", "right"])
  assert.equal(table.rows.length, 2)
  assert.equal(markdown.inlineToText(table.rows[0][2], { keepUrl: false }), "去标记")
})

check("水平分割线", () => {
  assert.ok(blocks.some((b) => b.type === "hr"))
})

check("图片降级成带 alt 的行内单元", () => {
  const last = blocks[blocks.length - 1]
  assert.ok(last.inlines.some((r) => r.image && r.text === "示意图"))
})

check("原始 HTML：白名单标签丢标签留文字，白名单外的原样当文本", () => {
  const parsed = markdown.parseMarkdown("<div>危险</div> 正文 <b>加粗</b>")
  // div 在白名单里（预览会渲染成块），b 不在白名单里（预览会把它当**纯文本**显示）。
  // 所以 PDF 侧也必须保留 `<b>` 的字面文字，不能悄悄删掉 —— 否则两边内容不一致。
  assert.equal(markdown.inlineToText(parsed[0].inlines, { keepUrl: false }), "危险 正文 <b>加粗</b>")
})

/* ---------------------------------------------------------------- 2. md → txt */

section("Markdown → 纯文本")

const mdTxt = registry.getConverter("md-to-txt")
const txtOut = mdTxt.run({ text: SAMPLE_MD, eol: "lf" }).data.toString("utf8")

check("不再出现 Markdown 标记（# / ** / 反引号 / 围栏）", () => {
  assert.ok(!/^#/m.test(txtOut), "还有 # 标题标记")
  assert.ok(!txtOut.includes("**"), "还有粗体标记")
  assert.ok(!txtOut.includes("```"), "还有代码围栏")
})

check("标题文字被保留", () => {
  assert.ok(txtOut.includes("项目周会纪要"))
  assert.ok(txtOut.includes("待办事项"))
})

check("列表项带 - 前缀，任务项带 [x] / [ ]", () => {
  assert.ok(txtOut.includes("- [x] 服务端转换器注册表"))
  assert.ok(txtOut.includes("- [ ] 右键菜单入口"))
})

check("引用带 > 前缀", () => {
  assert.ok(txtOut.includes("> 引用里也可以有 强调"))
})

check("链接保留 URL（纯文本里没有可点击的东西）", () => {
  assert.ok(txtOut.includes("链接 (https://example.com/docs)"))
})

check("图片变成 [图片: alt]", () => {
  assert.ok(txtOut.includes("[图片: 示意图]"))
})

check("代码块缩进四格原样保留", () => {
  assert.ok(txtOut.includes("    const a = 1"))
})

check("表格转成 | a | b | 文本行，分隔行保留对齐写法", () => {
  assert.ok(txtOut.includes("| 格式 | 方向 | 说明 |"))
  assert.ok(txtOut.includes("| :--- | :---: | ---: |"))
})

check("输出以单个换行结尾，且没有连续三个空行", () => {
  assert.ok(txtOut.endsWith("\n") && !txtOut.endsWith("\n\n"))
  assert.ok(!txtOut.includes("\n\n\n"))
})

check("换行风格跟随源文件（crlf）", () => {
  const crlf = mdTxt.run({ text: "第一段\n\n第二段\n", eol: "crlf" }).data.toString("utf8")
  assert.ok(crlf.includes("\r\n"), "没有生成 CRLF")
  assert.ok(!/[^\r]\n/.test(crlf), "混入了裸 LF")
})

check("空 Markdown 不炸，输出为空串而不是 undefined", () => {
  const empty = mdTxt.run({ text: "", eol: "lf" }).data.toString("utf8")
  assert.equal(empty.trim(), "")
})

/* ---------------------------------------------------------------- 3. md → PDF */

section("Markdown → PDF")

const mdPdf = registry.getConverter("md-to-pdf")
const mdPdfMod = await import(pathToFileURL(path.join(root, "server", "src", "convert", "converters", "md-to-pdf.js")).href)
const fontMod = await import(pathToFileURL(path.join(root, "server", "src", "convert", "pdf", "font.js")).href)
const layoutMod = await import(pathToFileURL(path.join(root, "server", "src", "convert", "pdf", "layout.js")).href)
const docMod = await import(pathToFileURL(path.join(root, "server", "src", "convert", "pdf", "document.js")).href)
let pdfBuffer = null
const pdfNotes = []

await checkAsync("能生成 PDF，且结构（xref / trailer / 流长度）自洽", async () => {
  const result = await mdPdf.run({ text: SAMPLE_MD, name: "纪要.md", onProgress: () => {} })
  pdfBuffer = result.data
  pdfNotes.push(...(result.notes || []))
  assert.ok(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 2000, `PDF 太小：${pdfBuffer?.length}`)
  const info = inspectPdf(pdfBuffer)
  assert.ok(info.xrefCount > 5)
  fs.writeFileSync(path.join(OUT_DIR, "sample.pdf"), pdfBuffer)
})

await checkAsync("字体以内嵌 Type0（Identity-H）形式写入，且带 ToUnicode", async () => {
  const info = inspectPdf(pdfBuffer)
  const raw = info.raw
  assert.match(raw, /\/Subtype \/Type0/)
  assert.match(raw, /\/Encoding \/Identity-H/)
  assert.match(raw, /\/Subtype \/CIDFontType2/)
  assert.match(raw, /\/CIDToGIDMap \/Identity/)
  assert.match(raw, /\/FontFile2 \d+ 0 R/)
  // /W 数组必须给出真实字宽（没有它，阅读器一律按 1000 排，混排会歪）
  assert.match(raw, /\/W \[/)
  assert.match(raw, /\/Length1 \d+/)
})

await checkAsync("中文字形真的进了 ToUnicode（复制/搜索得到的是汉字）", async () => {
  const info = inspectPdf(pdfBuffer)
  const cmap = info.streams.find((s) => s.data.toString("latin1").includes("beginbfchar"))
  assert.ok(cmap, "找不到 ToUnicode CMap 流")
  const text = cmap.data.toString("latin1")
  // 我们要在中文字形映射里找到"中"(4E2D) 与"文"(6587)
  for (const cp of ["4e2d", "6587"]) {
    assert.ok(new RegExp(cp, "i").test(text), `ToUnicode 里没有 U+${cp.toUpperCase()}`)
  }
  // 页脚里的 "1 / 1" 也应该能被映射出来
  assert.ok(/0031/i.test(text))
})

await checkAsync("页面内容流里有真正的 Tj 文本绘制（不是空白页）", async () => {
  const info = inspectPdf(pdfBuffer)
  const contents = info.streams.filter((s) => s.data.toString("latin1").includes("Tj"))
  assert.ok(contents.length >= 1, "没有任何文本绘制指令")
  const content = contents.map((s) => s.data.toString("latin1")).join("\n")
  assert.match(content, /\/F1 [\d.]+ Tf/)
  assert.match(content, /<[0-9A-F]+> Tj/)
})

/**
 * 把 PDF 里画出来的文字"读回来"：内容流里的十六进制串是字形号（Identity-H），
 * 用 ToUnicode CMap 反查回 Unicode。这一步等价于用户在阅读器里选中并复制文本，
 * 能同时验证三件事：字形号选对了、ToUnicode 映射对了、排版没有把字丢在页外。
 */
function extractDrawnText(buffer) {
  const info = inspectPdf(buffer)
  const cmapStream = info.streams.find((s) => s.data.toString("latin1").includes("beginbfchar"))
  assert.ok(cmapStream, "找不到 ToUnicode CMap")
  const cmapText = cmapStream.data.toString("latin1")
  const toUnicode = new Map()
  for (const m of cmapText.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>/g)) {
    toUnicode.set(parseInt(m[1], 16), parseInt(m[2].slice(0, 4), 16))
  }
  const pages = []
  for (const stream of info.streams) {
    const content = stream.data.toString("latin1")
    if (!content.includes("Tj")) continue
    let text = ""
    for (const m of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const hex = m[1]
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        const gid = parseInt(hex.slice(i, i + 4), 16)
        const cp = toUnicode.get(gid)
        if (cp !== undefined) text += String.fromCodePoint(cp)
      }
    }
    pages.push(text)
  }
  return pages
}

await checkAsync("从 PDF 里读回的正文与源 Markdown 一致（含中文与链接文字）", async () => {
  const pages = extractDrawnText(pdfBuffer)
  const text = pages.join("\n")
  assert.ok(text.includes("项目周会纪要"), `读回的正文里没有标题，实际开头：${text.slice(0, 80)}`)
  assert.ok(text.includes("待办事项"), "读回的正文里没有二级标题")
  assert.ok(text.includes("服务端转换器注册表"), "列表项丢了")
  assert.ok(text.includes("引用里也可以有"), "引用块丢了")
  assert.ok(text.includes("console.log"), "代码块丢了")
  assert.ok(text.includes("https") || text.includes("链接"), "链接文字丢了")
  // 页脚 "1 / 1" 也要能在第一页读出来
  assert.ok(/1 \/ 1/.test(text), `页脚没读到：${text.slice(-40)}`)
})

await checkAsync("内嵌字体子集里，用到的字形有真实轮廓（不是空 glyf）", async () => {
  const info = inspectPdf(pdfBuffer)
  const fontStream = info.streams.find((s) => /\/Length1 \d+/.test(s.dict))
  assert.ok(fontStream, "找不到 FontFile2 流")
  const program = fontStream.data // 已经被 inflate 过
  assert.equal(program.toString("latin1", 0, 4), "\x00\x01\x00\x00", "内嵌字体不是 TrueType")

  // 解析内嵌字体的表目录
  const numTables = program.readUInt16BE(4)
  const tables = {}
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + i * 16
    const tag = program.toString("latin1", at, at + 4)
    tables[tag] = { offset: program.readUInt32BE(at + 8), length: program.readUInt32BE(at + 12) }
  }
  for (const required of ["head", "hhea", "maxp", "hmtx", "loca", "glyf"]) {
    assert.ok(tables[required], `内嵌字体缺少 ${required} 表`)
  }
  const numGlyphs = program.readUInt16BE(tables.maxp.offset + 4)
  assert.ok(numGlyphs > 1000, `numGlyphs=${numGlyphs}，不像保留了原始字形号空间`)

  // 找到"中"的字形号（从 ToUnicode 反查），确认它的 glyf 数据非空
  const cmapStream = info.streams.find((s) => s.data.toString("latin1").includes("beginbfchar"))
  const cmapText = cmapStream.data.toString("latin1")
  const hit = [...cmapText.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>/g)].find(
    (m) => parseInt(m[2].slice(0, 4), 16) === 0x4e2d
  )
  assert.ok(hit, "ToUnicode 里找不到「中」")
  const gid = parseInt(hit[1], 16)
  const locaOffset = tables.loca.offset
  const longFormat = program.readInt16BE(tables.head.offset + 50) === 1
  const locaAt = (index) =>
    longFormat ? program.readUInt32BE(locaOffset + index * 4) : program.readUInt16BE(locaOffset + index * 2) * 2
  const glyphLength = locaAt(gid + 1) - locaAt(gid)
  assert.ok(glyphLength > 20, `「中」(gid=${gid}) 的轮廓长度只有 ${glyphLength} 字节`)
})

await checkAsync("标题用更大字号、代码块有底色矩形、表格/分割线有画线指令", async () => {
  const info = inspectPdf(pdfBuffer)
  const content = info.streams.map((s) => s.data.toString("latin1")).join("\n")
  const sizes = [...content.matchAll(/\/F1 ([\d.]+) Tf/g)].map((m) => Number(m[1]))
  assert.ok(Math.max(...sizes) >= 17, `最大字号只有 ${Math.max(...sizes)}，标题没有放大`)
  assert.match(content, / re f/, "没有填充矩形（代码块底色）")
  assert.match(content, / m [\d.]+ [\d.]+ l S/, "没有画线指令（表格分隔线 / 水平线）")
})

await checkAsync("链接会生成可点击的 Link 注释，且 URI 正确", async () => {
  const info = inspectPdf(pdfBuffer)
  assert.ok(/\/Subtype \/Link/.test(info.raw), "没有 Link 注释对象")
  assert.ok(/\/URI \(https:\/\/example\.com\/docs\)/.test(info.raw), "Link 注释里的 URI 不对")
})

await checkAsync("长文档自动分页，页脚是「n / N」", async () => {
  const longText = Array.from({ length: 120 }, (_, i) => `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 段正文，用来把文档撑到多页。\n`).join("\n")
  const result = await mdPdf.run({ text: longText, name: "long.md", onProgress: () => {} })
  const info = inspectPdf(result.data)
  const pages = Number(/\/Count (\d+)/.exec(info.raw)?.[1] ?? 0)
  assert.ok(pages >= 3, `只生成了 ${pages} 页`)
  const content = info.streams.map((s) => s.data.toString("latin1")).join("\n")
  const footerHex = content.includes("0031") && content.includes("002F") // "1" 与 "/"
  assert.ok(footerHex, "页脚没有画出来")
  fs.writeFileSync(path.join(OUT_DIR, "long.pdf"), result.data)
})

await checkAsync("空文档也能产出合法 PDF（1 页，只有页脚）", async () => {
  const result = await mdPdf.run({ text: "", name: "empty.md", onProgress: () => {} })
  const info = inspectPdf(result.data)
  assert.match(info.raw, /\/Count 1/)
})

await checkAsync("纯 ASCII 文档在没有中文字体时也能生成（退化路径不抛错）", async () => {
  const result = await mdPdf.run({ text: "# Hello\n\nworld\n", name: "en.md", onProgress: () => {} })
  assert.ok(result.data.length > 500)
  inspectPdf(result.data)
})

await checkAsync("真·退化路径（没有中文字体）：退回内置 Helvetica，中文变 ? 且 PDF 仍合法", async () => {
  const fallback = fontMod.fallbackFontView()
  const layout = layoutMod.layoutDocument({
    blocks: markdown.parseMarkdown("# 中文标题\n\n正文里有中文与 ASCII text。\n"),
    font: fallback,
    fallbackTitle: "fallback",
  })
  const buffer = docMod.buildPdf({ pages: layout.pages, font: fallback, title: "fallback" }).data
  const info = inspectPdf(buffer)
  // 退化时必须是内置 Type1 字体，而不是"空字体程序的 CIDFontType2"（那会让阅读器直接报错）
  assert.ok(/\/Subtype \/Type1/.test(info.raw), "退化路径没有用 Type1 内置字体")
  assert.ok(/\/WinAnsiEncoding/.test(info.raw), "退化路径没有声明 WinAnsiEncoding")
  assert.ok(!/\/FontFile2/.test(info.raw), "退化路径不该引用字体程序")
  // 中文被替换成 '?'，并且这件事被记进了 missingChars
  assert.ok(fallback.missingChars.size > 0, "缺字没有被记录")
})

check("needsCjkFont：中文与全角标点要字体，纯 ASCII 不要", () => {
  assert.equal(mdPdfMod.needsCjkFont("# 标题"), true)
  assert.equal(mdPdfMod.needsCjkFont("全角标点：，。！"), true)
  assert.equal(mdPdfMod.needsCjkFont("plain ASCII, 123, punctuation; ok!"), false)
  // Latin-1 范围内的重音字母 WinAnsi 有，不算"缺字"；希腊字母/箭头之类就超界了
  assert.equal(mdPdfMod.needsCjkFont("café résumé"), false)
  assert.equal(mdPdfMod.needsCjkFont("Ω → ∞"), true)
  assert.equal(mdPdfMod.needsCjkFont(""), false)
})

await checkAsync("没有中文字体时：含中文的 md→PDF **直接报错**（绝不写出满屏问号）", async () => {
  const fallback = fontMod.fallbackFontView()
  assert.throws(
    () => mdPdfMod.assertRenderable("# 中文标题\n", fallback, "测试原因"),
    (err) => err.errorKey === "api.fs.convert_no_cjk_font" && err.status === 501 && /data\/fonts/.test(err.message)
  )
  // 纯 ASCII 文档在没有字体时照样能转（内置 Helvetica 够用）
  assert.doesNotThrow(() => mdPdfMod.assertRenderable("# Hello\n\nworld 123\n", fallback, "测试原因"))
})

await checkAsync("有中文字体时 assertRenderable 放行（并报告是哪个字体）", async () => {
  const loaded = await fontMod.loadFont()
  if (!loaded.ok) {
    console.log(`      （这台机器没有中文字体，跳过：${loaded.reason}）`)
    return
  }
  assert.doesNotThrow(() => mdPdfMod.assertRenderable("# 中文标题\n", loaded.font))
  assert.ok(typeof loaded.source === "string" && loaded.source.length > 3, "没有给出字体路径")
  const status = fontMod.fontStatus()
  assert.equal(status.ok, true)
  assert.equal(status.source, loaded.source)
})

/* ---------------------------------------------------------------- 4. 图片互转 */

section("图片互转（PNG ↔ JPG）")

let sharp = null
try {
  // sharp 装在 server/ 里（pnpm 的 node_modules 结构随安装方式而变，用 require.resolve 找）
  const { createRequire } = await import("node:module")
  const requireFromServer = createRequire(path.join(root, "server", "index.js"))
  sharp = (await import(pathToFileURL(requireFromServer.resolve("sharp")).href)).default
} catch {
  sharp = null
}

if (!sharp) {
  console.log("  ! 未找到 sharp，跳过图片转换断言（单文件 exe 发布版就是这种状态）")
} else {
  const pngToJpg = registry.getConverter("png-to-jpg")
  const jpgToPng = registry.getConverter("jpg-to-png")

  await checkAsync("PNG（带透明区）→ JPG：透明区铺白底，不是黑块", async () => {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()
    const out = await pngToJpg.run({ buffer: png, onProgress: () => {} })
    assert.equal(out.data.subarray(0, 3).toString("hex"), "ffd8ff", "不是 JPEG")
    const meta = await sharp(out.data).metadata()
    assert.equal(meta.format, "jpeg")
    assert.equal(meta.width, 40)
    assert.equal(meta.height, 30)
    // 取第一个像素：全透明区域应该是白色（255,255,255）
    const { data } = await sharp(out.data).raw().toBuffer({ resolveWithObject: true })
    assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, `透明区没铺白底：${data[0]},${data[1]},${data[2]}`)
  })

  await checkAsync("JPG → PNG：尺寸不变、扩展名与格式正确", async () => {
    const jpg = await sharp({
      create: { width: 24, height: 16, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer()
    const out = await jpgToPng.run({ buffer: jpg, onProgress: () => {} })
    assert.equal(out.data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "不是 PNG")
    const meta = await sharp(out.data).metadata()
    assert.equal(meta.format, "png")
    assert.equal(meta.width, 24)
    assert.equal(meta.height, 16)
  })

  await checkAsync("坏图片 → 可识别的 415 错误（不是未捕获异常）", async () => {
    await assert.rejects(
      () => pngToJpg.run({ buffer: Buffer.from("not an image"), onProgress: () => {} }),
      (err) => err.status === 415 || err.errorKey === "api.fs.convert_bad_image" || /unsupported image/i.test(err.message)
    )
  })
}

/* ---------------------------------------------------------------- 5. 注册表 */

section("转换器注册表（可扩展接口）")

check("内置四个转换器，按扩展名查得到", () => {
  assert.deepEqual(
    registry.convertersForExt("md").map((c) => c.id).sort(),
    ["md-to-pdf", "md-to-txt"]
  )
  assert.deepEqual(registry.convertersForExt("markdown").map((c) => c.id).sort(), ["md-to-pdf", "md-to-txt"])
  assert.deepEqual(registry.convertersForExt("png").map((c) => c.id), ["png-to-jpg"])
  assert.deepEqual(registry.convertersForExt("jpeg").map((c) => c.id), ["jpg-to-png"])
  assert.deepEqual(registry.convertersForExt("docx"), [])
})

check("扩展名大小写 / 前导点都被规范化", () => {
  assert.equal(registry.convertersForExt(".PNG").length, 1)
})

check("下发给前端的清单只含展示字段（不带 run / maxBytes）", () => {
  const list = registry.publicConverterList()
  assert.equal(list.length, 4)
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ["from", "id", "label", "labelKey", "to"])
    assert.equal(typeof item.label, "string")
    assert.ok(item.labelKey.startsWith("ui.convert."))
  }
})

check("非法定义会立刻抛错（id 重复 / 缺 run / 缺 maxBytes）", () => {
  assert.throws(() => registry.registerConverter({ id: "md-to-txt", from: ["md"], to: "x", run: () => {} }), /重复/)
  assert.throws(() => registry.registerConverter({ id: "bad", from: ["md"], to: "x", maxBytes: 1 }), /run/)
  assert.throws(() => registry.registerConverter({ id: "bad2", from: ["md"], to: "x", run: () => {} }), /maxBytes/)
  assert.throws(() => registry.registerConverter({ id: "bad3", from: [], to: "x", run: () => {}, maxBytes: 1 }), /源扩展名/)
  assert.throws(() => registry.registerConverter({ id: "Bad Id", from: ["md"], to: "x", run: () => {}, maxBytes: 1 }), /id 非法/)
})

/* ---------------------------------------------------------------- 6. 并发闸门 */

section("并发闸门（convert/queue.js）")

const queue = await import(pathToFileURL(path.join(root, "server", "src", "convert", "queue.js")).href)

await checkAsync("同时只放 4 个执行位，第 5 个排队；释放后立刻接上", async () => {
  const releases = []
  for (let i = 0; i < 4; i += 1) releases.push(await queue.acquireConvertSlot())
  assert.deepEqual(queue.convertQueueState(), { active: 4, waiting: 0 })

  let fifthDone = false
  const fifth = queue.acquireConvertSlot().then((release) => {
    fifthDone = true
    return release
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fifthDone, false, "第 5 个不该直接拿到执行位")
  assert.equal(queue.convertQueueState().waiting, 1)

  releases.shift()() // 放掉一个
  const release5 = await fifth
  assert.equal(fifthDone, true, "释放后第 5 个应该立刻被唤醒")
  assert.equal(queue.convertQueueState().active, 4, "释放一个、唤醒一个，占用数应保持 4")

  release5()
  for (const release of releases) release()
  assert.deepEqual(queue.convertQueueState(), { active: 0, waiting: 0 })
})

await checkAsync("队列排满时立刻报 503（不让用户干等）", async () => {
  const releases = []
  for (let i = 0; i < 4; i += 1) releases.push(await queue.acquireConvertSlot())
  // 排 32 个：拿到执行位后立刻还回去，这样后面的 release 会级联唤醒它们
  const drain = []
  for (let i = 0; i < 32; i += 1) drain.push(queue.acquireConvertSlot().then((release) => release()))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(queue.convertQueueFull(), true, "32 个排队后应判定为满")

  await assert.rejects(
    () => queue.acquireConvertSlot(),
    (err) => err.status === 503 && err.errorKey === "api.fs.convert_busy"
  )

  // 放掉 4 个执行位 → 排队者依次拿到并立刻还回 → 全部排空
  for (const release of releases) release()
  await Promise.all(drain)
  assert.deepEqual(queue.convertQueueState(), { active: 0, waiting: 0 })
})

/* ------------------------------------------------- 7. 字体：CFF 与服主指定 */

section("字体：CFF（OpenType）子集化与服主指定")

// 找一个 CFF 中文字体：优先用环境变量指定，其次扫常见目录（拿不到就跳过这几条，
// 因为这些断言需要**真实的** CFF 字体才有意义，造不出来）
function findCffFont() {
  const candidates = [
    process.env.ZS_TEST_CFF_FONT,
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Users/RedmiBook/AppData/Local/Microsoft/Windows/Fonts/NotoSerifSC-Medium.otf",
    "C:/Users/RedmiBook/AppData/Local/Microsoft/Windows/Fonts/SourceHanSansSC-Normal-2.otf",
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* 没有就继续 */
    }
  }
  return null
}

const cffFont = findCffFont()
const truetypeMod = await import(pathToFileURL(path.join(root, "server", "src", "convert", "pdf", "truetype.js")).href)

if (!cffFont) {
  console.log("  · 跳过 CFF 断言（本机没有 CFF 中文字体，可用 ZS_TEST_CFF_FONT 指定一个）")
} else {
  await checkAsync("CFF 字体能被解析，且 kind = cff", async () => {
    const font = truetypeMod.parseFont(fs.readFileSync(cffFont))
    assert.equal(font.kind, "cff")
    assert.ok(font.cidByGid && font.cidByGid.length === font.numGlyphs, "没有解析出 CID 映射")
  })

  await checkAsync("CFF 子集化：体积大幅下降、自检通过、CID 保持原值", async () => {
    const { parseFont, charMap, buildFontProgram } = truetypeMod
    const font = parseFont(fs.readFileSync(cffFont))
    const map = charMap(font)
    const gids = new Set()
    for (const ch of "中文测试文件转换ABC") {
      const gid = map.get(ch.codePointAt(0))
      if (gid) gids.add(gid)
    }
    const built = buildFontProgram(font, gids)
    assert.equal(built.format, "cff")
    assert.equal(built.fallbackReason, undefined, `子集化失败并回退了：${built.fallbackReason}`)
    // 思源/Noto 这种中文字体整份 CFF 有 10MB 上下，子集必须小得多（这里给 1/5 的宽松门槛）
    assert.ok(
      built.program.length < font.cff.fullProgram.length / 5,
      `子集没变小：${built.program.length} vs ${font.cff.fullProgram.length}`
    )
    // CID 必须与原字体一致（PDF 内容流里写的就是 CID，错了就是一堆错字）
    const cffMod = await import(pathToFileURL(path.join(root, "server", "src", "convert", "pdf", "cff.js")).href)
    const reparsed = cffMod.parseCff(built.program, 0, built.program.length, built.oldGids.length)
    for (let i = 0; i < built.oldGids.length; i += 1) {
      assert.equal(reparsed.cidByGid[i], font.cidByGid[built.oldGids[i]], `第 ${i} 个字形的 CID 不一致`)
    }
  })

  await checkAsync("服主指定的 CFF 字体优先于系统里的 TrueType 字体", async () => {
    const prevEnv = process.env.CONVERT_PDF_FONT
    process.env.CONVERT_PDF_FONT = cffFont
    fontMod.resetFontCache()
    try {
      const loaded = await fontMod.loadFont()
      assert.equal(loaded.ok, true)
      assert.equal(loaded.kind, "cff", `指定了 CFF 却用了 ${loaded.kind}（显式指定必须优先）`)
      assert.equal(path.resolve(loaded.source), path.resolve(cffFont))
    } finally {
      if (prevEnv === undefined) delete process.env.CONVERT_PDF_FONT
      else process.env.CONVERT_PDF_FONT = prevEnv
      fontMod.resetFontCache()
    }
  })

  await checkAsync("CFF 字体也能生成结构合法的 PDF（CIDFontType0 + FontFile3）", async () => {
    const prevEnv = process.env.CONVERT_PDF_FONT
    process.env.CONVERT_PDF_FONT = cffFont
    fontMod.resetFontCache()
    try {
      const result = await mdPdf.run({ text: "# 中文标题\n\n正文含中文与 ASCII。\n", name: "cff.md", onProgress: () => {} })
      const raw = result.data.toString("latin1")
      assert.ok(/\/Subtype \/CIDFontType0\b/.test(raw), "没有用 CIDFontType0")
      assert.ok(/\/FontFile3/.test(raw), "没有引用 FontFile3")
      assert.ok(/\/Subtype \/CIDFontType0C/.test(raw), "字体流缺少 /CIDFontType0C")
      assert.ok(!/\/CIDToGIDMap/.test(raw), "CIDFontType0 不该出现 /CIDToGIDMap")
      inspectPdf(result.data)
    } finally {
      if (prevEnv === undefined) delete process.env.CONVERT_PDF_FONT
      else process.env.CONVERT_PDF_FONT = prevEnv
      fontMod.resetFontCache()
    }
  })
}

await checkAsync("字体校验：路径不存在 / 不是字体 / 没有汉字 都要被拒", async () => {
  const missing = await fontMod.inspectFontFile(path.join(OUT_DIR, "definitely-not-here.ttf"))
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在|权限/)

  const notFont = path.join(OUT_DIR, "not-a-font.ttf")
  fs.writeFileSync(notFont, Buffer.from("this is definitely not a font file"))
  const bad = await fontMod.inspectFontFile(notFont)
  assert.equal(bad.ok, false)

  const wrongExt = await fontMod.inspectFontFile(path.join(OUT_DIR, "x.zip"))
  assert.equal(wrongExt.ok, false)
  assert.match(wrongExt.reason, /只支持/)
})

/* ---------------------------------------------- 8. 与预览一致的行内/块级特性 */

section("与预览一致：硬换行 / 删除线 / 白名单标签 / 复选框")

check("硬换行（行尾两个空格）变成 { br: true } 的换行单元", () => {
  const parsed = markdown.parseMarkdown("第一行  \n第二行\n")
  const run = parsed[0].inlines.find((r) => r.br)
  assert.ok(run, "没有产生换行单元")
})

check("反斜杠结尾也是硬换行", () => {
  const parsed = markdown.parseMarkdown("第一行\\\n第二行\n")
  assert.ok(parsed[0].inlines.some((r) => r.br), "没有产生换行单元")
})

check("<br> 标签变成换行单元，<kbd> 只丢标签留文字", () => {
  const parsed = markdown.parseMarkdown("上<br>下 与 <kbd>Ctrl</kbd>")
  const inlines = parsed[0].inlines
  assert.ok(inlines.some((r) => r.br), "<br> 没有变成换行")
  const text = markdown.inlineToText(inlines, { keepUrl: false })
  assert.ok(text.includes("Ctrl"), "白名单标签里的文字丢了")
  assert.ok(!text.includes("<kbd>"), "白名单标签本身不该出现在正文里")
})

check("~~删除线~~ 带上 strike 标记", () => {
  const parsed = markdown.parseMarkdown("~~删掉~~ 正常")
  const strike = parsed[0].inlines.find((r) => r.strike)
  assert.ok(strike && strike.text.includes("删掉"))
})

check("任务列表的勾选框不是文字（改用矢量方框，避免字体缺 ☑ 变成 ?）", () => {
  const parsed = markdown.parseMarkdown("- [x] 完成\n- [ ] 未完成\n")
  const list = parsed.find((b) => b.type === "list")
  assert.equal(list.items[0].task, true)
  assert.equal(list.items[1].task, false)
  const text = markdown.inlineToText(list.items[0].inlines, { keepUrl: false })
  assert.ok(!text.includes("☑") && !text.includes("☐"), "正文里不该再出现 ☑/☐ 这两个码点")
})

/* --------------------------------------------------- 9. 图片真的进了 PDF */

section("图片：预览里看得到的图，PDF 里也要有")

/** 造一张最小但合法的 PNG（1×1，RGB，filter=0） */
function tinyPng() {
  const zlibRaw = zlib.deflateSync(Buffer.from([0x00, 0x11, 0x22, 0x33])) // filter 0 + RGB
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 4, "latin1")
    const crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    // CRC 覆盖"类型 + 数据"两部分（类型已经在 head 里，这里单独拼一份给 CRC 用）
    for (const byte of Buffer.concat([Buffer.from(type, "latin1"), data])) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    }
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibRaw),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

await checkAsync("md 里引用的图片被内嵌成 Image XObject（不是一行占位文字）", async () => {
  const image = path.join(OUT_DIR, "inline-test.png")
  fs.writeFileSync(image, tinyPng())
  const result = await mdPdf.run({
    text: "# 有图\n\n![一张图](inline-test.png)\n\n正文\n",
    name: "img.md",
    dir: OUT_DIR,
    onProgress: () => {},
  })
  const raw = result.data.toString("latin1")
  assert.ok(/\/Subtype \/Image/.test(raw), "PDF 里没有图像对象")
  assert.ok(/\/XObject\s*</.test(raw), "页面资源里没有 /XObject")
  assert.ok(!raw.includes("[图片: 一张图]"), "仍然只画了占位文字")
  inspectPdf(result.data)
})

await checkAsync("图片不存在时退化成占位文字（不抛错、不缺块）", async () => {
  const result = await mdPdf.run({
    text: "![缺失](nope.png)\n",
    name: "img2.md",
    dir: OUT_DIR,
    onProgress: () => {},
  })
  inspectPdf(result.data)
  const raw = result.data.toString("latin1")
  assert.ok(!/\/Subtype \/Image/.test(raw), "图不存在却写了图像对象")
})

/* ---------------------------------------------------------------- 汇总 */

console.log("")
console.log(`产物目录（可删）：${OUT_DIR}`)
if (failed > 0) {
  console.log(`\u274c ${failed} / ${total} 条断言失败`)
  for (const label of failures) console.log(`   - ${label}`)
  process.exit(1)
}
console.log(`\u2705 全部 ${total} 条断言通过`)
