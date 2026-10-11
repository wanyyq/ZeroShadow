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
