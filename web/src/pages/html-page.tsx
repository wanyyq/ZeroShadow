import { useSearchParams, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { downloadUrl } from "@/lib/api"

export default function HtmlPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const entryPath = params.get("path") || ""
  const name = entryPath.split("/").pop() || ""
  const url = entryPath ? downloadUrl(entryPath, true) : ""

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Icon name="globe" className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon-xs" variant="ghost" onClick={() => window.open(url, "_blank")}>
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
