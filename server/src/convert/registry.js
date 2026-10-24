/**
 * convert/registry.js —— 文件转换器的注册表（这就是"可扩展接口"）。
 *
 * 加一种新转换只需要两步：
 *   1. 在 `server/src/convert/` 下写一个模块，导出一个（或多个）转换器对象；
 *   2. 在 `server/src/convert/index.js` 里 `registerConverter(...)` 一次。
 * 前端不需要改：右键菜单里的「转换」子项是**按 `/api/fs/convert/targets` 的返回**
 * 动态渲染的，新转换器会自动出现（文案取 labelKey 对应的译文，没有译文就退回 label）。
 *
 * 转换器对象的字段（全部在 registerConverter 里校验，写错会直接抛错 —— 让错误在
 * 启动自检/单元测试阶段暴露，而不是等用户点了菜单才 500）：
 *
 *   id        唯一标识，会出现在接口里（`POST /api/fs/convert` 的 target 字段）
 *   from      源扩展名数组（小写、不带点）
 *   to        目标扩展名（小写、不带点）—— 决定生成的文件名
 *   label     兜底文案（中文），前端缺译文时显示它
 *   labelKey  可选的 i18n 键（如 ui.convert.md_pdf）
 *   input     "text" = 先按识别出的编码解码再传 text；"buffer" = 传原始字节
 *   maxBytes  源文件体积上限（超过直接 413，不进转换）
 *   run(ctx)  async，返回 { data: Buffer, notes?: string[] }
 *             ctx = { text?, buffer?, name, ext, encoding?, eol?, onProgress(percent), job }
 */

const EXT_RE = /^[a-z0-9][a-z0-9._-]*$/
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

const converters = new Map()

function normalizeExt(ext) {
  return String(ext || "").trim().toLowerCase().replace(/^\./, "")
}

/**
 * 注册一个转换器。
 * @param {object} def 见文件头的字段说明
 * @returns {object} 规范化后的转换器（一般不需要用返回值）
 */
export function registerConverter(def) {
  if (!def || typeof def !== "object") throw new Error("转换器定义必须是对象")
  const id = String(def.id || "").trim()
  if (!ID_RE.test(id)) throw new Error(`转换器 id 非法：${id}`)
  if (converters.has(id)) throw new Error(`转换器 id 重复：${id}`)

  const from = (Array.isArray(def.from) ? def.from : [def.from])
    .map(normalizeExt)
    .filter((ext) => EXT_RE.test(ext))
  const to = normalizeExt(def.to)
  if (!from.length) throw new Error(`转换器 ${id} 没有有效的源扩展名`)
  if (!EXT_RE.test(to)) throw new Error(`转换器 ${id} 的目标扩展名非法：${def.to}`)
  if (typeof def.run !== "function") throw new Error(`转换器 ${id} 缺少 run()`)
  const input = def.input === "text" ? "text" : "buffer"
  const maxBytes = Number(def.maxBytes)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`转换器 ${id} 必须声明正数的 maxBytes（源文件上限）`)
  }

  const normalized = {
    id,
    from,
    to,
    label: String(def.label || `${from[0].toUpperCase()} → ${to.toUpperCase()}`),
    labelKey: def.labelKey ? String(def.labelKey) : null,
    input,
    maxBytes,
    run: def.run,
  }
  converters.set(id, normalized)
  return normalized
}

/** 按 id 取转换器（不存在返回 undefined） */
export function getConverter(id) {
  return converters.get(String(id || ""))
}

/** 某个扩展名可用的全部转换器 */
export function convertersForExt(ext) {
  const target = normalizeExt(ext)
  return [...converters.values()].filter((c) => c.from.includes(target))
}

/** 全部转换器（接口下发 / 文档生成用） */
export function listConverters() {
  return [...converters.values()]
}

/**
 * 下发给前端的清单：**只暴露展示需要的字段**。
 * run / maxBytes 之类留在服务端 —— 前端不需要知道上限是多少，服务端自己会拦。
 */
export function publicConverterList() {
  return listConverters().map(({ id, from, to, label, labelKey }) => ({
    id,
    from,
    to,
    label,
    labelKey,
  }))
}

/** 测试用：清空注册表（避免多次 import 造成状态残留） */
export function clearConverters() {
  converters.clear()
}
