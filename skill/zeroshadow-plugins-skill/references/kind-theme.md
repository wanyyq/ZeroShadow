# theme 插件：声明式 CSS 变量

`theme` 插件**不执行任何代码**，只提供 CSS 自定义属性的键值对。服务端把它们拼成一段
作用域受限的 CSS，前端塞进 `<head>` 的 `<style id="zs-plugin-theme">`，并给 `<html>` 打上
`data-theme-plugin="<id>"`。

## 最小可安装包

```
org.example.solarized.zip
└── manifest.json
```

```json
{
  "id": "org.example.solarized",
  "name": "Solarized 暖色",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "theme",
  "theme": {
    "light": {
      "--background": "oklch(0.9803 0.0108 85.5)",
      "--foreground": "oklch(0.3500 0.0200 70)",
      "--primary":    "oklch(0.5500 0.1200 55)",
      "--border":     "oklch(0.3500 0.0200 70 / 14%)"
    },
    "dark": {
      "--background": "oklch(0.2100 0.0150 70)",
      "--foreground": "oklch(0.9200 0.0100 85)"
    }
  }
}
```

`theme` 里一个令牌都没有 → 安装失败。只有 `light` 也可以，但暗色模式下会保持默认。

## 可以覆盖哪些变量

主题实际生效的机制是**覆盖 `:root` / `.dark` 上定义的同名变量**。当前应用定义了两套（浅色在 `:root`、
深色在 `.dark`），名单位于 `web/src/index.css`：

### 基础色板（最常用）

| 变量 | 作用 |
|---|---|
| `--background` / `--foreground` | 页面底色 / 主要文字 |
| `--card` / `--card-foreground` | 卡片 |
| `--popover` / `--popover-foreground` | 浮层、下拉、右键菜单 |
| `--primary` / `--primary-foreground` | 主色按钮、选中态 |
| `--secondary` / `--secondary-foreground` | 次级按钮 |
| `--muted` / `--muted-foreground` | 弱化背景 / 次要文字（说明文字、时间戳） |
| `--accent` / `--accent-foreground` | 悬停高亮 |
| `--destructive` | 危险操作（删除） |
| `--border` / `--input` / `--ring` | 描边 / 输入框边 / 焦点环 |
| `--chart-1` … `--chart-5` | 图表配色 |

### 侧栏（想做出"另一种质感"时改这里）

`--sidebar` `--sidebar-foreground` `--sidebar-primary` `--sidebar-primary-foreground`
`--sidebar-accent` `--sidebar-accent-foreground` `--sidebar-border` `--sidebar-ring`

### 其它

`--radius-sm|md|lg|xl|2xl|3xl|4xl`、`--text-xs|sm|base|lg`、`--font-sans`、`--font-heading`、`--font-mono`。
改字体更推荐用 `theme.fontSans`（它会单独生成一条 `body { font-family }`）。

> 不是白名单 —— 服务端只校验**名字格式**（`--` 开头、`[a-zA-Z0-9-]{1,40}`）和**值的安全性**，
> 所以任何 `--xxx` 都能写。但写应用没用到的变量等于没效果。
> 想看某个新版本新增了哪些变量：直接读 `web/src/index.css` 的 `:root` / `.dark` 块。

## 值的规则（会被服务端拒绝）

- 长度 ≤ 200 字符
- **禁止**：`;` `{` `}` `@` `<` `>` `\` 以及换行
- **禁止**：`url(`、`expression(`、`javascript:`

为什么这么严：值会被直接拼进一条 CSS 规则（`--k:v;`）。能带 `;` 或 `}` 就能"逃出"这条规则改写整页样式，
`url()` 还能让浏览器发出外部请求（泄露访问者 IP）。

允许的写法：`oklch(...)`、`hsl(...)`、`#rgb`、`rgb(0 0 0 / 12%)`、`0.75rem`、`system-ui`、
`'Google Sans Flex', sans-serif`。

## 生成出来的 CSS 长什么样

服务端 `themeCss()` 的输出：

```css
html[data-theme-plugin="org.example.solarized"]{--background:…;--foreground:…}
html[data-theme-plugin="org.example.solarized"].dark{--background:…;--foreground:…}
html[data-theme-plugin="org.example.solarized"] body{font-family:…}
```

为什么用 `html[…="id"]` 而不是 `:root`：它的特异性是 **(0,1,1)**，高于 `:root` / `.dark` 的 **(0,1,0)**，
所以不需要 `!important` 就能稳定覆盖。**因此你也不需要写 `!important`** —— 写了反而会在切换主题时残留。

## 生效流程与常见坑

1. 安装（总开关必须开）
2. `PATCH /api/admin/plugins/<id>` `{"enabled": true}`
3. `POST /api/admin/plugins/<id>/theme` `{"active": true}` ← **少这一步就看不到任何变化**
4. 刷新页面（前端在首屏会 `GET /api/plugins/theme`）

| 坑 | 说明 |
|---|---|
| 只启用、没「应用主题」 | 全局**同时只能有一个**主题生效，必须单独确认 |
| 改了 zip 重新装报 409 | 同 id 已存在：先 `DELETE` 再装（升级 = 卸载 + 安装） |
| 颜色写了但没变化 | 变量名拼错，或改的是应用没引用的变量 |
| 权限写了 `permissions` | theme **必须为空**，否则安装 400 |
| 想加 JS 动效 | 做不到。theme 没有 JS 通道，需要动效请用 `fileType`（只有预览区域内生效） |

## 自测清单

- [ ] `POST /api/admin/plugins?filename=x.zip` 返回 201，`enabled: false`
- [ ] `PATCH {enabled:true}` 后 `GET /api/admin/plugins` 里 `enabled: true`
- [ ] 未应用主题时 `GET /api/plugins/theme` 返回 `{id:"",css:""}`
- [ ] 应用后该接口的 `css` 含 `data-theme-plugin="<你的 id>"` 与你的变量
- [ ] 页面刷新后配色变化；切到暗色模式后 `.dark` 那套生效
- [ ] `DELETE /api/admin/plugins/<id>` 后主题自动回落，页面恢复默认
