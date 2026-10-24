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

  const post = React.useCallback((message: unknown, transfer?: Transferable[]) => {
    const win = frameRef.current?.contentWindow
    if (win) win.postMessage(message, "*", transfer ?? [])
  }, [])

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
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
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
        src={`/api/plugins/entry/${encodeURIComponent(plugin.id)}`}
        // 关键：只有 allow-scripts。加上 allow-same-origin 等于把沙箱拆了
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
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
