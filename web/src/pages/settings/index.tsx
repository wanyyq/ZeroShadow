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
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Icon } from "@/components/icon"
import { Avatar } from "@/components/avatar"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/state/auth"
import { useClientSettings } from "@/state/client-settings"
import { api, uploadAvatar, deleteAvatar } from "@/lib/api"
import { ownerForUser, primeAvatar, forgetAvatar } from "@/lib/avatar-cache"
import { fileToAvatarWebp } from "@/lib/avatar-image"
import { formatBytes, formatUptime } from "@/lib/format"
import type { AdminConfig, Member, ServerStatus, TunnelStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { GroupsSection } from "@/pages/settings/groups-section"
import { DataSection } from "@/pages/settings/data-section"
import { LogsMetricsSection } from "@/pages/settings/logs-metrics-section"

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
                    <TabsTrigger value="logs"><Icon name="scroll-text" /> 日志与指标</TabsTrigger>
                    <TabsTrigger value="members"><Icon name="users" /> 成员</TabsTrigger>
                    <TabsTrigger value="groups"><Icon name="layers" /> 小组</TabsTrigger>
                    <TabsTrigger value="perms"><Icon name="shield-check" /> 权限</TabsTrigger>
                    <TabsTrigger value="data"><Icon name="database" /> 数据与保留</TabsTrigger>
                    <TabsTrigger value="security"><Icon name="lock" /> 安全</TabsTrigger>
                    <TabsTrigger value="tunnel"><Icon name="globe" /> 公网</TabsTrigger>
                  </>
                )}
              </TabsList>
              <TabsContent value="appearance"><AppearanceSection /></TabsContent>
              {isSuper && (
                <>
                  <TabsContent value="status"><StatusSection /></TabsContent>
                  <TabsContent value="logs"><LogsMetricsSection /></TabsContent>
                  <TabsContent value="members"><MembersSection /></TabsContent>
                  <TabsContent value="groups"><GroupsSection /></TabsContent>
                  <TabsContent value="perms"><PermsSection /></TabsContent>
                  <TabsContent value="data"><DataSection /></TabsContent>
                  <TabsContent value="security"><SecuritySection /></TabsContent>
                  <TabsContent value="tunnel"><TunnelSection /></TabsContent>
                </>
              )}
            </Tabs>
          )}
        </div>
      </div>
      <div className="border-t border-border/30 px-3 py-2">
        <div className="text-center text-[11px] text-muted-foreground">管理外观、服务器、成员与权限</div>
      </div>
    </AppShell>
  )
}

/* ==================== 外观 ==================== */

/** 设置行：左侧文字 + 右侧控件，说明另起一行 —— 比把控件挤进 label 里更好读 */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FieldLabel className="flex-auto">{label}</FieldLabel>
        {children}
      </div>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const settings = useClientSettings()

  const themeOptions = [
    ["light", "sun", "浅色"],
    ["dark", "moon", "深色"],
    ["system", "monitor", "跟随系统"],
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>外观</CardTitle>
              <CardDescription>只作用于这台设备的浏览器（保存在 localStorage）</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => { settings.reset(); toast.success("已恢复默认外观") }}>
              <Icon name="rotate-ccw" data-icon="inline-start" /> 恢复默认
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-6">
            <FieldSet>
              <FieldLegend variant="label">主题</FieldLegend>
              <ToggleGroup
                value={[theme]}
                onValueChange={(v) => {
                  const next = v[v.length - 1] as "light" | "dark" | "system" | undefined
                  if (next) setTheme(next)
                }}
              >
                {themeOptions.map(([value, icon, label]) => (
                  <ToggleGroupItem key={value} value={value}>
                    <Icon name={icon} data-icon="inline-start" /> {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription className="mt-2">任意页面按 `D` 键也能循环切换主题。</FieldDescription>
            </FieldSet>

            <Separator />

            <FieldSet>
              <FieldLegend variant="label">界面</FieldLegend>
              <div className="flex flex-col divide-y divide-border/60 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
                <SettingRow label="界面密度" hint="紧凑会收紧列表行高与卡片内边距，一屏能放下更多条目。">
                  <ToggleGroup
                    value={[settings.density]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "comfortable" | "compact" | undefined
                      if (next) settings.update({ density: next })
                    }}
                  >
                    <ToggleGroupItem value="comfortable">舒适</ToggleGroupItem>
                    <ToggleGroupItem value="compact">紧凑</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label="字号" hint="整体缩放界面文字（Tailwind 的尺寸都是 rem，改根字号即可）。">
                  <ToggleGroup
                    value={[settings.fontScale]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "sm" | "base" | "lg" | undefined
                      if (next) settings.update({ fontScale: next })
                    }}
                  >
                    <ToggleGroupItem value="sm">小</ToggleGroupItem>
                    <ToggleGroupItem value="base">标准</ToggleGroupItem>
                    <ToggleGroupItem value="lg">大</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label="默认折叠侧边栏" hint="仅影响桌面端；窄屏抽屉不受影响。">
                  <Switch
                    checked={settings.sidebarCollapsed}
                    onCheckedChange={(v) => settings.update({ sidebarCollapsed: !!v })}
                  />
                </SettingRow>

                <SettingRow label="背景噪点" hint="页面底层的细微噪点纹理，关掉后背景更纯净。">
                  <Switch checked={settings.noise} onCheckedChange={(v) => settings.update({ noise: !!v })} />
                </SettingRow>

                <SettingRow label="减少动画" hint="关闭页面与列表的入场动画、以及界面过渡效果。">
                  <Switch
                    checked={settings.reduceMotion}
                    onCheckedChange={(v) => settings.update({ reduceMotion: !!v })}
                  />
                </SettingRow>
              </div>
            </FieldSet>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>文件浏览默认值</CardTitle>
          <CardDescription>打开文件页时使用的初始视图与排序（页面上随时可改，改完同样会记在这里）</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-6">
            <FieldSet>
              <FieldLegend variant="label">视图</FieldLegend>
              <ToggleGroup
                value={[settings.view]}
                onValueChange={(v) => {
                  const next = v[v.length - 1] as "list" | "grid" | undefined
                  if (next) settings.update({ view: next })
                }}
              >
                <ToggleGroupItem value="list">
                  <Icon name="list" data-icon="inline-start" /> 列表
                </ToggleGroupItem>
                <ToggleGroupItem value="grid">
                  <Icon name="layout-grid" data-icon="inline-start" /> 网格
                </ToggleGroupItem>
              </ToggleGroup>
            </FieldSet>

            <Separator />

            <FieldSet>
              <FieldLegend variant="label">排序</FieldLegend>
              <div className="flex flex-col divide-y divide-border/60 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
                <SettingRow label="排序字段">
                  <ToggleGroup
                    value={[settings.sortBy]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "name" | "size" | "mtime" | undefined
                      if (next) settings.update({ sortBy: next })
                    }}
                  >
                    <ToggleGroupItem value="name">名称</ToggleGroupItem>
                    <ToggleGroupItem value="size">大小</ToggleGroupItem>
                    <ToggleGroupItem value="mtime">修改时间</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label="排序方向">
                  <ToggleGroup
                    value={[settings.sortDir]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "asc" | "desc" | undefined
                      if (next) settings.update({ sortDir: next })
                    }}
                  >
                    <ToggleGroupItem value="asc">升序</ToggleGroupItem>
                    <ToggleGroupItem value="desc">降序</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label="文件夹置顶" hint="排序时始终把文件夹排在文件前面。">
                  <Switch checked={settings.foldersFirst} onCheckedChange={(v) => settings.update({ foldersFirst: !!v })} />
                </SettingRow>
              </div>
            </FieldSet>
          </FieldGroup>
        </CardContent>
      </Card>
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
              <p className="truncate text-sm font-medium" title={value}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 访问地址：简洁列表 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-3">
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
  const avatarFileRef = React.useRef<HTMLInputElement>(null)
  const [avatarTarget, setAvatarTarget] = React.useState<Member | null>(null)

  const load = React.useCallback(() => {
    api.get<{ members: Member[] }>("/admin/members").then((d) => { setMembers(d.members); setSelected(new Set()) }).catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(load, [load])

  const pickAvatar = (m: Member) => {
    setAvatarTarget(m)
    avatarFileRef.current?.click()
  }

  const onAvatarFile = async (file: File | undefined) => {
    if (!file || !avatarTarget) return
    const target = avatarTarget
    try {
      const blob = await fileToAvatarWebp(file)
      const meta = await uploadAvatar(ownerForUser(target.id), blob)
      await primeAvatar(meta.owner, meta.md5, blob)
      toast.success(`已更新 ${target.username} 的头像`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAvatarTarget(null)
      if (avatarFileRef.current) avatarFileRef.current.value = ""
    }
  }

  const removeAvatar = async (m: Member) => {
    try {
      await deleteAvatar(ownerForUser(m.id))
      await forgetAvatar(ownerForUser(m.id))
      toast.success("已恢复默认头像")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

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
                <TableHead className="w-14">头像</TableHead>
                <TableHead>用户名</TableHead>
                <TableHead className="w-20">状态</TableHead>
                <TableHead className="w-40">创建时间</TableHead>
                <TableHead className="w-12 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">还没有成员，点击"添加成员"创建</TableCell></TableRow>}
              {members.map((m) => (
                <ContextMenu key={m.id}>
                  <ContextMenuTrigger render={
                    <TableRow key={m.id}>
                      <TableCell>
                        <Checkbox checked={selected.has(m.id)} onCheckedChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next })} />
                      </TableCell>
                      <TableCell>
                        <button type="button" onClick={() => pickAvatar(m)} title="点击更换头像" className="rounded-full">
                          <Avatar owner={ownerForUser(m.id)} name={m.username} size={28} />
                        </button>
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
                            <DropdownMenuItem onClick={() => pickAvatar(m)}><Icon name="image-plus" /> 设置头像</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => removeAvatar(m)}><Icon name="user-round-x" /> 恢复默认头像</DropdownMenuItem>
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

      <input ref={avatarFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onAvatarFile(e.target.files?.[0])} />

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
              <Button variant="outline" onClick={() => { const p = genPassword(); if (resetBatch) setBatchNewPassword(p); else setResetPassword(p) }}>随机生成</Button>
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
function PermsSection() {
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [superLimit, setSuperLimit] = React.useState("")
  const [memberLimit, setMemberLimit] = React.useState("")
  const [zipMaxFiles, setZipMaxFiles] = React.useState("")
  const [zipMaxSingle, setZipMaxSingle] = React.useState("")
  const [zipMaxTotal, setZipMaxTotal] = React.useState("")
  const [extractMax, setExtractMax] = React.useState("")
  const [downloadMax, setDownloadMax] = React.useState("")

  const load = React.useCallback(() => {
    api.get<AdminConfig>("/admin/config").then((c) => {
      setConfig(c)
      setSuperLimit(String(c.superUploadLimitMB ?? 2048))
      setMemberLimit(String(c.memberUploadLimitMB ?? 512))
      setZipMaxFiles(String(c.zipMaxFiles ?? 100))
      setZipMaxSingle(String(c.zipMaxSingleMB ?? 50))
      setZipMaxTotal(String(c.zipMaxTotalMB ?? 128))
      setExtractMax(String(c.extractMaxZipMB ?? 128))
      setDownloadMax(String(c.downloadUrlMaxMB ?? 4096))
    }).catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    try {
      const next = await api.patch<AdminConfig>("/admin/config", body)
      setConfig(next)
      setSuperLimit(String(next.superUploadLimitMB ?? 2048))
      setMemberLimit(String(next.memberUploadLimitMB ?? 512))
      setZipMaxFiles(String(next.zipMaxFiles ?? 100))
      setZipMaxSingle(String(next.zipMaxSingleMB ?? 50))
      setZipMaxTotal(String(next.zipMaxTotalMB ?? 128))
      setExtractMax(String(next.extractMaxZipMB ?? 128))
      setDownloadMax(String(next.downloadUrlMaxMB ?? 4096))
      if (msg) toast.success(msg)
    } catch (e) { toast.error((e as Error).message) }
  }

  const unhide = async (p: string) => {
    try { const next = await api.del<AdminConfig>("/admin/hidden-paths", { path: p }); setConfig(next); toast.success("已恢复访客可见") }
    catch (e) { toast.error((e as Error).message) }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  const m = config.memberPerms
  const g = config.guestPerms
  const fw = m.fileWrite

  return (
    <div className="edge-highlight rounded-xl border border-border bg-card p-5">
      {/* ===== 上传大小限制 ===== */}
      <h3 className="mb-3 text-sm font-medium">上传大小限制（单文件 MB）</h3>
      <div className="mb-4 grid gap-2 sm:flex sm:items-end sm:gap-4">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">超级管理员</span>
          <Input className="w-24 text-right" inputMode="numeric" value={superLimit} onChange={(e) => setSuperLimit(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">团队成员</span>
          <Input className="w-24 text-right" inputMode="numeric" value={memberLimit} onChange={(e) => setMemberLimit(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <Button size="sm" onClick={() => patch({ superUploadLimitMB: Number(superLimit), memberUploadLimitMB: Number(memberLimit) }, "上传限制已更新")}>保存</Button>
      </div>

      <Separator className="mb-5" />

      {/* ===== ZIP 打包/解压限制 ===== */}
      <h3 className="mb-3 text-sm font-medium">ZIP 打包 / 解压限制</h3>
      <div className="mb-4 grid gap-2 sm:flex sm:items-end sm:flex-wrap sm:gap-4">
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">最大文件数</span>
          <Input className="w-20 text-right" inputMode="numeric" value={zipMaxFiles} onChange={(e) => setZipMaxFiles(e.target.value)} />
          <span className="text-xs text-muted-foreground">个</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">单文件最大</span>
          <Input className="w-20 text-right" inputMode="numeric" value={zipMaxSingle} onChange={(e) => setZipMaxSingle(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">总大小最大</span>
          <Input className="w-20 text-right" inputMode="numeric" value={zipMaxTotal} onChange={(e) => setZipMaxTotal(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">解压ZIP最大</span>
          <Input className="w-20 text-right" inputMode="numeric" value={extractMax} onChange={(e) => setExtractMax(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <Button size="sm" onClick={() => patch({ zipMaxFiles: Number(zipMaxFiles), zipMaxSingleMB: Number(zipMaxSingle), zipMaxTotalMB: Number(zipMaxTotal), extractMaxZipMB: Number(extractMax) }, "ZIP 限制已更新")}>保存</Button>
      </div>

      <Separator className="mb-5" />

      {/* ===== 链接下载工具（按 URL 抓取）===== */}
      <h3 className="mb-3 text-sm font-medium">链接下载工具限制（单个文件 MB）</h3>
      <div className="mb-4 grid gap-2 sm:flex sm:items-end sm:gap-4">
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">单个文件最大</span>
          <Input className="w-24 text-right" inputMode="numeric" value={downloadMax} onChange={(e) => setDownloadMax(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <Button size="sm" onClick={() => patch({ downloadUrlMaxMB: Number(downloadMax) }, "下载限制已更新")}>保存</Button>
      </div>

      <Separator className="mb-5" />

      {/* ===== 团队成员权限 ===== */}
      <h3 className="mb-4 text-sm font-medium">团队成员权限</h3>

      {/* 文件操作（主开关 + 子项） */}
      <div className="mb-4">
        <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">文件操作</span>
          <Switch checked={fw} onCheckedChange={(v) => patch({ memberPerms: { fileWrite: !!v } })} />
        </div>
        <div className={cn("mt-1 ml-1 grid gap-px sm:grid-cols-2", !fw && "pointer-events-none opacity-30")}>
          {permItem("上传文件", fw && m.upload, (v) => patch({ memberPerms: { upload: !!v } }))}
          {permItem("上传文件夹", fw && m.uploadFolders, (v) => patch({ memberPerms: { uploadFolders: !!v } }))}
          {permItem("新建文件夹", fw && m.mkdir, (v) => patch({ memberPerms: { mkdir: !!v } }))}
          {permItem("复制", fw && m.copy, (v) => patch({ memberPerms: { copy: !!v } }))}
          {permItem("移动", fw && m.move, (v) => patch({ memberPerms: { move: !!v } }))}
          {permItem("重命名", fw && m.rename, (v) => patch({ memberPerms: { rename: !!v } }))}
          {permItem("删除", fw && m.delete, (v) => patch({ memberPerms: { delete: !!v } }))}
        </div>
      </div>

      <Separator className="mb-4" />

      {/* 下载与预览 */}
      <div className="mb-4">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">下载与预览</h4>
        <div className="grid gap-px sm:grid-cols-2">
          {permItem("浏览目录", m.browse, (v) => patch({ memberPerms: { browse: !!v } }))}
          {permItem("下载文件", m.downloadFile, (v) => patch({ memberPerms: { downloadFile: !!v } }))}
          {permItem("下载文件夹", m.downloadFolder, (v) => patch({ memberPerms: { downloadFolder: !!v } }))}
          {permItem("允许预览", m.preview, (v) => patch({ memberPerms: { preview: !!v } }))}
        </div>
      </div>

      <Separator className="mb-4" />

      {/* 高级功能 */}
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">高级功能</h4>
      <div className="mb-4 grid gap-px sm:grid-cols-2">
        {permItem("压缩为 Zip", m.compressZip, (v) => patch({ memberPerms: { compressZip: !!v } }))}
        {permItem("解压 Zip", m.extractZip, (v) => patch({ memberPerms: { extractZip: !!v } }))}
        {permItem("多线程下载器", m.downloadUrl, (v) => patch({ memberPerms: { downloadUrl: !!v } }))}
        {permItem("HTML 全屏预览", m.htmlPreview, (v) => patch({ memberPerms: { htmlPreview: !!v } }))}
        {permItem("在线编辑文件", m.editFiles, (v) => patch({ memberPerms: { editFiles: !!v } }))}
      </div>

      <Separator className="mb-4" />

      {/* 管理与账户 */}
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">管理与账户</h4>
      <div className="mb-4 grid gap-px sm:grid-cols-2">
        {permItem("管理访客可见性", m.manageGuestVisibility, (v) => patch({ memberPerms: { manageGuestVisibility: !!v } }))}
        {permItem("修改密码", m.changePassword, (v) => patch({ memberPerms: { changePassword: !!v } }))}
      </div>

      <Separator className="mb-5" />

      {/* ===== 访客权限 ===== */}
      <h3 className="mb-4 text-sm font-medium">访客权限</h3>
      <div className="mb-4 grid gap-px sm:grid-cols-2">
        {permItem("浏览目录", g.browse, (v) => patch({ guestPerms: { browse: !!v } }))}
        {permItem("下载文件", g.downloadFile, (v) => patch({ guestPerms: { downloadFile: !!v } }))}
        {permItem("下载文件夹", g.downloadFolder, (v) => patch({ guestPerms: { downloadFolder: !!v } }))}
        {permItem("允许预览", g.preview, (v) => patch({ guestPerms: { preview: !!v } }))}
        {permItem("压缩为 Zip", g.compressZip, (v) => patch({ guestPerms: { compressZip: !!v } }))}
        {permItem("解压 Zip", g.extractZip, (v) => patch({ guestPerms: { extractZip: !!v } }))}
        {permItem("HTML 全屏预览", g.htmlPreview, (v) => patch({ guestPerms: { htmlPreview: !!v } }))}
        {permItem("在线编辑文件", g.editFiles, (v) => patch({ guestPerms: { editFiles: !!v } }))}
      </div>

      {/* 隐藏文件夹 */}
      <Separator className="mb-3" />
      <div>
        <p className="mb-2 text-sm font-medium">对访客隐藏的文件夹</p>
        {config.guestHiddenPaths.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无。在文件列表中右键文件夹可设为隐藏</p>
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
  )
}

function permItem(label: string, checked: boolean, onChange: (v: boolean) => void) {
  return (
    <div className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/30">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/* ==================== 安全 ==================== */
function SecuritySection() {
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [status, setStatus] = React.useState<ServerStatus | null>(null)
  const [ratePerMin, setRatePerMin] = React.useState("")
  const [extractTotal, setExtractTotal] = React.useState("")

  const load = React.useCallback(() => {
    api.get<AdminConfig>("/admin/config").then((c) => {
      setConfig(c)
      setRatePerMin(String(c.rateLimitPerMin ?? 120))
      setExtractTotal(String(c.extractMaxTotalMB ?? 512))
    }).catch((e) => toast.error((e as Error).message))
    api.get<ServerStatus>("/admin/status").then(setStatus).catch(() => { /* 状态可缺省 */ })
  }, [])
  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    try {
      const next = await api.patch<AdminConfig>("/admin/config", body)
      setConfig(next)
      setRatePerMin(String(next.rateLimitPerMin ?? 120))
      setExtractTotal(String(next.extractMaxTotalMB ?? 512))
      if (msg) toast.success(msg)
    } catch (e) { toast.error((e as Error).message) }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  const trustProxy = status?.trustProxy
  const ipMode = trustProxy === undefined
    ? "未知"
    : trustProxy === false
      ? "直连（不信任代理头）"
      : `信任代理头 ${Array.isArray(trustProxy) ? trustProxy.join(", ") : String(trustProxy)}`

  return (
    <div className="grid gap-5">
      {/* 接口限流 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-1 text-sm font-medium">接口限流</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          限制单个 IP 每分钟可执行的打包、解压、搜索、查看详情、链接下载次数，防止被刷满 CPU 与磁盘。普通浏览目录与单文件下载不受影响。
        </p>
        <div className="mb-4 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">开启限流</span>
          <Switch checked={config.rateLimitEnabled} onCheckedChange={(v) => patch({ rateLimitEnabled: !!v })} />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-sm text-muted-foreground">每分钟上限</span>
            <Input className="w-24 text-right" inputMode="numeric" value={ratePerMin} onChange={(e) => setRatePerMin(e.target.value)} />
            <span className="text-xs text-muted-foreground">次</span>
          </div>
          <Button size="sm" onClick={() => patch({ rateLimitPerMin: Number(ratePerMin) }, "限流设置已更新")}>保存</Button>
        </div>
      </div>

      {/* 解压保护 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-1 text-sm font-medium">解压保护</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          限制 ZIP 解压后的总大小；超出时会中止解压并清理已写出的内容，避免用小压缩包占满磁盘。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-sm text-muted-foreground">解压总量最大</span>
            <Input className="w-24 text-right" inputMode="numeric" value={extractTotal} onChange={(e) => setExtractTotal(e.target.value)} />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
          <Button size="sm" onClick={() => patch({ extractMaxTotalMB: Number(extractTotal) }, "解压上限已更新")}>保存</Button>
        </div>
      </div>

      {/* 其他开关 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-4 text-sm font-medium">其他安全开关</h3>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">允许复制只读映射目录的内容</p>
              <p className="text-xs text-muted-foreground">关闭时，外部映射目录（只读虚拟文件夹）的内容不能复制或压缩进网盘目录</p>
            </div>
            <Switch checked={config.softDirAllowCopyOut} onCheckedChange={(v) => patch({ softDirAllowCopyOut: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">作业进度仅创建者可见</p>
              <p className="text-xs text-muted-foreground">关闭后，团队成员之间可以互相查看压缩 / 解压 / 链接下载任务的文件名与进度</p>
            </div>
            <Switch checked={config.jobStatusOwnerOnly} onCheckedChange={(v) => patch({ jobStatusOwnerOnly: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">链接下载允许访问内网地址</p>
              <p className="text-xs text-muted-foreground">关闭时禁止用链接下载工具抓取内网 / 回环 / 云元数据地址（防 SSRF）</p>
            </div>
            <Switch checked={config.downloadUrlAllowPrivate} onCheckedChange={(v) => patch({ downloadUrlAllowPrivate: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">写操作校验请求来源</p>
              <p className="text-xs text-muted-foreground">拒绝来自其他站点的写请求（校验 Origin / Sec-Fetch-Site）。若反向代理改写了 Host 头造成误拦，可在此关闭</p>
            </div>
            <Switch checked={config.csrfOriginCheck} onCheckedChange={(v) => patch({ csrfOriginCheck: !!v })} />
          </div>
        </div>
      </div>
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-3 text-sm font-medium">客户端 IP 解析</h3>
        <div className="flex items-center gap-2">
          <Badge variant={trustProxy === undefined || trustProxy === false ? "secondary" : "default"} className="shrink-0 text-[10px]">{ipMode}</Badge>
          <span className="text-xs text-muted-foreground">用于日志记录与按 IP 限速</span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          由服务端 .env 中的 <code className="font-mono">TRUST_PROXY</code> 决定，修改后需重启服务。
          只通过隧道 / 反向代理访问时设为 <code className="font-mono">loopback</code>，日志与限流才会使用真实客户端 IP；
          若服务同时能被直接访问，请保持关闭（默认），否则客户端可伪造该标头绕过限速。
        </p>
      </div>
    </div>
  )
}

/* ==================== 公网 ==================== */
function TunnelSection() {
  const [config, setConfig] = React.useState<{ enabled: boolean; mode: string; customHost: string } | null>(null)
  const [status, setStatus] = React.useState<TunnelStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  const configRef = React.useRef(config)
  React.useEffect(() => { configRef.current = config }, [config])

  const load = React.useCallback(() => {
    api.get<{ config: { enabled: boolean; mode: string; customHost: string }; status: TunnelStatus }>("/admin/tunnel")
      .then((d) => {
        setConfig((prev) => {
          if (!prev) return d.config
          const cur = configRef.current
          if (!cur || cur.enabled !== d.config.enabled || cur.mode !== d.config.mode || cur.customHost !== d.config.customHost) {
            return d.config
          }
          return prev
        })
        setStatus(d.status)
      }).catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const apply = async (next: { enabled: boolean; mode: string; customHost: string }) => {
    setBusy(true)
    try {
      const d = await api.post<{ config: typeof next; status: TunnelStatus }>("/admin/tunnel", next)
      setConfig(d.config)
      setStatus(d.status)
      if (next.enabled) {
        if (d.status.running) {
          toast.success(d.status.url ? "隧道已连接" : "隧道已启动，等待连接…")
        } else {
          toast.warning("隧道未能启动，请查看下方日志")
        }
      } else {
        toast.success("已关闭")
      }
    }
    catch (e) { toast.error((e as Error).message) }
    finally { setBusy(false) }
  }

  const handleModeChange = React.useCallback((v: string | null) => {
    if (!v) return
    const cur = configRef.current
    if (!cur) return
    const next = { ...cur, mode: v }
    setConfig(next)
    if (cur.enabled) apply(next)
  }, [])

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* 配置区：行内 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 text-sm font-medium">SSH 反向隧道</h3>
        <p className="mb-4 text-xs text-muted-foreground">通过 ssh -R 将本服务暴露到公网</p>
        <div className="grid gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">启用公网访问</span>
            <Switch checked={config.enabled} disabled={busy} onCheckedChange={(v) => apply({ ...config, enabled: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">隧道服务</span>
            <Select value={config.mode} onValueChange={handleModeChange}>
              <SelectTrigger className="w-40"><SelectValue>{(v) => (v === "localhostrun" ? "localhost.run" : v === "serveo" ? "serveo.net" : v === "custom" ? "自定义 SSH" : "pinggy.io")}</SelectValue></SelectTrigger>
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
      <div className="edge-highlight rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          运行状态
          <Badge variant={status?.running ? "default" : "secondary"}>{status?.running ? "运行中" : "未运行"}</Badge>
        </h3>
        {status?.url && (
          <div className="mb-3"><Label>公网地址</Label><Input readOnly value={status.url} className="mt-1 h-7 font-mono text-xs" onFocus={(e) => e.target.select()} /></div>
        )}
        <p className="mb-2 text-xs text-muted-foreground">{status?.restarts ? `已自动重连 ${status.restarts} 次` : "隧道日志"}</p>
        <ScrollArea className="h-56 rounded-md border border-border bg-muted/30 p-2">
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{status?.output?.length ? status.output.join("\n") : "（暂无输出）"}</pre>
        </ScrollArea>
      </div>
    </div>
  )
}
