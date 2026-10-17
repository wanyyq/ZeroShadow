import * as React from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Icon } from "@/components/icon"
import { useConfirm } from "@/components/confirm-dialog"
import {
  createShare,
  deleteShare,
  fetchMyShares,
  fetchShareOptions,
  precheckShare,
  type ShareOptions,
  type SharePrecheck,
  type ShareRow,
} from "@/lib/api"
import { formatDate } from "@/lib/format"
import { useT } from "@/lib/i18n"

/**
 * 分享创建对话框（v1.2.1）。
 *
 * 规则来自需求，注意别在这里"放宽"：
 *   - 对访客不可见的路径**必须**设 6~10 位密码（服务端同样强制，前端只是提前提示）；
 *   - 有效期只有 9 档，档位由服务端返回（`/api/shares/options`），前端不自己算秒数；
 *   - 密码与有效期创建后不能改 —— 所以这里没有编辑入口，只能删了重建。
 */

/** 随机密码：去掉容易看错的 0/O/1/l/I，8 位（在 6~10 区间内，够用且好念） */
const RANDOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
function randomPassword(length = 8) {
  let out = ""
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < length; i += 1) out += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length]
  return out
}

function absoluteUrl(path: string) {
  try {
    return new URL(path, window.location.origin).href
  } catch {
    return path
  }
}

export function ShareDialog({
  open,
  onOpenChange,
  path,
  name,
  isFolder,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 目标在网盘里的相对路径（文件或文件夹） */
  path: string
  name: string
  isFolder: boolean
}) {
  const t = useT()
  const confirm = useConfirm()

  const [options, setOptions] = React.useState<ShareOptions | null>(null)
  const [precheck, setPrecheck] = React.useState<SharePrecheck | null>(null)
  const [expireKey, setExpireKey] = React.useState("1d")
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [created, setCreated] = React.useState<ShareRow | null>(null)
  const [mine, setMine] = React.useState<ShareRow[]>([])
  const [loading, setLoading] = React.useState(false)

  const loadMine = React.useCallback(() => {
    fetchMyShares()
      .then((data) => setMine(data.shares))
      .catch(() => setMine([]))
  }, [])

  React.useEffect(() => {
    if (!open) return
    setCreated(null)
    setPassword("")
    setPrecheck(null)
    setLoading(true)
    void Promise.all([
      fetchShareOptions().then(setOptions).catch(() => setOptions(null)),
      precheckShare(path).then(setPrecheck).catch(() => setPrecheck(null)),
    ]).finally(() => setLoading(false))
    loadMine()
  }, [open, path, loadMine])

  const needPassword = precheck?.needPassword ?? false
  const featureOff = options ? !options.enabled : false

  const expireOptions = options?.expiry ?? []
  const currentExpire = expireOptions.find((o) => o.key === expireKey) ?? expireOptions[0]

  /**
   * 有效期档位的文案：这里**显式列出 9 个键**而不是拼 `ui.share.expire.${key}`。
   * 好处有二：i18n-check 能静态看到这些键（否则会被当成"死键"报警），
   * 并且服务端万一返回未知档位时有确定的兜底文案。
   */
  const expireLabels: Record<string, string> = {
    "30m": t("ui.share.expire.30m"),
    "1h": t("ui.share.expire.1h"),
    "6h": t("ui.share.expire.6h"),
    "12h": t("ui.share.expire.12h"),
    "1d": t("ui.share.expire.1d"),
    "3d": t("ui.share.expire.3d"),
    "7d": t("ui.share.expire.7d"),
    "14d": t("ui.share.expire.14d"),
    "21d": t("ui.share.expire.21d"),
  }
  const expireLabel = (key: string) => expireLabels[key] ?? key

  const submit = async () => {
    if (busy || !currentExpire) return
    const pw = password.trim()
    if (needPassword && !pw) {
      toast.warning(t("ui.share.password_required_hint"))
      return
    }
    if (pw && (pw.length < 6 || pw.length > 10)) {
      toast.warning(t("ui.share.password_length"))
      return
    }
    if (/\s/.test(pw)) {
      toast.warning(t("ui.share.password_space"))
      return
    }
    setBusy(true)
    try {
      const row = await createShare({
        path,
        expireSeconds: currentExpire.seconds,
        password: pw || undefined,
      })
      setCreated(row)
      toast.success(t("ui.share.created"))
      loadMine()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copyLink = (url: string) => {
    const full = absoluteUrl(url)
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText) {
      toast.error(t("ui.common.copy_unsupported"))
      return
    }
    void clipboard.writeText(full).then(
      () => toast.success(t("ui.share.copied")),
      () => toast.error(t("ui.common.copy_failed"))
    )
  }

  const revoke = async (row: ShareRow) => {
    const ok = await confirm({
      title: t("ui.share.revoke_confirm_title"),
      description: t("ui.share.revoke_confirm_desc"),
      confirmText: t("ui.share.revoke"),
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteShare(row.id)
      toast.success(t("ui.share.revoked"))
      if (created?.id === row.id) setCreated(null)
      loadMine()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-all">{t("ui.share.title", { name })}</DialogTitle>
          <DialogDescription>{isFolder ? t("ui.share.desc_folder") : t("ui.share.desc")}</DialogDescription>
        </DialogHeader>

        {featureOff && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("ui.share.disabled_hint")}
          </p>
        )}

        {created ? (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="share-link">{t("ui.share.link")}</Label>
              <div className="flex items-center gap-1.5">
                <Input id="share-link" readOnly value={absoluteUrl(created.url)} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button size="icon-sm" variant="outline" title={t("ui.share.copy_link")} onClick={() => copyLink(created.url)}>
                  <Icon name="copy" />
                </Button>
                <Button size="icon-sm" variant="outline" title={t("ui.share.open")} onClick={() => window.open(absoluteUrl(created.url), "_blank", "noopener")}>
                  <Icon name="external-link" />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">
                <Icon name="clock" /> {t("ui.share.expires_at")} {formatDate(created.expiresAt)}
              </Badge>
              {created.requirePassword && (
                <Badge variant="outline">
                  <Icon name="lock" /> {t("ui.share.need_password")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("ui.share.immutable_hint")}</p>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setCreated(null)}>
                {t("ui.share.create")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>{t("ui.share.expiry")}</Label>
              <Select value={expireKey} onValueChange={(v) => setExpireKey(String(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) => expireLabel(String(value))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {expireOptions.map((o) => (
                    <SelectItem key={o.key} value={o.key}>
                      {expireLabel(o.key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="share-password">
                {t("ui.share.password")}
                {needPassword && <span className="ml-0.5 text-destructive">*</span>}
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="share-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("ui.share.password_placeholder")}
                  maxLength={10}
                  autoComplete="new-password"
                  className="font-mono"
                />
                <Button size="sm" variant="outline" onClick={() => setPassword(randomPassword())}>
                  <Icon name="dices" /> {t("ui.share.random")}
                </Button>
              </div>
              <p className={needPassword ? "text-xs text-amber-600 dark:text-amber-400" : "text-xs text-muted-foreground"}>
                {needPassword ? t("ui.share.password_required_hint") : t("ui.share.password_optional_hint")}
              </p>
            </div>

            {precheck && (
              <p className="text-xs text-muted-foreground">
                {precheck.isFolder ? t("ui.share.page_folder") : t("ui.share.page_file")} · {precheck.name}
              </p>
            )}
            {/* 站点级策略提示：管理员把分享收成"仅登录"时，这里要提前讲清楚 */}
            <p className="text-[11px] text-muted-foreground">
              {options?.publicAccess === false ? t("ui.share.login_only_hint") : t("ui.share.public_access_hint")}
            </p>
            {loading && <p className="text-xs text-muted-foreground">{t("ui.share.creating")}</p>}
          </div>
        )}

        <div className="grid gap-2 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t("ui.share.my_shares", { n: mine.length })}</p>
          {mine.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("ui.share.my_shares_empty")}</p>
          ) : (
            <div className="grid max-h-44 gap-1 overflow-y-auto">
              {mine.map((row) => (
                <div key={row.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60">
                  <Icon name={row.isFolder ? "folder" : "file"} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" title={row.path}>{row.name}</span>
                  <span className="hidden shrink-0 text-muted-foreground sm:inline">{formatDate(row.expiresAt)}</span>
                  <span className="hidden shrink-0 text-muted-foreground sm:inline" title={t("ui.share.downloads", { n: row.downloads })}>
                    {row.downloads}
                  </span>
                  {row.expired ? (
                    <Badge variant="secondary">{t("ui.share.expired")}</Badge>
                  ) : row.requirePassword ? (
                    <Badge variant="outline"><Icon name="lock" /></Badge>
                  ) : null}
                  <Button size="icon-sm" variant="ghost" title={t("ui.share.revoke")} onClick={() => void revoke(row)}>
                    <Icon name="trash-2" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("ui.common.close")}
          </Button>
          {!created && (
            <Button onClick={() => void submit()} disabled={busy || featureOff || !currentExpire}>
              {busy ? <Icon name="loader-2" className="animate-spin" /> : <Icon name="share-2" />}
              {busy ? t("ui.share.creating") : t("ui.share.create")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
