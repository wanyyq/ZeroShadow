/**
 * DOCX 解析：WordprocessingML → 与渲染无关的结构化数据
 *
 * 覆盖范围（「不崩、能读、不乱码」优先）：
 *   段落顺序 / Heading 1–6 / 粗斜下划线删除线 / 字号 / 颜色 / 对齐
 *   表格（gridSpan 横向合并、单元格内多段）
 *   列表（numbering.xml 的 numFmt + ilvl 缩进）
 *   图片（r:embed → word/media/*，按 wp:extent 限宽）
 *   分页符（w:br w:type="page"）→ 分隔线
 * 忽略：页眉页脚、脚注、批注、竖排合并（vMerge）、域代码缓存。
 *
 * 产出里所有文本都是纯字符串，图片是包内路径 + 字节，由 React 侧转 `blob:` URL ——
 * 因此这里既没有 DOM，也没有 `dangerouslySetInnerHTML` 的用武之地。
 */

import { collectMedia, emuToPx, readRels, type MediaMap, type OfficePackage, type RelTarget } from "./package.ts"
import { attr, boolProp, child, find, kids, localName, numAttr, type XmlNode } from "./xml.ts"

export type DocxAlign = "left" | "center" | "right" | "justify"

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
  runs: DocxRun[]
}

export interface DocxList {
  kind: "list"
  items: DocxListItem[]
}

export interface DocxTableCell {
  /** w:gridSpan，横向合并的列数 */
  span: number
  blocks: DocxBlock[]
}

export interface DocxTable {
  kind: "table"
  rows: DocxTableCell[][]
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

interface Ctx {
  rels: Map<string, RelTarget>
  mediaPaths: Set<string>
  /** 段落里出现过「分页符」：交给 readBlocks 转成分隔线 */
  pageBreak: boolean
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

function headingOf(pPr: XmlNode | undefined): number | null {
  if (!pPr) return null
  const style = (attr(child(pPr, "pStyle"), "val") ?? "").replace(/\s+/g, "").toLowerCase()
  const fromStyle = /^(?:heading|h)?([1-6])$/.exec(style)
  if (fromStyle) return Number(fromStyle[1])
  if (style === "title") return 1
  const outline = numAttr(child(pPr, "outlineLvl"), "val")
  if (outline !== undefined && outline >= 0 && outline <= 5) return outline + 1
  return null
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
  if (boolProp(child(rPr, "b"))) style.bold = true
  if (boolProp(child(rPr, "i"))) style.italic = true
  const u = child(rPr, "u")
  if (u && (attr(u, "val") ?? "").toLowerCase() !== "none") style.underline = true
  if (boolProp(child(rPr, "strike")) || boolProp(child(rPr, "dstrike"))) style.strike = true
  const half = numAttr(child(rPr, "sz"), "val")
  if (half && half > 0) style.sizePt = Math.round((half / 2) * 10) / 10
  const color = attr(child(rPr, "color"), "val")
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) style.color = `#${color.toLowerCase()}`
  return style
}

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

/** 逐个 `w:r` 读文本；`w:hyperlink` / `w:ins` 等容器递归下去，`w:del` 整段跳过 */
function readRuns(parent: XmlNode, style: RunStyle, ctx: Ctx, out: DocxRun[] = []): DocxRun[] {
  for (const node of parent.children) {
    const name = localName(node.name)
    if (name === "r") {
      const runStyle = { ...style, ...readRunStyle(child(node, "rPr")) }
      for (const item of node.children) {
        const itemName = localName(item.name)
        if (itemName === "t") {
          if (item.text) out.push({ kind: "text", text: item.text, ...runStyle })
        } else if (itemName === "tab") {
          out.push({ kind: "text", text: "\t", ...runStyle })
        } else if (itemName === "noBreakHyphen") {
          out.push({ kind: "text", text: "-", ...runStyle })
        } else if (itemName === "br" || itemName === "cr") {
          const type = attr(item, "type")
          if (type === "page") ctx.pageBreak = true
          else out.push({ kind: "text", text: "\n", ...runStyle })
        } else if (itemName === "drawing" || itemName === "pict" || itemName === "object") {
          const image = readImage(item, ctx)
          if (image) out.push(image)
        }
      }
      continue
    }
    if (
      name === "hyperlink" ||
      name === "ins" ||
      name === "smartTag" ||
      name === "fldSimple" ||
      name === "customXml" ||
      name === "sdt" ||
      name === "sdtContent"
    ) {
      readRuns(node, style, ctx, out)
      continue
    }
    if (name === "del" || name === "moveFrom") continue
  }
  return out
}

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
  const format = numbering.get(numId)?.get(level) ?? (level === 0 ? "bullet" : "bullet")
  const style = NUM_FORMAT[format] ?? { ordered: true, css: "decimal" }
  return { level, ordered: style.ordered, listStyle: style.css }
}

function readParagraph(p: XmlNode, ctx: Ctx, numbering: Numbering): DocxParagraph | DocxListItem {
  const pPr = child(p, "pPr")
  const align = alignOf(attr(child(pPr, "jc"), "val"))
  const runs = readRuns(p, {}, ctx)
  const list = listMetaOf(pPr, numbering)
  if (list) {
    return { kind: "item", level: list.level, ordered: list.ordered, listStyle: list.listStyle, align, runs }
  }
  return { kind: "paragraph", heading: headingOf(pPr), align, runs }
}

function readTable(tbl: XmlNode, ctx: Ctx, numbering: Numbering): DocxTable {
  const rows: DocxTableCell[][] = []
  for (const tr of kids(tbl, "tr")) {
    const cells: DocxTableCell[] = []
    for (const tc of kids(tr, "tc")) {
      const tcPr = child(tc, "tcPr")
      const spanRaw = numAttr(child(tcPr, "gridSpan"), "val")
      const span = spanRaw && spanRaw > 1 ? Math.min(spanRaw, 64) : 1
      cells.push({ span, blocks: readBlocks(tc, ctx, numbering) })
    }
    if (cells.length) rows.push(cells)
  }
  return { kind: "table", rows }
}

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
  const ctx: Ctx = { rels, mediaPaths: new Set(), pageBreak: false }
  const blocks = readBlocks(body, ctx, numbering)
  const media = await collectMedia(pkg, ctx.mediaPaths)
  return { kind: "docx", blocks, media }
}
