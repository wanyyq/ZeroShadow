/**
 * convert/converters/image.js —— 图片格式互转（PNG → JPG、JPG → PNG）。
 *
 * 走项目已有的 sharp（缩略图用的同一套原生库），因此：
 *   - 单文件 exe 里没有 sharp → 这里回一个明确的 `no_sharp` 错误，而不是崩掉；
 *   - PNG 的透明通道在 JPG 里没法保留，统一**铺白底**（不这么做，透明区会变成黑块，
 *     这是所有"PNG 转 JPG 变黑"投诉的唯一原因）；
 *   - 先 `rotate()` 应用 EXIF 方向：手机照片不这么做，转出来会躺倒。
 *
 * 输出参数刻意选"看起来和原图一样"的一档：
 *   JPG: quality 90 + 4:4:4 色度采样（截图/文字边缘不会糊），渐进式
 *   PNG: 最高压缩（PNG 是无损的，压缩级别只影响生成耗时与体积）
 */
/** 图片转换的源文件上限：32MB 已经能覆盖 4000 万像素级的原图，再大属于"素材"而非文档 */
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024
/** 解码像素上限：防"一个 3 亿像素的扫描图把内存吃光"（与缩略图模块同一思路） */
const MAX_INPUT_PIXELS = 120_000_000

let sharpLib = null
let sharpState = "unknown"

/** 懒加载 sharp；失败只判定一次，之后直接不可用 */
async function loadSharp() {
  if (sharpState === "ok") return sharpLib
  if (sharpState === "missing") return null
  try {
    const mod = await import("sharp")
    sharpLib = mod.default ?? mod
    sharpState = "ok"
    return sharpLib
  } catch {
    sharpState = "missing"
    return null
  }
}

function unavailableError() {
  const err = new Error("服务端未安装 sharp，图片转换不可用")
  err.status = 501
  err.errorKey = "api.fs.convert_no_sharp"
  return err
}

/** 公共前处理：限像素 + 应用 EXIF 方向 */
function prepare(sharp, buffer) {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" }).rotate()
}

async function convertImage(buffer, encode) {
  const sharp = await loadSharp()
  if (!sharp) throw unavailableError()
  let pipeline = prepare(sharp, buffer)
  const meta = await pipeline.metadata().catch(() => null)
  if (!meta?.width || !meta?.height) {
    const err = new Error("无法识别这个图片文件")
    err.status = 415
    err.errorKey = "api.fs.convert_bad_image"
    throw err
  }
  return encode(pipeline)
}

export const pngToJpg = {
  id: "png-to-jpg",
  from: ["png"],
  to: "jpg",
  label: "PNG → JPG",
  labelKey: "ui.convert.png_jpg",
  input: "buffer",
  maxBytes: IMAGE_MAX_BYTES,
  async run({ buffer, onProgress }) {
    const data = await convertImage(buffer, (pipeline) =>
      pipeline
        .flatten({ background: "#ffffff" }) // 透明区铺白底，否则 JPG 里会变黑
        .jpeg({ quality: 90, progressive: true, chromaSubsampling: "4:4:4" })
        .toBuffer()
    )
    onProgress?.(90)
    return { data }
  },
}

export const jpgToPng = {
  id: "jpg-to-png",
  from: ["jpg", "jpeg"],
  to: "png",
  label: "JPG → PNG",
  labelKey: "ui.convert.jpg_png",
  input: "buffer",
  maxBytes: IMAGE_MAX_BYTES,
  async run({ buffer, onProgress }) {
    const data = await convertImage(buffer, (pipeline) =>
      pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    )
    onProgress?.(90)
    return { data }
  },
}
