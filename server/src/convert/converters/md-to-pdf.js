/**
 * convert/converters/md-to-pdf.js —— Markdown → PDF（A4，可选中复制、链接可点击）。
 *
 * 三段式：解析（markdown.js）→ 排版（pdf/layout.js）→ 写出（pdf/document.js）。
 * 字体走 pdf/font.js 的"系统字体优先 + data/fonts 兜底"策略，找不到中文字体时
 * **不失败**，而是生成一份中文变「?」的 PDF 并在 notes 里说明 —— 见 font.js 的理由。
 */
import { parseMarkdown } from "../markdown.js"
import { loadFont } from "../pdf/font.js"
import { layoutDocument } from "../pdf/layout.js"
import { buildPdf } from "../pdf/document.js"
import { TEXT_MAX_BYTES } from "./md-to-txt.js"

export const mdToPdf = {
  id: "md-to-pdf",
  from: ["md", "markdown", "mdown", "mkd"],
  to: "pdf",
  label: "Markdown → PDF",
  labelKey: "ui.convert.md_pdf",
  input: "text",
  maxBytes: TEXT_MAX_BYTES,
  async run({ text, name, onProgress }) {
    onProgress?.(10)
    const blocks = parseMarkdown(text)
    onProgress?.(25)

    const loaded = await loadFont()
    onProgress?.(45)
    const notes = []
    if (!loaded.ok) {
      notes.push(`没有找到可用的中文字体（${loaded.reason || "未知原因"}），中文会显示为「?」`)
    }

    const title = (name || "").replace(/\.[^.]+$/, "") || "ZeroShadow 文档"
    const layout = layoutDocument({ blocks, font: loaded.font, fallbackTitle: title })
    onProgress?.(75)
    for (const warning of layout.warnings) notes.push(warning)

    const buffer = buildPdf({
      pages: layout.pages,
      font: loaded.font,
      title: layout.title || title,
      subject: "由 ZeroShadow 从 Markdown 转换",
    })
    onProgress?.(95)
    return { data: buffer, notes }
  },
}
