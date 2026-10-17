import * as React from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Icon } from "@/components/icon"
import { api, fetchMetrics } from "@/lib/api"
import { formatBytes } from "@/lib/format"
import type { LogRow, LogStats, MetricsResponse } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"

function Sparkline({ data, max = 100, color = "#5b8def", height = 36 }: { data: number[]; max?: number; color?: string; height?: number }) {
  const t = useT()
  const width = 240
  if (data.length < 2) return <div className="flex h-9 items-center text-xs text-muted-foreground">{t("ui.settings.logs.insufficient_data")}</div>
  const step = width / (data.length - 1)
  const points = data.map((v, i) => {
    const y = height - Math.max(0, Math.min(1, max ? v / max : 1)) * (height - 4) - 2
    return `${i * step},${y}`
  }).join(" ")
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-9 w-full">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card p-3">
      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value}</p>
      {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function LogsMetricsSection() {
  const t = useT()
  const [metrics, setMetrics] = React.useState<MetricsResponse | null>(null)
  const [logs, setLogs] = React.useState<LogRow[]>([])
  const [stats, setStats] = React.useState<LogStats | null>(null)
  const [level, setLevel] = React.useState("all")
  const [auditOnly, setAuditOnly] = React.useState(false)
  const [days, setDays] = React.useState("5")
  const [q, setQ] = React.useState("")
  const [confirmClear, setConfirmClear] = React.useState(false)

  const loadMetrics = React.useCallback(() => {
    fetchMetrics().then(setMetrics).catch(() => {})
  }, [])
  React.useEffect(() => {
    loadMetrics()
    const timer = setInterval(loadMetrics, 10000)
    return () => clearInterval(timer)
  }, [loadMetrics])

  const loadLogs = React.useCallback(() => {
    api.get<{ logs: LogRow[]; stats: LogStats }>("/admin/logs", {
      limit: 300,
      level: level === "all" ? "" : level,
      q,
      days: Number(days) || 5,
      audit: auditOnly ? "1" : "",
    })
      .then((d) => { setLogs(d.logs); setStats(d.stats) })
      .catch((e) => toast.error((e as Error).message))
  }, [level, q, days, auditOnly])
  React.useEffect(loadLogs, [loadLogs])

  const latest = metrics?.latest
  const cpuSeries = metrics?.mem.map((m) => m.cpu) || []
  const memSeries = metrics?.mem.map((m) => m.memUsedPct) || []
  const req = metrics?.requests

  return (
    <div className="grid gap-5">
      {/* 系统指标 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>{t("ui.settings.logs.system_metrics")}</CardTitle>
          <CardDescription>
            {t("ui.settings.logs.system_metrics_description", { n: metrics?.config.memMinutes ?? 15 })}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="edge-highlight grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
            <Metric label="CPU" value={latest ? `${latest.cpu}%` : "—"} />
            <Metric label={t("ui.settings.logs.metric_memory")} value={latest ? `${latest.memUsedPct}%` : "—"} sub={latest ? `${latest.rssMB}MB / ${latest.totalMB}MB` : ""} />
            <Metric label={t("ui.settings.logs.metric_disk")} value={latest?.diskFreeMB != null ? t("ui.settings.logs.disk_free", { n: latest.diskFreeMB }) : "—"} sub={latest?.diskTotalMB != null ? t("ui.settings.logs.disk_total", { n: latest.diskTotalMB }) : ""} />
            <Metric label={t("ui.settings.logs.metric_files")} value={latest ? t("ui.settings.logs.files_count", { n: latest.files }) : "—"} sub={latest ? t("ui.settings.logs.dirs_and_size", { dirs: latest.dirs, size: formatBytes(latest.bytes) }) : ""} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t("ui.settings.logs.cpu_usage")}</span>
                <span className="font-medium">{latest ? `${latest.cpu}%` : "—"}</span>
              </div>
              <Sparkline data={cpuSeries} max={100} color="#e0894c" />
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t("ui.settings.logs.memory_usage")}</span>
                <span className="font-medium">{latest ? `${latest.memUsedPct}%` : "—"}</span>
              </div>
              <Sparkline data={memSeries} max={100} color="#5b8def" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 请求指标 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>{t("ui.settings.logs.request_metrics")}</CardTitle>
          <CardDescription>{t("ui.settings.logs.request_metrics_description", { n: metrics?.config.memMinutes ?? 15 })}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="edge-highlight grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-5">
            <Metric label="QPS" value={req ? String(req.qps) : "—"} />
            <Metric label="2xx" value={req ? String(req.lastMinute.s2) : "—"} />
            <Metric label="4xx" value={req ? String(req.lastMinute.s4) : "—"} />
            <Metric label="5xx" value={req ? String(req.lastMinute.s5) : "—"} />
            <Metric label={t("ui.settings.logs.slow_requests")} value={req ? String(req.lastMinute.slow) : "—"} />
          </div>
          <div className="min-w-0">
            <p className="mb-2 text-xs text-muted-foreground">{t("ui.settings.logs.slow_requests_recent", { n: req?.slow.length ?? 0 })}</p>
            <ScrollArea className="h-40 min-w-0 rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14 sm:w-16">{t("ui.settings.logs.col_method")}</TableHead>
                    <TableHead>{t("ui.common.path")}</TableHead>
                    <TableHead className="w-12 sm:w-16">{t("ui.common.status")}</TableHead>
                    <TableHead className="w-16 sm:w-20">{t("ui.settings.logs.col_duration")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!req || req.slow.length === 0) && <TableRow><TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">{t("ui.settings.logs.no_slow_requests")}</TableCell></TableRow>}
                  {req?.slow.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{s.method}</TableCell>
                      <TableCell className="truncate font-mono text-xs" title={s.path}>{s.path}</TableCell>
                      <TableCell className={cn("text-xs", s.status >= 500 ? "text-destructive" : "")}>{s.status}</TableCell>
                      <TableCell className="text-xs">{s.ms}ms</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>
        </CardContent>
      </Card>

      {/* 日志 */}
      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("ui.settings.logs.audit_title")}</CardTitle>
              <CardDescription>{t("ui.settings.logs.audit_description")}</CardDescription>
            </div>
            <Button size="sm" variant="destructive" onClick={() => setConfirmClear(true)}><Icon name="trash-2" /> {t("ui.settings.logs.clear")}</Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {stats && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{t("ui.settings.logs.total_count", { n: stats.total })}</Badge>
              <Badge variant="outline">{t("ui.settings.logs.level_info_count", { n: stats.byLevel.info || 0 })}</Badge>
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400">{t("ui.settings.logs.level_warn_count", { n: stats.byLevel.warn || 0 })}</Badge>
              <Badge variant="outline" className="text-destructive">{t("ui.settings.logs.level_error_count", { n: stats.byLevel.error || 0 })}</Badge>
              {stats.topEvents.slice(0, 4).map((e) => (
                <Badge key={e.event} variant="outline" className="text-[10px]">{e.event} · {e.count}</Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={level} onValueChange={(v) => setLevel(v || "all")}>
              <SelectTrigger className="w-28" size="sm"><SelectValue>{(v) => (v === "info" ? t("ui.settings.logs.level_info") : v === "warn" ? t("ui.settings.logs.level_warn") : v === "error" ? t("ui.settings.logs.level_error") : t("ui.settings.logs.level_all"))}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("ui.settings.logs.level_all")}</SelectItem>
                <SelectItem value="info">{t("ui.settings.logs.level_info")}</SelectItem>
                <SelectItem value="warn">{t("ui.settings.logs.level_warn")}</SelectItem>
                <SelectItem value="error">{t("ui.settings.logs.level_error")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={days} onValueChange={(v) => setDays(v || "5")}>
              <SelectTrigger className="w-24" size="sm"><SelectValue render={(_p, s) => <>{t("ui.settings.logs.unit_days", { n: s.value })}</>}>{t("ui.settings.logs.unit_days", { n: days })}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t("ui.settings.logs.unit_days", { n: 1 })}</SelectItem>
                <SelectItem value="5">{t("ui.settings.logs.unit_days", { n: 5 })}</SelectItem>
                <SelectItem value="30">{t("ui.settings.logs.unit_days", { n: 30 })}</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={auditOnly} onCheckedChange={(v) => setAuditOnly(!!v)} /> {t("ui.settings.logs.audit_only")}
            </label>
            <Input placeholder={t("ui.settings.logs.search_placeholder")} className="h-8 w-48 text-sm" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadLogs()} />
            <Button size="sm" variant="ghost" onClick={loadLogs}><Icon name="refresh-cw" /> {t("ui.common.refresh")}</Button>
          </div>
          <ScrollArea className="h-96 min-w-0 rounded-md border border-border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24 sm:w-40">{t("ui.common.time")}</TableHead>
                  <TableHead className="w-24 sm:w-28">{t("ui.settings.logs.col_event")}</TableHead>
                  <TableHead className="hidden w-24 sm:table-cell">{t("ui.settings.logs.col_user")}</TableHead>
                  <TableHead className="hidden w-32 md:table-cell">IP</TableHead>
                  <TableHead>{t("ui.settings.logs.col_detail")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{t("ui.settings.logs.no_logs")}</TableCell></TableRow>}
                {logs.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{row.t.replace("T", " ").slice(0, 19)}</TableCell>
                    <TableCell className={cn("truncate text-xs font-medium", row.lvl === "error" ? "text-destructive" : row.lvl === "warn" ? "text-amber-600 dark:text-amber-400" : "")} title={row.ev}>
                      {row.audit && <Icon name="shield" className="mr-1 inline size-3 text-muted-foreground" />}
                      {row.ev}
                    </TableCell>
                    <TableCell className="hidden truncate text-xs sm:table-cell" title={row.user || undefined}>{row.user || "-"}</TableCell>
                    <TableCell className="hidden truncate font-mono text-xs md:table-cell" title={row.ip || undefined}>{row.ip || "-"}</TableCell>
                    <TableCell className="truncate text-xs" title={row.msg}>{row.msg || "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t("ui.settings.logs.clear_confirm_title")}</AlertDialogTitle><AlertDialogDescription>{t("ui.settings.logs.clear_confirm_description")}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={async (e) => { e.preventDefault(); try { await api.del("/admin/logs"); toast.success(t("ui.settings.logs.cleared")); loadLogs(); setConfirmClear(false) } catch (err) { toast.error((err as Error).message) } }}>{t("ui.settings.logs.clear")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
