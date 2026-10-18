#!/usr/bin/env node
/**
 * scripts/office-preview-test.mjs —— Office 预览解析器的自测
 *
 * 做法：用 `server/node_modules/archiver` 现场生成最小可用的 docx / xlsx / pptx，
 * 再用 Node 的 `DecompressionStream("deflate-raw")`（解析器自己就有）解开，
 * 断言解出的结构符合预期。
 *
 * 之所以能在 Node 里跑：`web/src/lib/office/` 里没有 `DOMParser`，
 * XML 解析器（`xml.ts`）与 ZIP 读取器（`zip.ts`）都是自带的纯函数，
 * 浏览器和 Node 共用同一份代码。
 *
 * 运行：`node scripts/office-preview-test.mjs`（Node 22.18+ 直接 import .ts，
 * 依赖的语法都限制在「可擦除类型」范围内，无需编译）。
 */

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const require = createRequire(import.meta.url)
const archiver = require(path.join(root, "server", "node_modules", "archiver"))

const office = await import(pathToFileURL(path.join(root, "web", "src", "lib", "office", "index.ts")).href)

/* ---------------------------------------------------------------- 断言框架 */

let total = 0
let failed = 0
const failures = []

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

/** 需要 await 的断言（rejects 之类） */
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

function section(title) {
  console.log(`\n${title}`)
}

/* -------------------------------------------------------------- ZIP 构造器 */

/** 用 archiver 把 { 路径: 文本 } 打成 deflate 压缩的 ZIP */
function makeZip(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } })
    const chunks = []
    archive.on("data", (chunk) => chunks.push(chunk))
    archive.on("warning", (err) => console.warn("archiver warning:", err.message))
    archive.on("error", reject)
    archive.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
    for (const [name, content] of Object.entries(files)) {
      archive.append(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), { name })
    }
    archive.finalize()
  })
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const CONTENT_TYPES = `${XML_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`

/* -------------------------------------------------------------------- DOCX */

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

function buildDocx() {
  return makeZip({
    "[Content_Types].xml": CONTENT_TYPES,
    "word/document.xml": `${XML_HEAD}
<w:document ${W_NS}>
  <w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>第一段加粗</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>第二段居中</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>要点一</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并表头</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>A 格</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B 格</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/_rels/document.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`,
    "word/numbering.xml": `${XML_HEAD}
<w:numbering ${W_NS}>
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`,
    "word/media/image1.png": PNG_1X1,
  })
}

/* -------------------------------------------------------------------- XLSX */

const S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

function buildXlsx() {
  return makeZip({
    "[Content_Types].xml": CONTENT_TYPES,
    "xl/workbook.xml": `${XML_HEAD}
<workbook ${S_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="数据" sheetId="1" r:id="rId1"/>
    <sheet name="报表" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
    "xl/styles.xml": `${XML_HEAD}
<styleSheet ${S_NS}>
  <numFmts count="0"/>
  <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>
</styleSheet>`,
    "xl/sharedStrings.xml": `${XML_HEAD}
<sst ${S_NS} count="2" uniqueCount="2">
  <si><t>名称</t></si>
  <si><r><t>富</t></r><r><t>文本</t></r></si>
</sst>`,
    // 45292 = 2024-01-01（Excel 序列号）
    "xl/worksheets/sheet1.xml": `${XML_HEAD}
<worksheet ${S_NS}>
  <cols><col min="1" max="1" width="20" customWidth="1"/></cols>
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><t>内联文本</t></is></c>
      <c r="C1" s="1"><f>SUM(A2:A2)</f><v>45292</v></c>
    </row>
    <row r="2">
      <c r="A2" s="1"><v>45292</v></c>
      <c r="B2" t="s"><v>1</v></c>
      <c r="C2" t="b"><v>1</v></c>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>`,
    "xl/worksheets/sheet2.xml": `${XML_HEAD}
<worksheet ${S_NS}>
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>报表内容</t></is></c></row></sheetData>
</worksheet>`,
  })
}

/* -------------------------------------------------------------------- PPTX */

const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function buildPptx() {
  return makeZip({
    "[Content_Types].xml": CONTENT_TYPES,
    "ppt/presentation.xml": `${XML_HEAD}
<p:presentation ${P_NS}>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`,
    "ppt/slides/slide1.xml": `${XML_HEAD}
<p:sld ${P_NS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="1143000"/></a:xfrm>
        <a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill>
      </p:spPr>
      <p:txBody>
        <a:bodyPr anchor="ctr"/>
        <a:p>
          <a:pPr algn="ctr"/>
          <a:r><a:rPr sz="4400" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>标题一</a:t></a:r>
          <a:r><a:rPr sz="2000"/><a:t>副文本</a:t></a:r>
        </a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
    "ppt/slides/slide2.xml": `${XML_HEAD}
<p:sld ${P_NS}>
  <p:cSld><p:spTree>
    <p:pic>
      <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr>
      <p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
    </p:pic>
    <p:sp>
      <p:spPr><a:xfrm><a:off x="0" y="2200000"/><a:ext cx="6096000" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800" i="1" u="sng"/><a:t>第二页说明</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>版式标题占位符</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
    "ppt/slides/_rels/slide2.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`,
    "ppt/media/image1.png": PNG_1X1,
  })
}

/* ------------------------------------------------------------------ 跑起来 */

console.log("Office 预览解析自测")
console.log(`  parser: web/src/lib/office/index.ts`)
console.log(`  node:   ${process.version}`)

const docxBytes = await buildDocx()
const xlsxBytes = await buildXlsx()
const pptxBytes = await buildPptx()

/* ---- 扩展名判定 ---- */
section("扩展名 → 解析种类")
check("docx → docx", () => assert.equal(office.officeKindOf("季度报告.docx"), "docx"))
check("docm 视作 docx", () => assert.equal(office.officeKindOf("macro.docm"), "docx"))
check("xlsm 视作 xlsx", () => assert.equal(office.officeKindOf("台账.XLSM"), "xlsx"))
check("pptm 视作 pptx", () => assert.equal(office.officeKindOf("deck.pptm"), "pptx"))
check("老二进制格式 .doc 不认", () => assert.equal(office.officeKindOf("old.doc"), null))
check("无扩展名不认", () => assert.equal(office.officeKindOf("README"), null))

/* ---- DOCX ---- */
section("DOCX：两段 + 粗体 + 表格 + 列表 + 图片")
const docx = await office.parseOffice(docxBytes, "docx")

check("kind 为 docx", () => assert.equal(docx.kind, "docx"))

check("块数量 = 6（段落、表格、图片段落、分页符）", () => assert.equal(docx.blocks.length, 6))

check("第 1 段文本 = 第一段加粗", () => {
  const block = docx.blocks[0]
  assert.equal(block.kind, "paragraph")
  assert.equal(block.runs.length, 1)
  assert.equal(block.runs[0].kind, "text")
  assert.equal(block.runs[0].text, "第一段加粗")
})

check("第 1 段是粗体且字号 16pt（w:sz=32 半磅）", () => {
  const run = docx.blocks[0].runs[0]
  assert.equal(run.bold, true)
  assert.equal(run.sizePt, 16)
})

check("第 2 段居中，文本 = 第二段居中", () => {
  const block = docx.blocks[1]
  assert.equal(block.kind, "paragraph")
  assert.equal(block.align, "center")
  assert.equal(block.runs[0].text, "第二段居中")
})

check("第 3 块是列表（numbering.xml 的 bullet）", () => {
  const block = docx.blocks[2]
  assert.equal(block.kind, "list")
  assert.equal(block.items.length, 1)
  assert.equal(block.items[0].ordered, false)
  assert.equal(block.items[0].listStyle, "disc")
  assert.equal(block.items[0].runs[0].text, "要点一")
})

check("表格 2 行，首行 gridSpan=2，次行两格", () => {
  const table = docx.blocks[3]
  assert.equal(table.kind, "table")
  assert.equal(table.rows.length, 2)
  assert.equal(table.rows[0].length, 1)
  assert.equal(table.rows[0][0].span, 2)
  assert.equal(table.rows[1].length, 2)
  const firstCellText = table.rows[1][0].blocks[0].runs[0].text
  assert.equal(firstCellText, "A 格")
})

check("图片段落解出 image run，路径指向 word/media/image1.png", () => {
  const block = docx.blocks[4]
  assert.equal(block.kind, "paragraph")
  const image = block.runs.find((run) => run.kind === "image")
  assert.ok(image, "没有解出 image run")
  assert.equal(image.src, "word/media/image1.png")
  // 914400 EMU = 1 英寸 = 96px
  assert.equal(image.width, 96)
  assert.equal(image.height, 48)
})

check("分页符 → break 块", () => assert.equal(docx.blocks[5].kind, "break"))

check("media 里有 1 张 PNG，mime 正确", () => {
  assert.equal(docx.media.size, 1)
  const file = docx.media.get("word/media/image1.png")
  assert.ok(file)
  assert.equal(file.mime, "image/png")
  assert.equal(file.data.length, PNG_1X1.length)
})

/* ---- XLSX ---- */
section("XLSX：两个工作表 + 合并格 + 日期 + 公式")
const xlsx = await office.parseOffice(xlsxBytes, "xlsx")

check("kind 为 xlsx", () => assert.equal(xlsx.kind, "xlsx"))

check("工作表顺序与名字按 workbook.xml", () => {
  assert.deepEqual(
    xlsx.sheets.map((sheet) => sheet.name),
    ["数据", "报表"]
  )
})

check("共享字符串：单个 <t> 与多个 <r><t> 都拼得出来", () => {
  const row = xlsx.sheets[0].rows[0]
  assert.equal(row.cells[0].text, "名称")
  assert.equal(xlsx.sheets[0].rows[1].cells[1].text, "富文本")
})

check("内联字符串（inlineStr）解出文本", () => {
  // B1 被 A1:B1 合并覆盖，所以表格里只剩 A1；用第 2 个工作表验证 inlineStr
  assert.equal(xlsx.sheets[1].rows[0].cells[0].text, "报表内容")
})

check("合并格：A1 的 colSpan = 2，B1 被覆盖（null）", () => {
  const row = xlsx.sheets[0].rows[0]
  assert.equal(row.cells[0].colSpan, 2)
  assert.equal(row.cells[1], null)
})

check("日期格式：numFmtId=14，序列号 45292 → 2024-01-01", () => {
  assert.equal(xlsx.sheets[0].rows[1].cells[0].text, "2024-01-01")
})

check("公式显示缓存值（同样按日期格式化），并保留公式原文", () => {
  const cell = xlsx.sheets[0].rows[0].cells[2]
  assert.equal(cell.text, "2024-01-01")
  assert.equal(cell.formula, "SUM(A2:A2)")
})

check("布尔值 → TRUE", () => assert.equal(xlsx.sheets[0].rows[1].cells[2].text, "TRUE"))

check("列宽：width=20 → 145px", () => assert.equal(xlsx.sheets[0].cols[0], 145))

check("未截断", () => assert.equal(xlsx.sheets[0].truncated, false))

/* ---- PPTX ---- */
section("PPTX：两张幻灯片 + 文本框 + 图片")
const pptx = await office.parseOffice(pptxBytes, "pptx")

check("kind 为 pptx", () => assert.equal(pptx.kind, "pptx"))

check("画布 16:9（12192000 × 6858000 EMU）", () => {
  assert.equal(pptx.width, 12192000)
  assert.equal(pptx.height, 6858000)
})

check("幻灯片数量 = 2（顺序按 sldIdLst）", () => assert.equal(pptx.slides.length, 2))

check("第 1 页形状定位：off(0,0) ext(6096000,1143000) → 0%/0%/50%/16.67%", () => {
  const shape = pptx.slides[0].shapes[0]
  assert.equal(shape.x, 0)
  assert.equal(shape.y, 0)
  assert.equal(shape.w, 50)
  assert.ok(Math.abs(shape.h - 16.666666) < 0.01, `h = ${shape.h}`)
})

check("形状填充色与文本垂直居中", () => {
  const shape = pptx.slides[0].shapes[0]
  assert.equal(shape.fill, "#1f4e79")
  assert.equal(shape.anchor, "center")
})

check("文本段落：两段 run，字号 44pt / 20pt，粗体与颜色", () => {
  const paragraph = pptx.slides[0].shapes[0].paragraphs[0]
  assert.equal(paragraph.align, "center")
  assert.equal(paragraph.runs.length, 2)
  assert.equal(paragraph.runs[0].text, "标题一")
  assert.equal(paragraph.runs[0].sizePt, 44)
  assert.equal(paragraph.runs[0].bold, true)
  assert.equal(paragraph.runs[0].color, "#ffffff")
  assert.equal(paragraph.runs[1].text, "副文本")
  assert.equal(paragraph.runs[1].sizePt, 20)
})

check("第 2 页图片：r:embed → ppt/media/image1.png，坐标 7.5%", () => {
  const picture = pptx.slides[1].shapes[0]
  assert.equal(picture.image, "ppt/media/image1.png")
  assert.equal(picture.x, 7.5)
  assert.equal(picture.h, 13.333333333333334)
})

check("第 2 页文本框：斜体 + 下划线", () => {
  const text = pptx.slides[1].shapes[1]
  const run = text.paragraphs[0].runs[0]
  assert.equal(run.text, "第二页说明")
  assert.equal(run.italic, true)
  assert.equal(run.underline, true)
})

check("没有 a:xfrm 的标题占位符走兜底框（不丢文本）", () => {
  const placeholder = pptx.slides[1].shapes[2]
  assert.equal(placeholder.paragraphs[0].runs[0].text, "版式标题占位符")
  assert.deepEqual(
    { x: placeholder.x, y: placeholder.y, w: placeholder.w, h: placeholder.h },
    { x: 8, y: 6, w: 84, h: 16 }
  )
})

check("media 里有 1 张图片", () => {
  assert.equal(pptx.media.size, 1)
  assert.equal(pptx.media.get("ppt/media/image1.png").mime, "image/png")
})

/* ---- 样式继承 / 表格列宽 / 纵向合并 / 1904 / 母版占位符 ---- */
section("样式、表格与母版继承")

function buildDocxStyled() {
  return makeZip({
    "[Content_Types].xml": CONTENT_TYPES,
    "word/document.xml": `${XML_HEAD}
<w:document ${W_NS}>
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>样式标题</w:t></w:r></w:p>
    <w:p><w:pPr><w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="4000"/></w:tblGrid>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="FFCC00"/></w:tcPr><w:p><w:r><w:t>表头</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>示例链接</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>`,
    "word/_rels/document.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>
</Relationships>`,
    "word/styles.xml": `${XML_HEAD}
<w:styles ${W_NS}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:sz w:val="32"/><w:color w:val="1F4E79"/></w:rPr>
  </w:style>
</w:styles>`,
  })
}

const styled = await office.parseOffice(await buildDocxStyled(), "docx")

check("DOCX 样式继承：Heading1 → heading=1、16pt、深蓝", () => {
  const first = styled.blocks[0]
  assert.equal(first.kind, "paragraph")
  assert.equal(first.heading, 1)
  assert.equal(first.runs[0].sizePt, 16)
  assert.equal(first.runs[0].color, "#1f4e79")
  assert.equal(first.runs[0].bold, true)
})

check("DOCX 段落间距：before 6pt / after 12pt / 1.5 倍行距", () => {
  const second = styled.blocks[1]
  assert.deepEqual(second.spacing, { beforePt: 6, afterPt: 12, line: 1.5 })
})

check("DOCX 表格列宽来自 tblGrid（2:1）", () => {
  const table = styled.blocks[2]
  assert.equal(table.kind, "table")
  assert.deepEqual(table.widths, [33.33, 66.67])
})

check("DOCX 单元格底纹与纵向合并（rowSpan + 续格 null）", () => {
  const table = styled.blocks[2]
  assert.equal(table.rows[0][0].shade, "#ffcc00")
  assert.equal(table.rows[1][0].rowSpan, 2)
  assert.equal(table.rows[2][0], null)
})

check("DOCX 超链接保留外部 URL", () => {
  const para = styled.blocks[3]
  assert.equal(para.runs[0].href, "https://example.com/")
})

function buildXlsxStyled() {
  return makeZip({
    "[Content_Types].xml": CONTENT_TYPES,
    "xl/workbook.xml": `${XML_HEAD}
<workbook ${S_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="1"/>
  <sheets>
    <sheet name="数据" sheetId="1" r:id="rId1"/>
    <sheet name="隐藏" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
    "xl/styles.xml": `${XML_HEAD}
<styleSheet ${S_NS}>
  <fonts count="2"><font/><font><b/><i/><color rgb="FFFF0000"/></font></fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill>
  </fills>
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2"><alignment horizontal="center" wrapText="1"/></xf>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>`,
    "xl/worksheets/sheet1.xml": `${XML_HEAD}
<worksheet ${S_NS}>
  <sheetData>
    <row r="1" ht="30" customHeight="1">
      <c r="A1" s="1" t="inlineStr"><is><t>标题</t></is></c>
      <c r="B1"><v>0.30000000000000004</v></c>
    </row>
    <row r="2"><c r="A2" s="2"><v>0</v></c></row>
  </sheetData>
</worksheet>`,
    "xl/worksheets/sheet2.xml": `${XML_HEAD}
<worksheet ${S_NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>不该出现</t></is></c></row></sheetData></worksheet>`,
  })
}

const xlsxStyled = await office.parseOffice(await buildXlsxStyled(), "xlsx")

check("XLSX 隐藏工作表不出现", () => {
  assert.deepEqual(xlsxStyled.sheets.map((s) => s.name), ["数据"])
})

check("XLSX 行高 ht=30 → 40px", () => assert.equal(xlsxStyled.sheets[0].rows[0].height, 40))

check("XLSX 单元格样式：粗斜体 / 红字 / 绿底 / 居中 / 换行", () => {
  const cell = xlsxStyled.sheets[0].rows[0].cells[0]
  assert.equal(cell.bold, true)
  assert.equal(cell.italic, true)
  assert.equal(cell.color, "#ff0000")
  assert.equal(cell.fill, "#00ff00")
  assert.equal(cell.align, "center")
  assert.equal(cell.wrap, true)
})

check("XLSX General 浮点噪声被收掉（0.1+0.2 → 0.3）", () => {
  assert.equal(xlsxStyled.sheets[0].rows[0].cells[1].text, "0.3")
})

check("XLSX 1904 纪元：序列号 0 → 1904-01-01", () => {
  assert.equal(xlsxStyled.sheets[0].rows[1].cells[0].text, "1904-01-01")
})

function buildPptxInherited() {
  return makeZip({
    "[Content_Types].xml": CONTENT_TYPES,
    "ppt/presentation.xml": `${XML_HEAD}
<p:presentation ${P_NS}>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    "ppt/slides/slide1.xml": `${XML_HEAD}
<p:sld ${P_NS}>
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>继承标题</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="2000000"/><a:ext cx="6000000" cy="3000000"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:bodyPr wrap="none"><a:normAutofit fontScale="62500" lnSpcReduction="10000"/></a:bodyPr>
        <a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:rPr sz="2000"/><a:t>第一项</a:t></a:r></a:p>
        <a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:rPr sz="2000"/><a:t>第二项</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
    <p:graphicFrame>
      <p:xfrm><a:off x="1000000" y="3000000"/><a:ext cx="6000000" cy="1500000"/></p:xfrm>
      <a:graphic><a:graphicData><a:tbl>
        <a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>
        <a:tr h="750000">
          <a:tc><a:tcPr><a:solidFill><a:srgbClr val="FFEEEE"/></a:solidFill></a:tcPr>
            <a:txBody><a:p><a:r><a:t>甲</a:t></a:r></a:p></a:txBody></a:tc>
          <a:tc><a:txBody><a:p><a:r><a:t>乙</a:t></a:r></a:p></a:txBody></a:tc>
        </a:tr>
      </a:tbl></a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    "ppt/slideLayouts/slideLayout1.xml": `${XML_HEAD}
<p:sldLayout ${P_NS}><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="1000000" y="0"/><a:ext cx="8000000" cy="1000000"/></a:xfrm></p:spPr>
    <p:lstStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="60000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></p:lstStyle>
  </p:sp>
</p:spTree></p:cSld></p:sldLayout>`,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    "ppt/slideMasters/slideMaster1.xml": `${XML_HEAD}
<p:sldMaster ${P_NS}><p:cSld><p:spTree/></p:cSld>
  <p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000" b="1"/></a:lvl1pPr></p:titleStyle></p:txStyles>
</p:sldMaster>`,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": `${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    "ppt/theme/theme1.xml": `${XML_HEAD}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:clrScheme name="t">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
  </a:clrScheme></a:themeElements>
</a:theme>`,
  })
}

const inherited = await office.parseOffice(await buildPptxInherited(), "pptx")

check("PPTX 占位符从版式继承位置（无 xfrm 也有正确框）", () => {
  const title = inherited.slides[0].shapes[0]
  assert.ok(Math.abs(title.x - 8.2021) < 0.01, `x=${title.x}`)
  assert.equal(title.y, 0)
  assert.ok(Math.abs(title.w - 65.6168) < 0.01, `w=${title.w}`)
  assert.ok(Math.abs(title.h - 14.5815) < 0.01, `h=${title.h}`)
})

check("PPTX 字号/颜色继承：44pt、母版粗体、主题色 lumMod 变暗", () => {
  const run = inherited.slides[0].shapes[0].paragraphs[0].runs[0]
  assert.equal(run.sizePt, 44)
  assert.equal(run.bold, true)
  assert.match(run.color, /^#[0-9a-f]{6}$/)
  assert.notEqual(run.color, "#4472c4")
})

check("PPTX 主题正文色（tx1）被读出来", () => assert.equal(inherited.textColor, "#000000"))

check("PPTX 自适应字号 / 不换行 / 自动编号", () => {
  const body = inherited.slides[0].shapes[1]
  assert.equal(body.fontScale, 0.625)
  assert.equal(body.lnSpcReduction, 0.1)
  assert.equal(body.nowrap, true)
  assert.equal(body.paragraphs[0].autoNum, true)
  assert.equal(body.paragraphs[1].autoNum, true)
})

check("PPTX 表格：两列、单元格填充与文本", () => {
  const table = inherited.slides[0].shapes[2].table
  assert.deepEqual(table.cols, [50, 50])
  assert.equal(table.rows[0].cells[0].fill, "#ffeeee")
  assert.equal(table.rows[0].cells[0].paragraphs[0].runs[0].text, "甲")
})

/* ---- 失败路径 ---- */
section("失败路径：给出可识别的错误码，而不是抛原始异常")
await checkAsync("随机字节 → invalid", async () => {
  await assert.rejects(
    () => office.parseOffice(new Uint8Array([1, 2, 3, 4, 5]), "docx"),
    (err) => office.isOfficeError(err) && err.code === "invalid"
  )
})

await checkAsync("空文件 → empty", async () => {
  await assert.rejects(
    () => office.parseOffice(new Uint8Array(0), "docx"),
    (err) => office.isOfficeError(err) && err.code === "empty"
  )
})

await checkAsync("OLE 复合文档（加密的 Office）→ encrypted", async () => {
  const ole = new Uint8Array(64)
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  await assert.rejects(
    () => office.parseOffice(ole, "docx"),
    (err) => office.isOfficeError(err) && err.code === "encrypted"
  )
})

await checkAsync("把 docx 当成 xlsx 解析 → unsupported", async () => {
  await assert.rejects(
    () => office.parseOffice(docxBytes, "xlsx"),
    (err) => office.isOfficeError(err) && err.code === "unsupported"
  )
})

/* ---- 汇总 ---- */
console.log("")
if (failed > 0) {
  console.log(`\u274c ${failed} / ${total} 条断言失败`)
  for (const label of failures) console.log(`   - ${label}`)
  process.exit(1)
}
console.log(`\u2705 全部 ${total} 条断言通过`)
