/**
 * convert/pdf/font.js —— 为 PDF 找一个能排中文的字体，并提供"排版用的度量视图"。
 *
 * 两条现实约束：
 *   1. **不能把字体打进仓库**：一个能覆盖中文的 TrueType 动辄 10~20MB，塞进仓库会让
 *      克隆和发布包都变胖，而且中文字体的授权要单独说清楚。
 *   2. **又不能要求用户装字体**：所以按平台去找系统里几乎必然存在的几款中文字体，
 *      再加两个显式入口（环境变量 `CONVERT_PDF_FONT`、`data/fonts/` 目录）。
 *
 * 找字体这件事**不能硬编码路径**（v2.1.0 的第一版就是硬编码 `C:/Windows/Fonts`）：
 * Windows 装在 D 盘、字体是"仅为当前用户安装"、精简版系统、Linux 发行版的目录差异，
 * 每一种都会让硬编码全落空，而落空的后果是 PDF 里中文全变成 `?`。
 * 现在改成：环境变量 → `data/fonts/` → **按平台枚举字体目录并扫描文件名** →
 * 少数几条兜底绝对路径。扫到的候选按"常见中文字体名"的优先级排序，逐个真解析验证
 * （能解析 + cmap 里认得「中」字才算数）。
 *
 * 一个字体都找不到时**不再偷偷把中文写成 `?`**：调用方（converters/md-to-pdf.js）
 * 会用 `assertRenderable()` 拒绝这次转换并给出可操作的提示。理由与在线编辑拒绝
 * "目标编码表示不了的字符"完全一致 —— 宁可不转，也不要交出一份内容已经损坏的文件。
 * 纯 ASCII 文档仍然能转（内置 Helvetica + WinAnsi）。
 *
 * 只接受 TrueType 轮廓（glyf）。CFF/OTF（'OTTO'）会被跳过并继续找下一个，
 * 原因见 truetype.js 的说明。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DATA_DIR, ROOT_DIR } from "../../env.js"
import { getConfig } from "../../config.js"
import { advances, charMap, parseFont, subsetFont, buildFontProgram } from "./truetype.js"

/** 去掉控制台噪声用：最多尝试多少个候选字体（正常情况下第一个就成） */
const MAX_TRIES = 12
/** 负结果缓存时长：管理员把字体丢进 data/fonts/ 后最多等这么久就能生效，不用重启 */
const MISS_TTL_MS = 60 * 1000

/**
 * 常见中文字体的文件名优先级（越靠前越优先）。
 * 只用于**排序**，最终是否可用仍由真实解析 + cmap 验证决定。
 */
const NAME_PRIORITY = [
  /^msyh\.ttc$/i, // Windows 微软雅黑（默认 UI 字体，观感最好）
  /^msyh/i,
  /^msyhl/i,
  /^pingfang/i, // macOS 苹方
  /^sourcehansans/i, // 思源黑体
  /^sourcehanserif/i,
  /^notosanscjk/i,
  /^notoserifcjk/i,
  /^notosanssc/i,
  /^wqy-(zen|micro)hei/i, // Linux 文泉驿
  /^simhei\.ttf$/i, // Windows 黑体
  /^hiragino/i,
  /^droid ?sans ?fallback/i,
  /^deng/i, // 等线
  /^msjh/i, // 微软正黑（繁中）
  /^simsun/i, // 宋体（最老、一定有）
  /^simkai/i,
  /^mingliu/i,
  /^(u|a)ming/i,
  /^(u|a)kai/i,
  /^stheiti/i,
  /^arialuni/i,
]

/** 扫描目录时只认这些扩展名（CFF 的 .otf 也扫，但会在解析阶段被跳过） */
const FONT_EXT = /\.(ttf|ttc|otf)$/i

/** 该平台有哪些目录可能装着中文字体 */
function fontDirs() {
  const env = process.env
  const dirs = []
  if (process.platform === "win32") {
    // 系统字体目录的盘符/大小写都可能不同：优先问环境变量，最后才用 C: 兜底
    for (const root of [env.WINDIR, env.SystemRoot, "C:\\Windows"]) {
      if (root) dirs.push(path.join(root, "Fonts"))
    }
    // "仅为当前用户安装"的字体装在这里
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"))
  } else if (process.platform === "darwin") {
    dirs.push("/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts")
    dirs.push(path.join(os.homedir(), "Library", "Fonts"))
  } else {
    dirs.push(
      "/usr/share/fonts",
      "/usr/local/share/fonts",
      "/usr/share/fonts/truetype",
      "/usr/share/fonts/opentype",
      "/usr/share/fonts/TTF",
      path.join(os.homedir(), ".fonts"),
      path.join(os.homedir(), ".local", "share", "fonts")
    )
  }
  return [...new Set(dirs)]
}

/** 少数几条"几乎不会有错"的兜底绝对路径（扫描失败时才会用到） */
const FALLBACK_FILES = {
  win32: ["msyh.ttc", "simhei.ttf", "Deng.ttf", "simsun.ttc", "msjh.ttc"].map(
    (n) => `C:\\Windows\\Fonts\\${n}`
  ),
  darwin: [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
  ],
  linux: [
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  ],
}

/** 递归列出一个目录下的字体文件（最多 max 个，深度最多 4 层，防某些发行版的深目录） */
function listFontFiles(dir, max, depth = 0, acc = []) {
  if (acc.length >= max || depth > 4) return acc
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (acc.length >= max) break
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listFontFiles(full, max, depth + 1, acc)
    } else if (entry.isFile() && FONT_EXT.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

/** 文件名命中的优先级序号（没命中返回一个很大的数，排在后面） */
function nameRank(file) {
  const base = path.basename(file)
  for (let i = 0; i < NAME_PRIORITY.length; i += 1) {
    if (NAME_PRIORITY[i].test(base)) return i
  }
  return NAME_PRIORITY.length
}

/** 扫描结果缓存：文件系统扫描比读 20MB 字体便宜，但也没必要每次转换都扫 */
let dirCache = null
let dirCacheKey = ""
let dirCacheAt = 0
const DIR_CACHE_MS = 5 * 60 * 1000

/**
 * 按优先级列出所有候选字体。
 *
 * 每项带 `explicit` 标记：**服主显式指定**（后台配置 / 环境变量）的字体不受
 * "优先 TrueType"的约束 —— 说了用哪个就用哪个，哪怕它更大。
 */
function candidatePaths() {
  const list = []
  const seen = new Set()
  const push = (file, explicit = false) => {
    if (!file) return
    const resolved = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file)
    const key = resolved.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    list.push({ path: resolved, explicit })
  }

  // 1. **后台指定**（「设置 → 文件转换 → PDF 字体」）：服主说了算，排第一
  const fromConfig = resolveFontPath(configuredFont())
  if (fromConfig) push(fromConfig, true)

  // 2. 环境变量 CONVERT_PDF_FONT（老部署与容器场景仍然有效）
  const fromEnv = String(process.env.CONVERT_PDF_FONT || "").trim()
  if (fromEnv) push(fromEnv, true)

  // 3. data/fonts/：管理员自备字体（离线 / 无字体系统的部署靠它）
  try {
    const dir = path.join(DATA_DIR, "fonts")
    if (fs.existsSync(dir)) {
      const files = fs
        .readdirSync(dir)
        .filter((name) => FONT_EXT.test(name))
        .sort()
      for (const name of files) push(path.join(dir, name))
    }
  } catch {
    /* 目录不可读就跳过 */
  }

  // 4. 扫描平台字体目录（结果缓存 5 分钟）
  const dirs = fontDirs()
  const cacheKey = dirs.join("|")
  const now = Date.now()
  if (dirCacheKey !== cacheKey || !dirCache || now - dirCacheAt > DIR_CACHE_MS) {
    const found = []
    for (const dir of dirs) listFontFiles(dir, 400, 0, found)
    // 只保留"看起来是中文字体"的，以及排在最前的少量未知字体（可能叫别的名字）
    const ranked = found
      .map((file) => ({ file, rank: nameRank(file) }))
      .sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file))
    dirCache = ranked
    dirCacheKey = cacheKey
    dirCacheAt = now
  }
  for (const { file } of dirCache) push(file)

  // 5. 最后的兜底绝对路径
  for (const file of FALLBACK_FILES[process.platform] ?? FALLBACK_FILES.linux) push(file)

  return list
}

/** 内置度量单位：只有 ASCII 时的宽度按 0.5em 估 */
const FALLBACK_UNITS = 1000

let cached = null
let cachedKey = ""
let cachedAt = 0

/**
 * 打开一个可用的字体，并返回一份**全新的**度量视图。
 *
 * 注意：解析结果（几 MB 的表数据）会缓存，但**视图不缓存** —— 视图里带着
 * `usedGids`，如果复用，第二次转换会把上一次用到的字形也一起内嵌进 PDF，
 * 文件只会越来越大。所以每次转换都拿到一份干净的视图。
 *
 * 找不到字体时**只缓存一分钟**：管理员按提示把字体丢进 `data/fonts/` 之后，
 * 一分钟内（或点后台的「重新探测」/ 重启）就会生效。
 *
 * 候选顺序：**后台指定** → `.env` 的 `CONVERT_PDF_FONT` → `data/fonts/` →
 * 系统字体目录。前两个是"服主说用哪个就用哪个"，指定了就一定排在第一位。
 *
 * @returns {Promise<{ ok: boolean, source?: string, kind?: string, reason?: string, font: object }>}
 */
export async function loadFont() {
  const candidates = candidatePaths()
  const key = candidates.map((c) => `${c.explicit ? "!" : ""}${c.path}`).join("|")
  const expired = !cached || cachedKey !== key || (!cached.ok && Date.now() - cachedAt > MISS_TTL_MS)
  if (expired) {
    cached = await probeFont(candidates)
    cachedKey = key
    cachedAt = Date.now()
  }

  const font = cached.ok
    ? createFontView(cached.parsed, cached.advanceTable, cached.map)
    : createFallbackView()
  return { ok: cached.ok, source: cached.source, kind: cached.kind, reason: cached.reason, font }
}

/**
 * 诊断用：当前会用哪个字体 + 每个候选为什么被跳过。
 *
 * 这套信息直接呈现在「设置 → 文件转换」：用户把字体放对地方却仍然报"没有中文字体"时，
 * 唯一能说清原因的就是"这个文件被跳过的理由"（例如 CFF2 变量字体、不含汉字、
 * name-keyed CFF、路径不存在）。启动横幅与后台日志也用它。
 */
export function fontStatus() {
  return {
    ok: !!(cached && cached.ok),
    source: cached?.source ?? null,
    kind: cached?.kind ?? null,
    bytes: cached?.bytes ?? null,
    reason: cached?.reason ?? null,
    checked: !!cached,
    candidates: cached?.attempts ?? [],
    dirs: {
      dataFonts: path.join(DATA_DIR, "fonts"),
      system: fontDirs(),
    },
    /** 后台显式指定的字体（空字符串 = 自动） */
    configured: configuredFont(),
    envFont: String(process.env.CONVERT_PDF_FONT || "").trim() || null,
  }
}

/** 后台「设置 → 文件转换」里指定的字体路径（空 = 自动） */
export function configuredFont() {
  try {
    return String(getConfig().convertPdfFont || "").trim()
  } catch {
    return ""
  }
}

/** 把后台/环境变量里的路径规范化成绝对路径（相对路径按程序根目录解析） */
export function resolveFontPath(input) {
  const raw = String(input || "").trim()
  if (!raw) return ""
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw)
}

/**
 * 校验一个"服主指定"的字体是否真的能用。
 * 后台保存时调用：与其让他保存成功、转换时才失败，不如当场说清楚问题。
 *
 * @returns {Promise<{ ok: boolean, kind?: string, bytes?: number, reason?: string }>}
 */
export async function inspectFontFile(input) {
  const file = resolveFontPath(input)
  if (!file) return { ok: false, reason: "路径为空" }
  if (!FONT_EXT.test(file)) return { ok: false, reason: "只支持 .ttf / .ttc / .otf 字体文件" }
  let buffer
  try {
    buffer = await fs.promises.readFile(file)
  } catch {
    return { ok: false, reason: "文件不存在或没有读取权限" }
  }
  try {
    const parsed = parseFont(buffer)
    const map = charMap(parsed)
    if (!map.has(0x4e2d) && !map.has(0x9ad8)) {
      return { ok: false, kind: parsed.kind, bytes: buffer.length, reason: "这个字体不含汉字（认不出「中」字）" }
    }
    return { ok: true, kind: parsed.kind, bytes: buffer.length, glyphs: parsed.numGlyphs }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  }
}

/** 启动时预探测一次（失败不抛错，只让 status 有内容） */
export async function warmUpFont() {
  try {
    await loadFont()
  } catch {
    /* 探测失败不该影响启动 */
  }
  return fontStatus()
}

/**
 * 依次尝试候选字体，返回解析结果（不含视图）。
 *
 * 三个阶段，顺序是有意的：
 *   1. **显式指定**的字体（后台配置 / 环境变量）：不管你给的是 TrueType 还是 CFF，
 *      说了用哪个就用哪个 —— 否则"我指定了字体却没生效"这种反馈会一直出现；
 *   2. 其余候选里的 **TrueType**：子集只有一两百 KB；
 *   3. 其余候选里的 **CFF**：本机实测子集 0.5~1MB（局部 Subrs 没法安全裁剪，
 *      见 cff.js），所以能不用就不用。
 */
async function probeFont(candidates) {
  const attempts = []
  const tried = new Set()
  const visit = async (entry, allowCff) => {
    if (tried.has(entry.path)) return null
    tried.add(entry.path)
    let buffer
    try {
      buffer = await fs.promises.readFile(entry.path)
    } catch {
      attempts.push({ path: entry.path, explicit: entry.explicit, ok: false, reason: "文件不存在或不可读" })
      return null
    }
    try {
      const parsed = parseFont(buffer)
      if (parsed.kind === "cff" && !allowCff) {
        attempts.push({ path: entry.path, explicit: entry.explicit, ok: false, reason: "跳过（优先 TrueType）" })
        return null
      }
      const map = charMap(parsed)
      // 至少要认得几个常用汉字，否则这个字体帮不上忙（例如只含拉丁的字体）
      if (!map.has(0x4e2d) && !map.has(0x9ad8)) {
        attempts.push({ path: entry.path, explicit: entry.explicit, ok: false, reason: "不含汉字（认不出「中」字）" })
        return null
      }
      attempts.push({ path: entry.path, explicit: entry.explicit, ok: true, reason: "", kind: parsed.kind })
      return {
        ok: true,
        source: entry.path,
        kind: parsed.kind,
        bytes: buffer.length,
        parsed,
        advanceTable: advances(parsed),
        map,
        attempts,
      }
    } catch (err) {
      // CFF2 变量字体 / name-keyed CFF / 损坏文件：记下原因继续找下一个
      attempts.push({ path: entry.path, explicit: entry.explicit, ok: false, reason: String(err?.message || err) })
      return null
    }
  }

  // 1) 显式指定（允许 CFF）
  for (const entry of candidates.filter((c) => c.explicit)) {
    const hit = await visit(entry, true)
    if (hit) return hit
  }
  // 2) 其余候选：先只认 TrueType，有上限地试
  let budget = MAX_TRIES
  for (const entry of candidates.filter((c) => !c.explicit)) {
    if (budget <= 0) break
    const before = attempts.length
    const hit = await visit(entry, false)
    if (hit) return hit
    if (attempts.length > before) budget -= 1
  }
  // 3) 还没有：回头接受 CFF
  for (const entry of candidates.filter((c) => !c.explicit)) {
    const hit = await visit(entry, true)
    if (hit) return hit
  }

  const lastReal = [...attempts].reverse().find((a) => !a.ok && a.reason !== "跳过（优先 TrueType）")
  return {
    ok: false,
    reason: lastReal?.reason || "没有找到可用的中文字体",
    attempts,
  }
}

/** 测试用：清掉缓存（改过 CONVERT_PDF_FONT 后重新探测） */
export function resetFontCache() {
  cached = null
  cachedKey = ""
  cachedAt = 0
  dirCache = null
  dirCacheKey = ""
  dirCacheAt = 0
}

/**
 * 度量视图：把"字符 → 字形号 / CID / 字宽"包成排版层能直接用的形状。
 *
 * 所有宽度单位都是 **1/1000 em**（PDF 的字宽单位），这样内容流与 /W 数组共用一套数字，
 * 不会出现"排版算的和阅读器画的不一致"。
 *
 * 两条路径的差别只在这里收口：
 *   - TrueType：CID == 字形号
 *   - CFF：CID 来自字体 charset（与字形号**常常不相等**，实测 NotoSerifSC 的
 *     「中」是 gid 8742 / cid 9562），所以内容流、/W、ToUnicode 三处都必须用 CID
 */
function createFontView(parsed, advanceTable, map) {
  const perEm = parsed.unitsPerEm || FALLBACK_UNITS
  const toMil = (units) => Math.round((units / perEm) * 1000)
  /** 用到的是**原始字形号**（子集化需要它们） */
  const usedGids = new Set()
  /** CID → 该 CID 的宽度（/W 数组按 CID 索引） */
  const widthByCid = new Map()
  const cidToCodePoint = new Map()
  const missing = new Set()
  const isCff = parsed.kind === "cff"

  // 缺字时用它顶替（'?' 也缺就退回 0 号字形 .notdef，阅读器会画一个方框）
  const fallbackGid = map.get(0x3f) ?? 0

  /** 字形号 → CID（TrueType 路径下恒等） */
  const cidOf = (gid) => (isCff ? parsed.cidByGid[gid] ?? 0 : gid)

  const view = {
    ok: true,
    kind: parsed.kind,
    source: parsed,
    unitsPerEm: perEm,
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
    widthByCid,
    cidToCodePoint,
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
      const cid = cidOf(gid)
      if (!widthByCid.has(cid)) widthByCid.set(cid, toMil(advanceTable[gid] ?? 0))
      if (!cidToCodePoint.has(cid)) cidToCodePoint.set(cid, codePoint)
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
    /** 生成 PDF 文本串（Identity-H：每个 CID 两个字节的十六进制）与字宽 */
    encode(text) {
      let hex = ""
      let width = 0
      for (const ch of text) {
        const gid = view.gidFor(ch.codePointAt(0))
        const cid = cidOf(gid)
        hex += cid.toString(16).padStart(4, "0").toUpperCase()
        width += view.rawAdvance(gid)
      }
      return { hex, width }
    },
    /**
     * 收尾：生成可内嵌的字体程序。
     * @returns {{ program: Buffer, format: "truetype"|"cff", note?: string }}
     */
    buildSubset() {
      return buildFontProgram(parsed, usedGids)
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
