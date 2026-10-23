# ZeroShadow 安全审计报告

- 审计对象：`D:\编程\Wangyq EPan 网盘\EPan`（v1.1.2，Node + Express + React）
- 审计范围：`server/src/**`、`server/index.js`、`web/src/**`、`web/public/robustness/**`、依赖库关键实现
- 审计方式：完整读取全部后端源码（约 6.5k 行）与前端源码；对 5 项关键结论**在隔离副本中实际复现**（未触碰真实 `data/`）
- 结论：**发现 4 个高危（1 严重 + 3 高，含 2 个已验证的越权/信息泄露）、5 个中危、若干低危**。整体安全设计水准较高（路径校验、SSRF 防护、CSRF、原子写都做得比同类项目好），但访问控制有一处**成体系的遗漏**。

> **阅读提示（2026-10 更新）**
>
> - 本报告的**审计基准是 v1.1.2**，此后项目又发布了 v1.2.1 与 v1.2.3，当前版本是 **v1.2.4**。
>   因此下表里"保留"的结论**不等于今天仍然成立** —— 有 4 项已在 v1.2.3 被修掉，见每条状态列后的
>   `（v1.2.3 已闭合）` 标注。
> - v1.2.3 的"第二轮安全审计"目前**只有 [CHANGELOG](CHANGELOG.md) 里的摘要**（安全 /
>   行为变化两组），没有一份独立的逐条报告。要追溯某项结论，请以 CHANGELOG 为准。
> - 文中出现的 `fs.js:1143`、`safety.js:140` 这类行号是 **v1.1.2** 的行号，与当前源码已不对应；
>   按函数名 / 机制名搜索更可靠。
> - 本文件自身的编号已修正（此前有两个「## 二」导致后续章节整体错位一位）。

---

## 一、结论摘要

> **状态说明**：`已修` = 本次已改代码，`保留` = 有意不改（附理由）。修复详情与验证结果见第二节。

| # | 严重度 | 问题 | 位置 | 状态 |
|---|--------|------|------|------|
| 1 | **严重** | 「对访客隐藏」目录可被绕过：未登录访客能**读取**其中的文本文件，开启访客写权限后还能**覆盖**其中文件 | `routes/fs.js:1143`、`:1193` | ✅ 已修（实测通过） |
| 2 | **高** | 只读映射 `"./"`（模板默认示例）会把 `.env`（超管明文密码）与 `data/.jwt-secret`（会话签名密钥）暴露给**匿名访客** | `env.js:45`、`fs.js:226`、`safety.js:140` | ✅ 已修（实测通过） |
| 3 | **高** | 登录锁定表可被未授权请求无限撑大（内存耗尽）；`/api/auth/login` 无任何限流 | `auth.js:139-171` | ✅ 已修 |
| 4 | **高** | 在线保存的「不可映射字符」检测是 O(n²)，单个 16MB 请求可让整个服务卡死数十分钟 | `encoding.js:286-289`、`fs.js:1226` | ✅ 已修（实测 100× 提速） |
| 5 | 中 | 解压信任 zip 头里**攻击者可控**的声明大小，且先把整条目读进内存再判断 → zip 炸弹 OOM | `fs.js:1083-1095` | ✅ 已修（实测内存有界） |
| 6 | 中 | `data/*.json` 带 UTF-8 BOM 会被当成「损坏」隔离，并静默回退**默认配置**（隐藏目录设置清空、成员账号消失） | `store.js:18-24`、`integrity.js:41-59` | ✅ 已修（实测通过） |
| 7 | 中 | 日志导出 CSV 公式注入（未登录的登录名直接进 `user` 列） | `logger.js:161-165`、`routes/auth.js:62` | ✅ 已修 |
| 8 | 中 | 限流桶 `MAX_TRACKED_IPS` 上限无效；开启 `TRUST_PROXY` 后限流可被 `X-Forwarded-For` 完全绕过 | `ratelimit.js:40-44`、`env.js:92-103` | ✅ 上限已修；`TRUST_PROXY` 语义保留（见第二节说明） |
| 9 | 中 | 回收站失败（含路径 >1024 字符）会**静默降级为彻底删除** | `trash.js:89` ↔ `fs.js:713-722` | ✅ 已修（改为跳过并报错） |
| 10 | 低 | WebDAV `MOVE/COPY` 的自嵌套检查大小写敏感，与 `fs.js` 不一致 | `webdav.js:421` | ✅ 已修 |
| 11 | 低 | 无 `realpath` 校验：`FILES_DIR` 中间层符号链接可越出根目录 | `safety.js:35-60` | 保留（理由见第二节）→ **v1.2.3 已闭合**（`resolveAny` 改用 `realpathSync.native`） |
| 12 | 低 | 回收站还原参数非法时返回 200 假成功 | `trash.js:192-196` ↔ `admin.js:468` | ✅ 已修（实测返回 400） |
| 13 | 低 | 损坏文件「绝不直接删除」的承诺被 `rmSync` 兜底打破 | `integrity.js:31-38` | ✅ 已修 |
| 14 | 低 | 备份回滚不校验 JSON 顶层类型、不重置 0600 权限 | `backup.js:188-202` | ✅ 已修 |
| 15 | 低 | 删除成员/小组会把其**私有** Todo 改成「全体可见」 | `todos.js:134-166` | ✅ 已修（改为保留可见性、清空关联） |
| 16 | 低 | 任何普通成员都能通过 `/api/groups` 拿到全站账号名册 | `routes/groups.js:68` | 保留（团队页指派需要，属设计取舍）→ **v1.2.3 已收紧**（`allMembers` 只给超管与被授权组长） |
| 17 | 低 | 小组上下文**替换**而非取交 `defaultVisibility`；组长可清空本组白/黑名单 | `groups.js:302-307` | 保留（改动会变更可见性语义，需产品确认）→ **v1.2.3 已改**（缺省上下文权限取交集、可见范围取并集；`manageVisibility` 只能收窄） |
| 18 | 低 | 热路径同步 `appendFileSync`；控制台日志行可被换行注入 | `logger.js:52-75` | ✅ 换行已修；同步写在第二节说明为何保留 |
| 19 | 低 | 轮询可无限延长任务及其资源寿命 | `jobs.js:6-24,48-53` | 保留（实际影响有限，见第二节） |
| 20 | 低 | `dirStats` 缓存无 single-flight（仅超管可触达） | `status.js:26-29`、`metrics.js:68-79` | 保留 |
| 21 | 低 | 日志导出一次性读入内存（仅超管可触达） | `logger.js:99-131` | 保留 |
| 22 | 低 | `rename` 失败的兜底存在短暂"目标不存在"窗口 | `store.js:44-49` | 保留（有快照兜底） |

前端缺陷（第六节）：粘贴/上传重入、`handleUpload` 依赖、头像串号、回收站按钮 busy 失效、`truncated` 提示数字 — **均已修**；`editor-page` 快捷键 effect、`format.ts` 的 `.gitignore` 两项经复核**不属于缺陷**（见第六节说明）。

---

## 二、修复记录与验证

### 2.1 改动的文件（20 个）

**服务端（15）**
| 文件 | 修复内容 |
|------|----------|
| `routes/fs.js` | `assertContextVisible()` 内统一执行 `guestBlocked()`（#1）；软目录列表过滤服务自身文件（#2）；新增 `readZipEntryLimited()` 流式限额并在总量里计入"被跳过的条目"（#5）；删除时区分"回收站不可用"与"这一项入站失败"（#9） |
| `safety.js` | 新增并导出 `isSensitiveAbs()`，`resolveAny()` 的软目录分支命中 `.env` / `data/**` 时按 404 处理（#2） |
| `env.js` | 导出 `ENV_FILE` / `SECRET_FILE`；模板里的 `"./"` 示例换成安全的路径并加警告（#2）；`.env` 解析剥掉 BOM（否则首行的 `PORT=…` 会被忽略） |
| `encoding.js` | 不可映射字符检测从 `back.includes(ch)` 改为 `Set` 查表，并补上 `break`（#4） |
| `auth.js` | `loginLocked()` 改为只读查询（不再为任意用户名创建条目）；新增 `evictOldest()` 做真正的有界淘汰（#3） |
| `ratelimit.js` | 新增 `evict()`：超限时按窗口起点淘汰，而不是只删已过期条目（#8） |
| `routes/auth.js` | `/login` 挂上 `rateLimit`（#3） |
| `trash.js` | 入站失败改为 **throw**（带 `code: TRASH_FAILED`）而不是返回 null；`MAX_REL_LEN` 1024 → 4096；`restoreTrash` 的 `return err` 改为 `throw`（#9、#12） |
| `store.js` | `readJsonSync()` 剥掉 BOM（#6） |
| `integrity.js` | `checkFile()` 剥掉 BOM；`quarantine()` 失败时**保留原文件**并如实上报（#6、#13） |
| `logger.js` | `csvCell()` 对 `= + - @ TAB CR` 开头的值加前导单引号（#7）；控制台日志行清洗换行（#18） |
| `backup.js` | 回滚前校验顶层类型，恢复后调 `restrictFileMode()`（#14） |
| `todos.js` | 删除成员/小组时不再把私有 Todo 改成「全体」（#15） |
| `webdav.js` | 自嵌套判断改用大小写不敏感的 `isSameOrInside()`（#10） |
| `.env.example` | 同步软目录映射的安全警告（#2） |

**前端（5）**
| 文件 | 修复内容 |
|------|----------|
| `pages/browser-page.tsx` | 粘贴重入标志移到 `doPaste` 入口并在所有分支释放（含冲突对话框往返期间）；`handleUpload` 增加同款重入保护；依赖数组补 `existingDirNames` |
| `components/browser/dialogs.tsx` | 处理 `/fs/delete` 新增的 `failed[]`，明确提示"这些条目未删除、原文件保留" |
| `lib/avatar-cache.ts` | `useAvatar` 把 URL 与 owner 一起存放，owner 变化时立即失效，不再短暂显示上一个成员的头像 |
| `pages/settings/trash-section.tsx` | `busy` 标记改成 `await confirm(...)` 后才复位，按钮 `disabled` 真正生效 |
| `state/uploads.tsx` | 按 `results.length` 与实际批次差计算被丢弃的文件数，提示数字与结果一致 |

### 2.2 验证方式与结果

| 验证 | 结果 |
|------|------|
| 自建 32 项针对性验证（越权读写、软目录泄露、BOM、zip 炸弹、回收站、正常读写回归） | **32 / 32 通过** |
| 第二轮 13 项敏感路径验证（含 `FILES_DIR=项目根`、`FILES_DIR=data` 两个边界配置） | **13 / 13 通过** |
| 项目自带 `security-test.ps1`（19 组安全不变量） | **94 / 94 通过**（另有 2 项"读取前端源码"的 iframe 断言因测试树只放了 `dist` 而跳过；这两项在完整树上通过，且本次未改动相关源码） |
| 项目自带 `smoke-test.ps1`（14 组、65 项功能回归） | **64 通过 / 1 失败** —— 见下方说明 |
| `pnpm -C web typecheck` | 通过 |
| `pnpm -C web lint` | 0 error / 4 warning（与改动前的基线**完全一致**） |

关键实测数据：

- **#1**：`GET /api/fs/file?path=secret/topsecret.txt` 由 `200 + 正文` 变为 `404`；`POST /api/fs/save-file` 同样 `404`，磁盘文件保持原内容（改动前该请求会成功覆盖）。
- **#2**：`GET /api/fs/download?path=项目根/.env`、`…/data/.jwt-secret`、`…/data/config.json` 全部 `404`，而软目录里的普通文件仍可 `200` 下载。
- **#4**：`encodeText` 相同输入 **2,641 ms → 27 ms**（192,000 字符），120 万字符 138 ms，恢复线性。
- **#5**：构造「声明 1000 字节、实际 300MB ×2」的 zip，任务报 `解压后总大小超出限制 (32MB)`，写出 0 字节，半成品目录被清理，**进程 RSS 峰值增量仅 5MB**（改动前会把 600MB 全量缓冲）。
- **#6**：带 BOM 的 `config.json` 不再被隔离（`backups/corrupt/` 为空），且 `guestHiddenPaths` 生效（隐藏目录仍 404）。

**关于 `smoke-test.ps1` 的 1 项失败**：`robustness-entry-on-home` 断言"首页 HTML 里含 `/robustness/index.html` 链接"。但该链接由 React 在 `login-page.tsx:101` / `browser-page.tsx:1134` 渲染，而 `web/dist/index.html` 只有 `<div id="root">`（已 grep 确认不含该字符串）。**这是测试脚本自身的断言错误，不是应用缺陷，也与本次改动无关**（我没有改 `index.html`、`login-page.tsx`、`app-shell.tsx`）。建议把断言改为在构建产物 JS 里查找，或改为验证 `/robustness/index.html` 可访问（后者已通过）。

### 2.3 有意保留的问题与理由

- **#8 的 `TRUST_PROXY` 语义**：开启后 `req.ip` 来自 `X-Forwarded-For` 是**设计如此**（隧道/反代场景必须靠它拿真实 IP），`.env.example` 已明确警告"仅在服务只经可信代理暴露时开启"。本次只修了"上限无效"，未改语义。若你的部署里服务既可能被直连、又开了 `TRUST_PROXY`，建议改为只填具体网段（如 `TRUST_PROXY=loopback`）或关闭。
- **#11 无 `realpath` 校验**：`resolveAny()` 是纯词法校验，中间层符号链接理论上可越出根目录。但**网盘接口本身无法创建符号链接**（`copyEntry` 用 `verbatimSymlinks` 且 `mergeFolder` 跳过链接、`entryInfo`/`assertExists` 都拒绝链接），需要有人在服务器本机手动放一个链接；而正确实现 `realpath` 校验要处理"目标尚不存在"的写路径、Windows 8.3 短名与 junction，回归风险高于收益。建议作为后续加固项单独做。
- **#16 成员名册**：`/api/groups`、`/api/todos` 向所有成员返回账号列表，是"指派待办/查看组员"功能所必需。若你认为用户名也算敏感信息，可按 `leaderCaps.viewMembers` 裁剪。
- **#17 默认可见范围**：改动会实质变更可见性语义（可能让现有用户看到的内容变少或变多），需要你先确认期望行为再改。
- **#18 同步日志写**：`appendFileSync` 在热路径上确实会阻塞，但改成异步会打乱日志顺序、并让"进程被杀时最后几行丢失"的概率上升（这是本项目排查问题的关键线索）。当前只修了确定是漏洞的换行注入。
- **#19~#22**：均为仅超管可触达或影响可控的资源占用/健壮性问题，改动收益小、回归面大，建议按需处理。

### 2.4 第二轮复查中对自己的修正（"再检查检查"的收获）

第一轮修完 #2 后，我按"最坏配置"逐个回推，发现**自己的修复留了一个洞**，已一并修正：

1. **拦截只加在了软目录分支上**。`isSensitiveAbs()` 最初只作用于 `resolveAny()` 的 `isSoft` 分支，于是当有人把 `FILES_DIR` 设成**项目根目录**时（`.env` 与 `data/` 都落在"网盘里"），`.env`、`data/config.json`、`data/users.json`、`data/logs/**` 仍然可以被下载 —— 实测确认（`.env → 200`）。现已在网盘本体分支同样拦截，并让 `/list` 过滤掉这些条目。
2. **判定规则改成"相对 `DATA_DIR` 的第一段名字"**，与 `FILES_DIR` 放在哪里无关，避免"`FILES_DIR` 包含 `DATA_DIR`"或"`FILES_DIR` 就是 `DATA_DIR`"这类布局下的漏判。
3. **`data/` 目录本身仍然放行**：如果部署者把 `FILES_DIR` 直接设成 `data/`（文件就放在配置旁边），把 `data/` 整个挡掉会让网盘变空。现在只挡它里面的凭据/运行数据条目，其余内容照常可见。

两个边界配置的实测结果：

| 配置 | 结果 |
|------|------|
| `FILES_DIR` = 项目根 | `.env`、`data/.jwt-secret`、`data/config.json`、`data/users.json` → 全部 404；`data/` 列表只剩 `files`；网盘内容与 `data/files/**` 正常 |
| `FILES_DIR` = `data` | 根目录可正常列出（只剩 `files`、用户自己的文件夹），凭据条目不出现在列表里且下载 404，用户自己的文件夹/文件正常 |

另外顺带修掉一处同类根因：`env.js` 解析 `.env` 时不剥 BOM —— 用记事本/PowerShell 5.1 保存的 `.env`，**首行会被当成键名 `\uFEFFPORT` 而失效**，用户写了 `PORT=xxxx` 却跑在默认端口上。


## 三、高危问题详情

### 【严重】#1 「对访客隐藏」目录被越权读取/写入

`guestHiddenPaths` 是"把某个文件夹对访客隐藏"的唯一机制（`groups.js:305` 明确写了访客**不**套用小组可见范围，只走 `guestHiddenPaths`）。但各个端点对它的调用**不统一**：

- `/list`（`fs.js:193`）、`/download`（`fs.js:232`）、`/search`（`fs.js:879`）、`/zip`（`fs.js:289`）都显式调用了 `guestBlocked()` / `isHiddenFromGuest()`；
- **`/file`（在线编辑读取，`fs.js:1143`）和 `/save-file`（`fs.js:1193`）只调用了 `assertContextVisible()`，而它在 `groups.js:305` 对访客**无条件返回 `true`**。

于是"隐藏"对这两个端点形同虚设，且 `/file` 只需要 `browse` 权限——**默认配置下访客就有**。

**实测（隔离副本，`guestHiddenPaths: ["secret"]`，全程无 Cookie / 未登录）**：

```
GET /api/fs/list?path=secret               → 404       ← 列表正确地隐藏了
GET /api/fs/search?q=topsecret             → []        ← 搜索正确地隐藏了
GET /api/fs/download?path=secret/topsecret.txt → 404   ← 下载正确地隐藏了
GET /api/fs/file?path=secret/topsecret.txt → 200       ← 越权！正文全文返回
    {"path":"secret/topsecret.txt", ... "content":"SECRET-CANARY-CONTENT-12345\n", ...}
```

开启访客写权限后（`guestPerms.editFiles=true`），写入同样被绕过：

```
POST /api/fs/save-file  {"path":"secret/topsecret.txt","content":"PWNED-BY-GUEST",...}
  → 200 {"ok":true,"bytes":14,...}     磁盘文件内容确实被改成 PWNED-BY-GUEST
  而此时 GET /api/fs/list?path=secret 仍是 404
```

**影响**：任何能访问服务的匿名用户（局域网内任意设备、或隧道暴露后的公网用户），只要知道/猜到隐藏目录里的文件名，就能读取其中所有文本文件；若管理员开了访客编辑、压缩、解压、链接下载权限，还能在隐藏目录里写入/覆盖/落脚文件。此外 `/api/fs/file` **没有挂 `rateLimit`**，可被用来高速枚举探测路径。

**修复**（一行即可闭环，建议改在公共入口）：

```js
// server/src/routes/fs.js
function assertContextVisible(req, rel) {
  if (guestBlocked(req, rel)) {            // ← 新增：访客隐藏对**所有**端点统一生效
    const err = new Error("文件或目录不存在"); err.status = 404; throw err
  }
  if (!contextVisible(req, rel)) { ... }
}
```
并给 `/file` 补 `rateLimit`。`/list`、`/download` 里已有的显式 `guestBlocked` 调用可保留（幂等）。

---

### 【高】#2 只读映射 `"./"` 会把 `.env` 和 `data/.jwt-secret` 交给匿名访客

`env.js:45` 在自动生成的 `.env` 模板里给出的示例是：

```
# FILES_SOFT_DIR={"软件文件夹":"./","工作目录":"D:/Program/xxx/xxx"}
```

`"./"` 就是**项目根目录**，而项目根目录下有 `.env`（超管明文密码）和 `data/.jwt-secret`（签发会话 JWT 的密钥，拿到即可伪造任意登录态）。映射成"只读虚拟目录"后：

- 该软目录**默认对访客可见**（`fs.js:214` 只在 `guestHiddenPaths` 命中时才隐藏软目录名）；
- `/download` 对访客只检查 `guestBlocked`，`guestPerms.downloadFile` 默认 `true`；
- 代码里唯一的缓解 `blockSoftCopyOut()（fs.js:81）只拦"复制进网盘"，不拦下载。

**实测（`FILES_SOFT_DIR={"项目根":"."}`，未登录）**：

```
GET /api/fs/list?path=                     → 200，条目里出现 "项目根"（softReadOnly, hiddenFromGuest:false）
GET /api/fs/download?path=项目根/.env          → 200  明文正文（含 SUPER_ADMIN_PASSWORD）
GET /api/fs/download?path=项目根/data/.jwt-secret → 200  64 位会话签名密钥
```

**影响**：匿名用户直接拿到超管密码与会话签名密钥 → 完全接管（伪造任意成员/超管 Cookie）。虽然需要管理员按模板填了 `"./"`，但这是**模板主动推荐**的写法，属于默认引导导致的真实风险。

**修复**（建议三选多）：
1. 模板示例改成不会泄露的路径，并加醒目警告；
2. 启动时拒绝把包含 `DATA_DIR` / `.env` 的目录注册为软目录（或自动排除 `.` 开头段与 `data/`）；
3. 软目录列表与下载统一过滤"点开头的文件/目录"，并在 `/download` 里对软目录同样套用 `guestBlocked`（现状已套用，但软目录默认不隐藏）。

---

### 【高】#3 登录锁定表可被未授权请求无限撑大

```js
// auth.js:139-147
export function loginLocked(ip, username) {
  const byIp = bucket(`ip:${ip}`)
  const byUser = bucket(`user:${String(username).toLowerCase()}`)   // ← 每次都创建条目
  ...
}
// auth.js:167-171（唯一清理点，在 recordLoginFail 内）
if (attempts.size > 5000) { for (const [k, v] of attempts) { if (已过期) attempts.delete(k) } }
```

- `bucket()` 找不到就**新建**，所以每次登录请求都会为任意用户名建一个 `user:<name>` 条目；
- `/api/auth/login` **没有挂 `rateLimit`**，用户名只校验长度（≤64，`routes/auth.js:33`），字符集不限；
- IP 被锁后 `routes/auth.js:39` 直接 429 返回，**永远不会走到 `recordLoginFail`**，清理逻辑也就永远不会执行；
- 清理条件 `attempts.size > 5000` 后面又只删"已过期"的条目，新条目一个都不删 —— 这个"上限"实际不存在。

**影响**：攻击者先用 30 次失败锁掉自己的 IP，然后持续发送不同用户名的请求，每个请求永久新增一个 Map 条目（键最长 64 字符 + 一个对象，约 200~300 字节）。约百万级请求可吃掉数百 MB 内存，且不会释放。

**修复**：`loginLocked` 改为**只读查询**（不创建条目）；设真正的 LRU 上限（超限时删最旧）；给 `/api/auth/login` 挂一个比通用限流更严格的限流器。

---

### 【高】#4 `encodeText` 的不可映射字符检测是 O(n²)，单请求可卡死服务

```js
// encoding.js:286-289
if (back.length !== text.length) {
  // 长度都变了（通常是被折叠成单字节），整体标出来
  for (const ch of text) if (!back.includes(ch)) bad.add(ch)   // ← O(n·m)，且没有 break
}
```

上面第一个循环有 `if (bad.size >= 32) break`（第 284 行），**这个循环没有**。当 iconv 往返后长度变化（目标编码表示不了某些字符时必然发生，例如把含 emoji 的文本存成 Big5/GBK/Shift_JIS）时，会对全文每个字符做一次 O(len) 的 `includes`。

**实测（直接调用真实函数 `encodeText`，`server/` 下用 Node 执行）**：

| 输入 | 输出 | 耗时 |
|------|------|------|
| 96,000 字符（中文 + emoji，→ big5） | — | 576 ms |
| 192,000 字符（同上） | — | 2,641 ms |
| 4 MB emoji（→ big5，复审复核） | — | **> 90 s 仍未结束（手动终止）** |

输入翻倍耗时约 4.6 倍 → 干净的超线性/二次增长。`POST /api/fs/save-file` 的 body 上限是 **16MB**（`fs.js:1131`），任何有 `editFiles` 权限的成员（默认开启）都能一次请求让 Node 单线程阻塞几十分钟 —— 局域网内所有人同时断线；而那个 400「无法用该编码表示」的提示是在烧完之后才返回的。

**修复**：

```js
const present = new Set(back)
for (const ch of text) { if (!present.has(ch)) bad.add(ch); if (bad.size >= 32) break }
```
或只抽样扫描文本头部（与 `scoreCandidate` 一致的做法），并补上 `break`。

---

## 四、中危问题详情

### #5 解压信任 zip 头声明的大小，且先整块读入内存 → zip 炸弹

```js
// fs.js:1083-1095
if (file.uncompressedSize > limits.maxSingleBytes) continue   // ← 这是中央目录里的声明值，攻击者可控
const buf = await file.buffer()                               // ← 先整块读进内存
if (buf.length > limits.maxSingleBytes) continue               // ← 检查发生得太晚
written += buf.length
if (written > limits.extractMaxTotalBytes) throw ...
```

`directory.files[i].uncompressedSize` 来自 zip 的中央目录记录（`unzipper/lib/Open/directory.js:198`），可以随便伪造；而 `BufferStream` / `file.buffer()`（`unzipper/lib/BufferStream.js:5-8`）是**无上限地把所有分片累积起来再 `Buffer.concat`**，峰值内存约为解压后体积的 2 倍。

**实测**：构造一个中央目录声明 `uncompressedSize = 1000` 的单条目 zip（40,885 字节，实际解压 41,943,040 字节），普通成员调用 `/api/fs/extract`：

```
"state":"done","processedBytes":41943040
解压产物: bomb/bomb.bin = 41943040 字节        ← zip 里声明的是 1000 字节
```

即：**所有基于 `uncompressedSize` 的体积限制（单文件 50MB、总量 512MB）都可以被一个 40KB 的文件绕过**。deflate 的极限压缩比约 1032:1，理论上一个 ≤128MB（`extractMaxZipMB` 上限）的 zip 可以膨胀到几十 GB —— 由于是"先缓冲、后判断"，结果不是"被拒绝"，而是 **Node 内存耗尽/进程被 OOM 杀掉**。

**修复**：不要用 `file.buffer()`，改成 `file.stream()` 边解压边累计字节数、超过上限立刻 `destroy()`；判断值只用**实际写出的字节数**，永远不要用 zip 头里的声明值。

---

### #6 `data/*.json` 带 BOM 会被隔离 + 静默回退默认配置

```js
// store.js:18-24
export function readJsonSync(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return fallback }
}
// integrity.js:44-58
const value = JSON.parse(fs.readFileSync(abs, "utf8"))   // 带 BOM 会抛
...
quarantine(name)      // → fs.renameSync 到 data/backups/corrupt/
```

`JSON.parse` 不接受开头的 U+FEFF，所以**用记事本"UTF-8 带 BOM"或 PowerShell `Set-Content -Encoding utf8` 保存过的配置会被判定为"损坏"**：文件被移走，程序以默认值启动，并立刻写回一份新的默认文件。

**实测**：我把 `data/config.json` 用 `Set-Content -Encoding utf8`（PowerShell 5.1 默认带 BOM）写出后启动服务，结果：

```
data/backups/corrupt/2026-10-07T03-45-01-081Z-config.json   ← 原文件被隔离
运行中的配置 = 全默认值（guestHiddenPaths 变成 []，隐藏目录对访客恢复可见）
```

**影响**：
- `config.json`：权限、上传上限、`guestHiddenPaths`（安全设置）全部静默回默认 —— **隐藏目录会重新对访客可见**；
- `users.json`：**全部成员账号消失**（成员无法登录），数据只在 `backups/corrupt/` 里；
- `groups.json` / `todos.json`：小组与待办全部"丢失"。

**修复**：读取前剥离 BOM，例如

```js
const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
```
`store.js` 与 `integrity.js` 两处都要改（`writeJsonAtomic` 本身不写 BOM，触发条件只来自外部编辑/恢复备份）。

---

### #7 日志导出 CSV 公式注入

```js
// logger.js:161-165
function csvCell(value) {
  const s = value == null ? "" : String(value)
  if (!/[",\r\n]/.test(s)) return s      // ← 没有处理开头的 = + - @ 与制表符
  return `"${s.replace(/"/g, '""')}"`
}
// routes/auth.js:62（未登录即可触达，用户名只校验长度）
warn("login_fail", { msg: "用户名或密码错误", user: username, ip: req.ip })
```

未登录的攻击者用 `username = "=cmd|'/C calc'!A0"` 反复触发登录失败，该字符串会进入日志的 `user` 字段，并在超管执行「日志导出 → CSV」后出现在**单元格开头**。Excel / LibreOffice / Google Sheets 都会把以 `=` 开头的单元格当公式执行（DDE 可导致命令执行），加引号并不影响 Excel 求值。成员侧也可通过文件名植入（`validateName` 允许 `= + - @`，`safety.js:95`）。

**修复**：`csvCell` 里对以 `= + - @ \t \r` 开头的值加前缀（如 `'`）后再引用；同时给登录用户名加字符集白名单。

---

### #8 限流桶上限无效；`TRUST_PROXY` 下限流可被完全绕过

```js
// ratelimit.js:40-44
if (buckets.size > MAX_TRACKED_IPS) {
  for (const [k, v] of buckets) { if (now - v.windowStart >= WINDOW_MS) buckets.delete(k) }
}
```

只删"窗口已过期"的条目，而计数刚被写入的是新条目，所以 Map 可以无限超出 5000。更关键的是：当按 `.env.example` 的推荐开了 `TRUST_PROXY`（隧道场景）后，`req.ip` 来自 `X-Forwarded-For`（`app.set("trust proxy", true)` 时取最左侧、即客户端自报值），攻击者每次伪造一个 IP 就得到一个全新的计数窗口 → **限流完全失效**，同时内存无上限增长。

**修复**：超限时按插入顺序淘汰最旧条目；限流键不要用可伪造的头（用 `req.socket.remoteAddress`，或仅在确有可信代理时才用 `req.ip`）。

---

### #9 回收站失败会静默降级为彻底删除

`moveToTrash` 的契约是"失败返回 null，调用方应中止删除"（`trash.js:84`），但它在多种情况下返回 null：路径 > `MAX_REL_LEN`(1024)（`trash.js:89`）、`lstat` 失败、`mkdir/rename` 失败、回收站目录不可用。而调用方：

```js
// fs.js:713-722
const meta = await moveToTrash(resolved, actor(req))
if (meta) { trashed.push(resolved.rel); continue }
failedToTrash.push(resolved.rel)
await fs.promises.rm(resolved.abs, { recursive: true, force: true })   // ← 永久删除
```

**影响**：在 Windows（启用长路径后）或 Linux 上，超过 1024 字符的深层路径会被**永久删除**，而 UI 与文档承诺的是"删除 = 进回收站"。响应里虽然回了 `permanentlyDeleted`，但内容已经没了。

**修复**：区分"无法入回收站"与"无需入回收站"，前者应中止该项并报错，而不是回落到 `rm`。

---

## 五、低危问题

| # | 位置 | 问题与修复 |
|---|------|-----------|
| 10 | `webdav.js:421` | 自嵌套检查 `destRel === resolved.rel \|\| destRel.startsWith(resolved.rel + "/")` 是**大小写敏感**的裸串比较，而 `fs.js` 用的是大小写不敏感的 `isSameOrInside()`。Windows 下把 `/A` COPY/MOVE 到 `/a/x` 能绕过检查（结果是 rename 到自身子目录而报错，非数据丢失）。统一改用 `isSameOrInside()`。 |
| 11 | `safety.js:35-60` | `resolveSafe`/`resolveAny` 只做**词法**边界校验，没有 `realpath`。`/api/fs/file`（`fs.js:1145`）用的是会跟随符号链接的 `fs.promises.stat`，所以 `FILES_DIR` 里存在指向外部（或中间层是指向外的 junction/symlink）时即可越出根目录。列目录/`assertExists` 都刻意 lstat 拒了**末级**符号链接，说明作者有意防护，但中间层没查。建议对已存在路径做 `realpath` 后再比较边界。 |
| 12 | `trash.js:192-196` ↔ `admin.js:468` | `restoreTrash` 在 `!dest.rel` 时 `return err` 而不是 `throw`，调用方只判断 `result.conflict`，于是 `POST /api/admin/trash/restore {id, dest:""}` 返回 `200 {ok:true}` 但什么都没还原。改成 `throw err`。 |
| 13 | `integrity.js:31-38` | 文件头承诺"绝不直接删除"，`catch` 里却 `fs.rmSync(src)` 兜底。若 `data/backups` 不可写/被占用，损坏的 `users.json`（往往还能人工抢救）会被直接删掉。建议 rename 失败就保持原样并记一条 issue。 |
| 14 | `backup.js:188-202` | 回滚前只 `JSON.parse` 不校验顶层类型（`integrity.js:46-52` 有校验），且不像 `writeJsonAtomic` 那样调 `restrictFileMode`，POSIX 下恢复出来的 `users.json`（含 bcrypt 哈希）权限变成 0644。 |
| 15 | `todos.js:134-166` | 删除成员时把其 `scope:"member"` 的私有 Todo 改成 `scope:"all"`，删除小组时把组 Todo 改成 `"all"` —— **私有待办会突然变成全员可见**。建议改为标记孤立/隐藏，而不是公开。 |
| 16 | `routes/groups.js:68` | `GET /api/groups` 对**任何**成员返回 `allMembers: listMembers()`（全站账号 id/用户名/创建时间），不受 `leaderCaps` 约束。`/api/todos` 同理。若认为账号名册属于敏感信息，应按 `viewMembers` 裁剪。 |
| 17 | `groups.js:302-307` + `routes/groups.js:118-119` | 成员一旦选中某个小组，可见性就**只**按该小组的白/黑名单计算，`config.defaultVisibility.blacklist`（"始终隐藏"）不再生效；且组长通过 `PATCH /api/groups/:id {whitelist:[],blacklist:[]}` 可清空本组名单从而放宽可见范围。建议 defaultVisibility 与小组名单取**并集/交集**而非替换。 |
| 18 | `logger.js:52-75` | 热路径上的同步 `fs.appendFileSync`；且 `details.user` 未做换行清洗就拼进控制台行（`line 72`），未校验的登录名可伪造 stdout 日志行（磁盘 JSON 行是安全的，`JSON.stringify` 会转义）。 |
| 19 | `jobs.js:6-24,48-53` | `getJob/jobStatus` 会刷新 `updatedAt`，轮询可无限延长任务及其资源寿命；`sweep` 只清"闲置 ≥10 分钟"的。建议加绝对 TTL（`createdAt + 硬上限`）与每用户任务数上限。 |
| 20 | `status.js:26-29`、`metrics.js:68-79` | 30s / 5min 缓存没有 single-flight，并发请求会各自触发一次全量递归 `dirStats`（仅超管可触达，但可自伤）。缓存 in-flight Promise 即可。 |
| 21 | `logger.js:99-131` + `admin.js:331-337` | 导出走 `unlimited: true`，最多 90 天日志一次性读进内存再序列化。建议逐行流式输出。 |
| 22 | `store.js:44-49` | `rename` 失败的兜底是"先 rm 再 rename"，中间存在目标文件不存在的窗口。有快照兜底，影响有限。 |

---

## 六、前端缺陷（`web/src`）

| 严重度 | 位置 | 问题 |
|--------|------|------|
| 中低 | `pages/browser-page.tsx:289-347` | `pastingRef` 的检查（319 行）与置位（334 行）之间隔着 `resolveConflicts` 的冲突对话框往返：冲突对话框打开期间再次 Ctrl+V 会替换掉待处理的回调，对话框确认后才检查重入标志 → 可能发出重复的 `POST /fs/copy`（服务端 `uniqueName` 会生成 `x (1)` 副本）。另外 `handleUpload` 完全没有重入保护。建议在 `doPaste` 入口就置位、在 `finally` 与取消分支复位。 |
| 中低 | `pages/browser-page.tsx:391-404`、`:498` | `resolveConflicts` 只依赖 `[existingNames]`，但文件夹上传路径传入的是 `existingDirNames`（442 行），`handleUpload` 的依赖数组也漏了它 → 冲突分类可能用过期集合（把"已存在同名文件夹"当成文件冲突，只能"覆盖"而不能"合并"）。 |
| 低 | `lib/avatar-cache.ts:216-230` | `owner` 变化时不会同步清空 `url`，要等 `getAvatarUrl()` 异步返回才 `setUrl`。表现是**短暂**显示上一个成员的头像（IndexedDB 读取通常几毫秒；因 `tx()` 各分支都 resolve、不会 reject，所以不会永久残留）。把 URL 与 owner 一起放进 state 即可修掉。 |
| 低 | `pages/settings/trash-section.tsx:209-210` | `setBusyId(it.id); doRestore(...); setBusyId(null)` 同一 tick 内完成，`disabled` 永远不生效；另两个按钮压根没设 `busyId`，该 state 实为死代码 → 连点「还原」会弹出两个确认框。 |
| 低 | `state/uploads.tsx:34,104-108` | 服务端返回 `truncated` 时只弹警告，被丢弃的文件不会重传；`okCount` 取自 `results.length`，可能出现"提示已上传 N 个"但实际少了文件。服务端已返回权威值 `maxFilesPerRequest`，客户端应当用它分片。 |
| 低 | `pages/editor-page.tsx:308-323` | 全局 keydown 监听没有依赖数组，每次渲染都移除再添加（每个按键都做一次）。**经复核不改**：当前行为正确（闭包总是最新的），补依赖反而有引入过期闭包的风险，收益仅是省一次 add/removeEventListener。 |
| — | `lib/format.ts:117-140` | **经复核不属于缺陷**：`ext()` 里 `i > 0` 的判断让 `.gitignore`/`.env` 会原样返回（带点），与 `PREVIEWABLE` 的 `.gitignore`/`.env` 成员是匹配的，预览正常。 |
| — | `pages/preview-page.tsx:217` | **降级为提示**：PDF 预览的 iframe 未加 `sandbox`，但服务端对 html/svg 内联响应强制 `CSP: sandbox allow-scripts`（`fs.js:262`），且 html 走的是带 sandbox 的 `/html-preview`。属于"纵深防御可以再加一层"，当前无可利用路径。 |

> 说明：复审时我**推翻**了三个看起来很像 Bug 的结论 —— `navigator.clipboard?.writeText(...).then(...)` 在缺少剪贴板 API 时**不会**抛 TypeError（可选链会短路整条链，已用 Node 实测）；`ColorPicker.commit` 不会无限递归；`format.ts` 的 `.gitignore`/`.env` 预览判断实际是有效的。这三项不计入问题清单。

---

## 七、已验证「做得对」的部分（无需再查）

- **路径穿越**：实测 `../`、`..\`、`/etc/passwd`、`C:/Windows/win.ini`、`%00` 等 7 组 payload 全部被 400/404 拦下；`path.join(FILES_DIR, "C:", ...)` 不会跳出根目录；软目录子路径有 `base + sep` 前缀校验。
- **XSS**：`web/src` 全量 grep 无 `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` / `srcdoc`；两个 HTML 预览 iframe 都是 `sandbox="allow-scripts"`（**没有** `allow-same-origin`）；用户上传的 HTML/SVG 内联时由服务端强制 `CSP: sandbox allow-scripts`（`fs.js:262-264`）；兼容模式页（`web/public/robustness`）所有 `innerHTML` 都过了 `esc()`。
- **SSRF**（`netguard.js`）：先解析域名取全部 A/AAAA、逐个按段判定（含 IPv6 映射/6to4/NAT64/Teredo），再把已校验 IP 固定给 socket（`pinnedLookup`）消除 DNS rebinding，逐跳重新校验重定向，默认拒绝内网。
- **CSRF**：`/api` 全局 `csrfGuard`（要求 `X-Requested-With` + `Sec-Fetch-Site`/`Origin` 同源）；WebDAV **刻意不接受 Cookie**、只认 Basic 且拒绝超管账号（避免 DAV 变成绕过 CSRF 的后门）。
- **密码**：`timingSafeEqual` 比较超管密码；未知用户的 bcrypt 走固定 dummy hash 保持耗时恒定；`bcryptjs` 哈希；成员口令变更/禁用会递增 `tokenVersion` 使旧会话立即失效。
- **原型污染**：`deepMerge` 只遍历 `Object.keys(base)`；`admin.js` 对权限值一律 `!!` 转换，`__proto__` 键写入变成无操作 setter；`SOFT_DIRS` 用 `Object.create(null)`。
- **注入**：`tunnel.js` 用 `spawn("ssh", argv[])`（无 shell）+ 主机名正则（拒绝 `-` 开头）→ 无命令注入；WebDAV XML 输出全部 `xmlEscape`；头像 `owner` 正则 `^[A-Za-z0-9_-]{1,72}$` + 尺寸/格式手写校验。
- **其他**：`data/` 下 `config/users/groups/todos` 均为原子写（临时文件 + rename）且写前快照；`trash` 用 `basename` + `isInsideTrash` 收敛 id；备份回滚把 `name` 限定在 `MANAGED_FILES`、`id` 过 `basename` + `.json` 校验；回收站目录刻意放在 `FILES_DIR` 之外。
- **仓库卫生**：`.env`、`data/`、`.jwt-secret`、构建产物均已 `.gitignore`；`git log --all` 中**从未**提交过 `.env` 或 `data/`（仅 `.env.example` 在库中，内容是占位符）。

---

## 八、复现与审计方法说明

- 所有实测都在**工作区内的隔离副本** `.audit-tmp/` 中进行：复制 `server/index.js` + `server/src`，用自定义 ESM loader 把裸模块解析到 `server/node_modules`，独立 `PORT`/`.env`/`data/`，服务端只监听 `127.0.0.1:5187`。
- **真实的 `data/` 目录未被改动**（其最新写入时间早于本次审计），测试结束后 `.audit-tmp/` 已删除。
- 复现用到的关键命令/脚本思路见上文各节的代码引用与实测输出。
- 唯一的遗留物：`server/.audit-enc-probe.mjs`（审计过程中生成的探针脚本，893 字节）。沙箱禁止我写入 `server/`，因此**无法删除**，请手动执行：
  ```powershell
  Remove-Item "D:\编程\Wangyq EPan 网盘\EPan\server\.audit-enc-probe.mjs"
  ```

## 九、建议的后续动作

1. **重新构建前端**：本次改了 `web/src`（5 个文件），线上仍是旧的 `web/dist`。发布前请 `pnpm build`，否则前端修复（重入保护、头像、回收站按钮、delete.failed 提示）不会生效。
2. **删除审计遗留的探针脚本**（沙箱不允许我写 `server/` 目录，删不掉）：
   ```powershell
   Remove-Item "D:\编程\Wangyq EPan 网盘\EPan\server\.audit-enc-probe.mjs"
   ```
3. **修一下 `smoke-test.ps1` 的 `robustness-entry-on-home` 断言**（见 2.2 说明）。
4. 复查 `.env`：若你开了 `TRUST_PROXY`，确认服务不可能被直连（或改成具体网段）。
5. 可选加固项：`realpath` 边界校验（#11）、`defaultVisibility` 与小组名单取交（#17）、日志异步写入（#18）。
6. 建议给这几项补进 `security-test.ps1` 的固定断言（越权读写、软目录凭据、zip 声明值、BOM 配置），让它们成为长期回归项。
