import * as React from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Icon } from "@/components/icon"
import { cn } from "@/lib/utils"
import type { ConflictAction, ConflictItem } from "@/lib/conflict"
import { resolveDuplicateName } from "@/lib/conflict"

interface ConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conflicts: string[]
  existingNames: Set<string>
  directoryNames?: Set<string>
  onResolved: (items: ConflictItem[]) => void
}

export function ConflictDialog({
  open,
  onOpenChange,
  conflicts,
  existingNames,
  directoryNames,
  onResolved,
}: ConflictDialogProps) {
  const dirs = directoryNames ?? new Set<string>()
  const defaultAction = (name: string): ConflictAction => dirs.has(name) ? "merge" : "rename"

  const [actions, setActions] = React.useState<ConflictAction[]>(() =>
    conflicts.map((n) => defaultAction(n))
  )
  const [applyAll, setApplyAll] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setActions(conflicts.map((n) => defaultAction(n)))
      setApplyAll(false)
    }
  }, [open, conflicts])

  const resolvedNames = React.useMemo(() => {
    const taken = new Set(existingNames)
    return actions.map((action, i) => {
      if (action === "rename") {
        const resolved = resolveDuplicateName(conflicts[i], taken)
        taken.add(resolved)
        return resolved
      }
      return conflicts[i]
    })
  }, [actions, conflicts, existingNames])

  const setAction = (index: number, action: ConflictAction) => {
    if (applyAll && action !== "rename" && action !== "merge") {
      setActions((prev) => {
        const next = [...prev]
        for (let i = index; i < next.length; i += 1) {
          next[i] = action
        }
        return next
      })
    } else {
      setActions((prev) => {
        const next = [...prev]
        next[index] = action
        if (applyAll) {
          for (let i = index + 1; i < next.length; i += 1) {
            next[i] = action
          }
        }
        return next
      })
    }
  }

  const handleConfirm = () => {
    const items: ConflictItem[] = conflicts.map((name, i) => ({
      name,
      action: actions[i],
      resolvedName: actions[i] === "rename" ? resolvedNames[i] : undefined,
    }))
    onResolved(items)
    onOpenChange(false)
  }

  if (!conflicts.length) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>同名文件处理</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          目标位置已存在 {conflicts.length} 个同名项目，请选择处理方式：
        </p>
        <ScrollArea className="max-h-64 rounded-md border border-border">
          <div className="divide-y divide-border">
            {conflicts.map((name, i) => {
              const isDir = dirs.has(name)
              return (
                <div key={name} className="grid gap-2 p-3">
                  <p className="truncate text-sm font-medium" title={name}>
                    <Icon name={isDir ? "folder" : "file"} className="mr-1.5 inline size-3.5 text-muted-foreground" />
                    {name}
                  </p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <label className={cn("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 transition-colors", actions[i] === "rename" ? "border-ring bg-accent" : "border-border hover:bg-muted")}>
                      <input
                        type="radio"
                        name={`conflict-${i}`}
                        className="sr-only"
                        checked={actions[i] === "rename"}
                        onChange={() => setAction(i, "rename")}
                      />
                      <Icon name="pencil-line" className="size-3" />
                      重命名为 {resolvedNames[i]}
                    </label>
                    <label className={cn("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 transition-colors", actions[i] === "skip" ? "border-ring bg-accent" : "border-border hover:bg-muted")}>
                      <input
                        type="radio"
                        name={`conflict-${i}`}
                        className="sr-only"
                        checked={actions[i] === "skip"}
                        onChange={() => setAction(i, "skip")}
                      />
                      <Icon name="circle-slash" className="size-3" />
                      跳过
                    </label>
                    <label className={cn("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 transition-colors", actions[i] === "overwrite" ? "border-ring bg-accent" : "border-border hover:bg-muted")}>
                      <input
                        type="radio"
                        name={`conflict-${i}`}
                        className="sr-only"
                        checked={actions[i] === "overwrite"}
                        onChange={() => setAction(i, "overwrite")}
                      />
                      <Icon name="replace" className="size-3" />
                      覆盖
                    </label>
                    {isDir && (
                      <label className={cn("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 transition-colors", actions[i] === "merge" ? "border-ring bg-accent" : "border-border hover:bg-muted")}>
                        <input
                          type="radio"
                          name={`conflict-${i}`}
                          className="sr-only"
                          checked={actions[i] === "merge"}
                          onChange={() => setAction(i, "merge")}
                        />
                        <Icon name="folder-sync" className="size-3" />
                        合并
                      </label>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
        {conflicts.length > 1 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={applyAll} onCheckedChange={(v) => setApplyAll(!!v)} />
            对接下来所有同名项目执行此操作
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleConfirm}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
