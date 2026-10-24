/**
 * pdf/truetype.js —— 只读的 TrueType / CFF(OpenType) 解析 + 子集化（供 md→PDF 内嵌中文字体用）。
 *
 * 为什么自己写（而不是装 pdfkit / fontkit）：
 *   - 项目对外承诺的后端依赖只有 8 个，`docs/开发者指南.md` 与「软件开源信息」页都
 *     按这个清单展示；为了一个「Markdown 转 PDF」多背两个几 MB 的库不划算。
 *   - 我们需要的功能区间其实很窄：读 cmap（字符→字形号）、读 hmtx（字宽），然后按
 *     PDF 的规则内嵌。不需要 shaping（连字 / 阿拉伯文变形）。
 *
 * 两种轮廓各走一条路（v2.1.0 起）：
 *
 *   1. **TrueType（glyf）**：PDF 用 CIDFontType2 + Identity-H，CID 就等于字形号，
 *      于是可以**保留原始字形号**做子集：只把"用到的字形"的轮廓拷进新的 glyf，
 *      其余留空。不需要重排字形号，也就不需要重写 composite glyph 的组件引用。
 *      代价是 hmtx / loca 仍然是 numGlyphs 条（雅黑约 3 万字形 → 各约 120KB），
 *      但相比整份 19MB 的 msyh.ttc 已经小了两个数量级。
 *
 *   2. **CFF（OpenType/OTTO）**：PDF 用 CIDFontType0 + `/FontFile3 /CIDFontType0C`。
 *      CFF 的 INDEX 结构没法"原地留空"，所以这里做的是**重建容器式的子集**
 *      （见 `cff.js`：新字形密集重排、CID 保持原值、只在用到时保留 charstring）。
 *      CFF 子集失败或自检不过时**回退整份内嵌**（文件会明显变大，但保证能打开）。
 *
 *   注意 CID 与 GID 的区别：TrueType 路径下 CID == GID；CFF 路径下必须用字体
 *   charset 里声明的 CID（思源/Noto 里两者经常**不相等**，实测 NotoSerifSC 的
 *   「中」gid=8742 而 cid=9562），内容流里写的是 CID。
 *
 * 明确不支持：CFF2（可变字体）、name-keyed CFF（非 CID-keyed 的 .otf）、
 * 预定义 charset（ISOAdobe/Expert）的字体、以及任何需要 GSUB/GPOS 的复杂文字排版。
 * 这些都写进了 `docs/使用手册.md` 的转换限制与「常见问题 → 文件转换」。
 */

import { parseCff, subsetCff, verifySubset } from "./cff.js"

/** sfnt 版本常量 */
const SFNT_TRUETYPE = 0x00010000
const SFNT_TRUE = 0x74727565 // 'true'
const SFNT_OTTO = 0x4f54544f // 'OTTO'（CFF 轮廓）
const SFNT_TTCF = 0x74746366 // 'ttcf'

/** 复合字形里"还有下一个组件"的标志位（TrueType 规范） */
const MORE_COMPONENTS = 0x0020
const ARG_1_AND_2_ARE_WORDS = 0x0001
const WE_HAVE_A_SCALE = 0x0008
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040
const WE_HAVE_A_TWO_BY_TWO = 0x0080

function u8(b, o) {
  return b.readUInt8(o)
}
function u16(b, o) {
  return b.readUInt16BE(o)
}
function i16(b, o) {
  return b.readInt16BE(o)
}
function u32(b, o) {
  return b.readUInt32BE(o)
}
function tag(b, o) {
  return b.toString("latin1", o, o + 4)
}

function fail(reason) {
  const err = new Error(reason)
  err.code = "TTF_UNSUPPORTED"
  return err
}

/**
 * 解析字体文件（.ttf 或 .ttc）。
 *
 * @param {Buffer} buffer 整个字体文件
 * @param {{ faceIndex?: number }} [options] TTC 里取第几个 face（默认 0）
 * @returns 解析结果（含 tables / 各关键表的视图）
 */
export function parseFont(buffer, { faceIndex = 0 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw fail("字体文件太小")
  const sfnt = u32(buffer, 0)

  let base = 0
  let faceCount = 1
  if (sfnt === SFNT_TTCF) {
    // TTC 头：tag(4) major(2) minor(2) numFonts(4) offset[numFonts]
    const numFonts = u32(buffer, 8)
    if (!numFonts) throw fail("TTC 里没有字体")
    faceCount = numFonts
    const idx = Math.min(Math.max(0, faceIndex), numFonts - 1)
    base = u32(buffer, 12 + idx * 4)
  }
  const version = u32(buffer, base)
  let kind = "truetype"
  if (version === SFNT_OTTO) {
    // CFF 轮廓：走另一条内嵌路径（见文件头）。CFF2（可变字体）的表名是 "CFF2"，
    // 结构完全不同，明确拒绝而不是"试一下"。
    kind = "cff"
  } else if (version !== SFNT_TRUETYPE && version !== SFNT_TRUE) {
    throw fail(`未知的字体格式：0x${version.toString(16)}`)
  }

  const numTables = u16(buffer, base + 4)
  const tables = new Map()
  for (let i = 0; i < numTables; i += 1) {
    const entry = base + 12 + i * 16
    if (entry + 16 > buffer.length) throw fail("字体表目录越界")
    const name = tag(buffer, entry)
    const offset = u32(buffer, entry + 8)
    const length = u32(buffer, entry + 12)
    if (offset + length > buffer.length) throw fail(`字体表 ${name} 越界`)
    tables.set(name, { tag: name, offset, length })
  }

  const required = ["head", "hhea", "maxp", "hmtx", "cmap"]
  if (kind === "cff") {
    if (!tables.has("CFF ")) {
      throw fail(
        tables.has("CFF2")
          ? "这是 CFF2 可变字体，暂不支持（请改用静态 .ttf / .otf）"
          : "OpenType 字体缺少 CFF 表"
      )
    }
    required.push("CFF ")
  } else {
    required.push("loca", "glyf")
  }
  for (const name of required) {
    if (!tables.has(name)) throw fail(`字体缺少必需的表：${name}`)
  }

  const head = tables.get("head")
  const unitsPerEm = u16(buffer, head.offset + 18)
  const indexToLocFormat = i16(buffer, head.offset + 50)
  const bbox = {
    xMin: i16(buffer, head.offset + 36),
    yMin: i16(buffer, head.offset + 38),
    xMax: i16(buffer, head.offset + 40),
    yMax: i16(buffer, head.offset + 42),
  }
  const macStyle = u16(buffer, head.offset + 44)

  const maxp = tables.get("maxp")
  const numGlyphs = u16(buffer, maxp.offset + 4)

  const hhea = tables.get("hhea")
  const ascender = i16(buffer, hhea.offset + 4)
  const descender = i16(buffer, hhea.offset + 6)
  const lineGap = i16(buffer, hhea.offset + 8)
  const numberOfHMetrics = u16(buffer, hhea.offset + 34)
  const capHeight = detectCapHeight(buffer, tables)

  const font = {
    buffer,
    base,
    faceCount,
    /** "truetype"（glyf）或 "cff"（OpenType/CFF）—— 决定 PDF 用 CIDFontType2 还是 Type0 */
    kind,
    unitsPerEm: unitsPerEm || 1000,
    indexToLocFormat,
    bbox,
    ascender,
    descender,
    lineGap,
    numberOfHMetrics: Math.max(1, Math.min(numberOfHMetrics, numGlyphs)),
    numGlyphs,
    macStyle,
    capHeight,
    tables,
    cmap: [],
    /** CFF 字体：字形号 → CID（TrueType 路径下恒等，这里留 null） */
    cidByGid: null,
    /** CFF 字体：可直接内嵌的 CFF 表字节 */
    cffProgram: null,
    /** 字形号 → 字宽（字体单位），懒解析 */
    _advances: null,
    /** 字符 → 字形号，懒解析 */
    _charMap: null,
  }

  if (kind === "cff") {
    const parsed = parseCff(buffer, tables.get("CFF ").offset, tables.get("CFF ").length, numGlyphs)
    font.cidByGid = parsed.cidByGid
    font.cff = parsed
  }
  return font
}

/**
 * 生成可内嵌的字体程序。
 *
 * - TrueType：返回子集 sfnt（`/FontFile2`）
 * - CFF：返回子集 CFF（`/FontFile3` + `/Subtype /CIDFontType0C`）；子集化或自检
 *   失败时回退到整份 CFF，并把 `fallbackReason` 带出去（任务提示里会说明文件偏大）
 *
 * @param {object} font parseFont() 的结果
 * @param {Iterable<number>} usedGids 用到的**原始字形号**
 * @returns {{ program: Buffer, format: "truetype"|"cff", cidOfNewGid?: Uint32Array, note?: string }}
 */
export function buildFontProgram(font, usedGids) {
  if (font.kind !== "cff") {
    return { program: subsetFont(font, usedGids), format: "truetype" }
  }
  try {
    const subset = subsetCff(font.buffer, font.cff, usedGids)
    verifySubset(subset.program, font.cff, subset)
    return { program: subset.program, format: "cff", oldGids: subset.oldGids, cidOfNewGid: subset.newCid }
  } catch (err) {
    // 回退：整份内嵌。宁可 PDF 变大，也不要交出打不开的文件。
    return {
      program: font.cff.fullProgram,
      format: "cff",
      fallbackReason: String(err?.message || err),
      note: `字体子集化失败，已改为整份内嵌（PDF 会偏大）：${err?.message || err}`,
    }
  }
}

/* ============================================================ CFF（OpenType） == */
// CFF 的解析与子集化都在 `cff.js` 里（那份实现同时负责"重建容器 + 回填偏移"）。
// 这里只保留 TrueType（glyf）相关的部分。

/**
 * 读 OS/2 的 sCapHeight（版本 ≥ 2 才有）；没有就退回 ascender 的 0.7 倍。
 * 只是给 PDF 的 FontDescriptor 填 /CapHeight，观感细节，不做精确校验。
 */
function detectCapHeight(buffer, tables) {
  const os2 = tables.get("OS/2")
  if (!os2) return null
  const version = u16(buffer, os2.offset)
  if (version >= 2 && os2.length >= 90) return i16(buffer, os2.offset + 88)
  return null
}

/** 字形号 → 字宽（字体单位）。hmtx 的后半段（等宽尾部）按规范复用最后一个宽度。 */
export function advances(font) {
  if (font._advances) return font._advances
  const { buffer, tables, numberOfHMetrics, numGlyphs } = font
  const hmtx = tables.get("hmtx")
  const out = new Uint16Array(numGlyphs)
  let last = 0
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    if (gid < numberOfHMetrics) {
      const off = hmtx.offset + gid * 4
      last = off + 2 <= hmtx.offset + hmtx.length ? u16(buffer, off) : last
    }
    out[gid] = last
  }
  font._advances = out
  return out
}

/**
 * 解析 cmap，得到「Unicode 码点 → 字形号」的映射。
 *
 * 只认 Unicode 子表：format 12（含 BMP 之外）优先，其次 format 4（BMP）。
 * 符号字体（3,0）与 Mac Roman（1,0）不处理 —— 我们要排的是正文文本。
 */
export function charMap(font) {
  if (font._charMap) return font._charMap
  const map = new Map()
  const { buffer, tables } = font
  const cmap = tables.get("cmap")
  if (!cmap) {
    font._charMap = map
    return map
  }
  const count = u16(buffer, cmap.offset + 2)
  const candidates = []
  for (let i = 0; i < count; i += 1) {
    const rec = cmap.offset + 4 + i * 8
    const platform = u16(buffer, rec)
    const encoding = u16(buffer, rec + 2)
    const sub = cmap.offset + u32(buffer, rec + 4)
    if (sub + 2 > buffer.length) continue
    const format = u16(buffer, sub)
    // (3,10) / (0,4..6) 是完整 Unicode；format 12 优先
    const score =
      (platform === 3 && encoding === 10) || (platform === 0 && encoding >= 4)
        ? format === 12
          ? 4
          : format === 4
            ? 3
            : 0
        : (platform === 3 && encoding === 1) || (platform === 0 && encoding <= 3)
          ? format === 12
            ? 2
            : format === 4
              ? 1
              : 0
          : 0
    if (score > 0) candidates.push({ score, format, sub })
  }
  candidates.sort((a, b) => b.score - a.score)

  for (const { format, sub } of candidates) {
    try {
      if (format === 12) readFormat12(buffer, sub, map)
      else if (format === 4) readFormat4(buffer, sub, map)
    } catch {
      // 单个子表坏了就换下一个；全都失败时 map 为空，调用方会把缺字降级成 '?'
    }
    if (map.size) break
  }
  font._charMap = map
  return map
}

function readFormat12(buffer, sub, map) {
  const nGroups = u32(buffer, sub + 12)
  for (let i = 0; i < nGroups; i += 1) {
    const g = sub + 16 + i * 12
    if (g + 12 > buffer.length) break
    const start = u32(buffer, g)
    const end = u32(buffer, g + 4)
    const startGid = u32(buffer, g + 8)
    // 防御巨型表：正常字体最大的组也就覆盖整个 CJK 区
    if (end < start || end - start > 0x10000) continue
    for (let cp = start; cp <= end; cp += 1) {
      const gid = startGid + (cp - start)
      if (gid > 0 && gid < 0xffff) map.set(cp, gid)
    }
  }
}

function readFormat4(buffer, sub, map) {
  const segCountX2 = u16(buffer, sub + 6)
  const segCount = segCountX2 / 2
  const endCodes = sub + 14
  const startCodes = endCodes + segCountX2 + 2
  const idDeltas = startCodes + segCountX2
  const idRangeOffsets = idDeltas + segCountX2
  for (let s = 0; s < segCount; s += 1) {
    const end = u16(buffer, endCodes + s * 2)
    const start = u16(buffer, startCodes + s * 2)
    const delta = i16(buffer, idDeltas + s * 2)
    const rangeOffsetPos = idRangeOffsets + s * 2
    const rangeOffset = u16(buffer, rangeOffsetPos)
    if (start > end || end === 0xffff) continue
    for (let cp = start; cp <= end; cp += 1) {
      let gid
      if (rangeOffset === 0) {
        gid = (cp + delta) & 0xffff
      } else {
        // 规范里这是一个相对 idRangeOffset 自身位置的字节偏移
        const glyphPos = rangeOffsetPos + rangeOffset + (cp - start) * 2
        if (glyphPos + 2 > buffer.length) continue
        gid = u16(buffer, glyphPos)
        if (gid !== 0) gid = (gid + delta) & 0xffff
      }
      // 0xffff 是 format 4 的哨兵段
      if (gid > 0 && cp !== 0xffff) map.set(cp, gid)
    }
  }
}

/** 一个字形在 glyf 表里的字节区间 */
function glyphRange(font, gid) {
  const { buffer, tables, numGlyphs } = font
  if (gid < 0 || gid >= numGlyphs) return null
  const loca = tables.get("loca")
  let start
  let end
  if (font.indexToLocFormat === 0) {
    if (loca.offset + (gid + 2) * 2 > loca.offset + loca.length) return null
    start = u16(buffer, loca.offset + gid * 2) * 2
    end = u16(buffer, loca.offset + (gid + 1) * 2) * 2
  } else {
    if (loca.offset + (gid + 2) * 4 > loca.offset + loca.length) return null
    start = u32(buffer, loca.offset + gid * 4)
    end = u32(buffer, loca.offset + (gid + 1) * 4)
  }
  const glyf = tables.get("glyf")
  if (end <= start) return null // 空字形（例如空格）
  if (start + 10 > glyf.length || end > glyf.length) return null
  return { from: glyf.offset + start, to: glyf.offset + end }
}

/**
 * 读一个复合字形引用的组件字形号（简单字形返回空数组）。
 * 必须递归收集：否则"用了 é 但没用到 e"时，é 的组件 e 会被留空，渲染成空白。
 */
function compositeComponents(font, gid) {
  const range = glyphRange(font, gid)
  if (!range) return []
  const { buffer } = font
  const contours = i16(buffer, range.from)
  if (contours >= 0) return []
  const out = []
  let p = range.from + 10
  for (;;) {
    if (p + 4 > range.to) break
    const flags = u16(buffer, p)
    const childGid = u16(buffer, p + 2)
    out.push(childGid)
    p += 4
    p += flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2
    if (flags & WE_HAVE_A_SCALE) p += 2
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) p += 4
    else if (flags & WE_HAVE_A_TWO_BY_TWO) p += 8
    if (!(flags & MORE_COMPONENTS)) break
  }
  return out
}

const TABLE_ORDER = [
  "head",
  "hhea",
  "maxp",
  "hmtx",
  "loca",
  "glyf",
  "cvt ",
  "fpgm",
  "prep",
  "gasp",
]

/**
 * 生成子集字体（保留原始 GID）。
 *
 * @param {object} font parseFont 的结果
 * @param {Iterable<number>} usedGids 需要保留轮廓的字形号
 * @returns {Buffer} 可直接作为 PDF /FontFile2 的 TrueType 程序
 */
export function subsetFont(font, usedGids) {
  const { buffer, numGlyphs } = font
  // 0 号字形（.notdef）永远保留；复合字形的组件递归补齐
  const keep = new Set([0])
  const queue = [0, ...usedGids]
  const seen = new Set()
  while (queue.length) {
    const gid = queue.pop()
    if (seen.has(gid)) continue
    seen.add(gid)
    if (gid < 0 || gid >= numGlyphs) continue
    keep.add(gid)
    for (const child of compositeComponents(font, gid)) {
      if (!seen.has(child)) queue.push(child)
    }
  }

  // ---- 新 glyf：按字形号顺序拼接，未使用的留空 ----
  const offsets = new Uint32Array(numGlyphs + 1)
  const chunks = []
  let cursor = 0
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    offsets[gid] = cursor
    if (!keep.has(gid)) continue
    const range = glyphRange(font, gid)
    if (!range) continue
    const data = buffer.subarray(range.from, range.to)
    chunks.push(data)
    cursor += data.length
    // loca 用 4 字节偏移，但字形数据仍按 4 字节对齐更稳妥（部分阅读器按 int32 读）
    const pad = (4 - (cursor % 4)) % 4
    if (pad) {
      chunks.push(Buffer.alloc(pad))
      cursor += pad
    }
  }
  offsets[numGlyphs] = cursor
  const glyf = Buffer.concat(chunks, cursor)

  const loca = Buffer.alloc((numGlyphs + 1) * 4)
  for (let i = 0; i <= numGlyphs; i += 1) loca.writeUInt32BE(offsets[i], i * 4)

  // ---- 其余表：head 打补丁，其它原样搬运 ----
  const out = new Map()
  for (const name of TABLE_ORDER) {
    const entry = font.tables.get(name)
    if (!entry) continue
    if (name === "glyf") {
      out.set(name, glyf)
    } else if (name === "loca") {
      out.set(name, loca)
    } else if (name === "head") {
      const head = Buffer.from(buffer.subarray(entry.offset, entry.offset + entry.length))
      head.writeUInt32BE(0, 8) // checkSumAdjustment 先清零，最后再算
      head.writeInt16BE(1, 50) // indexToLocFormat = long
      out.set(name, head)
    } else {
      out.set(name, Buffer.from(buffer.subarray(entry.offset, entry.offset + entry.length)))
    }
  }
  return buildSfnt(out)
}

/** 把若干张表拼成一个 sfnt（TrueType）文件，并按规范填好校验和 */
function buildSfnt(tableMap) {
  const tags = [...tableMap.keys()].sort()
  const numTables = tags.length
  let entrySelector = 0
  while (2 ** (entrySelector + 1) <= numTables) entrySelector += 1
  const searchRange = 2 ** entrySelector * 16
  const rangeShift = numTables * 16 - searchRange

  const header = Buffer.alloc(12)
  header.writeUInt32BE(SFNT_TRUETYPE, 0)
  header.writeUInt16BE(numTables, 4)
  header.writeUInt16BE(searchRange, 6)
  header.writeUInt16BE(entrySelector, 8)
  header.writeUInt16BE(rangeShift, 10)

  const directory = Buffer.alloc(numTables * 16)
  const bodies = []
  let offset = 12 + numTables * 16
  const records = []
  for (const name of tags) {
    const data = tableMap.get(name)
    const padded = pad4(data)
    const checksum = tableChecksum(padded)
    records.push({ name, offset, length: data.length, checksum })
    bodies.push(padded)
    offset += padded.length
  }
  records.forEach((rec, i) => {
    const p = i * 16
    directory.write(rec.name.padEnd(4, " "), p, 4, "latin1")
    directory.writeUInt32BE(rec.checksum, p + 4)
    directory.writeUInt32BE(rec.offset, p + 8)
    directory.writeUInt32BE(rec.length, p + 12)
  })

  const file = Buffer.concat([header, directory, ...bodies])
  // checkSumAdjustment：对整份文件（head 的该字段视为 0）求和后取补
  const headRec = records.find((r) => r.name === "head")
  if (headRec) {
    const total = tableChecksum(file)
    const adjustment = (0xb1b0afba - total) >>> 0
    file.writeUInt32BE(adjustment, headRec.offset + 8)
  }
  return file
}

function pad4(buf) {
  const pad = (4 - (buf.length % 4)) % 4
  return pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf
}

function tableChecksum(buf) {
  let sum = 0
  const len = buf.length - (buf.length % 4)
  for (let i = 0; i < len; i += 4) sum = (sum + buf.readUInt32BE(i)) >>> 0
  if (len < buf.length) {
    const tail = Buffer.alloc(4)
    buf.copy(tail, 0, len)
    sum = (sum + tail.readUInt32BE(0)) >>> 0
  }
  return sum >>> 0
}

export { u8, u32 }
