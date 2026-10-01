import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Icon } from "@/components/icon"

// 版本号在此处写死是有意为之：项目约定版本号需与根 package.json、/api/meta 三处保持一致
// （见 docs/开发者指南.md 的「常见改动指引」）。
const VERSION = "1.1.0"
const LICENSE = "Apache-2.0"
const AUTHOR = "Wanyyq"
const AUTHOR_URL = "https://github.com/wanyyq"
const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0"

/** 直接依赖清单，与 server/package.json、web/package.json 的 dependencies 一一对应 */
const DEPENDENCIES: { scope: "后端" | "前端"; name: string; version: string; license: string; unused?: boolean }[] = [
  { scope: "后端", name: "archiver", version: "7.0.1", license: "MIT" },
  { scope: "后端", name: "bcryptjs", version: "3.0.3", license: "BSD-3-Clause" },
  { scope: "后端", name: "busboy", version: "1.6.0", license: "MIT" },
  { scope: "后端", name: "cookie-parser", version: "1.4.7", license: "MIT" },
  { scope: "后端", name: "express", version: "4.22.2", license: "MIT" },
  { scope: "后端", name: "jsonwebtoken", version: "9.0.3", license: "MIT" },
  { scope: "后端", name: "unzipper", version: "0.12.5", license: "MIT" },
  { scope: "前端", name: "react", version: "19.2.7", license: "MIT" },
  { scope: "前端", name: "react-dom", version: "19.2.7", license: "MIT" },
  { scope: "前端", name: "react-router-dom", version: "7.18.1", license: "MIT" },
  { scope: "前端", name: "@base-ui/react", version: "1.6.0", license: "MIT" },
  { scope: "前端", name: "tailwindcss", version: "4.3.3", license: "MIT" },
  { scope: "前端", name: "@tailwindcss/vite", version: "4.3.3", license: "MIT" },
  { scope: "前端", name: "shadcn", version: "4.13.0", license: "MIT" },
  { scope: "前端", name: "class-variance-authority", version: "0.7.1", license: "Apache-2.0" },
  { scope: "前端", name: "clsx", version: "2.1.1", license: "MIT" },
  { scope: "前端", name: "tailwind-merge", version: "3.6.0", license: "MIT" },
  { scope: "前端", name: "tw-animate-css", version: "1.4.0", license: "MIT" },
  { scope: "前端", name: "lucide-react", version: "1.25.0", license: "ISC" },
  { scope: "前端", name: "sonner", version: "2.0.7", license: "MIT" },
  { scope: "前端", name: "next-themes", version: "0.4.6", license: "MIT" },
  { scope: "前端", name: "@fontsource-variable/inter", version: "5.2.8", license: "OFL-1.1", unused: true },
]

/** 随项目分发的本地静态资源（public/resources/），不经过 npm */
const BUNDLED: { name: string; version: string; license: string; note: string; url?: string; caution?: boolean }[] = [
  {
    name: "lucide",
    version: "1.21.0",
    license: "ISC",
    note: "图标库，本地 lucide.min.js 由 createIcons() 渲染 <i data-lucide> 占位",
  },
  {
    name: "GSAP",
    version: "3.13.0",
    license: "GreenSock Standard License",
    note: "入场动画，本地 gsap.min.js。注意：这不是 MIT/ISC，商用与再分发请阅读其许可条款",
    url: "https://gsap.com/standard-license",
    caution: true,
  },
  {
    name: "Tailwind CSS（浏览器版构建）",
    version: "4.3.2",
    license: "MIT",
    note: "本地 tailwindcss.min.js（由 jsDelivr 压缩）。当前页面并未引用它，仅随资源目录留档",
  },
  {
    name: "Google Sans Flex",
    version: "—",
    license: "OFL-1.1",
    note: "界面字体。Google 于 2025 年 11 月以 SIL 开源字体许可（OFL-1.1）开放，可自由使用、修改与再分发（含商用）；仓库内为压缩后的子集文件。注意 OFL 不授予商标权，「Google Sans」名称仍归 Google。",
    url: "https://fonts.google.com/specimen/Google+Sans+Flex/license",
  },
]

function copyText(text: string, okMsg: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error("复制失败，请手动选择文本")
  )
}

export function AboutPage() {
  const backend = DEPENDENCIES.filter((d) => d.scope === "后端")
  const frontend = DEPENDENCIES.filter((d) => d.scope === "前端")
  const licenseCounts = DEPENDENCIES.reduce<Record<string, number>>((acc, d) => {
    acc[d.license] = (acc[d.license] || 0) + 1
    return acc
  }, {})

  const asText = () =>
    [
      `ZeroShadow ${VERSION}`,
      `许可证：${LICENSE}`,
      `作者：${AUTHOR}（${AUTHOR_URL}）`,
      "",
      "== 直接依赖 ==",
      ...DEPENDENCIES.map((d) => `${d.scope}\t${d.name}\t${d.version}\t${d.license}`),
      "",
      "== 随项目分发的静态资源 ==",
      ...BUNDLED.map((b) => `${b.name}\t${b.version}\t${b.license}`),
    ].join("\n")

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">软件开源信息</h1>
              <p className="text-sm text-muted-foreground">
                本软件自身的许可、作者与所用第三方开源组件清单
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => copyText(asText(), "依赖清单已复制")}>
              <Icon name="clipboard-copy" data-icon="inline-start" /> 复制依赖清单
            </Button>
          </div>

          {/* 软件自身 */}
          <Card className="edge-highlight">
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Icon name="hard-drive" className="size-5" />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <CardTitle>ZeroShadow</CardTitle>
                  <CardDescription>轻量级局域网网盘 · 一款极简好用的工作室网盘</CardDescription>
                </div>
                <Badge variant="secondary" className="ml-auto shrink-0">v{VERSION}</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Separator />
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="scale" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">许可证</dt>
                  <dd className="font-medium">
                    <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4 hover:text-primary">
                      Apache License 2.0
                    </a>
                  </dd>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="server" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">作者</dt>
                  <dd className="font-medium">
                    <a href={AUTHOR_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4 hover:text-primary">
                      {AUTHOR}
                    </a>
                  </dd>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="copyright" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">版权</dt>
                  <dd className="font-medium">Copyright © {AUTHOR} 2026</dd>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="code" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">技术栈</dt>
                  <dd className="font-medium">Node.js + React 19 + Tailwind v4</dd>
                </div>
              </dl>
              <Separator />
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <p>Apache License 2.0 允许商用、修改与再分发，但要求：</p>
                <ul className="ml-4 flex list-disc flex-col gap-1">
                  <li>保留版权、许可与免责声明（本项目的 <span className="font-mono">LICENSE</span> 文件）；</li>
                  <li>对被修改过的文件作出说明；</li>
                  <li>若原项目附带 <span className="font-mono">NOTICE</span> 文件，需一并保留；</li>
                  <li>不授予商标权，软件按「现状」提供、不承担担保责任。</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          {/* 第三方组件 */}
          <Card className="edge-highlight">
            <CardHeader>
              <CardTitle>第三方开源组件</CardTitle>
              <CardDescription>
                共 {DEPENDENCIES.length} 个直接依赖（
                {Object.entries(licenseCounts).map(([k, v]) => `${k} ${v}`).join(" · ")}）
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {[["后端（server）", backend], ["前端（web）", frontend]].map(([title, list]) => (
                <div key={title as string} className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{title as string}</h3>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>组件</TableHead>
                          <TableHead className="w-28">版本</TableHead>
                          <TableHead className="w-36">许可证</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(list as typeof DEPENDENCIES).map((d) => (
                          <TableRow key={`${d.scope}-${d.name}`}>
                            <TableCell className="font-mono text-xs">
                              {d.name}
                              {d.unused && (
                                <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground">
                                  未引用
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{d.version}</TableCell>
                            <TableCell>
                              <Badge variant={d.license === "MIT" ? "secondary" : "outline"} className="text-[10px]">
                                {d.license}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                完整版本与传递依赖见两个子项目的 <span className="font-mono">pnpm-lock.yaml</span>；
                各组件许可证全文随 <span className="font-mono">node_modules</span> 一并分发。
              </p>
            </CardContent>
          </Card>

          {/* 随包分发的静态资源 */}
          <Card className="edge-highlight">
            <CardHeader>
              <CardTitle>随项目分发的静态资源</CardTitle>
              <CardDescription>
                <span className="font-mono">public/resources/</span> 下的文件不走 npm，授权情况单独列出
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border/50">
              {BUNDLED.map((b) => (
                <div key={b.name} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{b.name}</span>
                    {b.version !== "—" && <span className="text-xs text-muted-foreground">{b.version}</span>}
                    <Badge
                      variant={b.caution ? "destructive" : "secondary"}
                      className="text-[10px]"
                    >
                      {b.license}
                    </Badge>
                    {b.url && (
                      <a
                        href={b.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ml-auto flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-primary"
                      >
                        许可条款 <Icon name="external-link" className="size-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{b.note}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted-foreground">
            ZeroShadow v{VERSION} · {LICENSE} · 本页信息与仓库中的 <span className="font-mono">LICENSE</span> 与两个
            <span className="font-mono"> package.json</span> 保持一致
          </p>
        </div>
      </div>
    </AppShell>
  )
}
