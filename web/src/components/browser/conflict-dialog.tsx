import * as React from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Icon } from "@/components/icon"
import type { ConflictAction, ConflictItem, ConflictResolution } from "@/lib/conflict"
import { resolveDuplicateName } from "@/lib/conflict"
import { useT } from "@/lib/i18n"

interface ConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conflicts: string[]
  existingNames: Set<string>
  directoryNames?: Set<string>
  onResolved: (items: ConflictResolution) => void
}

export function ConflictDialog({
  open,
  onOpenChange,
  conflicts,
  existingNames,
  directoryNames,
  onResolved,
}: ConflictDialogProps) {
  const t = useT()
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
          <DialogTitle>{t("ui.conflict.title")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("ui.conflict.description", { count: conflicts.length })}
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
                  {/* 2–4 个互斥选项：用 ToggleGroup 而不是手写 radio + active 样式 */}
                  <ToggleGroup
                    size="sm"
                    className="flex-wrap"
                    value={[actions[i]]}
                    onValueChange={(next) => {
                      const picked = next[next.length - 1] as ConflictAction | undefined
                      if (picked && picked !== actions[i]) setAction(i, picked)
                    }}
                  >
                    <ToggleGroupItem value="rename">
                      <Icon name="pencil-line" data-icon="inline-start" />
                      {t("ui.conflict.rename_to", { name: resolvedNames[i] })}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="skip">
                      <Icon name="circle-slash" data-icon="inline-start" />
                      {t("ui.conflict.skip")}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="overwrite">
                      <Icon name="replace" data-icon="inline-start" />
                      {t("ui.conflict.overwrite")}
                    </ToggleGroupItem>
                    {isDir && (
                      <ToggleGroupItem value="merge">
                        <Icon name="folder-sync" data-icon="inline-start" />
                        {t("ui.conflict.merge")}
                      </ToggleGroupItem>
                    )}
                  </ToggleGroup>
                </div>
              )
            })}
          </div>
        </ScrollArea>
        {conflicts.length > 1 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={applyAll} onCheckedChange={(v) => setApplyAll(!!v)} />
            {t("ui.conflict.apply_to_all")}
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("ui.common.cancel")}</Button>
          <Button onClick={handleConfirm}>{t("ui.common.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
