import { createRequire } from "node:module"
import {
  applyEol, decodeBuffer, detectEncoding, detectEol, encodeText, looksBinary, EDITOR_ENCODINGS,
} from "./server/src/encoding.js"

const require = createRequire(import.meta.url)
const iconv = require("./server/node_modules/iconv-lite")

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`}`)
}

const ZH = "第一行中文内容\n第二行：测试编码识别\n第三行结束\n"
const TW = "第一行繁體中文內容\n第二行：測試編碼識別\n第三行結束\n"
const JA = "こんにちは世界\nこれはテストです\n日本語のファイル\n"
const KO = "안녕하세요 세계\n이것은 테스트입니다\n한국어 파일\n"

console.log("=== 1. 带 BOM 的识别 ===")
{
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ZH, "utf8")])
  check("UTF-8 BOM 识别", detectEncoding(utf8).encoding, "utf8bom")
  check("UTF-8 BOM 解码", decodeBuffer(utf8, "utf8bom"), ZH)

  const u16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ZH, "utf16le")])
  check("UTF-16LE 识别", detectEncoding(u16le).encoding, "utf16le")
  check("UTF-16LE 解码", decodeBuffer(u16le, "utf16le"), ZH)

  const beBody = Buffer.from(ZH, "utf16le")
  for (let i = 0; i < beBody.length; i += 2) { const t = beBody[i]; beBody[i] = beBody[i + 1]; beBody[i + 1] = t }
  const u16be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody])
  check("UTF-16BE 识别", detectEncoding(u16be).encoding, "utf16be")
  check("UTF-16BE 解码", decodeBuffer(u16be, "utf16be"), ZH)
}

console.log("\n=== 2. 无 BOM 的识别（关键：GBK / Big5 不能混淆）===")
{
  check("UTF-8 无 BOM", detectEncoding(Buffer.from(ZH, "utf8")).encoding, "utf8")
  check("纯 ASCII", detectEncoding(Buffer.from("hello world\n", "utf8")).encoding, "utf8")

  const gbk = iconv.encode(ZH, "gbk")
  const g = detectEncoding(gbk)
  check("GBK 识别为 gb18030 系", g.encoding, "gb18030")
  check("GBK 解码正确", decodeBuffer(gbk, g.encoding), ZH)
  check("GBK 判定为有把握", g.confident, true)

  const big5 = iconv.encode(TW, "big5")
  const b = detectEncoding(big5)
  check("Big5 识别", b.encoding, "big5")
  check("Big5 解码正确", decodeBuffer(big5, b.encoding), TW)

  const sjis = iconv.encode(JA, "shift_jis")
  const s = detectEncoding(sjis)
  check("Shift_JIS 识别", s.encoding, "shift_jis")
  check("Shift_JIS 解码正确", decodeBuffer(sjis, s.encoding), JA)

  const kr = iconv.encode(KO, "euc-kr")
  const k = detectEncoding(kr)
  check("EUC-KR 识别", k.encoding, "euc-kr")
  check("EUC-KR 解码正确", decodeBuffer(kr, k.encoding), KO)
}

console.log("\n=== 3. 保存时编码写回 ===")
{
  const gbk = iconv.encode(ZH, "gbk")
  const r = encodeText(ZH, "gb18030")
  check("GB18030 写回字节与原始一致", r.buffer.equals(gbk), true)
  check("GB18030 无不可表示字符", r.unmappable.length, 0)

  const rBom = encodeText(ZH, "utf8bom")
  check("UTF-8 BOM 写入带 BOM", rBom.buffer.subarray(0, 3).toString("hex"), "efbbbf")
  check("UTF-8 BOM 内容正确", decodeBuffer(rBom.buffer, "utf8bom"), ZH)

  const rU16 = encodeText(ZH, "utf16le")
  check("UTF-16LE 写回可解码", decodeBuffer(rU16.buffer, "utf16le"), ZH)

  // GB18030 是完整的 Unicode 变换格式：连 emoji 都能用 4 字节表示，
  // 所以这里不该报「不可表示」。先确认它真能无损往返。
  const emoji = encodeText("中文😀表情", "gb18030")
  check("GB18030 能表示 emoji（4 字节）", emoji.unmappable.length, 0)
  check("GB18030 emoji 无损往返", decodeBuffer(emoji.buffer, "gb18030"), "中文😀表情")
  check("GB18030 emoji 用 4 字节", emoji.buffer.includes(Buffer.from("90308130", "hex")) || emoji.buffer.length > 10, true)

  const okUtf8 = encodeText("中文😀表情", "utf8")
  check("UTF-8 不误报不可表示", okUtf8.unmappable.length, 0)

  // 真正表示不了的组合：Big5 没有简体「试」；ISO-8859-1 完全没有汉字
  const simp = encodeText("测试", "big5")
  check("Big5 检出简体不可表示", simp.unmappable.length > 0, true)
  const latin = encodeText("中文abc", "iso-8859-1")
  check("Latin-1 检出汉字不可表示", latin.unmappable.length > 0, true)
  const latinOk = encodeText("café abc", "iso-8859-1")
  check("Latin-1 能表示 café", latinOk.unmappable.length, 0)
}

console.log("\n=== 4. 换行风格 ===")
{
  check("CRLF 探测", detectEol("a\r\nb\r\n"), "crlf")
  check("LF 探测", detectEol("a\nb\n"), "lf")
  check("CR 探测", detectEol("a\rb\r"), "cr")
  check("LF -> CRLF", applyEol("a\nb", "crlf"), "a\r\nb")
  check("CRLF -> LF", applyEol("a\r\nb", "lf"), "a\nb")
  // 结尾那个孤立 \r 本身就是「经典 Mac」换行，所以也该变成 \r\n
  check("混合 -> CRLF", applyEol("a\nb\r\nc\r", "crlf"), "a\r\nb\r\nc\r\n")
  check("幂等：CRLF 再转 CRLF", applyEol(applyEol("a\nb", "crlf"), "crlf"), "a\r\nb")
}

console.log("\n=== 5. 二进制拦截 ===")
{
  check("PNG 头判为二进制", looksBinary(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), true)
  check("普通文本不误判", looksBinary(Buffer.from(ZH, "utf8")), false)
  check("空文件不误判", looksBinary(Buffer.alloc(0)), false)
  check("带 TAB 的文本不误判", looksBinary(Buffer.from("a\tb\nc", "utf8")), false)
}

console.log("\n=== 6. 无 BOM 的 UTF-16 与写回时的 BOM ===")
{
  const le = Buffer.from(ZH, "utf16le")
  check("无 BOM UTF-16LE 识别", detectEncoding(le).encoding, "utf16le")
  check("无 BOM UTF-16LE 解码", decodeBuffer(le, "utf16le"), ZH)

  const beBody2 = Buffer.from(ZH, "utf16le")
  for (let i = 0; i < beBody2.length; i += 2) { const t = beBody2[i]; beBody2[i] = beBody2[i + 1]; beBody2[i + 1] = t }
  check("无 BOM UTF-16BE 识别", detectEncoding(beBody2).encoding, "utf16be")

  const wLe = encodeText(ZH, "utf16le")
  check("utf16le 写回带 BOM", wLe.buffer.subarray(0, 2).toString("hex"), "fffe")
  check("utf16le 带 BOM 可解码", decodeBuffer(wLe.buffer, "utf16le"), ZH)
  const wBe = encodeText(ZH, "utf16be")
  check("utf16be 写回带 BOM", wBe.buffer.subarray(0, 2).toString("hex"), "feff")
  check("utf16be 带 BOM 可解码", decodeBuffer(wBe.buffer, "utf16be"), ZH)
}

console.log("\n=== 7. 编码白名单 ===")
{
  check("编码列表非空", EDITOR_ENCODINGS.length > 0, true)
  const ids = EDITOR_ENCODINGS.map((e) => e.id)
  check("含 gb18030", ids.includes("gb18030"), true)
  check("含 utf8bom", ids.includes("utf8bom"), true)
  for (const e of EDITOR_ENCODINGS) {
    const probe = encodeText("测试abc", e.id)
    check(`编码 ${e.id} 可用`, !probe.error, true)
  }
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
