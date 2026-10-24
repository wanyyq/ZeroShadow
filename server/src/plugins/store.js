import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import unzipper from "unzipper"
import { DATA_DIR, TMP_DIR } from "../env.js"
import { readJsonSync, withLock, writeJsonAtomic } from "../store.js"
import { httpError } from "../http.js"
import { info, warn } from "../logger.js"
import { hashDirectory, ManifestError, normalizeManifest } from "./manifest.js"
import { stopPlugin } from "./runner.js"

// ============================================================================
//  plugins/store.js - 插件的安装 / 启停 / 卸载 / 私有设置
//
//  数据布局：
//    data/plugins.json          → 每个插件的启用状态、安装时间、哈希、私有设置
//    data/plugins/<id>/         → 插件包内容（manifest.json 与静态资源）
//
//  安全要点：
//   - 插件目录与 trash / lang / thumbs 一样**不在网盘根目录内**，并已加入
//     safety.js 的敏感条目，不能被网盘接口列举或下载；
//   - 解压时逐条校验路径（拒绝 `..`、绝对路径、符号链接），并有**体积与条目上限**，
//     防止 zip 炸弹把磁盘写满；
//   - 只接受 `manifest.json` 在包根或单一顶层目录下的包（不做任意深度的搜索）。
// ============================================================================

export const PLUGIN_DIR = path.join(DATA_DIR, "plugins")
const STATE_FILE = path.join(DATA_DIR, "plugins.json")

/** 单个插件包（zip）上限 */
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024
/** 解压后总量上限 */
const MAX_UNPACKED_BYTES = 10 * 1024 * 1024
/** 解压条目上限 */
const MAX_ENTRIES = 300
/** 最多安装多少个插件 */
const MAX_PLUGINS = 20

let state = load()

function emptyState() {
  return { version: 1, plugins: {}, activeTheme: "" }
}

function load() {
  const raw = readJsonSync(STATE_FILE, emptyState())
  const out = emptyState()
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.plugins && typeof raw.plugins === "object") {
      for (const [id, entry] of Object.entries(raw.plugins)) {
        if (!entry || typeof entry !== "object") continue
        out.plugins[id] = {
          enabled: entry.enabled === true,
          installedAt: Number(entry.installedAt) || 0,
          sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
          settings: entry.settings && typeof entry.settings === "object" && !Array.isArray(entry.settings) ? entry.settings : {},
        }
      }
    }
    if (typeof raw.activeTheme === "string") out.activeTheme = raw.activeTheme
  }
  return out
}

export function reloadPlugins() {
  state = load()
  return state
}

async function persist(mutator) {
  return withLock("plugins", async () => {
    mutator(state)
    await writeJsonAtomic(STATE_FILE, state)
  })
}

/* ------------------------------------------------------------------ 读取 -- */

function manifestPath(id) {
  return path.join(PLUGIN_DIR, id, "manifest.json")
}

/** 读取磁盘上的清单（损坏/被手改时返回 null，并在列表里体现为 broken） */
function readManifest(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(id), "utf8").replace(/^\uFEFF/, ""))
    return normalizeManifest(raw, { packageSha256: state.plugins[id]?.sha256 || "" })
  } catch {
    return null
  }
}

/**
 * 列出所有已安装插件。
 *
 * `broken: true` 表示目录还在、但清单读不出来（被手改坏 / 升级不兼容）——
 * 这种情况仍然展示出来，让管理员可以卸载，而不是"凭空消失"。
 */
export function listPlugins() {
  let dirs = []
  try {
    dirs = fs.readdirSync(PLUGIN_DIR).filter((name) => {
      try {
        return fs.statSync(path.join(PLUGIN_DIR, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    dirs = []
  }
  const rows = []
  for (const id of dirs) {
    const st = state.plugins[id] || { enabled: false, installedAt: 0, sha256: "", settings: {} }
    const manifest = readManifest(id)
    rows.push({
      id,
      installed: true,
      enabled: st.enabled === true,
      installedAt: st.installedAt,
      sha256: st.sha256,
      broken: !manifest,
      manifest: manifest
        ? {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            kind: manifest.kind,
            description: manifest.description,
            author: manifest.author,
            homepage: manifest.homepage,
            permissions: manifest.permissions,
            settings: manifest.settings,
            // server 插件才有：它愿意被调用哪些动作（前端用来渲染"测试"按钮/文档）
            actions: manifest.actions || [],
          }
        : null,
      settings: st.settings,
      activeTheme: state.activeTheme === id,
    })
  }
  rows.sort((a, b) => b.installedAt - a.installedAt)
  return rows
}

/** 当前生效的主题插件（未启用 / 已删除时返回 null） */
export function activeThemeManifest() {
  const id = state.activeTheme
  if (!id || !state.plugins[id]?.enabled) return null
  const manifest = readManifest(id)
  if (!manifest || manifest.kind !== "theme") return null
  return manifest
}

/**
 * 已启用、并且带前端运行时的插件（给 `/api/plugins/list` 用）。
 *
 * 只暴露"渲染一个插件需要知道的信息"：id / name / kind / extensions / modes。
 * **不含** permissions、sha256、settings schema、主题令牌 —— 那些是管理员视角的数据。
 */
export function enabledRuntimePlugins() {
  const out = []
  for (const [id, st] of Object.entries(state.plugins)) {
    if (!st.enabled) continue
    const manifest = readManifest(id)
    if (!manifest) continue
    if (manifest.kind !== "fileType") continue
    out.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      extensions: manifest.extensions,
      modes: manifest.modes,
      // 插件自己的设置：由管理员在后台填，最终交给插件渲染时使用。
      // 它属于"插件配置"而不是"网盘机密"，且拼好后的内容本来就会展示给用户。
      settings: st.settings || {},
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 取某个插件的入口文件（只认 manifest 里声明的 entry，别的一律不给） */
export function pluginEntryFile(id) {
  const st = state.plugins[id]
  if (!st?.enabled) return null
  const manifest = readManifest(id)
  if (!manifest || !manifest.entry) return null
  const abs = resolvePluginAsset(id, manifest.entry)
  return abs ? { file: abs, manifest } : null
}

/** 插件私有设置（插件运行时通过 init 消息拿到，宿主不额外暴露接口） */
export function runtimeSettings(id) {
  return state.plugins[id]?.settings ?? {}
}

export function pluginSettings(id) {
  return state.plugins[id]?.settings ?? {}
}

/* ------------------------------------------------------------------ 安装 -- */

function safeRelPath(name) {
  const rel = String(name || "").replace(/\\/g, "/")
  if (!rel || rel.startsWith("/") || rel.includes("..")) return null
  if (path.isAbsolute(rel)) return null
  return rel.split("/").filter((s) => s && s !== ".").join("/")
}

/**
 * 从 zip 解压到目标目录（自带路径与体积校验）。
 *
 * 不用 `unzipper.Extract({ path })`：那个 API 对条目路径的校验交给调用方，
 * 一旦漏了就是 zip-slip。这里逐条自己写，拒绝目录穿越、符号链接与超限条目。
 */
async function extractZip(zipPath, destDir) {
  let total = 0
  let entries = 0
  const zip = await unzipper.Open.file(zipPath)
  for (const entry of zip.files) {
    entries += 1
    if (entries > MAX_ENTRIES) throw httpError(400, `插件包内文件过多（上限 ${MAX_ENTRIES} 个）`, { errorKey: "api.plugins.too_many_entries" })
    // 只接受普通文件与目录；符号链接会指向包外
    if (entry.type !== "File" && entry.type !== "Directory") continue
    const rel = safeRelPath(entry.path)
    if (!rel) throw httpError(400, `插件包含非法路径：${entry.path}`, { errorKey: "api.plugins.zip_slip" })
    const abs = path.join(destDir, ...rel.split("/"))
    if (entry.type === "Directory") {
      await fs.promises.mkdir(abs, { recursive: true })
      continue
    }
    if (entry.uncompressedSize > MAX_PACKAGE_BYTES) {
      throw httpError(400, `插件包内单个文件过大：${entry.path}`, { errorKey: "api.plugins.file_too_large" })
    }
    total += entry.uncompressedSize
    if (total > MAX_UNPACKED_BYTES) {
      throw httpError(400, `插件解压后过大（上限 ${Math.round(MAX_UNPACKED_BYTES / 1024 / 1024)} MB）`, {
        errorKey: "api.plugins.unpacked_too_large",
      })
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true })
    const buffer = await entry.buffer()
    // 再核一次实际字节数：uncompressedSize 是包内声明值，不可全信
    if (buffer.length > MAX_PACKAGE_BYTES) {
      throw httpError(400, `插件包内单个文件过大：${entry.path}`, { errorKey: "api.plugins.file_too_large" })
    }
    await fs.promises.writeFile(abs, buffer)
  }
}

/** 在解压目录里找 manifest.json（允许包根或单一顶层目录） */
function findManifest(dir) {
  const direct = path.join(dir, "manifest.json")
  if (fs.existsSync(direct)) return { file: direct, root: dir }
  const children = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const child of children) {
    const candidate = path.join(dir, child.name, "manifest.json")
    if (fs.existsSync(candidate)) return { file: candidate, root: path.join(dir, child.name) }
  }
  return null
}

/**
 * 安装一个插件包。
 *
 * 流程：落临时文件 → 解压到临时目录 → 找 manifest → 严格校验 → 查重 →
 * （通过后）整目录 rename 到 `data/plugins/<id>` → 记录状态（**默认禁用**）。
 * 任何一步失败都会清掉临时目录，不会留下半个插件。
 */
export async function installPlugin(buffer, { filename = "plugin.zip" } = {}) {
  if (!buffer || !buffer.length) throw httpError(400, "没有收到插件包", { errorKey: "api.plugins.empty_package" })
  if (buffer.length > MAX_PACKAGE_BYTES) {
    throw httpError(400, `插件包过大（上限 ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB）`, {
      errorKey: "api.plugins.package_too_large",
    })
  }
  if (!/\.zip$/i.test(filename)) {
    throw httpError(400, "插件包必须是 .zip", { errorKey: "api.plugins.not_zip" })
  }
  if (Object.keys(state.plugins).length >= MAX_PLUGINS) {
    throw httpError(400, `插件数量已达上限（${MAX_PLUGINS}）`, { errorKey: "api.plugins.too_many_plugins" })
  }

  await fs.promises.mkdir(PLUGIN_DIR, { recursive: true })
  await fs.promises.mkdir(TMP_DIR, { recursive: true })
  const work = await fs.promises.mkdtemp(path.join(TMP_DIR, "plugin-"))
  const zipPath = path.join(work, "package.zip")
  try {
    await fs.promises.writeFile(zipPath, buffer)
    const unpacked = path.join(work, "unpacked")
    await fs.promises.mkdir(unpacked, { recursive: true })
    await extractZip(zipPath, unpacked)

    const found = findManifest(unpacked)
    if (!found) throw httpError(400, "插件包里没有 manifest.json", { errorKey: "api.plugins.manifest_missing" })

    let raw
    try {
      raw = JSON.parse(fs.readFileSync(found.file, "utf8").replace(/^\uFEFF/, ""))
    } catch {
      throw new ManifestError("manifest.json 不是合法 JSON", "api.plugins.manifest_json")
    }
    let manifest
    try {
      manifest = normalizeManifest(raw)
    } catch (err) {
      if (err instanceof ManifestError) {
        throw httpError(err.status || 400, err.message, { errorKey: err.errorKey })
      }
      throw err
    }

    if (state.plugins[manifest.id] || fs.existsSync(path.join(PLUGIN_DIR, manifest.id))) {
      throw httpError(409, `插件 ${manifest.id} 已安装，请先卸载再安装`, { errorKey: "api.plugins.already_installed" })
    }

    // rename 是原子的：要么整目录出现，要么什么都没有
    const target = path.join(PLUGIN_DIR, manifest.id)
    await fs.promises.rename(found.root, target)
    const sha256 = hashDirectory(target)
    await persist((draft) => {
      draft.plugins[manifest.id] = { enabled: false, installedAt: Date.now(), sha256, settings: {} }
    })
    info("plugin_install", { msg: `${manifest.id}@${manifest.version} (${manifest.kind})` })
    return { ...manifest, sha256, enabled: false }
  } catch (err) {
    if (err instanceof ManifestError) {
      throw httpError(400, err.message, { errorKey: err.errorKey })
    }
    throw err
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ 状态 -- */

/** 启用 / 禁用。启用时重新读一次清单，避免"装完被手改坏"仍然能启用。 */
export async function setPluginEnabled(id, enabled) {
  if (!state.plugins[id]) throw httpError(404, "插件不存在", { errorKey: "api.plugins.not_found" })
  if (enabled) {
    const manifest = readManifest(id)
    if (!manifest) throw httpError(400, "插件清单已损坏，无法启用", { errorKey: "api.plugins.manifest_broken" })
  }
  await persist((draft) => {
    draft.plugins[id].enabled = !!enabled
    // 关掉主题插件时同时把"当前主题"清掉，否则主题会继续生效却显示为未启用
    if (!enabled && draft.activeTheme === id) draft.activeTheme = ""
  })
  // server 插件：禁用后立刻回收子进程，不让它在后台继续跑
  if (!enabled) stopPlugin(id, "插件被禁用")
  info("plugin_toggle", { msg: `${id} -> ${enabled ? "enabled" : "disabled"}` })
  return listPlugins().find((p) => p.id === id) || null
}

/** 选一个主题插件生效（传空字符串表示恢复默认主题） */
export async function setActiveTheme(id) {
  if (!id) {
    await persist((draft) => {
      draft.activeTheme = ""
    })
    return null
  }
  const entry = state.plugins[id]
  if (!entry) throw httpError(404, "插件不存在", { errorKey: "api.plugins.not_found" })
  if (!entry.enabled) throw httpError(400, "请先启用插件再应用主题", { errorKey: "api.plugins.not_enabled" })
  const manifest = readManifest(id)
  if (!manifest || manifest.kind !== "theme") {
    throw httpError(400, "该插件不是主题插件", { errorKey: "api.plugins.not_theme" })
  }
  await persist((draft) => {
    draft.activeTheme = id
  })
  return manifest
}

export async function uninstallPlugin(id) {
  if (!state.plugins[id]) throw httpError(404, "插件不存在", { errorKey: "api.plugins.not_found" })
  // 先停进程再删目录：Windows 上目录被占用是删不掉的
  stopPlugin(id, "插件被卸载")
  await persist((draft) => {
    delete draft.plugins[id]
    if (draft.activeTheme === id) draft.activeTheme = ""
  })
  await fs.promises.rm(path.join(PLUGIN_DIR, id), { recursive: true, force: true }).catch((err) => {
    warn("plugin_uninstall_rm", { msg: `${id}: ${err?.message || err}` })
  })
  info("plugin_uninstall", { msg: id })
}

/* ------------------------------------------------------------------ 设置 -- */

/** 按 schema 校验并保存插件私有设置（只保留 schema 里声明的键） */
export async function savePluginSettings(id, values) {
  const manifest = readManifest(id)
  if (!manifest) throw httpError(400, "插件清单已损坏", { errorKey: "api.plugins.manifest_broken" })
  const schema = manifest.settings
  const input = values && typeof values === "object" && !Array.isArray(values) ? values : {}
  const out = {}
  if (schema) {
    for (const [key, spec] of Object.entries(schema.properties)) {
      const value = input[key]
      if (value === undefined) continue
      if (spec.type === "boolean") {
        out[key] = value === true
      } else if (spec.type === "string") {
        const text = String(value ?? "")
        if (spec.enum) {
          if (!spec.enum.includes(text)) {
            throw httpError(400, `${key} 不是允许的取值`, { errorKey: "api.plugins.setting_invalid" })
          }
        } else if (spec.maxLength && text.length > spec.maxLength) {
          throw httpError(400, `${key} 过长（上限 ${spec.maxLength} 字符）`, { errorKey: "api.plugins.setting_invalid" })
        }
        out[key] = spec.enum ? text : text.slice(0, spec.maxLength || 200)
      } else {
        const num = Number(value)
        if (!Number.isFinite(num)) throw httpError(400, `${key} 必须是数字`, { errorKey: "api.plugins.setting_invalid" })
        if (spec.type === "integer" && !Number.isInteger(num)) {
          throw httpError(400, `${key} 必须是整数`, { errorKey: "api.plugins.setting_invalid" })
        }
        if (spec.minimum !== undefined && num < spec.minimum) {
          throw httpError(400, `${key} 不能小于 ${spec.minimum}`, { errorKey: "api.plugins.setting_invalid" })
        }
        if (spec.maximum !== undefined && num > spec.maximum) {
          throw httpError(400, `${key} 不能大于 ${spec.maximum}`, { errorKey: "api.plugins.setting_invalid" })
        }
        out[key] = num
      }
    }
  }
  await persist((draft) => {
    draft.plugins[id].settings = out
  })
  return out
}

/* ------------------------------------------------ 静态资源（后续插件用） -- */

/** 解析插件包内的一个文件（拒绝穿越；调用方负责权限与 CSP） */
export function resolvePluginAsset(id, rel) {
  if (!state.plugins[id]) return null
  const safe = safeRelPath(rel)
  if (!safe) return null
  const base = path.join(PLUGIN_DIR, id)
  const abs = path.join(base, ...safe.split("/"))
  const normalized = path.resolve(abs)
  if (!normalized.startsWith(path.resolve(base) + path.sep)) return null
  try {
    const stat = fs.statSync(normalized)
    return stat.isFile() ? normalized : null
  } catch {
    return null
  }
}

/** 供状态页展示的摘要 */
export function pluginsSummary() {
  const rows = listPlugins()
  return {
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    activeTheme: state.activeTheme || "",
    max: MAX_PLUGINS,
  }
}

/** 测试用：临时目录（供单元测试解压） */
export function pluginTempRoot() {
  return path.join(os.tmpdir(), "zeroshadow-plugins")
}
