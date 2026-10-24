/**
 * convert/converters/md-to-txt.js —— Markdown → 纯文本。
 *
 * 目标是"用记事本打开也能读"：所有 Markdown 标记都去掉，但层级感要保留
 * （标题独立成行、列表带 - / 1. 前缀、引用带 > 前缀、代码块缩进四格原样保留）。
 * 细节见 markdown.js 的 toPlainText()。
 *
 * 换行风格跟随源文件：源文件是 CRLF 就输出 CRLF —— 从 Windows 上拷下来的笔记
 * 转完还是 Windows 的换行，不会被记事本显示成一整行。
 */
import { parseMarkdown, toPlainText } from "../markdown.js"

/** 文本类转换的源文件上限：再大的 Markdown 已经不像"文档"了（编辑器上限是 8MB） */
export const TEXT_MAX_BYTES = 4 * 1024 * 1024

export const mdToTxt = {
  id: "md-to-txt",
  from: ["md", "markdown", "mdown", "mkd"],
  to: "txt",
  label: "Markdown → 纯文本",
  labelKey: "ui.convert.md_txt",
  input: "text",
  maxBytes: TEXT_MAX_BYTES,
  run({ text, eol }) {
    const body = toPlainText(parseMarkdown(text))
    const normalized = eol === "crlf" ? body.replace(/\n/g, "\r\n") : eol === "cr" ? body.replace(/\n/g, "\r") : body
    return { data: Buffer.from(normalized, "utf8") }
  },
}
