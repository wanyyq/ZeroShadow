import * as React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { api, downloadUrl } from "@/lib/api"
import { toast } from "sonner"

export default function EditorPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const entryPath = params.get("path") || ""
  const name = entryPath.split("/").pop() || ""
  const [content, setContent] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (entryPath) {
      setLoading(true)
      fetch(downloadUrl(entryPath, true), { credentials: "same-origin" })
        .then(async (r) => {
          if (r.ok) {
            const text = await r.text()
            setContent(text)
            setOriginal(text)
          } else {
            toast.error("加载文件失败")
          }
        })
        .catch(() => toast.error("加载文件失败"))
        .finally(() => setLoading(false))
    }
  }, [entryPath])

  const dirty = content !== original

  const save = async () => {
    if (!entryPath || saving) return
    setSaving(true)
    try {
      await api.post("/fs/save-file", { path: entryPath, content })
      setOriginal(content)
      toast.success("已保存")
    } catch (err) { toast.error((err as Error).message) }
    finally { setSaving(false) }
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save() }
      if (e.key === "Escape" && !dirty) navigate(-1)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [content, original, entryPath])

  const handleClose = () => {
    if (dirty && !confirm("有未保存的更改，确定离开？")) return
    navigate(-1)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Icon name="pencil-line" className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{name}{dirty ? " ●" : ""}</span>
          <span className="text-[10px] text-muted-foreground">Ctrl+S 保存</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
            {saving && <Icon name="loader-2" className="animate-spin" />} 保存
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={handleClose}><Icon name="x" /></Button>
        </div>
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">加载中…</div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 resize-none border-none bg-muted/10 p-6 font-mono text-sm leading-relaxed whitespace-pre outline-none"
          spellCheck={false}
          placeholder="（空文件）"
        />
      )}
    </div>
  )
}
