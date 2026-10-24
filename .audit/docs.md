# ZeroShadow 文档 ↔ 代码一致性审计报告

- 审计对象：`D:\编程\Wangyq EPan 网盘\EPan`（只读审计，未修改任何源码）
- 代码基准：`server/src/routes/*.js`、`server/src/{config,env,groups,users,shares,version}.js`、`server/index.js`、`web/src/lib/api.ts`、`package.json`、`.env.example`、`scripts/`、根目录各脚本
- 文档基准：树 A = `docs/*.md`；树 B = `docs/mdx/content/docs/**/*.mdx` + `docs/mdx/{README.md,integration/README.md,.authoring/style-guide.md}`；另含根 `README.md`、`CHANGELOG.md`、`SECURITY-AUDIT.md`、`SECURITY-REVIEW.md`
- 判定：**CONFIRMED** = 已用 file:line 双向核对；**SUSPECTED** = 文档与代码表述存在歧义/仅部分可验证

## 结论摘要

| 任务 | 类别 | CONFIRMED | SUSPECTED | 条目 |
|:--|:--|--:|--:|--:|
| T1 接口 | (a) 文档有 / 代码无（幽灵接口） | 0 | 0 | 0 |
| T1 接口 | (b) 代码有 / 文档无（A 树 11 项、B 树 16 项） | 27 | 0 | 27 |
| T1 接口 | (c) 方法 / 路径不符 | 1 | 0 | 1 |
| T1 接口 | (d) 权限 / 角色不符 | 5 | 0 | 5 |
| T1 接口 | (e) 参数 / 响应字段不符 | 7 | 1 | 8 |
| T1 接口 | (f) 错误码 / 文案不符 | 2 | 0 | 2 |
| T2 配置 | 字段 / 默认值 / 数量 / 结构不符 | 6 | 0 | 6 |
| T3 权限 | 权限点 / 依赖 / 归属不符（1 项与 T1-d 重复） | 4 | 0 | 4 |
| T4 双树 | A↔B 实质矛盾或内容丢失（仅计 T4 独有项） | 5 | 0 | 5 |
| T4 双树 | 导航（meta.json）/ 内部链接 | 2 | 0 | 2 |
| T5 命令 | 命令 / 脚本 / 路径 / 版本标记失效 | 4 | 1 | 5 |
| **合计** | | **63** | **2** | **65** |

> 计数口径：T1–T5 各自独立计数，**跨任务重复项会重复出现**（例如“备份受管文件数 4/5/6”同时落在 T1-e、T2、T4；`downloadUrl` 权限同时落在 T1-d、T3、T4）。去重后独立缺陷约 **52** 条。T4 的 “meta.json 导航” 一项为**校验通过（无漂移）**，仍列出以证明已核。

一句话结论：**接口的"有没有"高度一致（0 个幽灵接口），真正的问题是"谁有权限 / 谁被写进文档"**——插件体系（10 个端点）在 A 树完全缺席、分享体系（11 个端点）在 B 树完全缺席；配置文档的**字段计数与快照文件数**在双树都错；权限文档有一处**与自身 §4 和代码同时矛盾**的陈述（`downloadUrl` 不受 `fileWrite` 约束）。

---

# TASK 1 — API 参考 vs 实际路由

## 1.1 路由清单（从代码先构建，共 95 个 HTTP 端点 + 1 个 WebDAV 挂载）

挂载点来自 `server/index.js:124-140`（`/api/auth`、`/api/fs`、`/api/share`、`/api/shares`、`/api/admin/shares`、`/api/admin/plugins`、`/api/admin`、`/api/avatars`、`/api/todos`、`/api/groups`、`/api/i18n`、`/api/plugins`）；WebDAV 挂载见 `server/index.js:107`。

图例：A=`docs/API参考.md`，B=`docs/mdx/content/docs/api/reference.mdx`；✅ 有专节，⚠️ 仅速查表/一行提及，❌ 无。

| # | 方法 路径 | 代码要求（file:line） | A | B | 判定 |
|--:|:--|:--|:--:|:--:|:--|
| 1 | `GET /ping` | 无鉴权，`index.js:64` | ✅135 | ✅186 | 一致 |
| 2 | `GET /api/meta` | 无鉴权，`index.js:120` | ✅142 | ✅193 | 一致 |
| 3 | `GET /api/i18n` | 无，`routes/i18n.js:16` | ✅155 | ✅208 | 一致 |
| 4 | `GET /api/i18n/:code` | 无，`routes/i18n.js:27` | ✅186 | ✅236 | 一致 |
| 5 | `POST /api/auth/login` | 无限流中间件 `rateLimit`，`auth.js:30` | ✅217 | ✅274 | 一致 |
| 6 | `POST /api/auth/change-password` | `requireRole(superadmin,member)`+`requirePerm(changePassword)`，`auth.js:98` | ✅244 | ✅301 | 一致 |
| 7 | `POST /api/auth/logout` | `requireRole(superadmin,member)`，`auth.js:131` | ✅268 | ✅330 | 一致 |
| 8 | `GET /api/auth/groups` | 无，`auth.js:157` | ✅273 | ✅371 | 一致 |
| 9 | `GET /api/auth/me` | 无，`auth.js:167` | ✅288 | ✅335 | 一致 |
| 10 | `GET /api/fs/list` | `browse`，`fs.js:216` | ✅327 | ✅419 | 一致 |
| 11 | `GET /api/fs/download` | **无 requirePerm**，handler 内判 `downloadFile`/`preview`/`htmlPreview`，`fs.js:255,282-293` | ✅360 | ✅452 | 一致 |
| 12 | `GET /api/fs/thumb` | `preview`，`fs.js:1103` | ❌ | ✅479 | **T1-b：A 树缺** |
| 13 | `GET /api/fs/zip` | `downloadFolder`+`rateLimit`，`fs.js:476` | ✅382 | ✅509 | 一致 |
| 14 | `POST /api/fs/mkdir` | `mkdir`，`fs.js:543` | ✅404 | ✅530 | 一致 |
| 15 | `POST /api/fs/create-file` | `upload`，`fs.js:576` | ✅411 | ❌ | **T1-b：B 树缺** |
| 16 | `POST /api/fs/upload` | `upload`，`fs.js:613`；`uploadFolders` 在 handler 内，`fs.js:737` | ✅431 | ✅537 | 一致 |
| 17 | `POST /api/fs/rename` | `rename`，`fs.js:820` | ✅480 | ✅594 | 一致 |
| 18 | `POST /api/fs/delete` | `delete`，`fs.js:857` | ✅490 | ✅604 | 响应字段 T1-e |
| 19 | `POST /api/fs/copy` | `copy`，`fs.js:1037` | ✅507 | ✅628 | 一致 |
| 20 | `POST /api/fs/move` | `move`，`fs.js:1038` | ✅507 | ✅628 | 一致 |
| 21 | `GET /api/fs/stat` | `details`+`rateLimit`，`fs.js:1040` | ✅546 | ✅667 | 一致 |
| 22 | `GET /api/fs/details` | `details`+`rateLimit`，`fs.js:1076` | ✅566 | ✅688 | 一致 |
| 23 | `GET /api/fs/search` | `browse`+`rateLimit`，`fs.js:1140` | ✅610 | ✅734 | 一致 |
| 24 | `POST /api/fs/guest-visibility` | `requireRole`+`manageGuestVisibility`，`fs.js:1166-1169` | ✅632 | ✅757 | 一致 |
| 25 | `POST /api/fs/compress` | `compressZip`+`rateLimit`，`fs.js:1260` | ✅642 | ✅767 | 一致 |
| 26 | `GET /api/fs/compress/status` | `compressZip`，`fs.js:1286` | ✅657 | ✅784 | 一致 |
| 27 | `POST /api/fs/extract` | `extractZip`+`rateLimit`，`fs.js:1323` | ✅664 | ✅792 | T1-f |
| 28 | `GET /api/fs/extract/status` | `extractZip`，`fs.js:1446` | ✅680 | ✅809 | 一致 |
| 29 | `GET /api/fs/file` | `browse`+`rateLimit`，另需 `preview‖downloadFile`，`fs.js:1467,1476` | ✅684 | ✅817 | **T1-d** |
| 30 | `POST /api/fs/save-file` | `editFiles`+`rateLimit`，`fs.js:1532` | ✅741 | ✅876 | 一致 |
| 31 | `POST /api/fs/download-url` | `downloadUrl`+`rateLimit`，`fs.js:1762` | ✅788 | ✅920 | 一致 |
| 32 | `GET /api/fs/download-url/status` | `downloadUrl`，`fs.js:1788` | ✅818 | ✅951 | 一致 |
| 33 | `GET /api/avatars` | `requireRole`，`routes/avatars.js:42` | ✅831 | ✅1579 | 一致 |
| 34 | `GET /api/avatars/:owner` | `requireRole`，`avatars.js:46` | ✅845 | ✅1586 | 一致 |
| 35 | `POST /api/avatars/me` | `requireRole`，`avatars.js:67` | ✅851 | ✅1593 | 一致 |
| 36 | `POST /api/avatars/:owner` | `requireRole`+`canEditOwner`，`avatars.js:80` | ✅863 | ✅1603 | 一致 |
| 37 | `DELETE /api/avatars/:owner` | `requireRole`+`canEditOwner`，`avatars.js:94` | ✅875 | ✅1609 | 一致 |
| 38 | `GET /api/todos` | `requireRole`，`todos.js:12,116` | ✅936 | ✅1494 | T1-f |
| 39 | `POST /api/todos` | `requireRole`，`todos.js:156` | ✅965 | ✅1532 | 一致 |
| 40 | `PATCH /api/todos/:id` | `requireRole`，`todos.js:187` | ✅988 | ✅1544 | T1-e |
| 41 | `POST /api/todos/:id/done` | `requireRole`，`todos.js:231` | ✅998 | ✅1551 | **T1-f** |
| 42 | `DELETE /api/todos/:id` | `requireRole`，`todos.js:250` | ✅1004 | ✅1557 | **T1-f** |
| 43 | `GET /api/groups` | `requireRole`，`routes/groups.js:18,63` | ✅1041 | ✅1416 | T1-e |
| 44 | `GET /api/groups/:id/members` | 组长+`viewMembers`，`groups.js:76-86` | ✅1047 | ✅1440 | 一致 |
| 45 | `POST /api/groups/:id/members` | 组长+`manageMembers`，`groups.js:93-100` | ✅1053 | ✅1446 | 一致 |
| 46 | `PATCH /api/groups/:id` | 组长+**`manageVisibility`**，`groups.js:118-128` | ✅1060 | ✅1454 | **T1-d** |
| 47 | `GET /api/admin/config` | `requireRole(superadmin)`（`admin.js:32`）+ `admin.js:94` | ✅1075 | ✅998 | 一致 |
| 48 | `PATCH /api/admin/config` | 同上，`admin.js:98` | ✅1079 | ✅1002 | 一致 |
| 49 | `DELETE /api/admin/hidden-paths` | 同上，`admin.js:182` | ✅1117 | ✅1037 | 一致 |
| 50 | `GET /api/admin/members` | 同上，`admin.js:196` | ✅1126 | ✅1048 | 一致 |
| 51 | `POST /api/admin/members` | 同上，`admin.js:200` | ✅1134 | ✅1056 | 一致 |
| 52 | `POST /api/admin/members/batch` | 同上，`admin.js:219` | ✅1149 | ✅1071 | 一致 |
| 53 | `POST /api/admin/members/:id/password` | 同上，`admin.js:252` | ✅1159 | ✅1081 | 一致 |
| 54 | `PATCH /api/admin/members/:id` | 同上，`admin.js:264` | ✅1168 | ✅1090 | 一致 |
| 55 | `GET /api/admin/groups` | 同上，`admin.js:296` | ✅1177 | ✅1099 | T1-e |
| 56 | `POST /api/admin/groups` | 同上，`admin.js:304` | ✅1199 | ✅1125 | 一致 |
| 57 | `PATCH /api/admin/groups/:id` | 同上，`admin.js:314` | ✅1218 | ✅1140 | 一致 |
| 58 | `POST /api/admin/groups/:id/members` | 同上，`admin.js:324` | ✅1227 | ✅1152 | 一致 |
| 59 | `DELETE /api/admin/groups/:id` | 同上，`admin.js:336` | ✅1233 | ✅1158 | 一致 |
| 60 | `GET /api/admin/logs` | 同上，`admin.js:348` | ✅1294 | ✅1163 | 一致 |
| 61 | `DELETE /api/admin/logs` | 同上，`admin.js:369` | ✅1331 | ✅1201 | 一致 |
| 62 | `GET /api/admin/logs/export` | 同上，`admin.js:384` | ✅1337 | ✅1208 | 一致 |
| 63 | `GET /api/admin/metrics` | 同上，`admin.js:412` | ✅1238 | ✅1230 | 一致 |
| 64 | `GET /api/admin/metrics/history` | 同上，`admin.js:416` | ✅1265 | ✅1256 | 一致 |
| 65 | `GET /api/admin/backups` | 同上，`admin.js:426` | ✅1271 | ✅1266 | **T1-e（5 vs 4 vs 6）** |
| 66 | `POST /api/admin/backups` | 同上，`admin.js:430` | ✅1276 | ✅1271 | 同上 |
| 67 | `POST /api/admin/backups/restore` | 同上，`admin.js:448` | ✅1283 | ✅1279 | 一致 |
| 68 | `GET /api/admin/status` | 同上，`admin.js:463` | ✅1404 | ✅1359 | 一致 |
| 69 | `GET /api/admin/tunnel` | 同上，`admin.js:474` | ✅1430 | ✅1381 | 一致 |
| 70 | `POST /api/admin/tunnel` | 同上，`admin.js:478` | ✅1434 | ✅1390 | 一致 |
| 71 | `GET /api/admin/trash` | 同上，`admin.js:509` | ✅1358 | ✅1290 | 一致 |
| 72 | `POST /api/admin/trash/restore` | 同上，`admin.js:526` | ✅1383 | ✅1323 | 一致 |
| 73 | `POST /api/admin/trash/purge` | 同上，`admin.js:554` | ✅1393 | ✅1340 | 一致 |
| 74 | `POST /api/admin/trash/empty` | 同上，`admin.js:567` | ✅1397 | ✅1348 | 一致 |
| 75 | `GET /api/shares/options` | `requireRole`，`routes/shares.js:369,378` | ✅1469 | ❌ | **T1-b：B 树缺** |
| 76 | `GET /api/shares/precheck` | `requireRole`+`rateLimit`，`shares.js:391` | ✅1488 | ❌ | 同上 |
| 77 | `POST /api/shares` | `requireRole`+`rateLimit`，`shares.js:429` | ✅1512 | ❌ | 同上 |
| 78 | `GET /api/shares` | `requireRole`，`shares.js:495` | ✅1547 | ❌ | 同上 |
| 79 | `DELETE /api/shares/:id` | `requireRole`，`shares.js:515` | ✅1569 | ❌ | 同上 |
| 80 | `GET /api/admin/shares` | `requireRole(superadmin)`，`shares.js:536,538` | ✅1577 | ❌ | 同上 |
| 81 | `DELETE /api/admin/shares/:id` | 同上，`shares.js:582` | ✅1606 | ❌ | 同上 |
| 82 | `GET /api/share/:token` | 公开+`rateLimit`，`shares.js:246` | ✅1614 | ❌ | 同上 |
| 83 | `POST /api/share/:token/verify` | 公开，`shares.js:258` | ✅1642 | ❌ | 同上 |
| 84 | `GET /api/share/:token/list` | 公开+`rateLimit`，`shares.js:289` | ✅1668 | ❌ | 同上 |
| 85 | `GET /api/share/:token/download` | 公开+`rateLimit`，`shares.js:324` | ✅1693 | ❌ | 同上 |
| 86 | `GET /api/plugins/theme` | 公开，`routes/plugins.js:38` | ❌ | ⚠️1751 | **T1-b** |
| 87 | `GET /api/plugins/list` | 公开，`plugins.js:53` | ❌ | ❌ | **T1-b** |
| 88 | `GET /api/plugins/entry/:id` | 公开，`plugins.js:69` | ❌ | ❌ | **T1-b** |
| 89 | `GET /api/admin/plugins` | `requireRole(superadmin)`，`plugins.js:104,114` | ❌ | ⚠️1752 | **T1-b** |
| 90 | `POST /api/admin/plugins` | 同上 + `pluginsEnabled`，`plugins.js:128-133` | ❌ | ⚠️1752 | **T1-b** |
| 91 | `PATCH /api/admin/plugins/:id` | 同上，`plugins.js:146` | ❌ | ⚠️1752 | **T1-b** |
| 92 | `POST /api/admin/plugins/:id/theme` | 同上，`plugins.js:166` | ❌ | ⚠️1752 | **T1-b** |
| 93 | `DELETE /api/admin/plugins/:id` | 同上，`plugins.js:178` | ❌ | ⚠️1752 | **T1-b** |
| 94 | `DELETE /api/admin/plugins/theme/active` | 同上，`plugins.js:189` | ❌ | ❌ | **T1-b** |
| 95 | `POST /api/admin/plugins/:id/action` | 同上，`plugins.js:210` | ❌ | ❌ | **T1-b** |
| — | `ALL /dav*`（可配） | WebDAV 路由工厂，`index.js:107`；方法集 `webdav.js:56` | ✅1823 | ✅1750 | 方法清单 T1-c |

## 1.2 (a) 文档有、代码无 —— **0 项（CONFIRMED）**

逐个反查：A 树 §1–§11 列出的 84 个端点、B 树列出的 68 个端点全部在代码中存在；`/api/*` 兜底 404 也确实存在（`index.js:142-144`）。**没有幽灵接口**。

## 1.3 (b) 代码有、文档无 —— **27 项（CONFIRMED）**

| 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `docs/API参考.md`（全文无 `thumb`） | — | 缩略图端点存在且是网格视图唯一图源 | `server/src/routes/fs.js:1103` | CONFIRMED（A 树缺 1 项） |
| `docs/API参考.md`（全文无 `plugins`） | — | 10 个插件端点全部存在 | `server/src/routes/plugins.js:38,53,69,114,128,146,166,178,189,210` | CONFIRMED（A 树缺 10 项） |
| `docs/API参考.md:1821` 速查表 | `/api/admin` 覆盖“配置、成员、小组、日志、指标、备份、回收站、分享、状态、隧道” | 少列 `plugins` | 同上 | CONFIRMED |
| `docs/API参考.md:1813-1822` 速查表 | 无 `/api/plugins` 行 | 存在两个插件前缀路由器 | `server/index.js:132,140` | CONFIRMED |
| `docs/mdx/.../api/reference.mdx` 全文 | 无 `create-file` 字样 | `POST /api/fs/create-file` 存在，且 A 树有专节 | `fs.js:576`；A `411` | CONFIRMED（B 树缺 1 项） |
| `reference.mdx:1736-1753` 速查表 | 无 `/api/shares`、`/api/share`、`/api/admin/shares` | 11 个分享端点 | `routes/shares.js:246-592` | CONFIRMED（B 树缺 11 项） |
| `reference.mdx:1751-1752` | 只有 `/api/plugins/theme` 与 `/api/admin/plugins*` 两行 | `GET /api/plugins/list`、`GET /api/plugins/entry/:id`、`DELETE /api/admin/plugins/theme/active`、`POST /api/admin/plugins/:id/action` 完全没有提及 | `plugins.js:53,69,189,210` | CONFIRMED（B 树缺 4 项） |

## 1.4 (c) 方法 / 路径不符 —— **1 项（CONFIRMED）**

| 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `docs/配置参考.md:159`（`configuration.mdx:159` 同文） | 支持的协议方法：`OPTIONS` `PROPFIND` `GET` `HEAD` `PUT` `MKCOL` `DELETE` `COPY` `MOVE` `LOCK` `UNLOCK`（11 个） | 实际声明 12 个，多一个 `PROPPATCH` | `server/src/webdav.js:56` `const DAV_METHODS = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK"` | CONFIRMED |

> 说明：其余 94 个端点的「方法 + 全路径」与文档完全一致（含 `/api/share` 与 `/api/shares` 的单复数区分、`/api/admin/shares` 与 `/api/admin/plugins` 的挂载顺序，见 `index.js:126-133`）。

## 1.5 (d) 权限 / 角色不符 —— **6 项**

| 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `docs/API参考.md:1039` | “`canManageMembers` 决定能否**增删成员与改可见范围**” | 改可见范围要**独立**能力 `manageVisibility`（默认关）；`manageMembers` 只够增删成员 | `server/src/routes/groups.js:126` `if (!isSuper && !(isLeader(req, group) && group.leaderCaps.manageVisibility))`；`groups.js:32` | CONFIRMED |
| `docs/API参考.md:1044-1045` | 成员可见小组条件 = “至少开启 `viewMembers` / `manageMembers` / `manageTodo` 之一” | 还有第 4 项 `manageVisibility` | `routes/groups.js:37-39` | CONFIRMED |
| `docs/mdx/.../guide/permissions.mdx:229` | `manageVisibility` 已是独立能力 | 与代码一致；**A 树权限文档 `权限与角色.md:131` 也正确** | `groups.js:32,38-39` | 一致（错的是 `API参考.md:1039`） |
| `docs/API参考.md:1026`；`permissions.mdx:229` 表 | 小组对象/能力示例里 `leaderCaps` 只列 4 个字段 | 实际 5 个（含 `manageVisibility`） | `server/src/groups.js:32` `LEADER_CAPS = ["viewMembers","manageTodo","editMemberAvatar","manageMembers","manageVisibility"]` | CONFIRMED |
| `docs/API参考.md:689`；`reference.mdx:817` 附近 | `GET /api/fs/file`「权限：`browse`」 | 还需 `preview` 或 `downloadFile`，否则 403/401 | `routes/fs.js:1467` + `1476-1481` `if (!perms.preview && !perms.downloadFile)` | CONFIRMED |
| `docs/API参考.md:884-886` | “`todoEnabled` 关闭时……**标记完成与删除不查这个开关**，仍按各自权限执行” | 完成与删除**都查**并直接 403 | `routes/todos.js:233`、`routes/todos.js:252` | CONFIRMED |
| `docs/API参考.md:1094-1113` | `PATCH /api/admin/config` 可更新字段列举 | 与 `NUMERIC_KEYS`/`BOOLEAN_KEYS`/白名单完全一致 | `routes/admin.js:39-79,102-174` | 一致 |

## 1.6 (e) 参数 / 响应字段不符 —— **8 项**

| 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `docs/API参考.md:494` | 删除响应 = `{deleted, trashed, permanentlyDeleted}` | 还返回 `failed: [{path, error}]`（入站失败、原样保留） | `routes/fs.js:913-920` | CONFIRMED |
| `docs/API参考.md:1274` | 备份受管文件**五个** | **六个**（多 `plugins.json`，v2.0 加入） | `server/src/backup.js:25` `MANAGED_FILES = [..., "plugins.json"]` | CONFIRMED |
| `docs/mdx/.../api/reference.mdx:987` | `GET /api/admin/backups` “列出**四个**受管文件的备份” | 六个 | 同上 | CONFIRMED |
| `docs/API参考.md:1043` | `GET /api/groups` 返回 `allMembers: [成员对象]` | 普通成员（无 `viewMembers`/`manageMembers`）拿到的是 `[]` | `routes/groups.js:67-73` | CONFIRMED |
| `docs/配置参考.md:409-430`（shares.json 结构示例 + 字段表） | 记录字段：id/token/path/name/isFolder/owner/ownerRole/createdAt/expiresAt/requirePassword/passwordHash/downloads/lastAccessAt/note | 还有 `ownerId`、`visibility`（可见范围快照，安全审计 M8 的修复核心） | `server/src/shares.js:307,310` | CONFIRMED |
| `docs/配置参考.md` 缺 3.9 对应节（B 树） | B 树 `configuration.mdx` 从 3.8（隧道）直接跳到“四、浏览器本地存储”，**整节 shares.json 结构丢失** | A 树有 3.9 专节 | `docs/配置参考.md:405-446` vs `configuration.mdx:399-409` | CONFIRMED |
| `docs/API参考.md:1026` | 小组对象示例无 `canManageVisibility` | 序列化结果里始终有 | `routes/groups.js:54` | CONFIRMED |
| `docs/API参考.md:996` | PATCH 待办「传了却没权限时会被忽略，**不报错**」 | 被忽略后若再无其它字段，抛 400 `没有可更新的字段` | `routes/todos.js:209-219` | SUSPECTED（取决于 payload） |
| `docs/API参考.md:1126-1132` | `GET /api/admin/members` 成员对象四字段 | 一致 | `users.js` + `admin.js:197` | 一致 |

## 1.7 (f) 错误码 / 文案不符 —— **2 项**

| 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `docs/API参考.md:677`（`reference.mdx:809` 同） | `POST /api/fs/extract` 错误含 `500 服务端未安装 unzipper 模块，请联系管理员` | 该错误确实被抛出，但全局错误中间件把所有 `status>=500` 的 `error` 改写成 `服务器内部错误`（`errorKey: api.common.server_error`），**客户端永远看不到原句** | 抛出点 `routes/fs.js:1440`；改写点 `server/index.js:220-221` | CONFIRMED |
| `docs/API参考.md:79-90` | 500 = `服务器内部错误`（详情只进日志） | 与 `index.js:220-221` 一致 → 文档**自相矛盾**（§0 与 §3 打架） | 同上 | CONFIRMED（记为 A 树内部矛盾） |
| `docs/API参考.md:262-264` | change-password 错误列表 | 6 条错误文案逐条命中 | `routes/auth.js:103,106,110,116,118` | 一致（已核） |

> 其余 67 条文档里出现的中文错误文案（路径穿越、体积超限、Share/Todo/Group/Avatar/Backup 全量）**逐条 grep 命中**，无其它文案漂移。

## 1.8 已核对并确认一致的高风险细节（抽样，用于说明审计深度）

- 上传上限 `files:100 / fields:10`、`truncated`、`maxFilesPerRequest`：`fs.js:717,705` ↔ A `444,473-474`
- `create-file` 1MB 内容上限、`unique` 语义、201：`fs.js:574,591,607` ↔ A `422-425`
- `save-file` 16MB、`VERSION_CONFLICT`、`currentVersion`、不可映射字符拒绝（最多列 12 个）：`fs.js:1458,1566-1567,1581-1591`、`index.js:225-228` ↔ A `758-779`
- 搜索 200 条 / 30000 条目 / 6 秒 / 关键词 ≤100：`server/src/files.js:161,164,167` ↔ A `615,627`
- 目录统计 20 万条目上限：`files.js:100` ↔ A `563`
- 分享 9 档有效期、密码 6~10、票据 2 小时、错 8/20 次锁 15 分钟、上限 5000、token 24 字符、过期 30 天物理删除：`shares.js:34,36-37,41,47-57,418-420`、`pruneShares()` ↔ A `1459-1462,1527,1545,1665-1666`
- 头像 128×128 WebP、200KB（解析层 2MB）、`ETag`+304：`routes/avatars.js:65,56` ↔ A `847-859`
- WebDAV：`Depth:infinity`→403、5000 子项/507、锁 2000/200、非 PUT 64KB、1200 次/分、凭据缓存 60s：`webdav.js:59,61,63,65,226` ↔ A `559-568`、B `679-685`
- 缩略图 64MB/8000 万像素/并发 2/排队 64/512MB/30 天：`thumbs.js:37,39,41,43,45,47` ↔ A `404-406`

---

# TASK 2 — 配置参考 vs 代码

## 2.1 `.env` 变量（14 个）

结论：**`.env` 层没有漂移**。代码实际读取的 14 个变量与两树文档、`.env.example` 完全对应：

| 变量 | 代码读取点 | 文档 | 判定 |
|:--|:--|:--|:--|
| `PORT`（1–65535，非法回退 12345） | `env.js:145` `clamp(toInt(...,12345),1,65535)` | A`41` B`43` | 一致 |
| `HOST` | `env.js:146` | A`42` B`44` | 一致 |
| `SUPER_ADMIN_USER` | `env.js:147` | A`48` B`50` | 一致 |
| `SUPER_ADMIN_PASSWORD`（空或 `change-me` → 随机并回写） | `env.js:110-126` | A`49` B`51` | 一致 |
| `SESSION_HOURS`（1–8760） | `env.js:149` `clamp(...,1,24*365)` | A`50` B`52` | 一致 |
| `TRUST_PROXY`（false/数字/loopback/linklocal/uniquelocal/网段表） | `env.js:97-108` | A`96-113` B`100-112` | 一致 |
| `FILES_DIR` | `env.js:159-161` | A`59` B`61` | 一致 |
| `FILES_SOFT_DIR`（JSON；名 `1-100`、`^[\w\u4e00-\u9fff\u3400-\u4dbf.-]{1,100}$`；整份作废） | `env.js:163-185` | A`66-95` B`70-98` | 一致 |
| `NOLOG`（+`-nolog`） | `env.js:217` | A`179` B`180` | 一致 |
| `WEBDAV` | `env.js:132-136` | A`143` B`148` | 一致 |
| `WEBDAV_PATH`（补前导 `/`、去尾 `/`） | `env.js:137-142` | A`144` B`149` | 一致 |
| `DOWNLOAD_URL_ALLOW_PRIVATE` | `netguard.js:53`（`envFlag`，每次调用读） | A`121` B`127` | 一致 |
| `DOWNLOAD_URL_ALLOW_HOSTS` | `netguard.js:34-41` | A`122` B`128` | 一致 |
| `DOWNLOAD_URL_INSECURE_TLS` | `netguard.js:47-49` | A`123` B`129` | 一致 |

> B 树 `configuration.mdx:27` 声称“`.env` 一共 14 个变量”——**这个数字是对的**（已逐项数过）。

## 2.2 `data/config.json` 字段

代码基准：`server/src/config.js:7-122`（`DEFAULTS`）+ `server/src/routes/admin.js:39-79`（可写白名单）。

| # | 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|--:|:--|:--|:--|:--|:--|
| 1 | `configuration.mdx:244-247` | “`config.json` 一共 **59** 个字段：**16** 个数值、**11** 个布尔开关、**19** 个成员权限、**8** 个访客权限、**1** 个隐藏列表、**3** 个隧道字段、**1** 组默认可见范围” | 顶层键 **39** 个、叶子值 **67** 个；数值 **16** ✓、布尔 **15**（非 11） | `config.js:7-122`；布尔全集见 `admin.js:58-79`（15 项） | CONFIRMED（数字错） |
| 2 | `configuration.mdx:284-306` | 3.2 表列 13 个布尔，`<Callout>` 称“`shareEnabled` / `sharePublicAccess` **就在上表里**” | 表里**没有**这两行；代码里它们是独立布尔键 | `config.js:47,49`；`admin.js:70-71` | CONFIRMED（自相矛盾 + 缺行） |
| 3 | `docs/配置参考.md:285-291` | 表格在 `webdavPath` 说明块引用处被**切断**：`285-289` 是一段 `>` 引用，`290-291` 的 `shareEnabled`/`sharePublicAccess` 两行落在表格之外 | markdown 渲染后这两行变成普通文本行，表格少两行 | `docs/配置参考.md:269-291` | CONFIRMED（结构缺陷） |
| 4 | `docs/API参考.md:1274`、`configuration.mdx:987` | 备份受管文件：A=“五个”、B=“四个” | **六个** | `server/src/backup.js:25` | CONFIRMED（两树都错，且互不一致） |
| 5 | `docs/配置参考.md:405-446` | `data/shares.json` 结构示例与字段表 | 缺 `ownerId`、`visibility` 两个实存字段 | `server/src/shares.js:307,310` | CONFIRMED |
| 6 | `configuration.mdx`（3.8 → 四） | B 树**没有** shares.json 结构节 | A 树有完整 3.9 | `docs/配置参考.md:405-446` | CONFIRMED（内容丢失） |
| 7 | `configuration.mdx:262` | `avatarMaxKB` 1–10240 | 一致（另要求 128×128，见 `avatars.js`） | `admin.js:49` | 一致 |
| 8 | 3.1 全部 16 个数值区间 | 1–1048576 / 1–100000 / 1–10240 / 1–500 / 1–3650 / 1–365 / 1–1440 / 1–600000 | **逐项与 `NUMERIC_KEYS` 相同** | `admin.js:39-56` | 一致 |
| 9 | 3.2 其余布尔默认值 | `rateLimitEnabled`…`pluginsEnabled` 默认值 | **逐项相同**（`webdavEnabled` 取 `.env` 的 `WEBDAV`） | `config.js:17-67,58` | 一致 |
| 10 | `superSessionEpoch`（A`297-299` / B`303-304`） | 内部字段、不接受 PATCH | 不在 `NUMERIC_KEYS`/`BOOLEAN_KEYS` 内，且 `PATCH` 只写白名单键 | `admin.js:102-174` | 一致 |
| 11 | `defaultVisibility` 清洗规则（A`1112` / B`322-323`） | 去首尾 `/`、`\`→`/`、丢空/`.`/`..`、最多 200 条 | 完全一致 | `admin.js:81-92` | 一致 |
| 12 | `defaultLang` 必须是可用语言 | A`1105-1106` B`342` | 一致（`availableLangs()` 校验） | `admin.js:117-127` | 一致 |
| 13 | `webdavPath` 安全前缀限制 | A`1107-1109` B`156` | 一致（`normalizeDavPath`） | `admin.js:139-151` | 一致 |
| 14 | `tunnel.mode` 枚举（`pinggy`/`localhostrun`/`serveo`/`custom`） | A`364` B`404` | 一致：非法值归一化为 `serveo` | `admin.js:482` | 一致 |
| 15 | 未知字段被忽略 | A`232` B`235,238` | 一致（`deepMerge` 只遍历 base 的键） | `config.js:127-139` | 一致 |

---

# TASK 3 — 权限与角色 vs 代码

代码基准：`config.js:76-106`（`memberPerms`/`guestPerms` 默认值）、`config.js:208-290`（`effectivePerms`）、`groups.js:32-40`（`LEADER_CAPS`）、`groups.js:321-341`（上下文可见性/权限）、各路由 `requirePerm`。

| # | 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|--:|:--|:--|:--|:--|:--|
| 1 | `docs/权限与角色.md:303-308`（§6-C 只读资料库） | “成员：文件操作 ❌ 压缩为 Zip ✅ … 多线程下载器 ✅ / 成员可以…用链接下载器往盘里抓文件——注意：链接下载器写文件走的是**它自己的权限，不受 `fileWrite` 限制**” | `downloadUrl: fw && !!p.downloadUrl` —— **受** `fileWrite` 约束；且 A 树自己 §4（`:177`）也把「多线程下载器」列进 `fileWrite` 收口清单 | `server/src/config.js:260` | CONFIRMED（与代码 + 同文档 §4 + B 树 `permissions.mdx:292` 三方矛盾） |
| 2 | `docs/权限与角色.md:219`；`permissions.mdx:148` | “**打开**文件走「浏览目录」（`GET /api/fs/file`，与列目录同一个权限）” | `browse` **且** (`preview` ‖ `downloadFile`)，否则 403「没有权限读取文件内容」/访客 401 | `routes/fs.js:1467,1476-1481` | CONFIRMED |
| 3 | `docs/权限与角色.md:158-160` | “`defaultVisibility` 管的是‘不属于任何组 / **顶栏选默认**’的情形” | 属于小组的成员选「默认」（或不发头）时用的是**所属各组可见范围的并集**，`defaultVisibility` 只在“不属于任何小组”时生效 | `server/src/groups.js:321-327`、`unionVisibility()` `:298-311` | CONFIRMED（且与同文档 `:119` 自相矛盾） |
| 4 | `docs/权限与角色.md:130`；`permissions.mdx:228` | `manageMembers` = 增删成员（不含可见范围） | 一致 | `routes/groups.js:98` | 一致 |
| 5 | `docs/权限与角色.md:131,134-135`；`permissions.mdx:229` | `manageVisibility` 独立、默认关、只能收窄 | 一致（含 403 `visibility_widen_denied`） | `groups.js:32,39`、`routes/groups.js:126,138-147`、`groups.js:349-368` | 一致 |
| 6 | `docs/API参考.md:1039` | `canManageMembers` 管“增删成员**与改可见范围**” | 可见范围归 `manageVisibility` | `routes/groups.js:126` | CONFIRMED（同 T1-d） |
| 7 | 权限矩阵 20 行（A`36-57`）/ 分表（B`49-90`） | 19 个可配置项 + 固定「查看详细信息」 | `MEMBER_PERM_KEYS` 恰 **19** 键；`details` 成员固定 `true`、访客固定 `false` | `config.js:76-96,125,250,282` | 一致 |
| 8 | 访客 `guestPerms` 8 项默认值（A`329-338` B`370-379`） | browse/downloadFile/downloadFolder/preview=true；compressZip/extractZip/htmlPreview/editFiles=false | 逐项相同 | `config.js:97-106` | 一致 |
| 9 | `guestWrite` 总闸门（A`233-239` B`162-165`） | 关时三项写类子权限一律 false | `gw && !!g.x` | `config.js:115,284-286` | 一致 |
| 10 | `fileWrite` 收口清单（A`171-181` B`106-116`） | 上传/上传文件夹/新建文件夹/复制/移动/重命名/删除/在线编辑/压缩/解压/多线程下载器 | 逐项 `fw &&` | `config.js:239-260` | 一致（除 #1 的 §6-C 反例） |
| 11 | `uploadFolders` 服务端校验（A`199-201` B`130-134`） | 文件名含 `/` 的条目在 `uploadFolders=false` 时被拒 | `if (relDir && !req.perms.uploadFolders)` | `routes/fs.js:737-747` | 一致 |
| 12 | 「允许预览 vs 下载文件」（A`206-212` B`136-142`） | 只有 preview 时强制 inline；不支持内联的类型 → 成员 403/访客 401 | `fs.js:282-293` | 一致 |
| 13 | 成员上限 500 / 批量 200 / 用户名 `2-32` / 密码 `6-128` / bcrypt cost 10（A`24-26` B`31-33`） | 全部一致 | `users.js:8,9,65,107` | 一致 |
| 14 | 超管令牌含“密码派生指纹”（A`22` B`29`） | `pv = sha256(password)` 前 16 位；`se` 会话代次 | `auth.js:17,50,61` | 一致 |
| 15 | 访客隐藏：仅文件夹、404 而非 403、rename/move 自动跟随、delete 自动清理（A`254-278` B`238-262`） | 全部一致 | `fs.js:1177,340-351,896-900`；`fs.js:219,261` | 一致 |

---

# TASK 4 — 文档树 A vs 树 B 漂移

## 4.1 抽样逐对比较

### 4.1.1 `配置参考.md` ↔ `admin/configuration.mdx`

| 文档位置 | 文档内容 | 代码实际 / 对侧文档 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `configuration.mdx:244` | 59 字段 / 11 布尔 | 实为 39 顶层 / 67 叶子 / 15 布尔；A 树不写总数 | `config.js:7-122` | CONFIRMED |
| `configuration.mdx:288-300` | 3.2 表 13 行 | A 树 3.2 表 15 行（含 `shareEnabled`/`sharePublicAccess`） | A`269-291` | CONFIRMED |
| `configuration.mdx:305` | “就在上表里” | 上表没有这两行 | 同上 | CONFIRMED |
| `configuration.mdx:399-409` | 3.8 之后直接进“四” | A 树有 3.9 `data/shares.json` 专节 42 行 | A`405-446` | CONFIRMED（内容丢失） |
| `docs/配置参考.md:285-289` | `webdavPath` 引用块插在表格中间 | B 树把该说明放在 3.2 之外的独立小节，表格完整 | B`302-306` | CONFIRMED（A 树渲染缺陷） |
| 14 个 `.env` 变量 | 两树一致 | `env.js` 全部命中 | — | 一致 |

### 4.1.2 `API参考.md` ↔ `api/reference.mdx`

| 文档位置 | 文档内容 | 对侧文档 / 代码 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `reference.mdx`（全文） | 无分享章节 | A 树 §8 有 11 个端点、9 档有效期、票据语义等约 270 行 | A`1445-1713` | CONFIRMED |
| `docs/API参考.md`（全文） | 无 `thumb` | B 树有 `GET /api/fs/thumb` 专节 + 参数/缓存/501 降级 | B`479-507` | CONFIRMED |
| `reference.mdx`（全文） | 无 `create-file` | A 树有专节（1MB 上限、`unique`、201） | A`411-429` | CONFIRMED |
| `reference.mdx:987` | 备份“四个受管文件” | A 树“五个”，代码**六个** | `backup.js:25` | CONFIRMED |
| `docs/API参考.md:152-153`；`reference.mdx:202-205` | “改版本号必须同时改**三处**” | `开发者指南.md:1139-1155` 给出 **10 项**清单；`architecture.mdx:860` 又说“一共 **8 处**”；实际涉及 3 个 `package.json` + `index.js` + `version.ts` + `sw.js` + 文档若干 | `docs/API参考.md:152`、`docs/开发者指南.md:1139`、`docs/mdx/content/docs/development/architecture.mdx:860`、`web/src/version.ts:12`（`VERSION = "2.0.0-beta"`）、`web/public/sw.js:22` | CONFIRMED（三处口径互不一致，且“三处”漏掉 `sw.js`） |
| `docs/API参考.md:7` | “路由在 `server/src/routes/`（…共 **7 个文件**）” | 实际 **9 个**（多 `i18n.js`、`plugins.js`） | `server/src/routes/` 目录清单 | CONFIRMED |

### 4.1.3 `权限与角色.md` ↔ `guide/permissions.mdx`

| 文档位置 | 文档内容 | 对侧文档 / 代码 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| A`303-308` | 链接下载器“不受 `fileWrite` 限制” | B`292` 正确写“也要求「文件操作」为开”；代码亦为 `fw &&` | `config.js:260` | CONFIRMED |
| A`218` | §4 强调在线编辑要 `fileWrite` | B`148` 少了这句（只提两个权限点） | B`144-150` | CONFIRMED（B 表述不完整） |
| A`158-160` vs A`119` | `defaultVisibility` 是否管“顶栏选默认”自相矛盾 | B`205-206` 表述正确 | `groups.js:321-327` | CONFIRMED（A 树内部） |
| 权限矩阵 20 行 / 19 项 / `canManageMembers` 描述 | 两树基本一致（B 多了“实际效果”列） | — | — | 一致 |
| 组长能力 5 项 | 两树都正确（A`121-138`、B`218-236`） | `groups.js:32` | — | 一致 |

### 4.1.4 `安全设计.md` ↔ `security/design.mdx`

两树**数值口径高度一致**（登录锁定 30/10 次、15 分钟窗口、5→30 分钟翻倍；13 标签白名单；SSRF 段表；64/8000 万像素；512MB/30 天；1200 次/分…）。差异集中在 B 树**新增汇总表**（认证/路径/SSRF/限流开关一览）与 A 树**独有**的分享安全小节：

| 文档位置 | 文档内容 | 对侧文档 | 位置 | 判定 |
|:--|:--|:--|:--|:--|
| `docs/安全设计.md:529-543` | 分享安全 5 条（票据 2h 绑 token、bcrypt 6~10 位、8/20 次限速、30 天物理删除、可见范围快照） | B 树**整节缺失**；仅 `:560-562` 在限流表里列了 4 个分享端点 | A`529-543` vs B（无） | CONFIRMED（内容丢失） |
| `design.mdx:582-601` | 新增「限流与上限相关开关」19 行汇总表 | A 树无此表（信息分散在 §6） | B`582-601` | 非矛盾（增补） |
| `design.mdx:626-651` | 新增「日志导出为什么不会带出机密」「密钥卫生」 | A 树无 | B`626-651` | 非矛盾（增补） |
| A`5`（`security-test.ps1` 链到 `开发者指南.md#security-testps1安全回归测试`） | 锚点式相对链接 | 需人工点击验证（本次只校验文件存在，锚点未校验） | — | SUSPECTED |
| 两树共同结论 | `smoke-test.ps1` 第 14 组 25 项 DAV 断言、`security-test.ps1` 19 组 | 脚本存在（`security-test.ps1` 头部注释可见 19 组）；未逐条执行 | `security-test.ps1:1-60` | SUSPECTED（未运行验证） |

## 4.2 meta.json 导航 vs 实际文件 —— **无漂移（CONFIRMED 通过）**

`docs/mdx/content/docs/meta.json` 的 `pages = [index, getting-started, guide, admin, security, development, api]`，各子目录 `meta.json` 的 pages 与目录内 `.mdx` **一一对应**：

| 目录 | meta.json pages | 实际文件 | 判定 |
|:--|:--|:--|:--|
| `docs/` | index, getting-started, guide, admin, security, development, api | `index.mdx` + 6 个子目录 | ✅ 对应 |
| `admin/` | admin-guide, configuration, tunnel | 三文件齐全 | ✅ |
| `api/` | reference | ✅ | ✅ |
| `development/` | architecture, plugins, build, testing, release | 五文件齐全 | ✅ |
| `getting-started/` | quickstart, faq | ✅ | ✅ |
| `guide/` | manual, permissions | ✅ | ✅ |
| `security/` | design | ✅ | ✅ |

## 4.3 失效内部链接 / 路径 —— **2 项**

| 文档位置 | 文档内容 | 实际情况 | 判定 |
|:--|:--|:--|:--|
| `docs/mdx/.authoring/style-guide.md:89` | `<Card title="快速开始" href="/docs/getting-started/quickstart" …>` | 该路由不存在；全站实际前缀是 `/docs/zeroshadow/...`（见 `permissions.mdx:336-339`、`reference.mdx:1755-1758`） | CONFIRMED（断链示例） |
| `docs/mdx/.authoring/style-guide.md:162` | 规范条目：“站内页面一律用绝对路径且不带后缀：`[快速开始](/docs/getting-started/quickstart)`” | 同上，**规范本身给的是错前缀**，照抄会产生断链 | CONFIRMED |

> 其余 300+ 相对链接（A→A、根 README→docs、mdx→mdx 路由）经脚本校验全部可解析；`/img/*.png` 解析到 `docs/mdx/public/img/`（存在），`docs/changelog.md:282` 的 `./a.png`/`./b.md` 位于行内代码示例中，均非断链。

---

# TASK 5 — 文档里的命令 / 脚本 / 路径

## 5.1 脚本与命令清单（逐个落地核对）

| 文档位置 | 文档中的命令/路径 | 实际 | 判定 |
|:--|:--|:--|:--|
| `快速开始.md:28-34`、`build.mdx:55-61`、`开发者指南.md:783-789` | `pnpm setup` / `pnpm build` / `pnpm start` / `pnpm dev:server` / `pnpm dev:web` / `pnpm typecheck` / `pnpm lint` | 根 `package.json:7-15` 全部存在；`web/package.json` 有 `dev/build/lint/typecheck/format/preview`；`server/package.json` 有 `start/dev/bundle` | ✅ 全部可用 |
| `开发者指南.md:806`、`build.mdx:78`、`release.mdx:159` | `cd server && pnpm bundle` / `pnpm -C server bundle` | `server/package.json` 的 `bundle` esbuild 脚本存在 | ✅ |
| `开发者指南.md:789`、`build.mdx:61` | `pnpm -C web format` | `web/package.json` `format` 存在 | ✅ |
| `安全设计.md:615`、`security/design.mdx:778`、`开发者指南.md:883`、`testing.mdx:123` | `powershell -File security-test.ps1 -BaseUrl …` | 脚本存在，`param([string]$BaseUrl="http://127.0.0.1:5179", [string]$Root, [string]$User, [string]$Password, …)` | ✅ |
| `docs/开发者指南.md:835-838`、`testing.mdx:30-33` | `powershell -File smoke-test.ps1 [-BaseUrl …]` | 脚本存在，`param([string]$BaseUrl, [string]$Root, [string]$User, [string]$Password, [switch]$KeepScratch)` | ✅ |
| `安全设计.md:628`、`开发者指南.md:937`、`testing.mdx:191`、`design.mdx:791` | `node encoding-test.mjs` | 根目录文件存在 | ✅ |
| `开发者指南.md:727-729`、`architecture.mdx:766-768` | `node i18n-check.mjs [--list-cn\|--strict]` | 根目录文件存在 | ✅（参数未逐条执行验证，SUSPECTED） |
| `开发者指南.md:954`、`changelog.md:244` | `node scripts/office-preview-test.mjs` | `scripts/office-preview-test.mjs` 存在 | ✅ |
| `testing.mdx:7` | “两个 PowerShell 测试脚本和五个 Node 单测 / 校验脚本” | 2 个 `.ps1` + 5 个 Node 脚本（`encoding-test.mjs`、`i18n-check.mjs`、`scripts/{office-preview,markdown-html,markdown-url}-test.mjs`） | ✅ 数字正确 |
| `release.mdx:90-99`、`开发者指南.md:1019-1028` | `pwsh -File build-release.ps1 [-Targets …] [-FrozenLockfile] [-NoZip]` | `build-release.ps1:58-68` 有 `-Root/-Targets/-FrozenLockfile/-SkipInstall/-SkipFrontend/-SkipBundle/-NoZip` | ✅ |
| `release.mdx:179`、`开发者指南.md:1050` | `package-release.ps1 -Platform windows-x64` | `package-release.ps1:50-68` 有 `-Root/-ReleaseDir/-ZipPath/-Platform/-Version/-IncludeDocs/-NoZip/-DryRun` | ✅ |
| 根 `README.md`、`配置参考.md:235`、`configuration.mdx:22,241` | `Auto-building.bat` | 存在；薄封装，转发 `build-release.ps1` | ✅ |
| `docs/mdx/README.md:156-157` | `node docs/mdx/.authoring/validate-mdx.mjs docs/mdx`、`check-coverage.mjs` | 两脚本存在（另有 `check-tsx-syntax.mjs`） | ✅ |
| `快速开始.md:156`、`304` | `sudo -u zeroshadow -H bash -lc 'cd /opt/zeroshadow && pnpm setup && pnpm build'` | 纯 Linux 部署示例，命令本身有效 | ✅ |

## 5.2 命令 / 脚本 / 路径类漂移 —— **4 项**

| # | 文档位置 | 文档内容 | 代码实际 | 位置 | 判定 |
|--:|:--|:--|:--|:--|:--|
| 1 | `README.md:563` | “**v1.2.4（当前版本）** 修好 Markdown 预览的三个实际缺陷…” | 当前版本是 `2.0.0-beta`；文档自己的发布清单（`开发者指南.md:1155`、`release.mdx:277`）明确要求把「当前版本」标在新版本上 | `package.json:4`、`server/index.js:121`、`web/src/version.ts:12`、`web/public/sw.js:22`、`docs/README.md:3`、`docs/changelog.md:16` | CONFIRMED（README 更新日志段未随 2.0 更新） |
| 2 | `SECURITY-AUDIT.md:10` | “此后项目又发布了 v1.2.1 与 v1.2.3，当前版本是 **v1.2.4**” | 当前 `2.0.0-beta` | 同上 | CONFIRMED |
| 3 | `docs/API参考.md:7` | `server/src/routes/` “共 **7 个文件**” | 9 个（缺 `i18n.js`、`plugins.js`） | 目录清单 | CONFIRMED |
| 4 | `docs/开发者指南.md:1139-1155`、`release.mdx:261-277` | “改版本号的完整清单”（10 项）内含“`docs/使用手册.md` 的界面结构示意图”等文档项 | 清单里的 10 项中，`README.md` 这一项**当前就是漏改状态**（见 #1），说明清单与实际状态不一致 | 同上 | CONFIRMED |
| 5 | `SECURITY-AUDIT.md:10,12-13` | 文档自述“文中 `fs.js:1143`、`safety.js:140` 这类行号是 v1.1.2 的行号，与当前源码已不对应” | 属实（当前 `fs.js` 共 1796 行，该行号指向别处） | `server/src/routes/fs.js` | 已自述，不计为新漂移 |

---

# 附：最值得优先修的问题（按影响排序）

1. **插件体系文档缺位**：A 树 0 个插件端点、B 树仅 2 行速查 → 读者无法安装/启停/卸载插件，也不知道 `pluginsEnabled` 关闭时全部 403（`plugins.js:106-112`）。
2. **分享体系文档缺位（B 树）**：11 个端点 + 票据/密码/限速/清理语义全部缺失，而 MDX 是站点主入口。
3. **权限文档的 `downloadUrl` 反例**（`权限与角色.md:303-308`）：会让管理员以为“关掉文件操作后成员仍能往盘里抓文件”，实际已被 `config.js:260` 堵死。
4. **备份受管文件数 4/5/6 三套说法**：`backup.js:25` 是唯一真值（6）。
5. **`configuration.mdx:244` 字段计数（59/11）**：真值 39 顶层 / 67 叶子 / 15 布尔。
6. **`PATCH /api/groups/:id` 的权限归属**（`API参考.md:1039`）：可见范围归 `manageVisibility`，不归 `manageMembers`。
7. **`todoEnabled` 语义**（`API参考.md:884-886`）：完成/删除也受总开关约束。
8. **`/api/fs/file` 的隐含权限**（双树）：还需 `preview`/`downloadFile`。
9. **500 文案不可能送达**（`API参考.md:677`）：`index.js:220` 会统一改写。
10. **README / SECURITY-AUDIT 的“当前版本”**：仍是 v1.2.4，与 2.0.0-beta 冲突。
11. **`配置参考.md` 3.2 表格被引用块截断**：`shareEnabled`/`sharePublicAccess` 渲染成表格外文本。
12. **WebDAV 方法清单少 `PROPPATCH`**（双树）。

<!-- 审计方式说明：路由清单由 `Select-String -Pattern 'router\.(get|post|...)\('` + `server/index.js` 的 `app.use` 挂载点机械生成；每一条文档断言均回到代码定位；文档侧错误文案做了 86 条批量匹配、内部链接做了 300+ 条脚本校验。未运行服务、未修改源码。 -->
