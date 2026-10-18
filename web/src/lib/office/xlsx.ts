/**
 * XLSX 解析：SpreadsheetML → 工作簿结构
 *
 * 覆盖：多工作表（顺序按 workbook.xml 的 `<sheet>`）、共享字符串（`<si>` 内多个 `<r><t>`）、
 * 内联字符串 / 数字 / 布尔 / 错误值、公式的缓存值（`<v>`，原文进 `formula` 供 title 显示）、
 * 合并单元格、列宽、日期与百分比数字格式。
 *
 * 合并格的表达方式：主格带 `colSpan` / `rowSpan`，被覆盖的格直接删掉（渲染成 `null`），
 * 渲染侧只要跳过 `null`，配合 `colspan/rowspan` 就能得到正确网格 —— 不需要占位行。
 */

import { collectMedia, readRels, type MediaMap, type OfficePackage } from "./package.ts"
import { attr, boolProp, child, kids, localName, numAttr, type XmlNode } from "./xml.ts"

export interface XlsxCell {
  /** 显示文本（已按数字格式转好） */
  text: string
  /** 公式原文，例如 `SUM(A1:A2)`；没有公式时省略 */
  formula?: string
  colSpan?: number
  rowSpan?: number
  /** 数值/日期/百分比右对齐，文本左对齐（Excel 的默认观感） */
  numeric?: boolean
  bold?: boolean
  italic?: boolean
  /** 字体颜色与单元格填充（`#rrggbb`） */
  color?: string
  fill?: string
  align?: "left" | "center" | "right"
  /** 自动换行 */
  wrap?: boolean
}

export interface XlsxRow {
  /** 下标即列号；`null` 表示空位或被合并覆盖的格 */
  cells: (XlsxCell | null)[]
  /** 行高（像素，来自 row/@ht） */
  height?: number
}

export interface XlsxSheet {
  name: string
  /** 每列像素宽（与 `rows[i].cells` 的列号对齐） */
  cols: number[]
  rows: XlsxRow[]
  /** 行列数超过预览上限，只渲染了前一部分 */
  truncated: boolean
}

export interface XlsxWorkbook {
  kind: "xlsx"
  sheets: XlsxSheet[]
  media: MediaMap
}

const DEFAULT_COL_WIDTH = 80
const MIN_COL_WIDTH = 28
const MAX_COL_WIDTH = 420
const MAX_ROWS = 400
const MAX_COLS = 60

/** `A1` → 列号（0 起）；非法引用返回 -1 */
export function columnIndex(ref: string): number {
  let n = 0
  let seen = false
  for (const ch of ref) {
    const code = ch.charCodeAt(0)
    if (code >= 65 && code <= 90) {
      n = n * 26 + (code - 64)
      seen = true
    } else if (code >= 97 && code <= 122) {
      n = n * 26 + (code - 96)
      seen = true
    } else {
      break
    }
  }
  return seen ? n - 1 : -1
}

function rowIndexOf(ref: string): number {
  const digits = ref.replace(/[^0-9]/g, "")
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) && n > 0 ? n - 1 : -1
}

/** 共享字符串项：`<si>` 直属的 `<t>` 与 `<r>` 里的 `<t>` 都要，跳过拼音注音 */
function sharedItemText(si: XmlNode): string {
  let out = ""
  for (const node of si.children) {
    const name = localName(node.name)
    if (name === "t") out += node.text
    else if (name === "r") for (const t of kids(node, "t")) out += t.text
  }
  return out
}

/** `numFmtId` + 自定义 formatCode → 显示文本 */
function isDateFormat(numFmtId: number, code: string | undefined): boolean {
  if ((numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47)) return true
  if (!code) return false
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "")
  return /[ymdhs]/i.test(bare)
}

function decimalsOf(code: string | undefined): number | undefined {
  if (!code) return undefined
  const m = /\.(0+)/.exec(code)
  if (m) return m[1].length
  return undefined
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Excel 序列号（1899-12-30 纪元）→ `YYYY-MM-DD`（必要时带时间） */
function formatSerial(serial: number, withTime: boolean, date1904 = false): string {
  const whole = Math.floor(serial)
  const frac = serial - whole
  // 1904 纪元（Mac 版 Excel 的旧默认）比 1900 纪元晚 1462 天
  const dayMs = Math.round((whole + (date1904 ? 1462 : 0) - 25569) * 86400000)
  const timeMs = Math.round(frac * 86400000)
  const date = new Date(dayMs + timeMs)
  if (Number.isNaN(date.getTime())) return String(serial)
  const time = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
  // 纯时间（序列号 < 1）不要凭空造出 1899-12-30；1904 纪元里 0 是 1904-01-01
  if (whole === 0 && !date1904) return time
  const day = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
  return withTime ? `${day} ${time}` : day
}

/** 内置日期/时间格式里带时间的那些（14–17 是纯日期） */
const BUILTIN_TIME = new Set([18, 19, 20, 21, 22, 45, 46, 47])

function formatNumber(value: number, numFmtId: number, code: string | undefined, date1904: boolean): string {
  if (isDateFormat(numFmtId, code)) {
    const withTime = code
      ? /[hs]/i.test(code.replace(/"[^"]*"/g, ""))
      : BUILTIN_TIME.has(numFmtId)
    return formatSerial(value, withTime, date1904)
  }
  if ((code && code.includes("%")) || numFmtId === 9 || numFmtId === 10) {
    const decimals = decimalsOf(code) ?? (numFmtId === 10 ? 2 : 0)
    return `${(value * 100).toFixed(decimals)}%`
  }
  const decimals = decimalsOf(code)
  if (decimals !== undefined) return value.toFixed(Math.min(decimals, 10))
  // 内置 1/3 是整数格式，2/4 是两位小数；其余（含 General）交给 JS 的最短表示
  if (numFmtId === 1 || numFmtId === 3) return String(Math.round(value))
  if (numFmtId === 2 || numFmtId === 4) return value.toFixed(2)
  // General：Excel 最多显示 11 位有效数字，直接 String() 会把 0.1+0.2 之类
  // 二进制误差原样吐出来（0.30000000000000004），看起来像算错了。
  if (!Number.isInteger(value)) return String(Number(value.toPrecision(12)))
  return String(value)
}

interface FontInfo {
  bold?: boolean
  italic?: boolean
  color?: string
}

interface FormatInfo {
  id: number
  code?: string
  font?: FontInfo
  /** 单元格填充色（`#rrggbb`） */
  fill?: string
  align?: "left" | "center" | "right"
  wrap?: boolean
}

/** ARGB（`FFRRGGBB`）或 RGB（`RRGGBB`）→ `#rrggbb` */
function argbToHex(value: string | undefined): string | undefined {
  if (!value) return undefined
  const hex = value.replace(/^#/, "")
  if (hex.length === 8) return `#${hex.slice(2).toLowerCase()}`
  if (hex.length === 6) return `#${hex.toLowerCase()}`
  return undefined
}

function parseStyles(root: XmlNode | undefined): FormatInfo[] {
  const out: FormatInfo[] = []
  if (!root) return out
  const custom = new Map<number, string>()
  const numFmts = child(root, "numFmts")
  for (const fmt of kids(numFmts, "numFmt")) {
    const id = numAttr(fmt, "numFmtId")
    const code = attr(fmt, "formatCode")
    if (id !== undefined && code) custom.set(id, code)
  }

  const fonts: FontInfo[] = kids(child(root, "fonts"), "font").map((font) => {
    const info: FontInfo = {}
    if (boolProp(child(font, "b"))) info.bold = true
    if (boolProp(child(font, "i"))) info.italic = true
    const color = argbToHex(attr(child(font, "color"), "rgb"))
    if (color) info.color = color
    return info
  })

  const fills: (string | undefined)[] = kids(child(root, "fills"), "fill").map((fill) => {
    const pattern = child(fill, "patternFill")
    const fg = attr(child(pattern, "fgColor"), "rgb") ?? attr(child(pattern, "fgColor"), "theme")
    // Excel 的 0/1 号填充是 none / gray125，不能当用户设置的底色
    if (!fg) return undefined
    return argbToHex(fg)
  })

  const xfs = kids(child(root, "cellXfs"), "xf")
  for (const xf of xfs) {
    const id = numAttr(xf, "numFmtId") ?? 0
    const fontId = numAttr(xf, "fontId")
    const fillId = numAttr(xf, "fillId")
    const alignment = child(xf, "alignment")
    const alignRaw = attr(alignment, "horizontal")
    const align =
      alignRaw === "center" || alignRaw === "centerContinuous"
        ? "center"
        : alignRaw === "right"
          ? "right"
          : alignRaw === "left"
            ? "left"
            : undefined
    out.push({
      id,
      code: custom.get(id),
      font: fontId !== undefined ? fonts[fontId] : undefined,
      fill: fillId !== undefined ? fills[fillId] : undefined,
      align,
      wrap: alignment
        ? ["1", "true"].includes((attr(alignment, "wrapText") ?? "").toLowerCase())
        : false,
    })
  }
  return out
}

function cellFrom(
  node: XmlNode,
  shared: string[],
  formats: FormatInfo[],
  date1904: boolean
): XlsxCell | undefined {
  const type = attr(node, "t") ?? "n"
  const formulaNode = child(node, "f")
  const formula = formulaNode?.text || undefined
  const valueNode = child(node, "v")
  const raw = valueNode?.text ?? ""
  const styleIndex = numAttr(node, "s")
  const format = styleIndex !== undefined ? formats[styleIndex] : undefined
  const numFmtId = format?.id ?? 0

  let text = ""
  let numeric = false

  if (type === "s") {
    const index = Number.parseInt(raw, 10)
    text = Number.isFinite(index) ? shared[index] ?? "" : ""
  } else if (type === "inlineStr") {
    const is = child(node, "is")
    text = is ? sharedItemText(is) : ""
  } else if (type === "str") {
    text = raw
  } else if (type === "b") {
    text = raw === "1" || raw.toLowerCase() === "true" ? "TRUE" : "FALSE"
  } else if (type === "e") {
    text = raw || "#ERR"
  } else if (type === "d") {
    text = raw
  } else if (raw !== "") {
    const value = Number(raw)
    if (Number.isFinite(value)) {
      text = formatNumber(value, numFmtId, format?.code, date1904)
      // 日期/百分比同样按「数字」右对齐
      numeric = true
    } else {
      text = raw
    }
  }

  if (!text && !formula) return undefined
  const cell: XlsxCell = { text }
  if (formula) cell.formula = formula
  if (numeric) cell.numeric = true
  if (format?.font?.bold) cell.bold = true
  if (format?.font?.italic) cell.italic = true
  if (format?.font?.color) cell.color = format.font.color
  if (format?.fill) cell.fill = format.fill
  if (format?.align) cell.align = format.align
  if (format?.wrap) cell.wrap = true
  return cell
}

interface Merge {
  r1: number
  c1: number
  r2: number
  c2: number
}

function parseMerges(root: XmlNode): Merge[] {
  const out: Merge[] = []
  for (const node of kids(child(root, "mergeCells"), "mergeCell")) {
    const ref = attr(node, "ref")
    if (!ref) continue
    const [from, to] = ref.split(":")
    if (!from || !to) continue
    const r1 = rowIndexOf(from)
    const c1 = columnIndex(from)
    const r2 = rowIndexOf(to)
    const c2 = columnIndex(to)
    if (r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1) continue
    out.push({ r1, c1, r2, c2 })
  }
  return out
}

function parseColWidths(root: XmlNode, maxCol: number): number[] {
  const widths: number[] = []
  for (const col of kids(child(root, "cols"), "col")) {
    const width = numAttr(col, "width")
    if (!width || width <= 0) continue
    const min = Math.max(0, (numAttr(col, "min") ?? 1) - 1)
    const max = Math.min(maxCol, (numAttr(col, "max") ?? min + 1) - 1)
    // Excel 的宽度单位是「字符数」：约 7px/字符 + 5px 内边距
    const px = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width * 7 + 5)))
    for (let i = min; i <= max; i++) widths[i] = px
  }
  return widths
}

interface SheetRef {
  name: string
  path: string
}

async function readSheetRefs(pkg: OfficePackage): Promise<SheetRef[]> {
  const workbook = await pkg.xml("xl/workbook.xml")
  if (!workbook) return []
  const rels = await readRels(pkg, "xl/workbook.xml")
  const out: SheetRef[] = []
  for (const sheet of kids(child(workbook, "sheets"), "sheet")) {
    // 隐藏工作表不显示（Excel 的标签栏里也看不到）；如果全部隐藏，调用方会当成不支持
    const state = (attr(sheet, "state") ?? "visible").toLowerCase()
    if (state === "hidden" || state === "veryhidden") continue
    const name = attr(sheet, "name") ?? ""
    const rid = attr(sheet, "r:id") ?? attr(sheet, "id")
    const target = rid ? rels.get(rid) : undefined
    if (!target || target.external) continue
    out.push({ name, path: target.target })
  }
  return out
}

async function parseSheet(
  pkg: OfficePackage,
  ref: SheetRef,
  shared: string[],
  formats: FormatInfo[],
  date1904: boolean
): Promise<XlsxSheet> {
  const root = await pkg.xml(ref.path)
  if (!root) return { name: ref.name, cols: [DEFAULT_COL_WIDTH], rows: [], truncated: false }
  const sheetData = child(root, "sheetData")
  const grid = new Map<number, Map<number, XlsxCell>>()
  const heights = new Map<number, number>()
  let lastRow = -1
  let lastCol = -1
  let truncated = false

  if (sheetData) {
    let rowCursor = -1
    for (const rowNode of kids(sheetData, "row")) {
      const explicitRow = numAttr(rowNode, "r")
      const rowIndex = explicitRow !== undefined && explicitRow > 0 ? explicitRow - 1 : rowCursor + 1
      rowCursor = rowIndex
      // row/@ht 是磅值（1 磅 = 4/3 像素）
      const ht = numAttr(rowNode, "ht")
      if (ht && ht > 0 && rowIndex < MAX_ROWS) heights.set(rowIndex, Math.round((ht * 4) / 3))
      let colCursor = -1
      const rowMap = new Map<number, XlsxCell>()
      for (const cellNode of kids(rowNode, "c")) {
        const cellRef = attr(cellNode, "r")
        const col = cellRef ? columnIndex(cellRef) : colCursor + 1
        colCursor = col
        if (col < 0) continue
        if (col >= MAX_COLS || rowIndex >= MAX_ROWS) {
          truncated = true
          continue
        }
        const cell = cellFrom(cellNode, shared, formats, date1904)
        if (!cell) continue
        rowMap.set(col, cell)
        if (col > lastCol) lastCol = col
      }
      if (rowMap.size) {
        grid.set(rowIndex, rowMap)
        if (rowIndex > lastRow) lastRow = rowIndex
      }
    }
  }

  // 合并格：主格加 span，被覆盖的格删掉（越界的合并直接忽略）
  for (const merge of parseMerges(root)) {
    if (merge.r1 >= MAX_ROWS || merge.c1 >= MAX_COLS) {
      truncated = true
      continue
    }
    const r2 = Math.min(merge.r2, MAX_ROWS - 1)
    const c2 = Math.min(merge.c2, MAX_COLS - 1)
    let rowMap = grid.get(merge.r1)
    if (!rowMap) {
      rowMap = new Map()
      grid.set(merge.r1, rowMap)
      if (merge.r1 > lastRow) lastRow = merge.r1
    }
    const master = rowMap.get(merge.c1) ?? { text: "" }
    master.colSpan = c2 - merge.c1 + 1
    master.rowSpan = r2 - merge.r1 + 1
    rowMap.set(merge.c1, master)
    if (c2 > lastCol) lastCol = c2
    for (let r = merge.r1; r <= r2; r++) {
      const row = grid.get(r)
      if (!row) continue
      for (let c = merge.c1; c <= c2; c++) {
        if (r === merge.r1 && c === merge.c1) continue
        row.delete(c)
      }
      if (!row.size && r !== merge.r1) grid.delete(r)
    }
  }

  const colCount = Math.min(Math.max(lastCol + 1, 1), MAX_COLS)
  const srcWidths = parseColWidths(root, colCount - 1)
  const cols: number[] = []
  for (let i = 0; i < colCount; i++) cols.push(srcWidths[i] ?? DEFAULT_COL_WIDTH)

  const rows: XlsxRow[] = []
  const rowCount = Math.min(lastRow + 1, MAX_ROWS)
  for (let r = 0; r < rowCount; r++) {
    const rowMap = grid.get(r)
    const cells: (XlsxCell | null)[] = []
    for (let c = 0; c < colCount; c++) cells.push(rowMap?.get(c) ?? null)
    const height = heights.get(r)
    rows.push(height ? { cells, height } : { cells })
  }

  return { name: ref.name, cols, rows, truncated }
}

export async function parseXlsx(pkg: OfficePackage): Promise<XlsxWorkbook> {
  const styles = await pkg.xml("xl/styles.xml")
  const formats = parseStyles(styles ?? undefined)

  const shared: string[] = []
  const sst = await pkg.xml("xl/sharedStrings.xml")
  if (sst) for (const si of kids(sst, "si")) shared.push(sharedItemText(si))

  const refs = await readSheetRefs(pkg)
  // 1904 纪元（Mac 版 Excel 的旧默认）会让所有日期差 4 年，必须按 workbookPr 判定
  const workbook = await pkg.xml("xl/workbook.xml")
  const date1904 = ["1", "true"].includes((attr(child(workbook, "workbookPr"), "date1904") ?? "").toLowerCase())
  const sheets: XlsxSheet[] = []
  for (const ref of refs) sheets.push(await parseSheet(pkg, ref, shared, formats, date1904))

  const media = await collectMedia(pkg, [])
  return { kind: "xlsx", sheets, media }
}
