/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { BUILTIN, BUILTIN_META, FALLBACK_LANG, isBuiltinLang, type Dict, type LangMeta } from "@/locales"
import { VERSION } from "@/version"

/**
 * lib/i18n.tsx —— 界面语言
 *
 * 三条设计约束（决定了下面这些实现细节）：
 *
 * 1. **翻译函数必须能在 React 之外调用**：`lib/api.ts` 要把服务端返回的
 *    `errorKey` 翻成对话框里的文字，`lib/format.ts` 要在工具函数里产出标签。
 *    所以语言状态放在模块级单例里（`activeLang`），React 只负责"语言变了就重渲染"。
 * 2. **中文是兜底**：任何键在当前语言里缺失都依次回落到内置 zh，再回落到键名本身。
 *    这样即使某个 data/lang 文件只翻译了一半，界面也不会出现空白或报错。
 * 3. **切换语言不能整页刷新**：内置语言同步可用；扩展语言首次选中时拉一次
 *    `/api/i18n/<code>` 并缓存，之后就只切换状态。
 */

export const LANG_STORAGE_KEY = "zs-lang"
export { FALLBACK_LANG }

export function readStoredLang(): string | null {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredLang(code: string) {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, code)
  } catch {
    /* 存储不可用时只保留内存状态 */
  }
}

/** 非内置语言的完整字典（= 它声明的 base 语言 + 该语言自己的译文） */
const runtimeDicts = new Map<string, Dict>()
let activeLang: string = readStoredLang() || FALLBACK_LANG

function dictFor(lang: string): Dict | undefined {
  return runtimeDicts.get(lang) ?? BUILTIN[lang]
}

/** 插值：`{n}` / `{name}` 会被替换；未提供的占位符原样保留，方便定位漏传的参数 */
function interpolate(text: string, vars?: Record<string, string | number>) {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole
  )
}

export type TVars = Record<string, string | number>

/** 查一条文案：当前语言 → 内置中文 → undefined */
function lookup(lang: string, key: string): string | undefined {
  return dictFor(lang)?.[key] ?? BUILTIN[FALLBACK_LANG]?.[key]
}

/**
 * 翻译一个键。可在任意模块（含非 React 代码）中直接调用，用的是"当前语言"这个单例状态。
 * 组件里请用 useT()，否则切换语言时不会重新渲染。
 */
export function translate(key: string, vars?: TVars): string {
  return interpolate(lookup(activeLang, key) ?? key, vars)
}

/**
 * 按**指定语言**翻译。useT() 走的就是这条路径：把语言作为显式参数传进来，
 * 于是 t 的引用严格随 lang 变化（`useCallback(..., [lang])` 名副其实），
 * 用到它的组件必然重新渲染 —— 这正是"切语言立刻生效"的实现。
 */
export function translateFor(lang: string, key: string, vars?: TVars): string {
  return interpolate(lookup(lang, key) ?? key, vars)
}

export function currentLang(): string {
  return activeLang
}

/** 供脚本/调试：当前语言下哪些键还没有译文（会回落到中文） */
export function missingKeys(lang: string): string[] {
  const dict = dictFor(lang) ?? {}
  return Object.keys(BUILTIN[FALLBACK_LANG] ?? {}).filter((key) => !(key in dict))
}

interface I18nValue {
  lang: string
  langs: LangMeta[]
  /** 站点默认语言（服务端 config.defaultLang） */
  defaultLang: string
  /** 正在拉取某个扩展语言的字典 */
  loading: boolean
  t: (key: string, vars?: TVars) => string
  setLang: (code: string) => void
}

const Ctx = React.createContext<I18nValue | undefined>(undefined)

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * 语言包静态资源的 URL（带版本号）。
 *
 * 这些 JSON 由构建产出、可被浏览器缓存；但每次发版都会新增键，
 * 不带版本号时老访客会一直用缓存里的旧字典，新文案全部回落成中文。
 * 加 `?v=<版本>` 让"同一版本内吃缓存、换版本立刻换新"。
 */
function localeAssetUrl(code: string) {
  return `/resources/locales/${encodeURIComponent(code)}.json?v=${encodeURIComponent(VERSION)}`
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      credentials: "same-origin",
      // 与 lib/api.ts 一致：csrfGuard 要求这个头，且它不能带 Cookie 之外的凭据
      headers: { "X-Requested-With": "XMLHttpRequest" },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * 取一个非兜底语言的字典并缓存。
 *
 * 两条来源（顺序即优先级）：
 *   1. `/resources/locales/<code>.json` —— **内置语言**（含 en）：构建时由
 *      vite.config.ts 的 localeAssets 插件把该语言的各 area 文件合并输出成一份静态
 *      JSON。放在静态资源里而不是打进 JS，是为了让主包只背"兜底语言"，
 *      英文用户多一个请求（会被浏览器缓存），中文用户零额外请求。
 *   2. `/api/i18n/<code>` —— `data/lang/` 里的扩展语言：拿它声明的 base 语言字典
 *      再叠上它自己的译文。
 * 两条都失败时什么都不做：translate() 会继续用中文兜底，界面仍然可读。
 *
 * **URL 上必须带版本号**：这些 JSON 的缓存是 `max-age` 一天的静态资源，而语言包
 * 每次发版都会新增键。不带 `?v=` 的话，老访客会一直用缓存里的旧字典 ——
 * 新加的文案全部回落成中文，表现就是"选了自己语言但很多地方没翻译"。
 */
async function loadRuntimeDict(code: string): Promise<void> {
  if (code === FALLBACK_LANG || runtimeDicts.has(code)) return

  const staticDict = await fetchJson<Dict>(localeAssetUrl(code))
  if (staticDict && typeof staticDict === "object") {
    runtimeDicts.set(code, staticDict)
    return
  }

  interface Payload {
    base?: string
    translations?: Dict
  }
  const data = await fetchJson<Payload>(`/api/i18n/${encodeURIComponent(code)}`)
  if (!data) return
  const baseCode = data.base && isBuiltinLang(data.base) ? data.base : FALLBACK_LANG
  const baseDict =
    BUILTIN[baseCode] ??
    (await fetchJson<Dict>(localeAssetUrl(baseCode))) ??
    {}
  runtimeDicts.set(code, { ...baseDict, ...(data.translations ?? {}) })
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState(activeLang)
  const [langs, setLangs] = React.useState<LangMeta[]>(BUILTIN_META)
  const [defaultLang, setDefaultLang] = React.useState<string>(FALLBACK_LANG)
  const [loading, setLoading] = React.useState(false)

  const apply = React.useCallback(async (code: string) => {
    // 注意这里**不能**加 `code !== activeLang` 的判断：首次加载时 activeLang 可能
    // 已经等于 localStorage 里存的语言（比如 en），但它的字典还没取回来 ——
    // 那样就会跳过加载，界面永远停在中文。
    if (!BUILTIN[code] && !runtimeDicts.has(code) && LANG_RE.test(code)) {
      setLoading(true)
      await loadRuntimeDict(code)
      setLoading(false)
    }
    activeLang = code
    // 让 <html lang> 跟上：影响朗读、断词与 :lang() 选择器
    document.documentElement.lang = code
    setLangState(code)
  }, [])

  React.useEffect(() => {
    let alive = true
    void (async () => {
      interface Listing {
        langs?: LangMeta[]
        default?: string
      }
      const data = await fetchJson<Listing>("/api/i18n")
      if (!alive) return
      const list = data?.langs?.length ? data.langs : BUILTIN_META
      const siteDefault = data?.default && list.some((l) => l.code === data.default)
        ? String(data.default)
        : FALLBACK_LANG
      setLangs(list)
      setDefaultLang(siteDefault)

      const stored = readStoredLang()
      let next = stored && list.some((l) => l.code === stored) ? stored : siteDefault
      // 用户没选过时跟随浏览器：zh-CN → zh、en-US → en
      if (!stored) {
        const nav = (navigator.language || "").toLowerCase()
        const hit = list.find(
          (l) => nav === l.code.toLowerCase() || nav.startsWith(`${l.code.toLowerCase()}-`)
        )
        if (hit) next = hit.code
      }
      await apply(next)
    })()
    return () => {
      alive = false
    }
  }, [apply])

  const setLang = React.useCallback(
    (code: string) => {
      if (!LANG_RE.test(code)) return
      writeStoredLang(code)
      void apply(code)
    },
    [apply]
  )

  // 依赖 lang：translateFor 把语言当参数，所以这个 t 严格随语言变化，
  // 用到它的组件就会重新渲染（切语言立刻生效的关键）。
  const t = React.useCallback((key: string, vars?: TVars) => translateFor(lang, key, vars), [lang])

  const value = React.useMemo<I18nValue>(
    () => ({ lang, langs, defaultLang, loading, t, setLang }),
    [lang, langs, defaultLang, loading, t, setLang]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nValue {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useI18n must be used within I18nProvider")
  return ctx
}

/**
 * 组件里取翻译函数。返回的函数在语言变化时会换新引用，
 * 因此用到它的组件都会重新渲染 —— 这是"切换语言立刻生效"的关键。
 */
export function useT(): (key: string, vars?: TVars) => string {
  return useI18n().t
}
