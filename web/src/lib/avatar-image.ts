// 把用户选择的图片裁切/缩放为 128×128 的 WebP。
// 全部在浏览器端完成，服务端只做尺寸与体积校验。

const TARGET = 128

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error("图片读取失败"))
      el.src = url
    })
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function fileToAvatarWebp(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件")
  const source = await loadBitmap(file)
  const sw = "naturalWidth" in source ? source.naturalWidth : source.width
  const sh = "naturalHeight" in source ? source.naturalHeight : source.height
  if (!sw || !sh) throw new Error("图片尺寸无效")

  const canvas = document.createElement("canvas")
  canvas.width = TARGET
  canvas.height = TARGET
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("当前浏览器不支持图片处理")

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  // 保持比例，居中裁切（cover）
  const scale = Math.max(TARGET / sw, TARGET / sh)
  const dw = sw * scale
  const dh = sh * scale
  ctx.drawImage(source as CanvasImageSource, (TARGET - dw) / 2, (TARGET - dh) / 2, dw, dh)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85))
  if (!blob) throw new Error("当前浏览器不支持 WebP，请更换现代浏览器")
  if (blob.type !== "image/webp") throw new Error("当前浏览器不支持 WebP，请更换现代浏览器")
  return blob
}
