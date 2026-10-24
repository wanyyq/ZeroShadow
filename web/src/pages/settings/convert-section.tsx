import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/icon"
import { api } from "@/lib/api"
import { useT } from "@/lib/i18n"
import type { AdminConfig } from "@/lib/types"

/**
 * 「设置 → 文件转换」。
 *
 * 这一页只做一件事：让服主把 **md→PDF 用哪个字体**说清楚，并且在字体不可用时
 * 立刻看到"为什么"。`data/fonts/` 自动发现、`CONVERT_PDF_FONT` 环境变量都还在，
 * 但"我明明放了字体却还是报缺字体"是实际发生过的问题，所以：
 *   - 输入框：填绝对路径（或相对程序根目录的路径），留空 = 自动；
 *   - 状态区：当前**实际会用**的字体、类型（TrueType / CFF）、体积；
 *   - 诊断表：每个被考虑过的候选文件 + 被跳过的具体原因
 *     （文件不存在 / 不含汉字 / CFF2 变量字体 / name-keyed CFF …）；
 *   - 「重新探测」：刚把字体拷进 `data/fonts/` 时点一下，不必重启。
 */

interface FontCandidate {
  path: string
  explicit?: boolean
  ok: boolean
  reason?: string
  kind?: string
}

interface FontStatus {
  ok: boolean
  source: string | null
  kind: string | null
  bytes: number | null
  reason: string | null
  checked: boolean
  candidates: FontCandidate[]
  dirs?: { dataFonts?: string; system?: string[] }
  configured?: string
  envFont?: string | null
}

interface ConvertResponse {
  config: { font: string }
  status: FontStatus
}

function kb(n: number | null | undefined) {
  if (!n) return ""
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ConvertSection() {
  const t = useT()
  const [font, setFont] = React.useState("")
  const [draft, setDraft] = React.useState("")
  const [status, setStatus] = React.useState<FontStatus | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const apply = React.useCallback((data: ConvertResponse) => {
    setFont(String(data.config?.font || ""))
    setDraft(String(data.config?.font || ""))
    setStatus(data.status || null)
    setLoaded(true)
  }, [])

  const load = React.useCallback(() => {
    api
      .get<ConvertResponse>("/admin/convert")
      .then(apply)
      .catch((err) => toast.error((err as Error).message))
  }, [apply])

  React.useEffect(() => {
    load()
  }, [load])

  const save = async (value: string) => {
    setBusy(true)
    try {
      await api.patch<AdminConfig>("/admin/config", { convertPdfFont: value })
      const next = await api.post<ConvertResponse>("/admin/convert/rescan", {})
      apply(next)
      toast.success(t("ui.settings.convert.saved"))
    } catch (err) {
      toast.error((err as Error).message)
      setDraft(font)
    } finally {
      setBusy(false)
    }
  }

  const rescan = async () => {
    setBusy(true)
    try {
      apply(await api.post<ConvertResponse>("/admin/convert/rescan", {}))
      toast.success(t("ui.settings.convert.rescanned"))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  const kindLabel = (kind: string | null | undefined) =>
    kind === "cff" ? "CFF (OpenType)" : kind === "truetype" ? "TrueType" : "—"

  const attempts = (status?.candidates || []).filter((c) => c.ok || c.reason !== "跳过（优先 TrueType）")

  return (
    <div className="edge-highlight rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("ui.settings.convert.title")}</h3>
        <Badge variant={status?.ok ? "default" : "secondary"}>
          {status?.ok ? t("ui.settings.convert.font_ready") : t("ui.settings.convert.font_missing")}
        </Badge>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{t("ui.settings.convert.desc")}</p>

      {/* 当前生效的字体 */}
      <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed">
        {status?.ok ? (
          <>
            <p className="font-medium text-foreground">{t("ui.settings.convert.current")}</p>
            <p className="mt-1 break-all font-mono text-[11px]">{status.source}</p>
            <p className="mt-1 text-muted-foreground">
              {kindLabel(status.kind)}
              {status.bytes ? ` · ${kb(status.bytes)}` : ""}
              {status.kind === "cff" ? ` · ${t("ui.settings.convert.cff_hint")}` : ""}
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-destructive">{t("ui.settings.convert.missing_title")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("ui.settings.convert.missing_hint", { dir: status?.dirs?.dataFonts || "data/fonts" })}
            </p>
            {status?.reason ? <p className="mt-1 break-all text-muted-foreground">{status.reason}</p> : null}
          </>
        )}
      </div>

      {/* 指定字体 */}
      <div className="grid gap-2">
        <Label htmlFor="convert-pdf-font">{t("ui.settings.convert.font_label")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="convert-pdf-font"
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("ui.settings.convert.font_placeholder")}
          />
          <Button size="sm" variant="outline" disabled={busy || draft === font} onClick={() => void save(draft)}>
            <Icon name="check" data-icon="inline-start" /> {t("ui.common.save")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void rescan()}>
            <Icon name="refresh-cw" data-icon="inline-start" /> {t("ui.settings.convert.rescan")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("ui.settings.convert.font_hint")}</p>
      </div>

      {/* 诊断：每个候选为什么被跳过 */}
      {attempts.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t("ui.settings.convert.diagnostics", { n: attempts.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed">
            {attempts.slice(0, 30).map((c) => (
              <li key={c.path} className="flex flex-wrap items-baseline gap-x-2 break-all">
                <span className={c.ok ? "text-foreground" : "text-muted-foreground"}>{c.ok ? "✓" : "×"}</span>
                <span className="font-mono">{c.path}</span>
                {c.reason ? <span className="text-muted-foreground">— {c.reason}</span> : null}
              </li>
            ))}
            {attempts.length > 30 && (
              <li className="text-muted-foreground">{t("ui.settings.convert.too_many", { n: attempts.length - 30 })}</li>
            )}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("ui.settings.convert.dirs", {
              dir: status?.dirs?.dataFonts || "data/fonts",
              system: (status?.dirs?.system || []).join(", "),
            })}
          </p>
        </details>
      )}
    </div>
  )
}
