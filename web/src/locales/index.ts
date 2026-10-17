/**
 * locales/index.ts —— 内置语言字典的装配点
 *
 * 目录约定：
 *   locales/zh/<area>.json   中文（源语言，**必须**包含每一个出现过的键）
 *   locales/en/<area>.json   英文
 * 每个文件是一段"扁平键 → 文案"的映射，键名形如 `ui.browser.toolbar.upload`。
 * 之所以按 area 拆文件：多人/多路并行维护时不会互相改同一个文件，
 * 合并交给这里的 import.meta.glob（构建期完成，运行期零成本）。
 *
 * **只有中文是打包进 JS 的**：
 *   - `zh` 是所有键的兜底来源，必须同步可用 —— 否则首屏会先显示一串 `ui.xxx.yyy`；
 *   - 其它内置语言（含英文）在构建时会额外输出成未打包的
 *     `dist/resources/locales/<语言>.json`（见 vite.config.ts 的 localeAssets），
 *     由 lib/i18n.tsx 在用户真的选了它时才取一次。这样主包不会为"可能用不到的语言"
 *     多背一百多 KB，而英文用户只会多一个请求（且被浏览器缓存）。
 */

export type Dict = Record<string, string>

export interface LangMeta {
  /** BCP-47 风格的语言代码，如 zh / en / ja / pt-BR */
  code: string
  /** 语言名（用该语言自己的写法，即"自称"，便于在语言选择器里一眼认出） */
  name: string
  /** 是否为内置语言（内置语言随前端一起发布，不需要 data/lang 文件） */
  builtin?: boolean
}

export const FALLBACK_LANG = "zh"

const zhModules = import.meta.glob<{ default: Dict }>("./zh/*.json", { eager: true })

function collect(modules: Record<string, { default: Dict }>): Dict {
  const out: Dict = {}
  for (const [file, mod] of Object.entries(modules)) {
    const entries = mod?.default ?? {}
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== "string") continue
      if (key in out && out[key] !== value) {
        // 同一键在两个 area 文件里给了不同文案：后者生效，但开发时应该看到告警
        console.warn(`[i18n] 键 ${key} 在 ${file} 里覆盖了已有文案`)
      }
      out[key] = value
    }
  }
  return out
}

/** 打包进 JS 的字典：只有兜底语言 */
export const BUILTIN: Record<string, Dict> = {
  [FALLBACK_LANG]: collect(zhModules),
}

/** 内置语言清单（服务端 /api/i18n 会在它之上追加 data/lang 里的语言） */
export const BUILTIN_META: LangMeta[] = [
  { code: "zh", name: "简体中文", builtin: true },
  { code: "zh-TW", name: "繁體中文（台灣）", builtin: true },
  { code: "zh-HK", name: "繁體中文（香港）", builtin: true },
  { code: "zh-MO", name: "繁體中文（澳門）", builtin: true },
  { code: "en", name: "English", builtin: true },
  { code: "ja", name: "日本語", builtin: true },
  { code: "es", name: "Español", builtin: true },
  { code: "fr", name: "Français", builtin: true },
]

export function isBuiltinLang(code: string): boolean {
  return BUILTIN_META.some((l) => l.code === code)
}

/** 供脚本/调试用：当前打包在 JS 里的全部键 */
export function builtinKeys(): string[] {
  return Object.keys(BUILTIN[FALLBACK_LANG] ?? {})
}
