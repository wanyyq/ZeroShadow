import * as React from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/icon"
import { LanguageSelect } from "@/components/language-select"
import { useAuth } from "@/state/auth"
import { ApiError } from "@/lib/api"
import { animatePageIn } from "@/lib/lucide"
import { useT } from "@/lib/i18n"

export function LoginPage() {
  const t = useT()
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
      toast.success(t("ui.login.welcome_back", { name: next.username ?? "" }))
      navigate("/", { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.error(t("ui.login.account_disabled"), {
          description: t("ui.login.account_disabled_desc"),
        })
      } else {
        toast.error((err as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col">
        {/* 未登录时顶栏没有语言入口，「设置 → 外观」也进不去：登录页自己在右上角放一个，
            首次访问（或看不懂中文）的人才能把界面切成自己的语言。 */}
        <div className="flex justify-end px-4 pt-3">
          <LanguageSelect />
        </div>
        <div className="flex flex-1 items-center justify-center px-4">
          <div ref={cardRef} className="w-full max-w-sm">
            <div className="mb-6 text-center">
              <h1 className="font-heading text-xl font-semibold tracking-tight">ZeroShadow</h1>
              <p className="text-xs text-muted-foreground">Copyright@Wanyyq 2026</p>
            </div>
            <Card className="edge-highlight">
              <CardHeader>
                <CardTitle>{t("ui.login.title")}</CardTitle>
                <CardDescription>{t("ui.login.subtitle")}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="username">{t("ui.login.username")}</Label>
                    <Input
                      id="username"
                      value={username}
                      autoComplete="username"
                      autoFocus
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="password">{t("ui.login.password")}</Label>
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
                    {t("ui.login.submit")}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => navigate("/")}>
                    {t("ui.login.browse_as_guest")}
                  </Button>
                </form>
              </CardContent>
            </Card>
            {/* 未登录时看不到文件浏览器底部的状态条，所以这里必须也给一个入口，
                否则"跑不动正常页面"的旧电脑连登录界面都进不去就没退路了。 */}
            <p className="mt-4 text-center text-[11px] text-muted-foreground">
              {t("ui.login.compat_hint")}
              <a
                href="/robustness/index.html"
                target="_blank"
                rel="noopener noreferrer"
                className="mx-1 underline underline-offset-2 transition-colors hover:text-foreground"
              >
                {t("ui.login.compat_mode")}
              </a>
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
