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

import { OfficeError, isOfficeError } from "./errors.ts"

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
/** 单个条目解压后的上限：防一个条目吃掉全部预算（正常的 OOXML 部件远小于它） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

const utf8 = new TextDecoder("utf-8")

/**
 * 解压一个 deflate-raw 条目，**边读边计数**，超过预算立刻取消。
 *
 * 为什么不能再用 `new Response(stream.readable).arrayBuffer()`：
 * 那个写法会把解压结果整块攒进内存，而"这个条目解压后有多大"只写在中央目录里，
 * 完全由压缩包作者控制 —— 不可信。按 deflate 的极限压缩比（约 1032:1）构造的
 * 1MB 文件可以解出 1GB，用户点开预览的瞬间标签页就 OOM（安全复检 D-2）。
 *
 * 服务端对应逻辑（server/src/fileinfo.js 的 readZipEntry）用的正是
 * `zlib.inflateRawSync(data, { maxOutputLength })`，这里等价地手工限量。
 *
 * @param maxBytes 本次允许解出的最大字节数（由调用方按"剩余预算"算好）
 */
async function inflateRaw(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new OfficeError("unsupported")
  }
  const stream = new DecompressionStream("deflate-raw")
  const writer = stream.writable.getWriter()
  // 写入与读取必须并行：解压器的输出缓冲有限，先 await 写入会在大条目上互相卡死。
  // 失败由下面的 read() 统一转成 OfficeError，这里只做吞掉处理，免得 unhandled rejection。
  writer.write(bytes as unknown as ArrayBufferView<ArrayBuffer>).catch(() => {})
  writer.close().catch(() => {})

  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.length) continue
      total += value.length
      if (total > maxBytes) {
        // 超预算立刻取消：不能"先解完再判断"，那时内存已经吃掉了
        await reader.cancel().catch(() => {})
        throw new OfficeError("too_large")
      }
      chunks.push(value)
    }
  } catch (err) {
    if (isOfficeError(err)) throw err
    throw new OfficeError("invalid")
  }
  // 按实际长度拼一次，避免 Buffer.concat 式地再复制一遍多余容量
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
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
  /** 已经解出（含缓存命中）的字节总数：所有条目共享同一份预算 */
  let inflated = 0

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
    // 预算按"剩余"算：单个条目不能吃掉全部，多个条目也不能累加超限。
    // 注意这里**不**相信中央目录里的 e.size / compressedSize 声明值 ——
    // 它们是压缩包作者写的，正常的截断下载也会与之一致，但恶意包可以随便写。
    const budget = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - inflated)
    if (budget <= 0) throw new OfficeError("too_large")
    let out: Uint8Array
    if (e.method === 0) {
      // 存储方式没有解压膨胀，但仍要占预算
      if (raw.length > budget) throw new OfficeError("too_large")
      out = raw.slice()
    } else if (e.method === 8) {
      out = await inflateRaw(raw, budget)
    } else {
      throw new OfficeError("unsupported")
    }
    inflated += out.length
    cache.set(name, out)
    return out
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
  }
}
