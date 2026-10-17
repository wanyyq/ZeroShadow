import * as React from "react"
import { fetchShareOptions, type ShareExpiryOption } from "@/lib/api"
import { installWebMcpTools, webMcpSupported } from "@/lib/webmcp"
import { useAuth } from "@/state/auth"

/**
 * WebMcpBridge —— 把当前登录会话的能力暴露成 WebMCP 工具。
 *
 * 单独放在 `state/` 而不是和纯函数混在 `lib/webmcp.ts`：后者给 lint 的
 * "一个文件只导出组件" 规则会让路（Fast refresh 需要组件文件干净）。
 *
 * 渲染 `null`，对界面零影响；浏览器不支持 `navigator.modelContext` 时什么也不做。
 */
export function WebMcpBridge() {
  const { me, ready } = useAuth()
  const [expiry, setExpiry] = React.useState<ShareExpiryOption[]>([])

  // 有效期档位由服务端下发：工具描述里要写清可选值，所以先取一次
  React.useEffect(() => {
    if (!ready || me.role === "guest" || !webMcpSupported()) return
    let alive = true
    fetchShareOptions()
      .then((o) => {
        if (alive) setExpiry(o.expiry)
      })
      .catch(() => {
        /* 拿不到就用空清单：分享工具会提示可选值缺失，其余工具照常 */
      })
    return () => {
      alive = false
    }
  }, [ready, me.role])

  React.useEffect(() => {
    if (!ready) return
    return installWebMcpTools(me, expiry)
  }, [ready, me, expiry])

  return null
}
