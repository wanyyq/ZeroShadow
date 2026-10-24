import * as React from "react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { downloadUrl, fetchFileText, saveFileText } from "@/lib/api"
import type { FileTextResponse } from "@/lib/types"
import type { PluginRuntime } from "@/lib/plugin-registry"

/**
 * components/plugins/plugin-frame.tsx —— `fileType` 插件的前端沙箱宿主
 *
 * 设计底线（改之前先读）：
 *   1. iframe 用 `sandbox="allow-scripts"`，**没有** `allow-same-origin` —— 文档变成
 *      不透明源：拿不到本站 Cookie、读不到父页面 DOM、`fetch('/api/...')` 会被 CORS 拦下；
 *   2. 服务端给入口 HTML 的 CSP 是 `default-src 'none'` + `connect-src 'none'`，
 *      插件是**自包含单文件**，连子资源都发不出去；
 *   3. 所以插件要读写文件，只能 `postMessage` 回来，由**宿主**用自己的会话代执行 ——
 *      宿主再走既有接口，服务端 `req.perms` 才是最终裁判；
 *   4. 代执行之前，宿主还必须检查插件清单声明的 `permissions`
 *      （`fs.read` / `fs.write` / `ui.toast`）：不声明就不代做。插件是第三方内容，
 *      声明即边界；不查这一项，清单里的能力声明就只是装饰（安全复检 M-3）。
 *
 * 消息协议（v1，`apiVersion: 1`）：
 *   plugin → host  { type: "zs:ready" }
 *   host → plugin  { type: "zs:init", apiVersion, file, settings, canWrite, dark }
 *   plugin → host  { type: "zs:request", id, method, params }
 *                  method ∈ readText | readBinary | saveText | notify
 *   host → plugin  { type: "zs:response", id, ok, result?, error? }
 *   plugin → host  { type: "zs:dirty", dirty: boolean }
 *
 * 身份校验只认 `event.source === iframe.contentWindow`：不透明源下 `event.origin`
 * 恒为字符串 `"null"`，拿它做同源判断等于没判断。
 */

export interface PluginFrameProps {
  plugin: PluginRuntime
  path: string
  name: string
  size: number
  mtime: number
  canWrite: boolean
  onDirtyChange?: (dirty: boolean) => void
}

interface FrameRequest {
  type: "zs:request"
  id: number
  method: string
  params?: Record<string, unknown>
}

interface Outcome {
  ok: boolean
  result?: unknown
  error?: string
  /** 需要转移所有权的 ArrayBuffer（readBinary） */
  transfer?: Transferable[]
}

/** 二进制读取上限：插件不该把几百 MB 的内容读进内存 */
const MAX_BINARY_BYTES = 16 * 1024 * 1024

export function PluginFrame({ plugin, path, name, size, mtime, canWrite, onDirtyChange }: PluginFrameProps) {
  const t = useT()
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = React.useState<"loading" | "ready" | "failed">("loading")
  const [dirty, setDirty] = React.useState(false)
  /** 记住最近一次读到的编码/换行/版本：保存时默认沿用，避免插件把 CRLF 写成 LF */
  const lastText = React.useRef<FileTextResponse | null>(null)
  /** 插件入口文档的 load 次数：第 1 次是插件本身，之后再出现就意味着"被导航走了" */
  const loadCount = React.useRef(0)
  /** 判定为被劫持后彻底断链：不再处理任何消息，也不再回包 */
  const hijacked = React.useRef(false)
  const entrySrc = `/api/plugins/entry/${encodeURIComponent(plugin.id)}`
  /** 已计入的入口地址：换了插件要重新开始计数（否则新插件的第 1 次 load 会被当成"第 2 次"） */
  const loadSrc = React.useRef(entrySrc)

  // 换插件时重置导航守卫与界面状态
  React.useEffect(() => {
    loadSrc.current = entrySrc
    loadCount.current = 0
    hijacked.current = false
    setStatus("loading")
    setDirty(false)
    lastText.current = null
  }, [entrySrc])

  const post = React.useCallback((message: unknown, transfer?: Transferable[]) => {
    const win = frameRef.current?.contentWindow
    // targetOrigin 只能用 "*"：插件的 iframe 是 sandbox="allow-scripts"，属于
    // **不透明源**，它的 origin 序列化成 "null"，而 postMessage 的 targetOrigin
    // 参数只接受具体 URL 或 "*"（传 "null" 会按 URL 解析失败抛 SyntaxError）。
    // 因此出站方向无法靠 targetOrigin 约束，安全边界放在**入站**：
    // 见 onMessage 里的 event.origin 校验 + onLoad 的导航守卫。
    if (win && !hijacked.current) win.postMessage(message, "*", transfer ?? [])
  }, [])

  /**
   * 入口文档每次 load 都过这里。第 1 次是正常加载；第 2 次起说明这个 iframe
   * 已经导航到别的文档了 —— 而 CSP 的 `connect-src 'none'` / `default-src 'none'`
   * 拦不住"帧把自己导航走"（没有 navigate-to 指令，sandbox 也不禁止自身导航），
   * WindowProxy 又保持不变，于是导航后的文档仍能对着宿主发协议消息。
   *
   * 这里不尝试补救，直接断链：持 fs.read 的插件本来就能读出内容，宿主能做的
   * 只是别把"一次导航"升级成"一个可以任意读文件的接口"。
   */
  const handleFrameLoad = React.useCallback(() => {
    // 万一这次 load 属于"刚换上的新插件"（重置 effect 还没跑），把它当作新入口的第 1 次
    if (loadSrc.current !== entrySrc) {
      loadSrc.current = entrySrc
      loadCount.current = 0
      hijacked.current = false
    }
    loadCount.current += 1
    if (loadCount.current <= 1) return
    hijacked.current = true
    setStatus("failed")
  }, [entrySrc])

  const handleRequest = React.useCallback(
    async (req: FrameRequest): Promise<Outcome> => {
      const params = req.params || {}
      const targetPath = typeof params.path === "string" && params.path ? params.path : path
      // 插件清单声明的能力。**宿主是唯一的执法点**：插件跑在不透明源的 iframe 里，
      // 拿不到 Cookie、也发不出请求，所有读写都必须经这里代执行 —— 所以"该不该答应"
      // 的判断必须落在这里，而不能指望"插件不会越界"（安全复检 M-3：
      // 旧实现完全不看 permissions，零声明的插件照样能读写任意文件）。
      const perms = Array.isArray(plugin.permissions) ? plugin.permissions : []
      const requirePerm = (perm: string) => {
        if (!perms.includes(perm)) {
          throw new Error(t("ui.preview.plugin_permission_denied", { perm }))
        }
      }
      try {
        if (req.method === "readText") {
          requirePerm("fs.read")
          const data = await fetchFileText(targetPath, typeof params.encoding === "string" ? params.encoding : undefined)
          lastText.current = data
          return { ok: true, result: data }
        }
        if (req.method === "readBinary") {
          requirePerm("fs.read")
          const res = await fetch(downloadUrl(targetPath, true), {
            credentials: "same-origin",
            headers: { "X-Requested-With": "XMLHttpRequest" },
          })
          if (!res.ok) throw new Error(t("ui.preview.plugin_read_failed"))
          const buffer = await res.arrayBuffer()
          if (buffer.byteLength > MAX_BINARY_BYTES) throw new Error(t("ui.preview.plugin_too_large"))
          return { ok: true, result: { buffer, mime: res.headers.get("Content-Type") || "" }, transfer: [buffer] }
        }
        if (req.method === "saveText") {
          if (!canWrite) throw new Error(t("ui.preview.plugin_readonly"))
          requirePerm("fs.write")
          const base = lastText.current
          const saved = await saveFileText({
            path: targetPath,
            content: String(params.content ?? ""),
            encoding: typeof params.encoding === "string" ? params.encoding : base?.encoding || "utf8",
            eol: typeof params.eol === "string" ? params.eol : base?.eol || "lf",
            baseVersion: typeof params.baseVersion === "string" ? params.baseVersion : base?.baseVersion,
          })
          // 保存成功后版本串已经变了，旧值不能再用（否则下一次保存必然 409）。
          // 让插件在下次写入前重新 readText 拿新版本 —— 简单、且不会悄悄覆盖别人的改动。
          lastText.current = null
          return { ok: true, result: saved }
        }
        if (req.method === "notify") {
          requirePerm("ui.toast")
          toast.message(String(params.message ?? ""))
          return { ok: true, result: null }
        }
        return { ok: false, error: `unknown method: ${req.method}` }
      } catch (err) {
        return { ok: false, error: (err as Error).message || t("ui.common.operation_failed") }
      }
    },
    [canWrite, path, plugin.permissions, t]
  )

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // 已判定被导航劫持：一个字节都不再受理
      if (hijacked.current) return
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      // **必须校验来源**。sandbox 让插件文档成为不透明源，它发来的消息
      // `event.origin` 一定是字符串 "null"；而插件一旦把自己导航到外部站点
      // （https://attacker/），来源就变成真实 origin，这里会把整条会话掐断。
      // 只靠 event.source === contentWindow 是不够的：导航后 WindowProxy 不变，
      // 攻击者页面照样"就是那个窗口"。
      if (event.origin !== "null") {
        hijacked.current = true
        setStatus("failed")
        return
      }
      const data = event.data as { type?: string; id?: number; dirty?: boolean } | null
      if (!data || typeof data !== "object" || typeof data.type !== "string") return

      if (data.type === "zs:ready") {
        post({
          type: "zs:init",
          apiVersion: 1,
          file: { path, name, size, mtime },
          settings: plugin.settings || {},
          canWrite,
          dark: document.documentElement.classList.contains("dark"),
        })
        setStatus("ready")
        return
      }
      if (data.type === "zs:dirty") {
        const next = data.dirty === true
        setDirty(next)
        onDirtyChange?.(next)
        return
      }
      if (data.type === "zs:request" && typeof data.id === "number") {
        const req = data as unknown as FrameRequest
        void handleRequest(req).then(({ ok, result, error, transfer }) => {
          post({ type: "zs:response", id: req.id, ok, result, error }, transfer)
        })
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [canWrite, handleRequest, mtime, name, onDirtyChange, path, plugin.permissions, plugin.settings, post, size])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {status === "loading" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80">
          <Spinner className="size-5" />
          <p className="text-xs text-muted-foreground">{t("ui.preview.plugin_loading", { name: plugin.name })}</p>
        </div>
      )}
      {status === "failed" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center">
          <p className="text-sm">{t("ui.preview.plugin_failed")}</p>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            {t("ui.common.retry")}
          </Button>
        </div>
      )}
      <iframe
        ref={frameRef}
        title={plugin.name}
        src={entrySrc}
        // 关键：只有 allow-scripts。加上 allow-same-origin 等于把沙箱拆了
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={handleFrameLoad}
        onError={() => setStatus("failed")}
        className="min-h-0 w-full flex-1 border-0 bg-transparent"
      />
      {dirty && (
        <span className="pointer-events-none absolute top-2 right-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {t("ui.preview.plugin_dirty")}
        </span>
      )}
    </div>
  )
}
