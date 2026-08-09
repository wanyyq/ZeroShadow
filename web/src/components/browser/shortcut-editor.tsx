import * as React from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Icon } from "@/components/icon"
import { api } from "@/lib/api"
import { joinPath } from "@/lib/format"
import type { Entry } from "@/lib/types"

const LOGO_ICONS = [
  "folder", "file", "file-text", "file-code", "image", "film", "music",
  "folder-archive", "globe", "hard-drive", "download", "upload",
  "database", "server", "link", "external-link", "bolt", "star",
] as const

const TARGET_TYPES = [
  { value: "path", label: "目录" },
  { value: "file", label: "文件" },
  { value: "soft_path", label: "外部映射目录" },
  { value: "soft_file", label: "外部映射文件" },
] as const

export function ShortcutEditorDialog({
  open,
  onOpenChange,
  entry,
  currentPath,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry?: Entry | null
  currentPath: string
  onDone: () => void
}) {
  const editingExisting = entry?.type === "shortcut" && !!entry.shortcut
  const defaultName = editingExisting ? (entry?.shortcut?.displayName || entry?.name || "") : ""
  const defaultUrl = editingExisting ? entry.shortcut!.targetUrl : ""
  const defaultType = editingExisting ? entry.shortcut!.targetType : "path"
  const defaultLogo = editingExisting ? (entry.shortcut!.logo || "link") : "link"

  // If creating from a regular file/folder, pre-fill the target
  const targetFromEntry = entry && entry.type !== "shortcut"
    ? {
        url: joinPath(currentPath, entry.name),
        type: entry.softReadOnly
          ? (entry.type === "dir" ? "soft_path" : "soft_file")
          : (entry.type === "dir" ? "path" : "file"),
      }
    : null

  const [name, setName] = React.useState(targetFromEntry ? `${entry!.name} 快捷方式` : defaultName)
  const [targetUrl, setTargetUrl] = React.useState(targetFromEntry ? targetFromEntry.url : defaultUrl)
  const [targetType, setTargetType] = React.useState(targetFromEntry ? targetFromEntry.type : defaultType)
  const [logo, setLogo] = React.useState(targetFromEntry ? (entry!.type === "dir" ? "folder" : "file") : defaultLogo)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      if (targetFromEntry) {
        setName(`${entry!.name} 快捷方式`)
        setTargetUrl(targetFromEntry.url)
        setTargetType(targetFromEntry.type as typeof targetType)
        setLogo(entry!.type === "dir" ? "folder" : "file")
      } else if (editingExisting) {
        setName(defaultName)
        setTargetUrl(defaultUrl)
        setTargetType(defaultType)
        setLogo(defaultLogo)
      } else {
        setName("")
        setTargetUrl("")
        setTargetType("path")
        setLogo("link")
      }
    }
  }, [open])

  const save = async () => {
    if (!name.trim() || !targetUrl.trim()) { toast.warning("名称和目标不能为空"); return }
    setBusy(true)
    try {
      const content = JSON.stringify({ name: name.trim(), logo, url: targetUrl.trim(), type: targetType })
      const fileName = name.trim().endsWith(".zeropath") ? name.trim() : `${name.trim()}.zeropath`
      const destPath = currentPath ? `${currentPath}/${fileName}` : fileName

      // If editing existing, delete old file first
      if (editingExisting && entry) {
        try { await api.post("/fs/delete", { paths: [joinPath(currentPath, entry.name)] }) } catch { /* ignore */ }
      }

      await api.post("/fs/save-file", { path: destPath, content })
      toast.success(editingExisting ? "快捷方式已更新" : "快捷方式已创建")
      onOpenChange(false)
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingExisting ? "编辑快捷方式" : "创建快捷方式"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sc-name">显示名称</Label>
            <Input id="sc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="快捷方式显示名" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sc-url">目标路径</Label>
            <Input id="sc-url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="相对路径或外部映射路径" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>目标类型</Label>
              <Select value={targetType} onValueChange={(v) => setTargetType(v as typeof targetType)}>
                <SelectTrigger><SelectValue render={(_p, s) => <>{s.value}</>}>{TARGET_TYPES.find((t) => t.value === targetType)?.label}</SelectValue></SelectTrigger>
                <SelectContent>
                  {TARGET_TYPES.map((t) => (<SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>图标</Label>
              <div className="flex flex-wrap gap-1 rounded-md border border-border p-1.5 max-h-32 overflow-y-auto">
                {LOGO_ICONS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    className={`flex size-7 items-center justify-center rounded transition-colors ${logo === icon ? "bg-accent ring-1 ring-ring" : "hover:bg-muted"}`}
                    onClick={() => setLogo(icon)}
                    title={icon}
                  >
                    <Icon name={icon} className="size-4" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={save} disabled={busy || !name.trim() || !targetUrl.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />}
            {editingExisting ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
