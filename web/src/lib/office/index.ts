/**
 * 浏览器端 Office 预览的解析入口
 *
 * 设计要点：**纯函数式**。输入是一个 ZIP 的字节，输出是与渲染无关的结构化数据
 * （段落 / 表格 / 单元格 / 幻灯片），文本一律留在字符串里、图片一律以包内路径 +
 * 字节表示。于是：
 *   - 可以在 Node 里单测（`scripts/office-preview-test.mjs`），不需要 DOM；
 *   - React 侧只做「数据 → 元素」，永远不会把文档内容拼进 HTML，
 *     因此没有任何 `dangerouslySetInnerHTML` / XSS 通道。
 *
 * 本文件被 `components/preview/office-preview.tsx` 动态 `import()`，
 * 打包后会独立成 chunk，不进首屏。
 */

import { OfficeError, isOfficeError, type OfficeErrorCode } from "./errors.ts"
import { openOfficePackage } from "./package.ts"
import { parseDocx, type DocxDocument } from "./docx.ts"
import { parseXlsx, type XlsxWorkbook } from "./xlsx.ts"
import { parsePptx, type PptxDeck } from "./pptx.ts"

export { OfficeError, isOfficeError }
export type { OfficeErrorCode }
export type {
  DocxBlock,
  DocxDocument,
  DocxImageRun,
  DocxListItem,
  DocxParagraph,
  DocxRun,
  DocxSpacing,
  DocxTable,
  DocxTableCell,
  DocxTextRun,
} from "./docx.ts"
export type { XlsxCell, XlsxRow, XlsxSheet, XlsxWorkbook } from "./xlsx.ts"
export type { PptxDeck, PptxParagraph, PptxRun, PptxShape, PptxSlide } from "./pptx.ts"
export type { MediaFile, MediaMap } from "./package.ts"

export type OfficeKind = "docx" | "xlsx" | "pptx"
export type OfficeDoc = DocxDocument | XlsxWorkbook | PptxDeck

/** 同结构 OOXML 容器一并认：`.docm/.dotx` 是 docx，`.xlsm/.xltx` 是 xlsx，`.pptm/.potx` 是 pptx */
const BY_EXT: Record<string, OfficeKind> = {
  docx: "docx",
  docm: "docx",
  dotx: "docx",
  dotm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  xltx: "xlsx",
  xltm: "xlsx",
  pptx: "pptx",
  pptm: "pptx",
  potx: "pptx",
  potm: "pptx",
}

/** 文件名 → 预览种类；不认识返回 null（`.doc/.xls/.ppt` 是二进制老格式，不在此列） */
export function officeKindOf(name: string): OfficeKind | null {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return null
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null
}

export async function parseOffice(bytes: Uint8Array, kind: OfficeKind): Promise<OfficeDoc> {
  if (!bytes || bytes.length === 0) throw new OfficeError("empty")
  try {
    const pkg = await openOfficePackage(bytes)
    if (kind === "docx") return await parseDocx(pkg)
    if (kind === "xlsx") {
      const workbook = await parseXlsx(pkg)
      if (!workbook.sheets.length) throw new OfficeError("unsupported")
      return workbook
    }
    const deck = await parsePptx(pkg)
    if (!deck.slides.length) throw new OfficeError("unsupported")
    return deck
  } catch (err) {
    if (isOfficeError(err)) throw err
    // 解析器内部的意外（缺部件、XML 截断）统一当成「结构损坏」，不把原始异常抛给界面
    throw new OfficeError("invalid")
  }
}
