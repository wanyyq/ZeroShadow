/**
 * DOCX 解析：WordprocessingML → 与渲染无关的结构化数据
 *
 * 覆盖范围（「不崩、能读、不乱码」优先）：
 *   段落顺序 / Heading 1–6 / 粗斜下划线删除线 / 字号 / 颜色 / 对齐 / 段前段后 / 行距
 *   表格（gridSpan 横向合并、vMerge 纵向合并、列宽、单元格底纹、单元格内多段）
 *   列表（numbering.xml 的 numFmt + ilvl 缩进）
 *   图片（r:embed → word/media/*，按 wp:extent 限宽）
 *   超链接（外链保留 URL，渲染侧只放行 http(s)/mailto）
 *   分页符（w:br w:type="page"）→ 分隔线
 *
 * 本次更新起读 `word/styles.xml`：标题层级、默认字号、行距、对齐不再只认「直接写在
 * 段落/run 上」的属性，而是按 Word 的样式继承链（docDefaults → 段落样式 → 字符样式
 * → 直接格式）逐层合并。真实文档里 90% 的格式都在样式里，不读它就会出现
 * 「标题不大、正文挤在一起、表格列宽全一样」。
 *
 * 忽略：页眉页脚、脚注、批注、文本框、域代码缓存、艺术字。
 *
 * 产出里所有文本都是纯字符串，图片是包内路径 + 字节，由 React 侧转 `blob:` URL ——
 * 因此这里既没有 DOM，也没有 `dangerouslySetInnerHTML` 的用武之地。
 */

import { collectMedia, emuToPx, readRels, type MediaMap, type OfficePackage, type RelTarget } from "./package.ts"
import { attr, boolProp, child, find, kids, localName, numAttr, type XmlNode } from "./xml.ts"

export type DocxAlign = "left" | "center" | "right" | "justify"

/** 段前/段后（磅）与行距（倍数或固定磅值） */
export interface DocxSpacing {
  beforePt?: number
  afterPt?: number
  /** 倍数（1 = 单倍行距） */
  line?: number
  /** 固定行距（磅） */
  linePt?: number
}

export interface DocxTextRun {
  kind: "text"
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** 磅值（w:sz 是半磅） */
  sizePt?: number
  /** `#rrggbb` */
  color?: string
  /** 外部超链接（仅 http/https/mailto 会被渲染成 <a>） */
  href?: string
}

export interface DocxImageRun {
  kind: "image"
  /** 包内路径，例如 `word/media/image1.png` */
  src: string
  width?: number
  height?: number
}

export type DocxRun = DocxTextRun | DocxImageRun

export interface DocxParagraph {
  kind: "paragraph"
  /** 1–6 表示 Heading 1–6，null 为正文 */
  heading: number | null
  align?: DocxAlign
  spacing?: DocxSpacing
  /** 首行缩进（磅，负数为悬挂缩进） */
  indentPt?: number
  runs: DocxRun[]
}

export interface DocxListItem {
  kind: "item"
  /** 0 起的一级缩进层级 */
  level: number
  ordered: boolean
  /** CSS `list-style-type` */
  listStyle: string
  align?: DocxAlign
  spacing?: DocxSpacing
  runs: DocxRun[]
}

export interface DocxList {
  kind: "list"
  items: DocxListItem[]
}

export interface DocxTableCell {
  /** w:gridSpan，横向合并的列数 */
  span: number
  /** 纵向合并的行数（vMerge 的起点格） */
  rowSpan?: number
  /** 单元格底纹 `#rrggbb` */
  shade?: string
  blocks: DocxBlock[]
}

export interface DocxTable {
  kind: "table"
  /** 每列宽度占比（合计 100），来自 tblGrid */
  widths?: number[]
  rows: (DocxTableCell | null)[][]
}

export interface DocxPageBreak {
  kind: "break"
}

export type DocxBlock = DocxParagraph | DocxList | DocxTable | DocxPageBreak

export interface DocxDocument {
  kind: "docx"
  blocks: DocxBlock[]
  media: MediaMap
}

interface StyleDef {
  id: string
  name: string
  basedOn?: string
  run: RunStyle
  para: ParaStyle
}

interface ParaStyle {
  align?: DocxAlign
  spacing?: DocxSpacing
  outlineLvl?: number
}

interface StyleBook {
  map: Map<string, StyleDef>
  defaultRun: RunStyle
  defaultPara: ParaStyle
}

interface Ctx {
  rels: Map<string, RelTarget>
  mediaPaths: Set<string>
  /** 段落里出现过「分页符」：交给 readBlocks 转成分隔线 */
  pageBreak: boolean
  styles: StyleBook
}

/** `numbering.xml` 里一个编号定义：numId → ilvl → numFmt */
type Numbering = Map<string, Map<number, string>>

const NUM_FORMAT: Record<string, { ordered: boolean; css: string }> = {
  bullet: { ordered: false, css: "disc" },
  none: { ordered: false, css: "none" },
  decimal: { ordered: true, css: "decimal" },
  decimalZero: { ordered: true, css: "decimal-leading-zero" },
  lowerLetter: { ordered: true, css: "lower-alpha" },
  upperLetter: { ordered: true, css: "upper-alpha" },
  lowerRoman: { ordered: true, css: "lower-roman" },
  upperRoman: { ordered: true, css: "upper-roman" },
  decimalEnclosedCircle: { ordered: true, css: "decimal" },
  chineseCounting: { ordered: true, css: "cjk-ideographic" },
  chineseCountingThousand: { ordered: true, css: "cjk-ideographic" },
  ideographDigital: { ordered: true, css: "cjk-ideographic" },
}

function alignOf(value: string | undefined): DocxAlign | undefined {
  switch (value) {
    case "center":
      return "center"
    case "right":
    case "end":
      return "right"
    case "both":
    case "distribute":
    case "justify":
      return "justify"
    case "left":
    case "start":
      return "left"
    default:
      return undefined
  }
}

interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  sizePt?: number
  color?: string
}

function readRunStyle(rPr: XmlNode | undefined): RunStyle {
  if (!rPr) return {}
  const style: RunStyle = {}
  // 显式 w:b w:val="0" 要能关掉样式里的粗体，不能因为"值为假"就当成没写
  const bold = child(rPr, "b")
  if (bold) style.bold = boolProp(bold)
  const italic = child(rPr, "i")
  if (italic) style.italic = boolProp(italic)
  const u = child(rPr, "u")
  if (u && (attr(u, "val") ?? "").toLowerCase() !== "none") style.underline = true
  if (boolProp(child(rPr, "strike")) || boolProp(child(rPr, "dstrike"))) style.strike = true
  const half = numAttr(child(rPr, "sz"), "val")
  if (half && half > 0) style.sizePt = Math.round((half / 2) * 10) / 10
  const color = attr(child(rPr, "color"), "val")
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) style.color = `#${color.toLowerCase()}`
  return style
}

/** `w:spacing`：before/after 是 twips（1/20 磅），line + lineRule 决定行距 */
function readSpacing(node: XmlNode | undefined): DocxSpacing | undefined {
  if (!node) return undefined
  const out: DocxSpacing = {}
  const before = numAttr(node, "before")
  const after = numAttr(node, "after")
  if (before !== undefined) out.beforePt = Math.round((before / 20) * 10) / 10
  if (after !== undefined) out.afterPt = Math.round((after / 20) * 10) / 10
  const line = numAttr(node, "line")
  const rule = attr(node, "lineRule") ?? "auto"
  if (line !== undefined) {
    if (rule === "auto") out.line = Math.round((line / 240) * 100) / 100
    else out.linePt = Math.round((line / 20) * 10) / 10
  }
  return Object.keys(out).length ? out : undefined
}

function mergeSpacing(a: DocxSpacing | undefined, b: DocxSpacing | undefined): DocxSpacing | undefined {
  if (!a && !b) return undefined
  return { ...a, ...b }
}

function readParaStyle(pPr: XmlNode | undefined): ParaStyle {
  if (!pPr) return {}
  const out: ParaStyle = {}
  const align = alignOf(attr(child(pPr, "jc"), "val"))
  if (align) out.align = align
  const spacing = readSpacing(child(pPr, "spacing"))
  if (spacing) out.spacing = spacing
  const outline = numAttr(child(pPr, "outlineLvl"), "val")
  if (outline !== undefined && outline >= 0 && outline <= 8) out.outlineLvl = outline
  return out
}

/* ---------------------------------------------------------------- 样式表 */

function readStyles(root: XmlNode | undefined): StyleBook {
  const book: StyleBook = { map: new Map(), defaultRun: {}, defaultPara: {} }
  if (!root) return book
  const defaults = child(root, "docDefaults")
  if (defaults) {
    book.defaultRun = readRunStyle(child(child(defaults, "rPrDefault"), "rPr"))
    book.defaultPara = readParaStyle(child(child(defaults, "pPrDefault"), "pPr"))
  }
  for (const style of kids(root, "style")) {
    const id = attr(style, "styleId")
    if (!id) continue
    const name = attr(child(style, "name"), "val") ?? ""
    book.map.set(id, {
      id,
      name,
      basedOn: attr(child(style, "basedOn"), "val"),
      run: readRunStyle(child(style, "rPr")),
      para: readParaStyle(child(style, "pPr")),
    })
  }
  return book
}

/** 沿 basedOn 链合并样式（带环检测）；未定义的样式返回空 */
function resolveStyle(book: StyleBook, id: string | undefined, seen = new Set<string>()): { run: RunStyle; para: ParaStyle } {
  if (!id || seen.has(id)) return { run: {}, para: {} }
  const def = book.map.get(id)
  if (!def) return { run: {}, para: {} }
  seen.add(id)
  const base = resolveStyle(book, def.basedOn, seen)
  return { run: { ...base.run, ...def.run }, para: { ...base.para, ...def.para } }
}

/** 标题层级：直接 outlineLvl 优先，其次样式链上的 outlineLvl / 样式名 / styleId */
function headingOf(pPr: XmlNode | undefined, book: StyleBook): number | null {
  const direct = pPr ? numAttr(child(pPr, "outlineLvl"), "val") : undefined
  if (direct !== undefined && direct >= 0 && direct <= 5) return direct + 1
  const styleId = pPr ? attr(child(pPr, "pStyle"), "val") : undefined
  let cur = styleId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const def = book.map.get(cur)
    if (!def) break
    if (def.para.outlineLvl !== undefined && def.para.outlineLvl <= 5) return def.para.outlineLvl + 1
    const fromName = /^(?:heading|标题)\s*([1-6])$/.exec(def.name.trim().toLowerCase())
    if (fromName) return Number(fromName[1])
    const fromId = /^heading([1-6])$/i.exec(cur)
    if (fromId) return Number(fromId[1])
    if (cur.toLowerCase() === "title" || def.name.trim() === "标题") return 1
    cur = def.basedOn
  }
  return null
}

/* ---------------------------------------------------------------- runs */

/** 从 `w:drawing` / `w:pict` 里找出图片的包内路径与显示尺寸 */
function readImage(node: XmlNode, ctx: Ctx): DocxImageRun | undefined {
  const blip = find(node, "blip")
  const legacy = find(node, "imagedata")
  const embed = blip ? attr(blip, "embed") : undefined
  const relId = embed ?? (legacy ? attr(legacy, "id") : undefined)
  if (!relId) return undefined
  const rel = ctx.rels.get(relId)
  if (!rel || rel.external) return undefined
  ctx.mediaPaths.add(rel.target)
  const extent = find(node, "extent")
  const width = emuToPx(numAttr(extent, "cx"))
  const height = emuToPx(numAttr(extent, "cy"))
  return { kind: "image", src: rel.target, width, height }
}

/**
 * 逐个 `w:r` 读文本；`w:hyperlink` / `w:ins` 等容器递归下去，`w:del` 整段跳过。
 * 样式优先级：docDefaults → 段落样式 → 字符样式 → 直接 rPr（后者覆盖前者）。
 */
function readRuns(
  parent: XmlNode,
  base: RunStyle,
  ctx: Ctx,
  out: DocxRun[] = [],
  href?: string
): DocxRun[] {
  for (const node of parent.children) {
    const name = localName(node.name)
    if (name === "r") {
      const rPr = child(node, "rPr")
      const charStyleId = attr(child(rPr, "rStyle"), "val")
      const charStyle = charStyleId ? resolveStyle(ctx.styles, charStyleId).run : undefined
      const runStyle: RunStyle = { ...ctx.styles.defaultRun, ...base, ...charStyle, ...readRunStyle(rPr) }
      for (const item of node.children) {
        const itemName = localName(item.name)
        if (itemName === "t") {
          if (item.text) out.push({ kind: "text", text: item.text, ...runStyle, href })
        } else if (itemName === "tab") {
          out.push({ kind: "text", text: "\t", ...runStyle, href })
        } else if (itemName === "noBreakHyphen") {
          out.push({ kind: "text", text: "-", ...runStyle, href })
        } else if (itemName === "br" || itemName === "cr") {
          const type = attr(item, "type")
          if (type === "page") ctx.pageBreak = true
          else out.push({ kind: "text", text: "\n", ...runStyle, href })
        } else if (itemName === "drawing" || itemName === "pict" || itemName === "object") {
          const image = readImage(item, ctx)
          if (image) out.push(image)
        }
      }
      continue
    }
    if (name === "hyperlink") {
      const rid = attr(node, "id")
      const rel = rid ? ctx.rels.get(rid) : undefined
      const link = rel && rel.external ? rel.target : href
      readRuns(node, base, ctx, out, link)
      continue
    }
    if (
      name === "ins" ||
      name === "smartTag" ||
      name === "fldSimple" ||
      name === "customXml" ||
      name === "sdt" ||
      name === "sdtContent"
    ) {
      readRuns(node, base, ctx, out, href)
      continue
    }
    if (name === "del" || name === "moveFrom") continue
  }
  return out
}

/* ---------------------------------------------------------------- 列表 */

interface ListMeta {
  level: number
  ordered: boolean
  listStyle: string
}

function listMetaOf(pPr: XmlNode | undefined, numbering: Numbering): ListMeta | undefined {
  const numPr = child(pPr, "numPr")
  if (!numPr) return undefined
  const numId = attr(child(numPr, "numId"), "val") ?? ""
  const levelRaw = numAttr(child(numPr, "ilvl"), "val")
  const level = levelRaw !== undefined && levelRaw >= 0 && levelRaw <= 8 ? levelRaw : 0
  // numId="0" 是「显式取消编号」，按正文段落处理
  if (numId === "0") return undefined
  const format = numbering.get(numId)?.get(level) ?? "bullet"
  const style = NUM_FORMAT[format] ?? { ordered: true, css: "decimal" }
  return { level, ordered: style.ordered, listStyle: style.css }
}

function readParagraph(p: XmlNode, ctx: Ctx, numbering: Numbering): DocxParagraph | DocxListItem {
  const pPr = child(p, "pPr")
  const styleId = attr(child(pPr, "pStyle"), "val")
  const style = resolveStyle(ctx.styles, styleId)
  const align = alignOf(attr(child(pPr, "jc"), "val")) ?? style.para.align
  const spacing = mergeSpacing(style.para.spacing, readSpacing(child(pPr, "spacing")))
  const indent = child(pPr, "ind")
  const indentRaw = numAttr(indent, "firstLine")
  const hangingRaw = numAttr(indent, "hanging")
  const indentPt = indentRaw !== undefined ? indentRaw / 20 : hangingRaw !== undefined ? -hangingRaw / 20 : undefined
  const runs = readRuns(p, style.run, ctx)
  const list = listMetaOf(pPr, numbering)
  if (list) {
    const item: DocxListItem = {
      kind: "item",
      level: list.level,
      ordered: list.ordered,
      listStyle: list.listStyle,
      runs,
    }
    if (align) item.align = align
    if (spacing) item.spacing = spacing
    return item
  }
  const para: DocxParagraph = { kind: "paragraph", heading: headingOf(pPr, ctx.styles), runs }
  if (align) para.align = align
  if (spacing) para.spacing = spacing
  if (indentPt !== undefined) para.indentPt = indentPt
  return para
}

/* ---------------------------------------------------------------- 表格 */

function readTable(tbl: XmlNode, ctx: Ctx, numbering: Numbering): DocxTable {
  const grid = kids(child(tbl, "tblGrid"), "gridCol")
    .map((col) => numAttr(col, "w") ?? 0)
    .filter((w) => w > 0)
  const total = grid.reduce((sum, w) => sum + w, 0)
  const widths = total > 0 ? grid.map((w) => Math.round((w / total) * 10000) / 100) : undefined

  const rows: (DocxTableCell | null)[][] = []
  // 每个网格列当前由哪个主格占据（用于 vMerge 续格的 rowSpan 累加）
  const pending = new Map<number, DocxTableCell>()
  for (const tr of kids(tbl, "tr")) {
    const cells: (DocxTableCell | null)[] = []
    let col = 0
    for (const tc of kids(tr, "tc")) {
      const tcPr = child(tc, "tcPr")
      const spanRaw = numAttr(child(tcPr, "gridSpan"), "val")
      const span = spanRaw && spanRaw > 1 ? Math.min(spanRaw, 64) : 1
      const vMerge = child(tcPr, "vMerge")
      const cont = vMerge ? (attr(vMerge, "val") ?? "continue") === "continue" : false
      if (cont) {
        const master = pending.get(col)
        if (master) master.rowSpan = (master.rowSpan ?? 1) + 1
        cells.push(null)
        col += span
        continue
      }
      const shade = attr(child(tcPr, "shd"), "fill")
      const cell: DocxTableCell = { span, blocks: readBlocks(tc, ctx, numbering) }
      if (shade && /^[0-9a-fA-F]{6}$/.test(shade)) cell.shade = `#${shade.toLowerCase()}`
      pending.set(col, cell)
      for (let c = col + 1; c < col + span; c++) pending.delete(c)
      cells.push(cell)
      col += span
    }
    if (cells.length) rows.push(cells)
  }
  return { kind: "table", ...(widths ? { widths } : {}), rows }
}

/* ---------------------------------------------------------------- 块 */

function readBlocks(parent: XmlNode, ctx: Ctx, numbering: Numbering): DocxBlock[] {
  const blocks: DocxBlock[] = []
  let currentList: DocxList | undefined
  let pendingBreak = false

  const flushBreak = () => {
    if (pendingBreak) {
      blocks.push({ kind: "break" })
      pendingBreak = false
    }
  }

  for (const node of parent.children) {
    const name = localName(node.name)
    if (name === "p") {
      const parsed = readParagraph(node, ctx, numbering)
      // 只有分页符、没有文字的段落不必留下一个空行
      const onlyBreak = ctx.pageBreak && parsed.kind === "paragraph" && parsed.runs.length === 0
      if (parsed.kind === "paragraph") {
        if (!onlyBreak) {
          flushBreak()
          currentList = undefined
          blocks.push(parsed)
        }
      } else {
        if (!currentList) {
          currentList = { kind: "list", items: [] }
          blocks.push(currentList)
        }
        flushBreak()
        currentList.items.push(parsed)
      }
      if (ctx.pageBreak) {
        ctx.pageBreak = false
        currentList = undefined
        pendingBreak = true
      }
      continue
    }
    if (name === "tbl") {
      flushBreak()
      currentList = undefined
      blocks.push(readTable(node, ctx, numbering))
      continue
    }
    if (name === "sdt" || name === "sdtContent" || name === "customXml") {
      flushBreak()
      currentList = undefined
      blocks.push(...readBlocks(node, ctx, numbering))
      continue
    }
    if (name === "sectPr" || name === "bookmarkStart" || name === "bookmarkEnd") continue
  }
  flushBreak()
  return blocks
}

/* ---------------------------------------------------------------- 编号 */

async function readNumbering(pkg: OfficePackage): Promise<Numbering> {
  const root = await pkg.xml("word/numbering.xml")
  const out: Numbering = new Map()
  if (!root) return out
  const abstracts = new Map<string, Map<number, string>>()
  for (const abs of kids(root, "abstractNum")) {
    const id = attr(abs, "abstractNumId") ?? attr(abs, "numId")
    if (!id) continue
    const levels = new Map<number, string>()
    for (const lvl of kids(abs, "lvl")) {
      const ilvl = numAttr(lvl, "ilvl") ?? 0
      const fmt = attr(child(lvl, "numFmt"), "val") ?? "bullet"
      levels.set(ilvl, fmt)
    }
    abstracts.set(id, levels)
  }
  for (const num of kids(root, "num")) {
    const numId = attr(num, "numId")
    if (!numId) continue
    const absId = attr(child(num, "abstractNumId"), "val")
    const levels = absId ? abstracts.get(absId) : undefined
    out.set(numId, levels ? new Map(levels) : new Map())
  }
  return out
}

export async function parseDocx(pkg: OfficePackage): Promise<DocxDocument> {
  const root = await pkg.xml("word/document.xml")
  if (!root) throw new Error("missing word/document.xml")
  const body = find(root, "body") ?? root
  const rels = await readRels(pkg, "word/document.xml")
  const numbering = await readNumbering(pkg)
  const styles = readStyles(await pkg.xml("word/styles.xml"))
  const ctx: Ctx = { rels, mediaPaths: new Set(), pageBreak: false, styles }
  const blocks = readBlocks(body, ctx, numbering)
  const media = await collectMedia(pkg, ctx.mediaPaths)
  return { kind: "docx", blocks, media }
}
