# API 参考

ZeroShadow 的服务端是一套纯 JSON + 文件流的 HTTP 接口，前端只是它的一层客户端。
你可以用同一套接口写脚本、做自动化、接自己的客户端。

> 想直接对照源码看：路由在 `server/src/routes/`（`auth.js` / `fs.js` / `admin.js` / `avatars.js` /
> `todos.js` / `groups.js`，共 6 个文件），
> 中间件与静态托管在 `server/index.js`。

---

## 0. 通用约定

### 基地址与编码

```
http://<主机>:<端口>
```

默认端口 `12345`（`.env` 的 `PORT`）。请求与响应**均为 UTF-8**；
`Content-Type: application/json` 用于所有 JSON 接口。

### 认证

登录成功后服务端下发 Cookie：

```
Set-Cookie: zs_token=<JWT>; Max-Age=...; Path=/; HttpOnly; SameSite=Lax
```

之后所有请求浏览器会自动带上它。**没有 Bearer Token 方式**，只有这个 Cookie。
角色判定完全由服务端从 Cookie 推导，客户端无法自称身份。

未登录时一律是**访客**（`guest`）身份。

### 必须带的请求头（CSRF）

`/api` 下所有**非** `GET` / `HEAD` / `OPTIONS` 的请求都必须带：

```
X-Requested-With: XMLHttpRequest
```

否则返回 **403 `{"error":"请求校验失败"}`**。

此外，默认还会校验来源（可用后台开关 `csrfOriginCheck` 关闭）：

- 若带 `Sec-Fetch-Site`，值必须是 `same-origin` 或 `none`；
- 若带 `Origin`，其 host 必须与请求的 `Host` 一致。

用命令行工具（curl / PowerShell / 脚本）调写接口时，**别忘了这个头**。

### 错误响应

统一形态：

```json
{ "error": "人类可读的中文说明" }
```

| 状态码 | 含义 |
|:-------- |:--------------------------------------------------------------------- |
| 400 | 参数或路径非法（含路径穿越、体积超限、URL 不合法） |
| 401 | 访客尝试执行需要登录的操作 → `{"error":"请先登录"}` |
| 403 | 已登录但权限不足 → `{"error":"没有权限执行此操作"}`；CSRF 失败 → `请求校验失败` |
| 404 | 目标不存在；或访客访问了对其隐藏的路径（故意用 404 而不是 403） |
| 409 | 已存在同名文件或文件夹 |
| 413 | 请求体或文件体积超出限制（上传单文件、在线编辑内容、头像、在线阅读 8 MB 上限） |
| 415 | 在线编辑打开的文件被判定为二进制（见下文 `GET /api/fs/file`） |
| 429 | 被限流或账户被临时锁定（带 `Retry-After` 头时会给出建议等待秒数） |
| 500 | 服务器内部错误（详情只进服务端日志） |

> 单个请求里的意外异常**不会**拖垮整个服务：`server/index.js` 注册了进程级的
> `unhandledRejection` / `uncaughtException` 兜底，只把异常写进日志（事件名分别是
> `unhandled_rejection` / `uncaught_exception`）而**不退出进程**——本项目没有 Docker / pm2 之类的
> 进程管理，退出就等于局域网内所有人同时断线。

### 路径参数的写法

所有表示"网盘内路径"的参数（`path` / `paths` / `sources` / `dest`）都用**相对根目录的路径**：

- 用 `/` 分隔，**不要以 `/` 开头**；
- 根目录就是空字符串 `""`；
- 例如 `资料/2026/报告.pdf`。

服务端会做穿越校验（拒绝 `..`、NUL 字节、越界），非法路径返回 400。

### 权限点名称

下表"权限"一列使用的名称与 `data/config.json` 里的字段一致
（`memberPerms.*` / `guestPerms.*`），对应关系见 [权限与角色](权限与角色.md)。
标 `—` 表示该接口只有角色要求、没有单独的权限开关。

### 小组上下文（可选请求头）

团队成员（与超管）可以带一个请求头来切换**小组上下文**：

```
X-ZS-Group: <小组 id>
```

- 省略或传 `default` → 使用「默认」上下文；
- 服务端会校验该成员确实属于这个小组，**不合法时静默回退到「默认」**（不会报错）；
- 它同时决定本轮请求的**有效权限**（小组权限与全局成员权限取"与"）与**可见范围**
  （小组白名单 / 黑名单），所以 `/api/fs/*` 的结果会随之变化；
- 原生 `<img>` / `<video>` 这类无法自定义请求头的场景，可以用查询参数兜底：`?group=<小组 id>`
  （同样会校验归属）。

**小组权限收窄只对成员生效**：超管的这个请求头只影响"以哪个小组的身份看"，不会削减他的权限；
访客不参与小组机制。详见 [权限与角色 · 小组](权限与角色.md#3-小组权限收窄与可见范围)。

---

## 1. 基础接口

### `GET /ping`

健康检查，用于验证隧道 / 反代是否可达。

- 认证：无
- 响应：`text/plain`，内容固定为 `pong`

### `GET /api/meta`

- 认证：无
- 响应：

```json
{ "name": "ZeroShadow", "version": "1.1.0" }
```

> `version` 与根 `package.json` 保持一致。注意它是**写死**在代码里的，并没有从 `package.json` 读取：
> 改版本号时必须同时改三处——根 `package.json`、`server/index.js` 里的 `/api/meta`、
> 以及前端唯一的版本号来源 `web/src/version.ts`（导出 `VERSION`，供「软件开源信息」页与侧边栏共用）。

---

## 2. 认证与账户 `/api/auth`

### `POST /api/auth/login`

- 认证：无
- 请求体：

```json
{ "username": "admin", "password": "……" }
```

- 成功响应（同时 `Set-Cookie`）：

```json
{ "role": "superadmin", "username": "admin" }
```

`role` 为 `superadmin` 或 `member`。

- 错误：

| 状态 | error | 原因 |
|:-------- |:--------------------------------------- |:------------------------------- |
| 400 | 请输入用户名和密码 | 缺字段 |
| 400 | 用户名或密码格式不正确 | 用户名 >64 字符或密码 >256 字符 |
| 429 | 尝试次数过多，请约 N 分钟后再试 | 命中 IP 或账户锁定 |
| 401 | 用户名或密码错误 | 凭据不正确 |
| 403 | 该账户已被禁用 | 成员账号被禁用 |

### `POST /api/auth/change-password`

修改**成员**自己的密码。

- 认证：已登录（`superadmin` / `member`）
- 权限：`changePassword`
- 请求体：

```json
{ "oldPassword": "旧密码", "newPassword": "新密码" }
```

- 成功：清除 Cookie 并返回

```json
{ "ok": true, "message": "密码已修改，请重新登录" }
```

- 错误：`400 请输入旧密码和新密码`、`400 新密码长度需为 6-128 位`、
  `400 超级管理员密码请直接编辑 .env 中 SUPER_ADMIN_PASSWORD，改后重启服务生效`、
  `403 旧密码错误`、`404 用户不存在`

> 超管密码无法通过接口修改，必须改 `.env` 并重启。

### `POST /api/auth/logout`

- 认证：已登录
- 响应：`{ "ok": true }`，同时清除 Cookie

### `GET /api/auth/groups`

当前身份**可以切换**的小组清单（顶栏切换器的数据源）。

- 认证：无（未登录返回空数组）
- 响应：

```json
{ "groups": [ { "id": "uuid", "name": "设计组", "color": "#5b8def", "leaders": ["uuid"] } ] }
```

- 超管拿到**全部**小组；成员拿到自己所属的小组；访客是 `{ "groups": [] }`；
- 这里返回的是精简版（不含成员名单与可见范围），组长自助管理用的完整版在
  [`GET /api/groups`](#6-小组-apigroups)。

### `GET /api/auth/me`

获取当前身份与权限。前端每 30 秒轮询一次。

- 认证：无（未登录返回访客身份）
- 响应：

```json
{
  "role": "member",
  "username": "alice",
  "userId": "uuid",
  "perms": {
    "fileWrite": true, "browse": true, "upload": true, "uploadFolders": true,
    "downloadFile": true, "downloadFolder": true, "preview": true,
    "copy": true, "move": true, "rename": true, "delete": true, "mkdir": true,
    "manageGuestVisibility": true, "details": true, "htmlPreview": true,
    "editFiles": true, "compressZip": true, "extractZip": true,
    "downloadUrl": true, "changePassword": true
  },
  "uploadLimitMB": 512,
  "groupId": "default",
  "group": null
}
```

- `perms` 是**当前分组上下文下的有效权限**（已把小组收窄算进去），不是全局配置的原始值；
- `groupId` 是本次请求生效的小组 id（`default` 表示默认上下文），`group` 是对应的小组精简对象
  （`id` / `name` / `color` / `leaders`）或 `null`；
- 访问者未登录时 `role` 为 `guest`、`username` 为 `null`、`userId` 为 `null`、`uploadLimitMB` 为 `0`。

---

## 3. 文件操作 `/api/fs`

### `GET /api/fs/list`

列出目录内容。

- 权限：`browse`
- 查询参数：`path`（默认根目录）
- 响应：

```json
{
  "path": "资料",
  "entries": [
    { "name": "报告.pdf", "type": "file", "size": 102400, "mtime": 1767225600000, "hiddenFromGuest": false },
    { "name": "2026", "type": "dir", "size": 0, "mtime": 1767225600000, "hiddenFromGuest": false },
    { "name": "素材盘", "type": "dir", "size": 0, "mtime": 0, "softReadOnly": true, "hiddenFromGuest": false },
    { "name": "官网.zeropath", "type": "shortcut", "size": 128, "mtime": 1767225600000,
      "shortcut": { "targetType": "path", "targetUrl": "网站", "logo": "globe", "displayName": "官网" } }
  ]
}
```

字段说明：

| 字段 | 说明 |
|:-------------------- |:--------------------------------------- |
| `type` | `dir` / `file` / `shortcut` |
| `hiddenFromGuest` | **只有非访客才会看到**该字段 |
| `softReadOnly` | 只读映射目录（`FILES_SOFT_DIR`）的条目 |
| `shortcut.targetType` | `file` / `path` / `soft_file` / `soft_path` |

- 只有**根目录**的响应会带上映射目录条目，且排在真实目录之前；
- 访客请求时，对其隐藏的条目会被**直接过滤掉**；访问被隐藏的目录返回 404。

### `GET /api/fs/download`

下载或内联预览单个文件。

- 权限：`downloadFile`；**若只有 `preview`**，则仅当扩展名属于可内联类型时被强制以内联方式返回
- 查询参数：

| 参数 | 说明 |
|:-------- |:--------------------------------------------------------------- |
| `path` | 文件路径（**不能为空**，为空返回 400 非法路径） |
| `inline` | 传 `1` 且扩展名可内联时，以 `Content-Disposition: inline` 返回 |

- 判定用的是**当前小组上下文下的有效权限**（`req.perms`），因此小组关掉 `downloadFile` / `preview`
  后，即使全局是开的，这里也会按"没权限"处理；
- 访客隐藏检查对**只读映射目录（`FILES_SOFT_DIR`）同样生效**：被隐藏的映射目录里的文件，
  访客即使猜到完整路径也只能拿到 `404 文件不存在`；
- 响应：文件流。响应头包含 `Content-Type`、`Content-Disposition`（同时给 `filename` 与 UTF-8 的 `filename*`）、`Cache-Control: no-store`；
  内联返回 `.html` / `.htm` / `.svg` 时会额外带上 `Content-Security-Policy: sandbox allow-scripts`。
- 错误：`400 只能下载文件，文件夹请使用打包下载`、`403 没有权限下载文件`、`404 文件不存在`

> 单文件下载**不记录** `download` 日志（只有真正下载才记），也**不受限流**。

### `GET /api/fs/zip`

打包下载（流式 ZIP，边打边发）。

- 权限：`downloadFolder`　限流：是
- 查询参数（二选一）：

| 参数 | 说明 |
|:-------- |:----------------------------------------------------------- |
| `path` | 单个路径（文件或目录） |
| `paths` | JSON 数组字符串，最多 **200** 项，例如 `["a","b/c"]` |

- 响应：`application/zip` 流，文件名规则：
  - 单项目：`<名字>.zip`
  - 多项目：`ZeroShadow-<YYYY-MM-DD>.zip`
- 行为细节：跳过符号链接；空目录会补一个 `.keep`；
  重名条目用路径（`/`→`_`）区分，仍重名则加 `_2`、`_3`…
- **可见性过滤是递归的**：访客的「对访客隐藏」目录、以及当前小组 / 默认上下文的白名单外与黑名单内的
  目录，都会连同其中的**所有子目录与文件**一起被排除，不会"列表里看不到、打包却能拿到"；
- 归档统计（用于体积与条目数上限）**只计文件**，不把目录算成条目，因此进度与上限判断和实际文件数一致；
- 错误：`400 参数格式错误`、`400` 体积/条目数超限的具体说明、`404 没有可下载的内容`

### `POST /api/fs/mkdir`

- 权限：`mkdir`
- 请求体：`{ "path": "资料", "name": "2026" }`
- 响应：`{ "name": "2026" }`（若同名已存在，返回的名字会自动变成 `2026 (1)`）
- 错误：名称校验失败的说明、`404 目录不存在`、`403 外部映射目录仅支持只读操作`

### `POST /api/fs/upload`

- 权限：`upload`
- 查询参数：

| 参数 | 说明 |
|:-------- |:------------------------------------------------------------------------------- |
| `path` | 目标目录 |
| `overwrite` | JSON 数组字符串，列出要**覆盖**的路径，例如 `["a.txt","素材/logo.png"]`。**每一项既可以是文件 basename，也可以是相对目标目录的路径**；不在列表里的同名文件会自动改名 |

- 请求体：`multipart/form-data`，文件字段名 **`files`**（可重复）。
  文件名里带 `/`（浏览器上传文件夹时会这样）时，**整个相对路径会被保留**：服务端按它还原子目录结构
  （busboy 开了 `preservePath`），所以文件夹上传不会再被压平成一层。
- 限制：单个文件 ≤ `uploadLimitMB(role)`；单次请求 ≤ **100** 个文件、≤ 10 个非文件字段
- 目录是**按需创建**的：只有真正落盘的文件才会建出它的父目录，上传中断不会留下一片空目录树；
  临时文件写入失败（例如磁盘写满）只让**这一个文件**失败（`ok: false` + 原因），
  **不会**让服务进程崩溃。

> **注意**：服务端只校验 `upload`，「上传文件夹」对应的 `uploadFolders` 开关**目前只在前端生效**
> （界面会把按钮置灰），裸调接口时不受它限制。若需要严格限制"能不能传文件夹"，请直接关闭 `upload`。

- 响应：

```json
{
  "results": [
    { "name": "a.txt", "ok": true, "savedAs": "a.txt" },
    { "name": "assets/logo.png", "ok": true, "savedAs": "assets/logo.png" },
    { "name": "b.txt", "ok": false, "error": "超出大小限制 (512MB)" }
  ],
  "limitMB": 512,
  "truncated": false,
  "maxFilesPerRequest": 100
}
```

| 字段 | 说明 |
|:------------------------ |:----------------------------------------------------------------------- |
| `results[].name` | 提交时的名字；文件夹上传时是**相对路径**（如 `assets/logo.png`） |
| `results[].savedAs` | 实际落盘的相对路径（被自动改名时与 `name` 不同） |
| `results[].error` | 失败原因，常见的有 `超出大小限制 (NMB)`、`服务器磁盘空间不足`、`写入失败`、`保存失败` |
| `truncated` | `true` 表示本次请求命中了 100 个文件的解析上限，**超出部分被丢弃** |
| `maxFilesPerRequest` | 服务端当前的单请求文件数上限，固定 `100` |

- 状态码：只要**全部**失败且原因是超限时返回 **413**，否则 200。
- 网页端会按 `maxFilesPerRequest` **自动分批**（每批 100 个），所以一次选几百个文件也能传完；
  自己写脚本调用时请自行分批，并在看到 `truncated: true` 时补传剩余文件。

### `POST /api/fs/rename`

- 权限：`rename`
- 请求体：`{ "path": "旧名.txt", "newName": "新名.txt", "overwrite": false, "merge": false }`
  （`overwrite` / `merge` 仅在目标已存在时才有意义，`merge` 要求双方都是目录）
- 响应：`{ "name": "新名.txt" }`
- 错误：`400 非法路径` / 名称校验说明、`404 文件或目录不存在`、`409 已存在同名文件或文件夹`
- 副作用：若被重命名的路径命中"对访客隐藏"的记录，**整棵子树**的记录会一起改写到新位置
  （重命名父目录后，被隐藏的子目录不会因此对访客现身）。

### `POST /api/fs/delete`

- 权限：`delete`
- 请求体：`{ "paths": ["a.txt", "目录/b"] }`，最多 **500** 项
- 响应：`{ "deleted": 2 }`
- 错误：`400 参数格式错误`、`400 不能删除根目录`
- 副作用：清理与被删路径相关的访客隐藏记录。

### `POST /api/fs/copy` / `POST /api/fs/move`

两个接口共用同一套参数与逻辑，只是模式不同。

- 权限：`copy` / `move`
- 请求体：

```json
{
  "sources": ["a.txt", "目录"],
  "dest": "归档",
  "overwrite": false,
  "merge": false,
  "targetNames": { "a.txt": "a (1).txt" }
}
```

| 字段 | 说明 |
|:-------------- |:------------------------------------------------------------------------------- |
| `sources` | 源路径数组，最多 **500** 项 |
| `dest` | 目标目录 |
| `overwrite` | 目标已存在同名项时是否直接覆盖 |
| `merge` | 双方都是目录时逐层合并（同名文件以源为准） |
| `targetNames` | **可选**。对象，键是**源的相对路径**，值是**期望的新文件名**；缺省或传空串表示沿用原名。里面写的名字会走一遍和重命名一样的校验（非法名返回 400） |

- 响应：`{ "done": 2 }`
- 规则：
  - `sources` 最多 **500** 项；
  - 不能把目录复制/移动进它自己内部 → `400 不能将文件夹移动/复制到其自身内部`；
  - `merge` 仅当源与目标都是目录时生效，逐层合并，**同名文件以源为准**；
  - `move` 时如果源已经在目标目录里（父目录相同）且没有要求改名，视为已完成，不报错；
  - **`move` 的来源在只读映射目录里 → 403**；
  - **`copy` 的来源在只读映射目录里、且 `softDirAllowCopyOut` 为假 → 403**
    （`只读映射目录的内容不允许复制到网盘目录（可在后台设置中放开）`）；
  - 目标本身在映射目录里 → 403 只读。
- 副作用：`move` 时若源路径命中访客隐藏记录，**整棵子树**的记录会改写到新位置。
- `targetNames` 是"同名冲突处理"里选「重命名」时网页用的机制（把**原始来源**与**期望的新名字**分开传），
  不要把它当成"先把来源改名再传"——那样服务端会找不到来源并返回 404。

### `GET /api/fs/stat`

查看文件 / 目录详情。

- 权限：`details`（成员固定开启，访客关闭）　限流：是
- 查询参数：`path`
- 响应：

```json
{
  "name": "2026", "path": "资料/2026", "type": "dir",
  "size": 10485760, "mtime": 1767225600000, "created": 1767225600000,
  "hiddenFromGuest": false,
  "files": 12, "dirs": 3, "partial": false
}
```

- 目录会额外带 `files` / `dirs` / `partial`（`partial: true` 表示条目太多没统计完，上限约 20 万个）；
- `path` 为空时返回根目录信息，`name` 为 `根目录`。

### `GET /api/fs/search`

按文件名递归搜索。

- 权限：`browse`　限流：是
- 查询参数：`q`（**必填，≤100 字符**）、`path`（搜索起点，默认根目录）
- 响应：

```json
{
  "results": [
    { "name": "报告.pdf", "type": "file", "size": 102400, "mtime": 1767225600000,
      "path": "资料/2026/报告.pdf", "parent": "资料/2026" }
  ]
}
```

- 限制：最多返回 **200** 条；最多访问 **30000** 个条目；最长约 **6 秒**；
- 匹配规则：文件名**包含**关键词（不区分大小写）；
- 命中映射目录的结果会带 `softReadOnly: true`；访客结果里被隐藏的内容会被过滤。
- 错误：`400 请输入搜索关键词`（`q` 为空或超过 100 字符）

### `POST /api/fs/guest-visibility`

- 认证：`superadmin` 或 `member`
- 权限：`manageGuestVisibility`
- 请求体：`{ "path": "内部资料", "hidden": true }`
- 响应：`{ "path": "内部资料", "hidden": true }`
- 校验：目标路径必须**位于调用者当前上下文可见的范围之内**（小组 / 默认可见范围之外返回 404），
  否则会出现"给一个自己都看不到的目录打隐藏标记"的越权写入。
- 错误：`400 不能隐藏根目录`、`400 只能对文件夹设置访客可见性`、`404 文件或目录不存在`

### `POST /api/fs/compress`

启动在线压缩任务，**立即返回**任务 id。

- 权限：`compressZip`　限流：是
- 请求体：`{ "paths": ["目录", "a.txt"], "dest": "归档" }`
  （`paths` ≤ **200** 项；`dest` 省略时用第一个路径所在的目录）
- 响应：`{ "jobId": "1f2e3d..." }`
- 限制与 `/api/fs/zip` 相同（条目数 / 单文件 / 总量）；
  只读映射目录的**内容**同样受 `softDirAllowCopyOut` 限制，目标目录也不能是映射目录。
- **可见性过滤同样是递归的**（访客隐藏 + 小组 / 默认可见范围），
  隐藏目录里的文件不会被压进 zip；归档统计只计文件数，进度百分比与实际文件数一致。
- **失败会如实报告**：任何写入 / 压缩错误都会把任务置为 `state: "error"`（并带上原因），
  同时**删除已经写出的半个 `.zip`**，不会在目标目录里留下一个打不开的压缩包。

### `GET /api/fs/compress/status`

- 权限：`compressZip`
- 查询参数：`job`
- 响应（任务状态对象，见 [§8](#8-任务状态对象)）；
  任务不存在或不属于调用者时返回 `{ "id": "...", "state": "gone" }`。

### `POST /api/fs/extract`

启动解压任务，**立即返回**任务 id。

- 权限：`extractZip`　限流：是
- 请求体：`{ "path": "包.zip", "dest": "目标目录" }`（`dest` 省略时解压到 zip 所在目录）
- 响应：`{ "jobId": "..." }`
- 规则：只接受 `.zip`；解压到**以压缩包名命名的新文件夹**里（重名自动加 `(1)`）；
- 错误与上限：见 [安全设计 · 资源上限](安全设计.md)：
  - `400 非法路径`、`400 只能解压 zip 文件`、`400 目录不存在`
  - `400 ZIP 文件超出解压大小限制 (NMB)`
  - `400 ZIP 内文件数超出限制 (最多 N 个)`
  - `400 ZIP 解压后总大小 (NMB) 超出限制 (NMB)`
  - `500 服务端未安装 unzipper 模块，请联系管理员`
- 中途失败（含超限）会**删除已写出的半成品目录**，任务状态置为 `error`。

### `GET /api/fs/extract/status`

同上，查询解压任务状态。

### `GET /api/fs/file`

按识别出的编码把文本读出来，供在线编辑器打开文件。**这是在线编辑的读取侧**，
与 [`POST /api/fs/save-file`](#post-apifssave-file) 成对使用。

- 权限：`browse`
- 查询参数：

| 参数 | 必填 | 说明 |
|:-------- |:--- |:--------------------------------------- |
| `path` | 是 | 文件相对路径 |
| `encoding` | 否 | 强制用某个编码解码；**省略 = 自动识别**。取值必须是下面编码表里的 id |

- 成功响应（`application/json`）：

```json
{
  "path": "notes/gbk.txt",
  "name": "gbk.txt",
  "size": 42,
  "mtime": 1737000000000,
  "encoding": "gb18030",
  "encodingConfident": true,
  "eol": "crlf",
  "content": "第一行\n第二行\n",
  "softReadOnly": false,
  "encodings": [{ "id": "utf8", "label": "UTF-8", "bom": "none" }]
}
```

| 字段 | 说明 |
|:---------------------- |:--------------------------------------- |
| `encoding` | 实际用于解码的编码 id |
| `encodingConfident` | `false` 表示编码是**猜的**，前端应提示用户「如果乱码请手动切换编码」 |
| `eol` | 原始换行风格：`crlf` / `lf` / `cr`（内容里一律是 `\n`，见下） |
| `content` | 解码后的正文，**换行已统一成 `\n`**；BOM 已剥掉 |
| `softReadOnly` | `true` = 位于只读映射目录，编辑器只读 |
| `encodings` | 可选的编码列表（id / label / bom），供前端下拉框使用 |

- 支持的编码 id：`utf8`、`utf8bom`、`utf16le`、`utf16be`、`gb18030`（GBK / 简体中文）、
  `big5`（繁体中文）、`shift_jis`（日文）、`euc-kr`（韩文）、`windows-1252`、`iso-8859-1`。
- 识别顺序：**BOM → 无 BOM 的 UTF-16 → 严格 UTF-8 → 按常用字频率逐个候选编码打分**。
  打分是为了解决"GB18030 几乎能解码任意字节"的问题——用错编码解出来的是一片生僻字，
  用对编码才有大量高频字，因此 Big5 不会被误判成 GB18030、Shift_JIS 也不会被误判成 UTF-16。
- 错误：

| 状态 | 原因 |
|:-------- |:----------------------------------------------------------- |
| 400 | 非法路径 |
| 404 | 文件不存在（或者不是普通文件） |
| 413 | 文件大于 **8 MB**（`EDITOR_MAX_BYTES`），提示 `文件过大（NMB），在线编辑上限 8MB` |
| 415 | 判定为二进制文件（含 NUL 字节，或控制字符比例 > 10%），提示 `这看起来是二进制文件，不能当文本编辑` |

> UTF-16 文件天然含 NUL 字节，因此**带 BOM 或识别为 UTF-16 的内容不受 NUL 检查影响**，
> 不会被 415 误拦。

### `POST /api/fs/save-file`

把文本内容写回文件（在线编辑保存）。

- 权限：`editFiles`
- 请求体：

```json
{ "path": "notes.md", "content": "……", "encoding": "utf8", "eol": "lf" }
```

| 字段 | 默认 | 说明 |
|:---------- |:------- |:--------------------------------------- |
| `path` | — | 目标文件相对路径 |
| `content` | `""` | 正文；换行按 `\n` 提交 |
| `encoding` | `utf8` | 写回用的编码，取值必须是上面列出的编码 id |
| `eol` | `lf` | 写回时的换行风格：`crlf` / `lf` / `cr`（非法值退回 `lf`） |

- 响应：`{ "ok": true, "bytes": 1234, "encoding": "utf8", "eol": "lf" }`
- 说明：
  - 编码为 `utf8bom` / `utf16le` / `utf16be` 时**会写入对应的 BOM**（UTF-16 没有 BOM 就无法区分字节序）；
  - **目标编码表示不了的字符会被拒绝，而不是静默写成 `?`**：返回 **400**，
    提示 `这些字符无法用 <编码名> 表示：<字符…>。请改用 UTF-8 保存。`
    （最多列出 12 个字符）；例如把含简体字的文本存成 Big5、或把汉字存成 ISO-8859-1 都会命中这一条；
  - 不支持的编码 id 直接返回 **400** `不支持的编码：xxx`；
  - 不能写入只读映射目录（403）。
- **请求体上限 16 MB（仅这个接口）**，其余 JSON 接口仍是 1 MB：
  超限时返回 **413** 和中文提示
  `内容过大（NMB），在线编辑上限 16MB`。
  16 MB 这个常量定义在 `server/src/routes/fs.js`，导出为 `SAVE_FILE_MAX_BYTES`，
  并被 `server/index.js` 用来给这个路径单独挂一个更大的 `express.json`。
- **写入是原子的**：先写同目录下的临时文件再 `rename` 覆盖目标，
  因此保存过程中断电 / 进程被杀不会把原文件截断成半个（Windows 上若 rename 覆盖失败，
  会退化为"先删目标再改名"重试一次）。
- 编解码与探测的实现在 `server/src/encoding.js`，依赖 `iconv-lite`。
- 这也是创建 `.zeropath` 快捷方式的底层接口。

### `POST /api/fs/download-url`

让服务端把一个远程直链抓到网盘里。

- 权限：`downloadUrl`　限流：是
- 请求体：

```json
{ "url": "https://example.com/file.zip", "dest": "下载", "filename": "自定义名.zip" }
```

- 响应：`{ "jobId": "..." }`（真正下载在后台进行）
- 校验（在创建任务**之前**完成，不合格直接 400）：

| 情况 | 提示 |
|:------------------------------- |:--------------------------------------- |
| 空 | 请输入下载链接 |
| 超过 2048 字符 | 下载链接过长 |
| 非法 URL | URL 格式无效 |
| 非 http/https | 仅支持 http/https 链接 |
| URL 内含用户名密码 | 下载链接不能包含用户名或密码 |
| 缺主机名 | URL 缺少主机名 |
| 域名解析失败 | 无法解析该域名 |
| 目标是内网/回环/链路本地/保留地址 | 不允许下载<原因>（<地址>） |

- 其它限制：最多 **5** 跳重定向（每跳都重新校验）、连接超时 **60** 秒、
  体积上限 `downloadUrlMaxMB`（默认 4096MB，`0` 表示不限制）、
  实际字节不足 `Content-Length` 的 95% 判定为失败并删除残缺文件；
  文件名会自动清洗非法字符并处理重名。

### `GET /api/fs/download-url/status`

同上，查询链接下载任务状态。

---

## 4. 头像 `/api/avatars`

> 整个路由都要求已登录（`superadmin` / `member`），**访客一律 401**。
> 头像统一是 **128×128 的 WebP**，存在 `data/avatars/<owner>.webp`。
> `owner` 的取值规则：成员是 `u-<userId>`，超级管理员固定为 `_superadmin`
> （超管不在 `users.json` 里，所以没有用户 id）。

### `GET /api/avatars`

- 响应：

```json
{
  "avatars": [ { "owner": "u-3f1c…", "md5": "9a1…", "size": 4213, "updatedAt": 1767225600000 } ],
  "enabled": true
}
```

- `enabled` 就是配置里的 `avatarEnabled`；
- 只返回 `md5`（不返回图片内容），前端据此决定要不要重新下载。

### `GET /api/avatars/:owner`

- 响应：`image/webp` 文件流，带 `ETag: "<md5>"` 与 `Cache-Control: no-cache`；
  请求带 `If-None-Match: "<md5>"` 且命中时返回 **304**（不重复传输）；
- 错误：`400 头像标识无效`、`404 头像不存在`。

### `POST /api/avatars/me`

上传**自己**的头像。

- 请求体：图片的**原始字节**（不是 multipart），`Content-Type: image/webp` 或
  `application/octet-stream`；请求体解析上限 **2 MB**（超过由解析层返回 413）；
- 服务端会再校验三道：体积 ≤ `avatarMaxKB`（默认 200KB，超出返回 **413**「头像体积超出限制（最大 NKB）」）、
  必须是 WebP（`400 仅支持 WebP 格式头像`）、尺寸必须是 128×128
  （`400 头像尺寸必须为 128×128（当前 W×H）`）；
- 关闭头像功能时返回 `403 头像功能已关闭`；
- 响应：`{ "owner": "u-3f1c…", "md5": "9a1…", "size": 4213 }`。

### `POST /api/avatars/:owner`

给**指定账户**上传头像（请求体与校验规则同上）。权限：

| 调用者 | 允许的 owner |
|:-------------- |:--------------------------------------- |
| 超级管理员 | 任意合法 owner |
| 成员 | 只能是自己（`u-<自己的 id>`） |
| 组长 | 自己，或**本组成员**——前提是所在小组由超管开启了「修改本组成员头像」（`editMemberAvatar`） |

- 不满足时返回 `403 没有权限修改该头像`；`owner` 不合法返回 `400 头像标识无效`。

### `DELETE /api/avatars/:owner`

删除某个头像（权限判断与上一条相同），响应 `{ "ok": true }`。

---

## 5. 团队待办 `/api/todos`

> 整个路由都要求已登录（`superadmin` / `member`），**访客一律 401**；
> 另外受 `todoEnabled` 总开关约束：关闭时列表直接返回空数组 + `enabled: false`，
> 新建（`POST /api/todos`）与编辑（`PATCH`）返回 `403 Todo 功能已关闭`
> （标记完成与删除不查这个开关，仍按各自的权限执行）。
> 数据存在 `data/todos.json`，**上限 5000 条**。

### 待办对象

```json
{
  "id": "uuid",
  "title": "整理 Q3 素材",
  "note": "只处理原始素材",
  "priority": "high",
  "dueAt": "2026-08-01",
  "scope": "group",
  "groupId": "uuid",
  "memberId": "",
  "done": false,
  "doneAt": null,
  "doneBy": null,
  "allowAssigneeEdit": false,
  "createdBy": "alice",
  "createdById": "uuid",
  "createdByRole": "member",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "groupName": "设计组",
  "memberName": "",
  "canEdit": true,
  "canComplete": true,
  "canManage": true
}
```

| 字段 | 说明 |
|:-------------------- |:--------------------------------------------------------------- |
| `priority` | `high` / `normal` / `low` |
| `scope` | `all`（全体）/ `group`（指定小组）/ `member`（指定成员） |
| `groupId` / `memberId` | 只在对应 scope 下才有值，否则是空串 |
| `allowAssigneeEdit` | 是否允许范围内的人修改内容 |
| `groupName` / `memberName` | 服务端补上的可读名字 |
| `canEdit` / `canComplete` / `canManage` | 当前调用者对这条待办的三种能力（前端据此显示按钮） |

### 可见与可管理的规则

| 关系 | 能看到 | 能改内容 | 能标记完成 | 能改范围 / 删除 |
|:------------------ |:---:|:---:|:---:|:---:|
| 超级管理员 | ✅ | ✅ | ✅ | ✅ |
| 创建者 | ✅ | ✅ | ✅ | ✅ |
| 相关小组的组长（该组开启 `manageTodo`） | ✅ | ✅ | ✅ | ✅ |
| 范围内的人（`all` / 本组成员 / 被指派人） | ✅ | 仅当 `allowAssigneeEdit` 为真 | ✅ | ❌ |

### `GET /api/todos`

- 查询参数：

| 参数 | 默认 | 说明 |
|:-------- |:-------- |:--------------------------------------- |
| `status` | `all` | `open`（未完成）/ `done`（已完成）/ `all` |
| `scope` | `all` | `all` / `group` / `member` |
| `q` | 空 | 在**标题与备注**里做不区分大小写的包含匹配 |

- 响应：

```json
{
  "todos": [ /* 待办对象数组 */ ],
  "enabled": true,
  "canCreateAll": false,
  "leaderGroups": [ { "id": "uuid", "name": "设计组" } ],
  "members": [ { "id": "uuid", "username": "alice" } ]
}
```

- 排序：**未完成的在前**；都未完成时，有截止日期的在前（早的优先），其余按优先级
  `high` → `normal` → `low`；
- 关闭 `todoEnabled` 时，响应只有 `{ "todos": [], "enabled": false }`（不含下面几个字段）；
- `canCreateAll` 表示调用者能否下发"全体"待办（只有超管为 `true`）；
- `leaderGroups` 是调用者**作为组长且开启 `manageTodo`** 的小组（用于「下发范围」下拉），
  `members` 是所有成员的 `id` / `username`。

### `POST /api/todos`

- 请求体：

```json
{ "title": "整理 Q3 素材", "note": "…", "priority": "high", "dueAt": "2026-08-01",
  "allowAssigneeEdit": false, "scope": "group", "groupId": "uuid" }
```

- 响应：`{ "todo": { …待办对象… } }`
- 校验与错误：

| 状态 | error | 原因 |
|:-------- |:--------------------------------------- |:--------------------------------------- |
| 400 | 标题不能为空且不超过 200 字 | `title` 缺失或超长 |
| 400 | 作用域无效 | `scope` 不是 `all` / `group` / `member` |
| 400 | 小组不存在 / 成员不存在 | `groupId` / `memberId` 查不到 |
| 400 | Todo 数量已达上限 5000 | 条数上限 |
| 403 | 只有超级管理员可以创建全体 Todo | 成员试图下发 `scope: "all"` |
| 403 | 没有权限向该小组下发 Todo | 不是该组组长（或未开启 `manageTodo`） |
| 403 | 没有权限向该成员下发 Todo | 该成员不在自己管理的任何小组里 |
| 403 | Todo 功能已关闭 | `todoEnabled = false` |

### `PATCH /api/todos/:id`

- 请求体中的任意子集：`title`、`note`、`priority`、`dueAt`、`allowAssigneeEdit`、`scope` / `groupId` / `memberId`；
- **内容字段**（`title` / `note` / `priority` / `dueAt`）需要 `canEdit`；
  **`allowAssigneeEdit` 与作用域变更**需要 `canManage`（传了却没权限时会被忽略，不报错）；
- 作用域变更会重新走一遍下发权限校验（错误同 `POST`）；
- 响应：`{ "todo": { …待办对象… } }`
- 错误：`404 Todo 不存在`、`403 Todo 功能已关闭`（`todoEnabled = false`）、
  `403 没有权限编辑该 Todo`、`400 没有可更新的字段`、`400 标题不能为空且不超过 200 字`

### `POST /api/todos/:id/done`

- 请求体：`{ "done": true }`；**省略 `done` 时表示"取反"**（在完成 / 未完成之间切换）；
- 响应：`{ "todo": { … } }`（完成时会记下 `doneBy` 与 `doneAt`）；
- 错误：`404 Todo 不存在`、`403 没有权限完成该 Todo`

### `DELETE /api/todos/:id`

- 只有 `canManage` 的人能删；响应 `{ "ok": true }`；
- 错误：`404 Todo 不存在`、`403 没有权限删除该 Todo`
- 副作用：删除小组成员时，指派给他的待办会转为「全体」；删除小组时，该组的待办会转为「全体」。

---

## 6. 小组 `/api/groups`

这是**组长自助管理**用的接口，受超管为该组勾选的组长能力（`leaderCaps`）约束。
超管的完整管理接口在 [`GET /api/admin/groups`](#get-apiadmingroups)（能改名称、颜色、权限收窄、可见范围与组长能力）。

> 认证：`superadmin` 或 `member`（访客 401）。小组配置存在 `data/groups.json`。

### 小组对象

```json
{
  "id": "uuid",
  "name": "设计组",
  "color": "#5b8def",
  "leaderCaps": { "viewMembers": true, "manageTodo": true, "editMemberAvatar": false, "manageMembers": false },
  "isLeader": true,
  "canViewMembers": true,
  "canManageMembers": false,
  "canManageTodo": true,
  "whitelist": ["项目A"],
  "blacklist": ["机密"],
  "memberCount": 4,
  "members": [ { "id": "uuid", "username": "alice", "disabled": false, "createdAt": "…" } ]
}
```

- `members` **只有在 `canViewMembers` 为真时才是完整列表**，否则是空数组；
- `canManageMembers` 决定能否增删成员与改可见范围；`canManageTodo` 决定能否向该组下发待办。

### `GET /api/groups`

- 响应：`{ "groups": [ 小组对象 ], "allMembers": [ 成员对象 ] }`
- 返回的是**调用者可管理的小组**：超管拿到全部；成员只拿到"自己当组长、且至少开启了一项
  `viewMembers` / `manageMembers` / `manageTodo` 能力"的小组。

### `GET /api/groups/:id/members`

- 需要超管，或是该组组长且开启 `viewMembers`；
- 响应：`{ "members": [ { "id", "username", "disabled", "createdAt" } ] }`
- 错误：`404 小组不存在`、`403 没有权限`、`403 组长未获授权查看成员`

### `POST /api/groups/:id/members`

- 请求体：`{ "ids": ["uuid1", "uuid2"], "action": "add" | "remove" }`（`action` 省略即 `add`）；
- 需要超管，或是该组组长且开启 `manageMembers`；
- 响应：`{ "group": { 小组对象 } }`（移除某人会自动卸任其组长身份）；
- 错误：`404 小组不存在`、`403 没有权限管理该小组成员`、`400 包含不存在的成员`

### `PATCH /api/groups/:id`

- 请求体：`{ "whitelist": ["项目A"], "blacklist": ["机密"] }`（至少给一个）；
- **组长只能改这两项**；组名、颜色、权限收窄与 `leaderCaps` 始终归超管
  （要改那些请用 [`PATCH /api/admin/groups/:id`](#patch-apiadmingroupsid)）；
- 响应：`{ "group": { 小组对象 } }`
- 错误：`404 小组不存在`、`403 没有权限调整该小组可见范围`、`400 没有可更新的字段`

---

## 7. 管理接口 `/api/admin`

> **整个 `/api/admin` 路由都套了 `requireRole("superadmin")`**，
> 成员的请求一律 403，未登录一律 401。

### `GET /api/admin/config`

返回完整的配置对象（结构见 [配置参考](配置参考.md#三dataconfigjson-全部字段)）。

### `PATCH /api/admin/config`

局部更新配置，返回更新后的完整配置。

- 请求体示例：

```json
{
  "memberUploadLimitMB": 1024,
  "rateLimitPerMin": 200,
  "rateLimitEnabled": true,
  "guestPerms": { "browse": true, "downloadFile": true, "downloadFolder": false, "preview": true }
}
```

- 可更新字段：
  - 数值（必须是该字段允许区间内的**整数**，否则 400）：`superUploadLimitMB`、`memberUploadLimitMB`、
    `zipMaxFiles`（1–100000）、`zipMaxSingleMB`、`zipMaxTotalMB`、`extractMaxZipMB`、`extractMaxTotalMB`、
    `downloadUrlMaxMB`、`rateLimitPerMin`（1–100000）、`avatarMaxKB`（1–10240）、`backupKeep`（1–500）、
    `logRetentionDays`（1–3650）、`metricsRetentionDays`（1–365）、`metricsMemMinutes`（1–1440）、
    `slowRequestMs`（1–600000）；未标注的默认区间是 1–1048576
  - 布尔：`rateLimitEnabled`、`softDirAllowCopyOut`、`jobStatusOwnerOnly`、`downloadUrlAllowPrivate`、
    `csrfOriginCheck`、`avatarEnabled`、`todoEnabled`、`backupEnabled`、`requestMetricsEnabled`
  - 对象：`memberPerms`、`guestPerms`（只覆盖传入的键，值统一按布尔处理）
  - 对象：`defaultVisibility`——传 `{ "whitelist": [...], "blacklist": [...] }` 整体替换
    （数组会按可见性规则清洗：去首尾 `/`、`\`→`/`、丢弃空串 / `.` / `..` / 含 `..` 的段，最多 200 条）
- 未在此白名单里的字段（例如 `guestHiddenPaths`、`tunnel`）**无法通过这个接口改**，会被忽略。
- 错误：`400 <字段名> 需为 <最小值>-<最大值> 之间的整数`、`400 defaultVisibility 参数格式错误`、
  `400 参数格式错误`

### `DELETE /api/admin/hidden-paths`

把某个路径从"对访客隐藏"列表里移除。

- 请求体：`{ "path": "内部资料" }`
- 响应：更新后的完整配置

> 注意：这是 `DELETE` 方法但**带 JSON 请求体**，调用时同样要带 `X-Requested-With` 头。

### `GET /api/admin/members`

- 响应：

```json
{ "members": [ { "id": "uuid", "username": "alice", "disabled": false, "createdAt": "2026-01-01T00:00:00.000Z" } ] }
```

### `POST /api/admin/members`

批量创建成员。

- 请求体：`{ "users": [ { "username": "alice", "password": "123456" }, { "username": "bob", "password": "x" } ] }`
  （数组长度 1–**200**，否则 `400 参数格式错误（单次最多 200 个）`）
- 响应：

```json
{ "results": [ { "username": "alice", "ok": true }, { "username": "bob", "ok": false, "error": "密码长度需为 6-128 位" } ] }
```

- 单个失败的常见原因：`用户名需为 2-32 位字母、数字、_ . -`、`该用户名已被超级管理员占用`、
  `用户名已存在`、`本次提交中用户名重复`、`密码长度需为 6-128 位`、`成员数量已达上限 500`

### `POST /api/admin/members/batch`

批量启用 / 禁用 / 删除。

- 请求体：`{ "action": "enable" | "disable" | "delete", "ids": ["uuid1", "uuid2"] }`
- 响应：`{ "count": 2 }`
- 说明：禁用会同时让该成员的旧会话失效（`tokenVersion + 1`）；
  **删除**还会把该成员从所有小组移除、其创建或被指派的待办做相应清理、并删掉其头像。
- 错误：`400 参数格式错误`

### `POST /api/admin/members/:id/password`

重置某个成员的密码。

- 请求体：`{ "password": "新密码" }`
- 响应：`{ "ok": true }`
- 副作用：该成员所有旧会话立刻失效。
- 错误：`400 密码长度需为 6-128 位`、`400 用户不存在`

### `PATCH /api/admin/members/:id`

修改成员用户名。

- 请求体：`{ "username": "新用户名" }`
- 响应：`{ "ok": true }`
- 错误：`400 用户名需为 2-32 位字母、数字、_ . -`、`400 该用户名已被超级管理员占用`、
  `400 用户名已存在`、`404 用户不存在`

### `GET /api/admin/groups`

超管的完整小组数据（「设置 → 小组」页的数据源）。

- 响应：

```json
{
  "groups": [ { "id": "uuid", "name": "设计组", "color": "#5b8def", "members": ["uuid"],
                "leaders": ["uuid"], "perms": { "fileWrite": true, "upload": false, "…": true },
                "whitelist": [], "blacklist": [],
                "leaderCaps": { "viewMembers": true, "manageTodo": true, "editMemberAvatar": false, "manageMembers": false },
                "createdAt": "…", "updatedAt": "…" } ],
  "leaderCaps": ["viewMembers", "manageTodo", "editMemberAvatar", "manageMembers"],
  "members": [ { "id": "uuid", "username": "alice", "disabled": false, "createdAt": "…" } ]
}
```

- `perms` 是**该小组的权限收窄表**，键与 `memberPerms` 完全相同（19 个），值只会在全局权限
  基础上继续关闭；
- `leaderCaps` 顶层字段是四个能力的**字段名清单**（给前端渲染用）。

### `POST /api/admin/groups`

- 请求体（都可省略，省略即默认值）：

```json
{ "name": "设计组", "color": "#5b8def", "members": ["uuid"], "leaders": ["uuid"],
  "perms": { "upload": false }, "whitelist": ["项目A"], "blacklist": [],
  "leaderCaps": { "manageMembers": true } }
```

- 响应：`{ "group": { …完整小组对象… } }`
- 规则与错误：
  - `name` 必填，最多 40 字符，允许中英文、数字、空格与 `_` `.` `-` → `400 名称不能为空` /
    `400 名称仅支持中英文、数字、空格与 _ . -（1-40 位）`；
  - 组名重名（不区分大小写）→ `400 小组名称已存在`；
  - 小组数量上限 **200** → `400 小组数量已达上限 200`；
  - `leaders` 里不在 `members` 中的 id 会被丢弃；成员上限 **500**、组长上限 **100**；
  - 路径列表会被清洗（最多 200 条），`color` 只接受 `#rrggbb`。

### `PATCH /api/admin/groups/:id`

- 请求体是上面字段的任意子集（`name` / `color` / `members` / `leaders` / `perms` / `whitelist` /
  `blacklist` / `leaderCaps`）；
- `perms` 是**部分更新**：只覆盖传进来的键，其余保持不变；
- 响应：`{ "group": { …完整小组对象… } }`
- 说明：**被移出 `members` 的组长会自动卸任**；改 `members` 时同样会剔除不在组内的组长。
- 错误：`400 名称不能为空`、`400 小组名称已存在`、`404 小组不存在`

### `POST /api/admin/groups/:id/members`

- 请求体：`{ "ids": ["uuid"], "action": "add" | "remove" }`
- 响应：`{ "group": { … } }`
- 错误：`404 小组不存在`、`400 参数格式错误`（`ids` 不是数组）

### `DELETE /api/admin/groups/:id`

- 响应：`{ "ok": true }`
- 副作用：该小组的待办**转为「全体」可见**（不会丢）；成员与可见范围一并删除。

### `GET /api/admin/metrics`

「设置 → 日志与指标」的系统与请求指标。

- 响应：

```json
{
  "mem": [ { "t": 1767225600000, "cpu": 3.2, "memUsedPct": 41.5, "rssMB": 96, "heapUsedMB": 40,
             "freeMB": 8192, "totalMB": 16384, "diskFreeMB": 240000, "diskTotalMB": 500000,
             "files": 120, "dirs": 8, "bytes": 10485760 } ],
  "latest": { "…同上一项…": true },
  "requests": {
    "qps": 0.12,
    "lastMinute": { "total": 7, "s2": 7, "s3": 0, "s4": 0, "s5": 0, "slow": 0 },
    "series": [ { "t": 1767225600000, "total": 7, "s4": 0, "s5": 0, "slow": 0 } ],
    "slow": [ { "t": 1767225600000, "method": "GET", "path": "/api/fs/zip", "status": 200, "ms": 1832 } ],
    "totals": { "…": 0 }
  },
  "config": { "memMinutes": 15, "sampleMs": 60000 }
}
```

- 采样间隔固定 **60 秒**；`mem` 只保留最近 `metricsMemMinutes` 分钟；
- 关闭 `requestMetricsEnabled` 后 `requests` 里的计数不再增长（`slow` 列表也不会新增）；
- 慢请求的判定阈值是 `slowRequestMs`（默认 1000 毫秒）。

### `GET /api/admin/metrics/history`

- 查询参数：`date`，格式必须是 `YYYY-MM-DD`，否则 `400 日期格式无效`；
- 响应：`{ "date": "2026-01-01", "samples": [ …同 mem 里的采样对象… ] }`（最多返回当天最后 1440 条）；
- 文件不存在时返回空数组（不算错误）。

### `GET /api/admin/backups`

- 响应：`{ "backups": { "config.json": [ { "id": "20260101-120000-ab12", "mtime": 1767225600000, "size": 2048 } ], "…": [] } }`
- 受管文件只有四个：`config.json`、`users.json`、`groups.json`、`todos.json`。

### `POST /api/admin/backups`

立即对四个受管文件做一次快照。

- 响应：`{ "ok": true, "count": 4, "backups": { …同 GET… } }`（`count` 是实际创建了几份，
  文件不存在时不会创建）

### `POST /api/admin/backups/restore`

回滚某个数据文件到指定快照。

- 请求体：`{ "name": "config.json", "id": "20260101-120000-ab12" }`
- 响应：`{ "ok": true, "name": "config.json", "id": "…" }`
- 说明：**回滚前会先给当前文件自动快照一份**（`snapshotFileAbs`），所以改错了还能再退回来；
  `config.json` / `users.json` / `groups.json` / `todos.json` 回滚后会立即重载内存态（无需重启）。
- 错误：`400 不支持恢复该文件`（`name` 不在受管列表里）、`400 备份标识无效`（`id` 含路径分隔符或不以 `.json` 结尾）、
  `404 备份不存在`、`400 该备份已损坏，无法恢复`（快照本身不是合法 JSON）

### `GET /api/admin/logs`

查询日志。

- 查询参数：

| 参数 | 默认 | 说明 |
|:-------- |:-------- |:--------------------------------------- |
| `limit` | 200 | 1–**2000**，超出会被夹取 |
| `level` | 空（全部） | `info` / `warn` / `error` |
| `q` | 空 | 在事件名、详情、用户名、IP、角色里做子串匹配（不区分大小写） |
| `days` | 5 | 读取最近几个日志文件，1–**90** |
| `audit` | 空 | 传 `1` 或 `true` 时只返回**审计事件**（登录、配置 / 成员 / 小组 / 待办变更、文件写操作、备份、日志清空、隧道开关等） |
| `stats` | 空 | 传 `0` 或 `false` 时**只返回 `{ logs }`**，省掉聚合统计 |

- 响应：

```json
{
  "logs": [ { "t": "2026-01-01T12:00:00", "lvl": "info", "ev": "login_success", "msg": "", "user": "alice", "role": "member", "ip": "192.168.1.5" } ],
  "stats": {
    "total": 128,
    "byLevel": { "info": 120, "warn": 6, "error": 2 },
    "topEvents": [ { "event": "upload", "count": 20 } ],
    "byDay": { "2026-01-01": 128 },
    "users": { "alice": 30 }
  }
}
```

- **最新在最前面**；默认只读取最近 **5** 个日志文件（按天切分），可用 `days` 放大；
- 审计事件行会多一个 `"audit": true` 字段；
- `stats` 是对**本次返回的这批日志**做的聚合：`byLevel` / `byDay` / `users` 是计数字典，
  `topEvents` 取出现次数最多的前 20 个事件；
- 传 `stats=0` 或 `stats=false` 时响应只有 `{ "logs": [...] }`——除了省算力，也方便脚本处理
  （`stats.users` 以用户名为键，而用户名可能只有大小写不同，某些 JSON 工具会把它们判成重复键而报错）。

### `DELETE /api/admin/logs`

清空所有日志文件。

- 响应：`{ "ok": true }`

### `GET /api/admin/status`

服务器状态（前端每 10 秒拉一次）。

- 响应：

```json
{
  "startedAt": 1767225600000, "uptimeSec": 3600,
  "node": "v20.x.x", "platform": "Windows_NT 10.0.22631 (x64)", "hostname": "SERVER",
  "port": 12345, "host": "0.0.0.0", "trustProxy": false,
  "lan": ["192.168.1.23"],
  "memory": { "rss": 0, "heapUsed": 0, "systemFree": 0, "systemTotal": 0 },
  "storage": { "files": 0, "dirs": 0, "bytes": 0, "partial": false, "root": "D:\\...\\data\\files" },
  "disk": { "free": 0, "total": 0 },
  "tunnel": { "running": false, "url": null, "output": [], "startedAt": null, "restarts": 0, "lastExit": null }
}
```

- `storage` 有 30 秒缓存；`disk` 取不到时是 `null`；
- `trustProxy` 的类型取决于配置：`false`、数字、字符串或字符串数组。

### `GET /api/admin/tunnel`

- 响应：`{ "config": { "enabled": false, "mode": "pinggy", "customHost": "" }, "status": { ... } }`

### `POST /api/admin/tunnel`

- 请求体：`{ "enabled": true, "mode": "pinggy" | "localhostrun" | "serveo" | "custom", "customHost": "user@host:22" }`
  （`mode` 不合法时会被归一化成 `serveo`）
- 响应：`{ "config": { ... }, "status": { ... } }`（服务端会等约 600 毫秒再返回，让状态有机会更新）
- 错误：`400` + `validateCustomHost` 的提示（`请填写 SSH 目标，例如 user@example.com` /
  `SSH 目标格式无效` / `SSH 目标格式无效，仅支持 user@host 或 user@host:端口`）
- 说明：调用后会立即按新配置生效（开启、关闭或重连）。

---

## 8. 任务状态对象

`/api/fs/compress/status`、`/api/fs/extract/status`、`/api/fs/download-url/status` 返回同一结构：

```json
{
  "id": "1f2e3d4c5b6a7988",
  "state": "running",
  "type": "compress",
  "label": "资料.zip",
  "percent": 42,
  "processed": 21,
  "total": 50,
  "processedBytes": 1048576,
  "totalBytes": 5242880,
  "error": null,
  "count": null
}
```

| 字段 | 说明 |
|:----------------- |:------------------------------------------------------- |
| `state` | `running` / `done` / `error` / `gone`（`gone` = 任务不存在、已过期或无权查看） |
| `type` | `compress` / `extract` / `download` |
| `percent` | 0–100；压缩按文件条目、解压按已处理条目、链接下载按 `Content-Length` |
| `error` | 失败原因；成功时为 `null` |
| `count` | 解压时表示实际写出的文件数 |
| 过期 | 任务状态保留 **10 分钟**，之后查询得到 `gone` |

---

## 9. 调用示例

### PowerShell

```powershell
$base = "http://localhost:12345"
$h = @{ "X-Requested-With" = "XMLHttpRequest" }
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# 登录（Cookie 保存在 $s 里）
Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/auth/login" -Headers $h `
  -ContentType "application/json" -Body '{"username":"admin","password":"你的密码"}' -WebSession $s | Out-Null

# 列目录（GET 不需要自定义头）
(Invoke-WebRequest -UseBasicParsing "$base/api/fs/list?path=" -WebSession $s).Content

# 新建文件夹
Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/mkdir" -Headers $h `
  -ContentType "application/json" -Body '{"path":"","name":"新目录"}' -WebSession $s

# 查看服务器状态
(Invoke-WebRequest -UseBasicParsing "$base/api/admin/status" -WebSession $s).Content
```

### curl

```bash
BASE=http://localhost:12345
# 登录，把 Cookie 存到 cookie.txt
curl -s -c cookie.txt -H 'X-Requested-With: XMLHttpRequest' -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"你的密码"}' "$BASE/api/auth/login"

# 列目录
curl -s -b cookie.txt "$BASE/api/fs/list?path="

# 上传文件
curl -s -b cookie.txt -H 'X-Requested-With: XMLHttpRequest' -F 'files=@./report.pdf' \
     "$BASE/api/fs/upload?path=%E8%B5%84%E6%96%99"
```

### 用 Python 轮询一个压缩任务

```python
import time, requests

BASE = "http://localhost:12345"
s = requests.Session()
s.headers["X-Requested-With"] = "XMLHttpRequest"
s.post(f"{BASE}/api/auth/login", json={"username": "admin", "password": "你的密码"}).raise_for_status()

job = s.post(f"{BASE}/api/fs/compress", json={"paths": ["资料"]}).json()["jobId"]
while True:
    st = s.get(f"{BASE}/api/fs/compress/status", params={"job": job}).json()
    print(st["state"], st.get("percent"))
    if st["state"] != "running":
        break
    time.sleep(0.5)
```

---

## 10. 路径与状态码速查

| 前缀 | 覆盖内容 | 认证要求 |
|:-------------- |:--------------------------------------------------- |:----------------------------- |
| `/ping` | 健康检查 | 无 |
| `/api/meta` | 名称与版本 | 无 |
| `/api/auth` | 登录、改密、登出、查身份、可切换的小组清单 | 部分 |
| `/api/fs` | 文件与目录、打包、压缩、解压、在线编辑、链接下载 | 按权限点 |
| `/api/avatars` | 头像列表、读取、上传、删除 | 已登录（超管 / 成员） |
| `/api/todos` | 团队待办 | 已登录（超管 / 成员） |
| `/api/groups` | 组长自助：本组成员与可见范围 | 已登录，且受组长能力约束 |
| `/api/admin` | 配置、成员、小组、日志、指标、备份、状态、隧道 | **仅超级管理员** |
| `/api/*` 其他 | 统一 404 `{"error":"接口不存在"}` | — |
| 其它任意路径 | 返回前端应用（SPA fallback） | — |

<p align="right"><a href="开发者指南.md">← 开发者指南</a> · <a href="README.md">文档中心 →</a></p>
