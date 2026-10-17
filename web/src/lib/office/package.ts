/**
 * OOXML 包（OPC）通用层
 *
 * `.docx/.xlsx/.pptx` 都是「一个 ZIP + 一堆 XML 部件 + `.rels` 关系表」。
 * 这一层把「按路径取部件 / 取 XML / 取关系表 / 取图片字节」收口成一组小函数，
 * 三种格式的解析器就只关心自己的那部分语义。
 *
 * 图片一律以 `{ mime, data }` 形式往外交（不在这里造 `blob:` URL）：
 * 解析层要能在 Node 测试里跑，`URL.createObjectURL` 由 React 组件负责。
 */

import { OfficeError } from "./errors.ts"
import { openZip, type ZipArchive } from "./zip.ts"
import { attr, kids, parseXml, type XmlNode } from "./xml.ts"

export interface MediaFile {
  mime: string
  data: Uint8Array
}

export type MediaMap = Map<string, MediaFile>

export interface RelTarget {
  /** 已按部件所在目录解析成包内绝对路径（external 时保留原始 URL） */
  target: string
  external: boolean
}

export interface OfficePackage {
  zip: ZipArchive
  has(path: string): boolean
  bytes(path: string): Promise<Uint8Array | undefined>
  text(path: string): Promise<string | undefined>
  xml(path: string): Promise<XmlNode | undefined>
  media(path: string): Promise<MediaFile | undefined>
}

const utf8 = new TextDecoder("utf-8")
const utf16le = new TextDecoder("utf-16le")
const utf16be = new TextDecoder("utf-16be")

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

export function baseOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/** 把 `.rels` 里的相对 Target 解析成包内路径（处理 `../` 与开头的 `/`） */
export function resolvePart(baseDir: string, target: string): string {
  if (!target) return ""
  if (target.startsWith("/")) return target.slice(1)
  const out: string[] = []
  for (const seg of `${baseDir ? `${baseDir}/` : ""}${target}`.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join("/")
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes.subarray(2))
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes.subarray(2))
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return utf8.decode(bytes.subarray(3))
  }
  return utf8.decode(bytes)
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  avif: "image/avif",
}

function mimeOf(path: string): string {
  const ext = baseOf(path).split(".").pop()?.toLowerCase() ?? ""
  return MIME[ext] ?? "application/octet-stream"
}

export async function openOfficePackage(bytes: Uint8Array): Promise<OfficePackage> {
  // 加密的 Office 文档是 OLE 复合文档（不是 ZIP），单独识别出来给「已加密」提示
  if (
    bytes.length > 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    throw new OfficeError("encrypted")
  }
  const zip = await openZip(bytes)
  if (!zip.has("[Content_Types].xml") && !zip.names.some((n) => n.includes("/"))) {
    throw new OfficeError("invalid")
  }

  const xmlCache = new Map<string, XmlNode | undefined>()

  const pkg: OfficePackage = {
    zip,
    has: (path) => zip.has(path),
    bytes: (path) => zip.read(path),
    async text(path) {
      const data = await zip.read(path)
      return data ? decodeText(data) : undefined
    },
    async xml(path) {
      if (xmlCache.has(path)) return xmlCache.get(path)
      const source = await pkg.text(path)
      const parsed = source === undefined ? undefined : parseXml(source)
      xmlCache.set(path, parsed)
      return parsed
    },
    async media(path) {
      const data = await zip.read(path)
      return data ? { mime: mimeOf(path), data } : undefined
    },
  }
  return pkg
}

/** 读取某个部件的 `.rels`：`word/document.xml` → `word/_rels/document.xml.rels` */
export async function readRels(
  pkg: OfficePackage,
  partPath: string
): Promise<Map<string, RelTarget>> {
  const relsPath = `${dirOf(partPath) ? `${dirOf(partPath)}/` : ""}_rels/${baseOf(partPath)}.rels`
  const root = await pkg.xml(relsPath)
  const out = new Map<string, RelTarget>()
  const baseDir = dirOf(partPath)
  for (const rel of kids(root, "Relationship")) {
    const id = attr(rel, "Id")
    const target = attr(rel, "Target")
    if (!id || !target) continue
    const external = (attr(rel, "TargetMode") ?? "").toLowerCase() === "external"
    out.set(id, {
      target: external ? target : resolvePart(baseDir, target),
      external,
    })
  }
  return out
}

/** 从包里挑出所有被引用到的图片，交给组件转成 blob: URL */
export async function collectMedia(
  pkg: OfficePackage,
  paths: Iterable<string>
): Promise<MediaMap> {
  const media: MediaMap = new Map()
  for (const path of paths) {
    if (!path || media.has(path)) continue
    const file = await pkg.media(path)
    if (file) media.set(path, file)
  }
  return media
}

/** EMU → CSS 像素（96 DPI；1cm = 360000 EMU，1px = 9525 EMU） */
export function emuToPx(emu: number | undefined): number | undefined {
  if (!emu || !Number.isFinite(emu)) return undefined
  return Math.round(emu / 9525)
}
