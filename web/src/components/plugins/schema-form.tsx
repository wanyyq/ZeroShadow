import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/lib/i18n"
import type { SettingsSchema, SettingsValues } from "@/lib/plugin-schema"

/**
 * components/plugins/schema-form.tsx —— 按插件提供的 JSON Schema 自动渲染设置表单
 *
 * 为什么要它：让插件**不必写 React**（也就不能往页面里注入组件/样式），
 * 只要在 manifest 里声明 `settings`，后台就能长出一张表单。
 *
 * 支持的子集见 `lib/plugin-schema.ts`（与 `server/src/plugins/manifest.js` 的
 * `normalizeSettingsSchema()` 一一对应）：object + 扁平 properties。
 * 提交前**服务端会再校验一遍**类型与范围，前端校验只是省一次往返。
 */
export function SchemaForm({
  schema,
  values,
  onChange,
  disabled,
}: {
  schema: SettingsSchema
  values: SettingsValues
  onChange: (next: SettingsValues) => void
  disabled?: boolean
}) {
  const t = useT()
  const entries = Object.entries(schema.properties || {})
  if (!entries.length) {
    return <p className="text-xs text-muted-foreground">{t("ui.plugins.no_settings")}</p>
  }
  const set = (key: string, value: string | number | boolean) => onChange({ ...values, [key]: value })

  return (
    <div className="grid gap-3">
      {entries.map(([key, spec]) => {
        const label = spec.title || key
        const current = values[key]
        if (spec.type === "boolean") {
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor={`p-${key}`}>{label}</Label>
                {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
              </div>
              <Switch
                id={`p-${key}`}
                checked={current === true}
                disabled={disabled}
                onCheckedChange={(v) => set(key, !!v)}
              />
            </div>
          )
        }
        if (spec.type === "string" && spec.enum?.length) {
          return (
            <div key={key} className="grid gap-1.5">
              <Label>{label}</Label>
              <Select
                value={typeof current === "string" ? current : spec.enum[0]}
                disabled={disabled}
                onValueChange={(v) => v && set(key, v)}
              >
                <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {spec.enum.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
            </div>
          )
        }
        if (spec.type === "string") {
          return (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`p-${key}`}>{label}</Label>
              <Input
                id={`p-${key}`}
                className="h-8"
                placeholder={spec.placeholder}
                maxLength={spec.maxLength}
                value={typeof current === "string" ? current : ""}
                disabled={disabled}
                onChange={(e) => set(key, e.target.value)}
              />
              {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
            </div>
          )
        }
        // number / integer
        return (
          <div key={key} className="grid gap-1.5">
            <Label htmlFor={`p-${key}`}>{label}</Label>
            <Input
              id={`p-${key}`}
              className="h-8 w-40"
              inputMode="numeric"
              min={spec.minimum}
              max={spec.maximum}
              value={typeof current === "number" ? String(current) : ""}
              disabled={disabled}
              onChange={(e) => {
                const n = Number(e.target.value)
                set(key, Number.isFinite(n) ? n : 0)
              }}
            />
            {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
          </div>
        )
      })}
    </div>
  )
}
