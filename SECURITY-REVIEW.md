# ZeroShadow / EPan 安全复检报告

- **审计对象**：`D:\编程\Wangyq EPan 网盘\EPan`（ZeroShadow v2.0.0-beta / 仓库 `wanyyq/ZeroShadow`，分支 `main`，HEAD `c4c01c2`）
- **审计方式**：全量只读静态审计，**两轮**（第一轮按攻击面横扫；第二轮逐行读完引擎层 + 机械验证 + 实测）
- **未安装任何软件**、未启动服务、未修改任何配置或数据文件
- **结论**：未发现"可直接远程无凭据接管"的高危漏洞。累计 **3 项中危、2 项中低、11 项低危/加固项**，另有 4 项信息级与 1 项合规提示；其余为本项目刻意的设计取舍

---

## 0. 结论速览

| 编号 | 风险 | 等级 | 一句话说明 |
|---|---|---|---|
| M-1 ✅ | Windows 下凭据文件对本地所有用户可读 | **中** | 已修：`.env` 与 `data\` 的 ACL 收紧为 仅你本人 / SYSTEM / Administrators |
| M-2 ✅ | 匿名访客默认可读全盘 | **中** | 已修：17 个顶层条目全部加入 `guestHiddenPaths`，访客默认看到空根目录 |
| M-3 ✅ | 插件 `permissions` 只声明不执行 | **中** | 已修：服务端下发 `permissions`，宿主在 readText/readBinary/saveText/notify 前强制校验 |
| L-1 | `save-file` 的 16MB JSON 在鉴权前解析 | 低 | 无凭据者也可反复触发 16MB 解析（`rateLimit` 在解析之后） |
| L-2 | WebDAV 不受 CSRF 校验 | 低 | 靠"只认 Basic、写方法无表单可达"兜住；将来若让 DAV 认 Cookie 需重新评估 |
| L-3 | 非法百分号编码使压缩中间件抛错 | 低 | `decodeURIComponent` 未捕获，请求 `/%E0` + `Accept-Encoding` 得到 500 而非 404 |
| L-4 | 安全响应头不完整 | 低 | 无 HSTS / COOP / COEP；CSP 的 `img-src` 放开 `http: https:`（可做追踪像素） |
| L-5 | 登录锁定只存在内存 | 低 | 重启即清零，攻击者可借运维重启刷新失败计数 |
| L-6 | 仓库跟踪了 40MB 编译产物 | 低 | `server/ZeroShadow.exe` 已入库且不可审计（`.gitignore` 注释里已自认是历史遗留） |
| L-7 | 磁盘残留旧凭据 | 低 | `.migration-backup/.../server.env`（旧超管口令）与 `server-data/.jwt-secret` |
| L-8 | WebMCP 把文件/分享能力暴露给浏览器内 AI 代理 | 低 | `navigator.modelContext` 注册的方法无二次确认即可被代理调用 |
| L-9 | 部分重接口无限流 | 低 | 单文件下载/上传无限流；`download-url` 任务无并发上限 |
| **D-1** ✅ | **目录级复制不做逐条敏感过滤** | **中低** | 已修：`data` 目录本身改为按部署布局判定 + 新增 `exposesServiceFiles()` 祖先预检 |
| **D-2** ✅ | **前端 OOXML 预览 ZIP 解压无上限** | **中低** | 已修：`inflateRaw` 改为边读边计数、超预算即取消 |
| D-3 | 压缩目标落在被压缩目录内 | 低 | 输出 zip 会把自己打进去，体积不受限 |
| D-4 | 回收站"覆盖还原"绕过回收站 | 低 | 直接 `fs.rm` 目标，不可恢复 |
| D-5~D-8 | 保留设备名 / 编码探测放大 / 第三方 JS 未锁 / 许可证 | 信息 | 见第 9 节 |

> 带 **D-** 前缀的是**第二轮深度检查**新增的，详见 [第 9 节](#9-第二轮新增发现)。

> **好消息**：已核对全部 git 历史，`.env`、`data/.jwt-secret`、`data/users.json`、`data/config.json` **从未被提交过**（公开仓库里没有凭据泄露）。

---

## 1. 审计范围与方法

| 层 | 文件数 | 覆盖情况 |
|---|---|---|
| 服务端核心 | 31 个 `server/src/*.js` | 全部通读 |
| 服务端路由 | 9 个 `server/src/routes/*.js` | 全部通读（`fs.js` 1773 行逐段读） |
| 插件体系 | 3 个 `server/src/plugins/*.js` | 全部通读 |
| 前端 | `web/src`（组件/页面/lib） | 重点读安全边界相关的：Markdown 渲染、HTML/SVG 预览、插件 iframe、WebMCP、API 封装 |
| 独立页面 | `web/public/robustness/*` | 转义与 `innerHTML` 使用点通读 |
| 运行时 | `.env`、`data/config.json`、`data/*.json`、ACL、git 历史 | 抽样核对（敏感值已脱敏处理，报告中不出现口令明文） |
| 依赖 | `server/package.json`、`web/package.json` | 版本清单复核（未联网做 CVE 比对） |

方法：以"攻击者可控输入 → 危险 sink"为主线追链路（`req.query/body/params` → 路径拼接、文件读写、子进程、出站请求、`innerHTML`、响应头），再对每条入口核对鉴权、权限、可见性、限流四件事。

---

## 2. 攻击面地图

```
浏览器 ──HTTP──> Express (HOST=0.0.0.0:5170)
                     │
      ┌──────────────┼───────────────────────────────┐
      │              │                               │
   /api/*        /dav/*  (WebDAV)              静态资源 + SPA
   csrfGuard     Basic 认证（无 Cookie）        web/dist, robustness
      │              │
      ├─ auth        ├─ PROPFIND/GET/HEAD
      ├─ fs          ├─ PUT/MKCOL/DELETE
      ├─ shares      └─ COPY/MOVE/LOCK/UNLOCK
      ├─ admin ──> 子进程 ssh（隧道，默认关）
      ├─ avatars ─> 子进程 node（server 插件，默认关）
      ├─ todos
      ├─ groups
      ├─ i18n       (公开)
      └─ plugins    (公开 /theme, /list, /entry/:id)
                     │
          文件系统：FILES_DIR=data/files（+ 只读软映射 FILES_SOFT_DIR）
          出站网络：download-url（DNS 解析 + 固定 IP 防 SSRF）
```

信任边界：`超级管理员（.env 口令）>` 成员（`users.json` bcrypt）> 组长 > 访客（匿名）> 插件（第三方代码）。

---

## 3. 中危问题

### M-1 Windows 下凭据文件对本地所有用户可读（`restrictFileMode` 无效）

**证据**

- `server/src/env.js:15-21` 用 `fs.chmodSync(file, 0o600)` 收紧权限。
- Node 在 Windows 上 `chmod` **只能切换只读位**，无法改 ACL —— 这行等于空操作。
- 本机实测（`icacls`）：
  ```
  .env               BUILTIN\Users:(I)(RX)   Authenticated Users:(I)(M)
  data\.jwt-secret   BUILTIN\Users:(I)(RX)   Authenticated Users:(I)(M)
  data               继承同样的 (OI)(CI) 权限
  ```
  即：本机任意用户（含低权限账户、服务账户、Windows Sandbox 类低完整性进程）都能读。

**影响**

| 读到的文件 | 后果 |
|---|---|
| `data/.jwt-secret` | 伪造任意成员令牌（`{role:"member",uid,tv}`，`tv` 从 `users.json` 里也能读到） |
| `.env` | 超管明文口令 `SUPER_ADMIN_PASSWORD` |
| 两者同时 | 计算 `pv = HMAC(secret, "zs-super-pwd:"+口口令)[:16]`，伪造**超级管理员**令牌 → 完全接管 |
| `data/users.json` | 成员口令哈希（可离线爆破） |

**为何仍评"中"**：需要攻击者在本机获得一个用户账号（本地权限边界），不是网络可达漏洞。但当前的 ACL 让"文件权限"这一层防护在 Windows 上完全不存在，与实际部署平台（Windows）不符。

**修复**（`icacls` 是系统自带，无需安装）

```powershell
# 在项目根执行；先备份 ACL 便于回滚
icacls .env /save env.acl.bak
icacls "data" /save data.acl.bak

icacls .env   /inheritance:r /grant:r "$env:USERNAME:(R,W)" "SYSTEM:(F)" "Administrators:(F)"
icacls "data" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)(F)" "SYSTEM:(OI)(CI)(F)" "Administrators:(OI)(CI)(F)"
```

代码侧同步建议：`restrictFileMode()` 在 `process.platform === "win32"` 时改为调用 `icacls`（或至少在启动横幅里提示"Windows 上请手动设置目录 ACL"），避免给人"已经收紧过"的错觉。

---

### M-2 匿名访客默认可读全盘（当前配置下的实际暴露面）

**证据**

| 项 | 当前值 | 出处 |
|---|---|---|
| 监听地址 | `HOST=0.0.0.0`，`PORT=5170` | `.env` |
| 访客浏览 | `guestPerms.browse = true` | `data/config.json` |
| 访客下载 | `guestPerms.downloadFile / downloadFolder = true` | 同上 |
| 访客预览 | `guestPerms.preview = true` | 同上 |
| 对访客隐藏 | `guestHiddenPaths = []`（空） | 同上 |
| 分享 | `shareEnabled=true`、`sharePublicAccess=true` | 同上 |

服务启动后，同一局域网内任何设备打开 `http://<你的IP>:5170` 即可：列出全盘目录树、下载任意文件、在线预览文本/图片/PDF、打包下载整个目录。当前 `data/files` 内混有真实内容（含一份班级花名册表格，属个人信息），并非测试数据 —— 这一点值得你在决定"访客能看多少"时纳入考虑。

**这不是代码缺陷**（代码完全按配置执行，且访客路径有完整的可见性/权限校验），而是**默认配置的暴露面需要你确认**。

**按需要的收紧方式（三选一或组合）**

1. 只在设置 → 权限里关掉访客的 `browse`（最彻底，访客需登录才能看任何东西）；
2. 保留"访客只看某个共享目录"的用法：把敏感目录加入"对访客隐藏"（`guestHiddenPaths`），注意隐藏是**递归**的（子目录一并隐藏）；
3. 只在本机使用：`.env` 改 `HOST=127.0.0.1`（此时其他设备完全连不上）。

> 另需注意：`.env` 里没有 `TRUST_PROXY`，即**不信任**代理头 —— 这与代码默认一致（`server/src/env.js:97-108`），是正确的。若将来放到 Nginx/隧道后面再开，务必只在"服务仅经该代理可达"时开启。

---

### M-3 插件 `permissions` 只声明、不执行

**证据**

- 清单校验：`server/src/plugins/manifest.js:209-219` 只做"值必须在白名单内""theme 插件不许申请权限"的**安装期**校验。
- 后台展示：`server/src/plugins/store.js:134` 把 `permissions` 交给管理界面显示。
- 运行期：`server/src/plugins/store.js:157-183` 的 `enabledRuntimePlugins()` **明确不把 `permissions` 发给前端**；
  `web/src/components/plugins/plugin-frame.tsx:74-119` 的 `handleRequest` 里，
  `readText` / `readBinary` / `saveText` **完全不检查 `plugin.permissions`**。

**影响**

`fileType` 插件（被 `sandbox="allow-scripts"` 的 iframe 承载，本身拿不到 Cookie）通过 `postMessage` 让宿主代跑请求，而宿主的判断只有两条：

- 读取：`/api/fs/file?path=<任意路径>` —— 只要是**当前登录用户**能读的文件；
- 写入：`saveText` 的 `targetPath` 同样来自插件，只要用户有 `editFiles`。

也就是说，一个声明 `permissions: []`（后台显示"不需要权限"）的插件，实际拥有"以当前用户身份读写任意文件"的能力，还能读取与它负责的扩展名完全无关的文件。

**为何评"中"**：需要超管安装并启用插件、且用户打开匹配后缀的文件才会触发；但文档与界面所承诺的"能力模型"与实际能力不符，属于**安全承诺失效**。

**修复建议**

1. 最小改动：`enabledRuntimePlugins()` 把 `permissions` 一并下发；`plugin-frame.tsx` 在 `readText/readBinary` 前要求 `permissions.includes("fs.read")`，`saveText` 前要求 `"fs.write"`；
2. 更彻底：宿主把请求转成一次服务端调用，由服务端按"插件 id + 动作"再校验一次（前端校验只是体验，不是边界）；
3. 若短期不打算实现，至少在 `docs` 与后台界面把这句话改成"已启用的插件可以当前用户身份读写文件"，不要让人误以为权限声明有效。

---

## 4. 低危与加固建议

### L-1 `/api/fs/save-file` 的 16MB 解析发生在鉴权之前

`server/index.js:117` 为该端点单独放宽到 16MB，而 `requirePerm("editFiles")` 与 `rateLimit` 都在 handler 内（`server/src/routes/fs.js:1509`）—— 解析先于两者。任何能连到端口的人（带 `X-Requested-With: XMLHttpRequest` 头即可，CSRF 只拦浏览器）都能反复强迫服务分配 16MB 并解析 JSON。

建议：把 `rateLimit` 提到 body parser 之前（或改用 `Content-Length` 预检 + 全局按 IP 的"大 body 配额"）。

### L-2 WebDAV 不受 CSRF 校验

`app.use("/api", csrfGuard)` 只覆盖 `/api`，`/dav` 在它之前挂载（`server/index.js:107`）。当前风险很低：DAV 只接受 Basic、拒绝超管、浏览器缓存的 Basic 凭据虽会自动携带，但 HTML 表单无法发出 `PUT/DELETE/MOVE/COPY`（只会 `POST`，落进 405）。**但这条边界很脆**：一旦将来给 DAV 加 Cookie 认证，就会立刻变成一个绕过 CSRF 的后门。

建议：在 `webdav.js` 头部注释里把这条约束写成显式的"不要给 DAV 加 Cookie 认证"，或加一道 `Origin` 校验作为兜底。

### L-3 压缩中间件的 `decodeURIComponent` 未捕获

`server/src/compress.js:139`：

```js
const abs = path.resolve(root, `.${decodeURIComponent(urlPath)}`)
```

请求 `/%E0%A4%A` 这类非法编码会抛 `URIError` → 500（而不是 404）。不影响安全，属健壮性；同时也是少量"日志噪声"来源。

建议：`try { ... } catch { return next() }`。

### L-4 安全响应头不完整

已有的（`server/index.js:77-84`）：`X-Content-Type-Options`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 全禁。CSP 见 `server/src/csp.js`，质量很高。

缺的：

- `Strict-Transport-Security`（仅在你不打算上 HTTPS 时可不加）；
- `Cross-Origin-Opener-Policy: same-origin`（挡 `window.opener` 类攻击，成本极低）；
- `Cross-Origin-Resource-Policy: same-origin`；
- CSP 的 `img-src 'self' data: blob: http: https:`（`csp.js:31`）—— 注释里已说清代价（可被用作追踪像素，`Referrer-Policy: no-referrer` 已缓解）。若你不依赖 Markdown 外链图片，可收紧为 `'self' data: blob:`。

### L-5 登录锁定只存在内存

`server/src/auth.js:147` 的 `attempts` 是进程内 `Map`。重启即清零；锁定期间不落盘。另外**账户锁定 5 分钟**（可递增到 30）确实可被用来"把某个成员挡在门外"（超管路径已特意改成"先验口令再判锁"来规避，成员路径没有）。
建议：至少把 `attempts` 快照进 `data/`（或接受现状，在文档里写明"重启会清空失败计数"）。

### L-6 仓库跟踪了 40MB 不可审计的编译产物

`git ls-files` 里有 `server/ZeroShadow.exe`（40.5 MB，pkg 产物）。`.gitignore` 里已经写了忽略，但文件仍在索引里（`.gitignore:10-12` 的注释也自认了这一点）。

影响：仓库体积、克隆速度、以及"仓库里有一个无法审阅的可执行文件"这一供应链观感（对公开仓库尤其如此）。

```powershell
git rm --cached server/ZeroShadow.exe
git commit -m "chore: 停止跟踪 pkg 产物"
```

（会保留本地文件，只是脱离索引。）

### L-7 磁盘残留旧凭据

`.migration-backup/20260927-135131/server.env`（567 B，旧配置，含口令字段）与 `server-data/.jwt-secret`（96 B）仍在磁盘上。它们已被 `server/src/safety.js:181-207` 的 `isSensitiveAbs()` 全面拦截（按文件名拦截 `.env*`、`.jwt-secret*`，与所在目录无关），**网盘接口读不到**；但作为废弃凭据建议直接删掉，减少"哪天被打包/备份带走"的面。

### L-8 WebMCP：把文件与分享能力暴露给浏览器内 AI 代理

`web/src/lib/webmcp.ts` 通过 `navigator.modelContext` 注册了一组工具（列目录、创建文件夹、建文本文件、创建/取消分享、报告权限……），由 `perms` / `role` 把关。支持该能力的浏览器里，**页面内的 AI 代理可以直接调用这些工具**，无需用户再确认一次 —— 其中"创建分享链接"等价于"生成一个可外发的下载地址"。

建议：给写入类与 `share_create` 加一次显式确认（或要求"仅超管可见"），并在文档里点明"开了 agent 就等于让代理以你的身份操作网盘"。

### L-9 部分重型接口没有限流

`rateLimit` 已挂在 zip / compress / extract / search / details / thumb / download-url（`routes/fs.js` 各处）。**没有**挂在：单文件下载（`/download`）、单文件上传（`/upload`）、分享下载。带宽滥用面仍在。另外 `download-url` 只是"创建任务就返回"，没有并发任务上限，一个有权限的成员可以同时起很多条出站下载。

建议：给 `download-url` 加"每用户同时进行中的任务数"上限（如 3），并与总体积上限联动。

---

## 5. 属于设计取舍、不算漏洞的几点

| 项 | 说明 |
|---|---|
| 无内置 HTTPS | 超管口令、成员口令、WebDAV Basic 凭据都会以明文经过网络。设计上依赖"只在可信内网使用"，文档与 `webdav.js` 头部都已明确警示 |
| 超管口令明文存 `.env` | 便于"改文件即改口令"，但 `.env` 必须按凭据对待（见 M-1） |
| WebDAV 用 Basic 认证 | 协议限制，每个请求重发凭据；代码已做：只认 Basic 不认 Cookie、拒绝超管、60 秒 sha256 凭据缓存、失败计数、按 IP 限流 1200/min |
| `server` 类插件不是沙箱 | `plugins/runner.js:14-21` 自己写得很清楚：只做故障隔离（独立进程、环境变量白名单、超时、输出上限），安全边界是"只装你信任的插件" |
| 自动生成口令打印到控制台 | 首次运行生成随机口令并写入 `.env`，同时打印一次。这是有意的"让部署者拿得到口令"，但要意识到控制台输出可能被日志采集 |
| `uncaughtException` 不退出 | `index.js:312` 刻意不退出（无进程管理器）。代价是"带着未知的坏状态继续跑"；换来的可用性对局域网网盘是合理的 |

---

## 6. 已确认做得好的部分（供代码评审时不要再"顺手简化"）

这些是本项目真正的安全底座，且明显是逐轮审计沉淀出来的，改动时容易被无意破坏：

**路径与文件系统**
- `safety.js:50-66` `realpathish()`：对**已存在**路径取 `realpathSync.native`（展开 8.3 短名、解开符号链接），对不存在路径取最近存在祖先 —— 让"按字符串比较"的安全判定不再被短名/链接绕过。
- `safety.js:21-35` `normRel()`：拒绝 `..`、NUL，Windows 上额外拒绝 `:`（挡 NTFS 备用数据流 `file::$DATA`）。
- `safety.js:181-207` `isSensitiveAbs()`：按**文件名**拦 `.env*` / `.jwt-secret*`，与目录无关；覆盖了 `.migration-backup` 里的历史副本；大小写归一。
- zip 解压（`routes/fs.js:1372-1400`）：逐条 `..` 检查 + `path.relative` 边界断言 + 声明值与实际值双重限额 + 累计消耗统计（防压缩炸弹）。
- 插件包解压（`plugins/store.js:219-252`）：拒绝符号链接与 `..`，条目数/单文件/总量三重上限，`manifest.id` 用 `ID_RE`（`manifest.js:57`）限死字符集，不可能穿出 `data/plugins`。

**认证与授权**
- JWT 用 48 字节随机密钥（`env.js:204-215`），HS256 且显式限定算法（`auth.js:60`）。
- 超管口令版本标识改为 `HMAC(JWT_SECRET, ...)`（`auth.js:17-21`）—— 不再把"可离线爆破的校验值"通过 JWT 载荷发给浏览器。
- 登出真吊销：成员 `tokenVersion + 1`，超管 `superSessionEpoch + 1`（`routes/auth.js:131-150`）。
- 未知用户也跑一次 bcrypt（`users.js:126`）—— 消除用户名枚举的时间差。
- 超管登录**先验口令再判锁**（`routes/auth.js:54-62`）—— 避免了"匿名打 10 次就能把唯一超管锁死"的 DoS；且注释里解释了为什么成员路径不能这么改（bcrypt 成本会变成放大器）。
- 小组上下文"缺省不等于不受限"：权限取所属组**交集**（`groups.js:335-341`），可见范围取**并集**（`groups.js:298-311`）—— 去掉 `X-ZS-Group` 头拿不回权限。
- 组长只能**收窄**可见范围（`groups.js:349-368`），不能放宽。

**CSRF / XSS / 响应**
- 双层 CSRF：自定义头 + `Sec-Fetch-Site`/`Origin` 比对（`auth.js:76-108`）。
- 用户上传的 HTML/SVG 一律 `Content-Disposition: attachment`，内联时再叠 `CSP: sandbox allow-scripts`（`routes/fs.js:282-284`、`routes/shares.js:343-345`）；`htmlPreview` 是独立权限点且服务端强判（不只是前端拦）。
- 插件入口 iframe 用 `sandbox="allow-scripts"`（**没有** `allow-same-origin`）+ `connect-src 'none'` + `default-src 'none'`（`routes/plugins.js:74-86`）；前端再用 `event.source === iframe.contentWindow` 校验来源（`plugin-frame.tsx:124`）—— 注释里点明"不透明源的 `event.origin` 恒为 `"null"`"，这一点很多实现都会写错。
- Markdown 渲染器"先整体转义、再解析"（`web/src/lib/markdown.ts`），原始 HTML 走固定白名单且**属性一律丢弃**（`markdown-html.ts`）—— 因此那处 `dangerouslySetInnerHTML` 确实没有通道；`BAD_URL` 挡 `javascript:` / `data:`。
- `contentDisposition()`（`http.js:43-48`）把非 ASCII 与引号处理掉，`\r\n` 落在替换范围内 —— 无响应头注入。
- 日志：`oneLine()` 去掉 CR/LF（防日志伪造），`csvCell()` 对 `= + - @ \t \r` 开头的值加前导单引号（**防 CSV 公式注入**，`logger.js:180-185`）—— 这一条很多项目会漏。

**SSRF（`server/src/netguard.js`）**
- 先解析 URL → DNS 取**全部** A/AAAA → 逐个按数值判断地址段（含 IPv4 映射、6to4、NAT64、Teredo、ULA、链路本地）；
- 校验通过后把 IP **固定**给 socket（`pinnedLookup`）—— 消除 DNS rebinding 的检查/使用时间差；
- 每一跳重定向都重新校验，最多 5 跳；
- 默认拒绝内网，放开需显式环境变量/后台开关，且启动时会打印"已放宽"提醒。

**其他**
- 回收站语义严格：入站失败**绝不**回落到 `fs.rm`（`trash.js:86-113`、`routes/fs.js:849-871`）。
- 覆盖 = 删除，因此统一要求 `delete` 权限并进回收站（`routes/fs.js:785-798`、`webdav.js:752-762`）。
- 备份恢复用 `path.basename` 收敛 id + 校验 JSON 顶层类型（`backup.js:176-224`）；指标历史日期用正则白名单（`metrics.js:260`）；界面语言代码用 `CODE_RE`（`i18n.js:48`）。
- 限流表全部**有界**（`auth.js:180-188`、`ratelimit.js:69-77`、`webdav.js:200-214`）—— 不会被"换 IP/换用户名"撑爆内存。
- 原子写：`writeJsonAtomic` / `save-file` / `DAV PUT` / 缩略图全部"临时文件 + rename"，并统一用 `INTERNAL_TEMP_RE` 把中间产物从列表/下载里排除（`safety.js:79-83`）。
- 缩略图：`limitInputPixels` + 并发闸门 + 队列上限 + 缓存预算（`thumbs.js`），不会被一张"1 亿像素 png"打爆。

---

## 7. 建议的处理顺序

| 顺序 | 动作 | 预计耗时 |
|---|---|---|
| 1 | 决定 M-2（访客是否该能看全盘）并按上面三选一收紧 | 5 分钟 |
| 2 | 执行 M-1 的 `icacls`（先用 `/save` 备份 ACL，改完立刻验证能登录、能上传） | 5 分钟 |
| 3 | 删除 L-7 的残留旧凭据（`.migration-backup` 里的 `server.env` 与 `.jwt-secret`） | 1 分钟 |
| 4 | `git rm --cached server/ZeroShadow.exe`（L-6） | 2 分钟 |
| 5 | 修 L-1（限流提到解析之前）、L-3（`try/catch` 包 `decodeURIComponent`） | 20 分钟 |
| 6 | 修 M-3（插件 permissions 落实，或改文档与界面文案） | 1–2 小时 |
| 7 | 补 L-4 响应头；给 WebMCP 写操作加确认（L-8） | 1 小时 |
| 8 | 需要对外暴露时再评估：HTTPS 终结、`DOWNLOAD_URL_ALLOW_PRIVATE` 永远不开、WebDAV 只在 HTTPS 下开 | — |

---

## 8. 复验方法

项目自带两个回归脚本，都只读/只测，不安装任何东西：

```powershell
# 1) 用一个独立端口、只监听回环启动待测服务（不动你现在的 5170 实例）
$env:HOST='127.0.0.1'; $env:PORT='5179'; node server/index.js

# 2) 另开一个终端跑安全回归（退出码 = 失败条数）
powershell -NoProfile -ExecutionPolicy Bypass -File security-test.ps1 -BaseUrl http://127.0.0.1:5179

# 3) 功能回归
powershell -NoProfile -ExecutionPolicy Bypass -File smoke-test.ps1 -BaseUrl http://127.0.0.1:5179
```

`security-test.ps1` 覆盖的断言与本次审计的结论高度重合（CSRF、路径穿越、zip-slip、SSRF、HTML 预览沙箱、安全响应头、发布包是否夹带凭据），建议把 M-1/L-1/M-3 修完后各补一条用例。

依赖侧的 CVE 比对本次**未联网执行**（按你的要求不做任何安装）。如需自查，在项目内执行 `pnpm audit --prod` 即可（只查询，不安装）；当前 `server/package.json` 的 express 4.21.2 / jsonwebtoken 9.0.2 / bcryptjs 3.0.2 / busboy 1.6.0 / archiver 7.0.1 / sharp 0.35.5 / unzipper 0.12.5 均为较新版本，人工核对未发现已知高危版本。

---

---

# 第二轮：深度检查

第一轮是"按攻击面横扫"，第二轮改为**逐行读完引擎层 + 机械验证 + 实测**：

- 逐行通读：`fileinfo.js`(1378 行)、`shares.js`(482)、`groups.js`(423)、`trash.js`(315)、`encoding.js`(313)、`metrics.js`(282)、`todos.js`(268)、`jobs.js`(109)、`routes/groups.js`(157)、`routes/todos.js` 全文
- 前端：Office 解析器（`office/zip.ts` `xml.ts` `xlsx.ts` `docx.ts` `pptx.ts`）、`markdown-urls.ts`、`vite.config.ts`、`index.html`
- 机械验证：路由守卫矩阵（自动提取每个路由的 `requireRole/requirePerm/rateLimit`）、"路径类端点是否都做上下文校验"、"是否存在 `readFile(req.*)` 式的直接拼接"
- 实测：Windows 保留设备名的真实行为（在临时目录做，不碰数据）；发布 zip 的条目清单；日志里的口令/票据泄漏扫描；口令哈希格式与密钥强度

## 9. 第二轮新增发现

| 编号 | 风险 | 等级 | 前置条件 |
|---|---|---|---|
| D-1 | 目录级复制不做逐条敏感过滤：开启 `softDirAllowCopyOut` 后，可复制映射目录下的 `data/` 把会话密钥搬进网盘 | **中低** | 管理员打开该开关 + 软映射指向项目根 |
| D-2 | 前端 OOXML 预览的 ZIP 解压无输出上限，恶意 docx/xlsx 可打爆浏览器标签页 | **中低** | 受害者主动打开恶意文档 |
| D-3 | 压缩目标落在被压缩目录内时，输出 zip 会把自己打进去 | 低 | 成员有 `compressZip` 权限 |
| D-4 | 回收站"覆盖还原"直接 `fs.rm` 目标，不经过回收站 | 低 | 超管显式勾选覆盖 |
| D-5 | 允许 Windows 保留设备名（`CON`/`NUL`/`COM1`…），造出打不开也删不掉的条目 | 信息 | — |
| D-6 | `/api/fs/file` 对非 UTF-8 大文件做 6 种编码全量解码，可被匿名放大 CPU | 信息 | — |
| D-7 | 同源加载的第三方 JS（lucide/gsap）未锁完整性 | 信息 | — |
| D-8 | 仓库声明 Apache-2.0，但内置 GSAP 使用 GreenSock 标准许可证 | 合规（非安全） | — |

### D-1 目录级复制不做逐条敏感文件过滤（最值得修的一条）

**证据链**

1. `server/src/routes/fs.js:80-87` 的 `blockSoftCopyOut()` 是**唯一的**门，且是"整棵子树"级的粗粒度判断，默认关闭（`softDirAllowCopyOut: false`）。
2. 真正的复制动作在 `server/src/files.js:138-146` 的 `copyEntry()`，它调用 `fs.promises.cp(..., { recursive: true })` —— **没有任何逐条过滤**。
3. `server/src/safety.js:199-202` 明确把 `data/` 目录**本身**放行（注释解释：FILES_DIR 可能就设在 data/ 上）：
   ```js
   if (norm === dataNorm) return false          // data 目录本身：放行
   if (!norm.startsWith(dataNorm + path.sep)) return false
   return SENSITIVE_DATA_ENTRIES.has(first)     // 只有 data/ 下的具体条目才拦
   ```
4. 于是 `resolveSafe("软件/data")`（软目录名 + `data`）**能够通过**全部检查 —— 被拦的是 `data/.jwt-secret`、`data/users.json` 这些**具体条目名**，而不是 `data` 这个目录。

**对比可以看出这是漏项而非设计**：打包 path 对同一场景做了逐条过滤 ——
`server/src/routes/fs.js:362`（递归统计）与 `:441`（写入 archive）都写了 `if (isSensitiveAbs(abs)) continue`。也就是说 **zip 路径防住了，copy 路径没防**。

**利用条件与影响**

条件：`.env` 里 `FILES_SOFT_DIR` 把项目根（或含 `data/` 的上级目录）映射成软目录，且管理员在后台把"允许把只读映射内容复制进网盘"打开（`softDirAllowCopyOut: true`）。

后果：任何有 `copy` 权限的成员执行一次
`POST /api/fs/copy {"sources":["<软目录名>/data"], "dest":""}`
就能把 `data/.jwt-secret`（会话签名密钥）、`data/users.json`（口令哈希）、`data/config.json` 一并复制进网盘根目录 —— 之后**匿名访客也能下载**（这两个文件名在 destination 一侧不再被拦，因为那时它们已经在 `data/files/` 里了）。等于绕过 M-1 之外的最后一层防线，直接拿到伪造任意登录态的能力。

**修复**（任选其一，建议 1+2）

1. 在 `blockSoftCopyOut` 里额外拒绝"目标树包含敏感条目"：复制前用 `dirStats` 那套遍历做一次 `isSensitiveAbs` 预检，命中就 403；
2. `copyEntry` 改为"逐条 walk + 过滤敏感项"（与 `addDirToArchive` 用同一套逻辑），顺手统一 zip / copy / trash 三条路径；
3. 最省事：把 `safety.js:199-202` 对 `data/` 目录本身的放行收窄为"仅当 `FILES_DIR` 真的等于 `DATA_DIR` 时放行"。

### D-2 前端 OOXML 预览：ZIP 解压没有输出上限（zip bomb）

**证据**

`web/src/lib/office/zip.ts:42-54`：

```ts
function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw")
  …
  return new Response(stream.readable).arrayBuffer()   // ← 无任何上限
}
```

而 `read()` 里唯一的体积校验用的是**中央目录里声明的** `e.size`（`zip.ts:126`），以及 `zip.ts:101-103` 对全部条目声明值的求和 —— 这两个值都完全由压缩包作者控制：

```ts
if (e.size > MAX_TOTAL_BYTES) throw new OfficeError("too_large")   // 只用声明值
```

**这与项目自己的服务端标准不一致**，而且服务端那段注释把这个坑解释得非常清楚（`server/src/fileinfo.js:903-907`）：

> 上面的 4MB 限制的是**压缩后**体积，解压后的输出仍然是攻击者说了算：deflate 极限压缩比约 1032:1，4MB 输入可以解出 4GB …… 超了就当解析失败。
> `zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES })`

也就是说：服务端专门加了 `maxOutputLength`，客户端这条同类路径没有对应保护。

**影响**：一个约 1MB 的 `.xlsx`（或 `.docx`/`.pptx`）声明"解压后 1KB"，实际解出 ~1GB，在用户点开预览的瞬间被 `arrayBuffer()` 全量读进内存 —— 标签页 OOM 崩溃或长时间卡死。只影响查看者自己的浏览器，服务端数据不受影响，所以是"中低"而不是"中"。但对"分享链接给别人看"这个场景很现实。

**修复**（与 Node 侧等价，改成边读边计数）

```ts
const reader = stream.readable.getReader()
let total = 0
const chunks: Uint8Array[] = []
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  total += value.length
  if (total > remainingBudget) { await reader.cancel(); throw new OfficeError("too_large") }
  chunks.push(value)
}
```

同时把 `remainingBudget` 做成跨条目共享（当前 `declared` 只在打开时算一次）。

### D-3 压缩到被压缩目录内部 → zip 把自己打进去

`server/src/routes/fs.js:1253` 的 `validateZipLimits()` 在**写入之前**算完；随后 `runCompressJob` 先 `fs.createWriteStream(outFile)`（`:1175`），再 `addDirToArchive`（`:1214`）递归读目录。若 `dest` 位于被压缩目录之内（`paths:["a"], dest:"a"` 或 `dest:"a/b"`），递归会把**正在写入的那个 zip** 当成普通文件读进去：zip 里嵌一个不完整的自己，体积不受 `validateZipLimits` 约束地增长。

`transfer()`（copy/move）对"目录移进自己"有检查（`:968`），`compress` 这条路径没有对称检查。建议在发起任务前拒绝 `dest` 落在任一源目录内部。

### D-4 回收站"覆盖还原"绕过回收站

`server/src/trash.js:219-223`：

```js
const existing = await fs.promises.lstat(dest.abs).catch(() => null)
if (existing) {
  if (!overwrite) return { conflict: true, meta }
  await fs.promises.rm(dest.abs, { recursive: true, force: true })   // 永久删除，不进回收站
}
```

项目在覆盖写、重命名、DAV MOVE、批量删除上都坚持"覆盖 = 删除 → 必须进回收站"，唯独这里没有。仅超管可达且需显式 `overwrite: true`，但一次误点就是不可恢复的数据丢失。建议改成 `moveToTrash(dest, actor)`。

### D-5 Windows 保留设备名（实测结论，不是漏洞）

`server/src/safety.js:244-253` 的 `validateName()` 只拦 `\ / : * ? " < > |` 与控制字符，不拦 `CON`/`NUL`/`AUX`/`COM1..9`/`LPT1..9`。

我在临时目录做了实测（未触碰你的数据），Node 的行为是**能正常创建**这些名字（因为 libuv 用 `\\?\` 前缀绕过了设备名解析）：

```
NUL -> 写入成功, stat.size=11, isFile=true
CON.txt -> 写入成功, stat.size=11, isFile=true
真实落盘文件: [ 'COM1', 'CON', 'CON.txt', 'NUL', 'ok.txt' ]
```

所以**不会**出现"内容写到控制台/静默丢数据"，比预想的安全；但代价是这些条目在资源管理器里双击打不开、右键删除可能失败，形成"僵尸条目"。属于健壮性瑕疵，建议在 `validateName` 里加一张保留名表（大小写不敏感，且 `CON.anything` 也算）。

### D-6 `/api/fs/file` 的多编码探测可被放大

`server/src/encoding.js:184-207`：只有在文件**不是合法 UTF-8**时才进入候选探测（绝大多数文件走早退，没问题）。但一旦进入，`scoreCandidate()` 会对 6 个候选各做一次 `countReplacement(text)` —— 这个函数遍历的是**全文**（最多 8MB），即单次约 48MB 的字符遍历。

`/api/fs/file` 只要求 `browse`，而访客默认 `browse: true`、`preview: true`，所以匿名访客能触发。已在 `rateLimit`（默认 120/分）之下，风险有限。建议：探测只在头 256KB 上做，或 >1MB 的文件直接按 UTF-8 处理并标 `confident:false`。

### D-7 同源第三方 JS 未锁完整性

`web/index.html` 用同源 `<script src="/resources/lucide.min.js">`、`/resources/gsap.min.js` 加载第三方代码，CSP 的 `script-src 'self'` 允许它们。我核对了两个文件的首部，来源是官方构建：

```
GSAP 3.13.0 / @license Copyright 2025, GreenSock
lucide v1.21.0 - ISC
```

它们位于 `web/dist`（在网盘可写范围 `FILES_DIR` 之外），所以当前**没有**通过网盘接口改写它们的路径。仅作为供应链信任点记录：建议在 CI 里对这两个文件加 hash 校验（或干脆改用 npm 依赖由打包器引入，避免"仓库里放一份 400KB 的 min.js"）。

### D-8 许可证不一致（合规，不是安全问题）

仓库根 `LICENSE` 是 **Apache License 2.0**，但 `web/public/resources/gsap.min.js` 的头声明是 GreenSock 的 **standard license**（`https://gsap.com/standard-license`），并非 Apache-2.0 兼容条款，且目录里只随附了 Google Sans Flex 字体的 OFL 许可证，没有 GSAP/lucide 的许可证全文。这与本报告的安全结论无关，但如果你要把这个项目作为公开仓库或对外分发，建议单独确认。

---

## 10. 第二轮确认的正面结论（机械验证，可复现）

| 检查项 | 方法 | 结果 |
|---|---|---|
| `/api/fs/*` 是否每个路径端点都做了上下文可见性校验 | 自动提取 22 个路由函数体搜 `assertContextVisible` | 全部覆盖；6 个"未直接出现"的经复核是误报：`/zip` 经 `zipVisibility()→contextVisible`，`/copy` `/move` 走 `transfer()` 内的 `assertContextVisible`，3 个 `*/status` 不涉及路径 |
| 路由级守卫是否齐全 | 自动矩阵（`requireRole` / `requirePerm` / `rateLimit`） | `admin`(superadmin)、`adminShare`、`adminPlugin`、`manageShare`、`groups`、`todos` 均有 `router.use` 顶层守卫；`/api/fs/download` 是唯一无路由守卫的 fs 端点，其手工权限判定逐条核对无误 |
| 是否存在 `readFile(req.*)` 式直接拼接 | 全库正则 | 无命中 |
| 日志是否泄漏口令/票据 | `Select-String` 扫 `data/logs/*.log` | 仅 3 条事件名命中（`members_reset_password`，msg 是用户 id），**无口令、无分享 token、无密钥** |
| 口令存储强度 | 读 `data/users.json` 哈希前缀 | 3 个账号全部 `bcrypt cost=10`、60 字符 |
| 签名密钥强度 | 读 `data/.jwt-secret` | 96 hex 字符 = 48 字节随机 |
| 超管口令强度 | 读 `.env`（长度/字符集，未记录明文） | 24 位、大小写+数字+符号、base64url 随机（18 字节） |
| 发布包是否夹带凭据 | 用 `System.IO.Compression` 只读列出 `!!!发行/ZeroShadow-1.1.0-windows-x64.zip` 的 61 个条目 | 只有 `.env.example`（内含 `change-me`）与 `data/.gitkeep`，**无 `.env` / `.jwt-secret` / `users.json`** |
| 前端外壳是否有内联脚本 | 解析 `web/dist/index.html` | 无内联 `<script>`，与 CSP `script-src 'self'` 自洽 |
| 待办（Todo）越权 | 读 `routes/todos.js:30-72` 的 `canView/canEdit/canComplete` | `all`/`group`/`member` 三种作用域判定正确，组长权限限制在"本组成员"内 |
| 组长能否自我提权 | 读 `routes/groups.js` + `groups.js:349-368` | 不能：改可见范围需独立能力 `manageVisibility`，且只能**收窄**；成员/组长名单变更仅超管 |
| 回收站 id 穿越 | 读 `trash.js:75-78, 181-191` | `path.basename()` 收敛 + `isInsideTrash()` 断言，双重 |

## 11. 合并后的处理顺序（第一轮 + 第二轮）

| 顺序 | 动作 | 来源 | 耗时 |
|---|---|---|---|
| 1 | 决定访客可见范围（三选一收紧） | M-2 | 5 分钟 |
| 2 | 修 `data/`、`.env`、`.jwt-secret` 的 Windows ACL | M-1 | 5 分钟 |
| 3 | 删 `.migration-backup` 里的旧 `server.env` / `.jwt-secret` | L-7 | 1 分钟 |
| 4 | **D-1**：`copyEntry` 加逐条敏感过滤（或收窄 `data/` 放行条件） | 二轮 | 30 分钟 |
| 5 | `git rm --cached server/ZeroShadow.exe` | L-6 | 2 分钟 |
| 6 | **D-2**：前端 `inflateRaw` 边读边计数 | 二轮 | 40 分钟 |
| 7 | L-1（限流提到解析前）、L-3（`try/catch`）、**D-3**（压缩目标不得在源内）、**D-4**（覆盖还原进回收站） | 一二轮 | 1 小时 |
| 8 | M-3（插件 permissions 落实或改文案） | 一轮 | 1–2 小时 |
| 9 | 补安全响应头、WebMCP 写入确认、`validateName` 保留名表（D-5） | 一二轮 | 1 小时 |
| 10 | 对外暴露前：HTTPS 终结；`softDirAllowCopyOut` 保持 false | 一二轮 | — |

---

# 13. 本轮修复记录（5 项已实施）

修复范围：**M-1、M-2、M-3**（中危）+ **D-1、D-2**（中低）。其余低危/信息项未动。

## 13.1 改动清单

| 项 | 文件 | 改了什么 |
|---|---|---|
| **M-1** | `.env`、`data\`（ACL，非代码） | `icacls /inheritance:r` 删除继承来的 `BUILTIN\Users:(RX)` 与 `Authenticated Users:(M)`，只保留 `LAPTOP-TMLB3J2D\RedmiBook`、`SYSTEM`、`Administrators`。`.env` 给 `(R,W)`，`data\` 给 `(OI)(CI)(F)` 并向下传播 |
| **M-2** | `data/config.json` | `guestHiddenPaths` 由 `[]` 改为 17 项（`data/files` 的全部顶层条目，含那份花名册与 7 个顶层文件） |
| **M-3** | `server/src/plugins/store.js` | `enabledRuntimePlugins()` 增加下发 `permissions`（原先刻意不下发） |
| | `server/src/routes/plugins.js` | 更新该端点的注释，说明 `permissions` 为什么必须下发 |
| | `web/src/lib/plugin-registry.ts` | `PluginRuntime` 增加 `permissions: string[]` |
| | `web/src/components/plugins/plugin-frame.tsx` | `handleRequest` 里新增 `requirePerm()`；`readText`/`readBinary` 要 `fs.read`，`saveText` 要 `fs.write`，`notify` 要 `ui.toast`；`useCallback` 依赖补 `plugin.permissions` |
| | `web/src/locales/{zh,en}/plugin-preview.json` | 新增 `ui.preview.plugin_permission_denied` |
| **D-1** | `server/src/safety.js` | ① `isSensitiveAbs` 对 `data` 目录**本身**的放行改为条件判断（仅当 `FILES_DIR === DATA_DIR`）；② 新增 `normPath()` 与 `exposesServiceFiles()` |
| | `server/src/routes/fs.js` | 新增 `assertCopySourceSafe()`，在 copy 分支调用（与 `softDirAllowCopyOut` 开关**无关、始终生效**） |
| | `web/src/locales/{zh,en}/api-fs.json` | 新增 `api.fs.copy_source_sensitive` |
| **D-2** | `web/src/lib/office/zip.ts` | `inflateRaw(bytes, maxBytes)` 改为 `getReader()` 边读边计数、超预算 `cancel()` 并抛 `too_large`；新增 `MAX_ENTRY_BYTES`(64MB)；`read()` 按"剩余预算"分配并累计 `inflated`；存储方式条目同样计入预算 |

## 13.2 回归验证（全部通过）

| 验证 | 方法 | 结果 |
|---|---|---|
| 服务端语法 | `node --check` × 4 个改动文件 | 全部通过 |
| 前端类型 | 本地 `tsc -p tsconfig.app.json --noEmit`（用 `web/node_modules` 里已装的 tsc，**未联网未安装**） | 退出码 0，无报错 |
| i18n 键一致性 | `node i18n-check.mjs` | **错误 0，警告 0**（新键在 zh/en 都齐全） |
| 语言文件 JSON | Node `JSON.parse` 读 4 个文件 | 全部 OK |
| **D-1 攻击链** | 设 `FILES_SOFT_DIR` 把项目根映射成软目录 `proj`，再跑真实 `resolveAny()` | `proj/data`、`proj/data/.jwt-secret`、`proj/data/users.json`、`proj/.env` **全部 404 拦截**；`proj/web`、`proj/server/src`、`proj/data/files` 正常放行（11/11 通过） |
| **D-1 结构判断** | `exposesServiceFiles()` 11 条断言 | 项目根/`data`/`.env` → true；`web`/`data/backups`/`data/files` → false（全部通过） |
| **M-2 生效性** | 读回 config.json 后调真实 `isHiddenFromGuest()` | 17 个顶层条目全部 true；深层路径（`web/dist/x.txt`、`多文件测试/图片/a.jpg`）也 true；根目录不隐藏；新目录默认可见；`web2` 不被误伤（22/22 通过） |
| **M-1 生效性** | `icacls` 复核 + 读关键文件 + 写探针 | `.env` 与 `data\` 只剩 3 条 ACE；`data\config.json`、`data\.jwt-secret` 正确继承；`.env`/`.jwt-secret`/`users.json`/`config.json`/`groups.json` 仍可读；在 `data\tmp\` 创建探针文件成功且只继承 3 条 ACE（说明服务进程仍能正常写盘） |

## 13.3 回滚方式

```powershell
# ACL（本次改动前已备份，含 data/ 下全部 356 个对象）
icacls data /restore "$env:TEMP\zs-acl-backup\data.acl"
icacls .env /restore "$env:TEMP\zs-acl-backup\env.acl"
# 文本快照也在同一目录：env.before.txt / data.before.txt / config.before.txt

# M-2：把 data/config.json 的 guestHiddenPaths 改回 []
```

**注意**：`$env:TEMP` 会被系统清理。若想长期保留回滚点，请把 `zs-acl-backup` 目录复制到项目外。

## 13.4 遗留与使用注意

1. **M-2 的行为变化（需要你知道）**
   - 访客现在打开首页看到的是**空网盘**。要让访客看某个目录：设置 → 权限 → 「隐藏文件夹」里点「取消隐藏」（列表里 17 项都在，逐条可撤）。该界面对的是 `PathPicker`（只能选目录），所以之后要给**文件**解除隐藏需要手动改 `config.json` 或用 `DELETE /api/admin/hidden-paths`。
   - 副作用（正面）：这些路径现在创建分享链接时**强制要求密码**（`requirePassword = isHiddenFromGuest(rel)`），因为"对访客隐藏"== "分享给匿名者必须加锁"。
   - **新建目录默认对访客可见** —— 这是当前实现的行为，不是配置问题。若你希望"默认隐藏、按需放开"，需要改成白名单语义（另一次改动）。
2. **`.env` 仍带 `Low` 完整性标签**（项目根目录被标成了 `Low Mandatory Level (OI)(CI)(NW)`，`.env` 创建时继承）。它**不影响**本次 ACL 的效果（访问控制看 DACL），但会让 Medium 完整性进程（如记事本）在**保存** `.env` 时可能被拒。如需修正：
   ```powershell
   icacls .env /setintegritylevel Medium
   icacls . /setintegritylevel Medium     # 只在你确认不需要该标签时
   ```
   我没有动项目根的标签 —— 它很可能是编辑器/沙箱工具设置的，改它可能影响其他工具。
3. `data\tmp\acl-probe.txt` 是我的写入探针，因当前 shell 处于 Low 完整性删不掉；**服务下次启动时 `runIntegrityCheck()` 会清空 `data/tmp`**，无残留。
4. 修复**未**触碰 `softDirAllowCopyOut` 的默认值（仍为 `false`）。D-1 的两道防线现在与开关无关，始终生效。

---

*本报告基于 2026-10-24 的工作区快照（HEAD `c4c01c2`）。报告中不含任何口令、密钥或哈希明文。*
