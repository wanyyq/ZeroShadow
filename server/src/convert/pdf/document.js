/**
 * convert/pdf/document.js —— 最小 PDF 1.7 写出器（只覆盖本项目要用的那点语法）。
 *
 * 为什么手写：见 truetype.js 文件头的说明（不新增依赖）。PDF 的文件结构其实很朴素：
 *   头部 → 一串 `n 0 obj ... endobj` → 交叉引用表（xref）→ trailer
 * 真正的坑只有两个，这里都处理了：
 *   1. **xref 里的偏移必须是字节偏移**，写错一个字节多数阅读器就直接拒绝打开。
 *      所以对象内容先全部编码进 Buffer，再在拼接时记录每个对象的起始偏移。
 *   2. **流对象的 /Length 必须是压缩后的字节数**（用 FlateDecode 时），
 *      而不是原始长度；字体程序还要额外给 /Length1 = 解压后的长度。
 *
 * 页面内容用"操作列表"描述（text / rect / line / link），由 layout.js 产出，
 * 这样排版逻辑不需要知道 PDF 操作符长什么样。
 */
import zlib from "node:zlib"

const PDF_HEADER = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"

/** 转义 PDF 字面量字符串里的特殊字符 */
function escapeLiteral(text) {
  return String(text).replace(/[\\()]/g, (m) => `\\${m}`)
}

/** 任意文本 → PDF 文本串（非 ASCII 用 UTF-16BE + BOM，避免乱码） */
function pdfTextString(text) {
  const value = String(text)
  if (/^[\x20-\x7e]*$/.test(value)) return `(${escapeLiteral(value)})`
  const utf16 = Buffer.from(`\ufeff${value}`, "utf16le")
  // utf16le 的字节序与 PDF 要求的 big-endian 相反，交换一下
  for (let i = 0; i < utf16.length; i += 2) {
    const tmp = utf16[i]
    utf16[i] = utf16[i + 1]
    utf16[i + 1] = tmp
  }
  return `<${utf16.toString("hex").toUpperCase()}>`
}

function num(value) {
  if (!Number.isFinite(value)) return "0"
  // 保留三位小数就够了，避免内容流里出现一长串浮点噪声
  return String(Math.round(value * 1000) / 1000)
}

function color(rgb, stroke = false) {
  const [r, g, b] = rgb || [0, 0, 0]
  return `${num(r)} ${num(g)} ${num(b)} ${stroke ? "RG" : "rg"}`
}

// ---------------------------------------------------------------------------
// 内容流：把排版层的操作翻译成 PDF 操作符
// ---------------------------------------------------------------------------

function renderTextOp(op, out) {
  const size = op.size
  out.push("BT")
  // 字体必须在文本对象里设置（Tf 是文本状态操作符，写在 BT 之前会被忽略）
  out.push(`/F1 ${num(size)} Tf`)
  out.push(`${color(op.color || [0, 0, 0])} ${color(op.color || [0, 0, 0], true)}`)
  for (const run of op.runs) {
    if (!run.hex) continue
    // 斜体：PDF 没有"倾斜字体"，用文本矩阵的剪切分量伪造（与 Word 的伪斜体同理）
    const shear = run.italic ? 0.21 : 0
    if (run.bold) {
      // 粗体同样靠"描边 + 填充"伪造：0.03em 的描边宽度肉眼上等价于半粗，
      // 且不需要第二份字体（省掉一半体积）
      out.push(`2 Tr ${num(size * 0.03)} w`)
    } else {
      out.push("0 Tr")
    }
    out.push(`1 0 ${num(shear)} 1 ${num(run.x)} ${num(op.y)} Tm`)
    out.push(`<${run.hex}> Tj`)
    if (run.bold) out.push("0 Tr")
  }
  out.push("ET")
}

function renderContent(page, ops) {
  const out = []
  for (const op of ops) {
    switch (op.t) {
      case "text": {
        renderTextOp(op, out)
        break
      }
      case "rect": {
        out.push("q")
        out.push(color(op.fill || [0.96, 0.96, 0.96]))
        if (op.stroke) {
          out.push(color(op.stroke, true))
          out.push(`${num(op.width || 0.5)} w`)
          out.push(
            `${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re B`
          )
        } else {
          out.push(`${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re f`)
        }
        out.push("Q")
        break
      }
      case "line": {
        out.push("q")
        out.push(color(op.color || [0.7, 0.7, 0.7], true))
        out.push(`${num(op.width || 0.5)} w`)
        out.push(`${num(op.x1)} ${num(op.y1)} m ${num(op.x2)} ${num(op.y2)} l S`)
        out.push("Q")
        break
      }
      default:
        break
    }
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// ToUnicode：让 PDF 里的文字可复制（CID → Unicode）
// ---------------------------------------------------------------------------

function buildToUnicode(font) {
  const entries = []
  for (const [gid, codePoint] of font.gidToCodePoint) {
    if (gid === undefined || codePoint === undefined) continue
    const src = gid.toString(16).padStart(4, "0").toUpperCase()
    let dst
    if (codePoint > 0xffff) {
      // 辅助平面：UTF-16 代理对
      const v = codePoint - 0x10000
      const hi = 0xd800 + (v >> 10)
      const lo = 0xdc00 + (v & 0x3ff)
      dst = hi.toString(16).padStart(4, "0") + lo.toString(16).padStart(4, "0")
    } else {
      dst = codePoint.toString(16).padStart(4, "0")
    }
    entries.push(`<${src}> <${dst.toUpperCase()}>`)
  }

  const lines = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
  ]
  // PDF 规定每个 beginbfchar 块最多 100 条
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    lines.push(`${chunk.length} beginbfchar`)
    lines.push(...chunk)
    lines.push("endbfchar")
  }
  lines.push(
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end"
  )
  return lines.join("\n")
}

/** /W 数组：每个用到的 CID 单独给一个宽度 */
function buildWidths(font) {
  const parts = []
  for (const gid of font.usedGids) {
    parts.push(`${gid} [${font.rawAdvance(gid)}]`)
  }
  return `[${parts.join(" ")}]`
}

// ---------------------------------------------------------------------------
// 文档装配
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {Array<{width:number,height:number,ops:object[],links:object[]}>} options.pages
 * @param {object} options.font loadFont() 返回的 font 视图
 * @param {string} [options.title]
 * @param {string} [options.subject]
 * @returns {Buffer} 完整的 PDF 文件
 */
export function buildPdf({ pages, font, title, subject }) {
  const objects = [] // 每项是 Buffer 或字符串，索引 0 => 1 号对象
  const addObject = (body) => {
    objects.push(body)
    return objects.length
  }
  const ref = (n) => `${n} 0 R`

  // 预留：Catalog(1) / Pages(2) / Font(3) / CIDFont(4) / Descriptor(5) / FontFile(6) / ToUnicode(7) / Info(8)
  const catalogId = addObject("") // 占位，最后回填（需要知道 Pages 的号）
  const pagesId = addObject("")
  const fontId = addObject("")
  const cidFontId = addObject("")
  const descriptorId = addObject("")
  const fontFileId = addObject("")
  const toUnicodeId = addObject("")
  const infoId = addObject("")

  const pageIds = []
  for (const page of pages) {
    const content = Buffer.from(renderContent(page, page.ops), "latin1")
    const compressed = zlib.deflateSync(content)
    const contentId = addObject(
      streamObject(compressed.toString("latin1"), { Length: compressed.length, Filter: "/FlateDecode" })
    )
    const annots = (page.links || []).map((link) => ({
      id: addObject(
        `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(num).join(" ")}] ` +
          `/Border [0 0 0] /A << /S /URI /URI (${escapeLiteral(link.url)}) >> >>`
      ),
      link,
    }))
    const annotsRef = annots.length ? ` /Annots [${annots.map((a) => ref(a.id)).join(" ")}]` : ""
    pageIds.push(
      addObject(
        `<< /Type /Page /Parent ${ref(pagesId)} /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${ref(fontId)} >> /ProcSet [/PDF /Text] >> ` +
          `/Contents ${ref(contentId)}${annotsRef} >>`
      )
    )
  }

  // ---- 字体相关 ----
  // 有中文字体时：Type0 + CIDFontType2（Identity-H）+ 子集化字体程序 + ToUnicode。
  // 没有中文字体时（font.kind === "fallback"）：退回 PDF 内置的 Helvetica + WinAnsi，
  // 中文由调用方替换成 '?' —— 这里绝不能内嵌一个空的字体程序，那会让阅读器直接报错。
  const simpleFont = font.kind === "fallback"
  const baseName = "ZSJPDOC+ZeroShadowCJK"
  const bbox = font.bbox || [0, -200, 1000, 900]

  if (simpleFont) {
    objects[fontId - 1] =
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    // 下面四个对象只在 CID 字体路径下被引用；退化路径留空字典，保证对象编号不错位
    objects[cidFontId - 1] = "<< >>"
    objects[descriptorId - 1] = "<< >>"
    objects[fontFileId - 1] = streamObject("", { Length: 0 })
    objects[toUnicodeId - 1] = streamObject("", { Length: 0 })
  } else {
    const subset = font.buildSubset()
    const fontProgram = subset ?? Buffer.alloc(0)
    objects[fontId - 1] =
      `<< /Type /Font /Subtype /Type0 /BaseFont /${baseName} /Encoding /Identity-H ` +
      `/DescendantFonts [${ref(cidFontId)}] /ToUnicode ${ref(toUnicodeId)} >>`
    objects[cidFontId - 1] =
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseName} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${ref(descriptorId)} /DW 1000 /W ${buildWidths(font)} /CIDToGIDMap /Identity >>`
    objects[descriptorId - 1] =
      `<< /Type /FontDescriptor /FontName /${baseName} /Flags 4 ` +
      `/FontBBox [${bbox.map(num).join(" ")}] /ItalicAngle 0 ` +
      `/Ascent ${num(font.ascent)} /Descent ${num(font.descent)} /CapHeight ${num(font.capHeight)} ` +
      `/StemV 80 /FontFile2 ${ref(fontFileId)} >>`

    const compressedFont = zlib.deflateSync(fontProgram)
    objects[fontFileId - 1] = streamObject(compressedFont.toString("latin1"), {
      Length: compressedFont.length,
      Length1: fontProgram.length,
      Filter: "/FlateDecode",
    })
    const cmap = Buffer.from(buildToUnicode(font), "latin1")
    objects[toUnicodeId - 1] = streamObject(cmap.toString("latin1"), { Length: cmap.length })
  }

  // ---- 文档树与信息 ----
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${ref(pagesId)} >>`
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map(ref).join(" ")}] /Count ${pageIds.length} >>`
  objects[infoId - 1] =
    `<< /Title ${pdfTextString(title || "ZeroShadow 文档")} ` +
    `/Subject ${pdfTextString(subject || "")} ` +
    `/Producer (ZeroShadow) /Creator (ZeroShadow) ` +
    `/CreationDate (D:${formatPdfDate(new Date())}) >>`

  // ---- 序列化（此时才知道每个对象的字节偏移）----
  const chunks = [Buffer.from(PDF_HEADER, "latin1")]
  let offset = chunks[0].length
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(offset)
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1")
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1")
    const tail = Buffer.from("\nendobj\n", "latin1")
    chunks.push(head, bodyBuf, tail)
    offset += head.length + bodyBuf.length + tail.length
  })

  const xrefOffset = offset
  const xrefLines = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "]
  for (const off of offsets) xrefLines.push(`${String(off).padStart(10, "0")} 00000 n `)
  const xref = Buffer.from(`${xrefLines.join("\n")}\n`, "latin1")
  chunks.push(xref)
  const trailer = Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root ${ref(catalogId)} /Info ${ref(infoId)} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
    "latin1"
  )
  chunks.push(trailer)

  return Buffer.concat(chunks)
}

/** 流对象：字典里除了长度还可以带别的键（Filter / Length1） */
function streamObject(data, dict = {}) {
  const entries = Object.entries(dict)
    .map(([k, v]) => `/${k} ${v}`)
    .join(" ")
  return `<< ${entries} >>\nstream\n${data}\nendstream`
}

function formatPdfDate(date) {
  const pad = (n) => String(n).padStart(2, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

export { pdfTextString }
