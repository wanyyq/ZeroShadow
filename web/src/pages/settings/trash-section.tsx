import * as React from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Icon } from "@/components/icon"
import { useConfirm } from "@/components/confirm-dialog"
import { getErrorMessage } from "@/lib/api"
import { api, emptyTrash, fetchTrash, purgeTrash, restoreTrash } from "@/lib/api"
import type { AdminConfig, TrashResponse } from "@/lib/types"
import { formatBytes } from "@/lib/format"
import { useT } from "@/lib/i18n"
/**
 * 回收站。
 *
 * 服务端的删除已经改为"移入回收站"，但**回收站的浏览与还原刻意只对超管开放**
 * （见 server/src/routes/admin.js 里的说明）：成员照常能删，但暂存区里的内容
 * 由超管统一管理，权限面更小，也避免成员之间互相看到对方删掉的文件。
 */
export function TrashSection() {
  const t = useT()
  const [data, setData] = React.useState<TrashResponse | null>(null)
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [retention, setRetention] = React.useState("")
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const confirm = useConfirm()

  const load = React.useCallback(() => {
    fetchTrash()
      .then((d) => {
        setData(d)
        setRetention(String(d.retentionDays ?? 30))
      })
      .catch((e) => toast.error(getErrorMessage(e)))
    api.get<AdminConfig>("/admin/config").then(setConfig).catch(() => {})
  }, [])
  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch<AdminConfig>("/admin/config", body)
      toast.success(msg)
      load()
    } catch (e) {
      toast.error(getErrorMessage(e))
    }
  }

  // confirm() 返回的是"用户点完确认之后的 promise"，所以要 await 它，
  // busy 标记才有意义。旧实现 set→doRestore→set(null) 全在同一 tick，
  // disabled 永远不生效（连点会弹出两个确认框）。
  const runBusy = async (id: string, fn: () => Promise<void> | void) => {
    setBusyId(id)
    try {
      await fn()
    } finally {
      setBusyId(null)
    }
  }

  const doRestore = (id: string, rel: string) =>
    runBusy(id, () =>
      confirm({
        title: t("ui.settings.trash.restore_confirm_title", { path: rel }),
        description: t("ui.settings.trash.restore_confirm_description"),
        confirmText: t("ui.settings.trash.restore"),
        destructive: false,
        onConfirm: async () => {
          await restoreTrash(id)
          toast.success(t("ui.settings.trash.restored"))
          load()
        },
      }).then(() => undefined)
    )

  /** 还原遇到同名冲突：让用户选择覆盖 */
  const doRestoreOverwrite = (id: string, rel: string) =>
    runBusy(id, () =>
      confirm({
        title: t("ui.settings.trash.overwrite_confirm_title", { path: rel }),
        description: t("ui.settings.trash.overwrite_confirm_description"),
        confirmText: t("ui.settings.trash.overwrite_restore"),
        onConfirm: async () => {
          await restoreTrash(id, undefined, true)
          toast.success(t("ui.settings.trash.overwrite_restored"))
          load()
        },
      }).then(() => undefined)
    )

  const doPurge = (id: string, rel: string) =>
    runBusy(id, () =>
      confirm({
        title: t("ui.settings.trash.purge_confirm_title", { path: rel }),
        description: t("ui.settings.trash.purge_confirm_description"),
        confirmText: t("ui.settings.trash.purge"),
        onConfirm: async () => {
          await purgeTrash(id)
          toast.success(t("ui.settings.trash.purged"))
          load()
        },
      }).then(() => undefined)
    )

  const doEmpty = () => {
    void confirm({
      title: t("ui.settings.trash.empty_confirm_title"),
      description: t("ui.settings.trash.empty_confirm_description", { n: data?.stats.count ?? 0 }),
      confirmText: t("ui.settings.trash.empty"),
      onConfirm: async () => {
        const r = await emptyTrash()
        toast.success(t("ui.settings.trash.emptied", { n: r.removed }))
        load()
      },
    })
  }

  const items = data?.items || []
  const stats = data?.stats

  return (
    <div className="grid gap-5">
      {data && data.enabled && !data.available && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("ui.settings.trash.unavailable_prefix")}<strong>{t("ui.settings.trash.unavailable_strong")}</strong>{t("ui.settings.trash.unavailable_suffix")}
        </div>
      )}

      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{t("ui.settings.trash.title")}</CardTitle>
              <CardDescription>
                {t("ui.settings.trash.description_prefix")}
                {stats ? t("ui.settings.trash.description_stats", { count: stats.count, size: formatBytes(stats.bytes) }) : ""}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("ui.settings.trash.retention_label")}</span>
                <Input
                  className="h-8 w-16 text-right"
                  inputMode="numeric"
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">{t("ui.settings.trash.unit_days")}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => patch({ trashRetentionDays: Number(retention) }, t("ui.settings.trash.retention_updated"))}
                >
                  {t("ui.common.save")}
                </Button>
              </div>
              <Button size="sm" variant="outline" onClick={load}>
                <Icon name="refresh-cw" /> {t("ui.common.refresh")}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" disabled={!items.length} onClick={doEmpty}>
                <Icon name="trash-2" /> {t("ui.settings.trash.empty_button")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {config && (
            <label className="flex cursor-pointer items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span>
                <span className="block text-sm font-medium">{t("ui.settings.trash.enabled_label")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("ui.settings.trash.enabled_hint")}
                </span>
              </span>
              <input
                type="checkbox"
                className="size-4"
                checked={config.trashEnabled !== false}
                onChange={(e) => patch({ trashEnabled: e.target.checked }, e.target.checked ? t("ui.settings.trash.enabled_toast") : t("ui.settings.trash.disabled_toast"))}
              />
            </label>
          )}
          <Separator />
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("ui.settings.trash.empty_state")}</p>
          ) : (
            <ScrollArea className="h-80 rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("ui.common.name")}</TableHead>
                    <TableHead>{t("ui.settings.trash.col_original_path")}</TableHead>
                    <TableHead className="w-24 text-right">{t("ui.common.size")}</TableHead>
                    <TableHead className="w-40">{t("ui.settings.trash.col_deleted_at")}</TableHead>
                    <TableHead className="w-24">{t("ui.settings.trash.col_deleted_by")}</TableHead>
                    <TableHead className="w-44 text-right">{t("ui.common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="max-w-56 truncate font-medium" title={it.name}>
                        <Icon name={it.type === "dir" ? "folder" : "file"} className="mr-1.5 inline size-3.5 text-muted-foreground" />
                        {it.name}
                      </TableCell>
                      <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={it.rel}>
                        /{it.rel}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {it.size < 0 ? t("ui.settings.trash.directory") : formatBytes(it.size)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{it.deletedAt.replace("T", " ").slice(0, 19)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {it.deletedBy || "—"}
                        {it.deletedByRole === "superadmin" && <Badge variant="secondary" className="ml-1 text-[10px]">{t("ui.settings.trash.superadmin")}</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyId === it.id}
                          onClick={() => { void doRestore(it.id, it.rel) }}
                        >
                          {t("ui.settings.trash.restore")}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-1"
                          title={t("ui.settings.trash.overwrite_hint")}
                          disabled={busyId === it.id}
                          onClick={() => { void doRestoreOverwrite(it.id, it.rel) }}
                        >
                          {t("ui.settings.trash.overwrite_restore")}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-1 text-destructive"
                          disabled={busyId === it.id}
                          onClick={() => { void doPurge(it.id, it.rel) }}
                        >
                          {t("ui.settings.trash.purge")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
          <p className="text-xs text-muted-foreground">
            {t("ui.settings.trash.hint")}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
