#!/usr/bin/env node
/**
 * i18n-check.mjs —— 多语言文案的完整性校验
 *
 * 为什么需要它：命名键方案下，"键写错/漏定义"不会在构建期报错，只会在界面上
 * 显示成一串 `ui.browser.toolbar.upload`。靠人眼通读 1000+ 个键不现实，
 * 所以把判断固化成脚本：
 *
 *   1. 源码里用到的键（t("...") / translate("...")）是否都在 zh / en 里定义了；
 *      - 缺 zh：**错误**（界面会直接显示键名）
 *      - 缺 en：警告（会回落到中文，但英文界面里冒出中文很难看）
 *   2. en 里有、zh 里没有的键：**错误**（zh 是兜底来源，缺了就是漏翻）
 *   3. 定义了两个语言都没用到的键：警告（死键，通常是改名后的残留）
 *   4. 同一个键在两份 area 文件里被定义了两次且文案不同：**错误**
 *   5. data/lang/*.json（如果存在）是否含有非法键名 / 非字符串值：警告
 *   6. 源码里还剩多少处硬编码中文（未接入 i18n 的地方）：警告
 *
 * 用法：
 *   node i18n-check.mjs            # 报告 + 退出码 = 错误数
 *   node i18n-check.mjs --strict   # 把"剩余硬编码中文"也算作错误
 *   node i18n-check.mjs --list-cn  # 只列出剩余硬编码中文
 */

import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname)
const WEB_SRC = path.join(ROOT, "web", "src")
const LOCALES = path.join(WEB_SRC, "locales")
const COMPAT_DIR = path.join(ROOT, "web", "public", "robustness")
const LANG_DIR = path.join(ROOT, "data", "lang")

const args = new Set(process.argv.slice(2))
const STRICT = args.has("--strict")
const LIST_CN = args.has("--list-cn")

const CJK = /[\u4e00-\u9fff]/
/**
 * 命名键格式：`<命名空间>.<区域>.<名字>`，至少三段。
 * 要求三段是为了排除文件名误报 —— 服务端 trash.js 里有 `"meta.json"`，
 * 两段的话会被当成 `meta` 命名空间下的键。
 */
const KEY_RE = /^(?:ui|api|meta|compat)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/

/**
 * 这些位置的中文不算"漏翻"，逐条列出理由，避免每次跑都有人重新判断一遍。
 */
const ALLOWED_CN = [
  // 开发者才会看到的内部错误（hook 用错位置），不需要翻译
  /must be used within/,
  // 语言自称（语言选择器里的 "简体中文"）本身就要求用中文显示
  /简体中文/,
]

function walk(dir, test) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(file, test))
    else if (test(entry.name)) out.push(file)
  }
  return out
}

/**
 * 去掉注释但保留字符串字面量（否则字符串里的 // 会被误当注释），
 * 同时把**正则字面量**整段吃掉。
 *
 * 为什么要专门处理正则：`lib/markdown.ts` 里有 `/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/`
 * 这样的模式串，里面那个反引号会让朴素的剥离器以为"模板字符串开始了"，
 * 于是把后面整段代码（含注释）都当成字符串 —— 结果满屏假的中文命中。
 * 判断 `/` 是正则还是除号，用的是"上一个有效字符"启发式（与 JS 词法一致）。
 */
const REGEX_PREV = "([{,;:=!&|?+-*%~^<>"

/** 消费一个模板字面量（i 指向起始反引号）；**必须处理 ${} 里再嵌模板**，
 *  否则 `a${`b${c}`}` 这种写法会让剥离器提前收尾、把后面的注释当成字符串。 */
function readTemplate(text, i) {
  i += 1
  while (i < text.length) {
    const c = text[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "`") return i + 1
    if (c === "$" && text[i + 1] === "{") {
      i = readBraced(text, i + 2)
      continue
    }
    i += 1
  }
  return i
}

/** 消费 `${` 之后的表达式（含嵌套的 {} 与字符串/模板），返回 `}` 之后的下标 */
function readBraced(text, i) {
  let depth = 1
  while (i < text.length) {
    const c = text[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "{") {
      depth += 1
      i += 1
      continue
    }
    if (c === "}") {
      depth -= 1
      i += 1
      if (!depth) return i
      continue
    }
    if (c === "`") {
      i = readTemplate(text, i)
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      i += 1
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    i += 1
  }
  return i
}

function stripComments(text) {
  let out = ""
  let i = 0
  let prev = ""
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (c === "/" && n === "/") {
      const end = text.indexOf("\n", i)
      i = end < 0 ? text.length : end
      continue
    }
    if (c === "/" && (!prev || REGEX_PREV.includes(prev))) {
      // 正则字面量：整段丢掉（正则里的中文不是界面文案）
      i++
      let inClass = false
      while (i < text.length) {
        const ch = text[i]
        if (ch === "\\") {
          i += 2
          continue
        }
        if (ch === "[") inClass = true
        else if (ch === "]") inClass = false
        else if (ch === "/" && !inClass) {
          i++
          break
        } else if (ch === "\n") break
        i++
      }
      prev = "/"
      out += "0"
      continue
    }
    if (c === "`") {
      const end = readTemplate(text, i)
      out += text.slice(i, end)
      i = end
      prev = "`"
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      out += c
      i++
      while (i < text.length) {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "")
          i += 2
          continue
        }
        out += text[i]
        if (text[i] === quote) {
          i++
          break
        }
        i++
      }
      prev = quote
      continue
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

/* ------------------------------ 1. 收集用到的键 ------------------------------ */

const used = new Map() // key -> Set(相对文件)
function record(key, file) {
  if (!KEY_RE.test(key)) return
  if (!used.has(key)) used.set(key, new Set())
  used.get(key).add(file)
}

const sourceFiles = [
  ...walk(WEB_SRC, (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts")),
  ...walk(COMPAT_DIR, (n) => n.endsWith(".js")),
  // 服务端也要扫：它的业务错误带 errorKey（命名键），元数据模块带 meta.* 键。
  // 这些键同样是"被使用"的，必须能在字典里找到，否则界面会直接显示键名。
  ...walk(path.join(ROOT, "server", "src"), (n) => n.endsWith(".js")),
  // 入口文件也要扫：统一的 404 / 500 响应就在 server/index.js 里
  path.join(ROOT, "server", "index.js"),
].filter((f) => !f.startsWith(LOCALES) && fs.existsSync(f) && fs.statSync(f).isFile())

/**
 * 判定"用到的键"的口径：**任何**匹配命名键格式的字符串字面量都算。
 * 比"只认 t(...) 的第一个参数"更宽，但不会误报 —— 键必须以 ui./api./meta./compat.
 * 开头，普通字符串不会长这样。这样服务端 `errorKey: "api.fs.path_invalid"`、
 * 元数据表里的 `"meta.exif.make"` 都能被统计到。
 */
const KEY_LITERAL = /["'`]((?:ui|api|meta|compat)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)["'`]/g

for (const file of sourceFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/")
  const text = stripComments(fs.readFileSync(file, "utf8"))
  for (const m of text.matchAll(KEY_LITERAL)) record(m[1], rel)
  // 兼容模式页用的是 T("...")，上面的正则已经覆盖；这里再兜一层拼接出来的键
  for (const m of text.matchAll(/\b(?:t|T|translate)\(\s*"([^"\\]*)"|::(?:t|T|translate)\(\s*'([^'\\]*)'/g)) {
    const key = m[1] ?? m[2]
    if (key) record(key, rel)
  }
}

/* ------------------------------ 2. 读取字典 ------------------------------ */

function readArea(lang) {
  const dir = path.join(LOCALES, lang)
  const keys = new Map() // key -> { value, file }
  const duplicates = []
  if (!fs.existsSync(dir)) return { keys, duplicates }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let json
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
    } catch (err) {
      duplicates.push(`locales/${lang}/${file} JSON 解析失败：${err.message}`)
      continue
    }
    for (const [key, value] of Object.entries(json)) {
      if (typeof value !== "string") continue
      const hit = keys.get(key)
      if (hit && hit.value !== value) {
        duplicates.push(`${key} 在 ${hit.file} 与 ${file} 中不一致（“${hit.value}” / “${value}”）`)
      }
      keys.set(key, { value, file })
    }
  }
  return { keys, duplicates }
}

const zh = readArea("zh")
const en = readArea("en")

/* ------------------------------ 3. 剩余硬编码中文 ------------------------------ */

const hardcoded = []
for (const file of sourceFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/")
  const text = stripComments(fs.readFileSync(file, "utf8"))
  const found = new Set()
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ""
    if (!CJK.test(value)) continue
    if (ALLOWED_CN.some((re) => re.test(value))) continue
    if (KEY_RE.test(value)) continue
    found.add(value.length > 60 ? `${value.slice(0, 60)}…` : value)
  }
  // JSX 文本节点：>中文<
  for (const m of text.matchAll(/>([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g)) {
    const value = m[1].trim()
    if (value && !ALLOWED_CN.some((re) => re.test(value))) found.add(value)
  }
  if (found.size) hardcoded.push([rel, [...found]])
}

/* ------------------------------ 4. data/lang 体检 ------------------------------ */

const langIssues = []
if (fs.existsSync(LANG_DIR)) {
  for (const file of fs.readdirSync(LANG_DIR)) {
    if (!file.endsWith(".json") || file.startsWith("_") || file.startsWith(".")) continue
    const code = file.slice(0, -".json".length)
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) {
      langIssues.push(`${file}：语言代码不合规（只允许小写字母 + 可选地区后缀）`)
      continue
    }
    let json
    try {
      json = JSON.parse(fs.readFileSync(path.join(LANG_DIR, file), "utf8"))
    } catch (err) {
      langIssues.push(`${file}：JSON 解析失败（${err.message}）`)
      continue
    }
    const source = json && typeof json.translations === "object" && json.translations ? json.translations : json
    let bad = 0
    for (const [key, value] of Object.entries(source ?? {})) {
      if (key === "_meta" || key.startsWith("_")) continue
      if (!KEY_RE.test(key) || typeof value !== "string") bad++
    }
    if (bad) langIssues.push(`${file}：${bad} 条会被忽略（键名不合规或值不是字符串）`)
  }
}

/* ------------------------------ 5. 汇总 ------------------------------ */

if (LIST_CN) {
  for (const [file, values] of hardcoded) {
    console.log(`\n${file}`)
    for (const v of values) console.log(`  ${v}`)
  }
  process.exit(0)
}

const errors = []
const warnings = []

for (const [key, files] of [...used].sort()) {
  if (!zh.keys.has(key)) errors.push(`zh 缺少键 ${key}（用于 ${[...files].join(", ")}）`)
  else if (!en.keys.has(key)) warnings.push(`en 缺少键 ${key}（英文界面会显示中文）`)
}
for (const key of en.keys.keys()) if (!zh.keys.has(key)) errors.push(`en 里有 ${key}，但 zh 里没有（zh 是兜底来源）`)

/**
 * 英文值里出现汉字 = 漏翻（抄了中文当英文）。
 * 少数例外：语言自称（"简体中文" 是给语言选择器用的名字）确实该是中文，用白名单放行。
 */
const EN_CJK_ALLOWED = [/^简体中文$/, /^日本語$/, /^繁體中文$/]
for (const [key, { value }] of en.keys) {
  if (!CJK.test(value)) continue
  if (EN_CJK_ALLOWED.some((re) => re.test(value))) continue
  errors.push(`en 里的 ${key} 仍含中文：“${value.slice(0, 40)}”`)
}

for (const key of zh.keys.keys()) if (!used.has(key)) warnings.push(`zh 里的 ${key} 没有被任何源码使用`)
errors.push(...zh.duplicates)
for (const issue of langIssues) warnings.push(`data/lang：${issue}`)

const cnCount = hardcoded.reduce((sum, [, v]) => sum + v.length, 0)

console.log("ZeroShadow i18n 校验")
console.log(`  源文件        ${sourceFiles.length}`)
console.log(`  用到的键      ${used.size}`)
console.log(`  zh 已定义     ${zh.keys.size}`)
console.log(`  en 已定义     ${en.keys.size}`)
console.log(`  剩余硬编码中文 ${cnCount} 处（${hardcoded.length} 个文件）`)

if (errors.length) {
  console.log(`\n错误（${errors.length}）：`)
  for (const e of errors) console.log(`  ✗ ${e}`)
}
if (warnings.length) {
  console.log(`\n警告（${warnings.length}）：`)
  for (const w of warnings.slice(0, 60)) console.log(`  ! ${w}`)
  if (warnings.length > 60) console.log(`  … 另有 ${warnings.length - 60} 条`)
}
if (hardcoded.length) {
  console.log(`\n还没接入 i18n 的中文（${hardcoded.length} 个文件，用 --list-cn 看明细）：`)
  for (const [file, values] of hardcoded.slice(0, 40)) console.log(`  ${file}  ×${values.length}`)
  console.log(
    `  ↑ 注意：**服务端文件里的中文大多是设计使然**，不是漏改 ——\n` +
      `     · error 字段必须保留中文原文（第三方脚本与 curl 的既有行为）；\n` +
      `     · 元数据的 label / value 是缺译文时的兜底；\n` +
      `     · info() / warn() 的日志、启动横幅、.env 模板都不做本地化。\n` +
      `     真正要清零的是**前端**（web/src、web/public/robustness）与\n` +
      `     「服务端新加的中文有没有一并给 errorKey」。`
  )
}

const failed = errors.length + (STRICT ? cnCount : 0)
console.log(`\n结果：错误 ${errors.length}，警告 ${warnings.length}${STRICT ? `，硬编码 ${cnCount}（strict 下计入失败）` : ""}`)
process.exit(failed)
