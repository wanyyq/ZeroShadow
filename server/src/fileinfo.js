import fs from "node:fs"
import crypto from "node:crypto"
import zlib from "node:zlib"
import { decodeBuffer, detectEol, detectEncoding, encodingLabel, looksBinary } from "./encoding.js"

// ============================================================================
//  fileinfo.js —— 文件「详细信息」用的元数据提取
//
//  「详细信息」里的基础字段（名称 / 大小 / 时间 / 访客可见性）由 /fs/stat
//  直接给；这里补的是**必须真的读一遍文件**才能拿到的东西：签名（magic）、
//  哈希、图片尺寸、EXIF、文档作者、音视频时长与标签、文本编码……
//
//  两条硬约束：
//    1. 不把整个文件读进内存：识别与解析只读头尾各 64KB；哈希走流式，
//       超过 HASH_MAX_BYTES 直接跳过 —— 点一次「详细信息」不该把几个 GB 的
//       文件从头读到尾。
//    2. 任何一段解析失败都只让**那一段**为空，绝不让整个接口 500：用户要看
//       的是文件信息，不是我们的报错。所以下面每一段都包在 try/catch 里。
// ============================================================================

/** 头部/尾部各读这么多字节，足够覆盖签名、图片尺寸、EXIF、PDF Info、mvhd 等 */
const HEAD_BYTES = 64 * 1024
/** 超过这个体积就不算哈希：一次详情点击读几百 MB 磁盘不划算 */
const HASH_MAX_BYTES = 64 * 1024 * 1024
/** 文本类信息（行数 / 字数）最多读这么多，避免为了数行把大日志读爆 */
const TEXT_SCAN_BYTES = 8 * 1024 * 1024

/* ============================== 读文件 ============================== */

async function readRange(abs, start, length) {
  if (length <= 0) return Buffer.alloc(0)
  const fh = await fs.promises.open(abs, "r")
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** 头 + 尾两段（小文件就是整个文件），后者用于 PDF 尾部 Info 与 mp4 的 moov */
async function readHeadTail(abs, size) {
  const head = await readRange(abs, 0, Math.min(size, HEAD_BYTES))
  let tail = Buffer.alloc(0)
  if (size > HEAD_BYTES) tail = await readRange(abs, Math.max(0, size - HEAD_BYTES), HEAD_BYTES)
  return { head, tail }
}

/* ============================== 签名识别 ============================== */

/** 十六进制签名串，就是用户说的「文件签名」 */
function hexOf(buf, n = 16) {
  return [...buf.subarray(0, n)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")
}

/**
 * 固定偏移的字节/字符串签名表（顺序即优先级）。
 * key 是文案的命名键（前端查字典），label 是中文原文兜底；没有 key 的说明文案
 * 本身是 ASCII（如 Monkey's Audio），任何语言下都无需翻译。
 */
const SIGNATURES = [
  { off: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: "PNG 图像", key: "meta.magic.png", mime: "image/png", kind: "image" },
  { off: 0, bytes: [0xff, 0xd8, 0xff], label: "JPEG 图像", key: "meta.magic.jpeg", mime: "image/jpeg", kind: "image" },
  { off: 0, ascii: "GIF87a", label: "GIF 图像", key: "meta.magic.gif", mime: "image/gif", kind: "image" },
  { off: 0, ascii: "GIF89a", label: "GIF 图像", key: "meta.magic.gif", mime: "image/gif", kind: "image" },
  { off: 0, ascii: "BM", label: "BMP 图像", key: "meta.magic.bmp", mime: "image/bmp", kind: "image" },
  { off: 0, ascii: "II*\u0000", label: "TIFF 图像（小端）", key: "meta.magic.tiff_le", mime: "image/tiff", kind: "image" },
  { off: 0, ascii: "MM\u0000*", label: "TIFF 图像（大端）", key: "meta.magic.tiff_be", mime: "image/tiff", kind: "image" },
  { off: 0, bytes: [0x00, 0x00, 0x01, 0x00], label: "ICO 图标", key: "meta.magic.ico", mime: "image/x-icon", kind: "image" },
  { off: 0, bytes: [0x38, 0x42, 0x50, 0x53], label: "Photoshop 文档", key: "meta.magic.photoshop", mime: "image/vnd.adobe.photoshop", kind: "image" },
  { off: 0, ascii: "%PDF-", label: "PDF 文档", key: "meta.magic.pdf", mime: "application/pdf", kind: "document" },
  { off: 0, bytes: [0x50, 0x4b, 0x03, 0x04], label: "ZIP 归档", key: "meta.magic.zip", mime: "application/zip", kind: "archive" },
  { off: 0, bytes: [0x50, 0x4b, 0x05, 0x06], label: "ZIP 归档（空档案）", key: "meta.magic.zip_empty", mime: "application/zip", kind: "archive" },
  { off: 0, bytes: [0x50, 0x4b, 0x07, 0x08], label: "ZIP 分卷归档", key: "meta.magic.zip_spanning", mime: "application/zip", kind: "archive" },
  { off: 0, ascii: "Rar!\u001a\u0007", label: "RAR 归档", key: "meta.magic.rar", mime: "application/vnd.rar", kind: "archive" },
  { off: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: "7-Zip 归档", key: "meta.magic.seven_zip", mime: "application/x-7z-compressed", kind: "archive" },
  { off: 0, bytes: [0x1f, 0x8b], label: "GZip 压缩", key: "meta.magic.gzip", mime: "application/gzip", kind: "archive" },
  { off: 0, ascii: "BZh", label: "BZip2 压缩", key: "meta.magic.bzip2", mime: "application/x-bzip2", kind: "archive" },
  { off: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], label: "XZ 压缩", key: "meta.magic.xz", mime: "application/x-xz", kind: "archive" },
  { off: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd], label: "Zstandard 压缩", key: "meta.magic.zstd", mime: "application/zstd", kind: "archive" },
  { off: 0, ascii: "LZIP", label: "lzip 压缩", key: "meta.magic.lzip", mime: "application/lzip", kind: "archive" },
  { off: 0, bytes: [0x1f, 0x9d], label: "compress 压缩（.Z）", key: "meta.magic.compress_z", kind: "archive" },
  { off: 0, ascii: "fLaC", label: "FLAC 音频", key: "meta.magic.flac", mime: "audio/flac", kind: "audio" },
  { off: 0, ascii: "OggS", label: "Ogg 容器（Vorbis / Opus）", key: "meta.magic.ogg", mime: "audio/ogg", kind: "audio" },
  { off: 0, ascii: "ID3", label: "MP3 音频（带 ID3v2 标签）", key: "meta.magic.mp3_id3", mime: "audio/mpeg", kind: "audio" },
  { off: 0, ascii: "MThd", label: "MIDI 音频", key: "meta.magic.midi", mime: "audio/midi", kind: "audio" },
  { off: 0, ascii: "FORM", label: "IFF 容器（AIFF / ANIM）", key: "meta.magic.iff", kind: "audio" },
  { off: 0, ascii: "caff", label: "CAF 音频", key: "meta.magic.caf", kind: "audio" },
  { off: 0, bytes: [0x4d, 0x41, 0x43, 0x20], label: "Monkey's Audio", kind: "audio" },
  { off: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], label: "Matroska / WebM 容器", key: "meta.magic.matroska", mime: "video/x-matroska", kind: "video" },
  { off: 0, bytes: [0x00, 0x00, 0x01, 0xba], label: "MPEG 视频流", key: "meta.magic.mpeg_video_stream", mime: "video/mpeg", kind: "video" },
  { off: 0, bytes: [0x00, 0x00, 0x01, 0xb3], label: "MPEG 视频流", key: "meta.magic.mpeg_video_stream", mime: "video/mpeg", kind: "video" },
  { off: 0, ascii: "FLV\u0001", label: "Flash 视频", key: "meta.magic.flash_video", mime: "video/x-flv", kind: "video" },
  { off: 0, ascii: "DKIF", label: "WebP 动画 / IVF 视频", key: "meta.magic.webp_anim_ivf", kind: "video" },
  { off: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: "OLE2 复合文档（旧版 Office / MSI / WPS）", key: "meta.magic.ole2", kind: "document" },
  { off: 0, ascii: "{\\rtf", label: "RTF 文档", key: "meta.magic.rtf", mime: "application/rtf", kind: "document" },
  { off: 0, ascii: "%!PS", label: "PostScript 文档", key: "meta.magic.postscript", kind: "document" },
  { off: 0, ascii: "\u0000\u0001\u0000\u0000", label: "TrueType 字体", key: "meta.magic.ttf", mime: "font/ttf", kind: "font" },
  { off: 0, ascii: "OTTO", label: "OpenType 字体（CFF 轮廓）", key: "meta.magic.otf", mime: "font/otf", kind: "font" },
  { off: 0, ascii: "ttcf", label: "TrueType 字体集合", key: "meta.magic.ttc", kind: "font" },
  { off: 0, ascii: "wOFF", label: "WOFF 字体", key: "meta.magic.woff", mime: "font/woff", kind: "font" },
  { off: 0, ascii: "wOF2", label: "WOFF2 字体", key: "meta.magic.woff2", mime: "font/woff2", kind: "font" },
  { off: 0, ascii: "SQLite format 3\u0000", label: "SQLite 数据库", key: "meta.magic.sqlite", mime: "application/vnd.sqlite3", kind: "database" },
  { off: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], label: "ELF 可执行文件 / 目标文件", key: "meta.magic.elf", kind: "program" },
  { off: 0, ascii: "MZ", label: "Windows 可执行文件（PE / DLL / MSI 内嵌）", key: "meta.magic.pe", kind: "program" },
  { off: 0, bytes: [0xfe, 0xed, 0xfa, 0xce], label: "Mach-O 可执行文件（32 位）", key: "meta.magic.macho32", kind: "program" },
  { off: 0, bytes: [0xfe, 0xed, 0xfa, 0xcf], label: "Mach-O 可执行文件（64 位）", key: "meta.magic.macho64", kind: "program" },
  { off: 0, bytes: [0xce, 0xfa, 0xed, 0xfe], label: "Mach-O 通用二进制", key: "meta.magic.macho_fat", kind: "program" },
  { off: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe], label: "Mach-O 通用二进制（64 位）", key: "meta.magic.macho_fat64", kind: "program" },
  { off: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], label: "Java class / Mach-O 通用二进制", key: "meta.magic.java_class", kind: "program" },
  { off: 0, bytes: [0x00, 0x61, 0x73, 0x6d], label: "WebAssembly 模块", key: "meta.magic.wasm", kind: "program" },
  { off: 0, bytes: [0x4c, 0x00, 0x00, 0x00], label: "Windows 快捷方式（.lnk）", key: "meta.magic.lnk", kind: "program" },
  { off: 0, bytes: [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50], label: "JPEG 2000 图像", key: "meta.magic.jpeg2000", kind: "image" },
  { off: 0, ascii: "gimp xcf", label: "GIMP 图像", key: "meta.magic.gimp", kind: "image" },
  { off: 0, bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], label: "（前 8 字节全为 0，未能识别）", key: "meta.magic.zero_bytes", kind: "unknown" },
]

/** ftyp 里的品牌 -> 说明（MP4 / HEIC / AVIF 都是这个盒子）；第 4 项是文案的命名键 */
const FTYP_BRANDS = {
  isom: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  iso2: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  iso4: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  iso5: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  iso6: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  mp41: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  mp42: ["MP4 视频", "video/mp4", "video", "meta.magic.mp4"],
  avc1: ["MP4 视频（H.264）", "video/mp4", "video", "meta.magic.mp4_h264"],
  dash: ["MP4 视频（DASH 分片）", "video/mp4", "video", "meta.magic.mp4_dash"],
  M4V: ["MP4 视频", "video/x-m4v", "video", "meta.magic.mp4"],
  M4A: ["MP4 音频", "audio/mp4", "audio", "meta.magic.m4a"],
  M4B: ["MP4 有声书", "audio/mp4", "audio", "meta.magic.m4b"],
  qt: ["QuickTime 影片", "video/quicktime", "video", "meta.magic.quicktime"],
  "3gp4": ["3GPP 视频", "video/3gpp", "video", "meta.magic.three_gpp"],
  "3gp5": ["3GPP 视频", "video/3gpp", "video", "meta.magic.three_gpp"],
  "3g2a": ["3GPP2 视频", "video/3gpp2", "video", "meta.magic.three_gpp2"],
  avif: ["AVIF 图像", "image/avif", "image", "meta.magic.avif"],
  avis: ["AVIF 图像序列", "image/avif", "image", "meta.magic.avif_sequence"],
  heic: ["HEIC 图像（HEVC）", "image/heic", "image", "meta.magic.heic"],
  heix: ["HEIC 图像（HEVC）", "image/heic", "image", "meta.magic.heic"],
  hevc: ["HEIC 图像序列", "image/heic", "image", "meta.magic.heic_sequence"],
  mif1: ["HEIF 图像", "image/heif", "image", "meta.magic.heif"],
  msf1: ["HEIF 图像序列", "image/heif", "image", "meta.magic.heif_sequence"],
  crx: ["Canon CR3 原始图像", "image/x-canon-cr3", "image", "meta.magic.cr3"],
}

/** OOXML（docx / xlsx / pptx）与同类 ZIP 容器：靠内部条目名区分 */
const ZIP_KINDS = [
  { probe: ["word/", "[Content_Types].xml"], label: "Word 文档（docx）", key: "meta.magic.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document", family: "ooxml" },
  { probe: ["xl/", "[Content_Types].xml"], label: "Excel 工作簿（xlsx）", key: "meta.magic.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "document", family: "ooxml" },
  { probe: ["ppt/", "[Content_Types].xml"], label: "PowerPoint 演示文稿（pptx）", key: "meta.magic.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "document", family: "ooxml" },
  { probe: ["AndroidManifest.xml"], label: "Android 应用包（apk）", key: "meta.magic.apk", mime: "application/vnd.android.package-archive", kind: "archive", family: "zip" },
  { probe: ["META-INF/MANIFEST.MF"], label: "Java 归档（jar）", key: "meta.magic.jar", mime: "application/java-archive", kind: "archive", family: "zip" },
  { probe: ["mimetype", "META-INF/container.xml"], label: "EPUB 电子书", key: "meta.magic.epub", mime: "application/epub+zip", kind: "document", family: "zip" },
  { probe: ["docProps/"], label: "OOXML 文档（docx / xlsx / pptx）", key: "meta.magic.ooxml", kind: "document", family: "ooxml" },
  { probe: ["content.xml"], label: "OpenDocument 文档（odt / ods / odp）", key: "meta.magic.opendocument", kind: "document", family: "odf" },
]

function startsWithBytes(buf, off, bytes) {
  if (buf.length < off + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (buf[off + i] !== bytes[i]) return false
  return true
}

function startsWithAscii(buf, off, text) {
  const s = Buffer.from(text, "latin1")
  return startsWithBytes(buf, off, [...s])
}

/** 识别文件签名。返回 { label, labelKey, labelParams, mime, kind, signature } */
function detectMagic(head, size) {
  const signature = hexOf(head, 16)
  if (size === 0) {
    return { label: "空文件（0 字节）", labelKey: "meta.magic.empty_file_zero", kind: "empty", mime: null, family: null, signature }
  }

  const asciiAt = (off, len) => head.subarray(off, off + len).toString("latin1")

  // ISO BMFF：MP4 / MOV / HEIC / AVIF / CR3
  if (head.length >= 12 && asciiAt(4, 4) === "ftyp") {
    const brand = asciiAt(8, 4).trim()
    const hit = FTYP_BRANDS[brand] || FTYP_BRANDS[asciiAt(16, 4).trim()]
    if (!hit) {
      // 品牌认不出来时把品牌名一并交代（品牌可以为空，这里必须与中文原文逐字一致）
      return brand
        ? {
            label: `ISO BMFF 媒体文件（品牌 ${brand}）`,
            labelKey: "meta.magic.iso_bmff_branded",
            labelParams: { brand },
            mime: null,
            kind: "video",
            family: null,
            signature,
          }
        : {
            label: "ISO BMFF 媒体文件（品牌 未知）",
            labelKey: "meta.magic.iso_bmff_unknown_brand",
            mime: null,
            kind: "video",
            family: null,
            signature,
          }
    }
    const [label, mime, kind, key] = hit
    return { label, labelKey: key, mime, kind, family: null, signature }
  }

  // RIFF：WAV / AVI / WebP
  if (asciiAt(0, 4) === "RIFF" && head.length >= 12) {
    const sub = asciiAt(8, 4)
    if (sub === "WAVE") return { label: "WAV 音频", labelKey: "meta.magic.wav", mime: "audio/wav", kind: "audio", family: null, signature }
    if (sub === "AVI ") return { label: "AVI 视频", labelKey: "meta.magic.avi", mime: "video/x-msvideo", kind: "video", family: null, signature }
    if (sub === "WEBP") return { label: "WebP 图像", labelKey: "meta.magic.webp", mime: "image/webp", kind: "image", family: null, signature }
    if (sub === "ACON") return { label: "Animated cursor 图像", labelKey: "meta.magic.animated_cursor", mime: "image/x-icon", kind: "image", family: null, signature }
    const format = sub.trim()
    return format
      ? { label: `RIFF 容器（${format}）`, labelKey: "meta.magic.riff_container", labelParams: { format }, kind: "archive", mime: null, family: null, signature }
      : { label: "RIFF 容器（未知）", labelKey: "meta.magic.riff_container_unknown_format", kind: "archive", mime: null, family: null, signature }
  }

  // MPEG-TS：每 188 字节一个 0x47 同步字节
  if (head[0] === 0x47 && head.length > 188 && head[188] === 0x47) {
    return { label: "MPEG 传输流（.ts）", labelKey: "meta.magic.mpeg_ts", mime: "video/mp2t", kind: "video", family: null, signature }
  }
  // MP3：无 ID3 时的帧同步。注意 UTF-16 文本的 BOM（FF FE / FE FF）长得和
  // MPEG 帧同步一模一样，必须先让文本检测裁决，否则 txt 会被认成音频。
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    const bom16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
    const detected = bom16 ? detectEncoding(head) : null
    if (detected && (detected.encoding === "utf16le" || detected.encoding === "utf16be")) {
      // UTF-16 文本天然含 NUL 字节，looksBinary 会误判成二进制，这里直接定性
      return detected.encoding === "utf16le"
        ? {
            label: "纯文本（UTF-16 LE）",
            labelKey: "meta.magic.plain_text_utf16le",
            mime: "text/plain",
            kind: "text",
            family: null,
            signature,
          }
        : {
            label: "纯文本（UTF-16 BE）",
            labelKey: "meta.magic.plain_text_utf16be",
            mime: "text/plain",
            kind: "text",
            family: null,
            signature,
          }
    }
    return { label: "MP3 音频", labelKey: "meta.magic.mp3", mime: "audio/mpeg", kind: "audio", family: null, signature }
  }
  // TAR：偏移 257 处的 ustar
  if (asciiAt(257, 5) === "ustar") {
    return { label: "TAR 归档", labelKey: "meta.magic.tar", mime: "application/x-tar", kind: "archive", family: null, signature }
  }

  for (const sig of SIGNATURES) {
    const ok = sig.bytes ? startsWithBytes(head, sig.off, sig.bytes) : startsWithAscii(head, sig.off, sig.ascii)
    if (!ok) continue
    if (sig.kind === "unknown") break // 兜底项留到最后判断，别抢在文本判断前面
    if (sig.kind === "archive" && sig.mime === "application/zip") {
      // 少数打包工具（例如 Windows 的 Compress-Archive）用反斜杠分隔条目名，
      // 探测时统一成正斜杠，否则同一个 zip 在这台机器上认不出是 docx
      const raw = head.toString("latin1")
      const probeText = raw.includes("\\") ? raw.replace(/\\/g, "/") : raw
      for (const z of ZIP_KINDS) {
        if (z.probe.every((p) => probeText.includes(p))) {
          return { label: z.label, labelKey: z.key, mime: z.mime ?? null, kind: z.kind, family: z.family, signature }
        }
      }
    }
    return { label: sig.label, labelKey: sig.key, mime: sig.mime ?? null, kind: sig.kind, family: null, signature }
  }

  if (size === 0) return { label: "空文件", labelKey: "meta.magic.empty_file", kind: "empty", mime: null, family: null, signature }
  if (!looksBinary(head)) {
    return { label: "纯文本", labelKey: "meta.magic.plain_text", mime: "text/plain", kind: "text", family: null, signature }
  }
  return { label: "未知二进制数据", labelKey: "meta.magic.unknown_binary", kind: "unknown", mime: null, family: null, signature }
}

/* ============================== 图片尺寸 ============================== */

function jpegSize(buf) {
  let i = 2
  while (i + 9 <= buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) break
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function webpSize(buf) {
  const type = buf.subarray(12, 16).toString("latin1")
  if (type === "VP8X" && buf.length >= 30) {
    return {
      width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
    }
  }
  if (type === "VP8 " && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (type === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function imageSize(head, magic) {
  try {
    switch (magic.label.split("（")[0]) {
      case "PNG 图像":
        if (head.subarray(12, 16).toString("latin1") !== "IHDR") return null
        return {
          width: head.readUInt32BE(16),
          height: head.readUInt32BE(20),
          bitDepth: head[24],
          colorType: head[25],
          interlaced: head[28] === 1,
        }
      case "JPEG 图像":
        return jpegSize(head)
      case "GIF 图像":
        return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
      case "BMP 图像":
        return { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)), bitDepth: head.readUInt16LE(28) }
      case "WebP 图像":
        return webpSize(head)
      case "ICO 图标":
        return { width: head[6] || 256, height: head[7] || 256 }
      case "Photoshop 文档":
        return { height: head.readUInt32BE(14), width: head.readUInt32BE(18) }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** PNG 色彩类型 -> 文案（key 给界面查字典用，label 是中文原文兜底） */
const PNG_COLOR = {
  0: { key: "meta.image.color_grayscale", label: "灰度" },
  2: { key: "meta.image.color_truecolor", label: "真彩色（RGB）" },
  3: { key: "meta.image.color_indexed", label: "索引色" },
  4: { key: "meta.image.color_grayscale_alpha", label: "灰度 + Alpha" },
  6: { key: "meta.image.color_truecolor_alpha", label: "真彩色 + Alpha" },
}

/* ============================== EXIF ============================== */

/**
 * EXIF / GPS 字段表：键是 TIFF 标签号（查表用的值，不要改），值是该字段的
 * 命名键与中文原文。formatExif() 按**命名键**分支，不再拿中文当分支条件。
 */
const TAG_IFD0 = {
  0x0100: { key: "meta.exif.image_width", label: "图像宽度" },
  0x0101: { key: "meta.exif.image_height", label: "图像高度" },
  0x010e: { key: "meta.exif.image_description", label: "图像描述" },
  0x010f: { key: "meta.exif.make", label: "相机厂商" },
  0x0110: { key: "meta.exif.model", label: "相机型号" },
  0x0112: { key: "meta.exif.orientation", label: "方向" },
  0x011a: { key: "meta.exif.x_resolution", label: "水平分辨率" },
  0x011b: { key: "meta.exif.y_resolution", label: "垂直分辨率" },
  0x0128: { key: "meta.exif.resolution_unit", label: "分辨率单位" },
  0x0131: { key: "meta.exif.software", label: "生成软件" },
  0x0132: { key: "meta.exif.modify_date", label: "文件修改时间" },
  0x013b: { key: "meta.exif.artist", label: "作者（Artist）" },
  0x013c: { key: "meta.exif.host_computer", label: "主机" },
  0x8298: { key: "meta.exif.copyright", label: "版权" },
}

const TAG_EXIF = {
  0x829a: { key: "meta.exif.exposure_time", label: "曝光时间" },
  0x829d: { key: "meta.exif.f_number", label: "光圈（F 值）" },
  0x8822: { key: "meta.exif.exposure_program", label: "曝光程序" },
  0x8827: { key: "meta.exif.iso", label: "ISO 感光度" },
  0x9000: { key: "meta.exif.exif_version", label: "EXIF 版本" },
  0x9003: { key: "meta.exif.datetime_original", label: "拍摄时间" },
  0x9004: { key: "meta.exif.datetime_digitized", label: "数字化时间" },
  0x9101: { key: "meta.exif.components_configuration", label: "分量配置" },
  0x9201: { key: "meta.exif.shutter_speed", label: "快门速度" },
  0x9202: { key: "meta.exif.aperture_value", label: "光圈值（APEX）" },
  0x9204: { key: "meta.exif.exposure_bias", label: "曝光补偿" },
  0x9207: { key: "meta.exif.metering_mode", label: "测光模式" },
  0x9209: { key: "meta.exif.flash", label: "闪光灯" },
  0x920a: { key: "meta.exif.focal_length", label: "焦距" },
  0x9286: { key: "meta.exif.user_comment", label: "用户注释" },
  0x9290: { key: "meta.exif.subsec_time_original", label: "秒以下时间（原始）" },
  0xa001: { key: "meta.exif.color_space", label: "色彩空间" },
  0xa002: { key: "meta.exif.pixel_x_dimension", label: "像素宽度" },
  0xa003: { key: "meta.exif.pixel_y_dimension", label: "像素高度" },
  0xa403: { key: "meta.exif.white_balance", label: "白平衡" },
  0xa405: { key: "meta.exif.focal_length_35mm", label: "35mm 等效焦距" },
  0xa431: { key: "meta.exif.body_serial_number", label: "机身序列号" },
  0xa432: { key: "meta.exif.lens_specification", label: "镜头规格" },
  0xa433: { key: "meta.exif.lens_make", label: "镜头厂商" },
  0xa434: { key: "meta.exif.lens_model", label: "镜头型号" },
  0xa435: { key: "meta.exif.lens_serial_number", label: "镜头序列号" },
}

const TAG_GPS = {
  0x0001: { key: "meta.exif.gps_latitude", label: "GPS 纬度" },
  0x0002: { key: "meta.exif.gps_latitude_ref", label: "纬度方向" },
  0x0003: { key: "meta.exif.gps_longitude", label: "GPS 经度" },
  0x0004: { key: "meta.exif.gps_longitude_ref", label: "经度方向" },
  0x0005: { key: "meta.exif.gps_altitude", label: "GPS 海拔" },
  0x0006: { key: "meta.exif.gps_altitude_ref", label: "海拔方向" },
  0x0007: { key: "meta.exif.gps_time", label: "GPS 时间" },
  0x001d: { key: "meta.exif.gps_date", label: "GPS 日期" },
}

/**
 * 下面几张枚举表：TIFF 里的数字（查表用的值，不要改）-> 显示文案。
 * 没有 key 的项说明文案是 ASCII（sRGB / Adobe RGB），任何语言下都无需翻译。
 */
const ORIENTATION = {
  1: { key: "meta.exif.orientation_normal", label: "正常" },
  2: { key: "meta.exif.orientation_mirror_horizontal", label: "水平镜像" },
  3: { key: "meta.exif.orientation_rotate_180", label: "旋转 180°" },
  4: { key: "meta.exif.orientation_mirror_vertical", label: "垂直镜像" },
  5: { key: "meta.exif.orientation_rotate_90_cw_mirrored", label: "顺时针 90° 后镜像" },
  6: { key: "meta.exif.orientation_rotate_90_cw", label: "顺时针 90°" },
  7: { key: "meta.exif.orientation_rotate_90_ccw_mirrored", label: "逆时针 90° 后镜像" },
  8: { key: "meta.exif.orientation_rotate_90_ccw", label: "逆时针 90°" },
}
const EXPOSURE_PROGRAM = {
  1: { key: "meta.exif.exposure_program_manual", label: "手动" },
  2: { key: "meta.exif.exposure_program_normal", label: "程序自动" },
  3: { key: "meta.exif.exposure_program_aperture_priority", label: "光圈优先" },
  4: { key: "meta.exif.exposure_program_shutter_priority", label: "快门优先" },
  5: { key: "meta.exif.exposure_program_creative", label: "创意模式" },
  6: { key: "meta.exif.exposure_program_action", label: "运动模式" },
  7: { key: "meta.exif.exposure_program_portrait", label: "人像模式" },
  8: { key: "meta.exif.exposure_program_landscape", label: "风景模式" },
  9: { key: "meta.exif.exposure_program_low_gain", label: "低感光度" },
}
const METERING = {
  0: { key: "meta.exif.metering_unknown", label: "未知" },
  1: { key: "meta.exif.metering_average", label: "平均测光" },
  2: { key: "meta.exif.metering_center_weighted", label: "中央重点" },
  3: { key: "meta.exif.metering_spot", label: "点测光" },
  4: { key: "meta.exif.metering_multi_spot", label: "多点测光" },
  5: { key: "meta.exif.metering_pattern", label: "评价测光" },
  6: { key: "meta.exif.metering_partial", label: "局部测光" },
}
const COLOR_SPACE = {
  1: { label: "sRGB" },
  2: { label: "Adobe RGB" },
  65535: { key: "meta.exif.color_space_uncalibrated", label: "未校准" },
}
const WHITE_BALANCE = {
  0: { key: "meta.exif.white_balance_auto", label: "自动" },
  1: { key: "meta.exif.white_balance_manual", label: "手动" },
}
const RESOLUTION_UNIT = {
  1: { key: "meta.exif.resolution_unit_none", label: "无单位" },
  2: { key: "meta.exif.resolution_unit_inch", label: "英寸" },
  3: { key: "meta.exif.resolution_unit_centimeter", label: "厘米" },
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

/** 按 TIFF 规范读一个 IFD 条目的值（count > 1 时返回数组） */
function readTiffValue(buf, le, type, count, entryOff) {
  const size = (TYPE_SIZE[type] || 0) * count
  if (!size) return null
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const off = size <= 4 ? entryOff + 8 : u32(entryOff + 8)
  if (off < 0 || off + size > buf.length) return null
  const values = []
  for (let i = 0; i < count; i++) {
    const o = off + i * (TYPE_SIZE[type] || 1)
    let v
    switch (type) {
      case 2:
        v = buf[o]
        break
      case 3:
        v = le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)
        break
      case 4:
        v = u32(o)
        break
      case 5:
        v = { num: u32(o), den: u32(o + 4) }
        break
      case 9:
        v = le ? buf.readInt32LE(o) : buf.readInt32BE(o)
        break
      case 10:
        v = { num: le ? buf.readInt32LE(o) : buf.readInt32BE(o), den: le ? buf.readInt32LE(o + 4) : buf.readInt32BE(o + 4) }
        break
      default:
        v = buf[o]
    }
    values.push(v)
  }
  if (type === 2) {
    const raw = Buffer.from(values.map((c) => c || 0))
    return raw.toString("latin1").replace(/\u0000+$/, "")
  }
  return count === 1 ? values[0] : values
}

/** 解析 TIFF / EXIF 结构（JPEG 的 APP1、PNG 的 eXIf、TIFF 文件本体都走这里） */
function parseExif(buf) {
  if (buf.length < 8) return null
  const head2 = buf.subarray(0, 2).toString("latin1")
  const le = head2 === "II"
  if (!le && head2 !== "MM") return null
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  if (u16(2) !== 0x2a) return null

  const rows = []
  const seen = new Set()

  const walk = (ifdOff, tags, prefix) => {
    if (!ifdOff || ifdOff + 2 > buf.length || seen.has(ifdOff)) return
    seen.add(ifdOff)
    const count = u16(ifdOff)
    if (count > 512) return
    for (let i = 0; i < count; i++) {
      const e = ifdOff + 2 + i * 12
      if (e + 12 > buf.length) return
      const tag = u16(e)
      const type = u16(e + 2)
      const n = u32(e + 4)
      const field = tags[tag]
      let value = null
      try {
        value = readTiffValue(buf, le, type, n, e)
      } catch {
        value = null
      }
      if (tag === 0x8769 && typeof value === "number") walk(value, TAG_EXIF, "")
      else if (tag === 0x8825 && typeof value === "number") walk(value, TAG_GPS, "")
      else if (field) {
        const text = formatExif(field.key, value)
        if (text) rows.push({ key: prefix + field.key, label: prefix + field.label, ...text })
      }
    }
  }

  walk(u32(4), TAG_IFD0, "")
  return rows.length ? rows : null
}

/**
 * 把 EXIF 原始值变成人能读的文案。
 *
 * 按**命名键**分支（不再拿中文当分支条件）。返回值是
 * `{ value, unitKey?, valueKey? }`：value 只含数值/文案本身，单位与枚举文案各带一个键，
 * 前端按 `${value} ${t(unitKey)}` 拼；返回 null 表示这条不值得展示。
 */
function formatExif(key, value) {
  if (value === null || value === undefined || value === "") return null
  try {
    switch (key) {
      case "meta.exif.orientation":
        return enumText(ORIENTATION, value)
      case "meta.exif.exposure_program":
        return enumText(EXPOSURE_PROGRAM, value)
      case "meta.exif.metering_mode":
        return enumText(METERING, value)
      case "meta.exif.color_space":
        return enumText(COLOR_SPACE, value)
      case "meta.exif.white_balance":
        return value === 0 || value === 1 ? enumText(WHITE_BALANCE, value) : { value: String(value) }
      case "meta.exif.flash": {
        if (typeof value !== "number") return { value: String(value) }
        const fired = value & 0x1
        const redEye = value & 0x40
        const text = `${fired ? "闪光" : "未闪光"}${redEye ? "（防红眼）" : ""}`
        const valueKey = fired
          ? redEye
            ? "meta.exif.flash_fired_red_eye"
            : "meta.exif.flash_fired"
          : redEye
            ? "meta.exif.flash_not_fired_red_eye"
            : "meta.exif.flash_not_fired"
        return { value: text, valueKey }
      }
      case "meta.exif.exposure_time":
      case "meta.exif.shutter_speed":
        return rationalText(value, "meta.unit.second", true)
      case "meta.exif.f_number":
        return { value: `f/${num(rational(value)).toFixed(1)}` }
      case "meta.exif.aperture_value":
        return { value: `f/${Math.pow(2, num(rational(value)) / 2).toFixed(1)}（APEX ${num(rational(value))}）` }
      case "meta.exif.focal_length":
      case "meta.exif.focal_length_35mm":
        return { value: num(rational(value)).toFixed(0), unitKey: "meta.unit.mm" }
      case "meta.exif.exposure_bias": {
        const v = num(rational(value))
        return { value: `${v > 0 ? "+" : ""}${v.toFixed(2)}`, unitKey: "meta.unit.ev" }
      }
      case "meta.exif.x_resolution":
      case "meta.exif.y_resolution":
        return { value: String(num(rational(value))), unitKey: "meta.unit.dpi" }
      case "meta.exif.iso":
        return { value: `ISO ${Array.isArray(value) ? value[0] : value}` }
      case "meta.exif.datetime_original":
      case "meta.exif.datetime_digitized":
      case "meta.exif.modify_date":
        return { value: exifDate(String(value)) }
      case "meta.exif.user_comment": {
        const text = String(value).replace(/^(ASCII|UNICODE|JIS)\u0000+/, "").trim()
        return text ? { value: text } : null
      }
      case "meta.exif.gps_latitude":
      case "meta.exif.gps_longitude":
        // 度数符号紧贴数字（`37.123456°`），拆成「值 + 单位」会多出一个空格，故整体留在 value 里
        return { value: gpsText(value) }
      case "meta.exif.gps_altitude":
        return { value: num(rational(value)).toFixed(1), unitKey: "meta.unit.meter" }
      case "meta.exif.lens_specification":
        return Array.isArray(value)
          ? { value: value.map((v) => num(rational(v)).toFixed(0)).join("-"), unitKey: "meta.unit.mm" }
          : { value: String(value) }
      case "meta.exif.resolution_unit":
        return enumText(RESOLUTION_UNIT, value)
      default:
        return { value: String(value) }
    }
  } catch {
    return null
  }
}

/** 枚举表的统一取值：数字查表（值本身别改），命中就给 valueKey，未命中退回数字 */
function enumText(table, value) {
  const hit = table[value]
  if (!hit) return { value: String(value) }
  return hit.key ? { value: hit.label, valueKey: hit.key } : { value: hit.label }
}

function rational(v) {
  if (v && typeof v === "object" && "num" in v) return v
  return { num: Number(v) || 0, den: 1 }
}
function num(r) {
  const { num: n, den: d } = rational(r)
  return d ? n / d : 0
}
function rationalText(v, unitKey, asFraction) {
  const value = num(rational(v))
  if (!value) return null
  if (asFraction && value < 1) return { value: `1/${Math.round(1 / value)}`, unitKey }
  return { value: String(Number(value.toFixed(4))), unitKey }
}
function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : s.trim()
}
function gpsText(value) {
  if (!Array.isArray(value) || value.length < 3) return String(value)
  const [d, m, s] = value.map((v) => num(rational(v)))
  const deg = d + m / 60 + s / 3600
  return `${deg.toFixed(6)}°`
}

/** JPEG 的 APP1 段里找 EXIF */
function exifFromJpeg(buf) {
  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) break // 之后是压缩数据
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) break
    if (marker === 0xe1 && buf.subarray(i + 4, i + 10).toString("latin1") === "Exif\u0000\u0000") {
      return buf.subarray(i + 10, i + 2 + len)
    }
    i += 2 + len
  }
  return null
}

/* ============================== PNG 分块 ============================== */

/** PNG 文本块的常见键名（PNG 规范推荐用英文关键字，这里翻成中文更好读） */
const PNG_KEY = {
  Title: { key: "meta.doc.title", label: "标题" },
  Author: { key: "meta.doc.author", label: "作者" },
  Description: { key: "meta.doc.description", label: "描述" },
  Copyright: { key: "meta.doc.copyright", label: "版权" },
  "Creation Time": { key: "meta.doc.creation_time", label: "创建时间" },
  Software: { key: "meta.doc.software", label: "生成软件" },
  Disclaimer: { key: "meta.doc.disclaimer", label: "免责声明" },
  Warning: { key: "meta.doc.warning", label: "警告" },
  Source: { key: "meta.doc.source", label: "来源" },
  Comment: { key: "meta.doc.comment", label: "备注" },
  "PNG 修改时间": { key: "meta.doc.png_modified_time", label: "PNG 修改时间" }, // tIME 块也走这张表
}

/** PNG 的 tEXt / iTXt / tIME / eXIf —— 图片的「作者 / 软件 / 创建时间」常在这里 */
function pngChunks(buf) {
  const meta = []
  let exifBuf = null
  let i = 8
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    if (len < 0 || i + 12 + len > buf.length) break
    const type = buf.subarray(i + 4, i + 8).toString("latin1")
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === "tEXt") {
      const z = data.indexOf(0)
      if (z > 0) meta.push([data.subarray(0, z).toString("latin1"), cleanText(data.subarray(z + 1).toString("latin1"))])
    } else if (type === "iTXt") {
      const z = data.indexOf(0)
      if (z > 0) {
        const rest = data.subarray(z + 1)
        // 压缩标志(1) + 压缩方法(1) + 语言(0 结尾) + 翻译键(0 结尾) + 正文
        if (!rest[0]) {
          let p = 2
          const langEnd = rest.indexOf(0, p)
          const keyEnd = rest.indexOf(0, langEnd + 1)
          if (langEnd > 0 && keyEnd > 0) {
            meta.push([data.subarray(0, z).toString("latin1"), cleanText(rest.subarray(keyEnd + 1).toString("utf8"))])
          }
        }
      }
    } else if (type === "tIME" && len >= 7) {
      const p = (n) => String(n).padStart(2, "0")
      meta.push(["PNG 修改时间", `${data.readUInt16BE(0)}-${p(data[2])}-${p(data[3])} ${p(data[4])}:${p(data[5])}:${p(data[6])}`])
    } else if (type === "eXIf") {
      exifBuf = data
    } else if (type === "IDAT" || type === "IEND") {
      break
    }
    i += 12 + len
  }
  return { meta, exifBuf }
}

function cleanText(s) {
  return String(s).replace(/\u0000+$/, "").trim()
}

/* ============================== PDF ============================== */

/** UTF-16BE → 字符串。必须自己拷贝：swap16() 是原地修改，会污染复用的 head */
function utf16beToString(buf) {
  const even = buf.length - (buf.length % 2)
  const copy = Buffer.from(buf.subarray(0, even))
  copy.swap16()
  return copy.toString("utf16le")
}

function pdfDecode(raw) {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== "\\") {
      out += c
      continue
    }
    const n = raw[i + 1]
    if (n === "n") out += "\n"
    else if (n === "r") out += "\r"
    else if (n === "t") out += "\t"
    else if (n === "b" || n === "f") out += ""
    else if (n >= "0" && n <= "7") {
      const oct = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0]
      out += String.fromCharCode(parseInt(oct, 8))
      i += oct.length
    } else out += n ?? ""
    i++
  }
  return out
}

function pdfText(raw) {
  // PDF 里的中文作者名普遍写成带 BOM 的 UTF-16BE；原始的 FE FF 在这里是
  // latin1 的两个字符，所以按字节判断而不是按 \uFEFF 判断。
  if (/^\u00fe\u00ff/.test(raw)) {
    try {
      return cleanText(utf16beToString(Buffer.from(raw.slice(2), "latin1")))
    } catch {
      return cleanText(raw.slice(2))
    }
  }
  return cleanText(pdfDecode(raw))
}

const PDF_FIELDS = {
  Title: { key: "meta.doc.document_title", label: "文档标题" },
  Author: { key: "meta.doc.author", label: "作者" },
  Subject: { key: "meta.doc.subject", label: "主题" },
  Keywords: { key: "meta.doc.keywords", label: "关键词" },
  Creator: { key: "meta.doc.creator", label: "创建程序" },
  Producer: { key: "meta.doc.producer", label: "生成工具" },
  CreationDate: { key: "meta.doc.creation_time", label: "创建时间" },
  ModDate: { key: "meta.doc.modified_time", label: "修改时间" },
}

function pdfInfo(parts) {
  const rows = []
  const text = Buffer.concat(parts).toString("latin1")
  for (const [name, field] of Object.entries(PDF_FIELDS)) {
    const m = new RegExp(`/${name}\\s*\\(((?:\\\\.|[^\\\\()])*)\\)`).exec(text)
    if (!m) continue
    let value = pdfText(m[1])
    if (!value) continue
    if (/Date$/.test(name)) value = pdfDate(value)
    if (rows.some((r) => r.key === field.key)) continue
    rows.push({ key: field.key, label: field.label, value })
  }
  const version = /^%PDF-(\d\.\d)/.exec(text)
  if (version) rows.unshift({ key: "meta.doc.pdf_version", label: "PDF 版本", value: version[1] })
  return rows
}

function pdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s)
  if (!m) return s
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00"] = m
  const tz = /([+-])(\d{2})'?(\d{2})?/.exec(s.slice(m[0].length))
  const zone = tz ? ` UTC${tz[1]}${tz[2]}:${tz[3] || "00"}` : ""
  return `${y}-${mo}-${d} ${h}:${mi}:${se}${zone}`
}

/* ============================== ZIP / OOXML ============================== */

/** 在 ZIP 里定位一个条目（只认本地文件头，够用且不需要读整个中央目录） */
function findZipEntry(buf, name) {
  const target = Buffer.from(name, "latin1")
  let i = 0
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      i++
      continue
    }
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    if (buf.subarray(i + 30, i + 30 + nameLen).equals(target)) {
      return {
        method: buf.readUInt16LE(i + 8),
        compSize: buf.readUInt32LE(i + 18),
        dataStart: i + 30 + nameLen + extraLen,
      }
    }
    i += 4
  }
  return null
}

/** 读出并解压一个 ZIP 条目（deflate 用内置 zlib，store 直接切片） */
async function readZipEntry(abs, buf, name) {
  const entry = findZipEntry(buf, name)
  if (!entry) return null
  let compSize = entry.compSize
  if (!compSize) {
    // 本地头里写了 0 说明用了 data descriptor，压缩数据后面跟着 PK\x07\x08 + 两个长度
    const after = await readRange(abs, entry.dataStart, 512 * 1024)
    const at = after.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
    if (at < 0) return null
    compSize = after.readUInt32LE(at + 4)
  }
  if (compSize <= 0 || compSize > 4 * 1024 * 1024) return null
  const data = await readRange(abs, entry.dataStart, compSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) return null
  try {
    return zlib.inflateRawSync(data)
  } catch {
    return null
  }
}

function xmlTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)
  if (!m) return null
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim() || null
}

/** docx / xlsx / pptx 的 docProps：作者、最后修改者、公司、页数、字数都在这里 */
async function ooxmlInfo(abs, head) {
  const rows = []
  // 条目名在个别工具产出的包里用反斜杠，两种都试一次
  const read = (name) => readZipEntry(abs, head, name).then((b) => b ?? readZipEntry(abs, head, name.replace(/\//g, "\\")))
  const core = await read("docProps/core.xml")
  if (core) {
    const xml = core.toString("utf8")
    const fields = [
      ["dc:title", "meta.doc.title", "标题"],
      ["dc:creator", "meta.doc.created_by", "创建者"],
      ["cp:lastModifiedBy", "meta.doc.last_modified_by", "最后修改者"],
      ["dcterms:created", "meta.doc.creation_time", "创建时间"],
      ["dcterms:modified", "meta.doc.modified_time", "修改时间"],
      ["cp:revision", "meta.doc.revision", "修订次数"],
      ["dc:subject", "meta.doc.subject", "主题"],
      ["dc:description", "meta.doc.comment", "备注"],
      ["cp:keywords", "meta.doc.keywords", "关键词"],
      ["cp:category", "meta.doc.category", "分类"],
    ]
    for (const [tag, key, label] of fields) {
      let value = xmlTag(xml, tag)
      if (!value) continue
      if (/^dcterms:(created|modified)$/.test(tag)) value = isoTimestamp(value)
      rows.push({ key, label, value })
    }
  }
  const app = await read("docProps/app.xml")
  if (app) {
    const xml = app.toString("utf8")
    const fields = [
      ["Application", "meta.doc.application", "生成程序"],
      ["Company", "meta.doc.company", "公司"],
      ["Manager", "meta.doc.manager", "管理者"],
      ["Pages", "meta.doc.pages", "页数"],
      ["Words", "meta.doc.word_count", "字数"],
      ["Characters", "meta.doc.character_count", "字符数"],
      ["Slides", "meta.doc.slides", "幻灯片数"],
      ["Sheets", "meta.doc.sheets", "工作表数"],
      ["TotalTime", "meta.doc.total_edit_minutes", "累计编辑分钟"],
      ["Template", "meta.doc.template", "模板"],
    ]
    for (const [tag, key, label] of fields) {
      const value = xmlTag(xml, tag)
      if (value) rows.push({ key, label, value })
    }
  }
  return rows
}

function isoTimestamp(s) {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/* ============================== 音视频 ============================== */

/**
 * MP4 / MOV / M4A 的时长：沿顶层 box 走到 moov，再在 moov 开头找 mvhd。
 *
 * 不能只搜头尾两段 —— 未做 faststart 的 MP4 会把 moov 放在文件末尾，而 moov
 * 完全可能大于 64KB（封面、章节、多音轨都在里面），那样 mvhd 就落在窗口外面。
 * 这里只读 box 头（每步 16 字节），成本可以忽略。
 */
async function mp4Duration(abs, size) {
  let pos = 0
  for (let guard = 0; guard < 64 && pos + 8 <= size; guard++) {
    const header = await readRange(abs, pos, 16)
    if (header.length < 8) return null
    let boxSize = header.readUInt32BE(0)
    const type = header.subarray(4, 8).toString("latin1")
    let headerLen = 8
    if (boxSize === 1) {
      if (header.length < 16) return null
      boxSize = Number(header.readBigUInt64BE(8))
      headerLen = 16
    } else if (boxSize === 0) {
      boxSize = size - pos
    }
    if (boxSize < headerLen) return null

    if (type === "moov") {
      const payload = await readRange(abs, pos + headerLen, Math.min(boxSize - headerLen, 256 * 1024))
      const at = payload.indexOf(Buffer.from("mvhd", "latin1"))
      if (at < 0) return null
      try {
        if (payload[at + 4] === 1) {
          const timescale = payload.readUInt32BE(at + 24)
          const duration = Number(payload.readBigUInt64BE(at + 28))
          if (timescale > 0 && duration > 0) return duration / timescale
        } else {
          const timescale = payload.readUInt32BE(at + 16)
          const duration = payload.readUInt32BE(at + 20)
          if (timescale > 0 && duration > 0 && duration !== 0xffffffff) return duration / timescale
        }
      } catch {
        /* 结构不对就当拿不到 */
      }
      return null
    }
    pos += boxSize
  }
  return null
}

function wavInfo(head) {
  const out = []
  let byteRate = 0
  let dataSize = 0
  let i = 12
  while (i + 8 <= head.length) {
    const id = head.subarray(i, i + 4).toString("latin1")
    const size = head.readUInt32LE(i + 4)
    if (id === "fmt " && size >= 16) {
      const channels = head.readUInt16LE(i + 10)
      const sampleRate = head.readUInt32LE(i + 12)
      const bits = head.readUInt16LE(i + 22)
      byteRate = head.readUInt32LE(i + 16)
      out.push(
        { key: "meta.media.channels", label: "声道数", value: String(channels) },
        { key: "meta.media.sample_rate", label: "采样率", value: String(sampleRate), unitKey: "meta.unit.hz" },
        { key: "meta.media.bit_depth", label: "位深", value: String(bits), unitKey: "meta.unit.bit" }
      )
    } else if (id === "data") {
      dataSize = size
    }
    i += 8 + size + (size % 2)
  }
  if (byteRate && dataSize) {
    const sec = secondsText(dataSize / byteRate)
    if (sec) out.push({ key: "meta.media.duration", label: "时长", ...sec })
  }
  return out
}

function flacInfo(head) {
  if (head.length < 26) return []
  const b = head.subarray(18, 26)
  const sampleRate = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4)
  const channels = ((b[2] >> 1) & 0x07) + 1
  const bits = (((b[2] & 0x01) << 4) | (b[3] >> 4)) + 1
  const total = (b[3] & 0x0f) * 2 ** 32 + b.readUInt32BE(4)
  const out = [
    { key: "meta.media.sample_rate", label: "采样率", value: String(sampleRate), unitKey: "meta.unit.hz" },
    { key: "meta.media.channels", label: "声道数", value: String(channels) },
    { key: "meta.media.bit_depth", label: "位深", value: String(bits), unitKey: "meta.unit.bit" },
  ]
  if (sampleRate > 0 && total > 0) {
    const sec = secondsText(total / sampleRate)
    if (sec) out.push({ key: "meta.media.duration", label: "时长", ...sec })
  }
  return out
}

/** ID3 的 UTF-16：enc=1 是"带 BOM"，enc=2 是不带 BOM 的大端 */
function decodeUtf16(body, enc) {
  // BOM 决定字节序：FF FE = 小端（数据本身就是 utf16le，不能再 swap），
  // FE FF = 大端（要换成小端再交给 Node 解码）
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    const even = body.length - 2 - ((body.length - 2) % 2)
    return body.subarray(2, 2 + even).toString("utf16le")
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return utf16beToString(body.subarray(2))
  return utf16beToString(body)
}

/** ID3v2：标题 / 艺术家 / 专辑 …… 音频文件的「创建者」基本都在这里 */
function id3Info(head) {
  if (head.subarray(0, 3).toString("latin1") !== "ID3" || head.length < 10) return []
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
  const end = Math.min(10 + size, head.length)
  const frames = {
    TIT2: { key: "meta.media.title", label: "标题" },
    TPE1: { key: "meta.media.artist", label: "艺术家" },
    TPE2: { key: "meta.media.album_artist", label: "专辑艺术家" },
    TALB: { key: "meta.media.album", label: "专辑" },
    TDRC: { key: "meta.media.year", label: "年份" },
    TYER: { key: "meta.media.year", label: "年份" },
    TRCK: { key: "meta.media.track", label: "音轨" },
    TCON: { key: "meta.media.genre", label: "流派" },
    TCOM: { key: "meta.media.composer", label: "作曲" },
    TENC: { key: "meta.media.encoder", label: "编码者" },
    TSSE: { key: "meta.media.encoder_software", label: "编码软件" },
    COMM: { key: "meta.media.comment", label: "备注" },
  }
  const rows = []
  let i = 10
  while (i + 10 <= end) {
    const id = head.subarray(i, i + 4).toString("latin1")
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const fsize = head.readUInt32BE(i + 4)
    if (fsize <= 0 || i + 10 + fsize > end) break
    const field = frames[id]
    if (field && !rows.some((r) => r.key === field.key)) {
      const enc = head[i + 10]
      const body = head.subarray(i + 11, i + 10 + fsize)
      let text = ""
      try {
        if (enc === 1 || enc === 2) text = decodeUtf16(body, enc)
        else if (enc === 3) text = body.toString("utf8")
        else text = body.toString("latin1")
      } catch {
        text = body.toString("latin1")
      }
      text = cleanText(text.replace(/\u0000/g, ""))
      if (text) rows.push({ key: field.key, label: field.label, value: text })
    }
    i += 10 + fsize
  }
  return rows
}

/**
 * 时长文案：`3:05（185 秒）`。
 * 括号里的秒数与时间串都交给字典插值（`{time}` / `{sec}`），中文界面逐字不变。
 */
function secondsText(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, "0")
  const time = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  return {
    value: `${time}（${total} 秒）`,
    valueKey: "meta.media.duration_text",
    valueParams: { time, sec: total },
  }
}

/* ============================== 哈希 ============================== */

async function hashFile(abs) {
  const md5 = crypto.createHash("md5")
  const sha1 = crypto.createHash("sha1")
  const sha256 = crypto.createHash("sha256")
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(abs)
    stream.on("data", (chunk) => {
      md5.update(chunk)
      sha1.update(chunk)
      sha256.update(chunk)
    })
    stream.on("end", resolve)
    stream.on("error", reject)
  })
  // 注意：同一个 Hash 对象只能 digest 一次，base64url 版本从十六进制结果换算
  const sha1Hex = sha1.digest("hex")
  return {
    md5: md5.digest("hex"),
    sha1: sha1Hex,
    sha256: sha256.digest("hex"),
    // version.js 的内容哈希是 sha1 的 base64url，这里顺手给出去，与前端的
    // 「内容版本」用同一套算法，避免同一个文件出现两种指纹
    sha1Base64Url: Buffer.from(sha1Hex, "hex").toString("base64url"),
  }
}

/* ============================== 文本信息 ============================== */

function textInfo(buf, size) {
  const detected = detectEncoding(buf)
  const isUtf16 = detected.encoding === "utf16le" || detected.encoding === "utf16be"
  if (!isUtf16 && looksBinary(buf)) return null
  let text = ""
  try {
    text = decodeBuffer(buf, detected.encoding)
  } catch {
    return null
  }
  const normalized = text.replace(/\r\n/g, "\n")
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return {
    encoding: detected.encoding,
    encodingLabel: encodingLabel(detected.encoding),
    encodingConfident: !!detected.confident,
    bom,
    eol: detectEol(text),
    lines: normalized.split("\n").length,
    chars: text.length,
    truncated: size > buf.length,
  }
}

/* ============================== 主入口 ============================== */

/** 换行风格 -> 文案（key 给界面查字典用，label 是中文原文兜底） */
const EOL_TEXT = {
  crlf: { key: "meta.text.eol_crlf", label: "CRLF（Windows）" },
  lf: { key: "meta.text.eol_lf", label: "LF（Unix / macOS）" },
  cr: { key: "meta.text.eol_cr", label: "CR（旧版 macOS）" },
  mixed: { key: "meta.text.eol_mixed", label: "混合" },
}

/**
 * 提取一个文件的详细信息。
 * @param {string} abs 已经过 resolveSafe / assertExists 校验的绝对路径
 * @param {import("node:fs").Stats} stat fs.lstat 结果
 */
export async function inspectFile(abs, stat) {
  const size = stat.size
  const result = {
    size,
    timestamps: {
      mtime: stat.mtimeMs,
      created: stat.birthtimeMs,
      atime: stat.atimeMs,
      ctime: stat.ctimeMs,
    },
    magic: null,
    hashes: null,
    hashNote: null,
    hashNoteKey: null,
    hashNoteParams: null,
    contentVersion: null,
    image: null,
    exif: null,
    doc: null,
    media: null,
    text: null,
  }

  const { head, tail } = await readHeadTail(abs, size)

  // 1) 签名
  try {
    result.magic = detectMagic(head, size)
  } catch {
    result.magic = { label: "识别失败", labelKey: "meta.magic.detect_failed", kind: "unknown", mime: null, signature: hexOf(head, 16) }
  }

  // 2) 图片尺寸（EXIF 里也可能有，作为补充）
  try {
    const img = imageSize(head, result.magic)
    if (img && img.width && img.height) {
      const color = img.colorType === undefined ? undefined : PNG_COLOR[img.colorType]
      result.image = {
        ...img,
        colorType: img.colorType === undefined ? undefined : color ? color.label : String(img.colorType),
        colorTypeKey: color?.key,
        megapixels: Number(((img.width * img.height) / 1e6).toFixed(2)),
        aspect: `${(img.width / img.height).toFixed(3)} : 1`,
      }
    }
  } catch {
    /* 图片尺寸拿不到就算了 */
  }

  // 3) EXIF：JPEG 的 APP1、PNG 的 eXIf、TIFF 本体
  try {
    let exifBuf = null
    if (result.magic?.label.startsWith("JPEG")) exifBuf = exifFromJpeg(head)
    else if (result.magic?.label.startsWith("TIFF")) exifBuf = head
    else if (result.magic?.label.startsWith("PNG")) exifBuf = pngChunks(head).exifBuf
    if (exifBuf) result.exif = parseExif(exifBuf)
    // EXIF 里带了尺寸而前面没解析出来（例如 TIFF）
    if (!result.image && result.exif) {
      const w = result.exif.find((r) => r.key === "meta.exif.image_width")
      const h = result.exif.find((r) => r.key === "meta.exif.image_height")
      if (w && h) result.image = { width: Number(w.value), height: Number(h.value) }
    }
  } catch {
    /* EXIF 坏了不影响其它信息 */
  }

  // 4) 文档元数据：PNG 文本块 / PDF Info / OOXML docProps
  const doc = []
  try {
    if (result.magic?.label.startsWith("PNG")) {
      for (const [k, v] of pngChunks(head).meta) {
        // 认不出的文本块（自造关键字）没有命名键：直接把关键字当键，前端查不到会回落到 label
        const field = PNG_KEY[k]
        doc.push(field ? { key: field.key, label: field.label, value: v } : { key: k, label: k, value: v })
      }
    } else if (result.magic?.label.startsWith("PDF")) {
      doc.push(...pdfInfo([head, tail]))
    } else if (result.magic?.family === "ooxml") {
      doc.push(...(await ooxmlInfo(abs, head)))
    } else if (result.magic?.label.startsWith("ZIP") || result.magic?.mime === "application/zip") {
      // 普通 zip：只把前 64KB 里能看到的条目数报出来，不去读整个中央目录
      const entries = (head.toString("latin1").match(/PK\u0003\u0004/g) || []).length
      if (entries) {
        doc.push({ key: "meta.doc.zip_scanned_entries", label: "已扫描到的条目数（前 64KB 内）", value: String(entries) })
      }
    }
  } catch {
    /* 同上 */
  }

  // 5) 音视频：时长与标签
  const media = []
  try {
    if (result.magic?.label.startsWith("MP4") || result.magic?.label.includes("QuickTime") || result.magic?.label.includes("ISO BMFF") || result.magic?.label.includes("MP4 音频") || result.magic?.label.includes("MP4 有声书")) {
      const sec = await mp4Duration(abs, size)
      if (sec) {
        const text = secondsText(sec)
        if (text) media.push({ key: "meta.media.duration", label: "时长", ...text })
      }
    } else if (result.magic?.label.includes("WAV")) {
      media.push(...wavInfo(head))
    } else if (result.magic?.label.includes("FLAC")) {
      media.push(...flacInfo(head))
    }
    media.push(...id3Info(head))
  } catch {
    /* 同上 */
  }

  if (doc.length) result.doc = doc
  if (media.length) result.media = media

  // 6) 文本信息（编码 / 换行 / 行数）：只有确实被判定为文本的文件才做，
  //    否则 MP3 的 ID3 区会被误认成 UTF-16 文本，冒出一堆假信息。
  try {
    if (result.magic?.kind === "text" && size > 0) {
      if (size <= TEXT_SCAN_BYTES) {
        const info = textInfo(head.subarray(0, Math.min(head.length, size)), size)
        if (info) {
          const eol = EOL_TEXT[info.eol]
          result.text = { ...info, eolLabel: eol ? eol.label : info.eol, eolKey: eol?.key }
        }
      } else {
        result.text = { truncated: true }
      }
    }
  } catch {
    /* 同上 */
  }

  // 7) 哈希（流式，超限跳过）
  if (size === 0) {
    result.hashNoteKey = "meta.hash.empty_file"
    result.hashNote = "空文件（0 字节），没有可计算的内容"
  } else if (size <= HASH_MAX_BYTES) {
    try {
      const h = await hashFile(abs)
      result.contentVersion = `${Math.trunc(stat.mtimeMs)}-${size}-${h.sha1Base64Url}`
      result.hashes = { md5: h.md5, sha1: h.sha1, sha256: h.sha256 }
    } catch {
      result.hashNoteKey = "meta.hash.read_failed"
      result.hashNote = "读取文件失败，未能计算校验和"
    }
  } else if (size > HASH_MAX_BYTES) {
    const limitMB = Math.round(HASH_MAX_BYTES / 1024 / 1024)
    result.hashNoteKey = "meta.hash.skipped_too_large"
    result.hashNoteParams = { limit: limitMB }
    result.hashNote = `文件超过 ${limitMB}MB，为节省磁盘读取已跳过校验和`
  }

  return result
}
