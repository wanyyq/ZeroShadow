import * as React from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Icon } from "@/components/icon"
import { PathPicker } from "@/components/browser/path-picker"
import { api, createBackup, fetchBackups, restoreBackup } from "@/lib/api"
import { formatBytes } from "@/lib/format"
import type { AdminConfig, BackupsResponse } from "@/lib/types"
import { currentLang, useT } from "@/lib/i18n"

// 键是数据文件名（代码里用于查表），值是界面文案的键
const FILE_LABEL_KEY: Record<string, string> = {
  "config.json": "ui.settings.data.file_config",
  "users.json": "ui.settings.data.file_users",
  "groups.json": "ui.settings.data.file_groups",
  "todos.json": "ui.settings.data.todos",
}

export function DataSection() {
  const t = useT()
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [avatarMax, setAvatarMax] = React.useState("")
  const [backupKeep, setBackupKeep] = React.useState("")
  const [logDays, setLogDays] = React.useState("")
  const [metricsDays, setMetricsDays] = React.useState("")
  const [metricsMem, setMetricsMem] = React.useState("")
  const [slowMs, setSlowMs] = React.useState("")
  const [defWhite, setDefWhite] = React.useState("")
  const [defBlack, setDefBlack] = React.useState("")
  const [backups, setBackups] = React.useState<BackupsResponse>({})
  const [restoreTarget, setRestoreTarget] = React.useState<{ name: string; id: string } | null>(null)
  // 「从目录选择」当前要追加到哪个列表
  const [picking, setPicking] = React.useState<null | "white" | "black">(null)

  const fileLabel = (name: string) => {
    const key = FILE_LABEL_KEY[name]
    return key ? t(key) : name
  }

  const insertPicked = (picked: string) => {
    const isWhite = picking === "white"
    const current = isWhite ? defWhite : defBlack
    const lines = current.split("\n").map((l) => l.trim()).filter(Boolean)
    if (picked && !lines.includes(picked)) lines.push(picked)
    if (isWhite) setDefWhite(lines.join("\n"))
    else setDefBlack(lines.join("\n"))
    setPicking(null)
  }

  const load = React.useCallback(() => {
    api.get<AdminConfig>("/admin/config").then((c) => {
      setConfig(c)
      setAvatarMax(String(c.avatarMaxKB ?? 200))
      setBackupKeep(String(c.backupKeep ?? 20))
      setLogDays(String(c.logRetentionDays ?? 30))
      setMetricsDays(String(c.metricsRetentionDays ?? 7))
      setMetricsMem(String(c.metricsMemMinutes ?? 15))
      setSlowMs(String(c.slowRequestMs ?? 1000))
      setDefWhite((c.defaultVisibility?.whitelist || []).join("\n"))
      setDefBlack((c.defaultVisibility?.blacklist || []).join("\n"))
    }).catch((e) => toast.error((e as Error).message))
    fetchBackups().then((d) => setBackups(d.backups)).catch(() => {})
  }, [])
  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    try {
      const next = await api.patch<AdminConfig>("/admin/config", body)
      setConfig(next)
      if (msg) toast.success(msg)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const saveDefaults = () => {
    patch({
      defaultVisibility: {
        whitelist: defWhite.split("\n").map((l) => l.trim()).filter(Boolean),
        blacklist: defBlack.split("\n").map((l) => l.trim()).filter(Boolean),
      },
    }, t("ui.settings.data.default_visibility_updated"))
  }

  const doBackup = async () => {
    try {
      const d = await createBackup()
      setBackups(d.backups)
      toast.success(t("ui.settings.data.snapshot_created", { n: d.count }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const doRestore = async () => {
    if (!restoreTarget) return
    try {
      await restoreBackup(restoreTarget.name, restoreTarget.id)
      toast.success(t("ui.settings.data.restored"))
      setRestoreTarget(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  return (
    <div className="grid gap-5">
      {/* 头像 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>{t("ui.settings.data.avatar_title")}</CardTitle>
          <CardDescription>{t("ui.settings.data.avatar_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">{t("ui.settings.data.avatar_enabled")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.data.avatar_enabled_hint")}</p>
            </div>
            <Switch checked={config.avatarEnabled !== false} onCheckedChange={(v) => patch({ avatarEnabled: !!v }, t("ui.settings.data.updated"))} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-sm text-muted-foreground">{t("ui.settings.data.avatar_max_label")}</span>
              <Input className="w-24 text-right" inputMode="numeric" value={avatarMax} onChange={(e) => setAvatarMax(e.target.value)} />
              <span className="text-xs text-muted-foreground">KB</span>
            </div>
            <Button size="sm" onClick={() => patch({ avatarMaxKB: Number(avatarMax) }, t("ui.settings.data.avatar_max_updated"))}>{t("ui.common.save")}</Button>
          </div>
        </CardContent>
      </Card>

      {/* 团队待办 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>{t("ui.settings.data.todos")}</CardTitle>
          <CardDescription>{t("ui.settings.data.todos_description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">{t("ui.settings.data.todos_enabled")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.data.todos_enabled_hint")}</p>
            </div>
            <Switch checked={config.todoEnabled !== false} onCheckedChange={(v) => patch({ todoEnabled: !!v }, t("ui.settings.data.updated"))} />
          </div>
        </CardContent>
      </Card>

      {/* 未分组默认可见范围 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>{t("ui.settings.data.default_visibility_title")}</CardTitle>
          <CardDescription>{t("ui.settings.data.default_visibility_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t("ui.settings.data.whitelist_label")}</span>
                <Button size="xs" variant="outline" onClick={() => setPicking("white")}>
                  <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.settings.data.pick_from_dir")}
                </Button>
              </div>
              <Textarea className="h-24 resize-none font-mono text-xs" value={defWhite} onChange={(e) => setDefWhite(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t("ui.settings.data.blacklist_label")}</span>
                <Button size="xs" variant="outline" onClick={() => setPicking("black")}>
                  <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.settings.data.pick_from_dir")}
                </Button>
              </div>
              <Textarea className="h-24 resize-none font-mono text-xs" value={defBlack} onChange={(e) => setDefBlack(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveDefaults}>{t("ui.common.save")}</Button>
            <span className="text-xs text-muted-foreground">{t("ui.settings.data.pick_hint")}</span>
          </div>
        </CardContent>
      </Card>

      <PathPicker open={picking !== null} onOpenChange={(o) => { if (!o) setPicking(null) }} onPick={insertPicked} />

      {/* 日志与指标保留 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>{t("ui.settings.data.retention_title")}</CardTitle>
          <CardDescription>{t("ui.settings.data.retention_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">{t("ui.settings.data.metrics_enabled")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.data.metrics_enabled_hint")}</p>
            </div>
            <Switch checked={config.requestMetricsEnabled !== false} onCheckedChange={(v) => patch({ requestMetricsEnabled: !!v }, t("ui.settings.data.updated"))} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberRow label={t("ui.settings.data.log_retention")} value={logDays} onChange={setLogDays} unit={t("ui.settings.data.unit_days")} onSave={() => patch({ logRetentionDays: Number(logDays) }, t("ui.settings.data.log_retention_updated"))} />
            <NumberRow label={t("ui.settings.data.metrics_retention")} value={metricsDays} onChange={setMetricsDays} unit={t("ui.settings.data.unit_days")} onSave={() => patch({ metricsRetentionDays: Number(metricsDays) }, t("ui.settings.data.updated"))} />
            <NumberRow label={t("ui.settings.data.mem_window")} value={metricsMem} onChange={setMetricsMem} unit={t("ui.settings.data.unit_minutes")} onSave={() => patch({ metricsMemMinutes: Number(metricsMem) }, t("ui.settings.data.updated"))} />
            <NumberRow label={t("ui.settings.data.slow_threshold")} value={slowMs} onChange={setSlowMs} unit={t("ui.settings.data.unit_ms")} onSave={() => patch({ slowRequestMs: Number(slowMs) }, t("ui.settings.data.updated"))} />
          </div>
        </CardContent>
      </Card>

      {/* 备份 */}
      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("ui.settings.data.backup_title")}</CardTitle>
              <CardDescription>{t("ui.settings.data.backup_description", { n: config.backupKeep })}</CardDescription>
            </div>
            <Button size="sm" onClick={doBackup}><Icon name="database-backup" /> {t("ui.settings.data.backup_now")}</Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {/* 这个开关此前在前端完全没有入口，只能手改 data/config.json，
              而文档里又说「快照默认开启」——两边对不上。 */}
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">{t("ui.settings.data.backup_enabled")}</p>
              <p className="text-xs text-muted-foreground">
                {t("ui.settings.data.backup_enabled_hint")}
              </p>
            </div>
            <Switch
              checked={config.backupEnabled !== false}
              onCheckedChange={(v) => patch({ backupEnabled: !!v }, t("ui.settings.data.updated"))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-sm text-muted-foreground">{t("ui.settings.data.backup_keep_label")}</span>
              <Input className="w-20 text-right" inputMode="numeric" value={backupKeep} onChange={(e) => setBackupKeep(e.target.value)} />
              <span className="text-xs text-muted-foreground">{t("ui.settings.data.unit_copies")}</span>
            </div>
            <Button size="sm" onClick={() => patch({ backupKeep: Number(backupKeep) }, t("ui.settings.data.backup_keep_updated"))}>{t("ui.common.save")}</Button>
          </div>
          <Separator />
          <ScrollArea className="h-72 rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("ui.common.file")}</TableHead>
                  <TableHead className="w-40">{t("ui.common.time")}</TableHead>
                  <TableHead className="w-20">{t("ui.common.size")}</TableHead>
                  <TableHead className="w-20 text-right">{t("ui.common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(backups).flatMap(([name, rows]) =>
                  rows.map((row) => (
                    <TableRow key={`${name}-${row.id}`}>
                      <TableCell className="text-xs">{fileLabel(name)}</TableCell>
                      <TableCell className="font-mono text-xs">{new Date(row.mtime).toLocaleString(currentLang())}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatBytes(row.size)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="xs" variant="ghost" onClick={() => setRestoreTarget({ name, id: row.id })}>{t("ui.settings.data.restore")}</Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
                {Object.values(backups).every((r) => r.length === 0) && (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">{t("ui.settings.data.no_backups")}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">{t("ui.settings.data.backup_hint")}</p>
        </CardContent>
      </Card>

      <AlertDialog open={restoreTarget !== null} onOpenChange={(o) => !o && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.settings.data.restore_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ui.settings.data.restore_confirm_description", { name: restoreTarget ? fileLabel(restoreTarget.name) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); doRestore() }}>{t("ui.settings.data.restore_confirm_action")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function NumberRow({ label, value, onChange, unit, onSave }: {
  label: string
  value: string
  onChange: (v: string) => void
  unit: string
  onSave: () => void
}) {
  const t = useT()
  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-1 items-center gap-2">
        <span className="w-24 shrink-0 text-sm text-muted-foreground">{label}</span>
        <Input className="w-20 text-right" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <Button size="sm" variant="outline" onClick={onSave}>{t("ui.common.save")}</Button>
    </div>
  )
}
