import * as React from "react"
import { AppShell } from "@/components/layout/app-shell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Icon } from "@/components/icon"
import { PathPicker } from "@/components/browser/path-picker"
import { useAuth } from "@/state/auth"
import { useOperations } from "@/state/operations"
import { cn } from "@/lib/utils"

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const
type Unit = (typeof SIZE_UNITS)[number]

function convertSize(value: number, from: Unit): Record<Unit, string> {
  let bytes = 0
  switch (from) {
    case "B": bytes = value; break
    case "KB": bytes = value * 1024; break
    case "MB": bytes = value * 1024 ** 2; break
    case "GB": bytes = value * 1024 ** 3; break
    case "TB": bytes = value * 1024 ** 4; break
  }
  return {
    B: `${bytes} B`,
    KB: `${(bytes / 1024).toFixed(2)} KB`,
    MB: `${(bytes / 1024 ** 2).toFixed(2)} MB`,
    GB: `${(bytes / 1024 ** 3).toFixed(4)} GB`,
    TB: `${(bytes / 1024 ** 4).toFixed(6)} TB`,
  }
}

export function ToolsPage() {
  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">工具</h1>
          <p className="mb-6 text-sm text-muted-foreground">实用工具集</p>
          <Tabs defaultValue="size">
            <TabsList variant="line" className="mb-6 flex-wrap">
              <TabsTrigger value="size"><Icon name="ruler" /> 大小转换</TabsTrigger>
              <TabsTrigger value="downloader"><Icon name="download" /> 多线程下载器</TabsTrigger>
            </TabsList>
            <TabsContent value="size"><SizeConverter /></TabsContent>
            <TabsContent value="downloader"><UrlDownloader /></TabsContent>
          </Tabs>
        </div>
      </div>
    </AppShell>
  )
}

function SizeConverter() {
  const [value, setValue] = React.useState("1")
  const [fromUnit, setFromUnit] = React.useState<Unit>("GB")
  const num = parseFloat(value) || 0
  const results = convertSize(num, fromUnit)

  return (
    <Card className="edge-highlight">
      <CardHeader>
        <CardTitle>文件大小单位转换</CardTitle>
        <CardDescription>输入数值和单位，查看其他单位对应的值</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex items-end gap-3">
          <div className="grid w-40 gap-1.5">
            <Label htmlFor="size-val">数值</Label>
            <Input id="size-val" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="text-right font-mono" />
          </div>
          <div className="grid w-28 gap-1.5">
            <Label>单位</Label>
            <Select value={fromUnit} onValueChange={(v) => setFromUnit(v as Unit)}>
              <SelectTrigger><SelectValue render={(_p, s) => <>{s.value}</>}>{fromUnit}</SelectValue></SelectTrigger>
              <SelectContent>
                {SIZE_UNITS.map((u) => (<SelectItem key={u} value={u}>{u}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Separator className="mb-3" />
        <div className="grid gap-2">
          {SIZE_UNITS.map((u) => (
            <div key={u} className={cn("flex items-center justify-between rounded-md px-3 py-2", u === fromUnit ? "bg-accent font-medium" : "hover:bg-muted/50")}>
              <span className="w-12 text-sm text-muted-foreground">{u}</span>
              <span className="font-mono text-sm tabular-nums">{results[u]}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function UrlDownloader() {
  const { me } = useAuth()
  const ops = useOperations()
  const [url, setUrl] = React.useState("")
  const [filename, setFilename] = React.useState("")
  const [dest, setDest] = React.useState("")
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [errors, setErrors] = React.useState<{ url?: string; dest?: string }>({})

  const canUse = me.perms.downloadUrl && me.role !== "guest"

  const validate = (): boolean => {
    const e: typeof errors = {}
    if (!url.trim()) {
      e.url = "请输入下载链接"
    } else if (!/^https?:\/\/.+/.test(url.trim())) {
      e.url = "仅支持 http/https 链接"
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const start = () => {
    if (!validate()) return
    ops.startDownloadUrl(url.trim(), dest.trim() || "/", filename.trim() || undefined)
    setUrl(""); setFilename("")
  }

  if (!canUse) {
    return (
      <Card className="edge-highlight">
        <CardHeader><CardTitle>多线程下载器</CardTitle><CardDescription>从远程 URL 下载文件到网盘</CardDescription></CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">
            {me.role === "guest" ? "请先登录管理员账户" : "此功能需要超级管理员在权限设置中开启"}
          </p>
        </CardContent>
      </Card>
    )
  }

  const downloadJobs = ops.jobs.filter((j) => j.type === "download")

  return (
    <div className="grid gap-5">
      <Card className="edge-highlight">
        <CardHeader>
          <CardTitle>多线程下载器</CardTitle>
          <CardDescription>从远程 URL 下载文件到网盘目录，支持进度跟踪</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="dl-url">下载链接 (http/https)</Label>
            <Input id="dl-url" placeholder="https://example.com/file.zip"
              value={url} onChange={(e) => { setUrl(e.target.value); setErrors((p) => ({ ...p, url: undefined })) }}
              className={errors.url ? "border-destructive" : ""} />
            {errors.url && <p className="text-xs text-destructive">{errors.url}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>保存到 (留空 = 根目录)</Label>
            <div className="flex gap-2">
              <Input className="flex-1" placeholder="文件夹/子文件夹" value={dest}
                onChange={(e) => setDest(e.target.value)} />
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <Icon name="folder-search" /> 浏览
              </Button>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dl-fn">文件名 (留空 = 自动识别)</Label>
            <Input id="dl-fn" placeholder="可选的自定义文件名" value={filename}
              onChange={(e) => setFilename(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">服务端自动处理重名、非法字符，请放心使用</p>
          <Button onClick={start} disabled={!url.trim()}>
            <Icon name="download" /> 开始下载
          </Button>
        </CardContent>
      </Card>

      {downloadJobs.length > 0 && (
        <Card className="edge-highlight">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>下载任务列表</span>
              <Button variant="ghost" size="icon-xs" onClick={ops.clearFinished}>
                <Icon name="x" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {downloadJobs.map((job) => (
                <div key={job.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                  <Icon
                    name={job.status === "done" ? "circle-check" : job.status === "error" ? "circle-alert" : "loader-2"}
                    className={cn("size-3.5 shrink-0", job.status === "running" && "animate-spin text-muted-foreground", job.status === "done" && "text-foreground", job.status === "error" && "text-destructive")}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{job.label}</p>
                    {job.status === "running" && (
                      <Progress value={job.percent} className="mt-0.5 h-1" />
                    )}
                    {job.error && job.status === "error" && (
                      <p className="mt-0.5 line-clamp-2 text-[10px] text-destructive">{job.error}</p>
                    )}
                  </div>
                  <span className={cn("w-9 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums", job.status === "done" && "text-foreground font-medium")}>
                    {job.status === "running" ? `${job.percent}%` : job.status === "done" ? "完成" : "失败"}
                  </span>
                  {job.status !== "running" && (
                    <Button variant="ghost" size="icon-xs" onClick={() => ops.dismiss(job.id)}>
                      <Icon name="x" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      <PathPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={(p) => setDest(p)} />
    </div>
  )
}
