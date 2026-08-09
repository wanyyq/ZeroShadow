import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Icon } from "@/components/icon"
import { api } from "@/lib/api"
import type { Entry } from "@/lib/types"
import { joinPath } from "@/lib/format"
import { toast } from "sonner"

export function PathPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
}) {
  const [current, setCurrent] = React.useState("")
  const [dirs, setDirs] = React.useState<Entry[]>([])
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback((path: string) => {
    setLoading(true)
    api.get<{ path: string; entries: Entry[] }>("/fs/list", { path })
      .then((data) => {
        setCurrent(data.path)
        setDirs(data.entries.filter((e) => e.type === "dir"))
      })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => { if (open) load("") }, [open, load])

  const handlePick = () => {
    onPick(current)
    onOpenChange(false)
  }

  const crumbs = current ? current.split("/") : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>选择目录</DialogTitle></DialogHeader>
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground" onClick={() => load("")}>
            根目录
          </button>
          {crumbs.map((seg, i) => (
            <React.Fragment key={`${seg}-${i}`}>
              <Icon name="chevron-right" className="size-3" />
              <button className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground" onClick={() => load(crumbs.slice(0, i + 1).join("/"))}>
                {seg}
              </button>
            </React.Fragment>
          ))}
        </div>
        <ScrollArea className="h-56 rounded-md border border-border">
          <div className="p-1">
            {current && (
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                onClick={() => { const parts = current.split("/"); parts.pop(); load(parts.join("/")) }}>
                <Icon name="corner-left-up" className="size-4 text-muted-foreground" /> 返回上级
              </button>
            )}
            {loading ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</p>
            ) : dirs.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">没有子文件夹</p>
            ) : (
              dirs.map((dir) => (
                <button key={dir.name}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                  onClick={() => load(joinPath(current, dir.name))}>
                  <Icon name="folder" className="size-4 text-muted-foreground" />
                  <span className="truncate">{dir.name}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground truncate">{current || "根目录"}</span>
          <Button size="sm" onClick={handlePick}>选择此目录</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
