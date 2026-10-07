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
import { detectConflicts } from "@/lib/conflict"
import { CONFLICT_CANCELLED, isCaseInsensitive } from "@/lib/conflict"
import type { ConflictResolution } from "@/lib/conflict"
import { ConflictDialog } from "@/components/browser/conflict-dialog"

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
  const [conflictOpen, setConflictOpen] = React.useState(false)
  const [conflictNames, setConflictNames] = React.useState<string[]>([])
  const [conflictExisting, setConflictExisting] = React.useState<Set<string>>(new Set())
  const [conflictDirs, setConflictDirs] = React.useState<Set<string>>(new Set())
  const conflictResolveRef = React.useRef<((items: ConflictResolution) => void) | null>(null)

  React.useEffect(() => {
    if (open && entry) setName(entry.shortcut?.displayName || entry.name)
  }, [open, entry])

  const submit = async () => {
    if (!entry || !name.trim() || busy) return
    setBusy(true)
    let newName = name.trim()
    if (entry.type === "shortcut" && !newName.toLowerCase().endsWith(".zeropath")) {
      newName = newName + ".zeropath"
    }
    try {
      const parentPath = path
      const listData = await api.get<{ entries: Entry[] }>("/fs/list", { path: parentPath })
      const filtered = listData.entries.filter((e) => e.name.toLowerCase() !== entry.name.toLowerCase())
      const existingNames = filtered.map((e) => e.name)
      // 冲突判定必须与服务端同规则（Windows/macOS 不区分大小写）。这里原先用
      // 裸 === 比较，于是"仅改大小写的重命名"撞上已存在的同名目录时会被归类成
      // 文件冲突，并给出「覆盖 / 合并」这两个对文件无意义的选项。
      const ci = isCaseInsensitive()
      const same = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
      const isDirConflict = filtered.some((e) => same(e.name, newName) && e.type === "dir")
      const conflicts = detectConflicts([newName], new Set(existingNames))
      if (conflicts.length === 0) {
        await api.post("/fs/rename", { path: joinPath(path, entry.name), newName })
        toast.success("已重命名")
        onOpenChange(false)
        setBusy(false)
        onDone()
      } else {
        setConflictNames([newName])
        setConflictExisting(new Set(existingNames))
        setConflictDirs(isDirConflict ? new Set([newName]) : new Set())
        conflictResolveRef.current = async (items) => {
          // 取消：直接结束，不要再往下走
          if (items === CONFLICT_CANCELLED) { setBusy(false); return }
          const item = items[0]
          // 旧实现把「取消」当成空数组传进来，item 为 undefined，
          // 读 item.action 抛出的 TypeError 被 catch 成一条英文报错 toast
          if (!item) { setBusy(false); return }
          setBusy(true)
          try {
            if (item.action === "skip") {
              onOpenChange(false)
              setBusy(false)
              return
            }
            if (item.action === "overwrite") {
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName, overwrite: true })
              toast.success("已重命名（覆盖）")
              onOpenChange(false)
              onDone()
            } else if (item.action === "merge") {
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName, merge: true })
              toast.success("已重命名（合并）")
              onOpenChange(false)
              onDone()
            } else if (item.action === "rename" && item.resolvedName) {
              let resolved = item.resolvedName
              if (entry.type === "shortcut" && !resolved.toLowerCase().endsWith(".zeropath")) {
                resolved = resolved + ".zeropath"
              }
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName: resolved })
              toast.success("已重命名")
              onOpenChange(false)
              onDone()
            }
          } catch (err) { toast.error((err as Error).message) }
          finally { setBusy(false) }
        }
        setConflictOpen(true)
        setBusy(false)
      }
    } catch (err) {
      toast.error((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
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
    <ConflictDialog
      open={conflictOpen}
      onOpenChange={(o) => { setConflictOpen(o); if (!o && conflictResolveRef.current) { conflictResolveRef.current(CONFLICT_CANCELLED); conflictResolveRef.current = null } }}
      conflicts={conflictNames}
      existingNames={conflictExisting}
      directoryNames={conflictDirs}
      onResolved={(items) => { conflictResolveRef.current?.(items); conflictResolveRef.current = null }}
    />
    </>
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
      const r = await api.post<{
        deleted: number
        trashed: number
        permanentlyDeleted?: string[]
        failed?: { path: string; error: string }[]
      }>("/fs/delete", { paths: names.map((n) => joinPath(path, n)) })
      if (r.failed && r.failed.length) {
        // 回收站可用、但这些条目没能入站：服务端已经**保留原文件**并跳过删除。
        // 必须明确报错，否则用户会以为删掉了，而文件其实还在（旧实现是把它们
        // 直接彻底删除，静默销毁数据）。
        toast.error(`${r.failed.length} 项未能删除（原文件仍保留）`, {
          description: r.failed.map((f) => `${f.path}：${f.error}`).join("\n"),
        })
      } else if (r.permanentlyDeleted && r.permanentlyDeleted.length) {
        // 回收站没兜住（目录不可用等）：必须明确告知，不能让用户以为还能还原
        toast.warning(`已删除 ${names.length} 项，其中 ${r.permanentlyDeleted.length} 项未进入回收站`, {
          description: `以下项目已被彻底删除，无法还原：${r.permanentlyDeleted.join("、")}`,
        })
      } else if (r.trashed > 0) {
        toast.success(`已将 ${r.trashed} 项移入回收站`)
      } else {
        toast.success(`已删除 ${names.length} 项`)
      }
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
            将把 {names.length === 1 ? `“${names[0]}”` : `选中的 ${names.length} 项`}
            移入<strong>回收站</strong>，可在「设置 → 回收站」里还原（管理员操作）。
            超过保留期或被清空后将无法恢复。
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
  isHtml,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
  name: string
  isHtml?: boolean
}) {
  const kind = previewType(name)
  const url = entryPath !== null ? downloadUrl(entryPath, true) : ""
  const [text, setText] = React.useState<string | null>(null)
  const [imgScale, setImgScale] = React.useState(1)
  const imgRef = React.useRef<HTMLImageElement>(null)

  React.useEffect(() => {
    setText(null)
    setImgScale(1)
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

  const handleWheel = (e: React.WheelEvent) => {
    if (kind !== "image") return
    e.preventDefault()
    setImgScale((prev) => {
      const next = prev - e.deltaY * 0.001
      return Math.max(0.1, Math.min(10, next))
    })
  }

  const ext = name.split(".").pop()?.toLowerCase() || ""
  const isHtmlFile = isHtml || ext === "html" || ext === "htm"

  if (!kind && !isHtmlFile) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[95vh] w-[95vw] max-w-none p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <div className="flex items-center gap-1">
              {kind === "image" && (
                <>
                  <Button size="icon-xs" variant="ghost" onClick={() => setImgScale((s) => Math.min(10, s + 0.25))}><Icon name="zoom-in" /></Button>
                  <Button size="icon-xs" variant="ghost" onClick={() => setImgScale((s) => Math.max(0.1, s - 0.25))}><Icon name="zoom-out" /></Button>
                  <Button size="icon-xs" variant="ghost" onClick={() => setImgScale(1)}><Icon name="rotate-cw" /></Button>
                </>
              )}
              <Button size="icon-xs" variant="ghost" onClick={() => onOpenChange(false)}><Icon name="x" /></Button>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {kind === "image" && (
              <div className="flex h-full items-center justify-center overflow-auto bg-muted/40" onWheel={handleWheel}>
                <img ref={imgRef} src={url} alt={name} style={{ transform: `scale(${imgScale})`, transition: "transform 0.1s" }} className="max-w-full" />
              </div>
            )}
            {kind === "video" && (
              <video src={url} controls autoPlay className="h-full w-full bg-black" />
            )}
            {kind === "audio" && (
              <div className="flex h-full items-center justify-center bg-muted/40 p-8">
                <div className="w-full max-w-md">
                  <div className="mb-4 text-center">
                    <Icon name="music" className="mx-auto size-12 text-muted-foreground" />
                    <p className="mt-2 truncate text-sm font-medium">{name}</p>
                  </div>
                  <audio src={url} controls autoPlay className="w-full" />
                </div>
              </div>
            )}
            {kind === "pdf" && <iframe src={url} title={name} className="h-full w-full" />}
            {/* 预览 HTML 时必须去掉 allow-same-origin：与 allow-scripts 同时出现的
                组合等同无沙箱，被预览页面可反过来操作父页面与本站接口。 */}
            {isHtmlFile && <iframe src={url} title={name} className="h-full w-full" sandbox="allow-scripts" />}
            {kind === "text" && (
              <ScrollArea className="h-full w-full bg-muted/30">
                <pre className="p-4 font-mono text-xs whitespace-pre-wrap">{text ?? "加载中…"}</pre>
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function EditorDialog({
  open,
  onOpenChange,
  entryPath,
  name,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
  name: string
  onDone: () => void
}) {
  const [content, setContent] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)

  React.useEffect(() => {
    if (open && entryPath !== null) {
      setContent("")
      setDirty(false)
      fetch(downloadUrl(entryPath, true), { credentials: "same-origin" })
        .then(async (r) => { if (r.ok) setContent(await r.text()); else toast.error("加载失败") })
        .catch(() => toast.error("加载失败"))
    }
  }, [open, entryPath])

  const save = async () => {
    if (!entryPath || saving) return
    setSaving(true)
    try {
      await api.post("/fs/save-file", { path: entryPath, content })
      toast.success("已保存")
      setDirty(false)
      onDone()
    } catch (err) { toast.error((err as Error).message) }
    finally { setSaving(false) }
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save() }
    }
    if (open) window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, content, entryPath])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && dirty && !confirm("有未保存的更改，确定关闭？")) return; onOpenChange(o); if (!o) setDirty(false) }}>
      <DialogContent className="h-[90vh] w-[90vw] max-w-none p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">编辑 {name}</DialogTitle>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <Icon name="pencil-line" className="size-4 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{name}{dirty ? " ●" : ""}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
                {saving && <Icon name="loader-2" className="animate-spin" />} 保存
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => onOpenChange(false)}><Icon name="x" /></Button>
            </div>
          </div>
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true) }}
            className="flex-1 resize-none border-none bg-muted/20 p-4 font-mono text-xs leading-relaxed whitespace-pre outline-none"
            spellCheck={false}
            placeholder="加载中…"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
