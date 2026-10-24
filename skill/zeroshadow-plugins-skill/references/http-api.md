# 接口参考

分三组：

| 前缀 | 权限 | 说明 |
|---|---|---|
| `/api/admin/plugins*` | **超管**（`requireRole("superadmin")`） | 安装、启停、设置、选主题、调动作 |
| `/api/plugins/theme`、`/list`、`/entry/:id` | **公开** | 主题 CSS、运行时插件清单、插件入口 HTML |
| `/api/admin/plugins` 自身 | 超管 | **不受**总开关影响，`pluginsEnabled` 关闭时也能列出（用于展示开关状态） |

---

## 0. 先解决身份与 CSRF

所有 `/api` 的**写请求**（非 GET/HEAD/OPTIONS）都必须带：

```
X-Requested-With: XMLHttpRequest
```

否则 403 `api.auth.csrf_failed`。另外若请求带了 `Origin`，它必须与 `Host` 一致；带了 `Sec-Fetch-Site`
则必须是 `same-origin` 或 `none`。会话是 httpOnly Cookie `zs_token`（JWT，默认 72 小时）。

### 登录（PowerShell 7 / 5.1）

```powershell
$base = 'http://127.0.0.1:5170'
$body = @{ username = 'admin'; password = '<SUPER_ADMIN_PASSWORD>' } | ConvertTo-Json
$null = Invoke-WebRequest -Uri "$base/api/auth/login" -Method Post -Body $body `
  -ContentType 'application/json' `
  -Headers @{ 'X-Requested-With' = 'XMLHttpRequest' } `
  -SessionVariable sess
# 之后所有请求加 -WebSession $sess
```

### 登录（curl）

```bash
BASE=http://127.0.0.1:5170
curl -s -c jar.txt -H 'X-Requested-With: XMLHttpRequest' \
     -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"<口令>"}' $BASE/api/auth/login
# 之后所有请求加 -b jar.txt
```

超管口令在服务端 `.env` 的 `SUPER_ADMIN_PASSWORD`（首次运行自动生成并打印一次）。

---

## 1. `GET /api/admin/plugins`

列出全部插件 + 总开关状态。

```json
{
  "enabled": true,
  "summary": { "total": 2, "enabled": 1, "activeTheme": "org.example.solarized", "max": 20 },
  "plugins": [
    {
      "id": "org.example.solarized",
      "installed": true,
      "enabled": true,
      "installedAt": 1761300000000,
      "sha256": "…64 位十六进制…",
      "broken": false,
      "activeTheme": true,
      "settings": { "accent": "blue" },
      "manifest": {
        "id": "org.example.solarized",
        "name": "Solarized 暖色",
        "version": "1.0.0",
        "apiVersion": 1,
        "kind": "theme",
        "description": "…",
        "author": "…",
        "homepage": "…",
        "permissions": [],
        "settings": { "type": "object", "additionalProperties": false, "properties": {} },
        "actions": []
      }
    }
  ]
}
```

`broken: true` = 目录还在但 `manifest.json` 读不出来（被手改坏）→ 仍然列出，方便卸载。
`sha256` 是**安装时**对整个目录算的摘要（相对路径 + 内容，排序后哈希），用于人工比对，不参与运行期校验。

---

## 2. `POST /api/admin/plugins?filename=<名字>.zip` —— 安装

请求体是 **zip 的原始字节**（不是 multipart）。

```bash
curl -s -b jar.txt -H 'X-Requested-With: XMLHttpRequest' \
     -H 'Content-Type: application/zip' \
     --data-binary @org.example.fooviewer-1.0.0.zip \
     "$BASE/api/admin/plugins?filename=org.example.fooviewer-1.0.0.zip"
```

```powershell
Invoke-WebRequest -Uri "$base/api/admin/plugins?filename=org.example.fooviewer-1.0.0.zip" `
  -Method Post -InFile .\org.example.fooviewer-1.0.0.zip -ContentType 'application/zip' `
  -Headers @{ 'X-Requested-With' = 'XMLHttpRequest' } -WebSession $sess
```

- `Content-Type` 只接受 `application/zip`、`application/x-zip-compressed`、`application/octet-stream`，原始体积上限 **3 MB**（解包前的护栏是 2 MB）
- `?filename=` 必须 `.zip` 结尾（服务端只看扩展名决定收不收）
- 成功：`201 { "ok": true, "plugin": { …规范化后的 manifest…, "sha256": "…", "enabled": false } }`
- **装完默认禁用**，必须再 PATCH 一次

---

## 3. `PATCH /api/admin/plugins/:id` —— 启停 / 保存设置

```json
{ "enabled": true }
```

```json
{ "settings": { "accent": "blue", "compact": true } }
```

两个字段可以一起发。`settings` 会按 manifest 的 schema 逐项校验，**只保留声明过的键**。

- 成功：`{ "ok": true, "plugin": { …同列表里的一行… } }`
- 未启用就保存设置也可以（设置在启用后生效）
- 启用时会重新读一次清单；清单坏了 → 400 `api.plugins.manifest_broken`

---

## 4. `POST /api/admin/plugins/:id/theme` —— 应用 / 取消主题

```json
{ "active": true }
```

- 只有 `kind: "theme"` 且**已启用**才能应用（否则 400 `not_theme` / `not_enabled`）
- 全局同时只有一个主题生效：应用 B 会自动让 A 失效
- 取消：`{"active": false}`，或 `DELETE /api/admin/plugins/theme/active`
- 成功：`{ "ok": true, "activeTheme": "org.example.solarized", "theme": { "id": "…", "name": "…" } }`

---

## 5. `DELETE /api/admin/plugins/:id` —— 卸载

返回 `{ "ok": true }`。行为：先 `stopPlugin`（发 shutdown 再 kill，Windows 上目录被占用就删不掉）→
删 `plugins.json` 里的记录 → `rm -rf data/plugins/<id>` → 若它是当前主题则清空 `activeTheme`。

---

## 6. `POST /api/admin/plugins/:id/action` —— 调 server 插件的动作

```json
{ "action": "rebuild", "params": { "batchSize": 100 } }
```

成功：`{ "ok": true, "data": <插件返回的 data> }`

| 状态 | errorKey | 说明 |
|---|---|---|
| 400 | `api.plugins.not_found` | id 不存在 |
| 400 | `api.plugins.manifest_broken` | 清单坏了 |
| 400 | `api.plugins.not_enabled` | 未启用 |
| 400 | `api.plugins.not_server` | 不是 server 类 |
| 400 | `api.plugins.action_not_allowed` | 动作不在清单里 |
| 502 | `api.plugins.process_gone` | 子进程不可用 |
| 504 | `api.plugins.action_timeout` / `start_timeout` | 超时（进程已被杀） |

---

## 7. `GET /api/plugins/theme` —— 公开，当前主题 CSS

```json
{ "id": "org.example.solarized", "name": "Solarized 暖色",
  "css": "html[data-theme-plugin=\"org.example.solarized\"]{--background:…}" }
```

没有生效主题时返回 `{ "id": "", "name": "", "css": "" }`。前端在首屏把它塞进 `<style id="zs-plugin-theme">`
并给 `<html>` 打 `data-theme-plugin`。

---

## 8. `GET /api/plugins/list` —— 公开，已启用的 fileType 插件

```json
{ "plugins": [
  { "id": "org.example.fooviewer", "name": "Foo 预览器", "version": "1.0.0",
    "kind": "fileType", "extensions": ["foo"], "modes": ["preview", "edit"],
    "permissions": ["fs.read", "fs.write"], "settings": {} }
] }
```

只含**已启用**的 `fileType` 插件（theme 插件与损坏的插件不会出现）。`permissions` 是给宿主做能力裁决用的。

---

## 9. `GET /api/plugins/entry/:id` —— 公开，插件入口 HTML

只返回**已启用**插件的 `entry` 文件，响应头：

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
                         img-src data: blob:; connect-src 'none'; base-uri 'none';
                         form-action 'none'; sandbox allow-scripts
X-Content-Type-Options: nosniff
```

未启用或不存在 → 404 `api.plugins.not_found`。

---

## 错误响应统一形状

```json
{
  "error": "中文原文（始终存在）",
  "errorKey": "api.plugins.xxx",
  "errorParams": { "limit": "2 MB" },
  "code": "VERSION_CONFLICT"
}
```

`errorKey` 缺失时前端回落显示 `error`。插件相关的错误键全集见 `manifest.md` 末尾的表。

---

## 一条命令跑完整个流程（PowerShell）

```powershell
$base = 'http://127.0.0.1:5170'
$h    = @{ 'X-Requested-With' = 'XMLHttpRequest' }

# 1. 登录
$login = @{ username='admin'; password='<口令>' } | ConvertTo-Json
$null = Invoke-WebRequest "$base/api/auth/login" -Method Post -Body $login `
          -ContentType 'application/json' -Headers $h -SessionVariable sess

# 2. 安装
$name = 'org.example.fooviewer-1.0.0.zip'
$r = Invoke-RestMethod "$base/api/admin/plugins?filename=$name" -Method Post `
       -InFile ".\$name" -ContentType 'application/zip' -Headers $h -WebSession $sess
$id = $r.plugin.id
"已安装 $id，enabled=$($r.plugin.enabled)"

# 3. 启用
$r2 = Invoke-RestMethod "$base/api/admin/plugins/$id" -Method Patch `
        -Body (@{ enabled = $true } | ConvertTo-Json) -ContentType 'application/json' `
        -Headers $h -WebSession $sess
"启用后 enabled=$($r2.plugin.enabled)"

# 4. 若是主题插件，再应用
# Invoke-RestMethod "$base/api/admin/plugins/$id/theme" -Method Post `
#   -Body (@{ active = $true } | ConvertTo-Json) -ContentType 'application/json' `
#   -Headers $h -WebSession $sess

# 5. 验证公开接口
(Invoke-RestMethod "$base/api/plugins/list").plugins | Format-Table id, name, extensions
```
