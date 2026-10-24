/**
 * lib/plugin-schema.ts —— 插件设置项的类型与默认值推导
 *
 * 单独成文件（而不是放在 schema-form.tsx 里）有两个原因：
 *   1. `react-refresh/only-export-components` 要求"组件文件只导出组件"，
 *      导出普通函数会破坏热更新；
 *   2. 类型与默认值推导不依赖 React，测试与其它地方都能直接 import。
 *
 * 支持的 JSON Schema 子集与 `server/src/plugins/manifest.js` 的
 * `normalizeSettingsSchema()` 一一对应：object + 扁平 properties。
 */
export interface SchemaProperty {
  type: "string" | "number" | "integer" | "boolean"
  title?: string
  description?: string
  placeholder?: string
  default?: string | number | boolean
  enum?: string[]
  minimum?: number
  maximum?: number
  maxLength?: number
}

export interface SettingsSchema {
  type: "object"
  additionalProperties: false
  properties: Record<string, SchemaProperty>
}

export type SettingsValues = Record<string, string | number | boolean>

/** 按 schema 推导一份初始值（用于"设置"表单首次打开） */
export function defaultsFromSchema(schema?: SettingsSchema | null): SettingsValues {
  const out: SettingsValues = {}
  if (!schema) return out
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (spec.default !== undefined) out[key] = spec.default
    else if (spec.type === "boolean") out[key] = false
    else if (spec.type === "string") out[key] = spec.enum?.[0] ?? ""
  }
  return out
}
