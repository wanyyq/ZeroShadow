/**
 * convert/pdf/font.js —— 为 PDF 找一个能排中文的字体，并提供"排版用的度量视图"。
 *
 * 两条现实约束：
 *   1. **不能把字体打进仓库**：一个能覆盖中文的 TrueType 动辄 10~20MB，塞进仓库会让
 *      克隆和发布包都变胖，而且中文字体的授权要单独说清楚。
 *   2. **又不能要求用户装字体**：所以按平台依次尝试系统里几乎必然存在的几款中文字体，
 *      再加两个显式入口（环境变量 `CONVERT_PDF_FONT`、`data/fonts/` 目录），
 *      部署环境是精简 Linux（没有任何中文字体）时管理员丢一个 ttf 进去就能用。
 *
 * 找不到任何中文字体时**不报错**：退化成只含 ASCII 的内置度量，PDF 里的中文会变成
 * `?`，同时由调用方在结果里带一个 warning —— 生成一个"能打开但中文缺失"的 PDF，
 * 比让整个功能直接不可用要好，而且用户能看懂发生了什么。
 *
 * 只接受 TrueType 轮廓（glyf）。CFF/OTF（'OTTO'）会被跳过并继续找下一个，
 * 原因见 truetype.js 的说明。
 */
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR, ROOT_DIR } from "../../env.js"
import { advances, charMap, parseFont, subsetFont } from "./truetype.js"

/** 各平台常见的中文字体（顺序即优先级） */
const PLATFORM_CANDIDATES = {
  win32: [
    "C:/Windows/Fonts/msyh.ttc", // 微软雅黑（Win7+ 默认 UI 字体，观感最好）
    "C:/Windows/Fonts/msyhl.ttc",
    "C:/Windows/Fonts/simhei.ttf", // 黑体
    "C:/Windows/Fonts/Deng.ttf", // 等线
    "C:/Windows/Fonts/simsun.ttc", // 宋体（兜底，一定有）
  ],
  darwin: [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/STHeiti Light.ttc",
  ],
  linux: [
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", // 文泉驿（Debian/Ubuntu 常见）
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
  ],
}

/** 只有 ASCII 时的内置度量：等宽 0.5em，保证没有字体也能算出稳定的版面 */
const FALLBACK_UNITS = 1000

let cached = null
let cachedKey = ""

function candidatePaths() {
  const list = []
  const fromEnv = String(process.env.CONVERT_PDF_FONT || "").trim()
  if (fromEnv) list.push(fromEnv)
  // data/fonts/：管理员自备字体（离线部署时最省事的办法）
  try {
    const dir = path.join(DATA_DIR, "fonts")
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (/\.(ttf|ttc)$/i.test(name)) list.push(path.join(dir, name))
      }
    }
  } catch {
    /* 目录不可读就跳过 */
  }
  list.push(...(PLATFORM_CANDIDATES[process.platform] ?? PLATFORM_CANDIDATES.linux))
  return list.map((p) => (path.isAbsolute(p) ? p : path.join(ROOT_DIR, p)))
}

/**
 * 打开一个可用的字体，并返回一份**全新的**度量视图。
 *
 * 注意：解析结果（几 MB 的表数据）会缓存，但**视图不缓存** —— 视图里带着
 * `usedGids`，如果复用，第二次转换会把上一次用到的字形也一起内嵌进 PDF，
 * 文件只会越来越大。所以每次转换都拿到一份干净的视图。
 *
 * @returns {Promise<{ ok: boolean, source?: string, reason?: string, font: object }>}
 */
export async function loadFont() {
  const candidates = candidatePaths()
  const key = candidates.join("|")
  if (!cached || cachedKey !== key) cached = await probeFont(candidates)
  cachedKey = key

  const font = cached.ok
    ? createFontView(cached.parsed, cached.advanceTable, cached.map)
    : createFallbackView()
  return { ok: cached.ok, source: cached.source, reason: cached.reason, font }
}

/** 依次尝试候选字体，返回解析结果（不含视图） */
async function probeFont(candidates) {
  let lastReason = "没有找到可用的中文字体"
  for (const file of candidates) {
    let buffer
    try {
      buffer = await fs.promises.readFile(file)
    } catch {
      continue // 文件不存在就是最正常的跳过路径
    }
    try {
      const parsed = parseFont(buffer)
      const map = charMap(parsed)
      // 至少要认得几个常用汉字，否则这个字体帮不上忙（例如只含拉丁的字体）
      if (!map.has(0x4e2d) && !map.has(0x9ad8)) {
        lastReason = `${path.basename(file)} 不含中文字形`
        continue
      }
      return { ok: true, source: file, parsed, advanceTable: advances(parsed), map }
    } catch (err) {
      // CFF / 损坏的字体：记下原因继续找下一个
      lastReason = `${path.basename(file)}: ${err.message}`
    }
  }
  return { ok: false, reason: lastReason }
}

/** 测试用：清掉缓存（改过 CONVERT_PDF_FONT 后重新探测） */
export function resetFontCache() {
  cached = null
  cachedKey = ""
}

/**
 * 度量视图：把"字符 → 字形号 / 字宽"包成排版层能直接用的形状。
 *
 * 所有宽度单位都是 **1/1000 em**（PDF 的字宽单位），这样内容流与 /W 数组共用一套数字，
 * 不会出现"排版算的和阅读器画的不一致"。
 */
function createFontView(parsed, advanceTable, map) {
  const perEm = parsed.unitsPerEm || FALLBACK_UNITS
  const toMil = (units) => Math.round((units / perEm) * 1000)
  const usedGids = new Set()
  const gidToCodePoint = new Map()
  const missing = new Set()

  // 缺字时用它顶替（'?' 也缺就退回 0 号字形 .notdef，阅读器会画一个方框）
  const fallbackGid = map.get(0x3f) ?? 0

  const view = {
    ok: true,
    kind: "truetype",
    source: parsed,
    unitsPerEm: perEm,
    /** 排版行高用：常规字体 ascent 大约 0.88em，descender 约 -0.12em */
    ascent: toMil(parsed.ascender),
    descent: toMil(parsed.descender),
    lineGap: toMil(parsed.lineGap),
    capHeight: parsed.capHeight ? toMil(parsed.capHeight) : toMil(Math.round(perEm * 0.7)),
    bbox: [
      toMil(parsed.bbox.xMin),
      toMil(parsed.bbox.yMin),
      toMil(parsed.bbox.xMax),
      toMil(parsed.bbox.yMax),
    ],
    /** 记录"哪些字符在这个字体里没有字形"，调用方可以据此提示 */
    missingChars: missing,
    usedGids,
    gidToCodePoint,
    rawAdvance(gid) {
      const units = advanceTable[gid] ?? 0
      return toMil(units)
    },
    /** 单个码点 → 字形号（缺字返回 fallbackGid 并记录） */
    gidFor(codePoint) {
      let gid = map.get(codePoint)
      if (gid === undefined) {
        missing.add(String.fromCodePoint(codePoint))
        gid = fallbackGid
      }
      usedGids.add(gid)
      if (!gidToCodePoint.has(gid)) gidToCodePoint.set(gid, codePoint)
      return gid
    },
    /** 一个字符串的字宽（单位 1/1000 em），同时把用到的字形登记下来 */
    measure(text) {
      let width = 0
      for (const ch of text) {
        const gid = view.gidFor(ch.codePointAt(0))
        width += view.rawAdvance(gid)
      }
      return width
    },
    /** 生成 PDF 文本串（Identity-H：每字形两个字节的十六进制）与字宽 */
    encode(text) {
      let hex = ""
      let width = 0
      for (const ch of text) {
        const gid = view.gidFor(ch.codePointAt(0))
        hex += gid.toString(16).padStart(4, "0").toUpperCase()
        width += view.rawAdvance(gid)
      }
      return { hex, width }
    },
    /** 收尾：只保留用到的字形，返回可内嵌的 TrueType 程序 */
    buildSubset() {
      return subsetFont(parsed, usedGids)
    },
  }
  return view
}

/**
 * 没有中文字体时的退化视图：只用 PDF 内置的 Helvetica（WinAnsi），宽度按 0.5em 估。
 * 中文一律用 '?' —— 关键点是**仍然产出一份能打开的 PDF**：宁可缺字，也不要给用户
 * 一个打不开的文件（这也是这里改用简单字体、而不是硬塞空字体程序的原因）。
 */
function createFallbackView() {
  const usedGids = new Set()
  const missing = new Set()
  const view = {
    ok: false,
    kind: "fallback",
    unitsPerEm: FALLBACK_UNITS,
    ascent: 880,
    descent: -120,
    lineGap: 0,
    capHeight: 700,
    bbox: [-20, -220, 1000, 900],
    missingChars: missing,
    usedGids,
    rawAdvance() {
      return 500
    },
    gidFor(codePoint) {
      // 退化模式走 Type1 + WinAnsi：字形号就是**单字节字符码**，超出 0xFF 的一律换成 '?'
      const cp = codePoint <= 0xff ? codePoint : 0x3f
      if (codePoint > 0xff) missing.add(String.fromCodePoint(codePoint))
      usedGids.add(cp)
      return cp
    },
    measure(text) {
      let width = 0
      for (const ch of text) {
        view.gidFor(ch.codePointAt(0))
        width += 500
      }
      return width
    },
    encode(text) {
      let hex = ""
      let width = 0
      for (const ch of text) {
        const code = view.gidFor(ch.codePointAt(0))
        hex += code.toString(16).padStart(2, "0").toUpperCase()
        width += 500
      }
      return { hex, width }
    },
    buildSubset() {
      return null
    },
  }
  return view
}

/** 供测试注入退化视图（生产路径不调用；见 scripts/convert-test.mjs 的退化用例） */
export { createFallbackView as fallbackFontView }
