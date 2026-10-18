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
import { LanguageSelect } from "@/components/language-select"
import { Avatar } from "@/components/avatar"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/state/auth"
import { useClientSettings } from "@/state/client-settings"
import { useConfirm } from "@/components/confirm-dialog"
import { useT } from "@/lib/i18n"
import { PathPicker } from "@/components/browser/path-picker"
import { api, uploadAvatar, deleteAvatar } from "@/lib/api"
import { ownerForUser, primeAvatar, forgetAvatar } from "@/lib/avatar-cache"
import { fileToAvatarWebp } from "@/lib/avatar-image"
import { formatBytes, formatUptime } from "@/lib/format"
import type { AdminConfig, Member, ServerStatus, TunnelStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { GroupsSection } from "@/pages/settings/groups-section"
import { DataSection } from "@/pages/settings/data-section"
import { TrashSection } from "@/pages/settings/trash-section"
import { LogsMetricsSection } from "@/pages/settings/logs-metrics-section"
import { SharesSection } from "@/pages/settings/shares-section"

export function SettingsPage() {
  const { me, ready } = useAuth()
  const t = useT()
  const isSuper = me.role === "superadmin"

  return (
    <AppShell>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-4xl min-w-0 px-3 py-5 sm:px-6 sm:py-6">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("ui.settings.page.title")}</h1>
          <p className="mb-6 text-sm text-muted-foreground">{isSuper ? t("ui.settings.page.subtitle_admin") : t("ui.settings.page.subtitle_member")}</p>
          {ready && (
            <Tabs defaultValue="appearance">
              {/*
                手机上有 11 个标签，必须换行 —— 但 TabsList 的默认样式带
                `group-data-horizontal/tabs:h-9`（固定 36px），换行后第二、三行
                会被这个固定高度裁掉，看起来就是"标签显示不全"。
                变体类的特异性高于普通 `h-auto`，所以这里用内联 style 覆盖，
                并且让触发器自己撑开高度（h-auto 需要父级有确定高度才生效）。
              */}
              <TabsList
                variant="line"
                className="mb-6 max-w-full flex-wrap"
                style={{ height: "auto" }}
              >
                <TabsTrigger value="appearance"><Icon name="palette" /> {t("ui.settings.tabs.appearance")}</TabsTrigger>
                {isSuper && (
                  <>
                    <TabsTrigger value="status"><Icon name="activity" /> {t("ui.settings.tabs.status")}</TabsTrigger>
                    <TabsTrigger value="logs"><Icon name="scroll-text" /> {t("ui.settings.tabs.logs")}</TabsTrigger>
                    <TabsTrigger value="members"><Icon name="users" /> {t("ui.settings.tabs.members")}</TabsTrigger>
                    <TabsTrigger value="groups"><Icon name="layers" /> {t("ui.settings.tabs.groups")}</TabsTrigger>
                    <TabsTrigger value="shares"><Icon name="share-2" /> {t("ui.share.tab")}</TabsTrigger>
                    <TabsTrigger value="perms"><Icon name="shield-check" /> {t("ui.settings.tabs.perms")}</TabsTrigger>
                    <TabsTrigger value="data"><Icon name="database" /> {t("ui.settings.tabs.data")}</TabsTrigger>
                    <TabsTrigger value="trash"><Icon name="trash-2" /> {t("ui.settings.tabs.trash")}</TabsTrigger>
                    <TabsTrigger value="security"><Icon name="lock" /> {t("ui.settings.tabs.security")}</TabsTrigger>
                    <TabsTrigger value="tunnel"><Icon name="globe" /> {t("ui.settings.tabs.tunnel")}</TabsTrigger>
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
                  <TabsContent value="shares"><SharesSection /></TabsContent>
                  <TabsContent value="perms"><PermsSection /></TabsContent>
                  <TabsContent value="data"><DataSection /></TabsContent>
                  <TabsContent value="trash"><TrashSection /></TabsContent>
                  <TabsContent value="security"><SecuritySection /></TabsContent>
                  <TabsContent value="tunnel"><TunnelSection /></TabsContent>
                </>
              )}
            </Tabs>
          )}
        </div>
      </div>
      <div className="border-t border-border/30 px-3 py-2">
        <div className="text-center text-[11px] text-muted-foreground">{t("ui.settings.page.subtitle_admin")}</div>
      </div>
    </AppShell>
  )
}

/* ==================== 外观 ==================== */

/** 设置行：左侧文字 + 右侧控件，说明另起一行 —— 比把控件挤进 label 里更好读 */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {  return (
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
  const confirm = useConfirm()
  const t = useT()

  const themeOptions = [
    ["light", "sun", t("ui.common.platform_theme_light")],
    ["dark", "moon", t("ui.common.platform_theme_dark")],
    ["system", "monitor", t("ui.common.platform_theme_system")],
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>{t("ui.settings.tabs.appearance")}</CardTitle>
              <CardDescription>{t("ui.settings.appearance.device_only_hint")}</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={async () => {
              if (!(await confirm({
                title: t("ui.settings.appearance.reset_confirm_title"),
                description: t("ui.settings.appearance.reset_confirm_desc"),
                confirmText: t("ui.settings.appearance.reset_default"),
              }))) return
              settings.reset()
              // 主题不归 ClientSettingsProvider 管（它在 ThemeProvider 自己的
              // "zs-theme" 键里）。不在这里一起重置的话，确认框承诺了"主题回到
              // 出厂设置"但实际不会生效。
              setTheme("system")
              toast.success(t("ui.settings.appearance.reset_done"))
            }}>
              <Icon name="rotate-ccw" data-icon="inline-start" /> {t("ui.settings.appearance.reset_default")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-6">
            <FieldSet>
              <FieldLegend variant="label">{t("ui.settings.appearance.theme_legend")}</FieldLegend>
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
              <FieldDescription className="mt-2">{t("ui.settings.appearance.theme_shortcut_hint")}</FieldDescription>
            </FieldSet>

            <Separator />

            <FieldSet>
              <FieldLegend variant="label">{t("ui.settings.appearance.ui_legend")}</FieldLegend>
              <div className="flex flex-col divide-y divide-border/60 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
                {/* 界面语言放在最前：它是唯一会同时影响"这一页怎么显示"的偏好 */}
                <SettingRow label={t("ui.i18n.language")}>
                  <LanguageSelect />
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.density_label")} hint={t("ui.settings.appearance.density_hint")}>
                  <ToggleGroup
                    value={[settings.density]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "comfortable" | "compact" | undefined
                      if (next) settings.update({ density: next })
                    }}
                  >
                    <ToggleGroupItem value="comfortable">{t("ui.settings.appearance.density_comfortable")}</ToggleGroupItem>
                    <ToggleGroupItem value="compact">{t("ui.settings.appearance.density_compact")}</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.font_scale_label")} hint={t("ui.settings.appearance.font_scale_hint")}>
                  <ToggleGroup
                    value={[settings.fontScale]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "sm" | "base" | "lg" | undefined
                      if (next) settings.update({ fontScale: next })
                    }}
                  >
                    <ToggleGroupItem value="sm">{t("ui.settings.appearance.font_small")}</ToggleGroupItem>
                    <ToggleGroupItem value="base">{t("ui.settings.appearance.font_base")}</ToggleGroupItem>
                    <ToggleGroupItem value="lg">{t("ui.settings.appearance.font_large")}</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.sidebar_collapsed_label")} hint={t("ui.settings.appearance.sidebar_collapsed_hint")}>
                  <Switch
                    checked={settings.sidebarCollapsed}
                    onCheckedChange={(v) => settings.update({ sidebarCollapsed: !!v })}
                  />
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.noise_label")} hint={t("ui.settings.appearance.noise_hint")}>
                  <Switch checked={settings.noise} onCheckedChange={(v) => settings.update({ noise: !!v })} />
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.reduce_motion_label")} hint={t("ui.settings.appearance.reduce_motion_hint")}>
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
          <CardTitle>{t("ui.settings.appearance.file_browse_defaults_title")}</CardTitle>
          <CardDescription>{t("ui.settings.appearance.file_browse_defaults_desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-6">
            <FieldSet>
              <FieldLegend variant="label">{t("ui.settings.appearance.view_legend")}</FieldLegend>
              <ToggleGroup
                value={[settings.view]}
                onValueChange={(v) => {
                  const next = v[v.length - 1] as "list" | "grid" | undefined
                  if (next) settings.update({ view: next })
                }}
              >
                <ToggleGroupItem value="list">
                  <Icon name="list" data-icon="inline-start" /> {t("ui.settings.appearance.view_list")}
                </ToggleGroupItem>
                <ToggleGroupItem value="grid">
                  <Icon name="layout-grid" data-icon="inline-start" /> {t("ui.settings.appearance.view_grid")}
                </ToggleGroupItem>
              </ToggleGroup>
            </FieldSet>

            <Separator />

            <FieldSet>
              <FieldLegend variant="label">{t("ui.settings.appearance.sort_legend")}</FieldLegend>
              <div className="flex flex-col divide-y divide-border/60 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
                <SettingRow label={t("ui.settings.appearance.sort_by_label")}>
                  <ToggleGroup
                    value={[settings.sortBy]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "name" | "size" | "mtime" | undefined
                      if (next) settings.update({ sortBy: next })
                    }}
                  >
                    <ToggleGroupItem value="name">{t("ui.common.name")}</ToggleGroupItem>
                    <ToggleGroupItem value="size">{t("ui.common.size")}</ToggleGroupItem>
                    <ToggleGroupItem value="mtime">{t("ui.settings.appearance.sort_mtime")}</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.sort_dir_label")}>
                  <ToggleGroup
                    value={[settings.sortDir]}
                    onValueChange={(v) => {
                      const next = v[v.length - 1] as "asc" | "desc" | undefined
                      if (next) settings.update({ sortDir: next })
                    }}
                  >
                    <ToggleGroupItem value="asc">{t("ui.settings.appearance.sort_asc")}</ToggleGroupItem>
                    <ToggleGroupItem value="desc">{t("ui.settings.appearance.sort_desc")}</ToggleGroupItem>
                  </ToggleGroup>
                </SettingRow>

                <SettingRow label={t("ui.settings.appearance.folders_first_label")} hint={t("ui.settings.appearance.folders_first_hint")}>
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
  const t = useT()
  const [status, setStatus] = React.useState<ServerStatus | null>(null)
  const load = React.useCallback(() => { api.get<ServerStatus>("/admin/status").then(setStatus).catch((e) => toast.error((e as Error).message)) }, [])
  React.useEffect(() => { load(); const timer = setInterval(load, 10000); return () => clearInterval(timer) }, [load])
  if (!status) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  return (
    <div className="grid gap-5">
      {/* 关键指标：横向条形网格 */}
      <div className="edge-highlight grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
        {[
          ["timer", t("ui.settings.status.label_uptime"), formatUptime(status.uptimeSec)],
          ["hard-drive", t("ui.settings.status.label_storage"), formatBytes(status.storage.bytes)],
          ["memory-stick", t("ui.settings.status.label_memory"), formatBytes(status.memory.rss)],
          ["cpu", "Node", status.node],
          ["database", t("ui.settings.status.label_files"), t("ui.settings.status.files_dirs", { files: status.storage.files, dirs: status.storage.dirs })],
          ["hard-drive", t("ui.settings.status.label_disk"), status.disk ? t("ui.settings.status.disk_free", { size: formatBytes(status.disk.free) }) : t("ui.settings.status.disk_unavailable")],
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
        <h3 className="mb-2 text-sm font-medium">{t("ui.settings.status.lan_access")}</h3>
        <div className="grid gap-1.5">
          {[`http://localhost:${status.port}`, ...status.lan.map((ip) => `http://${ip}:${status.port}`)].map((url) => (
            <div key={url} className="flex items-center gap-2">
              <Badge variant="secondary" className="w-12 shrink-0 justify-center text-[10px]">{url.includes("localhost") ? t("ui.settings.status.badge_local") : t("ui.settings.status.badge_lan")}</Badge>
              <Input readOnly value={url} className="h-7 font-mono text-xs" onFocus={(e) => e.target.select()} />
            </div>
          ))}
          {status.tunnel.running && status.tunnel.url && (
            <div className="flex items-center gap-2">
              <Badge className="w-12 shrink-0 justify-center text-[10px]">{t("ui.settings.status.badge_public")}</Badge>
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
  const confirm = useConfirm()
  const t = useT()
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
      toast.success(t("ui.settings.members.avatar_updated", { name: target.username }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAvatarTarget(null)
      if (avatarFileRef.current) avatarFileRef.current.value = ""
    }
  }

  const removeAvatar = (m: Member) => {
    const owner = ownerForUser(m.id)
    void confirm({
      title: t("ui.settings.members.avatar_reset_confirm_title", { name: m.username }),
      description: t("ui.settings.members.avatar_reset_confirm_desc"),
      confirmText: t("ui.settings.members.avatar_reset_confirm_action"),
      // 把动作交给确认框执行：成功才关、失败会留在框里显示原因。
      // 旧写法是"先 await 确认、再自己 try/catch"，失败时框已经关了，
      // 用户只能从右下角一条 toast 里猜到底成没成。
      onConfirm: async () => {
        await deleteAvatar(owner)
        await forgetAvatar(owner)
        toast.success(t("ui.settings.members.avatar_reset_done"))
        load()
      },
    })
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
      if (okList.length) { setCreatedInfo(okList); toast.success(t("ui.settings.members.created_count", { count: okList.length })) }
      for (const f of failList) toast.error(t("ui.settings.members.member_error", { name: f.username || t("ui.settings.members.empty_username"), error: f.error ?? "" }))
      setBatchText(""); setShowCreate(false); load()
    } catch (e) { toast.error((e as Error).message) }
  }

  const batch = async (action: "enable" | "disable" | "delete", singleId?: string) => {
    const ids = singleId ? [singleId] : [...selected]
    if (!ids.length) return
    try { await api.post("/admin/members/batch", { action, ids }); toast.success(t("ui.settings.members.action_done")); load() }
    catch (e) { toast.error((e as Error).message) }
  }

  const doReset = async () => {
    if (!resetTarget) return
    try { await api.post(`/admin/members/${resetTarget.id}/password`, { password: resetPassword }); toast.success(t("ui.settings.members.password_reset", { name: resetTarget.username })); setResetTarget(null); setResetPassword("") }
    catch (e) { toast.error((e as Error).message) }
  }

  const allChecked = members.length > 0 && selected.size === members.length

  return (
    <Card className="edge-highlight">
      <CardHeader>
        <CardTitle>{t("ui.settings.members.title")}</CardTitle>
        <CardDescription>{t("ui.settings.members.desc", { count: members.length })}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setShowCreate(true)}><Icon name="user-plus" /> {t("ui.settings.members.add_member")}</Button>
          {selected.size > 0 && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <span className="text-xs text-muted-foreground">{t("ui.settings.members.selected_count", { count: selected.size })}</span>
              <Button size="sm" variant="outline" onClick={() => batch("enable")}>{t("ui.common.enable")}</Button>
              <Button size="sm" variant="outline" onClick={() => batch("disable")}>{t("ui.common.disable")}</Button>
              <Button size="sm" variant="outline" onClick={() => setResetBatch(true)}>{t("ui.settings.members.batch_reset_password")}</Button>
              <Button size="sm" variant="destructive" onClick={() => setConfirmDelete({})}>{t("ui.common.delete")}</Button>
            </>
          )}
        </div>

        {createdInfo.length > 0 && (
          <div className="rounded-md border border-border bg-muted/50 p-3">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium">{t("ui.settings.members.created_notice")}</p>
              <Button size="icon-xs" variant="ghost" onClick={() => setCreatedInfo([])}><Icon name="x" /></Button>
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap select-all">{createdInfo.join("\n")}</pre>
          </div>
        )}

        <div className="min-w-0 overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allChecked} onCheckedChange={() => setSelected(allChecked ? new Set() : new Set(members.map((m) => m.id)))} />
                </TableHead>
                <TableHead className="hidden w-14 sm:table-cell">{t("ui.settings.members.col_avatar")}</TableHead>
                <TableHead>{t("ui.settings.members.col_username")}</TableHead>
                <TableHead className="w-20">{t("ui.common.status")}</TableHead>
                <TableHead className="hidden w-40 md:table-cell">{t("ui.settings.members.col_created_at")}</TableHead>
                <TableHead className="w-12 text-right">{t("ui.common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{t("ui.settings.members.empty_hint")}</TableCell></TableRow>}
              {members.map((m) => (
                <ContextMenu key={m.id}>
                  <ContextMenuTrigger render={
                    <TableRow key={m.id}>
                      <TableCell>
                        <Checkbox checked={selected.has(m.id)} onCheckedChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next })} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <button type="button" onClick={() => pickAvatar(m)} title={t("ui.settings.members.change_avatar_hint")} className="rounded-full">
                          <Avatar owner={ownerForUser(m.id)} name={m.username} size={28} />
                        </button>
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-medium">{m.username}</TableCell>
                      <TableCell><Badge variant={m.disabled ? "secondary" : "default"}>{m.disabled ? t("ui.common.disabled") : t("ui.settings.members.status_active")}</Badge></TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{m.createdAt.replace("T", " ").slice(0, 19)}</TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" />}><Icon name="ellipsis-vertical" className="size-3.5" /></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {m.disabled ? <DropdownMenuItem onClick={() => batch("enable", m.id)}><Icon name="check-circle" /> {t("ui.common.enable")}</DropdownMenuItem>
                            : <DropdownMenuItem onClick={() => batch("disable", m.id)}><Icon name="circle-slash" /> {t("ui.common.disable")}</DropdownMenuItem>}
                            <DropdownMenuItem onClick={() => { setRenameTarget(m); setNewUsername(m.username) }}><Icon name="pencil-line" /> {t("ui.settings.members.rename_user")}</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setResetTarget(m)}><Icon name="key" /> {t("ui.settings.members.reset_password")}</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => pickAvatar(m)}><Icon name="image-plus" /> {t("ui.settings.members.set_avatar")}</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => removeAvatar(m)}><Icon name="user-round-x" /> {t("ui.settings.members.avatar_reset_confirm_action")}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete({ singleId: m.id })}><Icon name="trash-2" /> {t("ui.common.delete")}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  } />
                  <ContextMenuContent className="w-44">
                    {m.disabled ? <ContextMenuItem onClick={() => batch("enable", m.id)}><Icon name="check-circle" /> {t("ui.common.enable")}</ContextMenuItem>
                    : <ContextMenuItem onClick={() => batch("disable", m.id)}><Icon name="circle-slash" /> {t("ui.common.disable")}</ContextMenuItem>}
                    <ContextMenuItem onClick={() => { setRenameTarget(m); setNewUsername(m.username) }}><Icon name="pencil-line" /> {t("ui.settings.members.rename_user")}</ContextMenuItem>
                    <ContextMenuItem onClick={() => setResetTarget(m)}><Icon name="key" /> {t("ui.settings.members.reset_password")}</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onClick={() => setConfirmDelete({ singleId: m.id })}><Icon name="trash-2" /> {t("ui.common.delete")}</ContextMenuItem>
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
          <DialogHeader><DialogTitle>{t("ui.settings.members.create_dialog_title")}</DialogTitle></DialogHeader>
          <div className="grid gap-2 text-sm">
            <Label>{t("ui.settings.members.create_dialog_label")}</Label>
            <Textarea rows={6} placeholder="alice 123456\nbob\ncarol pass888" value={batchText} onChange={(e) => setBatchText(e.target.value)} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground">{t("ui.settings.members.create_dialog_hint")}</p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setShowCreate(false)}>{t("ui.common.cancel")}</Button><Button onClick={createBatch} disabled={!batchText.trim()}>{t("ui.common.create")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetTarget !== null || resetBatch} onOpenChange={(o) => { if (!o) { setResetTarget(null); setResetBatch(false) } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{resetBatch ? t("ui.settings.members.batch_reset_title", { count: selected.size }) : t("ui.settings.members.reset_title", { name: resetTarget?.username ?? "" })}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reset-pwd">{t("ui.settings.members.new_password")}</Label>
            <div className="flex gap-2">
              <Input id="reset-pwd" value={resetBatch ? batchNewPassword : resetPassword} onChange={(e) => resetBatch ? setBatchNewPassword(e.target.value) : setResetPassword(e.target.value)} placeholder={t("ui.settings.members.password_min_hint")} />
              <Button variant="outline" onClick={() => { const p = genPassword(); if (resetBatch) setBatchNewPassword(p); else setResetPassword(p) }}>{t("ui.settings.members.generate_random")}</Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetTarget(null); setResetBatch(false) }}>{t("ui.common.cancel")}</Button>
            <Button onClick={resetBatch ? async () => {
              if (batchNewPassword.length < 6) return
              // 逐条重置：旧实现在这里没有 try/catch，任一条失败就是一个未处理的
              // Promise rejection，而成功分支照样提示"已重置 N 个密码"——用户
              // 根本不知道有几条没成功。
              const ids = [...selected]
              let ok = 0
              const failed: string[] = []
              for (const id of ids) {
                const who = members.find((m) => m.id === id)?.username || id
                try {
                  await api.post(`/admin/members/${id}/password`, { password: batchNewPassword })
                  ok += 1
                } catch (err) {
                  failed.push(t("ui.settings.members.member_error", { name: who, error: (err as Error).message }))
                }
              }
              if (ok) toast.success(t("ui.settings.members.reset_ok_count", { count: ok }))
              if (failed.length) {
                toast.error(t("ui.settings.members.reset_failed_count", { count: failed.length }), { description: failed.join("\n") })
              }
              setResetBatch(false)
              setBatchNewPassword("")
              load()
            } : doReset} disabled={resetBatch ? batchNewPassword.length < 6 : resetPassword.length < 6}>{t("ui.common.ok")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("ui.settings.members.rename_title", { name: renameTarget?.username ?? "" })}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="rename-user">{t("ui.settings.members.new_username")}</Label>
            <Input id="rename-user" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder={t("ui.settings.members.username_hint")} />
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRenameTarget(null)}>{t("ui.common.cancel")}</Button><Button onClick={async () => { if (!renameTarget || !newUsername.trim()) return; try { await api.patch(`/admin/members/${renameTarget.id}`, { username: newUsername.trim() }); toast.success(t("ui.settings.members.rename_done")); setRenameTarget(null); load() } catch (e) { toast.error((e as Error).message) } }} disabled={!newUsername.trim()}>{t("ui.common.ok")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => { if (!o) setConfirmDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t("ui.settings.members.delete_confirm_title")}</AlertDialogTitle><AlertDialogDescription>{confirmDelete?.singleId ? t("ui.settings.members.delete_confirm_single") : t("ui.settings.members.delete_confirm_batch", { count: selected.size })}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={(e) => { e.preventDefault(); batch("delete", confirmDelete?.singleId); setConfirmDelete(null) }}>{t("ui.common.delete")}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/* ==================== 权限 ==================== */
function PermsSection() {
  // 显式遮蔽 window.confirm —— 确认一律走应用内的 ConfirmProvider
  const confirm = useConfirm()
  const t = useT()
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [superLimit, setSuperLimit] = React.useState("")
  const [memberLimit, setMemberLimit] = React.useState("")
  const [zipMaxFiles, setZipMaxFiles] = React.useState("")
  const [zipMaxSingle, setZipMaxSingle] = React.useState("")
  const [zipMaxTotal, setZipMaxTotal] = React.useState("")
  const [extractMax, setExtractMax] = React.useState("")
  const [downloadMax, setDownloadMax] = React.useState("")
  const [pickHidden, setPickHidden] = React.useState(false)

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

  const unhide = (p: string) => {
    void confirm({
      title: t("ui.settings.perms.unhide_confirm_title", { path: p }),
      description: t("ui.settings.perms.unhide_confirm_desc"),
      confirmText: t("ui.settings.perms.unhide_confirm_action"),
      destructive: false,
      onConfirm: async () => {
        const next = await api.del<AdminConfig>("/admin/hidden-paths", { path: p })
        setConfig(next)
        toast.success(t("ui.settings.perms.unhide_done"))
      },
    })
  }

  // 用可视化目录选择器直接指定要隐藏的文件夹，不必先回到文件页右键
  const hidePath = async (p: string) => {
    if (!p) { toast.error(t("ui.settings.perms.cannot_hide_root")); return }
    try {
      await api.post("/fs/guest-visibility", { path: p, hidden: true })
      toast.success(t("ui.settings.perms.hidden_done", { path: p }))
      load()
    } catch (e) { toast.error((e as Error).message) }
  }

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  const m = config.memberPerms
  const g = config.guestPerms
  const fw = m.fileWrite
  const gw = !!config.guestWrite

  return (
    <div className="edge-highlight rounded-xl border border-border bg-card p-5">
      {/* ===== 上传大小限制 ===== */}
      <h3 className="mb-3 text-sm font-medium">{t("ui.settings.perms.upload_limit_title")}</h3>
      <div className="mb-4 grid gap-2 sm:flex sm:items-end sm:gap-4">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.superadmin")}</span>
          <Input className="w-24 text-right" inputMode="numeric" value={superLimit} onChange={(e) => setSuperLimit(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.member_role")}</span>
          <Input className="w-24 text-right" inputMode="numeric" value={memberLimit} onChange={(e) => setMemberLimit(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <Button size="sm" onClick={() => patch({ superUploadLimitMB: Number(superLimit), memberUploadLimitMB: Number(memberLimit) }, t("ui.settings.perms.upload_limit_updated"))}>{t("ui.common.save")}</Button>
      </div>

      <Separator className="mb-5" />

      {/* ===== ZIP 打包/解压限制 ===== */}
      <h3 className="mb-3 text-sm font-medium">{t("ui.settings.perms.zip_limit_title")}</h3>
      <div className="mb-4 grid gap-2 sm:flex sm:items-end sm:flex-wrap sm:gap-4">
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.zip_max_files")}</span>
          <Input className="w-20 text-right" inputMode="numeric" value={zipMaxFiles} onChange={(e) => setZipMaxFiles(e.target.value)} />
          <span className="text-xs text-muted-foreground">{t("ui.settings.perms.unit_items")}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.zip_max_single")}</span>
          <Input className="w-20 text-right" inputMode="numeric" value={zipMaxSingle} onChange={(e) => setZipMaxSingle(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.zip_max_total")}</span>
          <Input className="w-20 text-right" inputMode="numeric" value={zipMaxTotal} onChange={(e) => setZipMaxTotal(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.zip_extract_max")}</span>
          <Input className="w-20 text-right" inputMode="numeric" value={extractMax} onChange={(e) => setExtractMax(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <Button size="sm" onClick={() => patch({ zipMaxFiles: Number(zipMaxFiles), zipMaxSingleMB: Number(zipMaxSingle), zipMaxTotalMB: Number(zipMaxTotal), extractMaxZipMB: Number(extractMax) }, t("ui.settings.perms.zip_limit_updated"))}>{t("ui.common.save")}</Button>
      </div>

      <Separator className="mb-5" />

      {/* ===== 链接下载工具（按 URL 抓取）===== */}
      <h3 className="mb-3 text-sm font-medium">{t("ui.settings.perms.url_download_limit_title")}</h3>
      <div className="mb-4 grid gap-2 sm:flex sm:items-end sm:gap-4">
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">{t("ui.settings.perms.url_download_max")}</span>
          <Input className="w-24 text-right" inputMode="numeric" value={downloadMax} onChange={(e) => setDownloadMax(e.target.value)} />
          <span className="text-xs text-muted-foreground">MB</span>
        </div>
        <Button size="sm" onClick={() => patch({ downloadUrlMaxMB: Number(downloadMax) }, t("ui.settings.perms.download_limit_updated"))}>{t("ui.common.save")}</Button>
      </div>

      <Separator className="mb-5" />

      {/* ===== 团队成员权限 ===== */}
      <h3 className="mb-4 text-sm font-medium">{t("ui.settings.perms.member_perms_title")}</h3>

      {/* 文件操作（主开关 + 子项） */}
      <div className="mb-4">
        <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">{t("ui.settings.perms.file_write_title")}</span>
          <Switch checked={fw} onCheckedChange={(v) => patch({ memberPerms: { fileWrite: !!v } })} />
        </div>
        <div className={cn("mt-1 ml-1 grid gap-px sm:grid-cols-2", !fw && "pointer-events-none opacity-30")}>
          {permItem(t("ui.settings.perms.upload_file"), fw && m.upload, (v) => patch({ memberPerms: { upload: !!v } }))}
          {permItem(t("ui.settings.perms.upload_folder"), fw && m.uploadFolders, (v) => patch({ memberPerms: { uploadFolders: !!v } }))}
          {permItem(t("ui.settings.perms.mkdir"), fw && m.mkdir, (v) => patch({ memberPerms: { mkdir: !!v } }))}
          {permItem(t("ui.common.copy"), fw && m.copy, (v) => patch({ memberPerms: { copy: !!v } }))}
          {permItem(t("ui.settings.perms.move"), fw && m.move, (v) => patch({ memberPerms: { move: !!v } }))}
          {permItem(t("ui.common.rename"), fw && m.rename, (v) => patch({ memberPerms: { rename: !!v } }))}
          {permItem(t("ui.common.delete"), fw && m.delete, (v) => patch({ memberPerms: { delete: !!v } }))}
        </div>
      </div>

      <Separator className="mb-4" />

      {/* 下载与预览 */}
      <div className="mb-4">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("ui.settings.perms.download_preview_title")}</h4>
        <div className="grid gap-px sm:grid-cols-2">
          {permItem(t("ui.settings.perms.browse"), m.browse, (v) => patch({ memberPerms: { browse: !!v } }))}
          {permItem(t("ui.settings.perms.download_file"), m.downloadFile, (v) => patch({ memberPerms: { downloadFile: !!v } }))}
          {permItem(t("ui.settings.perms.download_folder"), m.downloadFolder, (v) => patch({ memberPerms: { downloadFolder: !!v } }))}
          {permItem(t("ui.settings.perms.preview"), m.preview, (v) => patch({ memberPerms: { preview: !!v } }))}
        </div>
      </div>

      <Separator className="mb-4" />

      {/* 高级功能 */}
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("ui.settings.perms.advanced_title")}</h4>
      <div className="mb-4 grid gap-px sm:grid-cols-2">
        {permItem(t("ui.settings.perms.compress_zip"), m.compressZip, (v) => patch({ memberPerms: { compressZip: !!v } }))}
        {permItem(t("ui.settings.perms.extract_zip"), m.extractZip, (v) => patch({ memberPerms: { extractZip: !!v } }))}
        {permItem(t("ui.settings.perms.download_url"), m.downloadUrl, (v) => patch({ memberPerms: { downloadUrl: !!v } }))}
        {permItem(t("ui.settings.perms.html_preview"), m.htmlPreview, (v) => patch({ memberPerms: { htmlPreview: !!v } }))}
        {permItem(t("ui.settings.perms.edit_files"), m.editFiles, (v) => patch({ memberPerms: { editFiles: !!v } }))}
      </div>

      <Separator className="mb-4" />

      {/* 管理与账户 */}
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("ui.settings.perms.manage_account_title")}</h4>
      <div className="mb-4 grid gap-px sm:grid-cols-2">
        {permItem(t("ui.settings.perms.manage_guest_visibility"), m.manageGuestVisibility, (v) => patch({ memberPerms: { manageGuestVisibility: !!v } }))}
        {permItem(t("ui.settings.perms.change_password"), m.changePassword, (v) => patch({ memberPerms: { changePassword: !!v } }))}
      </div>

      <Separator className="mb-5" />

      {/* ===== 访客权限 ===== */}
      <h3 className="mb-4 text-sm font-medium">{t("ui.settings.perms.guest_perms_title")}</h3>
      {/* 访客写权限总开关：访客没有 fileWrite，下面三个写子权限只有在总开关打开时才
          生效（服务端 effectivePerms 也是这么算的）。这样"允许匿名访客改文件"
          必须是单独一次明确决定，而不是顺手勾了一个看起来无害的子项。 */}
      <div className="mb-3 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("ui.settings.perms.guest_write")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("ui.settings.perms.guest_write_hint")}</p>
          </div>
          <Switch checked={!!config.guestWrite} onCheckedChange={(v) => patch({ guestWrite: !!v })} />
        </div>
      </div>
      <div className="mb-4 grid gap-px sm:grid-cols-2">
        {permItem(t("ui.settings.perms.browse"), g.browse, (v) => patch({ guestPerms: { browse: !!v } }))}
        {permItem(t("ui.settings.perms.download_file"), g.downloadFile, (v) => patch({ guestPerms: { downloadFile: !!v } }))}
        {permItem(t("ui.settings.perms.download_folder"), g.downloadFolder, (v) => patch({ guestPerms: { downloadFolder: !!v } }))}
        {permItem(t("ui.settings.perms.preview"), g.preview, (v) => patch({ guestPerms: { preview: !!v } }))}
        {permItem(t("ui.settings.perms.html_preview"), g.htmlPreview, (v) => patch({ guestPerms: { htmlPreview: !!v } }))}
        {permItem(t("ui.settings.perms.compress_zip"), gw && g.compressZip, (v) => patch({ guestPerms: { compressZip: !!v } }), !gw)}
        {permItem(t("ui.settings.perms.extract_zip"), gw && g.extractZip, (v) => patch({ guestPerms: { extractZip: !!v } }), !gw)}
        {permItem(t("ui.settings.perms.edit_files"), gw && g.editFiles, (v) => patch({ guestPerms: { editFiles: !!v } }), !gw)}
      </div>

      {/* 隐藏文件夹 */}
      <Separator className="mb-3" />
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{t("ui.settings.perms.hidden_paths_title")}</p>
          <Button size="xs" variant="outline" onClick={() => setPickHidden(true)}>
            <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.settings.perms.pick_dir")}
          </Button>
        </div>
        {config.guestHiddenPaths.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("ui.settings.perms.hidden_paths_empty")}</p>
        ) : (
          <div className="grid gap-1.5">
            {config.guestHiddenPaths.map((p) => (
              <div key={p} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
                <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
                  <Icon name="eye-off" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">/{p}</span>
                </span>
                <Button size="xs" variant="ghost" className="shrink-0" onClick={() => unhide(p)}>{t("ui.settings.perms.unhide_confirm_action")}</Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <PathPicker open={pickHidden} onOpenChange={setPickHidden} onPick={hidePath} />
    </div>
  )
}

function permItem(label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) {
  return (
    <div className={"flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/30" + (disabled ? " opacity-50" : "")}>
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

/* ==================== 安全 ==================== */
function SecuritySection() {
  const t = useT()
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

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  const trustProxy = status?.trustProxy
  const ipMode = trustProxy === undefined
    ? t("ui.common.unknown")
    : trustProxy === false
      ? t("ui.settings.security.ip_mode_direct")
      : t("ui.settings.security.ip_mode_trust", { value: Array.isArray(trustProxy) ? trustProxy.join(", ") : String(trustProxy) })

  return (
    <div className="grid gap-5">
      {/* 接口限流 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-1 text-sm font-medium">{t("ui.settings.security.rate_limit_title")}</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          {t("ui.settings.security.rate_limit_desc")}
        </p>
        <div className="mb-4 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">{t("ui.settings.security.rate_limit_enable")}</span>
          <Switch checked={config.rateLimitEnabled} onCheckedChange={(v) => patch({ rateLimitEnabled: !!v })} />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-sm text-muted-foreground">{t("ui.settings.security.rate_limit_per_min")}</span>
            <Input className="w-24 text-right" inputMode="numeric" value={ratePerMin} onChange={(e) => setRatePerMin(e.target.value)} />
            <span className="text-xs text-muted-foreground">{t("ui.settings.security.unit_times")}</span>
          </div>
          <Button size="sm" onClick={() => patch({ rateLimitPerMin: Number(ratePerMin) }, t("ui.settings.security.rate_limit_updated"))}>{t("ui.common.save")}</Button>
        </div>
      </div>

      {/* 解压保护 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-1 text-sm font-medium">{t("ui.settings.security.extract_protection_title")}</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          {t("ui.settings.security.extract_protection_desc")}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-sm text-muted-foreground">{t("ui.settings.security.extract_max_total")}</span>
            <Input className="w-24 text-right" inputMode="numeric" value={extractTotal} onChange={(e) => setExtractTotal(e.target.value)} />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
          <Button size="sm" onClick={() => patch({ extractMaxTotalMB: Number(extractTotal) }, t("ui.settings.security.extract_limit_updated"))}>{t("ui.common.save")}</Button>
        </div>
      </div>

      {/* 其他开关 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-4 text-sm font-medium">{t("ui.settings.security.other_switches_title")}</h3>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ui.settings.security.soft_dir_allow_copy_out")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.security.soft_dir_allow_copy_out_hint")}</p>
            </div>
            <Switch checked={config.softDirAllowCopyOut} onCheckedChange={(v) => patch({ softDirAllowCopyOut: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ui.settings.security.job_status_owner_only")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.security.job_status_owner_only_hint")}</p>
            </div>
            <Switch checked={config.jobStatusOwnerOnly} onCheckedChange={(v) => patch({ jobStatusOwnerOnly: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ui.settings.security.download_url_allow_private")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.security.download_url_allow_private_hint")}</p>
            </div>
            <Switch checked={config.downloadUrlAllowPrivate} onCheckedChange={(v) => patch({ downloadUrlAllowPrivate: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ui.settings.security.csrf_origin_check")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.settings.security.csrf_origin_check_hint")}</p>
            </div>
            <Switch checked={config.csrfOriginCheck} onCheckedChange={(v) => patch({ csrfOriginCheck: !!v })} />
          </div>
        </div>
      </div>
      <div className="edge-highlight rounded-xl border border-border bg-card p-5">
        <h3 className="mb-3 text-sm font-medium">{t("ui.settings.security.client_ip_title")}</h3>
        <div className="flex items-center gap-2">
          <Badge variant={trustProxy === undefined || trustProxy === false ? "secondary" : "default"} className="shrink-0 text-[10px]">{ipMode}</Badge>
          <span className="text-xs text-muted-foreground">{t("ui.settings.security.client_ip_badge_hint")}</span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("ui.settings.security.trust_proxy_desc_a")}<code className="font-mono">TRUST_PROXY</code>{t("ui.settings.security.trust_proxy_desc_b")}<code className="font-mono">loopback</code>{t("ui.settings.security.trust_proxy_desc_c")}
        </p>
      </div>
    </div>
  )
}

/* ==================== 公网 ==================== */
function TunnelSection() {
  const t = useT()
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
  React.useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer) }, [load])

  const apply = async (next: { enabled: boolean; mode: string; customHost: string }) => {
    setBusy(true)
    try {
      const d = await api.post<{ config: typeof next; status: TunnelStatus }>("/admin/tunnel", next)
      setConfig(d.config)
      setStatus(d.status)
      if (next.enabled) {
        if (d.status.running) {
          toast.success(d.status.url ? t("ui.settings.tunnel.connected") : t("ui.settings.tunnel.starting"))
        } else {
          toast.warning(t("ui.settings.tunnel.start_failed"))
        }
      } else {
        toast.success(t("ui.settings.tunnel.disabled_toast"))
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

  if (!config) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* 配置区：行内 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 text-sm font-medium">{t("ui.settings.tunnel.title")}</h3>
        <p className="mb-4 text-xs text-muted-foreground">{t("ui.settings.tunnel.desc")}</p>
        <div className="grid gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("ui.settings.tunnel.enable_label")}</span>
            <Switch checked={config.enabled} disabled={busy} onCheckedChange={(v) => apply({ ...config, enabled: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{t("ui.settings.tunnel.service_label")}</span>
            <Select value={config.mode} onValueChange={handleModeChange}>
              <SelectTrigger className="w-40"><SelectValue>{(v) => (v === "localhostrun" ? "localhost.run" : v === "serveo" ? "serveo.net" : v === "custom" ? t("ui.settings.tunnel.mode_custom_ssh") : "pinggy.io")}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="pinggy">{t("ui.settings.tunnel.mode_pinggy")}</SelectItem>
                <SelectItem value="localhostrun">localhost.run</SelectItem>
                <SelectItem value="serveo">serveo.net</SelectItem>
                <SelectItem value="custom">{t("ui.settings.tunnel.mode_custom_ssh")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.mode === "custom" && (
            <div className="grid gap-2">
              <Label htmlFor="custom-host">{t("ui.settings.tunnel.custom_host_label")}</Label>
              <Input id="custom-host" placeholder="user@example.com:22" value={config.customHost} onChange={(e) => setConfig({ ...config, customHost: e.target.value })} />
              <p className="text-xs text-muted-foreground">{t("ui.settings.tunnel.custom_host_hint")}</p>
            </div>
          )}
          {config.enabled && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => apply(config)}><Icon name="rotate-cw" /> {t("ui.settings.tunnel.apply_reconnect")}</Button>
          )}
        </div>
      </div>

      {/* 状态区：输出 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          {t("ui.settings.tunnel.runtime_status")}
          <Badge variant={status?.running ? "default" : "secondary"}>{status?.running ? t("ui.settings.tunnel.running") : t("ui.settings.tunnel.not_running")}</Badge>
        </h3>
        {status?.url && (
          <div className="mb-3"><Label>{t("ui.settings.tunnel.public_url")}</Label><Input readOnly value={status.url} className="mt-1 h-7 font-mono text-xs" onFocus={(e) => e.target.select()} /></div>
        )}
        <p className="mb-2 text-xs text-muted-foreground">{status?.restarts ? t("ui.settings.tunnel.reconnect_count", { count: status.restarts }) : t("ui.settings.tunnel.log_placeholder")}</p>
        <ScrollArea className="h-56 rounded-md border border-border bg-muted/30 p-2">
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{status?.output?.length ? status.output.join("\n") : t("ui.settings.tunnel.no_output")}</pre>
        </ScrollArea>
      </div>
    </div>
  )
}
