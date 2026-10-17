import fs from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/**
 * 把 src/locales/<语言>/*.json 合并后，在产物里额外出一份**未打包**的
 * `resources/locales/<语言>.json`。
 *
 * 为什么需要它：
 *   1. **主包体积**：中文（兜底语言）打进 JS，其余内置语言（含英文）只在这里输出，
 *      由 lib/i18n.tsx 在用户真的选了它时才取一次；
 *   2. **兼容模式页**：`web/public/robustness/` 是不参与构建的独立静态页，
 *      它取的就是这里的文件（它没有别的途径拿到字典）。
 * 开发模式下 `dist/` 不存在，所以 configureServer 里同样按需合并后直出。
 */
function localeAssets(): Plugin {
  /** 构建期派生的语言别名：键是要产出的语言代码，值是它的底本 */
  const LOCALE_ALIASES: Record<string, string> = { "zh-MO": "zh-HK" }
  /** 别名替换规则（只处理确有地区差异的词，其余原样保留） */
  const LOCALE_ALIAS_REPLACEMENTS: [string, string][] = [
    ["香港", "澳門"],
    ["港幣", "澳門幣"],
  ]

  const merge = (): Map<string, string> => {
    const out = new Map<string, string>()
    const root = path.resolve(__dirname, "src/locales")
    if (!fs.existsSync(root)) return out
    for (const lang of fs.readdirSync(root)) {
      const dir = path.join(root, lang)
      if (!fs.statSync(dir).isDirectory()) continue
      const dict: Record<string, string> = {}
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
        Object.assign(dict, JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")))
      }
      out.set(lang, `${JSON.stringify(dict, null, 2)}\n`)
    }
    // zh-MO（繁體中文 · 澳門）与 zh-HK 的差异只在极少数地区用词上。
    // 与其维护 1492 条几乎重复的译文（两套一旦漂移，反而比不做区分更糟），
    // 这里在构建时按固定替换规则**从 zh-HK 派生**——用户仍能在语言列表里
    // 明确选到「繁體中文（澳門）」，而仓库里只保留一份真正被维护的译文。
    for (const [alias, base] of Object.entries(LOCALE_ALIASES)) {
      if (out.has(alias)) continue
      const source = out.get(base)
      if (!source) continue
      let text = source
      for (const [from, to] of LOCALE_ALIAS_REPLACEMENTS) text = text.split(from).join(to)
      out.set(alias, text)
    }
    return out
  }

  return {
    name: "zs-locale-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const hit = /^\/resources\/locales\/([A-Za-z0-9-]+)\.json$/.exec(req.url ?? "")
        if (!hit) return next()
        const source = merge().get(hit[1])
        if (!source) return next()
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        res.end(source)
      })
    },
    generateBundle() {
      for (const [lang, source] of merge()) {
        this.emitFile({ type: "asset", fileName: `resources/locales/${lang}.json`, source })
      }
    },
  }
}

/**
 * 后端端口以仓库根目录的 .env 为准（server/src/env.js 也是从项目根读取的），
 * 这样 `pnpm start` / `pnpm dev:server` / 这里的代理三者永远指向同一个端口，
 * 不会出现「后端在 5170、Vite 把 /api 打到 12345」这种对不上的情况。
 */
function backendPort() {
  const fallback = 12345
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const idx = trimmed.indexOf("=")
      if (idx < 1) continue
      if (trimmed.slice(0, idx).trim() !== "PORT") continue
      const port = Number.parseInt(trimmed.slice(idx + 1).trim(), 10)
      if (Number.isFinite(port) && port >= 1 && port <= 65535) return port
    }
  } catch {
    /* 首次运行还没有 .env 时用默认端口 */
  }
  return fallback
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), localeAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // 首屏瘦身（v1.2.1）：把几乎不变的第三方运行时拆成独立 chunk，
    // 发版后老访客还能复用缓存里的 React，而不是重新下载整包。
    // 只拆两类，避免过度切分导致 chunk 间循环引用。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined
          // 注意：`@base-ui/react/...` 的路径里也含 "/react/"，所以必须先排除它，
          // 否则整个 base-ui 会被塞进 vendor-react（实测会把该 chunk 撑到 490KB）。
          if (id.includes("@base-ui") || id.includes("sonner") || id.includes("next-themes")) {
            return "vendor-ui"
          }
          if (/(?:^|[\\/])(?:react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react"
          }
          return undefined
        },
      },
    },
    // 单文件过大对弱网不友好：超过 400KB 的 chunk 在构建日志里直接告警
    chunkSizeWarningLimit: 400,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${backendPort()}`,
        changeOrigin: false,
      },
    },
  },
})
