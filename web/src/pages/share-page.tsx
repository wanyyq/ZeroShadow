import * as React from "react"
import { useParams } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Icon } from "@/components/icon"
import { LanguageSelect } from "@/components/language-select"
import {
  fetchPublicShare,
  fetchPublicShareList,
  shareDownloadUrl,
  verifySharePassword,
  type PublicShareEntry,
  type PublicShareMeta,
} from "@/lib/api"
import { formatBytes, formatDate, fileKind } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/**
 * 公开分享页 `/s/:token`（v1.2.1）。
 *
 * 刻意**不套 AppShell**：这一页要给"没有账号的人"看，不能依赖任何登录态、
 * 权限矩阵或顶栏小组上下文。整页只做三件事：验密码 → 浏览 → 下载。
 *
 * 密码通过后服务端给一张短时效票据，存在 sessionStorage（关掉标签页即失效），
 * 之后所有 list/download 请求都带上它；文件本身的字节仍然由服务端逐次鉴权。
 */

const TICKET_PREFIX = "zs-share-ticket:"

function readTicket(token: string) {
  try {
    return sessionStorage.getItem(TICKET_PREFIX + token) || ""
  } catch {
    return ""
  }
}

function writeTicket(token: string, ticket: string) {
  try {
    if (ticket) sessionStorage.setItem(TICKET_PREFIX + token, ticket)
    else sessionStorage.removeItem(TICKET_PREFIX + token)
  } catch {
    /* 存储不可用时只保留内存态 */
  }
}

type LoadState = "loading" | "ready" | "expired" | "notfound" | "login" | "missing" | "error"

export default function SharePage() {
  const { token = "" } = useParams()
  const t = useT()

  const [state, setState] = React.useState<LoadState>("loading")
  const [meta, setMeta] = React.useState<PublicShareMeta | null>(null)
  const [ticket, setTicket] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [unlocking, setUnlocking] = React.useState(false)
  const [passwordError, setPasswordError] = React.useState<string | null>(null)

  const [subPath, setSubPath] = React.useState("")
  const [entries, setEntries] = React.useState<PublicShareEntry[]>([])
  const [listLoading, setListLoading] = React.useState(false)

  /** 把后端的错误映射成页面状态 */
  const applyError = React.useCallback((err: unknown) => {
    const status = (err as { status?: number })?.status
    const code = (err as { code?: string })?.code
    // 内容被删除/移动 与 链接过期 是两件事，提示也不能混：
    // 前者是"文件没了"，后者是"时间到了"。
    if (code === "SHARE_TARGET_MISSING") return setState("missing")
    if (status === 410 || code === "SHARE_EXPIRED") return setState("expired")
    if (status === 404 || code === "SHARE_NOT_FOUND") return setState("notfound")
    if (status === 401 || code === "SHARE_LOGIN_REQUIRED") return setState("login")
    setState("error")
  }, [])

  const loadMeta = React.useCallback(
    async (nextTicket: string) => {
      if (!token) return setState("notfound")
      try {
        const data = await fetchPublicShare(token)
        setMeta(data)
        setTicket(nextTicket)
        setState("ready")
      } catch (err) {
        applyError(err)
      }
    },
    [token, applyError]
  )

  React.useEffect(() => {
    void loadMeta(readTicket(token))
  }, [loadMeta, token])

  const unlocked = !!meta && (!meta.requirePassword || !!ticket)

  /** 目录浏览 */
  const loadList = React.useCallback(
    async (path: string) => {
      if (!meta?.isFolder) return
      setListLoading(true)
      try {
        const data = await fetchPublicShareList(token, path, ticket)
        setEntries(data.entries)
        setSubPath(data.path)
      } catch (err) {
        const status = (err as { status?: number })?.status
        const code = (err as { code?: string })?.code
        if (status === 403) {
          // 票据过期（最长 2 小时）：清掉重新验密码
          writeTicket(token, "")
          setTicket("")
        }
        // 整个分享的目标没了（而不是某个子目录）：直接切到"内容已被移动或删除"
        if (code === "SHARE_TARGET_MISSING") applyError(err)
        else toast.error((err as Error).message)
      } finally {
        setListLoading(false)
      }
    },
    [meta, token, ticket, applyError]
  )

  React.useEffect(() => {
    if (state !== "ready" || !unlocked || !meta?.isFolder) return
    void loadList("")
  }, [state, unlocked, meta?.isFolder, loadList])

  const unlock = async () => {
    if (unlocking) return
    const pw = password.trim()
    if (!pw) return
    setUnlocking(true)
    setPasswordError(null)
    try {
      const res = await verifySharePassword(token, pw)
      writeTicket(token, res.ticket || "")
      setTicket(res.ticket || "")
      setPassword("")
      if (meta) setMeta({ ...meta, unlocked: true })
    } catch (err) {
      const status = (err as { status?: number })?.status
      const code = (err as { code?: string })?.code
      if (code === "SHARE_PASSWORD_LOCKED") setPasswordError((err as Error).message)
      else if (status === 403) setPasswordError(t("ui.share.page_wrong"))
      else setPasswordError((err as Error).message)
    } finally {
      setUnlocking(false)
    }
  }

  const crumbs = subPath ? subPath.split("/") : []

  const shell = (children: React.ReactNode) => (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-heading text-sm font-semibold tracking-tight">ZeroShadow</p>
            <p className="text-[11px] text-muted-foreground">{t("ui.share.page_title")} · {t("ui.share.page_powered")}</p>
          </div>
          <LanguageSelect compact />
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
        <footer className="mt-8 text-center text-[11px] text-muted-foreground">Copyright@Wanyyq 2026</footer>
      </div>
    </div>
  )

  if (state === "loading") {
    return shell(
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (state === "expired" || state === "notfound" || state === "login" || state === "missing" || state === "error") {
    const map = {
      expired: { icon: "clock-alert", title: t("ui.share.page_expired_title"), desc: t("ui.share.page_expired_desc") },
      notfound: { icon: "file-x", title: t("ui.share.page_notfound_title"), desc: t("ui.share.page_notfound_desc") },
      // 目标被删除/改名：标题沿用"不存在"，但原因说清楚，用户才知道去找分享者重发
      missing: { icon: "file-x", title: t("ui.share.page_notfound_title"), desc: t("api.share.target_missing") },
      login: { icon: "lock", title: t("ui.share.page_login_title"), desc: t("ui.share.page_login_desc") },
      error: { icon: "triangle-alert", title: t("ui.share.page_notfound_title"), desc: t("ui.share.page_notfound_desc") },
    }[state]
    return shell(
      <div className="flex flex-1 items-center justify-center">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <Icon name={map.icon} className="size-8 text-muted-foreground" />
            <p className="font-medium">{map.title}</p>
            <p className="text-xs text-muted-foreground">{map.desc}</p>
            {state === "login" && (
              <Button size="sm" onClick={() => { window.location.href = `/login?next=${encodeURIComponent(location.pathname)}` }}>
                <Icon name="log-in" /> {t("ui.share.page_login_action")}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // 需要密码
  if (meta?.requirePassword && !unlocked) {
    return shell(
      <div className="flex flex-1 items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="break-all">{meta.name}</CardTitle>
            <CardDescription>{t("ui.share.page_password_desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void unlock()
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="share-pw">{t("ui.share.page_password_title")}</Label>
                <Input
                  id="share-pw"
                  value={password}
                  autoFocus
                  autoComplete="off"
                  maxLength={10}
                  className="font-mono"
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setPasswordError(null)
                  }}
                />
                {passwordError && <p className="text-xs text-destructive">{passwordError}</p>}
              </div>
              <Button type="submit" disabled={unlocking || !password.trim()}>
                {unlocking ? <Icon name="loader-2" className="animate-spin" /> : <Icon name="lock-open" />}
                {t("ui.share.page_unlock")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!meta) return null

  // 单个文件
  if (!meta.isFolder) {
    const ext = (meta.name.split(".").pop() || "").toLowerCase()
    const inlineKind = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg"].includes(ext)
      ? "image"
      : ["mp4", "webm", "mov", "m4v"].includes(ext)
        ? "video"
        : ["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)
          ? "audio"
          : ext === "pdf"
            ? "pdf"
            : null
    const inlineUrl = shareDownloadUrl(token, "", ticket, true)
    return shell(
      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="break-all">{meta.name}</CardTitle>
              <CardDescription>
                {t("ui.share.page_file")} · {formatBytes(meta.size)} · {formatDate(meta.createdAt)}
              </CardDescription>
            </div>
            <Button
              render={<a href={shareDownloadUrl(token, "", ticket)} download={meta.name} />}
            >
              <Icon name="download" /> {t("ui.share.page_download")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {inlineKind && <p className="text-xs text-muted-foreground">{t("ui.share.page_preview")}</p>}
          {inlineKind === "image" && (
            <img src={inlineUrl} alt={meta.name} className="max-h-[70dvh] w-full rounded-lg object-contain" />
          )}
          {inlineKind === "video" && <video src={inlineUrl} controls className="max-h-[70dvh] w-full rounded-lg" />}
          {inlineKind === "audio" && <audio src={inlineUrl} controls className="w-full" />}
          {inlineKind === "pdf" && (
            <iframe src={inlineUrl} title={meta.name} className="h-[70dvh] w-full rounded-lg border border-border" />
          )}
          <p className="text-xs text-muted-foreground">
            {t("ui.share.expires_at")}: {formatDate(meta.expiresAt)}
          </p>
        </CardContent>
      </Card>
    )
  }

  // 文件夹
  return shell(
    <Card className="edge-highlight flex flex-1 flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="break-all">{meta.name}</CardTitle>
            <CardDescription>
              {t("ui.share.page_folder")} · {t("ui.share.page_summary", { files: meta.files, size: formatBytes(meta.size) })}
            </CardDescription>
          </div>
          <Badge variant="outline">
            <Icon name="clock" /> {formatDate(meta.expiresAt)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
        <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button
            type="button"
            className={cn("rounded px-1.5 py-0.5 transition-colors hover:bg-muted", !subPath && "font-medium text-foreground")}
            onClick={() => void loadList("")}
          >
            {t("ui.share.page_root")}
          </button>
          {crumbs.map((name, index) => {
            const target = crumbs.slice(0, index + 1).join("/")
            return (
              <React.Fragment key={target}>
                <span>/</span>
                <button
                  type="button"
                  className={cn(
                    "rounded px-1.5 py-0.5 transition-colors hover:bg-muted",
                    index === crumbs.length - 1 && "font-medium text-foreground"
                  )}
                  onClick={() => void loadList(target)}
                >
                  {name}
                </button>
              </React.Fragment>
            )
          })}
        </nav>

        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60">
          {listLoading && (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          )}
          {!listLoading && entries.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("ui.share.page_empty")}</p>
          )}
          {!listLoading &&
            entries.map((entry) => {
              const kind = fileKind(entry.name, entry.type)
              const childRel = subPath ? `${subPath}/${entry.name}` : entry.name
              if (entry.type === "dir") {
                return (
                  <button
                    key={entry.name}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                    onClick={() => void loadList(childRel)}
                  >
                    <Icon name="folder" className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm" title={entry.name}>{entry.name}</span>
                    <Icon name="chevron-right" className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                )
              }
              return (
                <div key={entry.name} className="flex items-center gap-3 px-3 py-2.5">
                  <Icon name={kind.icon} className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm" title={entry.name}>{entry.name}</span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
                    {formatBytes(entry.size)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    render={<a href={shareDownloadUrl(token, childRel, ticket)} download={entry.name} />}
                  >
                    <Icon name="download" /> <span className="hidden sm:inline">{t("ui.share.page_download")}</span>
                  </Button>
                </div>
              )
            })}
        </div>
        <p className="text-[11px] text-muted-foreground">{t("ui.share.page_count", { n: entries.length })}</p>
      </CardContent>
    </Card>
  )
}
