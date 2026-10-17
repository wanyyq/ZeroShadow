/**
 * PPTX 解析：PresentationML → 幻灯片结构
 *
 * 覆盖：幻灯片顺序（sldIdLst + rels）、形状按 `a:xfrm` 的 off/ext 换算出百分比坐标、
 * 文本段落/片段（sz、b、i、u、srgbClr）、形状填充与描边、图片（a:blip r:embed → ppt/media/*）、
 * 组合（p:grpSp）用 chOff/chExt 逐层换算到幻灯片坐标。
 *
 * 不处理：版式/母版继承（没有 `a:xfrm` 的占位符无法定位，直接跳过）、
 * 表格（p:graphicFrame）、图表、动画、SmartArt、裁剪与自动缩放。
 * 这些都是「少显示一点」而不是「报错」。
 */

import { collectMedia, readRels, type MediaMap, type OfficePackage, type RelTarget } from "./package.ts"
import { attr, child, find, kids, localName, numAttr, type XmlNode } from "./xml.ts"

export interface PptxRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** 磅值（a:rPr/@sz 是 1/100 磅） */
  sizePt?: number
  color?: string
}

export interface PptxParagraph {
  align?: "left" | "center" | "right" | "justify"
  runs: PptxRun[]
}

export interface PptxShape {
  /** 相对幻灯片宽/高的百分比（0–100） */
  x: number
  y: number
  w: number
  h: number
  fill?: string
  line?: string
  /** 图片：包内路径 */
  image?: string
  paragraphs?: PptxParagraph[]
  anchor?: "top" | "center" | "bottom"
  /** 文本内边距，已是相对幻灯片宽高的百分比 */
  inset?: { l: number; r: number; t: number; b: number }
}

export interface PptxSlide {
  shapes: PptxShape[]
  bg?: string
}

export interface PptxDeck {
  kind: "pptx"
  slides: PptxSlide[]
  /** 幻灯片画布尺寸（EMU），渲染侧按它把字号换算成随容器缩放的单位 */
  width: number
  height: number
  media: MediaMap
}

/** 默认主题配色（只认名字，不读 theme1.xml） */
const SCHEME: Record<string, string> = {
  tx1: "#000000",
  dk1: "#000000",
  bg1: "#ffffff",
  lt1: "#ffffff",
  tx2: "#44546a",
  dk2: "#44546a",
  bg2: "#e7e6e6",
  lt2: "#e7e6e6",
  accent1: "#4472c4",
  accent2: "#ed7d31",
  accent3: "#a5a5a5",
  accent4: "#ffc000",
  accent5: "#5b9bd5",
  accent6: "#70ad47",
  hlink: "#0563c1",
  folHlink: "#954f72",
}

const HEX6 = /^[0-9a-fA-F]{6}$/

function colorOf(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined
  const rgb = attr(child(node, "srgbClr"), "val")
  if (rgb && HEX6.test(rgb)) return `#${rgb.toLowerCase()}`
  const scheme = attr(child(node, "schemeClr"), "val")
  if (scheme && SCHEME[scheme]) return SCHEME[scheme]
  const sys = attr(child(node, "sysClr"), "val")
  if (sys === "windowText") return "#000000"
  if (sys === "window") return "#ffffff"
  if (sys === "highlightText") return "#ffffff"
  if (sys === "highlight") return "#0078d7"
  return undefined
}

/** 坐标映射：子坐标系（EMU）→ 幻灯片坐标系（EMU） */
interface Mapping {
  ox: number
  oy: number
  sx: number
  sy: number
}

const IDENTITY: Mapping = { ox: 0, oy: 0, sx: 1, sy: 1 }

/** 占位符不写 `a:xfrm` 时的兜底框（相对幻灯片宽高的百分比） */
const DEFAULT_PLACEHOLDER = { x: 5, y: 22, w: 90, h: 60 }
const PLACEHOLDER_BOX: Record<string, { x: number; y: number; w: number; h: number }> = {
  title: { x: 5, y: 5, w: 90, h: 16 },
  ctrTitle: { x: 5, y: 28, w: 90, h: 22 },
  subTitle: { x: 10, y: 52, w: 80, h: 20 },
  body: { x: 5, y: 22, w: 90, h: 68 },
}

interface SlideCtx {
  rels: Map<string, RelTarget>
  mediaPaths: Set<string>
  width: number
  height: number
}

function readParagraphs(txBody: XmlNode): PptxParagraph[] {
  const out: PptxParagraph[] = []
  for (const p of kids(txBody, "p")) {
    const pPr = child(p, "pPr")
    const alignRaw = attr(pPr, "algn")
    const align =
      alignRaw === "ctr"
        ? "center"
        : alignRaw === "r"
          ? "right"
          : alignRaw === "just"
            ? "justify"
            : alignRaw === "l"
              ? "left"
              : undefined
    const runs: PptxRun[] = []
    for (const node of p.children) {
      const name = localName(node.name)
      if (name === "r" || name === "fld") {
        const rPr = child(node, "rPr")
        const text = kids(node, "t").map((t) => t.text).join("")
        if (!text) continue
        const run: PptxRun = { text }
        const sz = numAttr(rPr, "sz")
        if (sz && sz > 0) run.sizePt = Math.round((sz / 100) * 10) / 10
        if ((attr(rPr, "b") ?? "").toLowerCase() === "1") run.bold = true
        if ((attr(rPr, "i") ?? "").toLowerCase() === "1") run.italic = true
        const underline = attr(rPr, "u")
        if (underline && underline !== "none") run.underline = true
        const color = colorOf(child(rPr, "solidFill"))
        if (color) run.color = color
        runs.push(run)
      } else if (name === "br") {
        const last = runs[runs.length - 1]
        if (last) last.text += "\n"
        else runs.push({ text: "\n" })
      }
    }
    if (runs.length) out.push({ align, runs })
  }
  return out
}

function readTextBody(txBody: XmlNode, ctx: SlideCtx): Partial<PptxShape> {
  const paragraphs = readParagraphs(txBody)
  if (!paragraphs.length) return {}
  const bodyPr = child(txBody, "bodyPr")
  const anchorRaw = attr(bodyPr, "anchor")
  const anchor = anchorRaw === "ctr" ? "center" : anchorRaw === "b" ? "bottom" : "top"
  // 四边内边距统一按「幻灯片宽度」折算：渲染侧用 cqw 表示，和字号同一套缩放基准
  const pct = (emu: number | undefined) => (emu === undefined ? 0 : (emu / ctx.width) * 100)
  const inset = {
    l: pct(numAttr(bodyPr, "lIns")),
    r: pct(numAttr(bodyPr, "rIns")),
    t: pct(numAttr(bodyPr, "tIns")),
    b: pct(numAttr(bodyPr, "bIns")),
  }
  const hasInset = inset.l || inset.r || inset.t || inset.b
  return { paragraphs, anchor, inset: hasInset ? inset : undefined }
}

function shapeBox(
  xfrm: XmlNode | undefined,
  map: Mapping,
  ctx: SlideCtx
): Pick<PptxShape, "x" | "y" | "w" | "h"> | undefined {
  const off = child(xfrm, "off")
  const ext = child(xfrm, "ext")
  const cx = numAttr(ext, "cx")
  const cy = numAttr(ext, "cy")
  const ox = numAttr(off, "x")
  const oy = numAttr(off, "y")
  if (cx === undefined || cy === undefined) return undefined
  const x = map.ox + map.sx * (ox ?? 0)
  const y = map.oy + map.sy * (oy ?? 0)
  return {
    x: (x / ctx.width) * 100,
    y: (y / ctx.height) * 100,
    w: ((map.sx * cx) / ctx.width) * 100,
    h: ((map.sy * cy) / ctx.height) * 100,
  }
}

function readShape(node: XmlNode, map: Mapping, ctx: SlideCtx): PptxShape | undefined {
  const spPr = child(node, "spPr")
  let box = shapeBox(child(spPr, "xfrm"), map, ctx)
  if (!box) {
    // 占位符常常不写 xfrm（位置继承自版式/母版）。不读母版，就按类型给一个稳妥的默认框，
    // 这样「标题 + 正文」这类典型页面至少能读；否则整页会只剩图片。
    const ph = find(node, "ph")
    if (!ph) return undefined
    const type = attr(ph, "type") ?? "body"
    box = { ...(PLACEHOLDER_BOX[type] ?? DEFAULT_PLACEHOLDER) }
  }
  const shape: PptxShape = { ...box }
  const fill = colorOf(child(spPr, "solidFill"))
  if (fill) shape.fill = fill
  const line = colorOf(child(child(spPr, "ln"), "solidFill"))
  if (line) shape.line = line
  const txBody = child(node, "txBody")
  if (txBody) Object.assign(shape, readTextBody(txBody, ctx))
  if (!shape.fill && !shape.line && !shape.paragraphs) return undefined
  return shape
}

function readPicture(node: XmlNode, map: Mapping, ctx: SlideCtx): PptxShape | undefined {
  const blipFill = child(node, "blipFill")
  const blip = child(blipFill, "blip")
  const rid = attr(blip, "embed")
  const rel = rid ? ctx.rels.get(rid) : undefined
  if (!rel || rel.external) return undefined
  const box = shapeBox(child(child(node, "spPr"), "xfrm"), map, ctx)
  if (!box) return undefined
  ctx.mediaPaths.add(rel.target)
  return { ...box, image: rel.target }
}

function walkShapes(nodes: XmlNode[], map: Mapping, ctx: SlideCtx, out: PptxShape[], depth: number) {
  if (depth > 8) return
  for (const node of nodes) {
    const name = localName(node.name)
    if (name === "sp") {
      const shape = readShape(node, map, ctx)
      if (shape) out.push(shape)
      continue
    }
    if (name === "pic") {
      const shape = readPicture(node, map, ctx)
      if (shape) out.push(shape)
      continue
    }
    if (name === "grpSp") {
      const xfrm = child(child(node, "grpSpPr"), "xfrm")
      const off = child(xfrm, "off")
      const ext = child(xfrm, "ext")
      const chOff = child(xfrm, "chOff")
      const chExt = child(xfrm, "chExt")
      const cx = numAttr(ext, "cx")
      const cy = numAttr(ext, "cy")
      const chCx = numAttr(chExt, "cx")
      const chCy = numAttr(chExt, "cy")
      if (!cx || !cy || !chCx || !chCy) {
        // 组合没有坐标系：按同一坐标系继续处理，总比整组丢掉好
        walkShapes(node.children, map, ctx, out, depth + 1)
        continue
      }
      const kx = cx / chCx
      const ky = cy / chCy
      const next: Mapping = {
        ox: map.ox + map.sx * ((numAttr(off, "x") ?? 0) - kx * (numAttr(chOff, "x") ?? 0)),
        oy: map.oy + map.sy * ((numAttr(off, "y") ?? 0) - ky * (numAttr(chOff, "y") ?? 0)),
        sx: map.sx * kx,
        sy: map.sy * ky,
      }
      walkShapes(node.children, next, ctx, out, depth + 1)
      continue
    }
    // p:graphicFrame（表格/图表）、p:cxnSp（连接线）、mc:AlternateContent 等一律跳过
  }
}

async function parseSlide(pkg: OfficePackage, path: string, ctx: SlideCtx): Promise<PptxSlide> {
  const root = await pkg.xml(path)
  if (!root) return { shapes: [] }
  const cSld = child(root, "cSld")
  const rels = await readRels(pkg, path)
  const slideCtx: SlideCtx = { ...ctx, rels }
  const tree = child(cSld, "spTree")
  const shapes: PptxShape[] = []
  if (tree) walkShapes(tree.children, IDENTITY, slideCtx, shapes, 0)
  const slide: PptxSlide = { shapes }
  const bg = colorOf(child(child(child(root, "bg"), "bgPr"), "solidFill"))
  if (bg) slide.bg = bg
  return slide
}

export async function parsePptx(pkg: OfficePackage): Promise<PptxDeck> {
  const pres = await pkg.xml("ppt/presentation.xml")
  if (!pres) throw new Error("missing ppt/presentation.xml")
  const size = child(pres, "sldSz")
  const width = numAttr(size, "cx") ?? 12192000
  const height = numAttr(size, "cy") ?? 6858000
  const rels = await readRels(pkg, "ppt/presentation.xml")
  const mediaPaths = new Set<string>()
  const ctx: SlideCtx = { rels, mediaPaths, width, height }
  const slides: PptxSlide[] = []
  for (const sldId of kids(child(pres, "sldIdLst"), "sldId")) {
    const rid = attr(sldId, "r:id") ?? attr(sldId, "id")
    const rel = rid ? rels.get(rid) : undefined
    if (!rel || rel.external) continue
    slides.push(await parseSlide(pkg, rel.target, ctx))
  }
  const media = await collectMedia(pkg, mediaPaths)
  return { kind: "pptx", slides, width, height, media }
}
