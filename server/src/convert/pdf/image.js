/**
 * convert/pdf/image.js —— 把 Markdown 里引用的图片变成 PDF 能画的 **Image XObject**。
 *
 * 为什么需要它："预览里看得到图、转成 PDF 却只有一行 `[图片: xxx]`" 是内容不一致，
 * 而用户对这功能的期待很明确：**除了字体，PDF 与预览应当一模一样**。
 *
 * 三条路径，按"能不能无损、省事、不引入依赖"排序：
 *
 *   1. **JPEG**：直接把原始字节塞进 `/Filter /DCTDecode` 的流里。不重编码 ——
 *      既不损失画质，文件也最小（一张照片重编码成 RGB + Flate 会大一个数量级）。
 *   2. **PNG**（非交错、8 位、灰度或 RGB、无 alpha）：PNG 的 IDAT 就是 zlib 压缩的
 *      逐行数据，每行开头是 filter 字节 —— 这正是 PDF 的 `/Predictor 15`。于是可以把
 *      IDAT 原样拼起来当流数据，**不需要解码采样，也不需要 sharp**。
 *   3. 其它（带 alpha 的 PNG / GIF / WebP / BMP / 调色板 PNG…）：用项目已有的
 *      `sharp`（图片转换功能本来就靠它，且是可选依赖）解码成 RGB 原始样本，Flate 压缩。
 *      sharp 不可用就退化成一行占位文字 —— 宁可少一张图，也不要让整篇转换失败。
 *
 * 尺寸计算不在这里：这里只回答"这张图多大、怎么编码"，放大缩小由 layout.js 决定
 * （它才知道版心宽度与分页）。
 */

/** PDF 图像对象（交给 document.js 写成 XObject） */
export class PdfImage {
  constructor({ width, height, colorSpace, bitsPerComponent, filter, data, decodeParms }) {
    this.width = width
    this.height = height
    this.colorSpace = colorSpace
    this.bitsPerComponent = bitsPerComponent
    this.filter = filter
    this.data = data
    this.decodeParms = decodeParms || null
  }

  get aspect() {
    return this.width / this.height
  }
}

/* ============================================================== JPEG == */

/** 读 JPEG 的尺寸与颜色分量数（SOF0/1/2/9/10 段） */
function readJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  const view = { width: 0, height: 0, components: 3 }
  let i = 2
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buffer[i + 1]
    // 填充字节 0xFF 允许连续出现
    if (marker === 0xff) {
      i += 1
      continue
    }
    // 无长度的独立标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = buffer.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      view.height = buffer.readUInt16BE(i + 5)
      view.width = buffer.readUInt16BE(i + 7)
      view.components = buffer[i + 9]
      break
    }
    i += 2 + length
  }
  if (!view.width || !view.height) return null
  return view
}

/* =============================================================== PNG == */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 解析 PNG 头部与 IDAT；能直接按 Predictor 15 交给 PDF 时返回描述，否则 null */
function readPng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  let i = 8
  let header = null
  const idat = []
  while (i + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(i)
    const type = buffer.toString("latin1", i + 4, i + 8)
    const dataStart = i + 8
    const dataEnd = dataStart + length
    if (dataEnd > buffer.length) return null
    if (type === "IHDR" && length >= 13) {
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        compression: buffer[dataStart + 10],
        filter: buffer[dataStart + 11],
        interlace: buffer[dataStart + 12],
      }
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === "IEND") {
      break
    }
    i = dataEnd + 4 // 跳过 CRC
  }
  if (!header || !idat.length) return null
  // 只直通"灰度 / RGB"两种。带 alpha（colorType 4/6）在直通路径里没法把 alpha 拆成
  // /SMask，硬塞进去会出现"整张图黑底"；调色板要搬 /Indexed 调色板；16 位要降位深；
  // 交错要重排 —— 这几种都交给 sharp 解码成 RGB，稳妥且只有一条代码路径。
  if (header.interlace !== 0 || header.bitDepth !== 8 || header.compression !== 0 || header.filter !== 0) return null
  if (header.colorType !== 0 && header.colorType !== 2) return null
  return { ...header, data: Buffer.concat(idat) }
}

/* ============================================================ sharp == */

let sharpModule = null
let sharpResolved = false

async function loadSharp() {
  if (sharpResolved) return sharpModule
  sharpResolved = true
  try {
    const mod = await import("sharp")
    sharpModule = mod.default ?? mod
  } catch {
    sharpModule = null
  }
  return sharpModule
}

/* =========================================================== 对外接口 == */

/**
 * 解析一张图片，返回可画的 {@link PdfImage}（无法处理时返回 null）。
 *
 * @param {Buffer} buffer 图片文件内容
 * @param {{ maxPixels?: number }} [options] 超过像素上限就放弃（避免一张 8000×8000 的图把内存打满）
 * @returns {Promise<PdfImage|null>}
 */
export async function prepareImage(buffer, { maxPixels = 40_000_000 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null

  const jpeg = readJpeg(buffer)
  if (jpeg) {
    if (jpeg.width * jpeg.height > maxPixels) return null
    return new PdfImage({
      width: jpeg.width,
      height: jpeg.height,
      colorSpace: jpeg.components === 1 ? "/DeviceGray" : jpeg.components === 4 ? "/DeviceCMYK" : "/DeviceRGB",
      bitsPerComponent: 8,
      filter: "/DCTDecode",
      data: buffer,
    })
  }

  const png = readPng(buffer)
  if (png) {
    if (png.width * png.height > maxPixels) return null
    const channels = png.colorType === 0 ? 1 : 3
    return new PdfImage({
      width: png.width,
      height: png.height,
      colorSpace: channels === 1 ? "/DeviceGray" : "/DeviceRGB",
      bitsPerComponent: 8,
      filter: "/FlateDecode",
      data: png.data,
      decodeParms: `/Predictor 15 /Colors ${channels} /BitsPerComponent 8 /Columns ${png.width}`,
    })
  }

  // 走到这里：GIF / WebP / 带 alpha 的 PNG / 调色板 PNG / BMP / SVG ……
  const sharp = await loadSharp()
  if (!sharp) return null
  try {
    const meta = await sharp(buffer).metadata()
    if (!meta.width || !meta.height) return null
    if (meta.width * meta.height > maxPixels) return null
    const flattened = sharp(buffer).rotate().flatten({ background: "#ffffff" }).toColourspace("srgb")
    const { data, info } = await flattened.raw().toBuffer({ resolveWithObject: true })
    const channels = info.channels
    if (channels !== 1 && channels !== 3) return null
    return new PdfImage({
      width: info.width,
      height: info.height,
      colorSpace: channels === 1 ? "/DeviceGray" : "/DeviceRGB",
      bitsPerComponent: 8,
      filter: "/FlateDecode",
      data,
    })
  } catch {
    return null
  }
}
