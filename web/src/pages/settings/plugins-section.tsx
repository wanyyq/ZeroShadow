import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Icon } from "@/components/icon"
import { useConfirm } from "@/components/confirm-dialog"
import { useT } from "@/lib/i18n"
import {
  deletePlugin,
  fetchPlugins,
  installPluginPackage,
  patchPlugin,
  setPluginTheme,
  api,
  type PluginRow,
  type PluginsResponse,
} from "@/lib/api"
import { loadPluginTheme } from "@/lib/plugin-theme"
import { SchemaForm } from "@/components/plugins/schema-form"
import { defaultsFromSchema, type SettingsSchema, type SettingsValues } from "@/lib/plugin-schema"

/**
 * 「设置 → 插件」。
 *
 * 设计口径（与 docs 的插件方案一致）：
 *  - **只有超管能进来**（tab 本身就是超管可见），且插件总开关默认关；
 *  - 安装 = 上传 zip，服务端校验 manifest / apiVersion / 权限白名单 / 包体积；
 *  - 装完**默认禁用**，要手动勾；主题插件还要再点「应用主题」才会生效；
 *  - 插件设置由它自己的 JSON Schema 渲染（`components/plugins/schema-form.tsx`），
 *    插件本身不提供任何 React 代码。
 *
 * 这一轮只启用 `kind: "theme"`；`fileType` / `server` 能装、能看、能禁用，
 * 但运行时会说明"需要后续版本"，避免出现"装了却没反应"的困惑。
 */
export function PluginsSection() {
  const t = useT()
  const confirm = useConfirm()
  const [data, setData] = React.useState<PluginsResponse | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [installing, setInstalling] = React.useState(false)
  const [openSettings, setOpenSettings] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<SettingsValues>({})
  const fileRef = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(async () => {
    try {
      setData(await fetchPlugins())
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [])
  React.useEffect(() => { void load() }, [load])

  const toggleMaster = async (next: boolean) => {
    setBusy(true)
    try {
      await api.patch("/admin/config", { pluginsEnabled: next })
      await load()
      // 关掉总开关时主题要立刻撤销，否则界面还挂着旧配色
      if (!next) await loadPluginTheme()
      toast.success(t("ui.plugins.saved"))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onInstall = async (file: File | undefined) => {
    if (!file) return
    setInstalling(true)
    try {
      await installPluginPackage(file)
      toast.success(t("ui.plugins.installed_toast"))
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setInstalling(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const togglePlugin = async (row: PluginRow, next: boolean) => {
    try {
      await patchPlugin(row.id, { enabled: next })
      await load()
      if (!next) await loadPluginTheme()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const applyTheme = async (row: PluginRow, active: boolean) => {
    try {
      await setPluginTheme(row.id, active)
      await loadPluginTheme()
      await load()
      toast.success(t("ui.plugins.saved"))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const remove = async (row: PluginRow) => {
    const name = row.manifest?.name || row.id
    if (!(await confirm({ title: t("ui.plugins.delete_title", { name }) }))) return
    try {
      await deletePlugin(row.id)
      await loadPluginTheme()
      await load()
      toast.success(t("ui.plugins.removed_toast"))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const openSettingsFor = (row: PluginRow) => {
    const schema = row.manifest?.settings as SettingsSchema | null | undefined
    if (!schema) return
    if (openSettings === row.id) {
      setOpenSettings(null)
      return
    }
    setDraft({ ...defaultsFromSchema(schema), ...(row.settings as SettingsValues) })
    setOpenSettings(row.id)
  }

  const saveSettings = async (row: PluginRow) => {
    try {
      await patchPlugin(row.id, { settings: draft })
      await load()
      toast.success(t("ui.plugins.saved"))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /**
   * 手动调用 server 插件的某个动作（空的 params）。
   *
   * 只用来"验证插件装好没有"：动作由插件清单声明，宿主不会转发任意方法名；
   * 结果直接以 JSON 形式弹出来，够排查就够了。
   */
  const runAction = async (row: PluginRow, action: string) => {
    try {
      const result = await api.post<{ ok: boolean; data: unknown }>(
        `/admin/plugins/${encodeURIComponent(row.id)}/action`,
        { action, params: {} }
      )
      const text = JSON.stringify(result.data ?? null)
      toast.success(t("ui.plugins.action_result", { action, result: text.length > 160 ? `${text.slice(0, 160)}…` : text }))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (!data) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>
  }

  const kindLabel = (kind?: string) =>
    kind === "theme" ? t("ui.plugins.kind_theme") : kind === "server" ? t("ui.plugins.kind_server") : t("ui.plugins.kind_file")

  return (
    <div className="grid gap-5">
      {/* 总开关 */}
      <div className="edge-highlight rounded-xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t("ui.plugins.enable")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("ui.plugins.enable_hint")}</p>
          </div>
          <Switch checked={data.enabled} disabled={busy} onCheckedChange={toggleMaster} />
        </div>
      </div>

      {!data.enabled ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("ui.plugins.disabled_hint")}
        </p>
      ) : (
        <div className="edge-highlight rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">{t("ui.plugins.title")}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("ui.plugins.desc")}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("ui.plugins.summary", { count: data.summary.total, enabled: data.summary.enabled })}
              </span>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => void onInstall(e.target.files?.[0])}
              />
              <Button size="sm" variant="outline" disabled={installing} onClick={() => fileRef.current?.click()}>
                <Icon name={installing ? "loader" : "package-plus"} /> {t("ui.plugins.install")}
              </Button>
            </div>
          </div>

          {data.plugins.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.plugins.empty")}</p>
          ) : (
            <div className="grid gap-2">
              {data.plugins.map((row) => {
                const info = row.manifest
                const schema = info?.settings as SettingsSchema | null | undefined
                return (
                  <div key={row.id} className="rounded-lg border border-border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{info?.name || row.id}</span>
                          <Badge variant="secondary">{kindLabel(info?.kind)}</Badge>
                          {info?.version && <span className="text-xs text-muted-foreground">v{info.version}</span>}
                          {row.activeTheme && <Badge variant="default">{t("ui.plugins.theme_active")}</Badge>}
                          {row.broken && <Badge variant="destructive">{t("ui.plugins.broken")}</Badge>}
                        </div>
                        {info?.description && (
                          <p className="mt-1 text-xs text-muted-foreground">{info.description}</p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>{t("ui.plugins.permissions")}:</span>
                          {info?.permissions?.length ? (
                            info.permissions.map((perm) => (
                              <code key={perm} className="rounded bg-muted px-1 py-0.5">{perm}</code>
                            ))
                          ) : (
                            <span>{t("ui.plugins.no_permissions")}</span>
                          )}
                          {info?.author && <span className="ml-2">· {info.author}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {info?.kind === "theme" && (
                          <Button
                            size="sm"
                            variant={row.activeTheme ? "secondary" : "outline"}
                            disabled={!row.enabled || row.broken}
                            onClick={() => void applyTheme(row, !row.activeTheme)}
                          >
                            {row.activeTheme ? t("ui.plugins.reset_theme") : t("ui.plugins.apply_theme")}
                          </Button>
                        )}
                        {schema && (
                          <Button size="sm" variant="ghost" onClick={() => openSettingsFor(row)}>
                            <Icon name="settings-2" /> {t("ui.plugins.settings")}
                          </Button>
                        )}
                        <Switch
                          checked={row.enabled}
                          disabled={row.broken}
                          onCheckedChange={(v) => void togglePlugin(row, !!v)}
                        />
                        <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                          <Icon name="trash-2" />
                        </Button>
                      </div>
                    </div>

                    {info?.kind === "server" && (
                      <div className="mt-2 rounded-md bg-muted/40 px-2 py-1.5">
                        <p className="text-[11px] text-muted-foreground">{t("ui.plugins.runtime_later")}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {(info.actions || []).map((action) => (
                            <Button
                              key={action}
                              size="xs"
                              variant="outline"
                              disabled={!row.enabled}
                              onClick={() => void runAction(row, action)}
                            >
                              <Icon name="play" /> {action}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}

                    {schema && openSettings === row.id && (
                      <>
                        <Separator className="my-3" />
                        <SchemaForm schema={schema} values={draft} onChange={setDraft} />
                        <div className="mt-3 flex items-center gap-2">
                          <Button size="sm" onClick={() => void saveSettings(row)}>{t("ui.common.save")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setOpenSettings(null)}>
                            {t("ui.common.cancel")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">{t("ui.plugins.safety_note")}</p>
      {/* 隐藏的辅助输入：让屏幕阅读器也能定位到上传控件 */}
      <Input type="hidden" aria-hidden="true" />
    </div>
  )
}
