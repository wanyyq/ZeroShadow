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

const FILE_LABEL: Record<string, string> = {
  "config.json": "系统配置",
  "users.json": "成员账户",
  "groups.json": "小组",
  "todos.json": "团队待办",
}

export function DataSection() {
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
    }, "默认可见范围已更新")
  }

  const doBackup = async () => {
    try {
      const d = await createBackup()
      setBackups(d.backups)
      toast.success(`已创建 ${d.count} 个文件的快照`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const doRestore = async () => {
    if (!restoreTarget) return
    try {
      await restoreBackup(restoreTarget.name, restoreTarget.id)
      toast.success("已回滚，请刷新页面")
      setRestoreTarget(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-5">
      {/* 头像 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>头像</CardTitle>
          <CardDescription>服务端与前端统一使用 128×128 WebP，客户端用 IndexedDB 缓存，未更换不重复下载</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">允许成员设置头像</p>
              <p className="text-xs text-muted-foreground">关闭后成员与超管均无法上传/修改头像</p>
            </div>
            <Switch checked={config.avatarEnabled !== false} onCheckedChange={(v) => patch({ avatarEnabled: !!v }, "已更新")} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-sm text-muted-foreground">单张体积上限</span>
              <Input className="w-24 text-right" inputMode="numeric" value={avatarMax} onChange={(e) => setAvatarMax(e.target.value)} />
              <span className="text-xs text-muted-foreground">KB</span>
            </div>
            <Button size="sm" onClick={() => patch({ avatarMaxKB: Number(avatarMax) }, "头像体积上限已更新")}>保存</Button>
          </div>
        </CardContent>
      </Card>

      {/* 团队待办 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>团队待办</CardTitle>
          <CardDescription>控制「团队」页面是否可用</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">启用团队待办</p>
              <p className="text-xs text-muted-foreground">关闭后所有成员看不到待办功能</p>
            </div>
            <Switch checked={config.todoEnabled !== false} onCheckedChange={(v) => patch({ todoEnabled: !!v }, "已更新")} />
          </div>
        </CardContent>
      </Card>

      {/* 未分组默认可见范围 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>默认上下文可见范围</CardTitle>
          <CardDescription>不属于任何小组、或顶栏选择「默认」时生效。白名单为空表示不限制，黑名单优先</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">白名单（每行一个相对路径）</span>
                <Button size="xs" variant="outline" onClick={() => setPicking("white")}>
                  <Icon name="folder-tree" data-icon="inline-start" /> 从目录选择
                </Button>
              </div>
              <Textarea className="h-24 resize-none font-mono text-xs" value={defWhite} onChange={(e) => setDefWhite(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">黑名单（一律隐藏）</span>
                <Button size="xs" variant="outline" onClick={() => setPicking("black")}>
                  <Icon name="folder-tree" data-icon="inline-start" /> 从目录选择
                </Button>
              </div>
              <Textarea className="h-24 resize-none font-mono text-xs" value={defBlack} onChange={(e) => setDefBlack(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveDefaults}>保存</Button>
            <span className="text-xs text-muted-foreground">点「从目录选择」会追加一行，仍需点保存才会生效</span>
          </div>
        </CardContent>
      </Card>

      <PathPicker open={picking !== null} onOpenChange={(o) => { if (!o) setPicking(null) }} onPick={insertPicked} />

      {/* 日志与指标保留 */}
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>日志与指标保留</CardTitle>
          <CardDescription>控制磁盘与内存占用；日志按天自动轮转清理</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div>
              <p className="text-sm font-medium">采集请求指标</p>
              <p className="text-xs text-muted-foreground">统计 QPS、状态码分布与慢请求</p>
            </div>
            <Switch checked={config.requestMetricsEnabled !== false} onCheckedChange={(v) => patch({ requestMetricsEnabled: !!v }, "已更新")} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberRow label="日志保留" value={logDays} onChange={setLogDays} unit="天" onSave={() => patch({ logRetentionDays: Number(logDays) }, "日志保留已更新")} />
            <NumberRow label="指标落盘保留" value={metricsDays} onChange={setMetricsDays} unit="天" onSave={() => patch({ metricsRetentionDays: Number(metricsDays) }, "已更新")} />
            <NumberRow label="内存曲线窗口" value={metricsMem} onChange={setMetricsMem} unit="分钟" onSave={() => patch({ metricsMemMinutes: Number(metricsMem) }, "已更新")} />
            <NumberRow label="慢请求阈值" value={slowMs} onChange={setSlowMs} unit="毫秒" onSave={() => patch({ slowRequestMs: Number(slowMs) }, "已更新")} />
          </div>
        </CardContent>
      </Card>

      {/* 备份 */}
      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>数据备份与回滚</CardTitle>
              <CardDescription>覆盖写入前自动快照，另每日快照；保留最近 {config.backupKeep} 份</CardDescription>
            </div>
            <Button size="sm" onClick={doBackup}><Icon name="database-backup" /> 立即备份</Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-sm text-muted-foreground">每个文件保留</span>
              <Input className="w-20 text-right" inputMode="numeric" value={backupKeep} onChange={(e) => setBackupKeep(e.target.value)} />
              <span className="text-xs text-muted-foreground">份</span>
            </div>
            <Button size="sm" onClick={() => patch({ backupKeep: Number(backupKeep) }, "保留份数已更新")}>保存</Button>
          </div>
          <Separator />
          <ScrollArea className="h-72 rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead className="w-40">时间</TableHead>
                  <TableHead className="w-20">大小</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(backups).flatMap(([name, rows]) =>
                  rows.map((row) => (
                    <TableRow key={`${name}-${row.id}`}>
                      <TableCell className="text-xs">{FILE_LABEL[name] || name}</TableCell>
                      <TableCell className="font-mono text-xs">{new Date(row.mtime).toLocaleString("zh-CN")}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatBytes(row.size)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="xs" variant="ghost" onClick={() => setRestoreTarget({ name, id: row.id })}>回滚</Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
                {Object.values(backups).every((r) => r.length === 0) && (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">暂无备份</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">备份保存在 data/backups/，仅包含 config/users/groups/todos 四个数据文件。</p>
        </CardContent>
      </Card>

      <AlertDialog open={restoreTarget !== null} onOpenChange={(o) => !o && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>回滚到该备份？</AlertDialogTitle>
            <AlertDialogDescription>
              将用所选备份覆盖当前的「{restoreTarget ? FILE_LABEL[restoreTarget.name] || restoreTarget.name : ""}」。当前状态也会先自动快照一份以便反悔。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); doRestore() }}>确认回滚</AlertDialogAction>
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
  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-1 items-center gap-2">
        <span className="w-24 shrink-0 text-sm text-muted-foreground">{label}</span>
        <Input className="w-20 text-right" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <Button size="sm" variant="outline" onClick={onSave}>保存</Button>
    </div>
  )
}
