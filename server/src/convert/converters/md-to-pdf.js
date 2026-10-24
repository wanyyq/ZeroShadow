/**
 * convert/converters/md-to-pdf.js —— Markdown → PDF（A4，可选中复制、链接可点击、图片内嵌）。
 *
 * 三段式：解析（markdown.js）→ 排版（pdf/layout.js）→ 写出（pdf/document.js）。
 * 字体走 pdf/font.js 的"服主指定 → data/fonts → 系统字体"策略。
 *
 * **与预览保持一致**是硬要求（用户原话："PDF 和预览内容除了字体以外其他一模一样"）：
 * 解析规则直接对齐 `web/src/lib/markdown.ts`（软换行=空格、硬换行=<br>、`~~删除线~~`、
 * 白名单 HTML 标签、任务列表复选框），图片也真的嵌进 PDF —— 由
 * `scripts/markdown-parity-test.mjs` 逐块比对，防止以后改一处忘另一处。
 *
 * 没有中文字体时**拒绝转换而不是写字**：见 assertRenderable() 的说明。
 */
import fs from "node:fs"
import path from "node:path"
import { parseMarkdown } from "../markdown.js"
import { loadFont } from "../pdf/font.js"
import { layoutDocument } from "../pdf/layout.js"
import { buildPdf } from "../pdf/document.js"
import { prepareImage } from "../pdf/image.js"
import { TEXT_MAX_BYTES } from "./md-to-txt.js"

/** 单张图片的大小上限：转换是"顺手"操作，不该因为一张 200MB 的图把内存吃掉 */
const IMAGE_MAX_BYTES = 24 * 1024 * 1024
/** 一篇文档最多内嵌多少张图（再多就只保留占位文字，避免 PDF 大到不可用） */
const MAX_IMAGES = 60

/**
 * 收集文档里引用到的图片，按 `src` 加载成 PDF 图像对象。
 *
 * 路径解析与预览一致（`lib/markdown-urls.ts` 的思路）：相对 `.md` 所在目录，
 * 支持 `./` `../`；`http(s)://` 外链不下载（会变成一次不可控的外部请求），
 * 直接留占位文字 —— 与"离线可用、不外连"的项目原则一致。
 *
 * @param {Array<object>} blocks parseMarkdown 的结果
 * @param {{ dir?: string }} [options] `dir` 是 .md 所在的**绝对**目录
 * @returns {Promise<Map<string, object>>} src → PdfImage
 */
export async function loadImages(blocks, { dir } = {}) {
  const wanted = new Set()
  for (const block of blocks) {
    const lists = []
    if (block.inlines) lists.push(block.inlines)
    if (block.header) lists.push(block.header)
    for (const row of block.rows || []) lists.push(row.flat ? row.flat() : row)
    for (const list of lists) {
      for (const run of list || []) {
        if (run && run.image && run.src) wanted.add(run.src)
      }
    }
  }

  const out = new Map()
  if (!wanted.size || !dir) return out
  let count = 0
  for (const src of wanted) {
    if (count >= MAX_IMAGES) break
    if (/^(?:https?|data|ftp):/i.test(src)) continue
    const clean = src.split(/[?#]/)[0]
    if (!clean) continue
    const file = path.resolve(dir, clean)
    // 防目录穿越：只允许读 `.md` 同目录及其子目录里的文件
    const rel = path.relative(dir, file)
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue
    let stat
    try {
      stat = await fs.promises.stat(file)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > IMAGE_MAX_BYTES) continue
    try {
      const image = await prepareImage(await fs.promises.readFile(file))
      if (image) {
        out.set(src, image)
        count += 1
      }
    } catch {
      /* 单张图失败不该毁掉整篇转换 */
    }
  }
  return out
}

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
      "请在「设置 → 文件转换」里指定字体，或把任意 .ttf / .ttc / .otf 中文字体放进 data/fonts/ 目录" +
      "（也可用环境变量 CONVERT_PDF_FONT 指定路径）后重试" +
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
  async run({ text, name, onProgress, dir }) {
    onProgress?.(10)
    const blocks = parseMarkdown(text)
    onProgress?.(25)

    const loaded = await loadFont()
    assertRenderable(text, loaded.font, loaded.reason)
    onProgress?.(40)

    // 图片：预览里看得到的图，PDF 里也必须有
    const images = await loadImages(blocks, { dir })
    onProgress?.(55)

    const notes = []
    const title = (name || "").replace(/\.[^.]+$/, "") || "ZeroShadow 文档"
    const layout = layoutDocument({ blocks, font: loaded.font, fallbackTitle: title, images })
    onProgress?.(75)
    for (const warning of layout.warnings) notes.push(warning)

    const built = buildPdf({
      pages: layout.pages,
      font: loaded.font,
      title: layout.title || title,
      subject: "由 ZeroShadow 从 Markdown 转换",
      images: layout.images,
    })
    if (built.fontNote) notes.push(built.fontNote)
    onProgress?.(95)
    return { data: built.data, notes }
  },
}
