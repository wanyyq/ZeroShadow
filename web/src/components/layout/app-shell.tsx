import * as React from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/icon"
import { Avatar } from "@/components/avatar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/state/auth"
import { useGroups } from "@/state/groups"
import { useClientSettings } from "@/state/client-settings"
import { VERSION } from "@/version"
import { cn } from "@/lib/utils"
import { translate, useT } from "@/lib/i18n"
import { api, uploadAvatar } from "@/lib/api"
import { ownerForMe, primeAvatar } from "@/lib/avatar-cache"
import { fileToAvatarWebp } from "@/lib/avatar-image"
import { toast } from "sonner"
import type { Me } from "@/lib/types"

/** 角色显示名。角色值本身（superadmin / member / guest）是判断用的，不能翻译。 */
function roleLabel(role: string) {
  if (role === "superadmin") return translate("ui.shell.role.superadmin")
  if (role === "member") return translate("ui.shell.role.member")
  if (role === "guest") return translate("ui.shell.role.guest")
  return role
}

function navItems(loggedIn: boolean) {
  const items = [{ path: "/", icon: "files", label: translate("ui.shell.nav.files") }]
  if (loggedIn) items.push({ path: "/team", icon: "clipboard-list", label: translate("ui.shell.nav.team") })
  items.push(
    { path: "/tools", icon: "wrench", label: translate("ui.shell.nav.tools") },
    { path: "/settings", icon: "settings", label: translate("ui.shell.nav.settings") },
    { path: "/about", icon: "info", label: translate("ui.shell.nav.about") }
  )
  return items
}

// 桌面侧边栏的折叠状态现在由 ClientSettingsProvider 统一持有
// （键 zs-client-settings.sidebarCollapsed），这样「设置 → 外观」也能改它，
// 并且会从旧的 zs-sidebar-collapsed 键自动迁移。

/** 复制纯文本并给出反馈。
 *  必须显式判断 navigator.clipboard 是否存在：可选链在它缺失时会让整条
 *  then 短路，成功与失败回调都不执行 —— 用户点了「复制链接」毫无反应。 */
function copyLink(text: string, okMsg: string) {
  const clipboard = navigator.clipboard
  if (!clipboard?.writeText) {
    toast.error(translate("ui.shell.copy_unsupported"))
    return
  }
  void clipboard.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error(translate("ui.shell.copy_failed"))
  )
}

/**
 * 侧边栏统一行（品牌、导航、折叠按钮共用）。
 *
 * 对齐的关键：图标固定放在 32px 的槽里、外层 px-2、间距 gap-2.5 —— 三者对所有行一致，
 * 所以展开时所有文字都从同一条竖线开始，折叠时所有图标都落在栏的水平中心。
 * 旧实现里品牌用的是 gap-2.5 + 32px 图标、导航用的是 gap-3 + 18px 图标，
 * 折叠时品牌还留着 gap，于是文字与图标都对不齐。
 *
 * 右键菜单挂在外面那层 div 上（而不是 render 到 button 上）：Base UI 的 render 合并
 * 有可能吞掉 render 元素上的 React 事件，导航点击不能冒这个风险。
 */
function SidebarRow({
  icon, label, collapsed, active, onClick, danger, contextItems,
}: {
  icon: string
  label: string
  collapsed: boolean
  active?: boolean
  onClick: () => void
  danger?: boolean
  contextItems?: React.ReactNode
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center rounded-lg text-sm transition-colors duration-150 outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        collapsed ? "mx-auto size-9 justify-center gap-0" : "gap-2.5 px-2 py-1.5",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : active
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center">
        <Icon name={icon} className="size-[18px]" />
      </span>
      <span className={cn("truncate transition-all duration-200 ease-out", collapsed ? "w-0 overflow-hidden opacity-0" : "opacity-100")}>
        {label}
      </span>
    </button>
  )

  if (!contextItems) return button

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={cn(collapsed ? "mx-auto w-9" : "w-full")} />}>
        {button}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">{contextItems}</ContextMenuContent>
    </ContextMenu>
  )
}

/** 导航项的右键菜单：新标签页打开 / 复制链接 */
function navContextItems(path: string, label: string) {
  return [
    <ContextMenuItem key="newtab" onClick={() => window.open(path, "_blank", "noopener")}>
      <Icon name="external-link" /> {translate("ui.common.open_new_tab")}
    </ContextMenuItem>,
    <ContextMenuItem key="copy" onClick={() => copyLink(new URL(path, window.location.origin).href, translate("ui.shell.copied_link_named", { label }))}>
      <Icon name="clipboard-copy" /> {translate("ui.common.copy_link")}
    </ContextMenuItem>,
  ]
}

interface ShellContextValue {
  searchText: string
  searchEl: React.ReactNode
  onSearchChange: (v: string) => void
}

const ShellContext = React.createContext<ShellContextValue>({
  searchText: "",
  searchEl: null,
  onSearchChange: () => {},
})

/**
 * 外壳搜索上下文。
 *
 * 历史：这里曾导出 `useShellSearch()` 让页面接管顶栏搜索框，但从来没有消费者
 * （文件浏览器的搜索框在自己的工具栏里），`searchEl` 也从未被渲染。现在它只
 * 作为一个包装用的 Provider 存在，`searchEl` 恒为 null —— 新增页面不要再依赖它，
 * 顶栏搜索相关的需求请直接看 AppShell 里的 searchText/submitSearch。
 */
function UserCard({ open, onOpenChange, me, logout, navigate, themeIcon, cycleTheme }: {
  open: boolean; onOpenChange: (o: boolean) => void; me: Me;
  logout: () => Promise<void>; navigate: (p: string) => void; themeIcon: string; cycleTheme: () => void;
}) {
  const t = useT()
  const [showPwd, setShowPwd] = React.useState(false)
  const [oldPwd, setOldPwd] = React.useState("")
  const [newPwd, setNewPwd] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const owner = ownerForMe(me)

  const onPickAvatar = async (file: File | undefined) => {
    if (!file || !owner) return
    setUploading(true)
    try {
      const blob = await fileToAvatarWebp(file)
      const meta = await uploadAvatar("me", blob)
      await primeAvatar(meta.owner, meta.md5, blob)
      toast.success(t("ui.shell.avatar_updated"))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const changePwd = async () => {
    if (!oldPwd || newPwd.length < 6) return
    setBusy(true)
    try {
      const res = await api.post<{ ok: boolean; message: string }>("/auth/change-password", { oldPassword: oldPwd, newPassword: newPwd })
      toast.success(res.message || t("ui.shell.password_changed"))
      setShowPwd(false); onOpenChange(false)
      await logout(); navigate("/")
    } catch (e) { toast.error((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        {showPwd ? (
          <>
            <DialogHeader><DialogTitle>{t("ui.shell.change_password")}</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="old-pwd">{t("ui.shell.old_password")}</Label>
                <Input id="old-pwd" type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} autoFocus />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-pwd">{t("ui.shell.new_password_label")}</Label>
                <Input id="new-pwd" type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} />
              </div>
              {me.role === "member" && (
                <p className="text-xs text-muted-foreground">{t("ui.shell.forgot_password_hint")}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPwd(false)}>{t("ui.common.cancel")}</Button>
              <Button onClick={changePwd} disabled={busy || !oldPwd || newPwd.length < 6}>
                {busy && <Icon name="loader-2" className="animate-spin" />} {t("ui.common.ok")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader><DialogTitle>{t("ui.shell.account")}</DialogTitle></DialogHeader>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="group relative shrink-0 rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
                title={t("ui.shell.change_avatar")}
              >
                <Avatar owner={owner} name={me.username} size={56} />
                <span className={cn(
                  "absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100",
                  uploading && "opacity-100"
                )}>
                  <Icon name={uploading ? "loader-2" : "camera"} className={cn("size-4", uploading && "animate-spin")} />
                </span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onPickAvatar(e.target.files?.[0])}
              />
              <div className="min-w-0">
                <p className="text-base font-semibold">{me.username}</p>
                <p className="text-sm text-muted-foreground">{roleLabel(me.role)}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t("ui.shell.avatar_crop_hint")}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-1">
              {me.role === "member" && me.perms.changePassword && (
                <button
                  onClick={() => { if (me.role === "superadmin") { toast.info(t("ui.shell.superadmin_pwd_env_hint")); return }; setShowPwd(true); setOldPwd(""); setNewPwd("") }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon name="key" className="size-[18px]" /> {t("ui.shell.change_password")}
                </button>
              )}
              {me.role === "member" && !me.perms.changePassword && (
                <button
                  disabled
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/40"
                >
                  <Icon name="key" className="size-[18px]" /> {t("ui.shell.change_password_no_perm")}
                </button>
              )}
              {me.role === "superadmin" && (
                <button
                  onClick={() => toast.info(t("ui.shell.superadmin_pwd_env_restart_hint"), { duration: 6000 })}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon name="key" className="size-[18px]" /> {t("ui.shell.change_password_env")}
                </button>
              )}
              <button onClick={cycleTheme} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <Icon name={themeIcon} className="size-[18px]" />
                {themeIcon === "sun" ? t("ui.shell.theme_light_mode") : themeIcon === "moon" ? t("ui.shell.theme_dark_mode") : t("ui.common.platform_theme_system")}
              </button>
              <button onClick={async () => { await logout(); navigate("/"); onOpenChange(false) }} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10">
                <Icon name="log-out" className="size-[18px]" /> {t("ui.shell.logout")}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function GroupSwitcher() {
  const t = useT()
  const { groups, currentId, setCurrent, refresh: refreshGroups } = useGroups()
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  if (me.role === "guest") return null
  const onChange = (v: string | null) => {
    setCurrent(v || "default")
    void refresh()
    navigate("/")
  }
  const label = currentId === "default" ? t("ui.shell.group_default") : groups.find((g) => g.id === currentId)?.name || t("ui.shell.group_default")
  return (
    <Select
      value={currentId}
      onValueChange={onChange}
      // 打开时重拉一次列表：否则在「设置 → 小组」里刚建/删的小组，要刷新整页才会出现在这里
      onOpenChange={(open) => { if (open) void refreshGroups() }}
    >
      <SelectTrigger className="h-8 w-28 text-xs sm:w-32" size="sm" title={t("ui.shell.switch_group_title")}>
        <Icon name="layers" className="size-3.5 shrink-0" />
        <SelectValue render={(_p, s) => <>{s.value === "default" ? t("ui.shell.group_default") : groups.find((g) => g.id === s.value)?.name || t("ui.shell.group_default")}</>}>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{t("ui.shell.group_default")}</SelectItem>
        {groups.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: g.color }} />
            {g.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { me, logout, refresh } = useAuth()
  const { theme, setTheme } = useTheme()
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [userCardOpen, setUserCardOpen] = React.useState(false)
  const [searchText, setSearchText] = React.useState("")
  const { sidebarCollapsed: collapsed, update: updateSettings } = useClientSettings()

  const toggleCollapsed = React.useCallback(() => {
    updateSettings({ sidebarCollapsed: !collapsed })
  }, [updateSettings, collapsed])

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/"
    return location.pathname.startsWith(path)
  }

  const themeIcon = theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"
  const cycleTheme = () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")

  const submitSearch = () => {
    const q = searchText.trim()
    if (q) navigate(`/?q=${encodeURIComponent(q)}`)
    else navigate("/")
  }

  // 搜索框：宽屏不在顶栏（在文件浏览器自己的工具栏里），只有窄屏这里有一个。
  // 原先这里还构造过一个 `searchEl`（宽屏用的表单）通过 ShellContext 往外传，
  // 但从未有任何页面消费它、也从未渲染过，已删除。

  // 导航行：折叠时只留图标（窄屏抽屉传 false，始终完整显示）
  const sidebarNav = (isCollapsed: boolean) => (
    <div className="flex flex-col gap-0.5">
      {navItems(me.role !== "guest").map((item) => (
        <SidebarRow
          key={item.path}
          icon={item.icon}
          label={item.label}
          collapsed={isCollapsed}
          active={isActive(item.path)}
          onClick={() => { navigate(item.path); setMobileOpen(false) }}
          contextItems={navContextItems(item.path, item.label)}
        />
      ))}
    </div>
  )

  // 侧边栏空白处右键：与单个导航项的菜单互补，这里放全局动作。
  // 菜单挂在导航区的外层，点空白处（列表下方那片）也能唤出。
  const sidebarBackgroundMenu = (
    <ContextMenuContent className="w-52">
      {me.role !== "guest" && (
        <ContextMenuItem onClick={() => { navigate("/team"); setMobileOpen(false) }}>
          <Icon name="list-checks" /> {t("ui.team.page_title")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => { navigate("/settings"); setMobileOpen(false) }}>
        <Icon name="settings" /> {t("ui.shell.open_settings")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Icon name={themeIcon} /> {t("ui.shell.theme")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => setTheme("light")}><Icon name="sun" /> {t("ui.common.platform_theme_light")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setTheme("dark")}><Icon name="moon" /> {t("ui.common.platform_theme_dark")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setTheme("system")}><Icon name="monitor" /> {t("ui.common.platform_theme_system")}</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={toggleCollapsed}>
        <Icon name={collapsed ? "panel-left-open" : "panel-left-close"} />
        {collapsed ? t("ui.shell.sidebar_expand") : t("ui.shell.sidebar_collapse")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyLink(window.location.href, t("ui.shell.copied_page_link"))}>
        <Icon name="clipboard-copy" /> {t("ui.shell.copy_page_link")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => window.location.reload()}>
        <Icon name="refresh-cw" /> {t("ui.shell.reload_page")}
      </ContextMenuItem>
    </ContextMenuContent>
  )

  return (
    // 这里的 Provider 只是把外壳包起来（搜索框在窄屏顶栏里直接用局部 state）。
    // 原先它还通过 context 外传 useShellSearch / searchEl 给页面接管顶栏搜索，
    // 但从未有任何消费者、searchEl 也从未渲染，那套接口已删除。
    <ShellContext.Provider value={{ searchText, searchEl: null, onSearchChange: setSearchText }}>
      <div className="flex h-dvh overflow-hidden">
        {/* 桌面侧边栏（可折叠为仅图标；窄屏隐藏，改用下方抽屉） */}
        <aside
          className={cn(
            "hidden h-full shrink-0 flex-col overflow-hidden border-r border-border/40 transition-[width] duration-200 ease-out sm:flex",
            collapsed ? "w-14" : "w-48"
          )}
        >
          <div className="flex flex-1 flex-col overflow-y-auto px-2 pt-3">
            <ContextMenu>
              {/* min-h-full 让触发区铺满可见高度，列表下方的空白处也能右键 */}
              <ContextMenuTrigger render={<div className="flex min-h-full flex-col gap-0.5" />}>
                {/* 品牌：与导航行共用同一套栅格（32px 图标槽 + gap-2.5 + px-2），保证文字与图标都对齐 */}
                <div
                  className={cn(
                    "mb-3 flex items-center rounded-lg",
                    collapsed ? "mx-auto size-9 justify-center gap-0" : "gap-2.5 px-2 py-1.5"
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Icon name="hard-drive" className="size-4" />
                  </span>
                  <div className={cn("min-w-0 transition-all duration-200 ease-out", collapsed ? "w-0 overflow-hidden opacity-0" : "opacity-100")}>
                    <p className="text-sm leading-tight font-semibold">ZeroShadow</p>
                    <p className="text-[10px] leading-tight text-muted-foreground">v{VERSION}</p>
                  </div>
                </div>
                {sidebarNav(collapsed)}
              </ContextMenuTrigger>
              {sidebarBackgroundMenu}
            </ContextMenu>
          </div>

          {/* 折叠开关：与导航行同栅格 —— 展开时和导航左对齐，折叠时图标落在同一竖线上 */}
          <div className="shrink-0 border-t border-border/40 px-2 py-2">
            <SidebarRow
              icon={collapsed ? "panel-left-open" : "panel-left-close"}
              label={collapsed ? t("ui.shell.sidebar_expand") : t("ui.shell.sidebar_collapse")}
              collapsed={collapsed}
              onClick={toggleCollapsed}
            />
          </div>
        </aside>

        {/* 右侧内容 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 顶栏 */}
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/30 px-3">
            <Button size="icon-sm" variant="ghost" className="sm:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
              <Icon name={mobileOpen ? "x" : "menu"} className="size-5" />
            </Button>

            {/* 手机端搜索 */}
            <div className="relative flex-1 sm:hidden">
              <Icon name="search" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchText} placeholder={t("ui.shell.search_placeholder")} className="h-8 pl-8 text-sm bg-muted/50 border-transparent"
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
              />
            </div>

            <div className="hidden flex-1 sm:block" />
            {/* 居右顺序固定为：主题切换 → 身份（小组）切换 → 用户头像 + 名字 */}
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={cycleTheme}
                title={theme === "light" ? t("ui.shell.theme_tip_light") : theme === "dark" ? t("ui.shell.theme_tip_dark") : t("ui.shell.theme_tip_system")}
                aria-label={t("ui.shell.switch_theme")}
                className="hidden rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
              >
                <Icon name={themeIcon} className="size-[18px]" />
              </button>
              <GroupSwitcher />
              {me.role === "guest" ? (
                <Button size="sm" variant="ghost" onClick={() => navigate("/login")}>
                  <Icon name="log-in" className="size-3.5" /> {t("ui.shell.login")}
                </Button>
              ) : (
                <ContextMenu>
                  <ContextMenuTrigger
                    render={<div className="flex items-center" />}
                  >
                    <button
                      onClick={() => setUserCardOpen(true)}
                      title={t("ui.shell.user_title", { username: String(me.username), role: roleLabel(me.role) })}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                    >
                      <Avatar owner={ownerForMe(me)} name={me.username} size={24} />
                      <span className="hidden max-w-24 truncate text-muted-foreground sm:inline">{me.username}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    <ContextMenuItem onClick={() => setUserCardOpen(true)}>
                      <Icon name="user-round" /> {t("ui.shell.account_panel")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => copyLink(me.username || "", t("ui.shell.copied_username"))}>
                      <Icon name="clipboard-copy" /> {t("ui.shell.copy_username")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => { void refresh(); toast.success(t("ui.shell.account_refreshed")) }}>
                      <Icon name="refresh-cw" /> {t("ui.shell.refresh_account")}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onClick={async () => { await logout(); navigate("/") }}>
                      <Icon name="log-out" /> {t("ui.shell.logout")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )}
            </div>
          </header>

          {/* 手机抽屉 */}
          {mobileOpen && <div className="fixed inset-0 z-50 bg-black/20 sm:hidden" onClick={() => setMobileOpen(false)} />}
          <div className={cn("fixed inset-y-0 left-0 z-50 w-52 border-r border-border/30 bg-background transition-transform duration-200 ease-out sm:hidden",
            mobileOpen ? "translate-x-0" : "-translate-x-full")}>
            <div className="flex h-12 items-center gap-2.5 border-b border-border/30 px-3">
              <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"><Icon name="hard-drive" className="size-3.5" /></span>
              <span className="font-heading text-sm font-semibold">ZeroShadow <span className="font-normal text-muted-foreground">v{VERSION}</span></span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <ContextMenu>
                <ContextMenuTrigger render={<div className="flex min-h-full flex-col gap-1" />}>
                  {sidebarNav(false)}
                </ContextMenuTrigger>
                {sidebarBackgroundMenu}
              </ContextMenu>
            </div>
          </div>

          {/* 主内容 */}
          {/* 页面容器刻意不做入场动画：整页级别的 transform/opacity 会让浏览器
              每帧重新合成整屏，在低端机上直接掉帧。需要动效的地方都在小元素上做
              （列表错落见 lib/lucide.ts 的 animateListIn）。 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
        </div>

        <UserCard open={userCardOpen} onOpenChange={setUserCardOpen} me={me} logout={logout} navigate={navigate} themeIcon={themeIcon} cycleTheme={cycleTheme} />
      </div>
    </ShellContext.Provider>
  )
}
