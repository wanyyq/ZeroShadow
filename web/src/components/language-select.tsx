import * as React from "react"
import { toast } from "sonner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { useI18n, useT } from "@/lib/i18n"
import { BUILTIN } from "@/locales"

/**
 * 界面语言选择器。
 *
 * 放在「设置 → 外观」里，登录页也复用它（未登录时也要能换语言）。
 * 右侧的下载按钮导出**全部文案键**（值就是中文原文）—— 这是给翻译者用的模板：
 * 翻完值、补一个 `_meta.name`，丢进服务端 `data/lang/` 就是一个新语言。
 * 之所以由前端导出而不由服务端生成：语言文件与前端源码同源，服务端没有键清单，
 * 而前端本来就打包了完整的中文字典，导出是零成本的。
 */
export function LanguageSelect({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { lang, langs, defaultLang, loading, setLang } = useI18n()
  const t = useT()

  const defaultName = langs.find((l) => l.code === defaultLang)?.name ?? defaultLang

  const exportTemplate = React.useCallback(() => {
    const entries = Object.entries(BUILTIN.zh ?? {}).sort(([a], [b]) => a.localeCompare(b))
    const payload = {
      _meta: { name: t("ui.i18n.template_name_placeholder"), base: "zh" },
      translations: Object.fromEntries(entries),
    }
    try {
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "zeroshadow-lang-template.json"
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 立即回收会让某些浏览器来不及开始下载，延后一点
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast.success(t("ui.i18n.exported"))
    } catch {
      toast.error(t("ui.common.operation_failed"))
    }
  }, [t])

  const followDefault = React.useCallback(() => {
    // 清掉本机选择，回到服务端配置的站点默认语言
    try {
      localStorage.removeItem("zs-lang")
    } catch {
      /* 存储不可用时忽略 */
    }
    setLang(defaultLang)
  }, [defaultLang, setLang])

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={lang} onValueChange={(value) => setLang(String(value))}>
          <SelectTrigger className={compact ? "w-32" : "w-48"} size="sm">
            <SelectValue>
              {(value) => langs.find((l) => l.code === String(value))?.name ?? String(value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {langs.map((item) => (
              <SelectItem key={item.code} value={item.code}>
                {item.name}
                {item.builtin ? "" : `（${t("ui.i18n.custom_tag")}）`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {compact ? null : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={followDefault}
              disabled={lang === defaultLang}
            >
              {t("ui.i18n.follow_default")}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("ui.i18n.export_template")}
              title={t("ui.i18n.export_template_hint")}
              onClick={exportTemplate}
            >
              <Icon name="download" />
            </Button>
          </>
        )}
      </div>
      {compact ? null : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {loading ? t("ui.i18n.loading") : t("ui.i18n.language_hint", { name: defaultName })}
        </p>
      )}
    </div>
  )
}
