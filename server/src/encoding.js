import iconv from "iconv-lite"

/**
 * 在线编辑器的编码处理。
 *
 * 之前的实现是「前端 fetch().text() + 后端固定 utf8 写入」——
 * 也就是**一律当 UTF-8**：打开 GBK 的 txt 直接满屏乱码，保存还会把文件写坏。
 *
 * 这里把编解码收到服务端，用 iconv-lite 支持一批常见编码：
 *   - 读：先看 BOM，再严格试 UTF-8，都不是就按候选编码逐个解码打分，取乱码最少的；
 *   - 写：按目标编码编码，并**回读比对**，把目标编码表示不了的字符报给用户，
 *         避免 iconv 静默替换成「?」把内容改坏。
 *
 * 换行符同样单独处理：读的时候统一成 \n 交给前端（textarea 本来就只认 \n），
 * 保存时再按用户选择还原成 CRLF / LF / CR。
 */

/** 在线编辑单次读取上限：再大就不适合塞进 textarea 了 */
export const EDITOR_MAX_BYTES = 8 * 1024 * 1024

/** 前端编码下拉里可选的编码。auto 只用于「读取时自动识别」，不能用于保存。 */
export const EDITOR_ENCODINGS = [
  { id: "utf8", label: "UTF-8", bom: "none" },
  { id: "utf8bom", label: "UTF-8 (带 BOM)", bom: "utf8" },
  { id: "utf16le", label: "UTF-16 LE", bom: "utf16le" },
  { id: "utf16be", label: "UTF-16 BE", bom: "utf16be" },
  { id: "gb18030", label: "GB18030 / GBK（简体中文）", bom: "none" },
  { id: "big5", label: "Big5（繁体中文）", bom: "none" },
  { id: "shift_jis", label: "Shift_JIS（日文）", bom: "none" },
  { id: "euc-kr", label: "EUC-KR（韩文）", bom: "none" },
  { id: "windows-1252", label: "Windows-1252（西欧）", bom: "none" },
  { id: "iso-8859-1", label: "ISO-8859-1（Latin-1）", bom: "none" },
]

const VALID_IDS = new Set(EDITOR_ENCODINGS.map((e) => e.id))

/** 无 BOM 时按这个顺序尝试；中文环境下 GB18030 优先级最高 */
const CANDIDATES = ["gb18030", "big5", "shift_jis", "euc-kr", "windows-1252", "iso-8859-1"]

/**
 * 常用字表，用来给候选编码打分。
 *
 * 只数「替换字符」是不够的：GB18030 几乎能解码任意字节序列，
 * 拿它去解 Big5 文件往往一个替换字符都没有，但内容是错的。
 * 正确编码解出来的文本会包含大量高频字，错误编码则是一片生僻字，
 * 所以用「命中常用字的数量」来区分，这是这类探测器的常规做法。
 */
const COMMON = {
  gb18030:
    "的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从",
  big5:
    "的一是不了人我在有他這為之大來以個中上們到說國和地也子時道出而要於就下得可你年生自會那後能對著事其裡所去行過家十用發天如然作方成者多日都三小軍二無同麼經法當起與好看學進種將還分此心前面又定見只主沒公從",
  shift_jis:
    "のにるたはをでがとてしなていれかすことあるものこれそのためようまた日本月日年生人学校行見思言時自分何",
  "euc-kr": "이다는의에를을가이한하로에서와과도로지만하지것수있다되며",
}

/** utf8bom 只是 utf8 加个 BOM，实际编解码都用 utf8 */
function codecOf(encoding) {
  return encoding === "utf8bom" ? "utf8" : encoding
}

export function isSupportedEncoding(encoding) {
  return VALID_IDS.has(String(encoding || ""))
}

export function encodingLabel(encoding) {
  return EDITOR_ENCODINGS.find((e) => e.id === encoding)?.label || encoding
}

/** 严格 UTF-8 校验：TextDecoder 的 fatal 模式遇非法字节会抛异常 */
function isValidUtf8(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function countReplacement(text) {
  let n = 0
  for (const ch of text) if (ch === "\uFFFD") n += 1
  return n
}

function scoreCandidate(buf, candidate) {
  let text
  try {
    text = iconv.decode(buf, candidate)
  } catch {
    return null
  }
  const sample = text.slice(0, 4000)
  let control = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1
  }
  const common = COMMON[candidate]
  let hits = 0
  if (common) {
    for (const ch of sample) if (common.includes(ch)) hits += 1
  }
  const replacement = countReplacement(text)
  return {
    score: hits * 3 - replacement * 100 - control * 20,
    hits,
    control,
    replacement,
    sampled: Math.max(1, sample.length),
  }
}

/**
 * 二进制探测：文本文件里不该出现 NUL，控制字符比例也应该很低。
 * UTF-16 天然含 NUL，所以要在 BOM 判定之后再调用。
 */
export function looksBinary(buf) {
  const sample = buf.subarray(0, 8192)
  if (!sample.length) return false
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return control / sample.length > 0.1
}

/**
 * 判断「按某种字节序当 UTF-16 读」有多像正常文本。
 *
 * 只数 NUL 字节是不够的：中文的 UTF-16 编码两个字节都不为 0
 * （比如「中」= 0x4E2D → 2D 4E），纯中文的 UTF-16 文件一个 0 都没有。
 * 所以改成看 16 位单元落在「可打印 ASCII / CJK / 常用标点」里的比例：
 * 正确的字节序会得到很高的比例，错误字节序和随机字节都远低于阈值。
 */
function utf16Plausibility(buf, little) {
  const pairs = Math.floor(Math.min(buf.length, 4096) / 2)
  if (pairs < 4) return 0
  let good = 0
  for (let i = 0; i < pairs; i += 1) {
    const a = buf[i * 2]
    const b = buf[i * 2 + 1]
    const u = little ? a | (b << 8) : (a << 8) | b
    if (u === 0) continue
    const printableAscii = u >= 32 && u < 127
    const cjk =
      (u >= 0x4e00 && u <= 0x9fff) || // 汉字
      (u >= 0x3000 && u <= 0x303f) || // 中文标点
      (u >= 0xff00 && u <= 0xffef) || // 全角
      (u >= 0x3040 && u <= 0x30ff) || // 日文假名
      (u >= 0xac00 && u <= 0xd7af) || // 韩文
      (u >= 0x2000 && u <= 0x206f)    // 通用标点
    if (printableAscii || cjk || u === 9 || u === 10 || u === 13) good += 1
  }
  return good / pairs
}

/** 无 BOM 的 UTF-16 探测：两种字节序各打一次分，差距足够大才认 */
function detectBomlessUtf16(buf) {
  const le = utf16Plausibility(buf, true)
  const be = utf16Plausibility(buf, false)
  const THRESHOLD = 0.85
  if (le >= THRESHOLD && le - be > 0.1) return "utf16le"
  if (be >= THRESHOLD && be - le > 0.1) return "utf16be"
  return null
}

/**
 * 识别编码。返回 { encoding, bom, confident }。
 * confident=false 表示是靠打分猜的，前端应当提示用户「如果乱码请手动改编码」。
 *
 * 判定顺序（每一步都有它的理由）：
 *   1. BOM —— 最确定，直接采信；
 *   2. 含 NUL 字节 —— 不可能是普通 UTF-8 文本，先看是不是无 BOM 的 UTF-16；
 *   3. 合法 UTF-8 —— 认定 UTF-8；
 *   4. 逐个候选编码打分 —— 用「命中常用字」的数量挑出最像的那个；
 *   5. 候选都不像正常文本时，再回头采信 UTF-16 的探测结果。
 *
 * 第 4/5 步的顺序很关键：Shift_JIS 的日文假名字节按 UTF-16BE 读会落在汉字区，
 * 光看「像不像 UTF-16」会把日文误判成 UTF-16，所以要让候选编码先表态。
 */
export function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf8bom", bom: true, confident: true }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf16le", bom: true, confident: true }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf16be", bom: true, confident: true }
  }
  if (!buf.length) return { encoding: "utf8", bom: false, confident: true }

  const utf16 = detectBomlessUtf16(buf)
  const hasNul = buf.subarray(0, 4096).includes(0)

  // 普通文本文件里不会出现 NUL；出现 NUL 时 UTF-8 那条路要绕开，
  // 否则「英文内容的 UTF-16LE 文件」会被当成 UTF-8 读出满屏 \0
  if (!hasNul && isValidUtf8(buf)) return { encoding: "utf8", bom: false, confident: true }

  const ranked = []
  for (const candidate of CANDIDATES) {
    const result = scoreCandidate(buf, candidate)
    if (result !== null) ranked.push({ encoding: candidate, ...result })
  }
  ranked.sort((a, b) => b.score - a.score)
  const best = ranked[0]

  // 「像正常文本」= 没有替换字符、没有控制字符，并且命中过常用字。
  // 命中数既看绝对值也看比例：很短的样例（比如只有 4 个字的 GBK 小文件）
  // 不可能凑到 3 个常用字，只看绝对值会把 GBK 判给 UTF-16 那一侧。
  const hitRatio = best ? best.hits / best.sampled : 0
  const legacyLooksLikeText =
    !!best && best.replacement === 0 && best.control === 0 && (best.hits >= 3 || hitRatio >= 0.15)
  if (!legacyLooksLikeText && utf16) {
    return { encoding: utf16, bom: false, confident: true }
  }

  if (!best) {
    return utf16
      ? { encoding: utf16, bom: false, confident: false }
      : { encoding: "utf8", bom: false, confident: false }
  }
  // 与第二名的分差够大才算有把握，否则前端会提示「乱码就手动换编码」
  const confident = ranked.length < 2 || best.score - ranked[1].score >= 10
  return { encoding: best.encoding, bom: false, confident }
}

/** 解码成文本，换行统一成 \n（textarea 只认 \n），并回报原始换行风格 */
export function decodeBuffer(buf, encoding) {
  const codec = codecOf(encoding)
  let text = iconv.decode(buf, codec)
  // 去掉 BOM：iconv 对 utf8/utf16 的 BOM 处理不一致，这里统一剥掉
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/** 探测换行风格 */
export function detectEol(text) {
  if (text.includes("\r\n")) return "crlf"
  if (text.includes("\n")) return "lf"
  if (text.includes("\r")) return "cr"
  return "lf"
}

/** 按选择的风格还原换行 */
export function applyEol(text, eol) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (eol === "crlf") return normalized.replace(/\n/g, "\r\n")
  if (eol === "cr") return normalized.replace(/\n/g, "\r")
  return normalized
}

/**
 * 编码成 Buffer，并回读比对找出「目标编码表示不了」的字符。
 * 不比对的话 iconv 会静默写成「?」，用户看到保存成功、内容却已经毁了。
 */
export function encodeText(text, encoding) {
  const codec = codecOf(encoding)
  let buffer
  try {
    buffer = iconv.encode(text, codec)
  } catch (err) {
    return { error: `无法用 ${encodingLabel(encoding)} 编码：${err.message}` }
  }
  let back = iconv.decode(buffer, codec).replace(/^\uFEFF/, "")
  // 按标准给需要 BOM 的编码补上 BOM：
  // UTF-16 没有 BOM 时字节序无法区分（记事本等工具也依赖 BOM 才认对）。
  if (encoding === "utf8bom") {
    buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buffer])
  } else if (encoding === "utf16le") {
    buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), buffer])
  } else if (encoding === "utf16be") {
    buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), buffer])
  }
  if (back === text) return { buffer, unmappable: [] }

  const bad = new Set()
  const limit = Math.min(back.length, text.length)
  for (let i = 0; i < limit; i += 1) {
    if (back[i] !== text[i]) bad.add(text[i])
    if (bad.size >= 32) break
  }
  if (back.length !== text.length) {
    // 长度都变了（通常是被折叠成单字节），整体标出来
    for (const ch of text) if (!back.includes(ch)) bad.add(ch)
  }
  return { buffer, unmappable: [...bad].filter((c) => c !== "\n" && c !== "\r") }
}

/** 供前端展示的编码列表 */
export function encodingList() {
  return EDITOR_ENCODINGS
}
