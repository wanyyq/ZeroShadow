import * as React from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Icon } from "@/components/icon"
import { api, downloadUrl } from "@/lib/api"
import { fileKind, formatBytes, formatDate, joinPath, previewType } from "@/lib/format"
import type { Entry, EntryStat } from "@/lib/types"
import { toast } from "sonner"

export function NewFolderDialog({
  open,
  onOpenChange,
  path,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string
  onDone: () => void
}) {
  const [name, setName] = React.useState("新建文件夹")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setName("新建文件夹")
  }, [open])

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await api.post("/fs/mkdir", { path, name: name.trim() })
      toast.success("文件夹已创建")
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建文件夹</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="folder-name">名称</Label>
          <Input
            id="folder-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />} 创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RenameDialog({
  open,
  onOpenChange,
  entry,
  path,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: Entry | null
  path: string
  onDone: () => void
}) {
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open && entry) setName(entry.name)
  }, [open, entry])

  const submit = async () => {
    if (!entry || !name.trim() || busy) return
    setBusy(true)
    try {
      await api.post("/fs/rename", { path: joinPath(path, entry.name), newName: name.trim() })
      toast.success("已重命名")
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="rename-input">新名称</Label>
          <Input
            id="rename-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />} 确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteDialog({
  open,
  onOpenChange,
  names,
  path,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  names: string[]
  path: string
  onDone: () => void
}) {
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.post("/fs/delete", { paths: names.map((n) => joinPath(path, n)) })
      toast.success(`已删除 ${names.length} 项`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除</AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除 {names.length === 1 ? `“${names[0]}”` : `选中的 ${names.length} 项`}
            ，此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {busy && <Icon name="loader-2" className="animate-spin" />} 删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function DetailsDialog({
  open,
  onOpenChange,
  entryPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
}) {
  const [stat, setStat] = React.useState<EntryStat | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!open || entryPath === null) return
    setLoading(true)
    setStat(null)
    api
      .get<EntryStat>("/fs/stat", { path: entryPath })
      .then(setStat)
      .catch((err) => toast.error((err as Error).message))
      .finally(() => setLoading(false))
  }, [open, entryPath])

  const rows: [string, React.ReactNode][] = stat
    ? [
        ["名称", stat.name],
        ["类型", stat.type === "dir" ? "文件夹" : fileKind(stat.name, "file").label],
        ["位置", `/${stat.path.split("/").slice(0, -1).join("/")}`],
        ["大小", `${formatBytes(stat.size)}${stat.partial ? "（部分统计）" : ""}`],
        ...(stat.type === "dir"
          ? ([["包含", `${stat.files ?? 0} 个文件，${stat.dirs ?? 0} 个文件夹`]] as [
              string,
              React.ReactNode,
            ][])
          : []),
        ["修改时间", formatDate(stat.mtime)],
        ["创建时间", formatDate(stat.created)],
        [
          "访客可见性",
          stat.hiddenFromGuest ? (
            <Badge variant="secondary">
              <Icon name="eye-off" className="size-3" /> 对访客隐藏
            </Badge>
          ) : (
            "可见"
          ),
        ],
      ]
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>详细信息</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="grid gap-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : stat ? (
          <div className="grid gap-2.5 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[6rem_1fr] items-center gap-2">
                <span className="text-muted-foreground">{label}</span>
                <span className="break-all">{value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export function PreviewDialog({
  open,
  onOpenChange,
  entryPath,
  name,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
  name: string
}) {
  const kind = previewType(name)
  const url = entryPath !== null ? downloadUrl(entryPath, true) : ""
  const [text, setText] = React.useState<string | null>(null)

  React.useEffect(() => {
    setText(null)
    if (open && kind === "text" && entryPath !== null) {
      fetch(url, { credentials: "same-origin" })
        .then(async (r) => {
          if (!r.ok) throw new Error("加载失败")
          const value = await r.text()
          setText(value.length > 200000 ? `${value.slice(0, 200000)}\n… (内容过长已截断)` : value)
        })
        .catch(() => setText("无法加载预览"))
    }
  }, [open, kind, url, entryPath])

  if (!kind) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{name}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-muted/40">
          {kind === "image" && (
            <img src={url} alt={name} className="max-h-[70vh] max-w-full object-contain" />
          )}
          {kind === "video" && <video src={url} controls className="max-h-[70vh] w-full" />}
          {kind === "audio" && <audio src={url} controls className="w-full p-8" />}
          {kind === "pdf" && <iframe src={url} title={name} className="h-[70vh] w-full" />}
          {kind === "text" && (
            <ScrollArea className="h-[60vh] w-full">
              <pre className="p-4 font-mono text-xs whitespace-pre-wrap">{text ?? "加载中…"}</pre>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
