import * as React from "react"
import { fetchShareOptions, type ShareExpiryOption } from "@/lib/api"
import { clearWebMcpTools, installWebMcpTools, webMcpSupported } from "@/lib/webmcp"
import { useAuth } from "@/state/auth"
import { useClientSettings } from "@/state/client-settings"

/**
 * WebMcpBridge —— 把当前登录会话的能力暴露成 WebMCP 工具。
 *
 * 单独放在 `state/` 而不是和纯函数混在 `lib/webmcp.ts`：后者给 lint 的
 * "一个文件只导出组件" 规则会让路（Fast refresh 需要组件文件干净）。
 *
 * 渲染 `null`，对界面零影响；浏览器不支持 `navigator.modelContext` 时什么也不做。
 *
 * **必须用户显式同意才会注册**（「设置 → 外观 → 允许浏览器 AI 调用网盘」，
 * `ClientSettings.webmcpEnabled`，默认关闭）。原因：注册的工具里包含
 * `create_text_file`、`share_create`（生成公开下载链接）、`share_revoke`，
 * 一旦注册，浏览器里任何接入的 AI 代理都能以当前用户权限直接调用，界面上
 * 没有任何提示；而网盘里的文本本身就是可被写入的提示注入载体 ——
 * "打开一个 Markdown 文件 → 代理照着里面的指令建公开分享 → 外带"这条链路
 * 只能靠"默认不授权"来断。
 */
export function WebMcpBridge() {
  const { me, ready } = useAuth()
  const { webmcpEnabled } = useClientSettings()
  const [expiry, setExpiry] = React.useState<ShareExpiryOption[]>([])

  const active = ready && me.role !== "guest" && webmcpEnabled && webMcpSupported()

  // 有效期档位由服务端下发：工具描述里要写清可选值，所以先取一次。
  // 未授权时不去请求：这个请求本身就在告诉服务端"有人准备用分享工具了"。
  React.useEffect(() => {
    if (!active) return
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
  }, [active])

  React.useEffect(() => {
    if (!ready) return
    if (!active) {
      // 关掉开关（或降级为访客）时立刻撤销，而不是等组件卸载
      clearWebMcpTools()
      return
    }
    return installWebMcpTools(me, expiry)
  }, [ready, active, me, expiry])

  return null
}
