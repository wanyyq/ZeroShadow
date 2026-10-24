---
name: zeroshadow-plugins-skill
description: ZeroShadow / EPan 网盘插件体系的开发与理解指南 —— 三种插件类型（theme / fileType / server）、manifest.json 校验规则、fileType 的 postMessage 协议、server 的 stdio JSON 协议、zip 打包与 /api/admin/plugins 接口、权限模型（fs.read / fs.write / ui.toast / settings.rw）。Use when the user asks to build, debug, package, review or document a ZeroShadow (EPan) plugin, theme, file-type renderer or server-side plugin, or to understand the plugin lifecycle, sandbox, permissions, manifest schema, settings schema, or plugin HTTP endpoints.
---

# ZeroShadow 插件开发

ZeroShadow（产品名 EPan 网盘）的插件体系。目标是让 Agent 能**读懂现有插件代码**、**从头写出能装上的插件包**、**调用正确的接口**。

## 什么时候用

- 用户要"给网盘写个插件 / 主题 / 某某格式的预览器"
- 用户要排查"插件装不上 / 装上不生效 / 预览是空白 / 动作超时"
- 需要解释插件的能力边界（能读文件吗？能联网吗？是不是沙箱？）
- 需要调 `/api/admin/plugins*` 或 `/api/plugins/*`

如果用户只是问"网盘怎么用"，不要用本 skill。

## 30 秒心智模型

```
插件 = 一个 zip 包（必需 manifest.json）
        │  管理员上传 → 服务端校验 → 解压到 data/plugins/<id>/ → 默认禁用
        │
        ├── theme    声明式 CSS 变量       → 服务端拼成 CSS，前端 <style> 注入
        ├── fileType 自包含单 HTML        → sandbox="allow-scripts" 的 iframe + postMessage
        └── server   独立子进程（node）    → stdin/stdout 一行一 JSON
```

三条必须先记住的边界：

1. **插件永远不直接访问 `/api`**。iframe 是不透明源（无 `allow-same-origin`）+ CSP `connect-src 'none'`，只能 `postMessage` 求宿主代执行；宿主再走服务端 `req.perms`。**但"发不出请求"不等于完全断网**：CSP 没有 `navigate-to`、sandbox 也不禁止自身导航，所以插件可以把自己导航到外部地址。宿主已加了两道校验（消息的 `event.origin` 必须是 `"null"`、入口文档一旦被再次导航就整条会话断链），但**内容本身仍可能随那次导航被带出去**——所以带 `fs.read` 的插件一律只装可信的。
2. **`server` 类插件不是沙箱，是故障隔离**。它和主进程**同一个操作系统用户**，等于"在服务器上以该用户身份执行任意程序"——可以直接读 `.env`（超管明文口令）与 `data/.jwt-secret`（会话签名密钥，拿到即可伪造任意成员登录）。只装可信插件。
3. **两扇门默认关着**：总开关 `pluginsEnabled` 默认 `false`（关着时安装/启用/应用主题一律 403，**连公开的主题 CSS / 运行时清单 / 插件入口也一并停用**）；装完的插件也是**默认禁用**，主题还要再点一次「应用主题」。

## 三种类型怎么选

| 需求 | 选 | 说明 |
|---|---|---|
| 换配色 / 字体 / 圆角 | `theme` | 只能改 CSS 变量，不能跑 JS，零执行风险 |
| 某种后缀的自定义预览或编辑器 | `fileType` | 单个自包含 HTML，可读写当前用户能访问的文件 |
| 定时任务、外部 API 汇总、重计算 | `server` | 独立进程，只通过白名单 `actions` 被调用 |

## manifest.json 骨架

```json
{
  "id": "org.example.myviewer",
  "name": "Foo 预览器",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "fileType",
  "permissions": ["fs.read"],
  "entry": "index.html",
  "extensions": ["foo"],
  "modes": ["preview"],
  "description": "把 .foo 渲染成表格",
  "author": "example",
  "settings": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

**四个最常见的装不上原因**（按出错频率排序）：

1. `id` **必须含至少一个点** —— 正则 `^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+){1,5}$`。`"myplugin"` 装不上，`"org.example.myplugin"` 才行。
2. `version` 必须是 **`x.y.z`**。`"1.0"` / `"v1.0.0"` 一律拒绝。
3. **任何未知顶层字段都会导致安装失败**（宁可装不上，也不静默忽略）。字段白名单见 `references/manifest.md`。
4. `fileType` 的 `entry` 必须是包内 **`.html`**（不能是 `.js`）；`server` 的 `entry` 必须是 **`.js` / `.mjs`**。

## 生命周期

```
上传 zip ──► 校验+解压 ──► data/plugins/<id>/ + plugins.json(enabled:false)
   │                              │
   │                              ├─ PATCH {enabled:true}  → 生效（theme 还需下一步）
   │                              ├─ POST /:id/theme       → 只有 theme 用，全局只有一个生效
   │                              └─ DELETE /:id           → 先停进程再删目录
   └─ 升级 = 先卸载再安装（不会自动更新：权限可能变，必须管理员重新确认）
```

状态文件 `data/plugins.json`：

```json
{ "version": 1,
  "plugins": { "org.example.x": { "enabled": false, "installedAt": 0, "sha256": "…", "settings": {} } },
  "activeTheme": "" }
```

## 权限（会被强制执行）

| 权限 | fileType 里对应 | 强制点 |
|---|---|---|
| `fs.read` | `readText` / `readBinary` | 宿主 `plugin-frame.tsx` 的 `requirePerm()` |
| `fs.write` | `saveText` | 同上（**另需**当前用户有 `editFiles`） |
| `ui.toast` | `notify` | 同上 |
| `settings.rw` | 后台设置表单 | 已可用 |

不声明就调用 → 宿主直接回 `{ok:false, error:"插件未声明「fs.xxx」权限…"}`，请求根本到不了服务端。**`theme` 插件必须一个权限都不申请**（否则安装失败）。

## fileType 协议（一行版）

```
plugin → host  {type:"zs:ready"}
host   → plugin{type:"zs:init", apiVersion:1, file:{path,name,size,mtime}, settings, canWrite, dark}
plugin → host  {type:"zs:request", id:number, method:"readText"|"readBinary"|"saveText"|"notify", params}
host   → plugin{type:"zs:response", id, ok, result?, error?}
plugin → host  {type:"zs:dirty", dirty:boolean}     // 可选，驱动"未保存"角标
```

插件页面里**没有** `document.cookie`、**不能** `fetch('/api/...')`、**不能**加载外部脚本/字体/图片（只能 `data:` / `blob:`）。整个 UI 与 JS 必须内联在一个 HTML 里。完整可运行示例见 `references/kind-filetype.md`。

> 设置项默认**不随清单下发**（`/api/plugins/list` 是匿名可访问的，全量下发会把管理员填的密钥公开给访客）。插件需要读到的值，必须在 manifest 的 `settings.properties` 里给该项标 `"public": true`；没有标注的项一律读不到（`init.settings` 里没有）。详见 `references/manifest.md` 的「`public`」一节。

## server 协议（一行版）

```
host   → plugin {"type":"init","apiVersion":1,"settings":{}}   // 注意：settings 目前恒为 {}
plugin → host   {"type":"ready"}                               // 10 秒内不给就杀进程
host   → plugin {"type":"action","id":1,"action":"foo","params":{}}
plugin → host   {"type":"result","id":1,"ok":true,"data":{}}    // 单动作默认 5 秒（上限 30 秒）
host   → plugin {"type":"shutdown"}                            // 停用/卸载/宿主退出
```

**stdout 只许输出一行一 JSON**，其余内容会被当成噪音丢弃（并记进最近 20 行 stderr 诊断）。超时是**直接杀进程**。示例见 `references/kind-server.md`。

## 常见错误对照表

| 现象 | 原因 |
|---|---|
| 安装 403 `api.plugins.disabled` | 总开关 `pluginsEnabled` 关着 |
| 安装 400 `id 必须形如 org.example.my-plugin` | `id` 没有点 |
| 安装 400 `manifest 含未知字段：x` | 拼错字段名，或加了自定义字段 |
| 安装 400 `theme 插件不应申请任何权限` | theme 写了 `permissions` |
| 安装 409 `已安装，请先卸载` | 同 id 已存在 |
| 安装 400 `插件包过大（上限 2 MB）` | 包太大（含素材时要精简） |
| 启用 400 `插件清单已损坏` | 装上后手改坏了 `manifest.json` |
| 应用主题 400 `请先启用插件再应用主题` | 少了 PATCH `{enabled:true}` |
| 预览一片空白 | 插件没发 `zs:ready`；或 `entry` 不是 `.html`；或外部资源被 CSP 拦了 |
| 预览报"未声明 fs.read 权限" | manifest 里 `permissions` 没写 |
| 保存报 409 / `VERSION_CONFLICT` | 别人改过文件；必须重新 `readText` 拿新 `baseVersion` |
| 动作 504 + 进程没了 | 超过 5 秒；超时会杀进程，下次调用重新拉起 |
| 动作 502 `插件进程不可用` | 入口文件不存在 / 启动即崩（看 stderr 日志） |

## 参考文件

| 文件 | 内容 |
|---|---|
| `references/manifest.md` | 字段白名单、每条正则、settings JSON Schema 子集、错误键全集 |
| `references/kind-theme.md` | 可用的 CSS 变量名、值的禁区、生成出来的 CSS 长什么样 |
| `references/kind-filetype.md` | 完整协议 + 一份可直接跑的最小编辑器（含读/存/冲突处理） |
| `references/kind-server.md` | 完整协议 + 可直接跑的 `main.mjs` + 环境变量白名单 + 超时/回收语义 |
| `references/http-api.md` | 安装/启停/应用主题/调动作/公开接口，含 curl 与 PowerShell 示例 |
| `references/packaging-and-debug.md` | zip 布局、体积与条目上限、sha256、打包命令、逐步自测清单 |

## 动手前先确认的三件事

1. **目标版本**：本 skill 对应 `apiVersion: 1`（v2.0.0）。宿主只认 `1`。
2. **插件要碰文件吗**：要碰就必须声明 `fs.read` / `fs.write`，并向用户说明"插件能以你当前账号的权限读写你可见的文件"。
3. **用户在什么环境验证**：管理员必须在「设置 → 插件」里打开总开关才能装。没有超管账号时，只能把包做到"可安装+自测清单通过"，不要假称已验证。
