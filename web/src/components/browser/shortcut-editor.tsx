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
import { useT } from "@/lib/i18n"
import type { Entry } from "@/lib/types"

const LOGO_ICONS = [
  "folder", "file", "file-text", "file-code", "image", "film", "music",
  "folder-archive", "globe", "hard-drive", "download", "upload",
  "database", "server", "link", "external-link", "bolt", "star",
] as const

/** label 存的是**键**：这张表在模块加载时只求值一次，存译文切换语言后不会刷新 */
const TARGET_TYPES = [
  { value: "path", label: "ui.shortcut.type_dir" },
  { value: "file", label: "ui.common.file" },
  { value: "soft_path", label: "ui.shortcut.type_soft_dir" },
  { value: "soft_file", label: "ui.shortcut.type_soft_file" },
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
  const t = useT()
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

  const [name, setName] = React.useState(targetFromEntry ? t("ui.shortcut.default_name", { name: entry!.name }) : defaultName)
  const [targetUrl, setTargetUrl] = React.useState(targetFromEntry ? targetFromEntry.url : defaultUrl)
  const [targetType, setTargetType] = React.useState(targetFromEntry ? targetFromEntry.type : defaultType)
  const [logo, setLogo] = React.useState(targetFromEntry ? (entry!.type === "dir" ? "folder" : "file") : defaultLogo)
  const [busy, setBusy] = React.useState(false)

  // 目标类型下拉当前项的文案键（表里存的是键，这里才取译文）
  const targetTypeKey = TARGET_TYPES.find((opt) => opt.value === targetType)?.label

  React.useEffect(() => {
    if (open) {
      if (targetFromEntry) {
        setName(t("ui.shortcut.default_name", { name: entry!.name }))
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
  }, [open, t])

  const save = async () => {
    if (!name.trim() || !targetUrl.trim()) { toast.warning(t("ui.shortcut.name_target_required")); return }
    setBusy(true)
    try {
      const content = JSON.stringify({ name: name.trim(), logo, url: targetUrl.trim(), type: targetType })
      const fileName = name.trim().endsWith(".zeropath") ? name.trim() : `${name.trim()}.zeropath`
      const destPath = currentPath ? `${currentPath}/${fileName}` : fileName

      // 先写新文件、成功之后再删旧文件。
      // 旧实现是「先删后写」，且删除失败被静默吞掉：只要写入这一步失败
      // （名称非法 / 权限 / 网络中断），旧快捷方式就已经被删了 —— 凭空消失。
      await api.post("/fs/save-file", { path: destPath, content })

      const oldPath = entry ? joinPath(currentPath, entry.name) : ""
      const sameTarget = !!entry && oldPath.toLowerCase() === destPath.toLowerCase()
      if (editingExisting && entry && !sameTarget) {
        try {
          await api.post("/fs/delete", { paths: [oldPath] })
        } catch (err) {
          // 新文件已经写好，旧文件没删掉：如实告知，不假装完全成功
          toast.warning(t("ui.shortcut.saved_old_not_deleted"), {
            description: (err as Error).message,
          })
          onOpenChange(false)
          onDone()
          return
        }
      }

      toast.success(editingExisting ? t("ui.shortcut.updated") : t("ui.shortcut.created"))
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
          <DialogTitle>{editingExisting ? t("ui.browser.edit_shortcut") : t("ui.browser.create_shortcut")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sc-name">{t("ui.shortcut.name_label")}</Label>
            <Input id="sc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ui.shortcut.name_placeholder")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sc-url">{t("ui.shortcut.target_path_label")}</Label>
            <Input id="sc-url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder={t("ui.shortcut.target_placeholder")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t("ui.shortcut.target_type_label")}</Label>
              <Select value={targetType} onValueChange={(v) => setTargetType(v as typeof targetType)}>
                <SelectTrigger><SelectValue render={(_p, s) => <>{s.value}</>}>{targetTypeKey ? t(targetTypeKey) : null}</SelectValue></SelectTrigger>
                <SelectContent>
                  {TARGET_TYPES.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{t(opt.label)}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("ui.shortcut.icon_label")}</Label>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("ui.common.cancel")}</Button>
          <Button onClick={save} disabled={busy || !name.trim() || !targetUrl.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />}
            {editingExisting ? t("ui.common.save") : t("ui.shortcut.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
