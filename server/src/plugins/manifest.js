import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// ============================================================================
//  plugins/manifest.js - 插件清单（manifest.json）的校验与规范化
//
//  设计原则（与 docs 里的插件方案一致）：
//   1. **白名单**：`kind`、`permissions`、`apiVersion` 都只接受代码里列出的值，
//      未知值直接拒绝安装 —— 而不是"忽略未知字段继续装"。
//   2. **不做任意代码**：theme 插件只接受 CSS 变量令牌（声明式），
//      fileType / server 插件的运行时后续版本才接入，这里先做**结构校验**。
//   3. **值要能安全落进 CSS / JSON**：主题令牌的值禁止 `;{}@<>\\` 与 `url(`，
//      否则字符串插值就能改掉整条规则（甚至引出一个远程图片请求）。
//   4. 校验与规范化放在服务端：前端只负责展示，不参与"能不能装"的判断。
// ============================================================================

/** 当前宿主支持的插件 API 版本（只认这一个；以后要兼容 N-1 在这里加集合） */
export const SUPPORTED_API_VERSIONS = new Set([1])

/** 插件类型白名单 */
export const PLUGIN_KINDS = new Set(["theme", "fileType", "server"])

/** 权限白名单：能力名一旦定下就不要改名，改名等于破坏兼容性 */
export const PLUGIN_PERMISSIONS = new Set([
  "fs.read", // 读取当前用户可见的文件内容
  "fs.write", // 保存文件（仍受 fileWrite + editFiles 约束）
  "ui.toast", // 由宿主弹提示
  "settings.rw", // 读写插件自己的设置
])

/** 清单里允许出现的顶层字段（写死，防止插件夹带未知指令） */
const MANIFEST_KEYS = new Set([
  "id",
  "name",
  "version",
  "apiVersion",
  "kind",
  "description",
  "author",
  "homepage",
  "permissions",
  "theme",
  "settings",
  "entry",
  "extensions",
  "modes",
  "actions",
])

/** 主题令牌允许的 CSS 自定义属性名（只允许 -- 开头的短名） */
const TOKEN_NAME = /^--[a-zA-Z0-9-]{1,40}$/
/** 令牌值：禁止能"逃出"当前声明或引发外部请求的字符/函数 */
const TOKEN_VALUE_BAD = /[;{}@<>\\\n\r]|url\s*\(|expression\s*\(|javascript:/i
const TOKEN_VALUE_MAX = 200

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+){1,5}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const SETTING_KEY_RE = /^[a-zA-Z0-9_-]{1,32}$/

export class ManifestError extends Error {
  constructor(message, errorKey = "api.plugins.manifest_invalid") {
    super(message)
    this.status = 400
    this.errorKey = errorKey
  }
}

function asString(value, { max, field, required = false }) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) {
    if (required) throw new ManifestError(`manifest 缺少 ${field}`, "api.plugins.manifest_missing_field")
    return ""
  }
  if (text.length > max) throw new ManifestError(`${field} 过长（上限 ${max} 字符）`)
  return text
}

/** 校验一个主题令牌集合 */
function normalizeTokens(raw, which) {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(`theme.${which} 必须是对象`)
  }
  const out = {}
  let count = 0
  for (const [name, value] of Object.entries(raw)) {
    count += 1
    if (count > 80) throw new ManifestError(`theme.${which} 的令牌过多（上限 80 个）`)
    if (!TOKEN_NAME.test(name)) throw new ManifestError(`非法的令牌名：${name}`)
    const text = String(value ?? "").trim()
    if (!text) continue
    if (text.length > TOKEN_VALUE_MAX) throw new ManifestError(`令牌 ${name} 的值过长`)
    if (TOKEN_VALUE_BAD.test(text)) throw new ManifestError(`令牌 ${name} 的值包含不允许的字符或函数`)
    out[name] = text
  }
  return out
}

/**
 * 校验 JSON Schema（**只支持子集**）。
 *
 * 目的是让后台能"自动渲染设置表单"，而不是实现一个 JSON Schema 引擎：
 * 只接受 object + 扁平的 properties，每个属性类型限于
 * string / number / integer / boolean / enum(string)，并且可以带 title / description /
 * default / minimum / maximum / maxLength / placeholder。
 */
function normalizeSettingsSchema(raw) {
  if (raw === undefined) return null
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("settings 必须是 JSON Schema 对象")
  }
  if (raw.type !== "object") throw new ManifestError("settings.type 必须是 object")
  if (raw.additionalProperties !== undefined && raw.additionalProperties !== false) {
    throw new ManifestError("settings.additionalProperties 只接受 false")
  }
  const props = raw.properties ?? {}
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new ManifestError("settings.properties 必须是对象")
  }
  const keys = Object.keys(props)
  if (keys.length > 20) throw new ManifestError("settings 的属性过多（上限 20 个）")
  const out = {}
  for (const key of keys) {
    if (!SETTING_KEY_RE.test(key)) throw new ManifestError(`非法的设置项名：${key}`)
    const p = props[key]
    if (!p || typeof p !== "object") throw new ManifestError(`设置项 ${key} 必须是对象`)
    const type = String(p.type || "")
    if (!["string", "number", "integer", "boolean"].includes(type)) {
      throw new ManifestError(`设置项 ${key} 的 type 不支持：${type || "(空)"}`)
    }
    const spec = { type }
    if (typeof p.title === "string") spec.title = p.title.slice(0, 60)
    if (typeof p.description === "string") spec.description = p.description.slice(0, 200)
    if (typeof p.placeholder === "string") spec.placeholder = p.placeholder.slice(0, 60)
    // `public: true` = 这一项允许下发给**浏览器**（进而被任何能预览该文件的人看到，
    // 包括未登录访客）。默认 false：插件设置最常见的用途就是放 API key / webhook
    // 地址，而 /api/plugins/list 是匿名可访问的，默认全量下发等于公开密钥。
    // 见 store.js 的 publicSettings()。
    if (p.public === true) spec.public = true
    if (type === "boolean") {
      spec.default = p.default === true
    } else if (type === "string") {
      if (Array.isArray(p.enum)) {
        const values = p.enum.filter((v) => typeof v === "string").slice(0, 30)
        if (!values.length) throw new ManifestError(`设置项 ${key} 的 enum 为空`)
        spec.enum = values
      }
      if (typeof p.default === "string" && p.default.length <= 200) spec.default = p.default
      if (Number.isInteger(p.maxLength) && p.maxLength > 0 && p.maxLength <= 4000) spec.maxLength = p.maxLength
    } else {
      const min = Number.isFinite(p.minimum) ? Number(p.minimum) : undefined
      const max = Number.isFinite(p.maximum) ? Number(p.maximum) : undefined
      if (min !== undefined) spec.minimum = min
      if (max !== undefined) spec.maximum = max
      if (Number.isFinite(p.default)) spec.default = Number(p.default)
    }
    out[key] = spec
  }
  return { type: "object", additionalProperties: false, properties: out }
}

/** 校验主题配置 */
function normalizeTheme(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("theme 插件必须提供 theme 对象")
  }
  const light = normalizeTokens(raw.light, "light")
  const dark = normalizeTokens(raw.dark, "dark")
  if (!Object.keys(light).length && !Object.keys(dark).length) {
    throw new ManifestError("theme.light / theme.dark 至少要有一些令牌")
  }
  const out = { light, dark }
  if (typeof raw.fontSans === "string" && raw.fontSans.length <= 120 && !TOKEN_VALUE_BAD.test(raw.fontSans)) {
    out.fontSans = raw.fontSans
  }
  if (typeof raw.noise === "boolean") out.noise = raw.noise
  return out
}

/**
 * 校验并规范化 manifest。
 *
 * @returns 规范化后的清单（字段齐全、已裁剪长度、已丢弃未知字段）
 */
export function normalizeManifest(raw, { packageSha256 = "" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("manifest.json 必须是对象")
  }
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.has(key)) throw new ManifestError(`manifest 含未知字段：${key}`)
  }

  const id = asString(raw.id, { max: 64, field: "id", required: true })
  if (!ID_RE.test(id)) throw new ManifestError("id 必须形如 org.example.my-plugin（小写字母/数字/点/连字符）")

  const name = asString(raw.name, { max: 40, field: "name", required: true })
  const version = asString(raw.version, { max: 32, field: "version", required: true })
  if (!VERSION_RE.test(version)) throw new ManifestError("version 必须是 x.y.z 形式")

  const apiVersion = Number(raw.apiVersion)
  if (!Number.isInteger(apiVersion) || !SUPPORTED_API_VERSIONS.has(apiVersion)) {
    throw new ManifestError(
      `apiVersion 不受支持（当前宿主支持：${[...SUPPORTED_API_VERSIONS].join(", ")}）`,
      "api.plugins.api_version_unsupported"
    )
  }

  const kind = asString(raw.kind, { max: 20, field: "kind", required: true })
  if (!PLUGIN_KINDS.has(kind)) {
    throw new ManifestError(`kind 只能是 ${[...PLUGIN_KINDS].join(" / ")}`)
  }

  const permissions = Array.isArray(raw.permissions) ? raw.permissions : []
  if (permissions.length > PLUGIN_PERMISSIONS.size) throw new ManifestError("permissions 过多")
  for (const perm of permissions) {
    if (typeof perm !== "string" || !PLUGIN_PERMISSIONS.has(perm)) {
      throw new ManifestError(`未知权限：${String(perm)}`, "api.plugins.permission_unknown")
    }
  }
  // 主题插件只改样式，不该申请任何文件/网络能力
  if (kind === "theme" && permissions.length) {
    throw new ManifestError("theme 插件不应申请任何权限", "api.plugins.theme_permissions_denied")
  }

  const manifest = {
    id,
    name,
    version,
    apiVersion,
    kind,
    description: asString(raw.description, { max: 300, field: "description" }),
    author: asString(raw.author, { max: 60, field: "author" }),
    homepage: asString(raw.homepage, { max: 200, field: "homepage" }),
    permissions: [...new Set(permissions)],
    settings: normalizeSettingsSchema(raw.settings),
    packageSha256,
  }
  if (kind === "theme") {
    manifest.theme = normalizeTheme(raw.theme)
  } else if (kind === "fileType") {
    // fileType 插件是**自包含的单个 HTML**：它的 JS/CSS 必须内联。
    // 这样 iframe 里的文档不需要再发任何子请求（响应 CSP 里 connect-src 'none'），
    // 也就没有"插件偷偷请求外网"的窗口。要读写文件只能走 postMessage 让宿主代执行。
    manifest.entry = asString(raw.entry, { max: 120, field: "entry", required: true })
    if (!/^[A-Za-z0-9._/-]+\.html$/.test(manifest.entry) || manifest.entry.includes("..")) {
      throw new ManifestError("fileType 插件的 entry 必须是包内的 .html（自包含单文件）", "api.plugins.entry_invalid")
    }
    manifest.extensions = Array.isArray(raw.extensions)
      ? raw.extensions.filter((e) => typeof e === "string" && /^[A-Za-z0-9]{1,12}$/.test(e)).map((e) => e.toLowerCase())
      : []
    if (!manifest.extensions.length) {
      throw new ManifestError("fileType 插件必须声明 extensions（它负责哪些后缀）", "api.plugins.extensions_missing")
    }
    manifest.modes = Array.isArray(raw.modes) ? raw.modes.filter((m) => m === "preview" || m === "edit") : ["preview"]
    if (!manifest.modes.length) manifest.modes = ["preview"]
  } else {
    // server：**独立子进程**，只通过声明的 actions 被调用（协议见 plugins/runner.js）
    manifest.entry = asString(raw.entry, { max: 120, field: "entry", required: true })
    if (!/^[A-Za-z0-9._/-]+\.(js|mjs)$/.test(manifest.entry) || manifest.entry.includes("..")) {
      throw new ManifestError("server 插件的 entry 必须是包内的 .js / .mjs，且不能包含 ..")
    }
    const actions = Array.isArray(raw.actions) ? raw.actions : []
    if (!actions.length) {
      throw new ManifestError("server 插件必须声明 actions（它愿意被调用哪些动作）", "api.plugins.actions_missing")
    }
    if (actions.length > 20) throw new ManifestError("actions 过多（上限 20 个）")
    for (const action of actions) {
      if (typeof action !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(action)) {
        throw new ManifestError(`非法的 action 名：${String(action)}（小写字母开头，可含数字/下划线/连字符）`)
      }
    }
    manifest.actions = [...new Set(actions)]
    manifest.extensions = []
    manifest.modes = []
  }

  return manifest
}

/** 计算插件包目录的 sha256（按"相对路径 + 内容"排序后哈希，与解压顺序无关） */
export function hashDirectory(dir) {
  const hash = crypto.createHash("sha256")
  const walk = (current, prefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(abs, rel)
      } else if (entry.isFile()) {
        hash.update(rel)
        hash.update("\u0000")
        hash.update(fs.readFileSync(abs))
        hash.update("\u0000")
      }
    }
  }
  walk(dir, "")
  return hash.digest("hex")
}

/** 把主题令牌拼成一段**作用域受限**的 CSS（值已在上面校验过） */
export function themeCss(manifest) {
  if (!manifest?.theme) return ""
  const id = manifest.id.replace(/[^a-z0-9.-]/gi, "")
  const selector = `html[data-theme-plugin="${id}"]`
  const block = (tokens, extra = "") => {
    const body = Object.entries(tokens)
      .map(([k, v]) => `${k}:${v}`)
      .join(";")
    return body || extra ? `${selector}${extra}{${body}${extra ? `;${extra}` : ""}}` : ""
  }
  const parts = [
    block(manifest.theme.light, ""),
    block(manifest.theme.dark, ".dark"),
  ].filter(Boolean)
  if (manifest.theme.fontSans) {
    parts.push(`${selector} body{font-family:${manifest.theme.fontSans}}`)
  }
  return parts.join("\n")
}
