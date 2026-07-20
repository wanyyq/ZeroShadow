import * as React from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/icon"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/state/auth"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { toast } from "sonner"

const ROLE_LABEL: Record<string, string> = { superadmin: "超级管理员", member: "团队成员", guest: "访客" }

const NAV = [
  { path: "/", icon: "files", label: "文件" },
  { path: "/settings", icon: "settings", label: "设置" },
]

interface ShellContextValue {
  searchText: string
  searchEl: React.ReactNode
  onSearchChange: (v: string) => void
}
const ShellContext = React.createContext<ShellContextValue>({ searchText: "", searchEl: null, onSearchChange: () => {} })
export function useShellSearch() { return React.useContext(ShellContext) }

function UserCard({ open, onOpenChange, me, logout, navigate, themeIcon, cycleTheme }: {
  open: boolean; onOpenChange: (o: boolean) => void; me: { role: string; username: string | null };
  logout: () => Promise<void>; navigate: (p: string) => void; themeIcon: string; cycleTheme: () => void;
}) {
  const [showPwd, setShowPwd] = React.useState(false)
  const [oldPwd, setOldPwd] = React.useState("")
  const [newPwd, setNewPwd] = React.useState("")
  const [busy, setBusy] = React.useState(false)

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
              <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-2xl font-medium">
                {me.username?.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-base font-semibold">{me.username}</p>
                <p className="text-sm text-muted-foreground">{ROLE_LABEL[me.role]}</p>
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { me, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [userCardOpen, setUserCardOpen] = React.useState(false)
  const [searchText, setSearchText] = React.useState("")

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

  const sidebarNav = (
    <div className="flex flex-col gap-1">
      {NAV.map((item) => (
        <button key={item.path} onClick={() => { navigate(item.path); setMobileOpen(false) }}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
            isActive(item.path) ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Icon name={item.icon} className="size-[18px] shrink-0" /> {item.label}
        </button>
      ))}
    </div>
  )

  return (
    <ShellContext.Provider value={{ searchText, searchEl, onSearchChange: setSearchText }}>
      <div className="flex h-dvh overflow-hidden">
        {/* 桌面侧边栏 */}
        <aside className="hidden h-full w-48 shrink-0 flex-col border-r border-border/40 sm:flex">
          <div className="flex flex-1 flex-col overflow-y-auto px-2 pt-4">
            <div className="mb-6 flex items-center gap-2.5 px-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Icon name="hard-drive" className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold leading-tight">Wangyq</p>
                <p className="text-[10px] leading-tight text-muted-foreground">ZeroShadow</p>
              </div>
            </div>
            {sidebarNav}
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
            <div className="ml-auto flex items-center gap-1">
              <button onClick={cycleTheme} title={theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统"}
                className="hidden rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex">
                <Icon name={themeIcon} className="size-[18px]" />
              </button>
              {me.role === "guest" ? (
                <Button size="sm" variant="ghost" onClick={() => navigate("/login")}>
                  <Icon name="log-in" className="size-3.5" /> 登录
                </Button>
              ) : (
                <button
                  onClick={() => setUserCardOpen(true)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-accent text-xs font-medium">
                    {me.username?.charAt(0).toUpperCase()}
                  </span>
                  <span className="hidden sm:inline text-muted-foreground">{me.username}</span>
                </button>
              )}
            </div>
          </header>

          {/* 手机抽屉 */}
          {mobileOpen && <div className="fixed inset-0 z-50 bg-black/20 sm:hidden" onClick={() => setMobileOpen(false)} />}
          <div className={cn("fixed inset-y-0 left-0 z-50 w-52 border-r border-border/30 bg-background transition-transform duration-200 ease-out sm:hidden",
            mobileOpen ? "translate-x-0" : "-translate-x-full")}>
            <div className="flex h-12 items-center gap-2.5 border-b border-border/30 px-3">
              <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"><Icon name="hard-drive" className="size-3.5" /></span>
              <span className="font-heading text-sm font-semibold">Wangyq ZeroShadow</span>
            </div>
            <div className="flex flex-col gap-1 p-3">{sidebarNav}</div>
          </div>

          {/* 主内容 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
        </div>

        <UserCard open={userCardOpen} onOpenChange={setUserCardOpen} me={me} logout={logout} navigate={navigate} themeIcon={themeIcon} cycleTheme={cycleTheme} />
      </div>
    </ShellContext.Provider>
  )
}
