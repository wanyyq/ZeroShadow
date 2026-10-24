# 安全审计报告 · 认证 / 会话 / 授权 / CSRF / 限流 / 安全响应头 / 密钥与日志

- 审计对象：`D:\编程\Wangyq EPan 网盘\EPan`（v2.0.0-beta，`server/index.js` + `server/src/**`）
- 审计范围（本次）：`server/index.js`、`src/{auth,csp,ratelimit,netguard,safety,env,config,context,http,logger,metrics,tunnel,users,groups,store}.js`、`src/routes/{auth,admin,shares,plugins,groups,todos,avatars,i18n}.js`、`src/{webdav,compress,shares,plugins/store}.js`（仅取与认证边界相关的部分）
- 方式：**只读静态审计**（未启动服务、未改动任何源码/数据）；对两份既有报告（`SECURITY-AUDIT.md`、`SECURITY-REVIEW.md`）中属于本领域的结论**逐条回查当前源码**；随后按"攻击者可控输入 → 认证/授权判定 → 危险动作"重新搜一遍
- 结论：**未发现可直接绕过认证或提权的漏洞**。此前的 #1（访客隐藏目录越权读写）、#3（锁定表无限膨胀）、#8 上限、#11 realpath、#16 名册、#17 可见范围等**已确认真正修复**；但**仍有 8 条旧结论并未真正修复**（其中 L-1、L-3、L-4 对本领域有实际意义）。新增 **1 项中等偏低 + 7 项低危**，均为"削弱纵深防御 / 可被滥用做资源或信息侧信道"，无单项即可接管。

---

## 一、结论摘要

| 编号 | 严重度 | 结论 | 位置 | 状态 |
|---|---|---|---|---|
| A-1 | 中低 | `/api/auth/change-password` **既无限流也无失败锁定**：每次请求无条件跑一次 `bcrypt.compare(cost 10)`，任一登录成员可把单核 CPU 打满（约 10 次/秒 × 100ms），同时使窃取的会话可无限次猜 `oldPassword` | `routes/auth.js:98,117` | **确认** |
| A-2 | 低 | 限流的"TCP 对端兜底桶"会被 `evict()` 当作最旧条目删掉并重置 —— 开启 `TRUST_PROXY` 后，伪造 XFF 轮换约 2500 次即可把兜底额度重新装满，`limit × 6` 的兜底上限失效 | `ratelimit.js:54,57,69-77` | **确认**（逻辑推演，需运行时复核计数） |
| A-3 | 低 | 分享 token（匿名访问凭据）会原样进入**控制台 REQ 日志**与超管"慢请求"指标。`shares.js:471` 明确写了"日志里不要写 token"，但全局日志把 `/s/<token>`、`/api/share/<token>/...` 直接打印 | `index.js:70-75`、`metrics.js:120-130` | **确认** |
| A-4 | 低 | 日志文件**无单文件体积上限**（只按天分文件 + 按天数淘汰），而登录失败/分享浏览等匿名请求都能写入日志 → 匿名方可按 120 次/分持续膨胀磁盘（约 26MB/天/IP） | `logger.js:74`、`sweepLogs` 仅按 mtime | **确认** |
| A-5 | 低 | 会话 Cookie 的 `secure` 判定读**客户端可伪造**的 `X-Forwarded-Proto`，且不受 `TRUST_PROXY` 约束；反之在隧道 HTTPS 场景下通常拿不到该头 → 真正走 HTTPS 时会话 Cookie **没有 Secure** | `auth.js:37-45`（`:41`） | **确认** |
| A-6 | 低 | 超管登录分支**完全跳过 bcrypt**，因此响应时间（~1ms vs ~100ms）可判断"该用户名是否就是超管账号"，形成用户名枚举（口令仍需猜） | `routes/auth.js:54-62` | **确认（代码路径确定，时间差未实测）** |
| A-7 | 低 | `restrictFileMode()` 在 Windows 上仍是**空操作**，且没有任何 `icacls` 调用或启动告警。本机 ACL 已手工收紧（已复核），但这层防护**不随仓库走**：新机器/重新克隆即回到"凭据对本机任意用户可读" | `env.js:15-21`；`store.js:61`、`env.js:64,122,213` 的调用点 | **确认（旧 M-1 的代码侧未修）** |
| — | — | 全站**没有任何全局请求限流**：`rateLimit` 只手工挂在 16 个端点上，`/api/fs/download`、`/api/fs/upload`、`/api/fs/list`、`/api/share/:token/verify`、`/api/auth/change-password`、所有 `/api/admin/*` 均无限流 | 全库 grep `rateLimit` | **确认（旧 L-9 未修完）** |

> 严重度标定口径：A-1 需要"一个成员账号"（默认配置下成员权限全开），拒绝服务面覆盖全站；A-2~A-7 均为纵深防御缺口或侧信道，单项不足以接管账号。

---

## 二、已修复验证（vs 两份既有报告）

### 2.1 真正修复（逐条回查通过）

| 旧编号 | 旧结论 | 现状 | 当前证据（行号为当前源码） |
|---|---|---|---|
| AUDIT #1 | 「对访客隐藏」可被 `/api/fs/file`、`/save-file` 绕过 | ✅ **已修**。`guestBlocked()` 已统一进 `assertContextVisible()`，两个端点都走它 | `routes/fs.js:118-130`（`if (guestBlocked(req, rel) \|\| !contextVisible(req, rel)) throw 404`）；调用点 `:1470`（`/file`）、`:1537`（`/save-file`）；`/file` 另外补了 `rateLimit`（`:1467`） |
| AUDIT #2 | 软目录映射 `"./"` 会泄露 `.env` / `data/.jwt-secret` | ✅ **已修**。`resolveAny()` 的两条分支（软目录 `:116`、网盘本体 `:129`）都调 `isSensitiveAbs()`；模板示例已换成不泄露的路径并加警告 | `safety.js:116`、`:129`、`:187-217`；`env.js:45-48` |
| AUDIT #3 | 登录锁定表可被任意用户名无限撑大 | ✅ **已修**。`loginLocked()` 改用只读 `peek()`（不再为任意用户名建条目）；`bucket()` 在插入路径上保证有界 | `auth.js:150-152`（`peek`）、`:190-199`（只读查询）、`:154-170`（插入即淘汰）、`:180-188`（`evictOldest`） |
| AUDIT #7 | 日志导出 CSV 公式注入 | ✅ **已修** | `logger.js:182`（`if (/^[=+\-@\t\r]/.test(s)) s = \`'${s}\``） |
| AUDIT #8（上半） | 限流桶 `MAX_TRACKED_IPS` 上限无效 | ✅ **已修**（有界性），但见 A-2（兜底桶会被删） | `ratelimit.js:57`、`:69-77` |
| AUDIT #11 | 无 `realpath` 校验 | ✅ **已修**。`realpathish()` 对已存在路径 `realpathSync.native`、对不存在路径取最近存在祖先，且判定用的是**规范化后**路径 | `safety.js:50-66`、`:104-123` |
| AUDIT #16 | 任何成员都能拿全站账号名册 | ✅ **已修**。`allMembers` 只给超管与 `viewMembers/manageMembers` 被授权的组长 | `routes/groups.js:63-74` |
| AUDIT #17 | 小组上下文"替换"而非交集；组长可清空白/黑名单 | ✅ **已修**。无小组头时权限取所属组**交集**、可见范围取**并集**；`manageVisibility` 是独立开关，且组长只能**收窄** | `groups.js:298-341`（`unionVisibility`/`permsForContext`）、`:349-368`（`isVisibilityNarrower`）；`routes/groups.js:126-148` |
| AUDIT #18 | 控制台日志行可被换行注入 | ✅ **已修**（磁盘 JSON 行本就安全） | `logger.js:82-83`（`oneLine()` 去 `\r\n\u2028\u2029`） |
| REVIEW M-1 | Windows 下凭据文件对本地所有用户可读 | ⚠️ **仅在本机修复**（ACL 已复核：`.env`/`data\`/`.jwt-secret`/`users.json` 只剩 SYSTEM/Administrators/RedmiBook 三条 ACE），**代码侧未修** → 见 A-7 | `icacls` 复核通过；`env.js:15-21` 仍是纯 `chmodSync` |
| REVIEW M-3 | 插件 `permissions` 只声明不执行 | ✅ **已修**（宿主侧强制校验） | `plugins/store.js:182`（下发 `permissions`）；`web/src/components/plugins/plugin-frame.tsx:85-135`（`requirePerm`） |
| REVIEW L-2 | WebDAV 不受 CSRF 校验 | ✅ **属设计取舍且已文档化**：`/dav` 只认 Basic、拒绝超管、不认 Cookie，且这条约束已写成文件头注释 | `webdav.js:35`、`:289-314`、`:875-900` |
| REVIEW L-5 | 登录锁定只在内存 | ✅ 结论仍成立，且已被注释承认 | `auth.js:147`（进程内 `Map`） |

### 2.2 旧结论**并未真正修复**（本次重点）

| 旧编号 | 旧结论 / 旧建议 | 当前实际 | 证据 |
|---|---|---|---|
| REVIEW **L-1** | `/api/fs/save-file` 的 16MB 解析发生在鉴权之前 | ❌ **仍未修**。只把 body 解析挪到了 `csrfGuard` 之后；`requirePerm`/`rateLimit` 仍是**路由级**，所以任何非浏览器客户端（自带 `X-Requested-With`）依旧可以在**未登录**状态下无限次强迫服务解析 16MB JSON | `index.js:117`（`app.use("/api/fs/save-file", express.json({ limit: SAVE_FILE_MAX_BYTES }))`）早于 `:124-140` 的路由挂载；`routes/fs.js:1532` 的 `requirePerm` 在 handler 内 |
| REVIEW **L-3** | `compress.js` 的 `decodeURIComponent` 未捕获 → 非法编码 500 | ❌ **仍未修**。仍无 `try/catch` | `compress.js:139`：`const abs = path.resolve(root, \`.\${decodeURIComponent(urlPath)}\`)`；触发：`GET /%E0%A4%A.js` + 任意 `Accept-Encoding`（`.js` 命中 `TYPES` 后才走到这一行，`compress.js:131-139`） |
| REVIEW **L-4** | 缺 HSTS / COOP / CORP | ❌ **仍未修**。全库无 `Strict-Transport-Security`、无 `Cross-Origin-Opener-Policy`、无 `Cross-Origin-Resource-Policy` | 全库 grep 仅命中 5 处 `Content-Security-Policy`（`index.js:182,202`、`compress.js:188`、`fs.js:303`、`shares.js:344`）；安全头仍只有 `index.js:77-84` 那 4 个 |
| REVIEW **L-5** | 锁定表快照落盘或文档写明 | ❌ 未做（见上） | `auth.js:147` |
| REVIEW **L-9** | 单文件下载/上传无限流；`download-url` 无并发上限 | ⚠️ **部分修复**：分享下载补了 `rateLimit`（`shares.js:324`），但 `/api/fs/download`、`/api/fs/upload` 仍无限流，`download-url` 仍无并发任务上限 | `routes/fs.js:255`（download 无 `rateLimit`）、`:613`（upload 无）；`:1762` 只有 `rateLimit` |
| REVIEW **M-1** | `restrictFileMode` 在 Windows 无效，建议代码侧兜底或启动横幅提示 | ❌ 未做（见 A-7） | `env.js:15-21`；全库 grep `icacls` 无命中 |
| AUDIT #8（下半） | `TRUST_PROXY` 下限流可被 XFF 绕过 | ⚠️ **加了兜底桶但兜底可被清掉** → 见 A-2 | `ratelimit.js:54`、`:69-77` |
| REVIEW D-6 | `/api/fs/file` 多编码探测可被放大 | ❌ 未修（仍有 6 候选全量扫描），仅靠 `rateLimit` 挡 | `routes/fs.js:1467`（有 `rateLimit`）+ `encoding.js` 的 `scoreCandidate` |

### 2.3 逐项复核通过、无需再查的部分（本领域）

- **Cookie 三属性**：`httpOnly: true`、`sameSite: "lax"`、`path: "/"`、`maxAge` 与 JWT `expiresIn` 同源（`auth.js:37-52`）；无 `domain`（host-only）。
- **JWT 强度**：`randomBytes(48).toString("hex")` = 96 hex / 384 bit（`env.js:211`）；签发与校验显式限定 HS256（`auth.js:52`、`:60`）。
- **超管口令不进载荷**：JWT 里只有 `HMAC(JWT_SECRET, pwd)[:16]`，无法离线验证猜测（`auth.js:17-21`）。
- **吊销是真吊销**：成员 `tokenVersion + 1`（`users.js:169-177`、`:193`），超管 `superSessionEpoch + 1`（`routes/auth.js:137-141`），改密/禁用同样走吊销（`users.js:148`、`:193`）。
- **陈旧用户不会带权限**：`attachAuth` 用 `findById(payload.uid)` 重查，并要求 `!user.disabled && tokenVersion === payload.tv`；删除用户后 `findById` 返回 null → 降为 guest（`auth.js:63-68`）。用户名从**数据库记录**取（`:66`），不取 JWT 的 `sub`。
- **CSRF 双层**：自定义头 + `Sec-Fetch-Site`/`Origin`；`Origin` 用 `new URL(origin).host` 与 `req.headers.host` 比对（**含端口**），因此 `:8080` 页面打 `:5170` 会被拦（`auth.js:81-105`）。
- **GET 无状态变更**（逐端点核对 38 个 `get(`）：`compress/extract/download-url` 的 `*/status` 只刷新内存里的 `updatedAt`；`/api/share/:token/download` 只 `touchShare` 统计；无任何 GET 触发配置/文件写。
- **管理员守卫顺序**：`admin.js` 的 `router.use(requireRole("superadmin"))` 在**第一行**路由之前（`routes/admin.js:32`）；`/api/admin/shares`（`shares.js:536`）、`/api/admin/plugins`（`plugins.js:104`）各自都有同样的顶层守卫，且它们在 `/api/admin` 之前挂载（`index.js:131-133`）—— Express 的 `app.use` 按路径段边界匹配（`/api/admin/sharesX` 不匹配 `/api/admin/shares`），因此**不存在"被超管守卫吞掉"或"越过守卫"两种问题**。
- **角色不会被请求头伪造**：全库 `req.headers[...]` 只有 `x-requested-with`、`sec-fetch-site`、`x-zs-group`、`if-*`、`authorization`、`content-length`、`lock-token`；`x-zs-group` 会经 `canUseGroupContext()` 校验归属，访客/非成员一律回落默认上下文，且**默认上下文是权限交集**（`groups.js:335-341`、`:403-423`）。
- **无 CORS 面**：全库无 `Access-Control-*`（不存在"反射 Origin"类配置错误）。
- **错误响应不含堆栈**：`index.js:214-237` 只在 5xx 用固定文案，从不返回 `err.stack`。`uncaughtException` 的 `stack` 字段虽然被传进 `logError`（`index.js:316`），但 `log()` 只取 `msg/user/role/ip`（`logger.js:63-71`），**实际被丢弃**——注释"详情写进日志"与实际不符（诊断性缺陷，不是泄露）。
- **日志不含口令/票据**：`data/logs/*.log` 全量扫描 `token|ticket|password|secret` 仅 3 条命中，均为 `members_reset_password` 的用户 id；`data/logs` ACL 也已收紧为 3 条 ACE。
- **隧道无命令注入**：`spawn("ssh", args)`（无 shell）+ 主机名正则 + 拒绝 `-` 开头（`tunnel.js:58-66`、`:137`）；`execSync("ssh -V")` 是常量命令（`:72`）。
- **SSRF 仍是本项目最强的一块**：DNS 全量解析 → 逐段数值判定 → `pinnedLookup` 固定 IP → 每跳重定向重新校验（`netguard.js:194-289`）。唯一"放开"路径是 `privateAccessAllowed()`（环境变量或后台开关，注释已明示，属设计取舍）。

---

## 三、确认的新问题

### A-1【中低】`/api/auth/change-password` 无限流、无失败锁定 —— bcrypt 放大器 + 旧密码可无限猜

**位置**：`server/src/routes/auth.js:98`（路由定义）、`:117`（`bcrypt.compare`）、`:121-122`

**证据**

```js
// routes/auth.js:98
router.post("/change-password", requireRole("superadmin", "member"), requirePerm("changePassword"), async (req, res, next) => {
// routes/auth.js:117
    const ok = await bcrypt.compare(oldPwd, user.passwordHash)
    if (!ok) throw httpError(403, "旧密码错误", { errorKey: "api.auth.old_password_incorrect" })
```

- 该路由**没有** `rateLimit`（对比同行 `router.post("/login", rateLimit, ...)` 在 `:30`）；
- 失败时**不调用** `recordLoginFail()`，因此 IP 锁定（`IP_MAX_FAILS=30`）与账户锁定（`USER_MAX_FAILS=10`，`auth.js:136-143`）对它完全不生效；
- 每次请求都跑一次 `bcrypt.compare(cost 10)`。

**影响**

1. **成员级 DoS 提升为全站 DoS**：Node 单线程，`bcryptjs` cost-10 约 100ms；一个登录成员以 10 req/s 持续请求即可占满一个核，全体用户的 `/api`（含登录、列目录）一起变慢。默认 `memberPerms.changePassword = true`（`config.js:95`），即**所有成员**都有这个能力。这与此前为 `/api/auth/login` 专门加限流的理由（"没有限流时仍可被用于反复触发 bcrypt 比对"，`routes/auth.js:26-29`）是同一个威胁模型，但这里漏了。
2. **会话被窃后旧密码可无限猜**：`oldPassword` 校验无次数上限。拿到 Cookie 的攻击者（共享电脑、日志/备份、XSS）可用离线字典无限次验证口令，进而改密并长期接管（JWT 有效期默认 72h，`env.js:149`）。

**触发条件**：持有一个有效成员会话（自己注册不可能 —— 成员由超管创建；但局域网内任一成员账号即可）。

**修复建议**

```js
router.post("/change-password", requireRole("superadmin","member"), rateLimit, requirePerm("changePassword"), ...)
// 并复用 auth.js 的失败计数（专门一套前缀，避免和登录锁定互相干扰）：
if (!ok) recordPasswordChangeFail(req.ip, req.auth.userId)   // 5 次 → 锁 15 分钟，返回 429
```

同时建议给**所有**跑 bcrypt 的端点（`/change-password`、`/api/share/:token/verify`、`/dav`）统一走一个"bcrypt 令牌桶"（全局并发上限 1~2 + 每 IP 速率），否则以后新增一个端点就会再漏一次。

---

### A-2【低】限流"对端兜底桶"会被淘汰逻辑删掉，`TRUST_PROXY` 下的兜底上限失效

**位置**：`server/src/ratelimit.js:54`（双桶）、`:57`（触发淘汰）、`:69-77`（淘汰实现）

**证据**

```js
// ratelimit.js:54
const blocked = hit(`ip:${ip}`, limit, now) || (peer !== ip ? hit(`peer:${peer}`, limit * PEER_FACTOR, now) : null)
// ratelimit.js:57
if (buckets.size > MAX_TRACKED_IPS) evict(now)
// ratelimit.js:74-76
const byAge = [...buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)
const drop = buckets.size - Math.floor(MAX_TRACKED_IPS * 0.9)
for (let i = 0; i < drop && i < byAge.length; i += 1) buckets.delete(byAge[i][0])
```

**推理链（可复核）**

1. 开启 `TRUST_PROXY` 后 `peer`（`req.socket.remoteAddress`，即代理地址）**恒定**，`ip`（XFF）由攻击者控制 → 每个伪造 IP 新建一个 `ip:` 桶；
2. 只有 `peer:` 桶能限制"换 IP 刷额度"，但它是在**最早**的时刻创建、且 `windowStart` 只在窗口过期时更新 → 在 `byAge` 里永远排最前；
3. 每次 `evict()` 都按 `windowStart` 升序**删掉最旧的约 10%**，`peer:` 桶因此几乎必然被删 → 计数归零，`limit × 6`（默认 720/分）重新装满；
4. 触发 `evict()` 只需 `buckets.size > 5000`，即 60 秒窗口内约 2500 个伪造 IP（每个请求同时创建一个 `ip:` 桶并累加 `peer:` 桶）。

**影响**：`ratelimit.js:13-19` 注释所声称的"单个来源最多只能做到 6 倍限额"在 `TRUST_PROXY` + 可直连（或代理不覆盖 XFF）的部署下不成立 —— 攻击者只要多花约 2500 个请求，就能把 IP 限流完全废掉，同时把限流表维持在上限附近（内存有界，不会 OOM）。

**触发条件**：`.env` 里 `TRUST_PROXY=true/1/loopback` 且服务同时可被直连（或代理未剥离客户端 XFF）。当前部署 `.env` **未设** `TRUST_PROXY`（已核对），因此现网不触发；`TRUST_PROXY=loopback` 是模板推荐的隧道配置（`env.js:38`），属于会踩到的路径。

**修复建议**：把兜底桶排除在淘汰之外（专用变量，或键前缀白名单：`if (k.startsWith("peer:")) continue`），并让 `peer:` 桶的 `windowStart` 不参与 `byAge` 排序；更彻底的做法是限制 `ip:` 桶总数（例如每 5000 上限时直接拒绝新 IP 而不是淘汰旧桶）。

---

### A-3【低】分享 token 进入控制台日志与慢请求指标

**位置**：`server/index.js:70-75`（REQ 日志）、`server/src/metrics.js:120-130`（慢请求）；相关"不要记 token"的约定在 `routes/shares.js:471-472`

**证据**

```js
// index.js:71-72
if (!NOLOG && req.path !== "/favicon.ico" && req.path !== "/resources/lucide.min.js") {
  console.log(`[REQ] ${req.method} ${req.path} host=${req.headers.host} ip=${req.ip} ua=...`)
```
```js
// routes/shares.js:471-472（作者自己的约定）
// 日志里**不要**写 token：它就是匿名访问凭据，写进 data/logs 后会被导出接口
// 带出去，而且日志的保留期（默认 30 天）比分享本身还长。记分享 id 即可。
```

分享访问的 URL 形态就是 `GET /api/share/<token>/list|download`、`GET /s/<token>`（前端页面）。这三条路径都**不会**在 `index.js:71` 被过滤，`req.path` 会把 `<token>` 原样带进 stdout。`metrics.js:124` 也把 `req.path` 存进 `slowRequests`（超管经 `/api/admin/metrics` 可读）。

**影响**：token 是**匿名访问凭据**（拿到即可读整个分享，不需要密码票）。它被写进：
1. 控制台 stdout —— 部署者常把 `node server/index.js` 的输出重定向到文件、或由 Windows 服务包装器/进程管理器采集；这些文件**不受 `data/logs` 的保留期与 ACL 保护**，也不在"日志导出"的可见范围内，属于隐蔽的凭据副本；
2. 与作者在 `shares.js:471` 明确表达的意图**直接矛盾**（说明是遗漏而非设计）；
3. 索引/访问日志里出现凭据还会被"分享链接本身不落日志"的假设误导后续审计。

**触发条件**：任何一次访问分享链接（匿名即可触发，无需登录、无需密码）。

**修复建议**：日志中间件里对路径做脱敏（`/^\/api\/share\/[^/]+/ → /api/share/:token`、`/^\/s\/[^/]+/ → /s/:token`），或干脆不打印 `/api/share`、`/s/` 前缀；`metrics.js` 同样脱敏。

---

### A-4【低】日志文件无单文件体积上限，匿名请求可无限写入

**位置**：`server/src/logger.js:73-77`（写盘）、`:246-267`（`sweepLogs` 只按 mtime 淘汰）

**证据**

```js
// logger.js:74
fs.appendFileSync(fileFor(dateKey()), JSON.stringify(entry) + "\n", "utf8")
```
```js
// logger.js:259-261（唯一的清理逻辑：只按"文件最后修改时间"判过期）
if (st.mtimeMs < cutoff) { await fs.promises.rm(abs, { force: true }); removed += 1 }
```

- 文件名是 `zs-YYYY-MM-DD.log`，**没有**按大小滚动、没有单文件上限、没有总量上限；
- 匿名（未登录）即可写入的审计事件：`login_fail`（`routes/auth.js:88`，每次登录失败一条）、`login_locked`、`share_password_fail`（`shares.js:276`）、`share_browse`/`share_download`（`shares.js:316,346`，无密码分享匿名可触发）；
- 唯一入口限流是 `/api/auth/login` 的 120 次/分（`ratelimit.js` 默认 120）。

**量级**：单条日志约 150 字节 → 120 次/分 ≈ 18KB/分 ≈ **26MB/天/IP**；局域网内多台设备/多 IP 线性叠加，且保留 30 天（`logRetentionDays` 默认 30，`config.js:37`）。`data/` 所在卷被写满会直接导致上传、原子写、备份全部失败（`store.js:53` 写临时文件失败 → 配置与用户数据保存不了）。

**触发条件**：无需任何凭据，只要网络可达。

**修复建议**：给单日文件加软上限（例如 20MB，超过后停写并记一条 `log_overflow`），或按大小滚动 `zs-YYYY-MM-DD.<n>.log`；同时给 `login_fail` 这类"纯计数"事件做聚合（同一 IP 每分钟只写一条 N 次），不要一条一写。

---

### A-5【低】会话 Cookie 的 `Secure` 由客户端可伪造的头决定，且不受 `TRUST_PROXY` 约束

**位置**：`server/src/auth.js:37-45`（`:41`）

**证据**

```js
export function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: req ? (req.secure || req.get("x-forwarded-proto") === "https") : false,
    path: "/",
    maxAge: env.sessionHours * 3600 * 1000,
  }
}
```

两个方向都有问题：

1. **过宽**：`req.get("x-forwarded-proto")` 是**请求头**，与 `TRUST_PROXY` 完全无关（项目其它地方对 `req.ip` 都严格按 `trustProxy` 处理，见 `index.js:56-61`）。任何客户端都能声明 `X-Forwarded-Proto: https`，让服务在**明文 HTTP** 上下发一个带 `Secure` 的 Cookie（后果是把自己锁在外面，属自伤；但说明该判定不是一个可信信号）。
2. **过窄（真正的风险）**：项目主推的公网访问方式是 SSH 隧道（`tunnel.js:89-104`，pinggy/serveo/localhost.run 终结 TLS 后以明文 HTTP 转发到 `127.0.0.1:PORT`）。若隧道方不注入 `X-Forwarded-Proto: https`（serveo/pinggy 的 `-R` 隧道通常不会），则 `req.secure === false`、头也拿不到 → **浏览器看到的 https 站点，会话 Cookie 却没有 `Secure`**。此后任何一次同域的 `http://` 请求（含被 DNS/代理降级的请求、`http://<同一域名>` 的旧书签）都会附带该 Cookie 明文传输。

**触发条件**：通过 HTTPS 隧道/反代访问且代理未注入 `X-Forwarded-Proto`。当前 `.env` 未启用隧道（`enabled: false`，已核对 `data/config.json`），故现网不触发。

**修复建议**

```js
// 与 trust proxy 对齐：只在信任代理时才采信该头
secure: req ? (req.secure || (env.trustProxy !== false && req.get("x-forwarded-proto") === "https")) : false
```

更稳的做法是让 Cookie 名带 `__Host-` 前缀并在隧道场景下强制 `secure: true`；同时补 HSTS（见 L-4 未修）。

---

### A-6【低】超管用户名可被响应时间枚举

**位置**：`server/src/routes/auth.js:54-66`

**证据**

```js
const superUser = isSuperUser(username)
if (superUser) {
  if (!verifySuperPassword(password)) { ...; return res.status(401).json(...) }   // 无 bcrypt，~微秒
} else {
  const lockedMinutes = loginLocked(req.ip, username)
  if (lockedMinutes) return lockedResponse(lockedMinutes)
}
...
const result = await verifyLogin(username, password)   // 未知/存在成员都跑一次 cost-10 bcrypt，~100ms
```

`isSuperUser` 命中时走 `timingSafeEqual`（`auth.js:233-241`），**完全不碰 bcrypt**；非超管用户名则必然经过 `verifyLogin` 的 cost-10 bcrypt（`:72`）。两条路径耗时差 ~2 个数量级，且 120 次/分的限流对"取 3~5 个样本"毫无阻碍。

**影响**：可确认"该用户名是否为超管账号"。超管名默认 `admin`（`env.js:147`）且写在 `.env` 的 `SUPER_ADMIN_USER`，本身就是可猜的；但如果部署者改成了不公开的名字，这条侧信道会把它暴露出来（口令仍需猜，故仅低危）。同时它也说明"超管/成员"两条认证路径的时序特征不一致。

**修复建议**：超管分支在口令错误时也跑一次固定成本的 dummy bcrypt（或整体把超管认证也改成 bcrypt 存储），使两条路径耗时同阶。

---

### A-7【低】Windows 上密钥/凭据文件权限仍只靠手工 ACL（代码侧 noop，回归风险）

**位置**：`server/src/env.js:15-21`（`restrictFileMode`）；调用点 `env.js:64,122,213`、`store.js:61`、`backup.js:100,223`、`avatars.js:163`

**证据**

```js
// env.js:15-21
export function restrictFileMode(file, mode = 0o600) {
  try { fs.chmodSync(file, mode) } catch { /* 平台不支持或文件暂不存在：忽略 */ }
}
```

Node 在 Windows 上 `chmod` 只能切换只读位，**改不了 ACL**；全库 grep `icacls` 无命中，启动横幅（`index.js:258-299`）也没有任何"请手工设置 ACL"的提示。

**现状复核（本机）**：`.env`、`data\`、`data\.jwt-secret`、`data\users.json`、`data\config.json` 的 ACL 都已是 `SYSTEM / Administrators / RedmiBook` 三条，**M-1 在本机确实修好了**。

**影响**：这层防护**不随代码/仓库传播**。换一台机器、重装系统、把项目复制到别的 Windows 主机、或从仓库重新部署（`.env` 与 `data/` 会重新创建）时，凭据文件立刻恢复为"本机任意用户可读"：读到 `data/.jwt-secret` 可伪造任意成员令牌，读到 `.env` 可得超管明文口令，两者兼得即完全接管（且 `pv = HMAC(JWT_SECRET, pwd)` 可离线算出超管令牌）。

**为什么仍报**：这是"审计结论与代码不一致"的典型 —— 文档写"已修"，但修复物在仓库之外，无法被任何后续检查发现。

**修复建议**：`restrictFileMode()` 在 `process.platform === "win32"` 时改调 `icacls <file> /inheritance:r /grant:r "%USERNAME%:(R,W)" "SYSTEM:(F)" "Administrators:(F)"`（失败则仅告警）；至少在启动时检测 `.env`/`data` 的 ACL 并打印一行"权限未收紧"的提示。

---

### A-8【低】全站没有全局请求限流（旧 L-9 的延伸）

**位置**：`server/src/ratelimit.js:45`（`rateLimit` 是按路由手工挂的中间件）；覆盖点仅 16 处

**证据**：全库 `rateLimit` 使用点（`routes/fs.js:476,1040,1076,1103,1140,1260,1323,1467,1532,1762`、`routes/auth.js:30`、`routes/shares.js:246,289,324,391,429`）+ `/dav` 自带 `davRateLimited`（`webdav.js:200-214,857`）。**未覆盖**：`/api/fs/download`、`/api/fs/upload`、`/api/fs/list`、`/api/auth/change-password`、`/api/auth/logout`、`/api/share/:token/verify`（`shares.js:258`，同组其它三个路由都挂了）、全部 `/api/admin/*`、`/api/avatars/*`、`/api/todos/*`、`/api/groups/*`。

**影响**：匿名方可无限次拉取 `/api/fs/download`（当前 `guestPerms.downloadFile=true`）做带宽放大、无限次 POST 1MB JSON 触发解析（见未修的 L-1）、无密码分享的 `/verify` 可无限刷日志（配合 A-4）。无凭据即可参与的资源放大面，比逐端点限流所假设的威胁模型更宽。

**修复建议**：在 `index.js` 的 `attachAuth` 之后加一道粗粒度全局限流（例如每 IP 600/分、只对 `/api` 生效、与现有细粒度限流叠加），并把 `rateLimit` 从"逐路由手写"改成"默认开启 + 白名单豁免"，避免以后新增端点继续漏。

---

## 四、疑似待验证（需运行时才能定论）

| # | 疑点 | 依据 | 需要的验证 |
|---|---|---|---|
| S-1 | 4xx 响应回显 `err.message`，可能把**服务器绝对路径**回给客户端 | `index.js:220`：`const body = { error: status >= 500 ? "服务器内部错误" : err.message }`；`fs.js:306`、`shares.js:347`、`webdav.js:558` 都走 `res.sendFile(..., (err) => next(err))`，而 `send` 对 ENOENT 会给出 `status: 404` + `"ENOENT: no such file or directory, open 'D:\\...'"` | 在 `assertExists()` 与 `res.sendFile()` 之间删掉文件，观察响应体是否含绝对路径。窗口极小，纯竞态 |
| S-2 | `evictOldest()` 也可能删掉**仍在锁定中**的桶，导致账户锁定被提前解除 | `auth.js:184-187` 的第二阶段按 `first` 升序无条件删除，只跳过"过期且未锁"的第一阶段（`:182`）。锁定后 `first` 会被重置为当下（`:216`），所以目标桶通常较新，需精确控制时间 | 构造 5000+ 个不同用户名的失败登录，使目标账户的锁定桶落在最旧 500 名内，观察 429 是否提前消失 |
| S-3 | 分享密码接口 `/api/share/:token/verify` 未挂 `rateLimit`，只有 per-IP+token 的失败计数；`req.ip` 在 `TRUST_PROXY` 下可伪造 → 分享密码可被"换 IP"爆破 | `shares.js:258`、`shares.js:418-473`（`PER_SHARE_MAX=8` / `PER_IP_MAX=20`，均以 ip 为键） | 开 `TRUST_PROXY` 后带不同 XFF 头对同一个加密分享连续试 8 次以上 |
| S-4 | `/api/fs/compress`、`/api/fs/extract`、`download-url` 的**任务表**是否也有"无并发上限"问题（旧 #19 的同类） | `jobs.js` 仅按闲置时间清理，`routes/fs.js:1762` 只有 `rateLimit` 没有并发闸门 | 并发发起 50 个 `download-url` 任务，观察任务表/磁盘临时文件增长 |
| S-5 | `compressorStats`/`compress.js` 的 `readFileSync`（`:157`）在静态资源热路径上同步读盘，可能被"缓存未命中 + 高并发"放大 | `compress.js:143-160` | 并发请求首屏资源，观察事件循环延迟 |
| S-6 | `metrics` 的 `slowRequests` 里除 token 外还含 `status/ms`，是否足够让超管判断匿名用户行为（隐私面） | `metrics.js:122-129` | 产品口径问题，非缺陷 |

---

## 五、设计取舍（**不计入漏洞**，但请知悉）

| 项 | 说明与依据 |
|---|---|
| **CSRF 只覆盖 `/api`，WebDAV 刻意豁免** | `/dav` 在 `csrfGuard` 之前挂载（`index.js:107` vs `:111`），且**只认 Basic、不认 Cookie**（`webdav.js:287-291`）、拒绝超管（`:308-314`）。HTML 表单发不出 `PUT/DELETE/MOVE/COPY`，浏览器缓存的 Basic 凭据也不会被跨站表单利用。这条边界是**有意为之且已写成注释**（`webdav.js:35`）；唯一遗留是"将来给 DAV 加 Cookie 认证就立刻变成后门"——建议保持现状。 |
| **`GET/HEAD/OPTIONS` 免 CSRF** | 本次逐端点核对了 38 个 `get(`，**没有**任何 GET 会改配置或改文件；`*/status` 只刷新内存时间戳。配合 `SameSite=Lax`（跨站子资源不携带 Cookie）与"POST 才写"的约定，这个豁免是安全的。 |
| **登录锁定只在内存** | `auth.js:147`。重启清零，攻击者可借运维重启刷掉失败计数；同时也是"每隔 10 次失败就能把某个成员锁 5→30 分钟"的 DoS 面（超管路径已通过"先验口令再判锁"规避，`routes/auth.js:47-62`）。已在旧报告 L-5 记录，本次确认仍未改。 |
| **`TRUST_PROXY` 的语义** | 开启后 `req.ip` 取自 XFF 是设计（隧道必须靠它）。真实风险在"既开 TRUST_PROXY 又能直连"的部署，`.env.example`/`env.js:36-40` 已明确警告；当前 `.env` 未开启。本次新增的兜底桶有 A-2 的缺陷，但方向正确。 |
| **无内置 HTTPS / 无 HSTS** | 项目假设"只在可信内网使用"，HTTP 明文是已知且文档化的取舍（`SECURITY-REVIEW.md` 第 5 节）。但**隧道模式会把服务暴露到公网 HTTPS**，此时缺 HSTS（`index.js:77-84` 无 `Strict-Transport-Security`）与 A-5 的 `Secure` 缺失叠加，构成真实的降级面 —— 因此我把它记为"未修的低危"而不是"纯设计"。 |
| **自动生成超管口令并写入 `.env` + 打印控制台** | `env.js:110-126`、`index.js:292-297`。这是"让部署者拿得到口令"的必要动作，但 stdout 可能被日志采集，属于已知取舍。 |
| **`restrictFileMode` 在 Windows 无效** | 见 A-7：本机已用 ACL 兜住，但代码侧仍是 noop。 |
| **`uncaughtException` 不退出** | `index.js:312-318`。可用性优先的明确取舍；副作用是"带着未知坏状态继续跑"，且实际并未记录 stack（见 2.3）——建议顺手修正注释或真的把 stack 落盘。 |
| **`superSessionEpoch` 是全局的** | 超管"登出"会一次性吊销**所有**超管会话（`routes/auth.js:137-141`）。本项目只有一个超管账号，语义正确。 |
| **分享票据可放查询串 `?t=`** | `shares.js:82-89`。票据会进浏览器历史/代理日志；`Referrer-Policy: no-referrer`（`index.js:80`）已挡住 Referer 泄露，属可接受。 |
| **`X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'`** | 两者一致（不是冲突），预览页是同源 iframe，正常可用；未发现"预览被 CSP 拦掉"的回归。 |

---

## 六、给修复排期的建议（按性价比）

| 顺序 | 动作 | 位置 | 成本 |
|---|---|---|---|
| 1 | `change-password` 挂 `rateLimit` + 失败计数（A-1） | `routes/auth.js:98` | 10 分钟 |
| 2 | 日志路径脱敏，去掉分享 token（A-3） | `index.js:71-72`、`metrics.js:124` | 10 分钟 |
| 3 | `evict()` 跳过 `peer:` 桶（A-2） | `ratelimit.js:69-77` | 10 分钟 |
| 4 | `compress.js:139` 包 `try/catch`（旧 L-3）、`restrictFileMode` 加 `icacls` 或启动告警（A-7） | `compress.js:139`、`env.js:15-21` | 20 分钟 |
| 5 | 日志单文件上限 / `login_fail` 聚合（A-4） | `logger.js:73-77` | 30 分钟 |
| 6 | 全局限流 + `body` 解析前限流（A-8 + 旧 L-1） | `index.js:117`、`ratelimit.js` | 1 小时 |
| 7 | Cookie `Secure` 与 `trustProxy` 对齐 + 补 HSTS/COOP/CORP（A-5 + 旧 L-4） | `auth.js:41`、`index.js:77-84` | 30 分钟 |
| 8 | 超管登录补 dummy bcrypt 拉平时序（A-6）；建议把 S-1~S-4 补进 `security-test.ps1` 成为回归项 | `routes/auth.js:54-62` | 30 分钟 |

---

*本报告只读完成：未启动服务、未修改任何源码/配置/数据。唯一写入物是本文件（`.audit/security-auth.md`）。所有行号对应本次审计时的源码快照。*
