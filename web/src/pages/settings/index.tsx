import * as React from "react"
import { toast } from "sonner"
import { AppHeader } from "@/components/layout/app-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Icon } from "@/components/icon"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/state/auth"
import { useClientSettings } from "@/state/client-settings"
import { api } from "@/lib/api"
import { formatBytes, formatUptime } from "@/lib/format"
import type { AdminConfig, LogRow, Member, ServerStatus, TunnelStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

export function SettingsPage() {
  const { me, ready } = useAuth()
  const isSuper = me.role === "superadmin"

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <h1 className="font-heading mb-1 text-2xl font-semibold tracking-tight">设置</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {isSuper ? "管理外观、服务器、成员与权限" : "个性化你的浏览体验"}
        </p>
        {ready && (
          <Tabs defaultValue="appearance" className="gap-4">
            <TabsList variant="line" className="flex-wrap">
              <TabsTrigger value="appearance">
                <Icon name="palette" /> 外观与浏览
              </TabsTrigger>
              {isSuper && (
                <>
                  <TabsTrigger value="status">
                    <Icon name="activity" /> 服务器状态
                  </TabsTrigger>
                  <TabsTrigger value="logs">
                    <Icon name="scroll-text" /> 日志
                  </TabsTrigger>
                  <TabsTrigger value="members">
                    <Icon name="users" /> 成员管理
                  </TabsTrigger>
                  <TabsTrigger value="perms">
                    <Icon name="shield-check" /> 权限
                  </TabsTrigger>
                  <TabsTrigger value="tunnel">
                    <Icon name="globe" /> 公网访问
                  </TabsTrigger>
                </>
              )}
            </TabsList>
            <TabsContent value="appearance">
              <AppearanceSection />
            </TabsContent>
            {isSuper && (
              <>
                <TabsContent value="status">
                  <StatusSection />
                </TabsContent>
                <TabsContent value="logs">
                  <LogsSection />
                </TabsContent>
                <TabsContent value="members">
                  <MembersSection />
                </TabsContent>
                <TabsContent value="perms">
                  <PermsSection />
                </TabsContent>
                <TabsContent value="tunnel">
                  <TunnelSection />
                </TabsContent>
              </>
            )}
          </Tabs>
        )}
      </main>
    </div>
  )
}

/* ---------- 外观（全部角色） ---------- */

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const settings = useClientSettings()

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>主题</CardTitle>
          <CardDescription>白天 / 夜间模式</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {(
            [
              ["light", "sun", "浅色"],
              ["dark", "moon", "深色"],
              ["system", "monitor", "跟随系统"],
            ] as const
          ).map(([value, icon, label]) => (
            <button
              key={value}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border border-border p-3 text-sm transition-all duration-200 ease-out",
                theme === value ? "border-ring bg-accent" : "hover:bg-muted/60"
              )}
              onClick={() => setTheme(value)}
            >
              <Icon name={icon} className="size-5" />
              {label}
            </button>
          ))}
        </CardContent>
      </Card>
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>浏览偏好</CardTitle>
          <CardDescription>视图与排序方式（保存在本机）</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label>默认视图</Label>
            <Select
              value={settings.view}
              onValueChange={(v) => settings.update({ view: v as "list" | "grid" })}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="list">列表</SelectItem>
                <SelectItem value="grid">网格</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label>排序字段</Label>
            <Select
              value={settings.sortBy}
              onValueChange={(v) => settings.update({ sortBy: v as "name" | "size" | "mtime" })}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="name">名称</SelectItem>
                <SelectItem value="size">大小</SelectItem>
                <SelectItem value="mtime">修改时间</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label>排序方向</Label>
            <Select
              value={settings.sortDir}
              onValueChange={(v) => settings.update({ sortDir: v as "asc" | "desc" })}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">升序</SelectItem>
                <SelectItem value="desc">降序</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label>文件夹置顶</Label>
            <Switch
              checked={settings.foldersFirst}
              onCheckedChange={(v) => settings.update({ foldersFirst: !!v })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------- 服务器状态（超级管理员） ---------- */

function StatusSection() {
  const [status, setStatus] = React.useState<ServerStatus | null>(null)

  const load = React.useCallback(() => {
    api.get<ServerStatus>("/admin/status").then(setStatus).catch((e) => toast.error((e as Error).message))
  }, [])

  React.useEffect(() => {
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load])

  if (!status) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  const items: [string, string, React.ReactNode][] = [
    ["timer", "运行时间", formatUptime(status.uptimeSec)],
    ["cpu", "运行环境", `Node ${status.node} · ${status.platform}`],
    ["memory-stick", "内存占用", `进程 ${formatBytes(status.memory.rss)} · 系统可用 ${formatBytes(status.memory.systemFree)}`],
    [
      "database",
      "存储占用",
      `${formatBytes(status.storage.bytes)}${status.storage.partial ? "+" : ""} · ${status.storage.files} 个文件 / ${status.storage.dirs} 个文件夹`,
    ],
    [
      "hard-drive",
      "磁盘空间",
      status.disk ? `可用 ${formatBytes(status.disk.free)} / 共 ${formatBytes(status.disk.total)}` : "不可用",
    ],
    ["server", "存储目录", status.storage.root],
  ]

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([icon, label, value]) => (
          <Card key={label} className="edge-highlight">
            <CardContent className="flex items-start gap-3 pt-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <Icon name={icon} className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-0.5 text-sm font-medium break-all">{value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>访问地址</CardTitle>
          <CardDescription>局域网内的设备可通过以下地址访问</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <AddressRow url={`http://localhost:${status.port}`} label="本机" />
          {status.lan.map((ip) => (
            <AddressRow key={ip} url={`http://${ip}:${status.port}`} label="局域网" />
          ))}
          {status.tunnel.running && status.tunnel.url && (
            <AddressRow url={status.tunnel.url} label="公网" highlight />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AddressRow({ url, label, highlight }: { url: string; label: string; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Badge variant={highlight ? "default" : "secondary"} className="w-14 justify-center">
        {label}
      </Badge>
      <Input readOnly value={url} className="h-8 font-mono text-xs" onFocus={(e) => e.target.select()} />
    </div>
  )
}

/* ---------- 日志（超级管理员） ---------- */

const LEVEL_STYLE: Record<string, string> = {
  info: "",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

function LogsSection() {
  const [logs, setLogs] = React.useState<LogRow[]>([])
  const [level, setLevel] = React.useState("all")
  const [q, setQ] = React.useState("")
  const [confirmClear, setConfirmClear] = React.useState(false)

  const load = React.useCallback(() => {
    api
      .get<{ logs: LogRow[] }>("/admin/logs", { limit: 300, level: level === "all" ? "" : level, q })
      .then((d) => setLogs(d.logs))
      .catch((e) => toast.error((e as Error).message))
  }, [level, q])

  React.useEffect(load, [load])

  return (
    <Card className="edge-highlight">
      <CardHeader>
        <CardTitle>操作日志</CardTitle>
        <CardDescription>登录、文件操作与系统事件（最近 5 天）</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={level} onValueChange={(v) => setLevel(v as string)}>
            <SelectTrigger className="w-28" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部级别</SelectItem>
              <SelectItem value="info">信息</SelectItem>
              <SelectItem value="warn">警告</SelectItem>
              <SelectItem value="error">错误</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="搜索事件 / 用户 / IP…"
            className="h-8 w-52 text-sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <Button size="sm" variant="ghost" onClick={load}>
            <Icon name="refresh-cw" /> 刷新
          </Button>
          <Button size="sm" variant="destructive" className="ml-auto" onClick={() => setConfirmClear(true)}>
            <Icon name="trash-2" /> 清空日志
          </Button>
        </div>
        <ScrollArea className="h-96 rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">时间</TableHead>
                <TableHead className="w-32">事件</TableHead>
                <TableHead className="w-24">用户</TableHead>
                <TableHead className="w-32">IP</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    暂无日志
                  </TableCell>
                </TableRow>
              )}
              {logs.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {row.t.replace("T", " ").slice(0, 19)}
                  </TableCell>
                  <TableCell className={cn("text-xs font-medium", LEVEL_STYLE[row.lvl])}>{row.ev}</TableCell>
                  <TableCell className="text-xs">{row.user || "-"}</TableCell>
                  <TableCell className="font-mono text-xs">{row.ip || "-"}</TableCell>
                  <TableCell className="max-w-md truncate text-xs" title={row.msg}>
                    {row.msg || "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空全部日志？</AlertDialogTitle>
            <AlertDialogDescription>该操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await api.del("/admin/logs")
                  toast.success("日志已清空")
                  load()
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
            >
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/* ---------- 成员管理（超级管理员） ---------- */

function MembersSection() {
  const [members, setMembers] = React.useState<Member[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [showCreate, setShowCreate] = React.useState(false)
  const [batchText, setBatchText] = React.useState("")
  const [createdInfo, setCreatedInfo] = React.useState<string[]>([])
  const [resetTarget, setResetTarget] = React.useState<Member | null>(null)
  const [resetPassword, setResetPassword] = React.useState("")

  const load = React.useCallback(() => {
    api
      .get<{ members: Member[] }>("/admin/members")
      .then((d) => {
        setMembers(d.members)
        setSelected(new Set())
      })
      .catch((e) => toast.error((e as Error).message))
  }, [])

  React.useEffect(load, [load])

  const genPassword = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)

  const createBatch = async () => {
    const lines = batchText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
    if (!lines.length) return
    const users = lines.map((line) => {
      const [username, password] = line.split(/[\s,，]+/)
      return { username: username || "", password: password || genPassword() }
    })
    try {
      const { results } = await api.post<{ results: { username: string; ok: boolean; error?: string }[] }>(
        "/admin/members",
        { users }
      )
      const okList = results
        .filter((r) => r.ok)
        .map((r) => {
          const u = users.find((x) => x.username === r.username)
          return `${r.username}  ${u?.password || ""}`
        })
      const failList = results.filter((r) => !r.ok)
      if (okList.length) {
        setCreatedInfo(okList)
        toast.success(`已创建 ${okList.length} 个成员`)
      }
      for (const f of failList) toast.error(`${f.username || "(空)"}：${f.error}`)
      setBatchText("")
      if (okList.length) setShowCreate(false)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const batch = async (action: "enable" | "disable" | "delete") => {
    if (!selected.size) return
    try {
      await api.post("/admin/members/batch", { action, ids: [...selected] })
      toast.success("操作完成")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const doReset = async () => {
    if (!resetTarget) return
    try {
      await api.post(`/admin/members/${resetTarget.id}/password`, { password: resetPassword })
      toast.success(`已重置 ${resetTarget.username} 的密码`)
      setResetTarget(null)
      setResetPassword("")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const allChecked = members.length > 0 && selected.size === members.length

  return (
    <Card className="edge-highlight">
      <CardHeader>
        <CardTitle>团队成员（低级管理员）</CardTitle>
        <CardDescription>成员可操作文件，无法进入服务器管理。共 {members.length} 人</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Icon name="user-plus" /> 添加成员
          </Button>
          {selected.size > 0 && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <span className="text-xs text-muted-foreground">已选 {selected.size} 人</span>
              <Button size="sm" variant="outline" onClick={() => batch("enable")}>启用</Button>
              <Button size="sm" variant="outline" onClick={() => batch("disable")}>禁用</Button>
              <Button size="sm" variant="destructive" onClick={() => batch("delete")}>删除</Button>
            </>
          )}
        </div>

        {createdInfo.length > 0 && (
          <div className="rounded-md border border-border bg-muted/50 p-3">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium">创建成功，请立即保存以下账号信息（用户名 密码）：</p>
              <Button size="icon-xs" variant="ghost" onClick={() => setCreatedInfo([])}>
                <Icon name="x" />
              </Button>
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap select-all">{createdInfo.join("\n")}</pre>
          </div>
        )}

        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allChecked}
                    onCheckedChange={() =>
                      setSelected(allChecked ? new Set() : new Set(members.map((m) => m.id)))
                    }
                  />
                </TableHead>
                <TableHead>用户名</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-44">创建时间</TableHead>
                <TableHead className="w-28 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    还没有成员，点击“添加成员”创建
                  </TableCell>
                </TableRow>
              )}
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(m.id)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(m.id)) next.delete(m.id)
                          else next.add(m.id)
                          return next
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="font-medium">{m.username}</TableCell>
                  <TableCell>
                    <Badge variant={m.disabled ? "secondary" : "default"}>
                      {m.disabled ? "已禁用" : "正常"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.createdAt.replace("T", " ").slice(0, 19)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="xs" variant="ghost" onClick={() => setResetTarget(m)}>
                      重置密码
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量添加成员</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <Label>每行一个账户：「用户名 密码」，省略密码则自动生成</Label>
            <Textarea
              rows={6}
              placeholder={"alice 123456\nbob\ncarol pass888"}
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              用户名 2-32 位（字母/数字/_.-），密码至少 6 位
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
            <Button onClick={createBatch} disabled={!batchText.trim()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetTarget !== null} onOpenChange={(o) => !o && setResetTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置 {resetTarget?.username} 的密码</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reset-pwd">新密码</Label>
            <div className="flex gap-2">
              <Input
                id="reset-pwd"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="至少 6 位"
              />
              <Button variant="outline" onClick={() => setResetPassword(genPassword())}>
                随机生成
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>取消</Button>
            <Button onClick={doReset} disabled={resetPassword.length < 6}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ---------- 权限（超级管理员） ---------- */

const MEMBER_PERM_LABELS: [keyof AdminConfig["memberPerms"], string][] = [
  ["upload", "上传文件"],
  ["download", "下载文件"],
  ["mkdir", "新建文件夹"],
  ["copy", "复制"],
  ["move", "移动 / 粘贴"],
  ["rename", "重命名"],
  ["delete", "删除"],
  ["manageGuestVisibility", "设置访客可见性"],
]

function PermsSection() {
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [superLimit, setSuperLimit] = React.useState("")
  const [memberLimit, setMemberLimit] = React.useState("")

  const load = React.useCallback(() => {
    api
      .get<AdminConfig>("/admin/config")
      .then((c) => {
        setConfig(c)
        setSuperLimit(String(c.superUploadLimitMB))
        setMemberLimit(String(c.memberUploadLimitMB))
      })
      .catch((e) => toast.error((e as Error).message))
  }, [])

  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg = "已保存") => {
    try {
      const next = await api.patch<AdminConfig>("/admin/config", body)
      setConfig(next)
      setSuperLimit(String(next.superUploadLimitMB))
      setMemberLimit(String(next.memberUploadLimitMB))
      toast.success(msg)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const unhide = async (path: string) => {
    try {
      const next = await api.del<AdminConfig>("/admin/hidden-paths", { path })
      setConfig(next)
      toast.success("已恢复访客可见")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>上传大小限制</CardTitle>
          <CardDescription>单文件上限（MB）</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between gap-3">
            <Label className="shrink-0">超级管理员</Label>
            <div className="flex items-center gap-2">
              <Input
                className="w-28 text-right"
                inputMode="numeric"
                value={superLimit}
                onChange={(e) => setSuperLimit(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">MB</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="shrink-0">团队成员</Label>
            <div className="flex items-center gap-2">
              <Input
                className="w-28 text-right"
                inputMode="numeric"
                value={memberLimit}
                onChange={(e) => setMemberLimit(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">MB</span>
            </div>
          </div>
          <Button
            size="sm"
            className="justify-self-end"
            onClick={() =>
              patch({
                superUploadLimitMB: Number(superLimit),
                memberUploadLimitMB: Number(memberLimit),
              })
            }
          >
            保存限制
          </Button>
        </CardContent>
      </Card>

      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>成员权限</CardTitle>
          <CardDescription>控制团队成员可执行的文件操作</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {MEMBER_PERM_LABELS.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between">
              <Label>{label}</Label>
              <Switch
                checked={config.memberPerms[key]}
                onCheckedChange={(v) => patch({ memberPerms: { [key]: !!v } })}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="edge-highlight md:col-span-2">
        <CardHeader>
          <CardTitle>访客权限</CardTitle>
          <CardDescription>访客无需登录，仅能浏览与下载可见内容</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between">
            <Label>允许访客下载文件</Label>
            <Switch
              checked={config.guestPerms.download}
              onCheckedChange={(v) => patch({ guestPerms: { download: !!v } })}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>允许访客打包下载（Zip）</Label>
            <Switch
              checked={config.guestPerms.zip}
              onCheckedChange={(v) => patch({ guestPerms: { zip: !!v } })}
            />
          </div>
          <Separator />
          <div>
            <p className="mb-2 text-sm font-medium">对访客隐藏的文件夹</p>
            {config.guestHiddenPaths.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                暂无。可在文件列表中右键文件夹 → “对访客隐藏”
              </p>
            ) : (
              <div className="grid gap-1.5">
                {config.guestHiddenPaths.map((p) => (
                  <div
                    key={p}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-1.5"
                  >
                    <span className="flex items-center gap-2 font-mono text-xs">
                      <Icon name="eye-off" className="size-3.5 text-muted-foreground" /> /{p}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => unhide(p)}>
                      恢复可见
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------- 公网访问（超级管理员） ---------- */

function TunnelSection() {
  const [config, setConfig] = React.useState<{ enabled: boolean; mode: "serveo" | "custom"; customHost: string } | null>(null)
  const [status, setStatus] = React.useState<TunnelStatus | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(() => {
    api
      .get<{ config: { enabled: boolean; mode: "serveo" | "custom"; customHost: string }; status: TunnelStatus }>(
        "/admin/tunnel"
      )
      .then((d) => {
        setConfig((prev) => prev ?? d.config)
        setStatus(d.status)
      })
      .catch((e) => toast.error((e as Error).message))
  }, [])

  React.useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const apply = async (next: { enabled: boolean; mode: "serveo" | "custom"; customHost: string }) => {
    setBusy(true)
    try {
      const d = await api.post<{ config: typeof next; status: TunnelStatus }>("/admin/tunnel", next)
      setConfig(d.config)
      setStatus(d.status)
      toast.success(next.enabled ? "公网访问已开启" : "公网访问已关闭")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>SSH 反向隧道</CardTitle>
          <CardDescription>
            通过 ssh -R 80:localhost:5170 将本服务暴露到公网（默认关闭）
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>启用公网访问</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">开启后局域网访问不受影响</p>
            </div>
            <Switch
              checked={config.enabled}
              disabled={busy}
              onCheckedChange={(v) => apply({ ...config, enabled: !!v })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label>隧道服务</Label>
            <Select
              value={config.mode}
              onValueChange={(v) => setConfig({ ...config, mode: v as "serveo" | "custom" })}
            >
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="serveo">serveo.net（免费）</SelectItem>
                <SelectItem value="custom">自定义 SSH 服务器</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.mode === "custom" && (
            <div className="grid gap-2">
              <Label htmlFor="custom-host">SSH 目标（user@host 或 user@host:端口）</Label>
              <Input
                id="custom-host"
                placeholder="user@example.com:22"
                value={config.customHost}
                onChange={(e) => setConfig({ ...config, customHost: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                需要本机已配置免密 SSH 密钥（不支持交互输密码）
              </p>
            </div>
          )}
          {config.enabled && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => apply(config)}>
              <Icon name="rotate-cw" /> 应用并重连
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            运行状态
            <Badge variant={status?.running ? "default" : "secondary"}>
              {status?.running ? "运行中" : "未运行"}
            </Badge>
          </CardTitle>
          <CardDescription>
            {status?.restarts ? `已自动重连 ${status.restarts} 次` : "隧道进程输出"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {status?.url && (
            <div className="grid gap-1.5">
              <Label>公网地址（点击全选复制）</Label>
              <Input
                readOnly
                value={status.url}
                className="h-8 font-mono text-xs"
                onFocus={(e) => e.target.select()}
              />
            </div>
          )}
          <ScrollArea className="h-48 rounded-md border border-border bg-muted/30 p-2">
            <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {status?.output?.length ? status.output.join("\n") : "（暂无输出）"}
            </pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
