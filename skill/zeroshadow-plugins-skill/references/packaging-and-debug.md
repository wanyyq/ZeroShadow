# 打包、安装流程与排错

## 体积与条目上限

| 限制 | 值 | 超出时 |
|---|---|---|
| zip 文件本身 | 2 MB（HTTP 层另限 3 MB） | 400 `api.plugins.package_too_large` |
| 包内文件数 | 300 | 400 `api.plugins.too_many_entries` |
| 单个文件（解压后） | 2 MB | 400 `api.plugins.file_too_large` |
| 全部解压总量 | 10 MB | 400 `api.plugins.unpacked_too_large` |
| 已安装插件数 | 20 | 400 `api.plugins.too_many_plugins` |

`fileType` 插件的资源必须**内联**（CSP 不让加载外部文件），所以要塞进 2 MB 的 zip 里。
真想带大素材（图标集、词表），压缩后再内联成 base64 通常就已经超限了 —— 这种情况改用
`server` 插件预处理，或让插件只依赖宿主给的 CSS 变量。

## zip 布局：两种都接受

```
# ① manifest.json 在包根（推荐）
myplugin.zip
├── manifest.json
├── index.html
└── assets/app.js          ← fileType 里其实加载不到外部 js，放这里只是存档

# ② 单一顶层目录（从 GitHub 直接下 zip 的常见形态）
myplugin.zip
└── myplugin/
    ├── manifest.json
    └── index.html
```

服务端先看包根有没有 `manifest.json`，没有就遍历**一级子目录**找第一个带 `manifest.json` 的目录，
并把它整个 rename 成 `data/plugins/<id>`。所以：

- ❌ 不要把 manifest 埋在两层以上（`dist/web/manifest.json`）→ 400 `manifest_missing`
- ❌ 不要放**两个**各有 manifest 的顶级目录 → 只会用到 readdir 顺序里的第一个（另一个留在临时目录里被丢弃）

## 打包

### PowerShell（Windows 自带，无需安装）

```powershell
# 目录结构：.\org.example.fooviewer\{manifest.json, index.html}
$src = '.\org.example.fooviewer'
$zip = '.\org.example.fooviewer-1.0.0.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }

# -Path "$src\*"  → 包根是文件内容（①）
Compress-Archive -Path "$src\*" -DestinationPath $zip -CompressionLevel Optimal

# 若想用形态 ②（带一层同名目录），改成：
# Compress-Archive -Path $src -DestinationPath $zip

(Get-Item $zip).Length / 1MB     # 必须 < 2
```

### zip 命令行（Git Bash / WSL / macOS / Linux）

```bash
cd org.example.fooviewer && zip -r9 ../org.example.fooviewer-1.0.0.zip . -x '.*' -x '__MACOSX/*'
```

> macOS 的 Finder「压缩」会带 `__MACOSX/` 与 `.DS_Store`：功能上不影响（解压时按普通文件处理，
> 只是占条目数），但没必要，建议用上面的命令。

## 安装时服务端到底做了什么

```
1. 校验：总开关开 / 体积极限 / filename 以 .zip 结尾 / 已装数量 < 20
2. mkdtemp 到 data/tmp/plugin-XXXX，把 zip 落盘
3. 逐条解压（这一步是安全边界）：
     · 跳过非 File/Directory（符号链接直接不写）
     · 路径含 ".."、以 "/" 开头、绝对路径 → 400 zip_slip
     · 累计条目/单文件/总量超限 → 400
4. 找 manifest.json（根或一级子目录）
5. normalizeManifest：字段白名单 + 每条正则 + 权限白名单
6. 查重：plugins.json 里有这个 id，或 data/plugins/<id> 已存在 → 409
7. fs.rename(解压出的根目录 → data/plugins/<id>)   ← 原子，要么全有要么全无
8. hashDirectory 算 sha256（相对路径 + 内容，排序后）
9. plugins.json 写入 { enabled:false, installedAt, sha256, settings:{} }
10. 清理临时目录
```

装完在磁盘上的样子：

```
data/plugins.json                       # 状态（启停、sha256、私有设置、activeTheme）
data/plugins/<id>/manifest.json         # 包内容，原封不动
data/plugins/<id>/index.html
```

`data/plugins/` 与 `data/plugins.json` 都在 `safety.js` 的敏感名单里：**网盘接口读不到、列不出、打不了包**。

## 排错：从哪儿看

| 想看什么 | 去哪儿 |
|---|---|
| 插件是否装/启用/损坏 | `GET /api/admin/plugins`（`broken` 字段）或后台「设置 → 插件」 |
| 磁盘上的真实内容 | `data/plugins/<id>/`、`data/plugins.json` |
| 服务端事件 | `data/logs/zs-YYYY-MM-DD.log`，相关 event：`plugin_install` `plugin_toggle` `plugin_uninstall` `plugin_uninstall_rm` `plugin_action` `plugin_process_exit` |
| server 插件的 stderr | 同上，`plugin_process_exit` 的 msg 里带最后 3 行；完整 20 行只在内存里 |
| fileType 插件的 JS 报错 | 预览页按 F12 —— iframe 的 console 会汇总到同一个 DevTools |
| postMessage 流量 | 在插件 HTML 里临时加一行打印（见下） |

插件 HTML 里临时插的调试代码：

```js
window.addEventListener("message", (e) => {
  console.log("[plugin←host]", e.data)
}, true)
const _post = parent.postMessage.bind(parent)
parent.postMessage = (msg, origin, transfer) => {
  console.log("[plugin→host]", msg)
  _post(msg, origin, transfer)
}
```

## 三种"卡住了"的修法

### ① 装了但改不动（同 id 无法重装）

升级 = 先卸载再安装：

```powershell
Invoke-RestMethod "$base/api/admin/plugins/$id" -Method Delete -Headers $h -WebSession $sess
```

### ② 目录还在、状态没了（或反过来）

`listPlugins()` 是**遍历 `data/plugins/` 下的目录**生成的，所以：

| 症状 | 原因 | 修法 |
|---|---|---|
| 列表里有、但点卸载报 404 | 目录在、`plugins.json` 里没记录 | 直接删目录；或先调安装把它"补登记"（会 409）后卸载 |
| `plugins.json` 里有、列表里没有 | 目录被删了 | 删掉 `plugins.json` 里那段（或备份回滚） |
| 卸载报 `plugin_uninstall_rm` 失败 | Windows 上文件被占用 | 禁用插件 → 重启服务 → 再卸载 |

最彻底的手工清理（**先停服务**）：

```powershell
# 1) 删目录
Remove-Item -Recurse -Force "data\plugins\<id>"
# 2) 删状态：把 data/plugins.json 里 plugins.<id> 这一段去掉
#    （改前建议先复制一份 plugins.json；服务启动时若 JSON 坏了会被 integrity 隔离）
```

### ③ 主题应用了但页面没变

1. `GET /api/plugins/theme` 看 `css` 是不是空 —— 空说明 `activeTheme` 没设上（要 POST `/:id/theme`）
2. `css` 有内容但页面没变 —— 打开的页面是缓存的老版本（`Cache-Control: no-cache`，强制刷新一次）
3. 变量名对但颜色没变 —— 服务端只校验格式，不校验"这个变量应用有没有用到"；对照 `web/src/index.css` 的 `:root` 块

## 发布前检查清单

- [ ] `manifest.json` 是合法 JSON（无尾逗号、无注释）
- [ ] `id` 含点、全小写、全局唯一（不要再发同 id 的不同版本）
- [ ] `version` 是 `x.y.z`
- [ ] `kind` 与必填字段匹配（theme→`theme`；fileType→`entry`+`extensions`；server→`entry`+`actions`）
- [ ] 没有未知顶层字段
- [ ] theme 的 `permissions` 为空
- [ ] fileType / server 只申请真正用到的权限
- [ ] `entry` 文件真的在包里，路径大小写与磁盘一致（Linux 上区分大小写）
- [ ] zip < 2 MB，条目 < 300
- [ ] 装上后 `enabled: false`；启用、应用、卸载都能走通
- [ ] 打包时**没有**把 `node_modules/`、`.git/`、测试产物带进去
