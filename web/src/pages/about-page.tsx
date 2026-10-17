import type { ReactNode } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Icon } from "@/components/icon"
import { translate, useT } from "@/lib/i18n"
import { VERSION } from "@/version"

const LICENSE = "Apache-2.0"
const AUTHOR = "Wanyyq"
const AUTHOR_URL = "https://github.com/wanyyq"
const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0"

/**
 * 依赖所属子项目。
 * 值刻意用与语言无关的标识：它会被代码拿去分组过滤（`d.scope === "server"`），
 * 界面上看到的「后端（server）」来自 ui.about.group_*，两者不能混为一谈。
 */
type Scope = "server" | "web"

/** 直接依赖清单，与 server/package.json、web/package.json 的 dependencies 一一对应 */
const DEPENDENCIES: { scope: Scope; name: string; version: string; license: string; unused?: boolean }[] = [
  { scope: "server", name: "archiver", version: "7.0.1", license: "MIT" },
  { scope: "server", name: "bcryptjs", version: "3.0.3", license: "BSD-3-Clause" },
  { scope: "server", name: "busboy", version: "1.6.0", license: "MIT" },
  { scope: "server", name: "cookie-parser", version: "1.4.7", license: "MIT" },
  { scope: "server", name: "express", version: "4.22.2", license: "MIT" },
  { scope: "server", name: "iconv-lite", version: "0.7.3", license: "MIT" },
  { scope: "server", name: "jsonwebtoken", version: "9.0.3", license: "MIT" },
  { scope: "server", name: "unzipper", version: "0.12.5", license: "MIT" },
  { scope: "web", name: "react", version: "19.2.7", license: "MIT" },
  { scope: "web", name: "react-dom", version: "19.2.7", license: "MIT" },
  { scope: "web", name: "react-router-dom", version: "7.18.1", license: "MIT" },
  { scope: "web", name: "@base-ui/react", version: "1.6.0", license: "MIT" },
  { scope: "web", name: "tailwindcss", version: "4.3.3", license: "MIT" },
  { scope: "web", name: "@tailwindcss/vite", version: "4.3.3", license: "MIT" },
  { scope: "web", name: "shadcn", version: "4.13.0", license: "MIT" },
  { scope: "web", name: "class-variance-authority", version: "0.7.1", license: "Apache-2.0" },
  { scope: "web", name: "clsx", version: "2.1.1", license: "MIT" },
  { scope: "web", name: "tailwind-merge", version: "3.6.0", license: "MIT" },
  { scope: "web", name: "tw-animate-css", version: "1.4.0", license: "MIT" },
  { scope: "web", name: "lucide-react", version: "1.25.0", license: "ISC" },
  { scope: "web", name: "sonner", version: "2.0.7", license: "MIT" },
  { scope: "web", name: "next-themes", version: "0.4.6", license: "MIT" },
  { scope: "web", name: "@fontsource-variable/inter", version: "5.2.8", license: "OFL-1.1", unused: true },
]

type BundledId = "lucide" | "gsap" | "tailwind" | "google-sans"

/**
 * 随项目分发的本地静态资源（public/resources/），不经过 npm。
 * 说明文字（含个别名称后缀）是给人看的文案，放字典里；包名、版本号、许可证标识是数据，原样保留。
 */
const BUNDLED: { id: BundledId; name: string; version: string; license: string; url?: string; caution?: boolean }[] = [
  {
    id: "lucide",
    name: "lucide",
    version: "1.21.0",
    license: "ISC",
  },
  {
    id: "gsap",
    name: "GSAP",
    version: "3.13.0",
    license: "GreenSock Standard License",
    url: "https://gsap.com/standard-license",
    caution: true,
  },
  {
    id: "tailwind",
    name: "Tailwind CSS",
    version: "4.3.2",
    license: "MIT",
  },
  {
    id: "google-sans",
    name: "Google Sans Flex",
    version: "—",
    license: "OFL-1.1",
    url: "https://fonts.google.com/specimen/Google+Sans+Flex/license",
  },
]

/**
 * 把译文里的 `{name}` 占位符渲染成等宽字体片段。
 * 本页多处句子内嵌文件名（LICENSE、node_modules …）：这些名字不翻译，但要保留等宽样式，
 * 写成占位符就不必把一句话拆成多个键。
 */
function monoText(text: string, parts: Record<string, string>): ReactNode {
  const names = Object.keys(parts)
  if (!names.length) return text
  const re = new RegExp(`\\{(${names.join("|")})\\}`, "g")
  const out: ReactNode[] = []
  let end = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > end) out.push(text.slice(end, at))
    out.push(
      <span key={`${at}-${m[1]}`} className="font-mono">
        {parts[m[1]]}
      </span>
    )
    end = at + m[0].length
  }
  if (!out.length) return text
  if (end < text.length) out.push(text.slice(end))
  return out
}

function copyText(text: string, okMsg: string) {
  // 显式判断 clipboard 是否存在：可选链会让两个回调都不执行，表现为"点了没反应"
  const clipboard = navigator.clipboard
  if (!clipboard?.writeText) {
    toast.error(translate("ui.common.copy_unsupported"))
    return
  }
  void clipboard.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error(translate("ui.common.copy_failed"))
  )
}

export function AboutPage() {
  const t = useT()
  const backend = DEPENDENCIES.filter((d) => d.scope === "server")
  const frontend = DEPENDENCIES.filter((d) => d.scope === "web")
  const licenseCounts = DEPENDENCIES.reduce<Record<string, number>>((acc, d) => {
    acc[d.license] = (acc[d.license] || 0) + 1
    return acc
  }, {})

  /**
   * 静态资源里随语言变化的文字。
   * 键必须写成字面量（scripts/i18n-check.mjs 靠正则收集用到的键），
   * 所以在这里按 id 查表，而不是把键名塞进上面的数据数组。
   */
  const bundledText: Record<BundledId, { nameSuffix?: string; note: string }> = {
    lucide: { note: t("ui.about.bundled_note_lucide") },
    gsap: { note: t("ui.about.bundled_note_gsap") },
    tailwind: {
      nameSuffix: t("ui.about.bundled_name_tailwind_suffix"),
      note: t("ui.about.bundled_note_tailwind"),
    },
    "google-sans": { note: t("ui.about.bundled_note_google_sans") },
  }

  const scopeLabel = (scope: Scope) =>
    scope === "server" ? t("ui.about.scope_backend") : t("ui.about.scope_frontend")

  const asText = () =>
    [
      `ZeroShadow ${VERSION}`,
      t("ui.about.as_text_license", { license: LICENSE }),
      t("ui.about.as_text_author", { author: AUTHOR, url: AUTHOR_URL }),
      "",
      t("ui.about.as_text_deps"),
      ...DEPENDENCIES.map((d) => `${scopeLabel(d.scope)}\t${d.name}\t${d.version}\t${d.license}`),
      "",
      t("ui.about.as_text_bundled"),
      ...BUNDLED.map((b) => `${b.name}${bundledText[b.id].nameSuffix ?? ""}\t${b.version}\t${b.license}`),
    ].join("\n")

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("ui.about.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("ui.about.subtitle")}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => copyText(asText(), t("ui.about.dependency_list_copied"))}>
              <Icon name="clipboard-copy" data-icon="inline-start" /> {t("ui.about.copy_dependency_list")}
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
                  <CardDescription>{t("ui.about.tagline")}</CardDescription>
                </div>
                <Badge variant="secondary" className="ml-auto shrink-0">v{VERSION}</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Separator />
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="scale" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">{t("ui.about.license")}</dt>
                  <dd className="font-medium">
                    <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4 hover:text-primary">
                      Apache License 2.0
                    </a>
                  </dd>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="server" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">{t("ui.about.author")}</dt>
                  <dd className="font-medium">
                    <a href={AUTHOR_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4 hover:text-primary">
                      {AUTHOR}
                    </a>
                  </dd>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="copyright" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">{t("ui.about.copyright")}</dt>
                  <dd className="font-medium">Copyright © {AUTHOR} 2026</dd>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Icon name="code" className="size-4 shrink-0 text-muted-foreground" />
                  <dt className="w-16 shrink-0 text-muted-foreground">{t("ui.about.tech_stack")}</dt>
                  <dd className="font-medium">Node.js + React 19 + Tailwind v4</dd>
                </div>
              </dl>
              <Separator />
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <p>{t("ui.about.license_allows")}</p>
                <ul className="ml-4 flex list-disc flex-col gap-1">
                  <li>{monoText(t("ui.about.license_item_keep"), { file: "LICENSE" })}</li>
                  <li>{t("ui.about.license_item_state")}</li>
                  <li>{monoText(t("ui.about.license_item_notice"), { file: "NOTICE" })}</li>
                  <li>{t("ui.about.license_item_trademark")}</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          {/* 第三方组件 */}
          <Card className="edge-highlight">
            <CardHeader>
              <CardTitle>{t("ui.about.third_party_title")}</CardTitle>
              <CardDescription>
                {t("ui.about.dependency_count", {
                  n: DEPENDENCIES.length,
                  licenses: Object.entries(licenseCounts).map(([k, v]) => `${k} ${v}`).join(" · "),
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {[[t("ui.about.group_backend"), backend], [t("ui.about.group_frontend"), frontend]].map(([title, list]) => (
                <div key={title as string} className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{title as string}</h3>
                  <div className="min-w-0 overflow-hidden rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("ui.about.table_component")}</TableHead>
                          <TableHead className="w-20 sm:w-28">{t("ui.about.table_version")}</TableHead>
                          <TableHead className="hidden w-36 sm:table-cell">{t("ui.about.license")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(list as typeof DEPENDENCIES).map((d) => (
                          <TableRow key={`${d.scope}-${d.name}`}>
                            <TableCell className="max-w-40 truncate font-mono text-xs sm:max-w-none">
                              {d.name}
                              {d.unused && (
                                <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground">
                                  {t("ui.about.unused")}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{d.version}</TableCell>
                            <TableCell className="hidden sm:table-cell">
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
                {monoText(t("ui.about.deps_footer"), { lock: "pnpm-lock.yaml", modules: "node_modules" })}
              </p>
            </CardContent>
          </Card>

          {/* 随包分发的静态资源 */}
          <Card className="edge-highlight">
            <CardHeader>
              <CardTitle>{t("ui.about.bundled_title")}</CardTitle>
              <CardDescription>
                {monoText(t("ui.about.bundled_desc"), { path: "public/resources/" })}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border/50">
              {BUNDLED.map((b) => (
                <div key={b.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{b.name}{bundledText[b.id].nameSuffix ?? ""}</span>
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
                        {t("ui.about.bundled_license_terms")} <Icon name="external-link" className="size-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{bundledText[b.id].note}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted-foreground">
            {`ZeroShadow v${VERSION} · ${LICENSE} · `}
            {monoText(t("ui.about.footer_note"), { license_file: "LICENSE", package_file: "package.json" })}
          </p>
        </div>
      </div>
    </AppShell>
  )
}
