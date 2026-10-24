/**
 * convert/converters/md-to-pdf.js —— Markdown → PDF（A4，可选中复制、链接可点击）。
 *
 * 三段式：解析（markdown.js）→ 排版（pdf/layout.js）→ 写出（pdf/document.js）。
 * 字体走 pdf/font.js 的"系统字体优先 + data/fonts 兜底"策略。
 *
 * 没有中文字体时**拒绝转换而不是写字**：见 assertRenderable() 的说明。
 */
import { parseMarkdown } from "../markdown.js"
import { loadFont } from "../pdf/font.js"
import { layoutDocument } from "../pdf/layout.js"
import { buildPdf } from "../pdf/document.js"
import { TEXT_MAX_BYTES } from "./md-to-txt.js"

/**
 * 文档里出现了内置字体表示不了的字符吗？
 *
 * 退化字体（没有中文字体时的 Helvetica + WinAnsi）只能覆盖单字节字符，
 * 任何 U+0100 以上的码点都会变成 `?`。这个判断就是"会不会丢字"的分界线。
 */
export function needsCjkFont(text) {
  for (const ch of String(text ?? "")) {
    if (ch.codePointAt(0) > 0xff) return true
  }
  return false
}

/**
 * 转换前的最后一道门：字体排不了这些字就**报错**，不要交出一份内容已损坏的文件。
 *
 * 这与在线编辑保存时的做法完全一致（目标编码表示不了的字符一律拒绝保存，
 * 而不是悄悄写成 `?`）。用户看到的是一句能照做的提示，而不是一份全问号的 PDF。
 *
 * @param {string} text Markdown 正文
 * @param {object} font loadFont() 返回的 font 视图
 * @param {string} [reason] 找不到字体的原因（来自 loadFont）
 */
export function assertRenderable(text, font, reason) {
  if (font.ok || !needsCjkFont(text)) return
  const err = new Error(
    "服务器上没有可用的中文字体，无法生成含中文的 PDF。" +
      "请把任意 .ttf / .ttc 中文字体放进 data/fonts/ 目录（或用环境变量 CONVERT_PDF_FONT 指定路径）后重试" +
      (reason ? `。当前探测结果：${reason}` : "")
  )
  err.status = 501
  err.errorKey = "api.fs.convert_no_cjk_font"
  err.errorParams = { reason: reason || "-" }
  throw err
}

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
    assertRenderable(text, loaded.font, loaded.reason)

    const notes = []
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
