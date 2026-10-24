import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { initLucide } from "@/lib/lucide"
import { VERSION } from "@/version"

initLucide()

/**
 * 注册 Service Worker（v2.0，弱网 / 内网穿透优化）。
 *
 * 只在**生产构建**且**安全上下文**（HTTPS 或 localhost）下注册：
 *   - 开发模式注册会缓存住 HMR 的 chunk，改完代码看不到变化；
 *   - 局域网 `http://192.168.x.x:端口` 不是安全上下文，浏览器本来就不支持，
 *     这里先 feature-detect，避免控制台出现"注册失败"的噪音。
 *
 * 失败一律静默：SW 只是"第二次打开更快"，没有它功能完全正常。
 */
function registerServiceWorker() {
  if (!import.meta.env.PROD) return
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  if (!window.isSecureContext) return
  // 兼容模式页（robustness）是独立静态页，不该被 SPA 的 SW 接管
  if (window.location.pathname.startsWith("/robustness")) return
  void navigator.serviceWorker
    .register(`/sw.js?v=${encodeURIComponent(VERSION)}`, { scope: "/" })
    .catch(() => {
      /* 注册失败不影响使用：下次访问正常走网络 */
    })
}

registerServiceWorker()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
