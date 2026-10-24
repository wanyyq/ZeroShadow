/*
 * ZeroShadow Service Worker（v2.0）—— 弱网 / 内网穿透场景的静态资源缓存。
 *
 * 解决的问题：穿透链路（pinggy / serveo / Cloudflare Tunnel 等）RTT 高、丢包多，
 * 每次打开都要重新下 ~1.3 MB 的 JS/CSS。这里把**内容哈希命名**的构建产物缓存下来，
 * 第二次打开几乎不产生网络请求。
 *
 * 边界（有意为之）：
 *   - **只接管同源 GET**；`/api/*`、`/dav` 一律放过（接口与协议数据不能缓存）；
 *   - `/assets/*`（带内容哈希）→ cache-first：命中就直接返回，永远新鲜；
 *   - `/resources/*`（字体/图标库/语言包）→ stale-while-revalidate：先用缓存，后台更新；
 *   - **不接管页面导航**：`index.html` 带 no-cache 且引用哈希资源，缓存它会带来
 *     "旧 HTML 配新 chunk"的经典故障；弱网下真正费流量的是 assets，不是那几 KB 的 HTML；
 *   - Range 请求（视频拖动）直接放过，交给浏览器与服务端；
 *   - 缓存名带版本号：升级后 activate 时清掉旧版本缓存。
 *
 * 注意：Service Worker 只在**安全上下文**（HTTPS 或 localhost）可用。用
 * `http://192.168.x.x:端口` 打开局域网地址时浏览器不会注册它 —— 这是浏览器限制，
 * 不是这里的 bug；隧道自带 https，所以"穿透 + 弱网"场景正好被覆盖。
 */

const VERSION = "2.1.0"
const ASSET_CACHE = `zs-assets-${VERSION}`
const RESOURCE_CACHE = `zs-resources-${VERSION}`
const KEEP = new Set([ASSET_CACHE, RESOURCE_CACHE])

self.addEventListener("install", (event) => {
  // 不预缓存：首屏资源本来就随 HTML 一起到达，预缓存只会额外多占流量。
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (!KEEP.has(key)) await caches.delete(key)
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/dav")) return
  if (req.headers.get("range")) return
  if (req.mode === "navigate") return

  // 构建产物：内容哈希命名 → 缓存优先
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      })()
    )
    return
  }

  // 字体 / 图标库 / 语言包：先用缓存，后台更新
  if (url.pathname.startsWith("/resources/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RESOURCE_CACHE)
        const hit = await cache.match(req)
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => null)
        return hit || (await network) || Response.error()
      })()
    )
  }
})
