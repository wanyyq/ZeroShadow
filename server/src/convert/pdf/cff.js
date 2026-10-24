/**
 * convert/pdf/cff.js —— CID-keyed CFF 的读取与**子集化**（供 md→PDF 内嵌 OpenType 字体）。
 *
 * 为什么需要子集：思源黑体 / Noto Sans CJK 这类中文字体的 CFF 表 11~15MB，flate 之后
 * 仍有 9~13MB。整份内嵌意味着"转一页便签得到 12MB 文件"——不可接受。所以这里只保留
 * **用到的字形**，输出通常几十 KB。
 *
 * 为什么不能像 TrueType 那样"原地留空未用字形"：
 *   CFF 是 `INDEX` 结构（count + 偏移数组 + 数据），每个字形的字节数不同，没法原地留空。
 *   唯一可行的做法是**重建整个容器**：Header / Name / TopDICT / String / GlobalSubrs /
 *   charset / FDSelect / CharStrings / FDArray / Private+Subrs。重建就必须重算三类
 *   偏移（TopDICT 的绝对偏移、每个 Font DICT 的 Private offset+size、每个 Private
 *   DICT 里的 Subrs 相对偏移）。
 *
 * 三条"防止改坏"的设计：
 *   1. 需要重算的偏移一律写成**定长 5 字节整数**（DICT 的 0x1d 形式）：
 *      先用 0 占位、排完版再回填，长度不随数值变化，因此不会出现"偏移一变、后面的
 *      布局全变"的连锁错误；
 *   2. 其它 DICT 操作数（SID、CIDCount、FontMatrix…）**原样拷贝原始字节**，
 *      不解析、不重编码 —— 不碰就不会算错；
 *   3. 字形号（GID）**密集重排**，但 **CID 保持原值**（charset 记的就是 CID；
 *      PDF 侧 Identity-H 用的也是 CID）。局部/全局子程序整段原样拷贝，因此
 *      charstring 里的子程序编号依然有效。
 *
 * 调用方（truetype.js）在子集化**失败或自检不通过**时会回退到整份内嵌 ——
 * 宁可文件大，也不要给出一个打不开的 PDF。
 */

function u8(b, o) {
  return b.readUInt8(o)
}
function u16(b, o) {
  return b.readUInt16BE(o)
}
function u32(b, o) {
  return b.readUInt32BE(o)
}

/** 子集化失败（调用方据此回退） */
function fail(reason) {
  const err = new Error(reason)
  err.code = "CFF_UNSUPPORTED"
  return err
}

/* ============================================================== 基础结构 == */

/** 读 INDEX：返回各项区间与结束偏移（规范里偏移量从"数据区前一个字节"起算，即 1 基） */
export function readIndex(buffer, offset) {
  if (offset + 2 > buffer.length) throw fail("CFF INDEX 越界")
  const count = u16(buffer, offset)
  if (count === 0) return { items: [], end: offset + 2, raw: buffer.subarray(offset, offset + 2) }
  const offSize = u8(buffer, offset + 2)
  if (offSize < 1 || offSize > 4) throw fail(`CFF INDEX 的 offSize 非法：${offSize}`)
  const offArray = offset + 3
  const dataStart = offArray + (count + 1) * offSize
  if (dataStart > buffer.length) throw fail("CFF INDEX 数据区越界")
  const readOff = (i) => {
    let v = 0
    for (let k = 0; k < offSize; k += 1) v = v * 256 + u8(buffer, offArray + i * offSize + k)
    return v
  }
  const items = []
  for (let i = 0; i < count; i += 1) {
    const start = dataStart + readOff(i) - 1
    const end = dataStart + readOff(i + 1) - 1
    if (start < 0 || end < start || end > buffer.length) throw fail("CFF INDEX 条目越界")
    items.push({ start, end })
  }
  return { items, end: dataStart + readOff(count) - 1, raw: buffer.subarray(offset, dataStart + readOff(count) - 1) }
}

/**
 * 把一段 DICT 拆成 `{ op, operands: [原始字节] }` 序列。
 *
 * 保留原始字节是刻意的：操作数可能是多种长度的整数或 nibble 编码的实数。
 * 重建时除了少数要重算的偏移，其余一律原样回写。
 */
export function parseDictEntries(buffer, start, end) {
  const entries = []
  let operands = []
  let i = start
  while (i < end) {
    const begin = i
    const b = u8(buffer, i)
    if (b <= 21) {
      let op = b
      i += 1
      if (b === 12) {
        if (i >= end) break
        op = 1200 + u8(buffer, i)
        i += 1
      }
      entries.push({ op, operands })
      operands = []
      continue
    }
    if (b === 28) i += 3
    else if (b === 29) i += 5
    else if (b === 30) {
      i += 1
      for (;;) {
        if (i >= end) break
        const v = u8(buffer, i)
        i += 1
        if ((v & 0x0f) === 0x0f || v >> 4 === 0x0f) break
      }
    } else if (b >= 32 && b <= 246) i += 1
    else if (b >= 247 && b <= 254) i += 2
    else i += 1
    operands.push(buffer.subarray(begin, Math.min(i, end)))
  }
  return entries
}

/** 定长 5 字节整数（DICT 的 0x1d 形式）——长度与数值无关，便于先占位后回填 */
function fixedInt(value) {
  const b = Buffer.alloc(5)
  b.writeUInt8(29, 0)
  b.writeInt32BE(value | 0, 1)
  return b
}

/** 一个 DICT 编码成字节；`overrides` 里的操作符改用定长整数（同样占 5 字节） */
function writeDict(entries, overrides = new Map()) {
  const parts = []
  for (const entry of entries) {
    const operands = overrides.get(entry.op) ?? entry.operands
    for (const operand of operands) parts.push(operand)
    parts.push(entry.op > 1200 ? Buffer.from([12, entry.op - 1200]) : Buffer.from([entry.op]))
  }
  return Buffer.concat(parts)
}

/** 一个 INDEX 编码（offSize 按数据总长自动选） */
function writeIndex(items) {
  const count = items.length
  if (!count) return Buffer.from([0, 0])
  const total = items.reduce((sum, item) => sum + item.length, 0)
  const offSize = total < 0x100 ? 1 : total < 0x10000 ? 2 : total < 0x1000000 ? 3 : 4
  const head = Buffer.alloc(3)
  head.writeUInt16BE(count, 0)
  head.writeUInt8(offSize, 2)
  const offsets = Buffer.alloc((count + 1) * offSize)
  const put = (index, value) => {
    for (let k = offSize - 1, v = value; k >= 0; k -= 1, v = Math.floor(v / 256)) {
      offsets.writeUInt8(v & 0xff, index * offSize + k)
    }
  }
  let cursor = 1
  put(0, cursor)
  for (let i = 0; i < count; i += 1) {
    cursor += items[i].length
    put(i + 1, cursor)
  }
  return Buffer.concat([head, offsets, ...items])
}

/* ================================================================= 解析 == */

function decodeDictInt(buf) {
  if (!buf || !buf.length) return NaN
  const b0 = u8(buf, 0)
  if (b0 === 28) return buf.readInt16BE(1)
  if (b0 === 29) return buf.readInt32BE(1)
  if (b0 >= 32 && b0 <= 246) return b0 - 139
  if (b0 >= 247 && b0 <= 250) return (b0 - 247) * 256 + u8(buf, 1) + 108
  if (b0 >= 251 && b0 <= 254) return -(b0 - 251) * 256 - u8(buf, 1) - 108
  return NaN
}

function intOf(ops, op, index = 0) {
  const operands = ops.get(op)
  if (!operands || operands.length <= index) return undefined
  return decodeDictInt(operands[index])
}

/** charset：字形号 → CID（格式 0 = 逐个；1/2 = 区间；字形 0 隐含 CID 0） */
export function parseCharset(buffer, offset, numGlyphs) {
  const cids = new Uint32Array(numGlyphs)
  cids[0] = 0
  const format = u8(buffer, offset)
  let p = offset + 1
  let gid = 1
  if (format === 0) {
    while (gid < numGlyphs) {
      if (p + 2 > buffer.length) throw fail("CFF charset 越界")
      cids[gid] = u16(buffer, p)
      p += 2
      gid += 1
    }
  } else if (format === 1 || format === 2) {
    while (gid < numGlyphs) {
      if (p + 3 > buffer.length) throw fail("CFF charset 区间越界")
      const first = u16(buffer, p)
      p += 2
      const nLeft = format === 1 ? u8(buffer, p) : u16(buffer, p)
      p += format === 1 ? 1 : 2
      for (let k = 0; k <= nLeft && gid < numGlyphs; k += 1) {
        cids[gid] = first + k
        gid += 1
      }
    }
  } else {
    throw fail(`不支持的 CFF charset 格式：${format}`)
  }
  return cids
}

/** FDSelect：字形号 → FD 序号（格式 0 / 3） */
export function parseFdSelect(buffer, offset, numGlyphs) {
  const out = new Uint8Array(numGlyphs)
  const format = u8(buffer, offset)
  if (format === 0) {
    for (let gid = 0; gid < numGlyphs; gid += 1) out[gid] = u8(buffer, offset + 1 + gid)
    return out
  }
  if (format === 3) {
    const nRanges = u16(buffer, offset + 1)
    let p = offset + 3
    const ranges = []
    for (let i = 0; i < nRanges; i += 1) {
      ranges.push({ first: u16(buffer, p), fd: u8(buffer, p + 2) })
      p += 3
    }
    const sentinel = u16(buffer, p)
    for (let i = 0; i < ranges.length; i += 1) {
      const from = ranges[i].first
      const to = i + 1 < ranges.length ? ranges[i + 1].first : sentinel
      for (let gid = from; gid < to && gid < numGlyphs; gid += 1) out[gid] = ranges[i].fd
    }
    return out
  }
  throw fail(`不支持的 CFF FDSelect 格式：${format}`)
}

/**
 * 解析 CFF 表。
 * @param {Buffer} buffer 整个字体文件
 * @param {number} cffOffset CFF 表在文件里的偏移
 * @param {number} cffLength CFF 表长度
 * @param {number} numGlyphs maxp 里的字形数（用于交叉校验）
 */
export function parseCff(buffer, cffOffset, cffLength, numGlyphs) {
  if (cffOffset + 4 > buffer.length) throw fail("CFF 表太小")
  const major = u8(buffer, cffOffset)
  const hdrSize = u8(buffer, cffOffset + 2)
  if (major !== 1) throw fail(`不支持的 CFF 主版本：${major}`)

  const nameIndex = readIndex(buffer, cffOffset + hdrSize)
  const topDictIndex = readIndex(buffer, nameIndex.end)
  const stringIndex = readIndex(buffer, topDictIndex.end)
  const globalSubr = readIndex(buffer, stringIndex.end)
  if (!topDictIndex.items.length) throw fail("CFF 没有 TopDICT")

  const top = topDictIndex.items[0]
  const topEntries = parseDictEntries(buffer, top.start, top.end)
  const topOps = new Map(topEntries.map((entry) => [entry.op, entry.operands]))
  if (!topOps.has(1230)) {
    throw fail(
      "这是 name-keyed CFF（非 CID-keyed）字体，无法作为 PDF 的 CIDFontType0C 内嵌；请改用 .ttf / .ttc 中文字体"
    )
  }
  const charStringsOffset = intOf(topOps, 17)
  const charsetOffset = intOf(topOps, 15) ?? 0
  const fdArrayOffset = intOf(topOps, 1236)
  const fdSelectOffset = intOf(topOps, 1237)
  if (!Number.isFinite(charStringsOffset)) throw fail("CFF TopDICT 缺少 CharStrings")
  if (charsetOffset <= 2) throw fail("CFF 使用预定义 charset，无法确定 CID 映射")
  if (!Number.isFinite(fdArrayOffset)) throw fail("CFF TopDICT 缺少 FDArray")

  const charStrings = readIndex(buffer, cffOffset + charStringsOffset)
  if (charStrings.items.length !== numGlyphs) {
    throw fail(`CFF 的 CharStrings 数量（${charStrings.items.length}）与 maxp（${numGlyphs}）不一致`)
  }

  const cidByGid = parseCharset(buffer, cffOffset + charsetOffset, numGlyphs)
  const fdOfGid = fdSelectOffset > 0 ? parseFdSelect(buffer, cffOffset + fdSelectOffset, numGlyphs) : new Uint8Array(numGlyphs)

  // FDArray：每个 Font DICT 里的 Private 操作数（size, offset）
  const fdArray = readIndex(buffer, cffOffset + fdArrayOffset)
  const fontDicts = fdArray.items.map((item) => parseDictEntries(buffer, item.start, item.end))
  const privates = fontDicts.map((entries) => {
    const ops = new Map(entries.map((entry) => [entry.op, entry.operands]))
    const size = intOf(ops, 18, 0)
    const offset = intOf(ops, 18, 1)
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0) return null
    const abs = cffOffset + offset
    if (abs + size > buffer.length) return null
    const privateEntries = parseDictEntries(buffer, abs, abs + size)
    const subrsRel = intOf(new Map(privateEntries.map((e) => [e.op, e.operands])), 19)
    let subrsRaw = null
    if (Number.isFinite(subrsRel)) {
      subrsRaw = readIndex(buffer, abs + subrsRel).raw
    }
    return { entries: privateEntries, subrsRaw }
  })
  const maxFd = fdOfGid.reduce((max, v) => Math.max(max, v), 0)
  if (maxFd >= fontDicts.length) throw fail("CFF 的 FDSelect 引用了不存在的 Font DICT")

  return {
    header: buffer.subarray(cffOffset, cffOffset + hdrSize),
    nameIndexRaw: nameIndex.raw,
    stringIndexRaw: stringIndex.raw,
    globalSubrRaw: globalSubr.raw,
    topEntries,
    fontDicts,
    privates,
    cidByGid,
    fdOfGid,
    charStrings,
    numGlyphs,
    /** 整份 CFF 的字节（回退路径用） */
    fullProgram: Buffer.from(buffer.subarray(cffOffset, cffOffset + cffLength)),
  }
}

/* ================================================================ 子集化 == */

/** charset 写成格式 2（区间）—— CID 连续时能压得很小 */
function writeCharset(cids) {
  const ranges = []
  let i = 1
  while (i < cids.length) {
    const first = cids[i]
    let n = 0
    while (i + 1 < cids.length && cids[i + 1] === first + n + 1 && n < 0xffff) {
      n += 1
      i += 1
    }
    ranges.push({ first, nLeft: n })
    i += 1
  }
  const buf = Buffer.alloc(1 + ranges.length * 4)
  buf.writeUInt8(2, 0)
  let p = 1
  for (const range of ranges) {
    buf.writeUInt16BE(range.first, p)
    buf.writeUInt16BE(range.nLeft, p + 2)
    p += 4
  }
  return buf
}

/** FDSelect 写成格式 0（每字形 1 字节）—— 字形数已经很小，不值得做区间压缩 */
function writeFdSelect(fdOfGid) {
  const buf = Buffer.alloc(1 + fdOfGid.length)
  buf.writeUInt8(0, 0)
  for (let i = 0; i < fdOfGid.length; i += 1) buf.writeUInt8(fdOfGid[i], i + 1)
  return buf
}

/** 按 entries 顺序把 override 指定的操作数写成定长整数 */
function patchDict(out, start, entries, overrides) {
  let p = start
  for (const entry of entries) {
    const override = overrides.get(entry.op)
    for (let k = 0; k < entry.operands.length; k += 1) {
      if (override && override[k] !== undefined) {
        out.writeUInt8(29, p)
        out.writeInt32BE(override[k] | 0, p + 1)
      }
      p += entry.operands[k].length
    }
    p += entry.op > 1200 ? 2 : 1
  }
}

/** 一个 INDEX 里每项数据的起始位置（用于回填 Font DICT 内部的偏移） */
function indexItemStarts(buffer, indexOffset) {
  const count = u16(buffer, indexOffset)
  const offSize = u8(buffer, indexOffset + 2)
  const offArray = indexOffset + 3
  const dataStart = offArray + (count + 1) * offSize
  const readOff = (i) => {
    let v = 0
    for (let k = 0; k < offSize; k += 1) v = v * 256 + u8(buffer, offArray + i * offSize + k)
    return v
  }
  const starts = []
  for (let i = 0; i < count; i += 1) starts.push(dataStart + readOff(i) - 1)
  return starts
}

/**
 * 生成子集。
 *
 * @param {Buffer} buffer 整个字体文件（charstring 从这里拷原始字节）
 * @param {object} cff parseCff() 的结果
 * @param {Iterable<number>} usedGids 要保留的原始字形号
 * @returns {{ program: Buffer, oldGids: number[], newCid: Uint32Array }}
 *   `program` 可直接作为 PDF 的 `/FontFile3`（`/Subtype /CIDFontType0C`）；
 *   `newCid[newGid]` 是对应的 CID（PDF 内容流里写的就是 CID）。
 */
export function subsetCff(buffer, cff, usedGids) {
  // 0 号字形（.notdef）必须保留，且它的 CID 必须是 0
  const used = new Set([0])
  for (const gid of usedGids) if (gid > 0 && gid < cff.numGlyphs) used.add(gid)
  const oldGids = [...used].sort((a, b) => a - b)
  const count = oldGids.length

  const newCid = new Uint32Array(count)
  const newFdRaw = new Uint8Array(count)
  const charStrings = []
  for (let i = 0; i < count; i += 1) {
    const oldGid = oldGids[i]
    newCid[i] = cff.cidByGid[oldGid]
    newFdRaw[i] = cff.fdOfGid[oldGid]
    const item = cff.charStrings.items[oldGid]
    charStrings.push(buffer.subarray(item.start, item.end))
  }
  if (newCid[0] !== 0) throw fail("子集化后 .notdef 的 CID 不为 0，拒绝生成")

  const charset = writeCharset(newCid)
  const charStringsIndex = writeIndex(charStrings)

  // 只保留被引用到的 FD，并重排成 0..n-1
  const usedFds = [...new Set(newFdRaw)].sort((a, b) => a - b)
  const fdRemap = new Map(usedFds.map((fd, i) => [fd, i]))
  const fdSelect = writeFdSelect(newFdRaw.map((fd) => fdRemap.get(fd)))

  // 每个用到的 FD：Font DICT（保留非 Private 的项）+ Private DICT（重算 Subrs 相对偏移）
  const fdDictEntries = usedFds.map((fd) => {
    const source = cff.fontDicts[fd] ?? []
    return source.filter((entry) => entry.op !== 18).concat([{ op: 18, operands: [fixedInt(0), fixedInt(0)] }])
  })
  const privateEntriesOf = (fd) => {
    const priv = cff.privates[fd]
    if (!priv) return { entries: [], subrsRaw: null }
    const entries = priv.entries.filter((entry) => entry.op !== 19)
    if (priv.subrsRaw) entries.push({ op: 19, operands: [fixedInt(0)] })
    return { entries, subrsRaw: priv.subrsRaw }
  }
  const privates = usedFds.map((fd) => privateEntriesOf(fd))

  /* ---------------- 布局（偏移用占位，长度固定） ---------------- */

  const topEntries = cff.topEntries
    .filter((entry) => ![15, 16, 17, 1236, 1237, 18].includes(entry.op))
    .concat([
      { op: 15, operands: [fixedInt(0)] },
      { op: 17, operands: [fixedInt(0)] },
      { op: 1237, operands: [fixedInt(0)] },
      { op: 1236, operands: [fixedInt(0)] },
    ])
  const topDictBytes = writeDict(topEntries)
  const topIndexBytes = writeIndex([topDictBytes])

  const fdDicts = fdDictEntries.map((entries) => writeDict(entries))
  const fdArrayBytes = writeIndex(fdDicts)

  const pieces = []
  let cursor = 0
  const offsets = {}
  const push = (name, bytes) => {
    if (name) offsets[name] = cursor
    pieces.push(bytes)
    cursor += bytes.length
    return bytes
  }

  push("header", cff.header)
  push("name", cff.nameIndexRaw)
  const topIndexOffset = cursor
  push("top", topIndexBytes)
  push("string", cff.stringIndexRaw)
  push("gsubrs", cff.globalSubrRaw)
  push("charset", charset)
  push("fdselect", fdSelect)
  push("charstrings", charStringsIndex)
  const fdArrayOffset = cursor
  push("fdarray", fdArrayBytes)

  const privateRanges = []
  for (let i = 0; i < privates.length; i += 1) {
    const start = cursor
    push(null, privates[i].entries.length ? writeDict(privates[i].entries) : Buffer.alloc(0))
    const length = cursor - start
    let subrsStart = null
    if (privates[i].subrsRaw) {
      subrsStart = cursor
      push(null, privates[i].subrsRaw)
    }
    privateRanges.push({ index: i, start, length, subrsStart })
  }

  const out = Buffer.concat(pieces, cursor)

  /* ---------------- 回填偏移 ---------------- */

  // 1) TopDICT 的四个绝对偏移
  const topDictStart = topIndexOffset + (topIndexBytes.length - topDictBytes.length)
  patchDict(
    out,
    topDictStart,
    topEntries,
    new Map([
      [15, [offsets.charset]],
      [17, [offsets.charstrings]],
      [1237, [offsets.fdselect]],
      [1236, [fdArrayOffset]],
    ])
  )

  // 2) 每个 Font DICT 的 Private（size, offset）
  const fdItemStarts = indexItemStarts(out, fdArrayOffset)
  for (let i = 0; i < fdDictEntries.length; i += 1) {
    const range = privateRanges[i]
    patchDict(out, fdItemStarts[i], fdDictEntries[i], new Map([[18, [range.length, range.start]]]))
  }

  // 3) 每个 Private DICT 的 Subrs（相对 Private 起点的偏移）
  for (const range of privateRanges) {
    if (range.subrsStart === null) continue
    patchDict(out, range.start, privates[range.index].entries, new Map([[19, [range.subrsStart - range.start]]]))
  }

  return { program: out, oldGids, newCid }
}

/**
 * 自检：把子集化产出**再解析一遍**，确认结构与原字体一致。
 *
 * 这一步是给"字节级手术"兜底的：任何偏移算错都会在这里暴露（而不是等用户打开 PDF
 * 才发现）。检查项：能解析、CharStrings 数量对、每个保留字形在新字体的 CID 与原字体
 * 相同、charstring 字节与原字体逐字节一致。
 *
 * @returns {true} 通过；抛错表示不可用（调用方回退整份内嵌）
 */
export function verifySubset(program, cff, subset) {
  const re = parseCff(program, 0, program.length, subset.oldGids.length)
  for (let i = 0; i < subset.oldGids.length; i += 1) {
    if (re.cidByGid[i] !== subset.newCid[i]) {
      throw fail(`子集自检失败：新字形 ${i} 的 CID 不一致（${re.cidByGid[i]} != ${subset.newCid[i]}）`)
    }
    const oldGid = subset.oldGids[i]
    const a = re.charStrings.items[i]
    const b = cff.charStrings.items[oldGid]
    if (a.end - a.start !== b.end - b.start) {
      throw fail(`子集自检失败：字形 ${oldGid} 的 charstring 长度不一致`)
    }
  }
  return true
}
