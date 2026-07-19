import * as React from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
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
    <AppShell>
      <div className="flex flex-1 flex-col overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">设置</h1>
          <p className="mb-6 text-sm text-muted-foreground">{isSuper ? "管理外观、服务器、成员与权限" : "个性化浏览体验"}</p>
          {ready && (
            <Tabs defaultValue="appearance">
              <TabsList variant="line" className="mb-6 flex-wrap">
                <TabsTrigger value="appearance"><Icon name="palette" /> 外观</TabsTrigger>
                {isSuper && (
                  <>
                    <TabsTrigger value="status"><Icon name="activity" /> 状态</TabsTrigger>
                    <TabsTrigger value="logs"><Icon name="scroll-text" /> 日志</TabsTrigger>
                    <TabsTrigger value="members"><Icon name="users" /> 成员</TabsTrigger>
                    <TabsTrigger value="perms"><Icon name="shield-check" /> 权限</TabsTrigger>
                    <TabsTrigger value="tunnel"><Icon name="globe" /> 公网</TabsTrigger>
                  </>
                )}
              </TabsList>
              <TabsContent value="appearance"><AppearanceSection /></TabsContent>
              {isSuper && (
                <>
                  <TabsContent value="status"><StatusSection /></TabsContent>
                  <TabsContent value="logs"><LogsSection /></TabsContent>
                  <TabsContent value="members"><MembersSection /></TabsContent>
                  <TabsContent value="perms"><PermsSection /></TabsContent>
                  <TabsContent value="tunnel"><TunnelSection /></TabsContent>
                </>
              )}
            </Tabs>
          )}
        </div>
      </div>
      <div className="border-t border-border/30 px-3 py-2">
        <div className="text-center text-[11px] text-muted-foreground">Copyright © Wangyq 2026</div>
      </div>
    </AppShell>
  )
}

/* ==================== 外观 ==================== */
function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const settings = useClientSettings()

  const themes = [
    ["light", "sun", "浅色"],
    ["dark", "moon", "深色"],
    ["system", "monitor", "跟随系统"],
  ] as const

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* 主题：不用卡，用按钮组 */}
      <div>
        <h3 className="mb-3 text-sm font-medium">主题</h3>
        <div className="edge-highlight flex gap-2 rounded-xl border border-border p-1">
          {themes.map(([value, icon, label]) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-all duration-200",
                theme === value ? "bg-accent font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon name={icon} className="size-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* 浏览偏好：行内布局 */}
      <div>
        <h3 className="mb-3 text-sm font-medium">浏览偏好</h3>
        <div className="edge-highlight rounded-xl border border-border p-3">
          <div className="grid gap-3">
            <Row label="默认视图">
              <Select value={settings.view} onValueChange={(v) => settings.update({ view: v as "list" | "grid" })}>
                <SelectTrigger className="w-28"><SelectValue render={(_p, s) => <>{s.value}</>}>列表</SelectValue></SelectTrigger>
                <SelectContent><SelectItem value="list">列表</SelectItem><SelectItem value="grid">网格</SelectItem></SelectContent>
              </Select>
            </Row>
            <Row label="排序字段">
              <Select value={settings.sortBy} onValueChange={(v) => settings.update({ sortBy: v as "name" | "size" | "mtime" })}>
                <SelectTrigger className="w-28"><SelectValue render={(_p, s) => <>{s.value}</>}>名称</SelectValue></SelectTrigger>
                <SelectContent><SelectItem value="name">名称</SelectItem><SelectItem value="size">大小</SelectItem><SelectItem value="mtime">修改时间</SelectItem></SelectContent>
              </Select>
            </Row>
            <Row label="排序方向">
              <Select value={settings.sortDir} onValueChange={(v) => settings.update({ sortDir: v as "asc" | "desc" })}>
                <SelectTrigger className="w-28"><SelectValue render={(_p, s) => <>{s.value}</>}>升序</SelectValue></SelectTrigger>
                <SelectContent><SelectItem value="asc">升序</SelectItem><SelectItem value="desc">降序</SelectItem></SelectContent>
              </Select>
            </Row>
            <Row label="文件夹置顶">
              <Switch checked={settings.foldersFirst} onCheckedChange={(v) => settings.update({ foldersFirst: !!v })} />
            </Row>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/* ==================== 状态 ==================== */
function StatusSection() {
  const [status, setStatus] = React.useState<ServerStatus | null>(null)
  const load = React.useCallback(() => { api.get<ServerStatus>("/admin/status").then(setStatus).catch((e) => toast.error((e as Error).message)) }, [])
  React.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [load])
  if (!status) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-5">
      {/* 关键指标：横向条形网格 */}
      <div className="edge-highlight grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
        {[
          ["timer", "运行", formatUptime(status.uptimeSec)],
          ["hard-drive", "存储", formatBytes(status.storage.bytes)],
          ["memory-stick", "内存", formatBytes(status.memory.rss)],
          ["cpu", "Node", status.node],
          ["database", "文件数", `${status.storage.files} 文件 / ${status.storage.dirs} 文件夹`],
          ["hard-drive", "磁盘", status.disk ? `可用 ${formatBytes(status.disk.free)}` : "不可用"],
        ].map(([icon, label, value]) => (
          <div key={label} className="flex items-center gap-3 bg-card p-3">
            <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
              <p className="text-sm font-medium">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 访问地址：简洁列表 */}
      <div className="edge-highlight rounded-xl border border-border p-3">
        <h3 className="mb-2 text-sm font-medium">局域网访问</h3>
        <div className="grid gap-1.5">
          {[`http://localhost:${status.port}`, ...status.lan.map((ip) => `http://${ip}:${status.port}`)].map((url) => (
            <div key={url} className="flex items-center gap-2">
              <Badge variant="secondary" className="w-12 shrink-0 justify-center text-[10px]">{url.includes("localhost") ? "本机" : "局域网"}</Badge>
              <Input readOnly value={url} className="h-7 font-mono text-xs" onFocus={(e) => e.target.select()} />
            </div>
          ))}
          {status.tunnel.running && status.tunnel.url && (
            <div className="flex items-center gap-2">
              <Badge className="w-12 shrink-0 justify-center text-[10px]">公网</Badge>
              <Input readOnly value={status.tunnel.url} className="h-7 font-mono text-xs border-ring" onFocus={(e) => e.target.select()} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ==================== 日志 ==================== */
function LogsSection() {
  const [logs, setLogs] = React.useState<LogRow[]>([])
  const [level, setLevel] = React.useState("all")
  const [q, setQ] = React.useState("")
  const [confirmClear, setConfirmClear] = React.useState(false)

  const load = React.useCallback(() => {
    api.get<{ logs: LogRow[] }>("/admin/logs", { limit: 300, level: level === "all" ? "" : level, q })
      .then((d) => setLogs(d.logs)).catch((e) => toast.error((e as Error).message))
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
          <Select value={level} onValueChange={(v) => setLevel(v || "all")}>
            <SelectTrigger className="w-28" size="sm"><SelectValue render={(_p, s) => <>{s.value}</>}>全部</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部级别</SelectItem>
              <SelectItem value="info">信息</SelectItem>
              <SelectItem value="warn">警告</SelectItem>
              <SelectItem value="error">错误</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="搜索事件/用户/IP…" className="h-8 w-52 text-sm" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
          <Button size="sm" variant="ghost" onClick={load}><Icon name="refresh-cw" /> 刷新</Button>
          <Button size="sm" variant="destructive" onClick={() => setConfirmClear(true)}><Icon name="trash-2" /> 清空</Button>
        </div>
        <ScrollArea className="h-96 rounded-md border border-border">
          <Table>
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
                  <TableCell className={cn("text-xs font-medium", row.lvl === "error" ? "text-destructive" : row.lvl === "warn" ? "text-amber-600 dark:text-amber-400" : "")}>{row.ev}</TableCell>
                  <TableCell className="text-xs">{row.user || "-"}</TableCell>
                  <TableCell className="font-mono text-xs">{row.ip || "-"}</TableCell>
                  <TableCell className="max-w-md truncate text-xs" title={row.msg}>{row.msg || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>清空全部日志？</AlertDialogTitle><AlertDialogDescription>该操作不可撤销。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { try { await api.del("/admin/logs"); toast.success("日志已清空"); load(); setConfirmClear(false) } catch (e) { toast.error((e as Error).message) } }}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/* ==================== 成员 ==================== */
function MembersSection() {
  const [members, setMembers] = React.useState<Member[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [showCreate, setShowCreate] = React.useState(false)
  const [batchText, setBatchText] = React.useState("")
  const [createdInfo, setCreatedInfo] = React.useState<string[]>([])
  const [resetTarget, setResetTarget] = React.useState<Member | null>(null)
  const [resetPassword, setResetPassword] = React.useState("")
  const [renameTarget, setRenameTarget] = React.useState<Member | null>(null)
  const [newUsername, setNewUsername] = React.useState("")
  const [resetBatch, setResetBatch] = React.useState(false)
  const [batchNewPassword, setBatchNewPassword] = React.useState("")
  const [confirmDelete, setConfirmDelete] = React.useState<{ singleId?: string } | null>(null)

  const load = React.useCallback(() => {
    api.get<{ members: Member[] }>("/admin/members").then((d) => { setMembers(d.members); setSelected(new Set()) }).catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(load, [load])

  const genPassword = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)

  const createBatch = async () => {
    const lines = batchText.split("\n").map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    const users = lines.map((line) => { const [u, p] = line.split(/[\s,，]+/); return { username: u || "", password: p || genPassword() } })
    try {
      const { results } = await api.post<{ results: { username: string; ok: boolean; error?: string }[] }>("/admin/members", { users })
      const okList = results.filter((r) => r.ok).map((r) => { const u = users.find((x) => x.username === r.username); return `${r.username}  ${u?.password || ""}` })
      const failList = results.filter((r) => !r.ok)
      if (okList.length) { setCreatedInfo(okList); toast.success(`已创建 ${okList.length} 个成员`) }
      for (const f of failList) toast.error(`${f.username || "(空)"}：${f.error}`)
      setBatchText(""); setShowCreate(false); load()
    } catch (e) { toast.error((e as Error).message) }
  }

  const batch = async (action: "enable" | "disable" | "delete", singleId?: string) => {
    const ids = singleId ? [singleId] : [...selected]
    if (!ids.length) return
    try { await api.post("/admin/members/batch", { action, ids }); toast.success("操作完成"); load() }
    catch (e) { toast.error((e as Error).message) }
  }

  const doReset = async () => {
    if (!resetTarget) return
    try { await api.post(`/admin/members/${resetTarget.id}/password`, { password: resetPassword }); toast.success(`已重置 ${resetTarget.username} 的密码`); setResetTarget(null); setResetPassword("") }
    catch (e) { toast.error((e as Error).message) }
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
          <Button size="sm" onClick={() => setShowCreate(true)}><Icon name="user-plus" /> 添加成员</Button>
          {selected.size > 0 && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <span className="text-xs text-muted-foreground">已选 {selected.size}</span>
              <Button size="sm" variant="outline" onClick={() => batch("enable")}>启用</Button>
              <Button size="sm" variant="outline" onClick={() => batch("disable")}>禁用</Button>
              <Button size="sm" variant="outline" onClick={() => setResetBatch(true)}>批量重置密码</Button>
              <Button size="sm" variant="destructive" onClick={() => setConfirmDelete({})}>删除</Button>
            </>
          )}
        </div>

        {createdInfo.length > 0 && (
          <div className="rounded-md border border-border bg-muted/50 p-3">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium">创建成功，请保存账号信息（用户名 密码）：</p>
              <Button size="icon-xs" variant="ghost" onClick={() => setCreatedInfo([])}><Icon name="x" /></Button>
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap select-all">{createdInfo.join("\n")}</pre>
          </div>
        )}

        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allChecked} onCheckedChange={() => setSelected(allChecked ? new Set() : new Set(members.map((m) => m.id)))} />
                </TableHead>
                <TableHead>用户名</TableHead>
                <TableHead className="w-20">状态</TableHead>
                <TableHead className="w-40">创建时间</TableHead>
                <TableHead className="w-12 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">还没有成员，点击"添加成员"创建</TableCell></TableRow>}
              {members.map((m) => (
                <ContextMenu key={m.id}>
                  <ContextMenuTrigger render={
                    <TableRow key={m.id}>
                      <TableCell>
                        <Checkbox checked={selected.has(m.id)} onCheckedChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next })} />
                      </TableCell>
                      <TableCell className="font-medium">{m.username}</TableCell>
                      <TableCell><Badge variant={m.disabled ? "secondary" : "default"}>{m.disabled ? "已禁用" : "正常"}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.createdAt.replace("T", " ").slice(0, 19)}</TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" />}><Icon name="ellipsis-vertical" className="size-3.5" /></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {m.disabled ? <DropdownMenuItem onClick={() => batch("enable", m.id)}><Icon name="check-circle" /> 启用</DropdownMenuItem>
                            : <DropdownMenuItem onClick={() => batch("disable", m.id)}><Icon name="circle-slash" /> 禁用</DropdownMenuItem>}
                            <DropdownMenuItem onClick={() => { setRenameTarget(m); setNewUsername(m.username) }}><Icon name="pencil-line" /> 更改用户名</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setResetTarget(m)}><Icon name="key" /> 重置密码</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete({ singleId: m.id })}><Icon name="trash-2" /> 删除</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  } />
                  <ContextMenuContent className="w-44">
                    {m.disabled ? <ContextMenuItem onClick={() => batch("enable", m.id)}><Icon name="check-circle" /> 启用</ContextMenuItem>
                    : <ContextMenuItem onClick={() => batch("disable", m.id)}><Icon name="circle-slash" /> 禁用</ContextMenuItem>}
                    <ContextMenuItem onClick={() => { setRenameTarget(m); setNewUsername(m.username) }}><Icon name="pencil-line" /> 更改用户名</ContextMenuItem>
                    <ContextMenuItem onClick={() => setResetTarget(m)}><Icon name="key" /> 重置密码</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onClick={() => setConfirmDelete({ singleId: m.id })}><Icon name="trash-2" /> 删除</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {/* Dialogs */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>批量添加成员</DialogTitle></DialogHeader>
          <div className="grid gap-2 text-sm">
            <Label>每行一个账户：「用户名 密码」，省略密码则自动生成</Label>
            <Textarea rows={6} placeholder="alice 123456\nbob\ncarol pass888" value={batchText} onChange={(e) => setBatchText(e.target.value)} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground">用户名 2-32 位（字母/数字/_.-），密码至少 6 位</p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button><Button onClick={createBatch} disabled={!batchText.trim()}>创建</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetTarget !== null || resetBatch} onOpenChange={(o) => { if (!o) { setResetTarget(null); setResetBatch(false) } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{resetBatch ? `批量重置 ${selected.size} 个密码` : `重置 ${resetTarget?.username} 的密码`}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reset-pwd">新密码</Label>
            <div className="flex gap-2">
              <Input id="reset-pwd" value={resetBatch ? batchNewPassword : resetPassword} onChange={(e) => resetBatch ? setBatchNewPassword(e.target.value) : setResetPassword(e.target.value)} placeholder="至少 6 位" />
              <Button variant="outline" onClick={() => { const p = genPassword(); resetBatch ? setBatchNewPassword(p) : setResetPassword(p) }}>随机生成</Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetTarget(null); setResetBatch(false) }}>取消</Button>
            <Button onClick={resetBatch ? async () => { if (batchNewPassword.length < 6) return; for (const id of selected) await api.post(`/admin/members/${id}/password`, { password: batchNewPassword }); toast.success(`已重置 ${selected.size} 个密码`); setResetBatch(false); setBatchNewPassword(""); load() } : doReset} disabled={resetBatch ? batchNewPassword.length < 6 : resetPassword.length < 6}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>更改 {renameTarget?.username} 的用户名</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="rename-user">新用户名</Label>
            <Input id="rename-user" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="2-32 位字母、数字、_ . -" />
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRenameTarget(null)}>取消</Button><Button onClick={async () => { if (!renameTarget || !newUsername.trim()) return; try { await api.patch(`/admin/members/${renameTarget.id}`, { username: newUsername.trim() }); toast.success("用户名已更改"); setRenameTarget(null); load() } catch (e) { toast.error((e as Error).message) } }} disabled={!newUsername.trim()}>确定</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => { if (!o) setConfirmDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认删除</AlertDialogTitle><AlertDialogDescription>{confirmDelete?.singleId ? "将永久删除该成员，不可撤销。" : `将永久删除选中的 ${selected.size} 个成员，不可撤销。`}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={(e) => { e.preventDefault(); batch("delete", confirmDelete?.singleId); setConfirmDelete(null) }}>删除</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/* ==================== 权限 ==================== */
const MEMBER_PERM_LABELS: [keyof AdminConfig["memberPerms"], string][] = [
  ["upload", "上传文件"], ["uploadFolders", "上传文件夹"], ["download", "下载文件"], ["mkdir", "新建文件夹"],
  ["copy", "复制文件"], ["move", "移动文件"], ["rename", "重命名"], ["delete", "删除"],
  ["manageGuestVisibility", "设置访客可见性"], ["htmlPreview", "HTML 全屏预览"], ["editFiles", "在线编辑文件"],
  ["compressZip", "压缩为 Zip"], ["extractZip", "解压 Zip"],
]

function PermsSection() {
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [superLimit, setSuperLimit] = React.useState("")
  const [memberLimit, setMemberLimit] = React.useState("")

  const load = React.useCallback(() => {
    api.get<AdminConfig>("/admin/config").then((c) => { setConfig(c); setSuperLimit(String(c.superUploadLimitMB ?? 2048)); setMemberLimit(String(c.memberUploadLimitMB ?? 512)) }).catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg = "已保存") => {
    try { const next = await api.patch<AdminConfig>("/admin/config", body); setConfig(next); setSuperLimit(String(next.superUploadLimitMB ?? 2048)); setMemberLimit(String(next.memberUploadLimitMB ?? 512)); toast.success(msg) }
    catch (e) { toast.error((e as Error).message) }
  }

  const unhide = async (p: string) => {
    try { const next = await api.del<AdminConfig>("/admin/hidden-paths", { path: p }); setConfig(next); toast.success("已恢复访客可见") }
    catch (e) { toast.error((e as Error).message) }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-5">
      {/* 上传限制：横向三行 */}
      <div className="edge-highlight rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-medium">上传大小限制（单文件 MB）</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3">
            <span className="w-28 text-sm text-muted-foreground">超级管理员</span>
            <Input className="w-24 text-right" inputMode="numeric" value={superLimit} onChange={(e) => setSuperLimit(e.target.value)} />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-28 text-sm text-muted-foreground">团队成员</span>
            <Input className="w-24 text-right" inputMode="numeric" value={memberLimit} onChange={(e) => setMemberLimit(e.target.value)} />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
        </div>
        <Button size="sm" className="mt-3" onClick={() => patch({ superUploadLimitMB: Number(superLimit), memberUploadLimitMB: Number(memberLimit) }, "限制已更新")}>保存</Button>
      </div>

      {/* 成员权限：网格开关 */}
      <div className="edge-highlight rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-medium">团队成员权限</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {MEMBER_PERM_LABELS.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
              <span className="text-sm">{label}</span>
              <Switch checked={config.memberPerms[key]} onCheckedChange={(v) => patch({ memberPerms: { [key]: !!v } })} />
            </div>
          ))}
        </div>
      </div>

      {/* 访客权限 + 隐藏文件夹 */}
      <div className="edge-highlight rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-medium">访客权限</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
            <span className="text-sm">允许下载文件</span>
            <Switch checked={config.guestPerms.download} onCheckedChange={(v) => patch({ guestPerms: { download: !!v } })} />
          </div>
          <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
            <span className="text-sm">允许打包下载（Zip）</span>
            <Switch checked={config.guestPerms.zip} onCheckedChange={(v) => patch({ guestPerms: { zip: !!v } })} />
          </div>
          <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
            <span className="text-sm">HTML 全屏预览</span>
            <Switch checked={config.guestPerms.htmlPreview} onCheckedChange={(v) => patch({ guestPerms: { htmlPreview: !!v } })} />
          </div>
          <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
            <span className="text-sm">在线编辑文件</span>
            <Switch checked={config.guestPerms.editFiles} onCheckedChange={(v) => patch({ guestPerms: { editFiles: !!v } })} />
          </div>
          <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
            <span className="text-sm">压缩为 Zip</span>
            <Switch checked={config.guestPerms.compressZip} onCheckedChange={(v) => patch({ guestPerms: { compressZip: !!v } })} />
          </div>
          <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/50">
            <span className="text-sm">解压 Zip</span>
            <Switch checked={config.guestPerms.extractZip} onCheckedChange={(v) => patch({ guestPerms: { extractZip: !!v } })} />
          </div>
        </div>
        <Separator className="my-3" />
        <div>
          <p className="mb-2 text-sm font-medium">对访客隐藏的文件夹</p>
          {config.guestHiddenPaths.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无。可在文件列表右键文件夹 → "对访客隐藏"</p>
          ) : (
            <div className="grid gap-1.5">
              {config.guestHiddenPaths.map((p) => (
                <div key={p} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                  <span className="flex items-center gap-2 font-mono text-xs"><Icon name="eye-off" className="size-3.5 text-muted-foreground" /> /{p}</span>
                  <Button size="xs" variant="ghost" onClick={() => unhide(p)}>恢复可见</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ==================== 公网 ==================== */
function TunnelSection() {
  const [config, setConfig] = React.useState<{ enabled: boolean; mode: string; customHost: string } | null>(null)
  const [status, setStatus] = React.useState<TunnelStatus | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(() => {
    api.get<{ config: { enabled: boolean; mode: string; customHost: string }; status: TunnelStatus }>("/admin/tunnel")
      .then((d) => { setConfig((prev) => prev ?? d.config); setStatus(d.status) }).catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const apply = async (next: { enabled: boolean; mode: string; customHost: string }) => {
    setBusy(true)
    try { const d = await api.post<{ config: typeof next; status: TunnelStatus }>("/admin/tunnel", next); setConfig(d.config); setStatus(d.status); toast.success(next.enabled ? "已开启" : "已关闭") }
    catch (e) { toast.error((e as Error).message) }
    finally { setBusy(false) }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* 配置区：行内 */}
      <div className="edge-highlight rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-medium">SSH 反向隧道</h3>
        <p className="mb-4 text-xs text-muted-foreground">通过 ssh -R 将本服务暴露到公网</p>
        <div className="grid gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">启用公网访问</span>
            <Switch checked={config.enabled} disabled={busy} onCheckedChange={(v) => apply({ ...config, enabled: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">隧道服务</span>
            <Select value={config.mode} onValueChange={(v) => v && setConfig({ ...config, mode: v })}>
              <SelectTrigger className="w-40"><SelectValue render={(_p, s) => <>{s.value}</>}>pinggy.io</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="pinggy">pinggy.io（推荐）</SelectItem>
                <SelectItem value="localhostrun">localhost.run</SelectItem>
                <SelectItem value="serveo">serveo.net</SelectItem>
                <SelectItem value="custom">自定义 SSH</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.mode === "custom" && (
            <div className="grid gap-2">
              <Label htmlFor="custom-host">SSH 目标（user@host 或 user@host:端口）</Label>
              <Input id="custom-host" placeholder="user@example.com:22" value={config.customHost} onChange={(e) => setConfig({ ...config, customHost: e.target.value })} />
              <p className="text-xs text-muted-foreground">需要本机已配置免密 SSH 密钥</p>
            </div>
          )}
          {config.enabled && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => apply(config)}><Icon name="rotate-cw" /> 应用并重连</Button>
          )}
        </div>
      </div>

      {/* 状态区：输出 */}
      <div className="edge-highlight rounded-xl border border-border p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          运行状态
          <Badge variant={status?.running ? "default" : "secondary"}>{status?.running ? "运行中" : "未运行"}</Badge>
        </h3>
        {status?.url && (
          <div className="mb-3"><Label>公网地址</Label><Input readOnly value={status.url} className="mt-1 h-7 font-mono text-xs" onFocus={(e) => e.target.select()} /></div>
        )}
        <p className="mb-2 text-xs text-muted-foreground">{status?.restarts ? `已自动重连 ${status.restarts} 次` : "隧道日志"}</p>
        <ScrollArea className="h-56 rounded-md border border-border bg-muted/30 p-2">
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{status?.output?.length ? status.output.join("\n") : "（暂无输出）"}</pre>
        </ScrollArea>
      </div>
    </div>
  )
}
