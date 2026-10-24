import { api } from "@/lib/api"
import { ext } from "@/lib/format"

/**
 * lib/plugin-registry.ts —— 前端"插件运行时"注册表
 *
 * 只做一件事：告诉预览等页面「这个后缀该交给哪个插件渲染」。
 * 数据来自 `GET /api/plugins/list`（已启用的 `fileType` 插件，不含管理信息）。
 *
 * `permissions` 是插件清单里声明的**能力**（fs.read / fs.write / ui.toast /
 * settings.rw）。宿主在替插件执行 readText / saveText 之前必须先查它 ——
 * 插件自己跑在不透明源的 iframe 里，宿主是唯一能拦住越权读写的环节。
 *
 * 缓存策略：**进程内缓存一次**。插件启停需要管理员操作，且页面刷新后就会重新拉；
 * 为它加轮询/订阅不值得。失败也不缓存（下次进预览会重试）。
 */
export interface PluginRuntime {
  id: string
  name: string
  version: string
  kind: string
  extensions: string[]
  modes: string[]
  /** 能力声明：宿主据此决定允不允许代执行（空数组 = 不允许任何读写） */
  permissions: string[]
  settings: Record<string, unknown>
}

let cache: PluginRuntime[] | null = null
let inflight: Promise<PluginRuntime[]> | null = null

/** 拉取已启用的运行时插件（带缓存与去重） */
export function loadRuntimePlugins(): Promise<PluginRuntime[]> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = api
    .get<{ plugins: PluginRuntime[] }>("/plugins/list")
    .then((data) => {
      cache = Array.isArray(data.plugins) ? data.plugins : []
      return cache
    })
    .catch(() => {
      // 拿不到就当没有插件：预览页会退回"无法预览"的既有提示
      return [] as PluginRuntime[]
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 清掉缓存（设置页启停插件后调用，避免"刚启用却还要刷新两次"） */
export function invalidateRuntimePlugins() {
  cache = null
}

/**
 * 为某个文件找匹配的插件。
 *
 * 匹配规则：`extensions` 命中后缀，且 `modes` 包含所需模式（预览/编辑）。
 * 有多个插件声明同一后缀时，按名称排序取第一个 —— 保持行为可预测。
 */
export function matchPlugin(list: PluginRuntime[], name: string, mode: "preview" | "edit" = "preview"): PluginRuntime | null {
  const suffix = ext(name)
  if (!suffix) return null
  const candidates = list
    .filter((p) => p.extensions?.includes(suffix) && p.modes?.includes(mode))
    .sort((a, b) => a.name.localeCompare(b.name))
  return candidates[0] ?? null
}
