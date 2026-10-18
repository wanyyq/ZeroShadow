/**
 * PPTX 解析：PresentationML → 幻灯片结构
 *
 * 覆盖：幻灯片顺序（sldIdLst + rels）、形状按 `a:xfrm` 的 off/ext 换算出百分比坐标、
 * 文本段落/片段（sz、b、i、u、srgb/scheme/sys/prst 颜色及 lumMod/tint/shade 修饰）、
 * 形状填充与描边、图片（a:blip r:embed → ppt/media/*）、
 * 组合（p:grpSp）用 chOff/chExt 逐层换算到幻灯片坐标、表格（p:graphicFrame → a:tbl）。
 *
 * 本次更新起补上「继承」：没有 `a:xfrm` 的占位符从 slideLayout / slideMaster 取位置，
 * 字号/颜色/对齐/项目符号/行距按
 *   形状 lstStyle → 版式占位符 lstStyle → 母版占位符 lstStyle → 母版 txStyles → presentation defaultTextStyle
 * 逐层回落。主题色（theme1.xml）也会读，避免「白底黑字变成黑底黑字」。
 *
 * 仍不处理：图表、SmartArt、动画、3D、艺术字、媒体（视频/音频）、OLE 对象。
 * 这些都是「少显示一点」而不是「报错」。
 */

import { collectMedia, readRels, type MediaMap, type OfficePackage, type RelTarget } from "./package.ts"
import { attr, child, kids, localName, numAttr, type XmlNode } from "./xml.ts"

export interface PptxRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** 磅值（a:rPr/@sz 是 1/100 磅） */
  sizePt?: number
  color?: string
}

export interface PptxParagraph {
  align?: "left" | "center" | "right" | "justify"
  /** 0–8（a:pPr/@lvl） */
  level?: number
  /** 项目符号字符（如 "•"）；autoNum 时由渲染侧编号 */
  bullet?: string
  autoNum?: boolean
  /** 编号起始值（a:buAutoNum/@startAt，默认 1） */
  startAt?: number
  /** 左缩进与首行缩进，相对幻灯片宽度的百分比（可负） */
  marL?: number
  indent?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
  /** 行距倍数（a:lnSpc/a:spcPct，100000 = 1.0 倍） */
  lineSpacing?: number
  /** 固定行距（a:lnSpc/a:spcPts，单位磅） */
  lineHeightPt?: number
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
  /** 文本内边距，相对幻灯片宽（左右）与高（上下）的百分比 */
  inset?: { l: number; r: number; t: number; b: number }
  /** `a:bodyPr/@wrap="none"`：不自动换行 */
  nowrap?: boolean
  /** 竖排（a:bodyPr/@vert） */
  vert?: "vert" | "vert270" | "eaVert"
  /** 旋转角度（a:xfrm/@rot，1/60000 度） */
  rotation?: number
  /** 自适应字号缩放（a:normAutofit/@fontScale，0–1） */
  fontScale?: number
  /** 自适应行距缩减（a:normAutofit/@lnSpcReduction，0–1） */
  lnSpcReduction?: number
  /** 表格：绝对定位 + 相对表宽的列宽百分比 */
  table?: PptxTable
}

export interface PptxTableCell {
  paragraphs?: PptxParagraph[]
  colSpan?: number
  rowSpan?: number
  fill?: string
  border?: boolean
  align?: "left" | "center" | "right"
  anchor?: "top" | "center" | "bottom"
  inset?: { l: number; r: number; t: number; b: number }
}

export interface PptxTableRow {
  /** 行高占比（相对表高百分比） */
  height?: number
  cells: (PptxTableCell | null)[]
}

export interface PptxTable {
  cols: number[]
  rows: PptxTableRow[]
  /** 表格是否带边框（任一单元格有描边即为 true） */
  border: boolean
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
  /** 主题正文色（tx1），渲染侧用作未指定颜色时的默认值 */
  textColor: string
  media: MediaMap
}

/* ---------------------------------------------------------------- 颜色 */

const HEX6 = /^[0-9a-fA-F]{6}$/

/** 主题缺失时的保底配色（Office 默认主题） */
const FALLBACK_SCHEME: Record<string, string> = {
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

/** 常用预设色名（prstClr）；只需要覆盖办公文档里会出现的那些 */
const PRESET: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  darkGray: "#a9a9a9",
  lightGray: "#d3d3d3",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  cyan: "#00ffff",
  magenta: "#ff00ff",
}

type ThemeColors = Record<string, string>

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function rgbToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(clamp01(l) * 255)
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`
  }
  const hue = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const r = hue(p, q, h + 1 / 3)
  const g = hue(p, q, h)
  const b = hue(p, q, h - 1 / 3)
  const hex = (n: number) =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** 应用 a:schemeClr 下的颜色修饰（lumMod / lumOff / tint / shade / satMod） */
function applyColorMods(hex: string, node: XmlNode): string {
  const base = rgbToHsl(hex)
  const h = base.h
  let s = base.s
  let l = base.l
  for (const mod of node.children) {
    const name = localName(mod.name)
    const val = numAttr(mod, "val")
    if (val === undefined) continue
    if (name === "lumMod") l = clamp01((l * val) / 100000)
    else if (name === "lumOff") l = clamp01(l + val / 100000)
    else if (name === "satMod") s = clamp01((s * val) / 100000)
    else if (name === "tint") l = clamp01(l + (1 - l) * (val / 100000))
    else if (name === "shade") l = clamp01(l * (val / 100000))
  }
  return hslToRgb(h, s, l)
}

function colorFromNode(node: XmlNode | undefined, theme: ThemeColors): string | undefined {
  if (!node) return undefined
  const srgb = attr(child(node, "srgbClr"), "val")
  if (srgb && HEX6.test(srgb)) return `#${srgb.toLowerCase()}`
  const schemeNode = child(node, "schemeClr")
  const scheme = attr(schemeNode, "val")
  if (scheme) {
    const base = theme[scheme] ?? FALLBACK_SCHEME[scheme]
    if (base) return schemeNode ? applyColorMods(base, schemeNode) : base
  }
  const sys = attr(child(node, "sysClr"), "val")
  if (sys) {
    const last = attr(child(node, "sysClr"), "lastClr")
    if (last && HEX6.test(last)) return `#${last.toLowerCase()}`
    if (sys === "windowText") return "#000000"
    if (sys === "window") return "#ffffff"
    if (sys === "highlight") return "#0078d7"
    if (sys === "highlightText") return "#ffffff"
  }
  const prst = attr(child(node, "prstClr"), "val")
  if (prst && PRESET[prst]) return PRESET[prst]
  const scrgb = child(node, "scrgbClr")
  if (scrgb) {
    const parts = ["r", "g", "b"].map((key) =>
      Math.round(clamp01((numAttr(scrgb, key) ?? 0) / 100000) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    return `#${parts.join("")}`
  }
  const hsl = child(node, "hslClr")
  if (hsl) {
    const hh = (numAttr(hsl, "hue") ?? 0) / 21600000
    const ss = (numAttr(hsl, "sat") ?? 0) / 100000
    const ll = (numAttr(hsl, "lum") ?? 0) / 100000
    return hslToRgb(hh, ss, ll)
  }
  return undefined
}

/** 从一个 solidFill/gradientFill 节点取颜色；渐变取第一个色标 */
function fillColor(fill: XmlNode | undefined, theme: ThemeColors): string | undefined {
  if (!fill) return undefined
  const solid = child(fill, "solidFill")
  if (solid) return colorFromNode(solid, theme)
  const grad = child(fill, "gradFill")
  if (grad) {
    const gsLst = child(grad, "gsLst")
    const first = kids(gsLst, "gs")[0]
    return colorFromNode(first, theme)
  }
  const patt = child(fill, "pattFill")
  if (patt) return colorFromNode(child(patt, "fgClr"), theme)
  return undefined
}

/* ---------------------------------------------------------------- 主题 */

async function readTheme(pkg: OfficePackage, path: string | undefined): Promise<ThemeColors> {
  const colors: ThemeColors = { ...FALLBACK_SCHEME }
  if (!path) return colors
  const root = await pkg.xml(path)
  const scheme = child(child(root, "themeElements"), "clrScheme")
  if (!scheme) return colors
  for (const item of scheme.children) {
    const name = localName(item.name)
    const color = colorFromNode(item, FALLBACK_SCHEME)
    if (color) colors[name] = color
  }
  // tx1/bg1 等别名指向 dk1/lt1（反之亦然），保证两种写法都能解析
  const alias: Record<string, string> = {
    tx1: "dk1",
    bg1: "lt1",
    tx2: "dk2",
    bg2: "lt2",
    dk1: "tx1",
    lt1: "bg1",
    dk2: "tx2",
    lt2: "bg2",
  }
  for (const [from, to] of Object.entries(alias)) {
    if (colors[from] && !colors[to]) colors[to] = colors[from]
  }
  return colors
}

/* ---------------------------------------------------------------- 样式 */

interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  sizePt?: number
  color?: string
}

interface ParaStyle {
  align?: PptxParagraph["align"]
  bullet?: string
  autoNum?: boolean
  startAt?: number
  marL?: number
  indent?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
  lineSpacing?: number
  lineHeightPt?: number
}

interface LevelStyle {
  run?: RunStyle
  para?: ParaStyle
}

type StyleSheet = Map<number, LevelStyle>

function truthy(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.toLowerCase()
  if (v === "1" || v === "true") return true
  if (v === "0" || v === "false") return false
  return undefined
}

/** 字号：a:rPr/@sz 是 1/100 磅 */
function sizeOf(node: XmlNode | undefined): number | undefined {
  const sz = numAttr(node, "sz")
  if (sz === undefined || sz <= 0) return undefined
  return Math.round((sz / 100) * 10) / 10
}

function readRunProps(node: XmlNode | undefined, theme: ThemeColors): RunStyle {
  if (!node) return {}
  const out: RunStyle = {}
  const bold = truthy(attr(node, "b"))
  if (bold !== undefined) out.bold = bold
  const italic = truthy(attr(node, "i"))
  if (italic !== undefined) out.italic = italic
  const underline = attr(node, "u")
  if (underline) out.underline = underline !== "none"
  const strike = attr(node, "strike")
  if (strike) out.strike = strike !== "noStrike"
  const size = sizeOf(node)
  if (size) out.sizePt = size
  const color = colorFromNode(child(node, "solidFill"), theme)
  if (color) out.color = color
  return out
}

function spacingPt(node: XmlNode | undefined): number | undefined {
  if (!node) return undefined
  const pts = numAttr(child(node, "spcPts"), "val")
  if (pts !== undefined) return Math.round((pts / 100) * 10) / 10
  return undefined
}

function readParaProps(node: XmlNode | undefined, theme: ThemeColors): { para: ParaStyle; run?: RunStyle } | undefined {
  if (!node) return undefined
  const para: ParaStyle = {}
  const align = attr(node, "algn")
  if (align === "l") para.align = "left"
  else if (align === "ctr") para.align = "center"
  else if (align === "r") para.align = "right"
  else if (align === "just" || align === "dist") para.align = "justify"
  const marL = numAttr(node, "marL")
  if (marL !== undefined) para.marL = marL
  const indent = numAttr(node, "indent")
  if (indent !== undefined) para.indent = indent
  const buNone = child(node, "buNone")
  const buChar = child(node, "buChar")
  const buAuto = child(node, "buAutoNum")
  if (buNone) para.bullet = ""
  else if (buChar) para.bullet = attr(buChar, "char") ?? "•"
  else if (buAuto) {
    para.autoNum = true
    const start = numAttr(buAuto, "startAt")
    if (start) para.startAt = start
  }
  const before = spacingPt(child(node, "spcBef"))
  if (before !== undefined) para.spaceBeforePt = before
  const after = spacingPt(child(node, "spcAft"))
  if (after !== undefined) para.spaceAfterPt = after
  const ln = child(node, "lnSpc")
  if (ln) {
    const pct = numAttr(child(ln, "spcPct"), "val")
    const pts = numAttr(child(ln, "spcPts"), "val")
    if (pct !== undefined) para.lineSpacing = pct / 100000
    else if (pts !== undefined) para.lineHeightPt = Math.round((pts / 100) * 10) / 10
  }
  const run = readRunProps(child(node, "defRPr"), theme)
  const hasRun = Object.keys(run).length > 0
  return { para, run: hasRun ? run : undefined }
}

/** 读 `a:lstStyle` / `p:txStyles/p:titleStyle` 之类的「按级别」样式表 */
function readLevelStyles(node: XmlNode | undefined, theme: ThemeColors): StyleSheet {
  const out: StyleSheet = new Map()
  if (!node) return out
  for (const item of node.children) {
    const name = localName(item.name)
    const match = /^lvl([1-9])pPr$/.exec(name)
    if (!match) continue
    const level = Number(match[1]) - 1
    const props = readParaProps(item, theme)
    if (props) out.set(level, props)
  }
  return out
}

function mergeStyleSheet(base: StyleSheet | undefined, extra: StyleSheet | undefined): StyleSheet {
  const out: StyleSheet = new Map()
  for (const [level, style] of base ?? []) out.set(level, { run: { ...style.run }, para: { ...style.para } })
  for (const [level, style] of extra ?? []) {
    const prev = out.get(level) ?? {}
    out.set(level, { run: { ...prev.run, ...style.run }, para: { ...prev.para, ...style.para } })
  }
  return out
}

/** 取某一级的最终样式：这一级没有就用第 1 级（PowerPoint 的行为） */
function levelStyle(sheet: StyleSheet, level: number): LevelStyle {
  return sheet.get(level) ?? sheet.get(0) ?? {}
}

/* ---------------------------------------------------------------- 继承 */

interface PlaceholderDef {
  type: string
  idx?: string
  xfrm?: XmlNode
  lst?: StyleSheet
}

interface Inheritance {
  theme: ThemeColors
  layoutPh: PlaceholderDef[]
  masterPh: PlaceholderDef[]
  roleStyles: Record<"title" | "body" | "other", StyleSheet>
  defaultStyles?: StyleSheet
  bg?: string
}

/** title/ctrTitle、body/obj/subTitle 在版式匹配时视为同类 */
function normType(type: string): string {
  if (type === "ctrTitle") return "title"
  if (type === "subTitle" || type === "obj") return "body"
  return type
}

function readPlaceholders(spTree: XmlNode | undefined, theme: ThemeColors): PlaceholderDef[] {
  const out: PlaceholderDef[] = []
  for (const sp of kids(spTree, "sp")) {
    const ph = child(child(child(sp, "nvSpPr"), "nvPr"), "ph")
    if (!ph) continue
    out.push({
      type: attr(ph, "type") ?? "body",
      idx: attr(ph, "idx"),
      xfrm: child(child(sp, "spPr"), "xfrm"),
      lst: readLevelStyles(child(sp, "lstStyle"), theme),
    })
  }
  return out
}

function pickPlaceholder(list: PlaceholderDef[], type: string, idx: string | undefined): PlaceholderDef | undefined {
  const want = normType(type)
  return (
    list.find((p) => normType(p.type) === want && idx !== undefined && p.idx === idx) ??
    list.find((p) => normType(p.type) === want) ??
    (idx !== undefined ? list.find((p) => p.idx === idx) : undefined)
  )
}

function bgOf(root: XmlNode | undefined, theme: ThemeColors): string | undefined {
  const bg = child(root, "bg")
  if (!bg) return undefined
  const bgPr = child(bg, "bgPr")
  const fromFill = fillColor(bgPr, theme)
  if (fromFill) return fromFill
  const bgRef = child(bg, "bgRef")
  if (bgRef) return colorFromNode(bgRef, theme)
  return undefined
}

/** 读 slide 的 layout / master / theme / defaultTextStyle，供每个形状回落 */
async function readInheritance(pkg: OfficePackage, slidePath: string): Promise<Inheritance> {
  const slideRels = await readRels(pkg, slidePath)
  const layoutRel = [...slideRels.values()].find((r) => (r.type ?? "").endsWith("/slideLayout"))
  let layoutRoot: XmlNode | undefined
  let masterRoot: XmlNode | undefined
  let themePath: string | undefined
  const theme: ThemeColors = { ...FALLBACK_SCHEME }
  if (layoutRel) {
    layoutRoot = await pkg.xml(layoutRel.target)
    const layoutRels = await readRels(pkg, layoutRel.target)
    const masterRel = [...layoutRels.values()].find((r) => (r.type ?? "").endsWith("/slideMaster"))
    if (masterRel) {
      masterRoot = await pkg.xml(masterRel.target)
      const masterRels = await readRels(pkg, masterRel.target)
      themePath = [...masterRels.values()].find((r) => (r.type ?? "").endsWith("/theme"))?.target
    }
  }
  Object.assign(theme, await readTheme(pkg, themePath))

  const masterSpTree = child(child(masterRoot, "cSld"), "spTree")
  const layoutSpTree = child(child(layoutRoot, "cSld"), "spTree")
  const txStyles = child(masterRoot, "txStyles")
  const roleStyles = {
    title: readLevelStyles(child(txStyles, "titleStyle"), theme),
    body: readLevelStyles(child(txStyles, "bodyStyle"), theme),
    other: readLevelStyles(child(txStyles, "otherStyle"), theme),
  }
  const pres = await pkg.xml("ppt/presentation.xml")
  return {
    theme,
    layoutPh: readPlaceholders(layoutSpTree, theme),
    masterPh: readPlaceholders(masterSpTree, theme),
    roleStyles,
    defaultStyles: readLevelStyles(child(pres, "defaultTextStyle"), theme),
    bg: bgOf(layoutRoot, theme) ?? bgOf(masterRoot, theme),
  }
}

/* ---------------------------------------------------------------- 文本 */

function roleOfType(type: string): "title" | "body" | "other" {
  const t = normType(type)
  if (t === "title") return "title"
  if (t === "body") return "body"
  return "other"
}

/** 一个形状最终生效的样式表（低优先级在前） */
function sheetForShape(shape: XmlNode, inh: Inheritance): StyleSheet {
  const ph = child(child(child(shape, "nvSpPr"), "nvPr"), "ph")
  const type = attr(ph, "type") ?? "body"
  const idx = attr(ph, "idx")
  let sheet: StyleSheet = inh.defaultStyles ?? new Map()
  sheet = mergeStyleSheet(sheet, inh.roleStyles[roleOfType(type)])
  if (ph) {
    const masterPh = pickPlaceholder(inh.masterPh, type, idx)
    if (masterPh?.lst) sheet = mergeStyleSheet(sheet, masterPh.lst)
  }
  if (ph) {
    const layoutPh = pickPlaceholder(inh.layoutPh, type, idx)
    if (layoutPh?.lst) sheet = mergeStyleSheet(sheet, layoutPh.lst)
  }
  sheet = mergeStyleSheet(sheet, readLevelStyles(child(shape, "lstStyle"), inh.theme))
  return sheet
}

function runFrom(node: XmlNode, base: RunStyle, theme: ThemeColors): PptxRun {
  const rPr = child(node, "rPr")
  const style = { ...base, ...readRunProps(rPr, theme) }
  const text = kids(node, "t")
    .map((t) => t.text)
    .join("")
  const run: PptxRun = { text }
  if (style.bold) run.bold = true
  if (style.italic) run.italic = true
  if (style.underline) run.underline = true
  if (style.strike) run.strike = true
  if (style.sizePt) run.sizePt = style.sizePt
  if (style.color) run.color = style.color
  return run
}

function readParagraphs(txBody: XmlNode, sheet: StyleSheet, inh: Inheritance, width: number): PptxParagraph[] {
  const out: PptxParagraph[] = []
  for (const p of kids(txBody, "p")) {
    const pPr = child(p, "pPr")
    const rawLevel = numAttr(pPr, "lvl")
    const level = rawLevel !== undefined && rawLevel >= 0 && rawLevel <= 8 ? rawLevel : 0
    const style = levelStyle(sheet, level)
    const direct = readParaProps(pPr, inh.theme)
    const para: PptxParagraph = {
      runs: [],
      level,
    }
    const mergedPara: ParaStyle = { ...style.para, ...direct?.para }
    if (mergedPara.align) para.align = mergedPara.align
    if (mergedPara.bullet !== undefined) para.bullet = mergedPara.bullet
    if (mergedPara.autoNum) para.autoNum = true
    if (mergedPara.startAt) para.startAt = mergedPara.startAt
    if (mergedPara.marL !== undefined) para.marL = (mergedPara.marL / width) * 100
    if (mergedPara.indent !== undefined) para.indent = (mergedPara.indent / width) * 100
    if (mergedPara.spaceBeforePt !== undefined) para.spaceBeforePt = mergedPara.spaceBeforePt
    if (mergedPara.spaceAfterPt !== undefined) para.spaceAfterPt = mergedPara.spaceAfterPt
    if (mergedPara.lineSpacing !== undefined) para.lineSpacing = mergedPara.lineSpacing
    if (mergedPara.lineHeightPt !== undefined) para.lineHeightPt = mergedPara.lineHeightPt
    const runBase: RunStyle = { ...style.run, ...direct?.run }
    for (const node of p.children) {
      const name = localName(node.name)
      if (name === "r" || name === "fld") {
        const run = runFrom(node, runBase, inh.theme)
        if (run.text) para.runs.push(run)
      } else if (name === "br") {
        const last = para.runs[para.runs.length - 1]
        if (last) last.text += "\n"
        else para.runs.push({ text: "\n" })
      }
    }
    if (para.runs.length) out.push(para)
  }
  return out
}

function readTextBody(
  txBody: XmlNode,
  sheet: StyleSheet,
  inh: Inheritance,
  width: number,
  height: number
): Partial<PptxShape> {
  const paragraphs = readParagraphs(txBody, sheet, inh, width)
  if (!paragraphs.length) return {}
  const bodyPr = child(txBody, "bodyPr")
  const anchorRaw = attr(bodyPr, "anchor")
  const anchor = anchorRaw === "ctr" ? "center" : anchorRaw === "b" ? "bottom" : "top"
  // 默认内边距：左右 0.1in、上下 0.05in（PowerPoint 的文本框默认值）
  const pctW = (emu: number | undefined, fallback: number) =>
    ((emu === undefined ? fallback : emu) / width) * 100
  const pctH = (emu: number | undefined, fallback: number) =>
    ((emu === undefined ? fallback : emu) / height) * 100
  const inset = {
    l: pctW(numAttr(bodyPr, "lIns"), 91440),
    r: pctW(numAttr(bodyPr, "rIns"), 91440),
    t: pctH(numAttr(bodyPr, "tIns"), 45720),
    b: pctH(numAttr(bodyPr, "bIns"), 45720),
  }
  const vertRaw = attr(bodyPr, "vert")
  const vert =
    vertRaw === "vert" || vertRaw === "vert270" || vertRaw === "eaVert" ? vertRaw : undefined
  const norm = child(bodyPr, "normAutofit")
  const fontScale = norm ? numAttr(norm, "fontScale") : undefined
  const lnSpcReduction = norm ? numAttr(norm, "lnSpcReduction") : undefined
  return {
    paragraphs,
    anchor,
    inset,
    nowrap: attr(bodyPr, "wrap") === "none",
    vert,
    fontScale: fontScale !== undefined ? fontScale / 100000 : undefined,
    lnSpcReduction: lnSpcReduction !== undefined ? lnSpcReduction / 100000 : undefined,
  }
}

/* ---------------------------------------------------------------- 坐标 */

/** 坐标映射：子坐标系（EMU）→ 幻灯片坐标系（EMU） */
interface Mapping {
  ox: number
  oy: number
  sx: number
  sy: number
}

const IDENTITY: Mapping = { ox: 0, oy: 0, sx: 1, sy: 1 }

/** 占位符不写 `a:xfrm`、版式里也找不到时的兜底框（相对幻灯片宽高的百分比） */
const DEFAULT_PLACEHOLDER = { x: 8, y: 24, w: 84, h: 56 }
const PLACEHOLDER_BOX: Record<string, { x: number; y: number; w: number; h: number }> = {
  title: { x: 8, y: 6, w: 84, h: 16 },
  ctrTitle: { x: 8, y: 30, w: 84, h: 22 },
  subTitle: { x: 12, y: 56, w: 76, h: 20 },
  body: { x: 8, y: 24, w: 84, h: 56 },
}

function boxFromXfrm(
  xfrm: XmlNode | undefined,
  map: Mapping,
  width: number,
  height: number
): Pick<PptxShape, "x" | "y" | "w" | "h"> | undefined {
  const off = child(xfrm, "off")
  const ext = child(xfrm, "ext")
  const cx = numAttr(ext, "cx")
  const cy = numAttr(ext, "cy")
  if (cx === undefined || cy === undefined) return undefined
  const ox = numAttr(off, "x") ?? 0
  const oy = numAttr(off, "y") ?? 0
  const x = map.ox + map.sx * ox
  const y = map.oy + map.sy * oy
  return {
    x: (x / width) * 100,
    y: (y / height) * 100,
    w: ((map.sx * cx) / width) * 100,
    h: ((map.sy * cy) / height) * 100,
  }
}

/* ---------------------------------------------------------------- 表格 */

function tableCellMargins(tcPr: XmlNode | undefined): { l: number; r: number; t: number; b: number } {
  const marL = numAttr(tcPr, "marL")
  const marR = numAttr(tcPr, "marR")
  const marT = numAttr(tcPr, "marT")
  const marB = numAttr(tcPr, "marB")
  return {
    l: marL ?? 91440,
    r: marR ?? 91440,
    t: marT ?? 45720,
    b: marB ?? 45720,
  }
}

function readTable(frame: XmlNode, map: Mapping, inh: Inheritance, width: number, height: number): PptxShape | undefined {
  const tbl = child(child(child(frame, "graphic"), "graphicData"), "tbl")
  if (!tbl) return undefined
  const box = boxFromXfrm(child(frame, "xfrm"), map, width, height)
  if (!box) return undefined

  const tableWidthEmu = (box.w / 100) * width
  const gridCols = kids(child(tbl, "tblGrid"), "gridCol")
  const rawWidths = gridCols.map((col) => numAttr(col, "w") ?? 0)
  const total = rawWidths.reduce((sum, w) => sum + w, 0) || 1
  const cols = rawWidths.map((w) => (w / total) * 100)

  const trs = kids(tbl, "tr")
  const rawHeights = trs.map((tr) => numAttr(tr, "h") ?? 0)
  const totalH = rawHeights.reduce((sum, h) => sum + h, 0) || 1
  let hasBorder = false

  const rows: PptxTableRow[] = []
  for (let r = 0; r < trs.length; r++) {
    const tr = trs[r]
    const cells: (PptxTableCell | null)[] = []
    for (const tc of kids(tr, "tc")) {
      // hMerge/vMerge 的续格由主格的 colSpan/rowSpan 覆盖，直接跳过占位
      if (truthy(attr(tc, "hMerge")) || truthy(attr(tc, "vMerge"))) {
        cells.push(null)
        continue
      }
      const tcPr = child(tc, "tcPr")
      const gridSpan = numAttr(tc, "gridSpan") ?? 1
      const rowSpan = numAttr(tc, "rowSpan") ?? 1
      const fill = fillColor(tcPr, inh.theme)
      const cell: PptxTableCell = {}
      if (gridSpan > 1) cell.colSpan = gridSpan
      if (rowSpan > 1) cell.rowSpan = rowSpan
      if (fill) cell.fill = fill
      const anchorRaw = attr(tcPr, "anchor")
      if (anchorRaw === "ctr") cell.anchor = "center"
      else if (anchorRaw === "b") cell.anchor = "bottom"
      const alignRaw = attr(tcPr, "algn")
      if (alignRaw === "ctr") cell.align = "center"
      else if (alignRaw === "r") cell.align = "right"
      const margins = tableCellMargins(tcPr)
      cell.inset = {
        l: (margins.l / tableWidthEmu) * 100,
        r: (margins.r / tableWidthEmu) * 100,
        t: (margins.t / ((box.h / 100) * height)) * 100,
        b: (margins.b / ((box.h / 100) * height)) * 100,
      }
      const hasLine = ["lnL", "lnR", "lnT", "lnB"].some((name) => {
        const ln = child(tcPr, name)
        return ln && child(ln, "solidFill") && attr(ln, "w") !== "0"
      })
      if (hasLine) {
        cell.border = true
        hasBorder = true
      }
      const txBody = child(tc, "txBody")
      if (txBody) {
        const sheet = mergeStyleSheet(inh.roleStyles.other, undefined)
        Object.assign(cell, { paragraphs: readParagraphs(txBody, sheet, inh, width) })
        if (!cell.paragraphs?.length) delete cell.paragraphs
      }
      cells.push(cell)
    }
    rows.push({
      height: rawHeights[r] ? (rawHeights[r] / totalH) * 100 : undefined,
      cells,
    })
  }
  if (!rows.length) return undefined
  return {
    ...box,
    table: { cols, rows, border: hasBorder },
  }
}

/* ---------------------------------------------------------------- 形状 */

interface ShapeCtx {
  inh: Inheritance
  width: number
  height: number
  rels: Map<string, RelTarget>
  mediaPaths: Set<string>
}

function readShape(node: XmlNode, map: Mapping, ctx: ShapeCtx): PptxShape | undefined {
  const spPr = child(node, "spPr")
  const ph = child(child(child(node, "nvSpPr"), "nvPr"), "ph")
  let box = boxFromXfrm(child(spPr, "xfrm"), map, ctx.width, ctx.height)
  if (!box) {
    // 占位符通常不写 xfrm（位置继承自版式/母版）：先找版式，再找母版，最后才是兜底框
    if (!ph) return undefined
    const type = attr(ph, "type") ?? "body"
    const idx = attr(ph, "idx")
    const layoutPh = pickPlaceholder(ctx.inh.layoutPh, type, idx)
    const masterPh = pickPlaceholder(ctx.inh.masterPh, type, idx)
    const inherited = layoutPh?.xfrm ?? masterPh?.xfrm
    box =
      (inherited ? boxFromXfrm(inherited, IDENTITY, ctx.width, ctx.height) : undefined) ??
      PLACEHOLDER_BOX[type] ??
      DEFAULT_PLACEHOLDER
  }
  const shape: PptxShape = { ...box }
  const fill = fillColor(spPr, ctx.inh.theme)
  if (fill) shape.fill = fill
  const lineFill = child(child(spPr, "ln"), "solidFill")
  const line = lineFill ? colorFromNode(lineFill, ctx.inh.theme) : undefined
  if (line) shape.line = line
  const xfrm = child(spPr, "xfrm")
  const rot = numAttr(xfrm, "rot")
  if (rot) shape.rotation = rot / 60000

  const txBody = child(node, "txBody")
  if (txBody) {
    Object.assign(shape, readTextBody(txBody, sheetForShape(node, ctx.inh), ctx.inh, ctx.width, ctx.height))
  }
  if (!shape.fill && !shape.line && !shape.paragraphs) return undefined
  return shape
}

function readPicture(node: XmlNode, map: Mapping, ctx: ShapeCtx): PptxShape | undefined {
  const blip = child(child(node, "blipFill"), "blip")
  const rid = attr(blip, "embed")
  const rel = rid ? ctx.rels.get(rid) : undefined
  if (!rel || rel.external) return undefined
  const box = boxFromXfrm(child(child(node, "spPr"), "xfrm"), map, ctx.width, ctx.height)
  if (!box) return undefined
  ctx.mediaPaths.add(rel.target)
  return { ...box, image: rel.target }
}

function walkShapes(nodes: XmlNode[], map: Mapping, ctx: ShapeCtx, out: PptxShape[], depth: number) {
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
    if (name === "graphicFrame") {
      const table = readTable(node, map, ctx.inh, ctx.width, ctx.height)
      if (table) out.push(table)
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
    // 图表（p:chart）、连接线（p:cxnSp）、OLE、媒体等一律跳过
  }
}

async function parseSlide(
  pkg: OfficePackage,
  path: string,
  width: number,
  height: number,
  mediaPaths: Set<string>
): Promise<{ slide: PptxSlide; textColor: string }> {
  const root = await pkg.xml(path)
  if (!root) return { slide: { shapes: [] }, textColor: "#000000" }
  const inh = await readInheritance(pkg, path)
  const rels = await readRels(pkg, path)
  const tree = child(child(root, "cSld"), "spTree")
  const shapes: PptxShape[] = []
  if (tree) walkShapes(tree.children, IDENTITY, { inh, width, height, rels, mediaPaths }, shapes, 0)
  const slide: PptxSlide = { shapes }
  const bg = bgOf(root, inh.theme) ?? inh.bg
  if (bg) slide.bg = bg
  return { slide, textColor: inh.theme.tx1 ?? "#000000" }
}

export async function parsePptx(pkg: OfficePackage): Promise<PptxDeck> {
  const pres = await pkg.xml("ppt/presentation.xml")
  if (!pres) throw new Error("missing ppt/presentation.xml")
  const size = child(pres, "sldSz")
  const width = numAttr(size, "cx") ?? 12192000
  const height = numAttr(size, "cy") ?? 6858000
  const rels = await readRels(pkg, "ppt/presentation.xml")
  const mediaPaths = new Set<string>()
  const slides: PptxSlide[] = []
  let textColor = "#000000"
  for (const sldId of kids(child(pres, "sldIdLst"), "sldId")) {
    const rid = attr(sldId, "r:id")
    const rel = rid ? rels.get(rid) : undefined
    if (!rel || rel.external) continue
    const parsed = await parseSlide(pkg, rel.target, width, height, mediaPaths)
    if (!slides.length) textColor = parsed.textColor
    slides.push(parsed.slide)
  }
  const media = await collectMedia(pkg, mediaPaths)
  return { kind: "pptx", slides, width, height, textColor, media }
}
