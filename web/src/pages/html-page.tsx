import { useSearchParams, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { downloadUrl } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useAuth } from "@/state/auth"

/**
 * 上传的 HTML 页面预览。
 *
 * 前置权限检查不能只留在入口按钮上：这个页面是**可按 URL 直接打开**的
 * （`/html-preview?path=...`），而服务端的下载接口对 html 只做
 * `CSP sandbox` 隔离、并不校验 htmlPreview（沙箱保证它拿不到本站 Cookie 与
 * /api 会话，但"能不能在网盘里看到这个页面"仍是权限问题）。
 * 这里补一道与服务端一致的校验：没有 preview + htmlPreview 就退回上一页。
 */
export default function HtmlPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const t = useT()
  const { me } = useAuth()
  const entryPath = params.get("path") || ""
  const name = entryPath.split("/").pop() || ""
  const allowed = !!me.perms?.preview && !!me.perms?.htmlPreview
  const url = entryPath && allowed ? downloadUrl(entryPath, true) : ""

  if (!allowed) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <Icon name="shield-alert" className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("ui.settings.perms.html_preview_denied")}</p>
        <Button size="sm" variant="outline" onClick={() => navigate(-1)}>
          {t("ui.common.back")}
        </Button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Icon name="globe" className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon-xs" variant="ghost" onClick={() => window.open(url, "_blank", "noopener")}>
            <Icon name="external-link" />
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={() => navigate(-1)}><Icon name="x" /></Button>
        </div>
      </div>
      {/* 用户上传的 HTML 是不可信内容：sandbox 里绝不能加 allow-same-origin，
          否则页面拿到网盘源身份，可直接调用 /api 冒充当前登录用户。 */}
      <iframe src={url} title={name} className="flex-1 border-none" sandbox="allow-scripts" />
    </div>
  )
}
