import fs from "node:fs"
import path from "node:path"
import { LANG_DIR } from "./env.js"
import { warn } from "./logger.js"

// ============================================================================
//  i18n.js —— 界面语言目录（data/lang）
//
//  只做一件事：把 `data/lang/<语言代码>.json` 扫描成一个语言清单，并按需把
//  某个语言的译文交出去。语言文件由部署者自己放进目录，**不需要重启服务**
//  （按 mtime + size 失效缓存），也不需要改任何代码。
//
//  文件格式（两种写法都接受）：
//
//    {
//      "_meta": { "name": "日本語", "base": "en" },
//      "translations": { "ui.common.ok": "OK" }
//    }
//
//    或直接扁平写：
//
//    { "_meta": { "name": "日本語" }, "ui.common.ok": "OK" }
//
//  `_meta.name` 是语言选择器里显示的名字（缺省用文件名），`_meta.base` 是
//  "未翻译的键回落到哪种语言"（默认 zh；内置语言只有 zh / en）。
//
//  安全细节（这个目录的内容是用户提供的）：
//    - 语言代码只允许 `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`，且拼路径时只取
//      代码本身，不做任何路径拼接 —— 无法用它穿越到别的文件；
//    - 单文件上限 2MB、单条译文上限 2000 字符、总键数上限 30000；
//    - `__proto__` / `constructor` / `prototype` 一律丢弃（原型污染）；
//    - 只接受字符串值，且键名必须符合命名键格式，其余静默忽略。
// ============================================================================

/** 内置语言：随前端产物一起发布，data/lang 里同名文件不会覆盖它们 */
export const BUILTIN_LANGS = [
  { code: "zh", name: "简体中文", builtin: true },
  { code: "zh-TW", name: "繁體中文（台灣）", builtin: true },
  { code: "zh-HK", name: "繁體中文（香港）", builtin: true },
  // zh-MO 与 zh-HK 共用同一份译文（构建期派生，见 web/vite.config.ts 的 LOCALE_ALIASES）
  { code: "zh-MO", name: "繁體中文（澳門）", builtin: true },
  { code: "en", name: "English", builtin: true },
  { code: "ja", name: "日本語", builtin: true },
  { code: "es", name: "Español", builtin: true },
  { code: "fr", name: "Français", builtin: true },
]

const CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const KEY_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_KEYS = 30000
const MAX_VALUE_LEN = 2000

const README = `# data/lang —— 自定义界面语言

把语言文件放在这个目录里，刷新网页后它就会出现在「设置 → 外观 → 界面语言」的列表里。
**不需要重启服务，也不需要改任何代码。**

## 文件命名

\`<语言代码>.json\`，代码用小写字母，可选地区后缀：

\`\`\`text
en.json          英语（内置，不需要自己写）
zh.json          中文（内置，不需要自己写）
ja.json          日语
pt-BR.json       巴西葡萄牙语
zh-TW.json       繁体中文
\`\`\`

以 \`_\` 或 \`.\` 开头的文件会被忽略（可以放草稿、备份）。

## 文件格式

\`\`\`json
{
  "_meta": { "name": "日本語", "base": "en" },
  "translations": {
    "ui.common.ok": "OK",
    "ui.common.cancel": "キャンセル",
    "ui.common.save": "保存"
  }
}
\`\`\`

- \`_meta.name\`：语言选择器里显示的名字（建议用该语言自己的写法）。缺省用文件名。
- \`_meta.base\`：**没有翻译到的键**回落到哪种语言，可取 \`zh\`（默认）或 \`en\`。
  所以你可以先翻一半就用起来。
- \`translations\`：键值对，键就是前端源码里 \`t("...")\` 的那个键。
  也可以省略这层，把键值对直接写在顶层。

## 怎么拿到全部键

在网盘界面里打开「设置 → 外观 → 界面语言」，点「导出翻译模板」，
会下载一个包含**所有键**的 JSON（值就是中文原文）。把它改名成目标语言代码、
把值逐条翻成你的语言，放回本目录即可。

只想翻一部分也行：没翻到的键会自动回落到 \`_meta.base\` 指定的语言。

## 注意

- 单条译文请勿超过 2000 字符；单文件上限 2MB。
- 以 \`__proto__\` / \`constructor\` / \`prototype\` 为键的条目会被忽略。
- 译文里的 \`{name}\`、\`{count}\` 这类占位符请原样保留，它们会被实际值替换。
`

/** 是否已经确保过目录与说明文件存在（每个进程只做一次） */
let ensured = false

/**
 * 首次调用时创建 data/lang 并写入 README.md（已存在则不动，用户改过的说明不会被覆盖）。
 * 返回是否新建了目录，供启动横幅使用。
 */
export function ensureLangDir() {
  if (ensured) return false
  let created = false
  try {
    if (!fs.existsSync(LANG_DIR)) {
      fs.mkdirSync(LANG_DIR, { recursive: true })
      created = true
    }
    const readme = path.join(LANG_DIR, "README.md")
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, "utf8")
  } catch (err) {
    // 目录建不出来（data 只读、磁盘满）不该让服务起不来：退化成"只有内置语言"。
    // 注意这里**不置 ensured**：下次调用还会重试，避免一次瞬时故障让它永久失效。
    warn("i18n_dir_unavailable", { msg: `data/lang 不可用：${err.message}` })
    return false
  }
  ensured = true
  return created
}

/** code -> { mtimeMs, size, parsed } */
const cache = new Map()

function langFile(code) {
  return path.join(LANG_DIR, `${code}.json`)
}

function normalize(code, json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const meta = json._meta && typeof json._meta === "object" && !Array.isArray(json._meta) ? json._meta : {}
  const source =
    json.translations && typeof json.translations === "object" && !Array.isArray(json.translations)
      ? json.translations
      : json

  // 逐条挑进新对象：既是白名单，也顺手挡掉原型污染
  const translations = {}
  let keys = 0
  for (const [key, value] of Object.entries(source)) {
    if (key === "_meta" || key.startsWith("_")) continue
    if (UNSAFE_KEYS.has(key) || !KEY_RE.test(key)) continue
    if (typeof value !== "string") continue
    translations[key] = value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) : value
    keys += 1
    if (keys >= MAX_KEYS) break
  }

  const name =
    typeof meta.name === "string" && meta.name.trim() ? meta.name.trim().slice(0, 64) : code
  const base = typeof meta.base === "string" && CODE_RE.test(meta.base) ? meta.base : "zh"
  return { code, name, base, translations, keys }
}

function readLangFile(code) {
  if (!CODE_RE.test(code)) return null
  let stat
  try {
    stat = fs.statSync(langFile(code))
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null

  const hit = cache.get(code)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed

  let parsed = null
  try {
    parsed = normalize(code, JSON.parse(fs.readFileSync(langFile(code), "utf8")))
  } catch (err) {
    warn("i18n_bad_file", { msg: `data/lang/${code}.json 读取失败：${err.message}` })
  }
  cache.set(code, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
  return parsed
}

/**
 * 可用语言清单：内置语言在前，然后是 data/lang 里的语言（按文件名排序）。
 * 每次调用都会重新读目录，所以新丢进去的文件刷新页面就能用。
 */
export function availableLangs() {
  ensureLangDir()
  const out = BUILTIN_LANGS.map((l) => ({ ...l }))
  let files = []
  try {
    files = fs.readdirSync(LANG_DIR)
  } catch {
    return out
  }
  for (const file of files.sort()) {
    const lower = file.toLowerCase()
    if (!lower.endsWith(".json") || file.startsWith("_") || file.startsWith(".")) continue
    const code = file.slice(0, -".json".length)
    if (!CODE_RE.test(code)) continue
    if (out.some((l) => l.code === code)) continue // 内置语言优先，不允许被覆盖
    const parsed = readLangFile(code)
    if (!parsed) continue
    out.push({ code, name: parsed.name, builtin: false, keys: parsed.keys })
  }
  return out
}

/**
 * 取某个语言的译文。
 * @returns {{code:string, base:string, builtin:boolean, translations:object|null}|null}
 *   内置语言返回 `translations: null`（前端已经打包了它们的字典）。
 */
export function getLang(code) {
  const value = String(code || "")
  if (!CODE_RE.test(value)) return null
  if (BUILTIN_LANGS.some((l) => l.code === value)) {
    return { code: value, base: value, builtin: true, translations: null }
  }
  const parsed = readLangFile(value)
  if (!parsed) return null
  return { code: parsed.code, base: parsed.base, builtin: false, translations: parsed.translations }
}

/** 已启用的自定义语言代码（启动横幅用） */
export function customLangCodes() {
  return availableLangs()
    .filter((l) => !l.builtin)
    .map((l) => l.code)
}
