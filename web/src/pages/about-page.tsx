import { AppShell } from "@/components/layout/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Icon } from "@/components/icon"

const VERSION = "1.0.0"

export function AboutPage() {
  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">关于</h1>
          <p className="mb-6 text-sm text-muted-foreground">软件信息与版权</p>

          <Card className="edge-highlight">
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Icon name="hard-drive" className="size-5" />
                </span>
                <div>
                  <CardTitle>ZeroShadow</CardTitle>
                  <CardDescription>一款极简好用的工作室网盘</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Separator className="mb-4" />
              <div className="grid gap-3 text-sm">
                {[
                  ["hard-drive", "版本", VERSION],
                  ["server", "作者", "Github: wanyyq"]
                ].map(([icon, label, value]) => (
                  <div key={label} className="flex items-center gap-3">
                    <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
                    <span className="font-medium">{value}</span>
                  </div>
                ))}
                <Separator className="my-1" />
                <p className="text-xs text-muted-foreground">Copyright &copy; Wanyyq 2026</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
