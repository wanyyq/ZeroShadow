/**
 * 浏览器原生 ZIP 读取器（只读、够用即止）
 *
 * 不装 jszip：`.docx/.xlsx/.pptx` 本质是 ZIP，浏览器自带
 * `DecompressionStream("deflate-raw")` 就能解 deflate 条目（Node 18+ 也有）。
 * 实现只覆盖 OOXML 会出现的形态：
 *   - EOCD → 中央目录 → 本地头（不依赖 data descriptor 里的长度）
 *   - 存储（method 0）与 deflate（method 8）两种压缩方式
 *   - 不读 ZIP64 / 分卷 / 传统加密（遇到就明确报错，而不是读出乱码）
 *
 * 条目按需解压并缓存：一份 docx 里 `document.xml` 可能被多个解析步骤用到，
 * 重复解压既慢又费内存。
 */

import { OfficeError } from "./errors.ts"

export interface ZipArchive {
  /** 全部条目名（含目录条目） */
  names: string[]
  has(name: string): boolean
  /** 解出某个条目的原始字节；不存在返回 undefined */
  read(name: string): Promise<Uint8Array | undefined>
}

interface Entry {
  method: number
  compressedSize: number
  size: number
  offset: number
  flags: number
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** 单份文档解压后的总上限：超过就说明这不是「用来看的」文档，直接友好报错 */
const MAX_TOTAL_BYTES = 192 * 1024 * 1024

const utf8 = new TextDecoder("utf-8")

function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    return Promise.reject(new OfficeError("unsupported"))
  }
  const stream = new DecompressionStream("deflate-raw")
  const writer = stream.writable.getWriter()
  // 写入与读取必须并行：解压器的输出缓冲有限，先 await 写入会在大条目上互相卡死。
  // 这里的失败由下面的 arrayBuffer() 统一转成 OfficeError，所以只做吞掉处理，
  // 免得出现 unhandled rejection。
  writer.write(bytes as unknown as ArrayBufferView<ArrayBuffer>).catch(() => {})
  writer.close().catch(() => {})
  return new Response(stream.readable)
    .arrayBuffer()
    .then((buf) => new Uint8Array(buf))
    .catch(() => {
      throw new OfficeError("invalid")
    })
}

export async function openZip(bytes: Uint8Array): Promise<ZipArchive> {
  if (bytes.length < 22) throw new OfficeError("invalid")
  const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)

  // EOCD 后面可能跟着注释（最多 65535 字节），从尾部往回找签名
  let eocd = -1
  const floor = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new OfficeError("invalid")

  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (!count || cdOffset >= bytes.length) throw new OfficeError("invalid")

  const entries = new Map<string, Entry>()
  let p = cdOffset
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) break
    const flags = view.getUint16(p + 8, true)
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const size = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const offset = view.getUint32(p + 42, true)
    const nameStart = p + 46
    if (nameStart + nameLen > bytes.length) break
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLen))
    if (flags & 0x1) throw new OfficeError("encrypted")
    entries.set(name, { method, compressedSize, size, offset, flags })
    p = nameStart + nameLen + extraLen + commentLen
  }
  if (entries.size === 0) throw new OfficeError("invalid")

  let declared = 0
  for (const e of entries.values()) declared += e.size
  if (declared > MAX_TOTAL_BYTES) throw new OfficeError("too_large")

  const cache = new Map<string, Uint8Array>()

  const read = async (name: string): Promise<Uint8Array | undefined> => {
    const hit = cache.get(name)
    if (hit) return hit
    const e = entries.get(name)
    if (!e) return undefined
    if (e.offset + 30 > bytes.length || view.getUint32(e.offset, true) !== SIG_LOCAL) {
      throw new OfficeError("invalid")
    }
    const nameLen = view.getUint16(e.offset + 26, true)
    const extraLen = view.getUint16(e.offset + 28, true)
    const start = e.offset + 30 + nameLen + extraLen
    const end = start + e.compressedSize
    if (end > bytes.length) throw new OfficeError("invalid")
    const raw = bytes.subarray(start, end)
    let out: Uint8Array
    if (e.method === 0) out = raw.slice()
    else if (e.method === 8) out = await inflateRaw(raw)
    else throw new OfficeError("unsupported")
    // 压缩后的长度可能与中央目录不符（截断的下载）；不信任 size，解出来就用
    if (e.size > MAX_TOTAL_BYTES) throw new OfficeError("too_large")
    cache.set(name, out)
    return out
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
  }
}
