import fs from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

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
  plugins: [react(), tailwindcss()],
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
