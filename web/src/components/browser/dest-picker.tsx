import * as React from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Icon } from "@/components/icon"
import { api } from "@/lib/api"
import type { Entry } from "@/lib/types"
import { joinPath, parentOf } from "@/lib/format"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

export function DestPickerDialog({
  open,
  onOpenChange,
  title,
  sourcePaths,
  mode,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  sourcePaths: string[]
  mode: "copy" | "move"
  onDone: () => void
}) {
  const [current, setCurrent] = React.useState("")
  const [dirs, setDirs] = React.useState<Entry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback((path: string) => {
    setLoading(true)
    api
      .get<{ path: string; entries: Entry[] }>("/fs/list", { path })
      .then((data) => {
        setCurrent(data.path)
        setDirs(data.entries.filter((e) => e.type === "dir"))
      })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    if (open) load("")
  }, [open, load])

  const disabled = sourcePaths.some(
    (src) => current === src || current.startsWith(`${src}/`)
  )

  const submit = async () => {
    if (busy || disabled) return
    setBusy(true)
    try {
      await api.post(`/fs/${mode}`, { sources: sourcePaths, dest: current })
      toast.success(mode === "copy" ? "复制完成" : "移动完成")
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const crumbs = current ? current.split("/") : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button
            className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => load("")}
          >
            根目录
          </button>
          {crumbs.map((seg, i) => (
            <React.Fragment key={`${seg}-${i}`}>
              <Icon name="chevron-right" className="size-3" />
              <button
                className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => load(crumbs.slice(0, i + 1).join("/"))}
              >
                {seg}
              </button>
            </React.Fragment>
          ))}
        </div>
        <ScrollArea className="h-56 rounded-md border border-border">
          <div className="p-1">
            {current && (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                onClick={() => load(parentOf(current))}
              >
                <Icon name="corner-left-up" className="size-4 text-muted-foreground" />
                返回上级
              </button>
            )}
            {loading ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</p>
            ) : dirs.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">没有子文件夹</p>
            ) : (
              dirs.map((dir) => {
                const target = joinPath(current, dir.name)
                const isSource = sourcePaths.includes(target)
                return (
                  <button
                    key={dir.name}
                    disabled={isSource}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                      isSource && "opacity-40"
                    )}
                    onClick={() => load(target)}
                  >
                    <Icon name="folder" className="size-4 text-muted-foreground" />
                    <span className="truncate">{dir.name}</span>
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || disabled}>
            {busy && <Icon name="loader-2" className="animate-spin" />}
            {mode === "copy" ? "复制到此处" : "移动到此处"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
