import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { Icon } from "@/components/icon"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/state/auth"

const ROLE_LABEL: Record<string, string> = {
  superadmin: "超级管理员",
  member: "团队成员",
  guest: "访客",
}

export function AppHeader({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate()
  const { me, logout } = useAuth()
  const { theme, setTheme } = useTheme()

  return (
    <header className="edge-highlight sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
        <button
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-all duration-200 ease-out hover:opacity-70"
          onClick={() => navigate("/")}
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Icon name="hard-drive" className="size-4" />
          </span>
          <span className="font-heading text-base font-semibold tracking-tight">EPan</span>
        </button>
        <Badge variant="secondary" className="hidden sm:inline-flex">
          {ROLE_LABEL[me.role]}
        </Badge>

        <div className="flex-1">{children}</div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="切换主题" />}
          >
            <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <Icon name="sun" /> 浅色
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <Icon name="moon" /> 深色
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <Icon name="monitor" /> 跟随系统
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="设置"
          onClick={() => navigate("/settings")}
        >
          <Icon name="settings" />
        </Button>

        {me.role === "guest" ? (
          <Button size="sm" onClick={() => navigate("/login")}>
            <Icon name="log-in" /> 登录
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Icon name="user" />
              <span className="max-w-24 truncate">{me.username}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {me.username}
                <span className="block text-xs font-normal text-muted-foreground">
                  {ROLE_LABEL[me.role]}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await logout()
                  navigate("/")
                }}
              >
                <Icon name="log-out" /> 退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  )
}
