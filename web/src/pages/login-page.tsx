import * as React from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/icon"
import { useAuth } from "@/state/auth"
import { animatePageIn } from "@/lib/lucide"

export function LoginPage() {
  const navigate = useNavigate()
  const { login, me } = useAuth()
  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const cardRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    animatePageIn(cardRef.current)
  }, [])

  React.useEffect(() => {
    if (me.role !== "guest") navigate("/", { replace: true })
  }, [me.role, navigate])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const next = await login(username.trim(), password)
      toast.success(`欢迎回来，${next.username}`)
      navigate("/", { replace: true })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 items-center justify-center px-4">
        <div ref={cardRef} className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="font-heading text-xl font-semibold tracking-tight">Wangyq ZeroShadow</h1>
            <p className="text-xs text-muted-foreground">轻量 · 安全 · 局域网优先</p>
          </div>
          <Card className="edge-highlight">
            <CardHeader>
              <CardTitle>管理员登录</CardTitle>
              <CardDescription>超级管理员或团队成员账户</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    value={username}
                    autoComplete="username"
                    autoFocus
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">密码</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy || !username || !password}>
                  {busy ? <Icon name="loader-2" className="animate-spin" /> : <Icon name="log-in" />}
                  登录
                </Button>
                <Button type="button" variant="ghost" onClick={() => navigate("/")}>
                  以访客身份浏览
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
