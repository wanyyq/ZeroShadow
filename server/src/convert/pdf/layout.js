/**
 * convert/pdf/layout.js —— 把 markdown.js 的块列表排成 PDF 页面。
 *
 * 排版目标不是"像素级还原 Markdown 阅读器"，而是**一份打印出来能读、复制出来是原文**
 * 的 PDF：层级用字号/缩进体现，代码块有底色，表格有细边框，链接带下划线且可点击。
 *
 * 所有宽度计算都走 font.measure()（单位 1/1000 em），所以中文（全角）与英文（半角）
 * 混排时不会被拉成"两行字间距不同的"怪样子。
 *
 * 断行规则（贴合中文写作习惯）：
 *   - 全角字符之间**任意位置可断**；
 *   - 半角单词不拆开，只在空格 / 连字符后断；
 *   - 代码块按字符断（程序员本来就接受这一点）；
 *   - 行首不保留空格。
 */
import { isWideChar, inlineToText } from "../markdown.js"

/** A4（单位 pt，1pt = 1/72 inch）；20mm 边距是打印与屏幕阅读都比较舒服的取值 */
export const PAGE_WIDTH = 595.276
export const PAGE_HEIGHT = 841.89
const MARGIN_X = 56.7
const MARGIN_TOP = 56.7
const MARGIN_BOTTOM = 56.7
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
/** 防御性上限：再长的文档也不该把内存吃光（超出部分截断并给出警告） */
const MAX_PAGES = 400

const BASE_SIZE = 10.5
const HEADING_SIZE = [22, 17.5, 15, 13.5, 12, 11]
const CODE_SIZE = 9.5
const TABLE_SIZE = 9.5
const LINE_FACTOR = 1.62
const COLOR_TEXT = [0.12, 0.12, 0.12]
const COLOR_MUTED = [0.42, 0.42, 0.42]
const COLOR_RULE = [0.72, 0.72, 0.72]
const COLOR_CODE_BG = [0.955, 0.955, 0.955]
const COLOR_QUOTE_BAR = [0.8, 0.8, 0.8]

/**
 * 把一块行的 run 列表按宽度折行。
 * @param {Array<object>} runs markdown.js 的行内 run
 * @param {number} maxWidth 可用的行宽（pt）
 * @param {number} size 字号
 * @param {object} font 度量视图
 * @param {{ breakAnywhere?: boolean }} [options]
 * @returns {Array<Array<object>>} 每行一组 { text, width, bold, italic, code, link }
 */
export function wrapRuns(runs, maxWidth, size, font, { breakAnywhere = false } = {}) {
  const lines = []
  let line = []
  let lineWidth = 0
  const scale = size / 1000
  const measure = (text) => font.measure(text) * scale

  const commit = () => {
    // 去掉行尾空白再收行
    while (line.length) {
      const last = line[line.length - 1]
      if (last.text === " " || last.text === "") {
        lineWidth -= last.width
        line.pop()
        continue
      }
      break
    }
    lines.push(line)
    line = []
    lineWidth = 0
  }

  const addPiece = (piece, style) => {
    const width = measure(piece.text)
    if (lineWidth + width > maxWidth && line.length) commit()
    // 行首空格没有意义
    if (!line.length && piece.text === " ") return
    const last = line[line.length - 1]
    if (
      last &&
      !style.link &&
      !last.link &&
      !!last.bold === !!style.bold &&
      !!last.italic === !!style.italic &&
      !!last.code === !!style.code &&
      !!last.strike === !!style.strike
    ) {
      last.text += piece.text
      last.width += width
    } else {
      // 必须把 style 一起带进来：链接矩形 / 粗体 / 斜体都是按 piece 上的标记画的
      line.push({ ...piece, ...style, width })
    }
    lineWidth += width
  }

  for (const run of runs) {
    // 硬换行（预览里是 <br />）：直接收行，后续内容从新行开始
    if (run.br) {
      commit()
      continue
    }
    const style = {
      bold: !!run.bold,
      italic: !!run.italic,
      code: !!run.code,
      strike: !!run.strike,
      link: run.link,
    }
    const text = run.image ? `[图片: ${run.text}]` : run.text
    if (breakAnywhere) {
      // 代码块：逐字符可断
      for (const ch of text) addPiece({ text: ch }, style)
      continue
    }
    // 普通文本：把字符串切成"不可再拆"的原子（全角单字 / 半角单词 / 空白）
    let buffer = ""
    const flushBuffer = () => {
      if (buffer) {
        addPiece({ text: buffer }, style)
        buffer = ""
      }
    }
    for (const ch of text) {
      if (ch === " ") {
        flushBuffer()
        addPiece({ text: " " }, style)
        continue
      }
      if (isWideChar(ch)) {
        flushBuffer()
        addPiece({ text: ch }, style)
        continue
      }
      buffer += ch
    }
    flushBuffer()
  }

  if (line.length) commit()
  if (!lines.length) lines.push([])
  return lines
}

/**
 * 排版主流程。
 *
 * @param {object} options
 * @param {Array<object>} options.blocks parseMarkdown 的结果
 * @param {object} options.font loadFont() 的 font 视图
 * @param {string} [options.fallbackTitle]
 * @param {Map<string, object>} [options.images] 图片注册表（src → PdfImage），见 pdf/image.js
 * @returns {{ pages: Array<object>, pageCount: number, warnings: string[], title: string, images: Map<string,object> }}
 */
export function layoutDocument({ blocks, font, fallbackTitle, images }) {
  const pages = []
  const warnings = []
  let page = null
  let y = 0
  let title = fallbackTitle || ""

  /** 图片 XObject 的名字（同一张图只登记一次，多个页面共用同一个对象） */
  const imageNames = new Map()
  /** 真正写进 PDF 的图片（name → PdfImage） */
  const usedImages = new Map()
  let imageSeq = 0

  const startPage = () => {
    page = { width: PAGE_WIDTH, height: PAGE_HEIGHT, ops: [], links: [], imageNames: new Set() }
    pages.push(page)
    y = PAGE_HEIGHT - MARGIN_TOP
  }
  const ensure = (height) => {
    if (!page) startPage()
    if (y - height < MARGIN_BOTTOM) {
      if (pages.length >= MAX_PAGES) return false
      startPage()
    }
    return true
  }

  /**
   * 画一张图（预览里是 <img>，所以 PDF 里也必须有图，不能只留一行占位文字）。
   *
   * 尺寸：按 96dpi 折算（1px ≈ 0.75pt），最宽不超过版心；图太高就等比缩到整页高度以内。
   * 找不到图（文件缺失、格式不支持、超过像素上限）时退化成 `[图片: alt]` 一行文字 ——
   * 与老行为一致，至少不会凭空少一块。
   */
  const drawImage = (run, x = MARGIN_X) => {
    const image = images?.get(run.src)
    const fallback = () => {
      drawParagraph([{ text: `[图片: ${run.text || run.src}]` }], { x })
    }
    if (!image) {
      fallback()
      return
    }
    const maxWidth = PAGE_WIDTH - MARGIN_X - x
    let width = Math.min(maxWidth, image.width * 0.75)
    let height = width / image.aspect
    const maxHeight = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM - 12
    if (height > maxHeight) {
      height = maxHeight
      width = height * image.aspect
    }
    if (!ensure(height + 8)) return
    let name = imageNames.get(run.src)
    if (!name) {
      imageSeq += 1
      name = `Im${imageSeq}`
      imageNames.set(run.src, name)
      usedImages.set(name, image)
    }
    const bottom = y - height
    page.ops.push({ t: "image", name, x, y: bottom, w: width, h: height })
    page.imageNames.add(name)
    y = bottom - 8
  }

  /** 画一行文本（含链接矩形、删除线、下划线） */
  const drawLine = (line, { x, size, color = COLOR_TEXT, underlineLinks = true }) => {
    if (!line.length) {
      y -= size * LINE_FACTOR
      return
    }
    const runs = []
    let cursor = x
    const links = []
    const strikes = []
    for (const piece of line) {
      const { hex } = font.encode(piece.text)
      runs.push({
        x: cursor,
        hex,
        bold: !!piece.bold,
        italic: !!piece.italic,
        width: piece.width,
      })
      // ~~删除线~~：预览是 <del>（一条穿过的横线），这里也画一条
      if (piece.strike) {
        const last = strikes[strikes.length - 1]
        if (last && Math.abs(last.x2 - cursor) < 0.01) last.x2 = cursor + piece.width
        else strikes.push({ x1: cursor, x2: cursor + piece.width })
      }
      if (piece.link) {
        const last = links[links.length - 1]
        if (last && last.url === piece.link && Math.abs(last.x2 - cursor) < 0.01) {
          last.x2 = cursor + piece.width
        } else {
          links.push({ url: piece.link, x1: cursor, x2: cursor + piece.width })
        }
      }
      cursor += piece.width
    }
    const baseline = y - size * 0.28
    page.ops.push({ t: "text", x, y: baseline, size, runs, color })
    for (const strike of strikes) {
      page.ops.push({
        t: "line",
        x1: strike.x1,
        y1: baseline + size * 0.3,
        x2: strike.x2,
        y2: baseline + size * 0.3,
        width: size * 0.06,
        color,
      })
    }
    if (underlineLinks) {
      for (const link of links) {
        page.ops.push({
          t: "line",
          x1: link.x1,
          y1: baseline - size * 0.12,
          x2: link.x2,
          y2: baseline - size * 0.12,
          width: 0.5,
          color: [0.25, 0.4, 0.85],
        })
        page.links.push({
          url: link.url,
          rect: [link.x1, baseline - size * 0.25, link.x2, baseline + size],
        })
      }
    }
    y -= size * LINE_FACTOR
  }

  /** 画一段（或一个列表项）：先折行，再逐行输出，必要时翻页 */
  const drawParagraph = (runs, { x = MARGIN_X, size = BASE_SIZE, color = COLOR_TEXT, lineFactor = LINE_FACTOR, spaceAfter = 0 } = {}) => {
    const width = PAGE_WIDTH - MARGIN_X - x
    const lines = wrapRuns(runs, width, size, font)
    for (const line of lines) {
      if (!ensure(size * lineFactor)) return
      drawLine(line, { x, size, color })
    }
    y -= spaceAfter
  }

  /**
   * 画"可能夹着图片"的一段：把行内 run 按图片切成若干文字段 + 若干个图片块。
   *
   * 为什么不在 wrapRuns 里处理图片：图片的行高与基线规则和文字完全不同（要预留
   * 整块高度、要按比例缩放、可能要翻页），混在折行逻辑里会把那段本来读得懂的代码
   * 变成一团。切分之后两边各自简单。
   */
  const drawRunsWithImages = (runs, { x = MARGIN_X, color = COLOR_TEXT, spaceAfter = 0 } = {}) => {
    let buffer = []
    const flushText = () => {
      // 只有换行 run 也交出去（它会推进一行，与预览里的空 <br> 一致）
      if (buffer.length && buffer.some((r) => r.br || (r.text && r.text.trim()))) {
        drawParagraph(buffer, { x, color })
      }
      buffer = []
    }
    for (const run of runs) {
      if (run.image) {
        flushText()
        drawImage(run, x)
        continue
      }
      buffer.push(run)
    }
    flushText()
    y -= spaceAfter
  }

  const drawHeading = (block) => {
    const size = HEADING_SIZE[Math.min(block.level, 6) - 1] || BASE_SIZE
    const inlines = block.inlines.map((run) => ({ ...run, bold: true }))
    const text = inlineToText(inlines, { keepUrl: false })
    if (!title && block.level === 1) title = text
    const lines = wrapRuns(inlines, CONTENT_WIDTH, size, font)
    // 标题不要孤零零留在页脚：至少给它两行的空间
    if (!ensure(size * LINE_FACTOR * Math.min(lines.length, 2) + size * 0.6)) return
    const pageAtStart = page
    y -= block.level <= 2 ? size * 0.45 : size * 0.3
    for (const line of lines) {
      if (!ensure(size * LINE_FACTOR)) return
      drawLine(line, { x: MARGIN_X, size, color: [0.07, 0.07, 0.07] })
    }
    if (block.level <= 2 && page === pageAtStart) {
      // 一、二级标题下面加一条细线，视觉上比单纯加粗更清楚
      if (page) {
        page.ops.push({
          t: "line",
          x1: MARGIN_X,
          y1: y + size * 0.34,
          x2: PAGE_WIDTH - MARGIN_X,
          y2: y + size * 0.34,
          width: block.level === 1 ? 0.9 : 0.5,
          color: COLOR_RULE,
        })
      }
    }
    y -= size * 0.55
  }

  const drawCode = (block) => {
    const lines = []
    for (const raw of block.text.split("\n")) {
      const wrapped = wrapRuns([{ text: raw || " " }], CONTENT_WIDTH - 16, CODE_SIZE, font, {
        breakAnywhere: true,
      })
      lines.push(...wrapped)
    }
    // 空代码块也要占一点高度，否则围栏里什么都没写时看不出这里曾经有块代码
    if (!lines.length) lines.push([])
    const lineHeight = CODE_SIZE * 1.45
    const padding = 6
    let index = 0
    while (index < lines.length) {
      const available = Math.floor((y - MARGIN_BOTTOM) / lineHeight)
      if (available <= 0) {
        if (!ensure(lineHeight)) return
        continue
      }
      const take = Math.max(1, Math.min(available, lines.length - index))
      const blockHeight = take * lineHeight + padding * 2
      // 底色按"这一页能放下的一段"画，跨页时自然分成两块
      page.ops.push({
        t: "rect",
        x: MARGIN_X,
        y: y - blockHeight + padding,
        w: CONTENT_WIDTH,
        h: blockHeight,
        fill: COLOR_CODE_BG,
      })
      y -= padding
      for (let k = 0; k < take; k += 1) {
        // 注意用 lines[index] 而不是 lines[index + k]：index 在这里会自增，
        // 两者相加会跳着取行（代码块末尾会读到 undefined）
        drawLine(lines[index], { x: MARGIN_X + 8, size: CODE_SIZE, color: [0.2, 0.2, 0.2] })
        index += 1
      }
      y -= padding + 4
      if (index < lines.length && !ensure(lineHeight)) return
    }
    y -= 2
  }

  const drawList = (block) => {
    let counter = block.start || 1
    for (const item of block.items) {
      const level = item.level || 0
      const x = MARGIN_X + level * 18
      const markerWidth = 18
      const isTask = item.task !== null && item.task !== undefined
      const markerText = block.ordered ? `${counter}.` : "•"
      if (block.ordered && level === 0) counter += 1
      // 任务列表的方框占位：文字从 marker 之后开始，方框在 marker 的位置上画
      const runs = item.inlines
      const lines = wrapRuns(runs, CONTENT_WIDTH - (x - MARGIN_X) - markerWidth, BASE_SIZE, font)
      const lineHeight = BASE_SIZE * LINE_FACTOR
      if (!ensure(lineHeight * Math.min(lines.length, 2))) return
      // 项目符号对齐首行基线
      const size = BASE_SIZE
      const baseline = y - size * 0.28
      if (isTask) {
        pushTaskBox(page, taskBoxGeometry(x + 1, baseline - size * 0.05, size, !!item.task))
      } else {
        const marker = font.encode(markerText)
        page.ops.push({
          t: "text",
          x,
          y: baseline,
          size,
          runs: [{ x, hex: marker.hex, width: marker.width * (size / 1000), bold: false, italic: false }],
          color: COLOR_MUTED,
        })
      }
      let first = true
      for (const line of lines) {
        if (!first) {
          if (!ensure(lineHeight)) return
        }
        drawLine(line, { x: x + markerWidth, size })
        first = false
      }
      y -= BASE_SIZE * 0.18
    }
    y -= BASE_SIZE * 0.35
  }

  const drawQuote = (block) => {
    const startY = y
    const pageBefore = page
    const opIndexBefore = page.ops.length
    for (const child of block.blocks) drawBlock(child, { quote: true })
    // 竖条只在这一段没有跨页时才补：跨页时 startY / y 属于两页，硬画会串页
    if (page === pageBefore && y < startY && page.ops.length > opIndexBefore) {
      page.ops.splice(opIndexBefore, 0, {
        t: "rect",
        x: MARGIN_X - 10,
        y: y + 4,
        w: 2.5,
        h: startY - y - 2,
        fill: COLOR_QUOTE_BAR,
      })
    }
  }

  const drawTable = (block) => {
    const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1)
    // 先量每一列的自然宽度（表头与所有单元格取最大），再按可用宽度等比缩放
    const natural = new Array(columns).fill(24)
    const measureRow = (cells) => {
      for (let c = 0; c < columns; c += 1) {
        const text = inlineToText(cells[c] ?? [], { keepUrl: false })
        const width = (font.measure(text) / 1000) * TABLE_SIZE + 12
        natural[c] = Math.min(Math.max(natural[c], width), CONTENT_WIDTH * 0.6)
      }
    }
    measureRow(block.header)
    for (const row of block.rows) measureRow(row)
    const total = natural.reduce((a, b) => a + b, 0)
    const scale = total > CONTENT_WIDTH ? CONTENT_WIDTH / total : 1
    const widths = natural.map((w) => w * scale)
    const lineHeight = TABLE_SIZE * 1.5

    const drawRow = (cells, { header = false } = {}) => {
      // 每个单元格先折行，行高取最高单元格
      const cellLines = []
      let maxLines = 1
      for (let c = 0; c < columns; c += 1) {
        const runs = (cells[c] ?? []).map((run) => (header ? { ...run, bold: true } : run))
        const lines = wrapRuns(runs, widths[c] - 10, TABLE_SIZE, font)
        cellLines.push(lines)
        maxLines = Math.max(maxLines, lines.length)
      }
      const height = maxLines * lineHeight + 6
      if (!ensure(height)) return false
      const top = y
      let x = MARGIN_X
      for (let c = 0; c < columns; c += 1) {
        const align = block.align?.[c] || "left"
        for (let k = 0; k < cellLines[c].length; k += 1) {
          const line = cellLines[c][k]
          const lineWidth = line.reduce((sum, p) => sum + p.width, 0)
          const offsetX =
            align === "right"
              ? widths[c] - 5 - lineWidth
              : align === "center"
                ? (widths[c] - lineWidth) / 2
                : 5
          const savedY = y
          y = top - 3 - k * lineHeight
          drawLine(line, { x: x + Math.max(2, offsetX), size: TABLE_SIZE })
          y = savedY
        }
        x += widths[c]
      }
      y = top - height
      // 行分隔线
      page.ops.push({
        t: "line",
        x1: MARGIN_X,
        y1: y + 2,
        x2: MARGIN_X + widths.reduce((a, b) => a + b, 0),
        y2: y + 2,
        width: 0.5,
        color: COLOR_RULE,
      })
      return true
    }

    if (!ensure(lineHeight * 2)) return
    const tableTop = y
    drawRow(block.header, { header: true })
    for (const row of block.rows) {
      if (!drawRow(row)) break
    }
    // 表头下加一条稍粗的分隔线，并在左侧画一条竖线把表格框起来
    page.ops.push({
      t: "line",
      x1: MARGIN_X,
      y1: tableTop - lineHeight - 4,
      x2: MARGIN_X + widths.reduce((a, b) => a + b, 0),
      y2: tableTop - lineHeight - 4,
      width: 0.8,
      color: COLOR_RULE,
    })
    y -= 8
  }

  const drawBlock = (block, ctx = {}) => {
    switch (block.type) {
      case "heading":
        if (ctx.quote) {
          drawParagraph(block.inlines, { x: MARGIN_X + 10, color: COLOR_MUTED })
        } else {
          drawHeading(block)
        }
        break
      case "para":
        // 段落里可能夹着图片（`![](a.png)` 独占一行是最常见的写法）。
        // 逐段切分：文字走 drawParagraph，图片走 drawImage —— 这样图片是"真的图"，
        // 与预览里的 <img> 一致，而不是一行 `[图片: alt]` 占位符。
        drawRunsWithImages(block.inlines, {
          x: ctx.quote ? MARGIN_X + 10 : MARGIN_X,
          color: ctx.quote ? COLOR_MUTED : COLOR_TEXT,
          spaceAfter: BASE_SIZE * 0.55,
        })
        break
      case "list":
        drawList(block)
        break
      case "code":
        drawCode(block)
        break
      case "quote":
        drawQuote(block)
        break
      case "table":
        drawTable(block)
        break
      case "hr":
        if (!ensure(BASE_SIZE * 3)) return
        y -= BASE_SIZE
        page.ops.push({
          t: "line",
          x1: MARGIN_X,
          y1: y,
          x2: PAGE_WIDTH - MARGIN_X,
          y2: y,
          width: 0.6,
          color: COLOR_RULE,
        })
        y -= BASE_SIZE
        break
      default:
        break
    }
  }

  startPage()
  for (const block of blocks) drawBlock(block)

  // 空文档也要产出至少一页，否则 PDF 没有页面树
  if (!pages.length) startPage()

  // 页脚：第 n 页 / 共 N 页（放在留白里，不占用正文区域）
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`
    const size = 8.5
    const width = (font.measure(label) / 1000) * size
    const { hex } = font.encode(label)
    const x = (p.width - width) / 2
    p.ops.push({
      t: "text",
      x,
      y: MARGIN_BOTTOM * 0.5,
      size,
      color: COLOR_MUTED,
      runs: [{ x, hex, width, bold: false, italic: false }],
    })
  })

  if (pages.length >= MAX_PAGES) {
    warnings.push(`文档过长，已截断到 ${MAX_PAGES} 页`)
  }
  if (font.missingChars?.size) {
    const sample = [...font.missingChars].slice(0, 8).join(" ")
    warnings.push(`字体缺少这些字符的字形，已用「?」代替：${sample}`)
  }
  return { pages, pageCount: pages.length, warnings, title, images: usedImages }
}

/**
 * 任务列表的勾选框。
 *
 * 预览里这是 `<input type="checkbox">` —— 一个**方框控件**，不是文字。所以 PDF 里也画
 * 一个方框（+ 勾），而不是往正文里塞 `☑` / `☐`：那两个码点很多中文字体里并没有
 * （实测 NotoSerifSC 就没有），会变成 `?`，既难看又破坏"内容一致"。
 *
 * @returns {{x:number,y:number,size:number,checked:boolean}} 交给调用方在正确的
 *   基线位置画（因为折行之后才知道首行在哪）
 */
function taskBoxGeometry(x, baseline, size, checked) {
  const box = size * 0.82
  return { x, y: baseline + size * 0.06, size: box, checked }
}

/** 把"画勾选框"的几条指令塞进 page.ops */
function pushTaskBox(page, { x, y, size, checked }) {
  page.ops.push({ t: "rect", x, y, w: size, h: size, fill: [1, 1, 1], stroke: [0.45, 0.45, 0.45], width: 0.7 })
  if (!checked) return
  page.ops.push({
    t: "line",
    x1: x + size * 0.2,
    y1: y + size * 0.52,
    x2: x + size * 0.42,
    y2: y + size * 0.26,
    width: 0.9,
    color: [0.12, 0.12, 0.12],
  })
  page.ops.push({
    t: "line",
    x1: x + size * 0.42,
    y1: y + size * 0.26,
    x2: x + size * 0.8,
    y2: y + size * 0.74,
    width: 0.9,
    color: [0.12, 0.12, 0.12],
  })
}
