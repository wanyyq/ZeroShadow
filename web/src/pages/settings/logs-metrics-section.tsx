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

function Sparkline({ data, max = 100, color = "#5b8def", height = 36 }: { data: number[]; max?: number; color?: string; height?: number }) {
  const width = 240
  if (data.length < 2) return <div className="flex h-9 items-center text-xs text-muted-foreground">数据不足</div>
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
    const t = setInterval(loadMetrics, 10000)
    return () => clearInterval(t)
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
          <CardTitle>系统指标</CardTitle>
          <CardDescription>每分钟采样；内存保留最近 {metrics?.config.memMinutes ?? 15} 分钟，磁盘保留 7 天</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="edge-highlight grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
            <Metric label="CPU" value={latest ? `${latest.cpu}%` : "—"} />
            <Metric label="内存" value={latest ? `${latest.memUsedPct}%` : "—"} sub={latest ? `${latest.rssMB}MB / ${latest.totalMB}MB` : ""} />
            <Metric label="磁盘" value={latest?.diskFreeMB != null ? `可用 ${latest.diskFreeMB}MB` : "—"} sub={latest?.diskTotalMB != null ? `共 ${latest.diskTotalMB}MB` : ""} />
            <Metric label="文件" value={latest ? `${latest.files} 文件` : "—"} sub={latest ? `${latest.dirs} 文件夹 · ${formatBytes(latest.bytes)}` : ""} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">CPU 使用率</span>
                <span className="font-medium">{latest ? `${latest.cpu}%` : "—"}</span>
              </div>
              <Sparkline data={cpuSeries} max={100} color="#e0894c" />
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">内存使用率</span>
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
          <CardTitle>请求指标</CardTitle>
          <CardDescription>近 {metrics?.config.memMinutes ?? 15} 分钟窗口统计</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="edge-highlight grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-5">
            <Metric label="QPS" value={req ? String(req.qps) : "—"} />
            <Metric label="2xx" value={req ? String(req.lastMinute.s2) : "—"} />
            <Metric label="4xx" value={req ? String(req.lastMinute.s4) : "—"} />
            <Metric label="5xx" value={req ? String(req.lastMinute.s5) : "—"} />
            <Metric label="慢请求" value={req ? String(req.lastMinute.slow) : "—"} />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted-foreground">慢请求（最近 {req?.slow.length ?? 0} 条）</p>
            <ScrollArea className="h-40 rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">方法</TableHead>
                    <TableHead>路径</TableHead>
                    <TableHead className="w-16">状态</TableHead>
                    <TableHead className="w-20">耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!req || req.slow.length === 0) && <TableRow><TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">暂无慢请求</TableCell></TableRow>}
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
              <CardTitle>操作日志</CardTitle>
              <CardDescription>登录、权限变更、文件操作与系统事件</CardDescription>
            </div>
            <Button size="sm" variant="destructive" onClick={() => setConfirmClear(true)}><Icon name="trash-2" /> 清空</Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {stats && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">共 {stats.total}</Badge>
              <Badge variant="outline">信息 {stats.byLevel.info || 0}</Badge>
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400">警告 {stats.byLevel.warn || 0}</Badge>
              <Badge variant="outline" className="text-destructive">错误 {stats.byLevel.error || 0}</Badge>
              {stats.topEvents.slice(0, 4).map((e) => (
                <Badge key={e.event} variant="outline" className="text-[10px]">{e.event} · {e.count}</Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={level} onValueChange={(v) => setLevel(v || "all")}>
              <SelectTrigger className="w-28" size="sm"><SelectValue>{(v) => (v === "info" ? "信息" : v === "warn" ? "警告" : v === "error" ? "错误" : "全部级别")}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部级别</SelectItem>
                <SelectItem value="info">信息</SelectItem>
                <SelectItem value="warn">警告</SelectItem>
                <SelectItem value="error">错误</SelectItem>
              </SelectContent>
            </Select>
            <Select value={days} onValueChange={(v) => setDays(v || "5")}>
              <SelectTrigger className="w-24" size="sm"><SelectValue render={(_p, s) => <>{s.value} 天</>}>{days} 天</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 天</SelectItem>
                <SelectItem value="5">5 天</SelectItem>
                <SelectItem value="30">30 天</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={auditOnly} onCheckedChange={(v) => setAuditOnly(!!v)} /> 仅审计事件
            </label>
            <Input placeholder="搜索事件/用户/IP…" className="h-8 w-48 text-sm" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadLogs()} />
            <Button size="sm" variant="ghost" onClick={loadLogs}><Icon name="refresh-cw" /> 刷新</Button>
          </div>
          <ScrollArea className="h-96 rounded-md border border-border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">时间</TableHead>
                  <TableHead className="w-28">事件</TableHead>
                  <TableHead className="w-24">用户</TableHead>
                  <TableHead className="w-32">IP</TableHead>
                  <TableHead>详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">暂无日志</TableCell></TableRow>}
                {logs.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{row.t.replace("T", " ").slice(0, 19)}</TableCell>
                    <TableCell className={cn("truncate text-xs font-medium", row.lvl === "error" ? "text-destructive" : row.lvl === "warn" ? "text-amber-600 dark:text-amber-400" : "")} title={row.ev}>
                      {row.audit && <Icon name="shield" className="mr-1 inline size-3 text-muted-foreground" />}
                      {row.ev}
                    </TableCell>
                    <TableCell className="truncate text-xs" title={row.user || undefined}>{row.user || "-"}</TableCell>
                    <TableCell className="truncate font-mono text-xs" title={row.ip || undefined}>{row.ip || "-"}</TableCell>
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
          <AlertDialogHeader><AlertDialogTitle>清空全部日志？</AlertDialogTitle><AlertDialogDescription>该操作不可撤销。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={async (e) => { e.preventDefault(); try { await api.del("/admin/logs"); toast.success("日志已清空"); loadLogs(); setConfirmClear(false) } catch (err) { toast.error((err as Error).message) } }}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
