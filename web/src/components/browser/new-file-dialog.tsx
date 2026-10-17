import * as React from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/icon"
import { createEmptyFile } from "@/lib/api"
import { checkFileName } from "@/lib/new-file"
import { useT } from "@/lib/i18n"
import { useOperations } from "@/state/operations"

/**
 * 右键「新建…」用到的两个对话框（v1.2.1）。
 *
 * 设计上刻意很轻：新建出来的永远是**空文件**，内容交给在线编辑器；
 * 这样服务端只需要一个 create-file 接口，也不会出现"前端拼一段半成品内容"
 * 这种以后难维护的行为。
 */

export function NewCustomFileDialog({
  open,
  onOpenChange,
  dirPath,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 新建到哪个目录（相对网盘根；根目录是空串） */
  dirPath: string
  onDone: (created?: string) => void
}) {
  const t = useT()
  const [base, setBase] = React.useState("")
  const [ext, setExt] = React.useState("txt")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setBase(t("ui.create.name_placeholder"))
    setExt("txt")
    setBusy(false)
  }, [open, t])

  const extension = ext.trim().replace(/^\.+/, "").replace(/[\\/:*?"<>|\s]/g, "")
  const name = extension ? `${base.trim()}.${extension}` : base.trim()

  const submit = async () => {
    if (busy) return
    const reason = checkFileName(name)
    if (reason === "empty") {
      toast.warning(t("ui.create.name_required"))
      return
    }
    if (reason) {
      toast.warning(t("ui.create.name_invalid"))
      return
    }
    setBusy(true)
    try {
      const res = await createEmptyFile(dirPath, name)
      toast.success(t("ui.create.created", { name: res.name }))
      onOpenChange(false)
      onDone(res.name)
    } catch (err) {
      const message = (err as Error).message
      // 服务端对同名返回 409，这里换成更直白的提示
      toast.error(/已存在/.test(message) ? t("ui.create.exists") : message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ui.create.custom_title")}</DialogTitle>
          <DialogDescription>{t("ui.create.custom_desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-file-base">{t("ui.create.base_name")}</Label>
            <Input
              id="new-file-base"
              value={base}
              autoFocus
              onChange={(e) => setBase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-file-ext">{t("ui.create.extension")}</Label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">.</span>
              <Input
                id="new-file-ext"
                value={ext}
                className="font-mono"
                onChange={(e) => setExt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("ui.create.extension_hint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("ui.common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !base.trim()}>
            {busy ? <Icon name="loader-2" className="animate-spin" /> : <Icon name="file-plus" />}
            {t("ui.create.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 新建下载任务：把「链接下载器」从工具页搬到右键菜单里，
 * 目的地固定为当前目录（这样"新建到哪"是显而易见的）。
 */
export function DownloadTaskDialog({
  open,
  onOpenChange,
  dest,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dest: string
  onDone: () => void
}) {
  const t = useT()
  const ops = useOperations()
  const [url, setUrl] = React.useState("")
  const [filename, setFilename] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setUrl("")
    setFilename("")
    setError(null)
  }, [open])

  const submit = () => {
    const value = url.trim()
    if (!value) {
      setError(t("ui.create.url_required"))
      return
    }
    if (!/^https?:\/\/.+/i.test(value)) {
      setError(t("ui.create.url_invalid"))
      return
    }
    setError(null)
    ops.startDownloadUrl(value, dest || "/", filename.trim() || undefined)
    toast.success(t("ui.create.started"))
    onOpenChange(false)
    onDone()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ui.create.download_title")}</DialogTitle>
          <DialogDescription>{t("ui.create.download_desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="dl-url">{t("ui.create.url")}</Label>
            <Input
              id="dl-url"
              value={url}
              autoFocus
              inputMode="url"
              placeholder={t("ui.create.url_placeholder")}
              onChange={(e) => {
                setUrl(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              aria-invalid={!!error}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dl-name">{t("ui.create.filename_optional")}</Label>
            <Input
              id="dl-name"
              value={filename}
              placeholder={t("ui.create.filename_placeholder")}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
            {t("ui.create.dest")}: <span className="font-mono break-all">/{dest}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("ui.common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!url.trim()}>
            <Icon name="download" /> {t("ui.create.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
