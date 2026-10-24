# manifest.json —— 逐字段校验规则

来源：`server/src/plugins/manifest.js` 的 `normalizeManifest()`。
**规范化的结果会丢弃所有未列出的字段，且遇到未知字段直接抛错**（不是忽略）。

## 顶层字段白名单

```js
id, name, version, apiVersion, kind,
description, author, homepage,
permissions, theme, settings,
entry, extensions, modes, actions
```

出现这 15 个之外的键 → `manifest 含未知字段：xxx`，安装失败。

## 通用字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+){1,5}$`，≤ 64。**至少一个点**；小写；不能以 `-` 开头 |
| `name` | ✅ | 非空，≤ 40 |
| `version` | ✅ | `^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`，≤ 32（`1.0.0` / `1.0.0-beta.1`） |
| `apiVersion` | ✅ | 整数，目前**只接受 `1`** |
| `kind` | ✅ | `theme` / `fileType` / `server` |
| `description` | | ≤ 300 |
| `author` | | ≤ 60 |
| `homepage` | | ≤ 200 |
| `permissions` | | 数组，元素 ∈ `fs.read` `fs.write` `ui.toast` `settings.rw`；会去重；`kind === "theme"` 时必须为空 |

被 trim；空字符串视为"未提供"。必填项缺失或全空白 → `manifest 缺少 xxx`。

## kind = theme

```json
{
  "theme": {
    "light": { "--background": "oklch(0.98 0.01 90)" },
    "dark":  { "--background": "oklch(0.22 0.02 220)" },
    "fontSans": "'Google Sans Flex', system-ui, sans-serif",
    "noise": true
  }
}
```

- `light` / `dark` 各 ≤ 80 个令牌，**两者合计至少 1 个**（否则 `theme.light / theme.dark 至少要有一些令牌`）
- 令牌名：`^--[a-zA-Z0-9-]{1,40}$`
- 令牌值：≤ 200 字符，禁止 `;` `{` `}` `@` `<` `>` `\` 换行，以及 `url(` / `expression(` / `javascript:`（大小写不敏感）
- `fontSans`：≤ 120 字符，同一套禁用字符
- `noise`：布尔，可选
- 声明了 `entry` / `extensions` / `modes` / `actions` 也没用——theme 不读它们（但字段本身在允许列表里，不会因此报错）

## kind = fileType

```json
{ "entry": "index.html", "extensions": ["foo", "foo2"], "modes": ["preview", "edit"] }
```

| 字段 | 规则 |
|---|---|
| `entry` | 必填，≤ 120；`^[A-Za-z0-9._/-]+\.html$`，且**不能含 `..`** |
| `extensions` | 必填且非空；每项 `^[A-Za-z0-9]{1,12}$`（**不带点**），统一转小写 |
| `modes` | 可省略，默认 `["preview"]`；只接受 `preview` / `edit` |

`extensions` 决定"哪些后缀交给这个插件"。同一后缀有多个插件时，宿主按**名称字典序**取第一个。
`modes: ["edit"]` 表示插件愿意接管编辑；宿主还要看当前用户是否有 `editFiles`（`canWrite`）。

## kind = server

```json
{ "entry": "main.mjs", "actions": ["rebuild", "stats"] }
```

| 字段 | 规则 |
|---|---|
| `entry` | 必填，≤ 120；`^[A-Za-z0-9._/-]+\.(js|mjs)$`，不能含 `..` |
| `actions` | 必填且非空，≤ 20 项；每项 `^[a-z][a-z0-9_-]{0,31}$`；去重 |

宿主**只**转发清单里声明过的动作名，其余一律 400。`extensions` / `modes` 会被强制清空。

## settings（JSON Schema 子集）

后台「设置 → 插件 → 设置」按它自动渲染表单；服务端保存时按它**再校验一遍**。

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "accent":  { "type": "string",  "title": "主色", "enum": ["auto", "blue", "green"], "default": "auto", "public": true },
    "heading": { "type": "string",  "title": "标题", "maxLength": 40, "placeholder": "留空用文件名", "public": true },
    "rows":    { "type": "integer", "title": "行数", "minimum": 1, "maximum": 500, "default": 50 },
    "compact": { "type": "boolean", "title": "紧凑", "default": false },
    "apiKey":  { "type": "string",  "title": "API Key" }
  }
}
```

规则：

- `type` 必须是 `"object"`；`additionalProperties` 若出现**只能**是 `false`
- `properties` 最多 20 项；键名 `^[a-zA-Z0-9_-]{1,32}$`
- 属性 `type` ∈ `string` / `number` / `integer` / `boolean`
- 展示用：`title` ≤ 60、`description` ≤ 200、`placeholder` ≤ 60（都只在 string 上生效，会被截断）
- `string`：可带 `enum`（≤ 30 个字符串）或 `maxLength`（1…4000）；`default` 字符串 ≤ 200
- `number` / `integer`：可带 `minimum` / `maximum` / 数字 `default`；`integer` 保存时会校验 `Number.isInteger`
- 保存时：`boolean` 严格 `=== true`；`string` 带 `enum` 时必须命中，否则按 `maxLength`（默认 200）截断；`number` 用 `Number()` 转，`NaN` 直接 400
- **只保留 schema 里声明过的键**，多余字段丢弃

### `public`：这一项要不要暴露给浏览器

`public: true` 表示"允许把这个设置项下发给浏览器"。**默认是 `false`（不下发）**。

为什么这样做：`GET /api/plugins/list` 是**匿名可访问**的（访客也要能预览文件，插件需要自己的
外观类配置），而插件设置最自然的用途恰恰是放 API key / webhook 地址。所以：

| 设置项 | 写不写 `public` | 结果 |
|---|---|---|
| 主色、字号、标题前缀这类纯外观 | 写 `"public": true` | 出现在 `/api/plugins/list` 的 `settings` 里，`init.settings` 能读到 |
| API Key、Webhook、内网地址 | **不要写** | 只留在服务端 `data/plugins.json`，浏览器/插件一律读不到 |

只有字符串/数字/布尔这类标量会下发（对象/数组一律忽略）。`server` 类插件的 `init.settings`
目前恒为 `{}`，需要配置请在**服务端**自己读取 `data/plugins.json` 或让管理员用文件保存。

> **向后兼容提醒**：这条规则是在 2.0.0 的安全修复里收紧的。老插件如果依赖
> `init.settings` 拿到值，必须在 manifest 里给对应项补 `"public": true`，否则拿到的是空对象。

## 安装期与安装后的错误键

| errorKey | HTTP | 触发 |
|---|---|---|
| `api.plugins.disabled` | 403 | 总开关 `pluginsEnabled` 关着 |
| `api.plugins.empty_package` | 400 | 请求体为空 |
| `api.plugins.not_zip` | 400 | `?filename=` 不以 `.zip` 结尾 |
| `api.plugins.package_too_large` | 400 | 包 > 2 MB |
| `api.plugins.too_many_plugins` | 400 | 已装 ≥ 20 个 |
| `api.plugins.too_many_entries` | 400 | zip 条目 > 300 |
| `api.plugins.zip_slip` | 400 | 条目路径含 `..` / 绝对路径 |
| `api.plugins.file_too_large` | 400 | 包内单文件 > 2 MB |
| `api.plugins.unpacked_too_large` | 400 | 解压总量 > 10 MB |
| `api.plugins.manifest_missing` | 400 | 找不到 manifest.json |
| `api.plugins.manifest_json` | 400 | manifest 不是合法 JSON |
| `api.plugins.manifest_invalid` | 400 | 通用校验失败（默认键） |
| `api.plugins.manifest_missing_field` | 400 | 缺必填字段 |
| `api.plugins.api_version_unsupported` | 400 | `apiVersion` ≠ 1 |
| `api.plugins.permission_unknown` | 400 | 权限名不在白名单 |
| `api.plugins.theme_permissions_denied` | 400 | theme 申请了权限 |
| `api.plugins.entry_invalid` | 400 | entry 后缀/字符集不对，或含 `..` |
| `api.plugins.extensions_missing` | 400 | fileType 没声明 extensions |
| `api.plugins.actions_missing` | 400 | server 没声明 actions |
| `api.plugins.already_installed` | 409 | 同 id 已安装 |
| `api.plugins.manifest_broken` | 400 | 启用时清单读不出来（被手改坏） |
| `api.plugins.not_found` | 404 | id 不存在 / 未启用却请求入口 |
| `api.plugins.not_enabled` | 400 | 未启用就应用主题 / 调动作 |
| `api.plugins.not_theme` / `not_server` | 400 | 类型不符 |
| `api.plugins.setting_invalid` | 400 | 设置项越界/类型不符 |
| `api.plugins.action_not_allowed` | 400 | 动作不在清单里 |
| `api.plugins.start_timeout` | 504 | 10 秒内没收到 `ready` |
| `api.plugins.action_timeout` | 504 | 动作超时（默认 5 秒） |
| `api.plugins.process_gone` | 502 | 子进程已不可用 |
| `api.plugins.entry_missing` | 400 | `entry` 指向的文件不在包里 |
