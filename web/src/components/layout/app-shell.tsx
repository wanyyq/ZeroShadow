/* eslint-disable react-refresh/only-export-components */
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
import { animatePageIn, animateSidebarIn, animateThemeSwap } from "@/lib/lucide"
import { VERSION } from "@/version"
import { cn } from "@/lib/utils"
import { api, uploadAvatar } from "@/lib/api"
import { ownerForMe, primeAvatar } from "@/lib/avatar-cache"
import { fileToAvatarWebp } from "@/lib/avatar-image"
import { toast } from "sonner"
import type { Me } from "@/lib/types"

const ROLE_LABEL: Record<string, string> = { superadmin: "超级管理员", member: "团队成员", guest: "访客" }

function navItems(loggedIn: boolean) {
  const items = [{ path: "/", icon: "files", label: "文件" }]
  if (loggedIn) items.push({ path: "/team", icon: "clipboard-list", label: "团队" })
  items.push(
    { path: "/tools", icon: "wrench", label: "工具" },
    { path: "/settings", icon: "settings", label: "设置" },
    { path: "/about", icon: "info", label: "软件开源信息" }
  )
  return items
}

// 桌面侧边栏的折叠状态现在由 ClientSettingsProvider 统一持有
// （键 zs-client-settings.sidebarCollapsed），这样「设置 → 外观」也能改它，
// 并且会从旧的 zs-sidebar-collapsed 键自动迁移。

/** 复制纯文本并给出反馈；隐私模式等场景下 navigator.clipboard 可能不可用 */
function copyLink(text: string, okMsg: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error("复制失败，请手动复制")
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
      <Icon name="external-link" /> 在新标签页打开
    </ContextMenuItem>,
    <ContextMenuItem key="copy" onClick={() => copyLink(new URL(path, window.location.origin).href, `已复制「${label}」的链接`)}>
      <Icon name="clipboard-copy" /> 复制链接
    </ContextMenuItem>,
  ]
}

interface ShellContextValue {
  searchText: string
  searchEl: React.ReactNode
  onSearchChange: (v: string) => void
}
const ShellContext = React.createContext<ShellContextValue>({ searchText: "", searchEl: null, onSearchChange: () => {} })
export function useShellSearch() { return React.useContext(ShellContext) }

function UserCard({ open, onOpenChange, me, logout, navigate, themeIcon, cycleTheme }: {
  open: boolean; onOpenChange: (o: boolean) => void; me: Me;
  logout: () => Promise<void>; navigate: (p: string) => void; themeIcon: string; cycleTheme: () => void;
}) {
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
      toast.success("头像已更新")
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
      toast.success(res.message || "密码已修改")
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
            <DialogHeader><DialogTitle>修改密码</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="old-pwd">旧密码</Label>
                <Input id="old-pwd" type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} autoFocus />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-pwd">新密码（至少 6 位）</Label>
                <Input id="new-pwd" type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} />
              </div>
              {me.role === "member" && (
                <p className="text-xs text-muted-foreground">若忘记密码，请联系超级管理员重置</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPwd(false)}>取消</Button>
              <Button onClick={changePwd} disabled={busy || !oldPwd || newPwd.length < 6}>
                {busy && <Icon name="loader-2" className="animate-spin" />} 确定
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader><DialogTitle>账户</DialogTitle></DialogHeader>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="group relative shrink-0 rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
                title="点击更换头像"
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
                <p className="text-sm text-muted-foreground">{ROLE_LABEL[me.role]}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">头像自动裁剪为 128×128</p>
              </div>
            </div>
            <div className="mt-4 grid gap-1">
              {me.role === "member" && me.perms.changePassword && (
                <button
                  onClick={() => { if (me.role === "superadmin") { toast.info("超级管理员密码请编辑 .env 文件中的 SUPER_ADMIN_PASSWORD，改后重启"); return }; setShowPwd(true); setOldPwd(""); setNewPwd("") }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon name="key" className="size-[18px]" /> 修改密码
                </button>
              )}
              {me.role === "member" && !me.perms.changePassword && (
                <button
                  disabled
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/40"
                >
                  <Icon name="key" className="size-[18px]" /> 修改密码（无权限）
                </button>
              )}
              {me.role === "superadmin" && (
                <button
                  onClick={() => toast.info("超级管理员密码请编辑 .env 中的 SUPER_ADMIN_PASSWORD，改后重启服务", { duration: 6000 })}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon name="key" className="size-[18px]" /> 修改密码（编辑 .env）
                </button>
              )}
              <button onClick={cycleTheme} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <Icon name={themeIcon} className="size-[18px]" />
                {themeIcon === "sun" ? "浅色模式" : themeIcon === "moon" ? "深色模式" : "跟随系统"}
              </button>
              <button onClick={async () => { await logout(); navigate("/"); onOpenChange(false) }} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10">
                <Icon name="log-out" className="size-[18px]" /> 退出登录
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function GroupSwitcher() {
  const { groups, currentId, setCurrent, refresh: refreshGroups } = useGroups()
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  if (me.role === "guest") return null
  const onChange = (v: string | null) => {
    setCurrent(v || "default")
    void refresh()
    navigate("/")
  }
  const label = currentId === "default" ? "默认" : groups.find((g) => g.id === currentId)?.name || "默认"
  return (
    <Select
      value={currentId}
      onValueChange={onChange}
      // 打开时重拉一次列表：否则在「设置 → 小组」里刚建/删的小组，要刷新整页才会出现在这里
      onOpenChange={(open) => { if (open) void refreshGroups() }}
    >
      <SelectTrigger className="h-8 w-28 text-xs sm:w-32" size="sm" title="切换小组身份">
        <Icon name="layers" className="size-3.5 shrink-0" />
        <SelectValue render={(_p, s) => <>{s.value === "default" ? "默认" : groups.find((g) => g.id === s.value)?.name || "默认"}</>}>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">默认</SelectItem>
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
  const navigate = useNavigate()
  const location = useLocation()
  const { me, logout, refresh } = useAuth()
  const { theme, setTheme } = useTheme()
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [userCardOpen, setUserCardOpen] = React.useState(false)
  const [searchText, setSearchText] = React.useState("")
  const { sidebarCollapsed: collapsed, update: updateSettings } = useClientSettings()

  // —— GSAP 动画挂载点（全部在 lib/lucide.ts 里判断「减少动画」，开了就自动跳过）——
  const pageRef = React.useRef<HTMLDivElement>(null)
  const sidebarNavRef = React.useRef<HTMLDivElement>(null)
  const firstThemeRef = React.useRef(true)
  // 换页面时重放一次入场动画
  React.useEffect(() => {
    animatePageIn(pageRef.current)
  }, [location.pathname])
  // 侧边栏首次出现时错落入场，只跑一次
  React.useEffect(() => {
    animateSidebarIn(sidebarNavRef.current)
  }, [])
  // 明暗切换时轻微淡入；首次挂载不播（否则会闪一下）
  React.useEffect(() => {
    if (firstThemeRef.current) {
      firstThemeRef.current = false
      return
    }
    animateThemeSwap(document.documentElement)
  }, [theme])

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

  const searchEl = (
    <form
      className="relative hidden max-w-xs sm:block"
      onSubmit={(e) => { e.preventDefault(); submitSearch() }}
    >
      <Icon name="search" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={searchText}
        placeholder="搜索文件…"
        className="h-8 border-transparent bg-muted/50 pl-8 text-sm focus:bg-background hover:bg-muted"
        onChange={(e) => setSearchText(e.target.value)}
      />
    </form>
  )

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
          <Icon name="list-checks" /> 团队待办
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => { navigate("/settings"); setMobileOpen(false) }}>
        <Icon name="settings" /> 打开设置
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Icon name={themeIcon} /> 主题
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => setTheme("light")}><Icon name="sun" /> 浅色</ContextMenuItem>
          <ContextMenuItem onClick={() => setTheme("dark")}><Icon name="moon" /> 深色</ContextMenuItem>
          <ContextMenuItem onClick={() => setTheme("system")}><Icon name="monitor" /> 跟随系统</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={toggleCollapsed}>
        <Icon name={collapsed ? "panel-left-open" : "panel-left-close"} />
        {collapsed ? "展开侧边栏" : "收起侧边栏"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyLink(window.location.href, "已复制当前页面链接")}>
        <Icon name="clipboard-copy" /> 复制当前页面链接
      </ContextMenuItem>
      <ContextMenuItem onClick={() => window.location.reload()}>
        <Icon name="refresh-cw" /> 重新载入页面
      </ContextMenuItem>
    </ContextMenuContent>
  )

  return (
    <ShellContext.Provider value={{ searchText, searchEl, onSearchChange: setSearchText }}>
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
              <ContextMenuTrigger render={<div ref={sidebarNavRef} className="flex min-h-full flex-col gap-0.5" />}>
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
              label={collapsed ? "展开侧边栏" : "收起侧边栏"}
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
              <Input value={searchText} placeholder="搜索…" className="h-8 pl-8 text-sm bg-muted/50 border-transparent"
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
              />
            </div>

            <div className="hidden flex-1 sm:block" />
            {/* 居右顺序固定为：主题切换 → 身份（小组）切换 → 用户头像 + 名字 */}
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={cycleTheme}
                title={theme === "light" ? "当前：浅色（点击切换）" : theme === "dark" ? "当前：深色（点击切换）" : "当前：跟随系统（点击切换）"}
                aria-label="切换主题"
                className="hidden rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
              >
                <Icon name={themeIcon} className="size-[18px]" />
              </button>
              <GroupSwitcher />
              {me.role === "guest" ? (
                <Button size="sm" variant="ghost" onClick={() => navigate("/login")}>
                  <Icon name="log-in" className="size-3.5" /> 登录
                </Button>
              ) : (
                <ContextMenu>
                  <ContextMenuTrigger
                    render={<div className="flex items-center" />}
                  >
                    <button
                      onClick={() => setUserCardOpen(true)}
                      title={`${me.username}（${ROLE_LABEL[me.role] || me.role}）`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                    >
                      <Avatar owner={ownerForMe(me)} name={me.username} size={24} />
                      <span className="hidden max-w-24 truncate text-muted-foreground sm:inline">{me.username}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    <ContextMenuItem onClick={() => setUserCardOpen(true)}>
                      <Icon name="user-round" /> 账户面板
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => copyLink(me.username || "", "已复制用户名")}>
                      <Icon name="clipboard-copy" /> 复制用户名
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => { void refresh(); toast.success("已刷新账户信息") }}>
                      <Icon name="refresh-cw" /> 刷新账户信息
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onClick={async () => { await logout(); navigate("/") }}>
                      <Icon name="log-out" /> 退出登录
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
          {/* 页面容器：每次换路由做一次轻微的入场动画（见 lib/lucide.ts，尊重「减少动画」） */}
          <div ref={pageRef} className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
        </div>

        <UserCard open={userCardOpen} onOpenChange={setUserCardOpen} me={me} logout={logout} navigate={navigate} themeIcon={themeIcon} cycleTheme={cycleTheme} />
      </div>
    </ShellContext.Provider>
  )
}
