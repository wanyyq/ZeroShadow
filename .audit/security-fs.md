# 安全审计报告 · 文件系统访问控制与路径安全（FS / 分享 / WebDAV / 压缩 / 回收站 / 缩略图 / 备份）

- **审计对象**：`D:\编程\Wangyq EPan 网盘\EPan`（ZeroShadow / EPan v2.0.0-beta，当前工作区快照）
- **审计方式**：**只读静态审计**。逐行读完本领域 16 个文件（`routes/fs.js` 1796 行、`webdav.js` 926 行、`safety.js`、`files.js`、`shares.js`、`routes/shares.js`、`trash.js`、`thumbs.js`、`avatars.js`、`backup.js`、`netguard.js`、`encoding.js`、`compress.js`、`fileinfo.js`、`groups.js`、`context.js`）；未启动服务、未修改任何源码或数据文件。
- **允许的运行时验证**：仅在 `%TEMP%` 下创建临时目录，用 `node -e` 验证 **Windows 8.3 短名 / 尾点** 在 Node `fs` 层的真实行为（见 F-1 的"机制"与"命中面"两张证据表），测完即删；`icacls` 只读复核 ACL；`Get-ChildItem` 只读核对 `data/files` 与 `.migration-backup`。
- **前序报告**：`SECURITY-AUDIT.md`（21 项）、`SECURITY-REVIEW.md`（M-1~M-3 / L-1~L-9 / D-1~D-8）。本报告先**逐项验证其在我领域的修复状态**，再报新发现。

---

## 一、结论摘要

**没有发现"未登录即可接管"的高危漏洞。** 路径解析确实已经收敛到单一入口（`safety.js:resolveSafe/resolveAny`），`realpath` 规范化、敏感文件拦截、访客隐藏、上传/解压的体量与炸弹防护都做得比前两轮报告所描述的更完整，SSRF 防护（`netguard.js`）质量很高。

但存在**一处可绕过"对访客隐藏"的确认漏洞**，成因是"可见性判定用了未规范化的词法相对路径，而实际读盘用的是规范化后的绝对路径" —— 正是 `safety.js:130-132` 注释里明确禁止的做法。同一类问题在 `webdav.js` 与 `routes/shares.js` 中各有一处。

| 编号 | 严重度 | 一句话 |
|---|---|---|
| **F-1** | **中高**（Windows，匿名可触发） | `/api/fs/zip`（含 `/api/fs/compress`）用**词法** `rel` 判可见性、用**规范化** `abs` 读盘 → 用 8.3 短名（`GSAP-S~1`、`SCREEN~1.PNG`）即可把「对访客隐藏」的目录整包下载给匿名访客 |
| **F-2** | 中低 | `webdav.js` 的 `visible()` 在 `resolveAny()` **之前**执行，同一手法可绕过小组黑名单 |
| **F-3** | 中低 | 分享链接的 `isHiddenFromGuest` / 可见范围快照判定也基于词法 `rel`，且 `createShare` 存的就是词法路径 |
| **F-4** | 中低 | WebDAV `PUT` 覆盖已存在文件**不需要 `delete` 权限、也不进回收站**（与 Web 端 `/upload`、`/rename` 的规则相反） |
| **F-5** | 中低 | 分享密码锁定**只按 IP** 计（无账号维度），且 `/api/share/:token/verify` 没挂 `rateLimit` → `TRUST_PROXY` 开启后可用 `X-Forwarded-For` 轮换无限试密码 + 打满 bcrypt |
| **F-6** | 低 | ZIP 解压的条目名只挡 `..`，不挡 `:` → Windows 下可写出 **NTFS 备用数据流**（列表/统计/配额都看不见） |
| **F-7** | 低 | `.env` / `*.env` / `.jwt-secret` 这类名字可以**被创建**（上传/改名/新建/链接下载），创建后立即对所有接口不可见且不可删除（超管也不行）。工作区里**实测已存在**一个这样的孤儿文件 |
| **F-8** | 低 | `download-url` 没有并发/总数上限，单任务可落 4GB 到 `data/tmp` → 磁盘耗尽 |
| **F-9** | 信息 | 全站没有磁盘配额（只有单文件上限）；缩略图单张 80M 像素 × 2 并发 |

前序报告中**未真正修复**的项：**D-3、D-4、D-5、D-6、L-3、L-7、L-9**（详见 §2.3）。其中 **D-3（压缩把自己打进 zip）** 在本轮仍然可复现。

---

## 二、已修复验证（对照前两轮报告，行号取自当前代码）

> 结论：前两轮报告里**属于本领域**的 26 项中，**19 项确认已修**、**7 项未修**（§2.3）。逐条给出当前机制与调用点。

### 2.1 确认已修复

| 前序编号 | 声称的修复 | 当前代码证据 | 判定 |
|---|---|---|---|
| #1 访客隐藏目录可被越权读写 | `assertContextVisible()` 内统一执行 `guestBlocked()` | `routes/fs.js:118-130` `if (guestBlocked(req, rel) \|\| !contextVisible(req, rel)) throw 404`；`/file` `fs.js:1470`、`/save-file` `fs.js:1537`、`/list` `fs.js:219-222`、`/download` `fs.js:261`、`/stat` `:1043`、`/details` `:1079`、`/thumb` `:1106`、`/search` `:1144-1145`、`/guest-visibility` `:1175`、`/copy`+`/move` `:976,986`、`/extract` `:1327,1332` 全部在**规范化后的** `resolved.rel` 上调用 | ✅ 已修（`/zip` 除外，见 F-1） |
| #2 软目录 `"./"` 泄露 `.env` / `data/` | `isSensitiveAbs()` + `resolveAny` 软目录分支 | `safety.js:187-217` 定义；`safety.js:116`（软目录）与 `:129`（网盘本体）各拦一次；列表侧 `fs.js:230,236`、搜索侧 `fs.js:1152`、打包侧 `fs.js:359,382,461` 都逐条过滤 | ✅ 已修 |
| #3 登录锁定表无界 | `peek()` 只读 + `evictOldest()` 有界 | `auth.js:150-152`（`peek` 不建条目）、`auth.js:180-188`（插入即淘汰，5% 批量）；`routes/auth.js:30` 挂 `rateLimit` | ✅ 已修 |
| #4 `encodeText` O(n²) | 改 `Set` 查表 | `encoding.js:301-306` `const present = new Set(back); if (!present.has(ch))` | ✅ 已修 |
| #5 解压信任 zip 头声明值 | `readZipEntryLimited()` 流式限额 | `fs.js:1303-1321`（边读边加、超限 `destroy`）；`fs.js:1410` 用它代替 `file.buffer()`；`fs.js:1394,1411-1414` 把**被跳过**的条目也计入 `consumed` | ✅ 已修 |
| #6 `data/*.json` BOM 误判 | 读取前剥 BOM | `store.js:24`、`integrity.js:50`、`backup.js:199` 三处都 `.replace(/^\uFEFF/, "")` | ✅ 已修 |
| #7 CSV 公式注入 | `csvCell` 前缀 | `logger.js` `if (/^[=+\-@\t\r]/.test(s)) s = "'" + s` | ✅ 已修 |
| #8 限流桶上限无效 / `TRUST_PROXY` | `evict()` + 对端兜底桶 | `ratelimit.js:57,69-77`（按窗口起点淘汰）；`ratelimit.js:52-54` 用 `req.socket.remoteAddress` 追加 `peer:` 桶（倍率 6） | ✅ 已修（`auth.js`/`shares.js` 的锁定表未跟进，见 F-5） |
| #9 回收站失败静默彻底删除 | 入站失败 throw + 调用方 skip | `trash.js:105-113,132-135` 抛 `TRASH_FAILED`；`fs.js:877-891` 捕获后 `failed.push` + `continue`，**不回落到 `rm`**；响应回 `failed[]` | ✅ 已修 |
| #10 WebDAV 自嵌套大小写敏感 | 改 `isSameOrInside` | `webdav.js:733-740` 双向判断（含"目标是源的祖先"这一反向） | ✅ 已修 |
| #11 无 `realpath` 校验 | `realpathish()` + 边界复判 | `safety.js:50-66`（不存在路径时向上找最近存在祖先再拼回）；`safety.js:110,123` 用 `resolved.startsWith(base + path.sep)` 判边界 | ✅ 已修 |
| #12 回收站还原参数非法返回 200 | 改 `throw` | `trash.js:210-214` `throw httpError(400, ...)` | ✅ 已修 |
| #13 `integrity.js` 兜底 `rmSync` | 隔离失败保留原样 | `integrity.js:36-41` `catch { return false }`，无 `rm` | ✅ 已修 |
| #14 备份回滚不校验类型 / 不收紧权限 | 顶层类型 + `restrictFileMode` | `backup.js:197-215`（`expectsObject`/`expectsArray` 校验）、`:223` `restrictFileMode(dest)` | ✅ 已修 |
| **D-1** 目录级复制不做逐条过滤 | `exposesServiceFiles()` 祖先预检 | `safety.js:236-248`；`fs.js:102-107 assertCopySourceSafe()`；调用点 `fs.js:984`（copy 分支，**与开关无关始终生效**）。`move` 分支由 `blockSoft` 兜住（`fs.js:981`），`compress` 由 `fs.js:1273 blockSoftCopyOut` + 逐条 `isSensitiveAbs` 兜住 | ✅ 已修 |
| **D-2** 前端 OOXML 解压无上限 | `inflateRaw(bytes, maxBytes)` 边读边计数 | `web/src/lib/office/zip.ts:57,68,77-79`（`getReader()` + 超预算 `cancel()`）；`:163` 按剩余预算分配 | ✅ 已修 |
| **L-1** 16MB JSON 在鉴权前解析 | body parser 挪到 `attachAuth`/`csrfGuard` 之后 | `server/index.js:109-118`：`app.use(attachAuth)` → `attachContext` → `/api` `csrfGuard` → **然后**才是 `save-file` 的 16MB 解析器 | ✅ 已修 |
| **M-1** Windows 下凭据文件对所有本地用户可读 | `icacls` 收紧 ACL | 只读复核：`.env` → `Administrators(F) / SYSTEM(F) / RedmiBook(R,W)`；`data` → 同样三条 `(OI)(CI)(F)`，已无 `BUILTIN\Users` / `Authenticated Users` | ✅ 已修 |
| **M-2** 匿名访客默认可读全盘 | 17 个顶层条目进 `guestHiddenPaths` | `data/config.json` 的 `guestHiddenPaths` 有 17 条；`data/files` 顶层恰好 17 个条目，逐条比对**完全一致**（`Get-ChildItem data\files` 与配置逐一核对）。访客根目录为空 | ✅ 已修（部署级） |

### 2.2 其余正向验证（本轮复核过、不必再查）

- **路径解析确实是单一入口**：`routes/fs.js` 里所有读盘路径都经 `resolveSafe`/`resolveAny`（`grep` 逐条核对了 22 个 handler）；全库没有 `fs.*(req.query…)` 式直拼。
- **NUL / `..` / `\` / `..%2f` / 双重编码 / 绝对路径 / UNC**：`normRel`（`safety.js:21-35`）先 `\`→`/`、拒 `\0`、逐段拒 `..`、Windows 下逐段拒 `:`；`split("/")` 后过滤空段，所以 `/etc/x`、`\\host\share`、`C:/x` 在 Windows 上全部被降级或拒绝；`%252f` 这类双重编码经 `qs` 解一次后 `%2f` 是字面量，不构成穿越。
- **`file.txt:stream`（ADS）**：`normRel:32` 与 `validateName:291` 在 Windows 上拒 `:`，`sanitizeFileName:317` 把 `:` 换成 `_` → **创建/读取侧都被堵住**（但解压侧漏了，见 F-6）。
- **别名/链接**：`realpathish` 会把 8.3 短名、符号链接、大小写全部规范化成"真实路径"，`resolved.rel` 是规范化的（`safety.js:111,124`）；`entryInfo`/`assertExists`/`dirStats` 都用 `lstat` 拒末级符号链接（`files.js:9-10,82-84,122`），`searchFiles` 经 `entryInfo` 间接过滤（`files.js:179`），打包侧同样 `if (!stat || stat.isSymbolicLink()) continue`（`fs.js:361,386,463`）。
- **SSRF（`netguard.js`）质量高**：先 `new URL` 限 `http/https`、拒 URL 内嵌凭据（`:229-234`）；对主机名做 `dns.lookup({all:true})` 取**全部** A/AAAA 并**逐个**判段（`:241-264`，任一命中即拒，比"取第一个"更严）；判段覆盖 `0/8、10/8、100.64/10、127/8、169.254/16（含云元数据）、172.16/12、192.168/16、198.18/15、224/4、240/4`（`:81-97`）与 IPv6 `::1、::ffff:x、2002::/16 6to4、64:ff9b::/96 NAT64、2001::/32 Teredo、fc00::/7、fe80::/10、ff00::/8`（`:153-191`），IPv6 按**数值**解析（`:110-147`），所以 `[::1]`、`::ffff:127.0.0.1`、`0:0:0:0:0:0:0:1` 都识别；连接阶段用 `pinnedLookup` 把**已校验 IP 固定给 socket**（`:274-288`、`fs.js:1669`），彻底消除 DNS rebinding 的检查/使用时间差；每一跳重定向都**重新解析重定向目标**（`fs.js:1745-1748`，`MAX_REDIRECTS=5`）；响应体积同时用 `content-length` 预判与边收边计数（`fs.js:1695-1721`）；TLS 默认严格校验，只有显式 `DOWNLOAD_URL_INSECURE_TLS=1` 才放开（`fs.js:1671`）。
- **分享 token 熵**：`crypto.randomBytes(18).toString("base64url")` = 144 位（`shares.js:76-78`），枚举不可行；密码 `bcrypt(10)` 存储（`:296`），校验用 `bcrypt.compare`（`routes/shares.js:273`）；票据是短时效 JWT（≤2h）并**绑定单个 share token**（`shares.js:391-408`），不是 Cookie，换一个分享的票据无效。
- **分享路径作用域**：`resolveSharePath`（`routes/shares.js:145-166`）= `normRel(sub)` + `joinRel` + `isSameOrInside(rel, share.path)` + `resolveAny`，`..` 在第一步就被拒；`../` 逃逸不可行。
- **头像**：`OWNER_RE=/^[A-Za-z0-9_-]{1,72}$/`（`avatars.js:24`）→ 无点号、无分隔符，`data/avatars/<owner>.webp` 不可能穿越；只用**手写 WebP 头解析**（`:49-74`）而不是图像库解码，尺寸必须恰好 128×128，体积受 `avatarMaxKB` 限制；`GET` 需登录（`routes/avatars.js:46`），`POST /:owner` 有 `canEditOwner` 归属校验（`:30-40`）。
- **缩略图**：缓存键 `sha1(rel|size|mtime|width)`（`thumbs.js:88-93`）→ 无用户可控路径成分；扩展名白名单**刻意不含 `.svg`**（`:30`）；`limitInputPixels=80M`、输入 ≤64MB、并发 2、队列 64（`:37-45`）；生成前已过 `resolveAny` + `assertContextVisible`（`fs.js:1105-1114`）。
- **备份**：`restoreBackup` 的 `name` 必须在 `MANAGED_FILES` 白名单内、`id` 走 `path.basename()` + 必须 `.json` 结尾（`backup.js:176-193`）→ **不可穿越、也拿不到 `.env`**；`/api/admin/*` 全程 `requireRole("superadmin")`（`routes/admin.js:32`）。
- **回收站 id 穿越**：`entryDir()` 做 `path.basename` 收敛 + `getTrash()` 再做 `isInsideTrash()` 断言（`trash.js:75-84,181-187`），双重。
- **响应头注入**：`contentDisposition()` 的 ASCII 回退把 `\r\n`（不在 `\x20-\x7e`）替换成 `_`（`http.js:45`）→ 文件名不能注入响应头。
- **CSRF**：写请求必须带 `X-Requested-With: XMLHttpRequest`，并校验 `Sec-Fetch-Site`/`Origin`（`auth.js:76-108`）；`server/index.js:111` 对 `/api` 全域生效。

### 2.3 前序报告声称"已修/待修"但**实际仍未修**的项

| 编号 | 位置（当前行号） | 现状 |
|---|---|---|
| **D-3** 压缩目标落在被压缩目录内 → zip 把自己打进去 | `routes/fs.js:1194-1258`（`runCompressJob`）、`:1260-1284`（`/compress`） | **未修**。`validateZipLimits()`（`:1276`）在写盘**之前**算完；随后 `fs.createWriteStream(outFile)`（`:1198`）先建文件，`addDirToArchive`（`:1238`）再递归读目录。`/compress` 与 `transfer()` 不同，**仍没有** `isSameOrInside(dest, src)` 对称检查。`{"paths":["a"],"dest":"a"}` 即可让正在写入的 `a/a.zip` 被当成普通条目读进去 |
| **D-4** 回收站"覆盖还原"绕过回收站 | `trash.js:219-223` | **未修**。`if (existing) { if (!overwrite) return {conflict}; await fs.promises.rm(dest.abs, {recursive:true, force:true}) }` —— 仍是永久删除，不进回收站 |
| **D-5** 保留设备名 | `safety.js:283-294` `validateName()` | **未修**。仍只拦 `\ / : * ? " < > \|` 与控制字符 + 尾点/尾空格，没有 `CON/PRN/AUX/NUL/COM1..9/LPT1..9`（含 `CON.txt`）保留名表 |
| **D-6** `/api/fs/file` 多编码探测放大 | `encoding.js:203-208`、`:87-113` | **未修**。非 UTF-8 时仍对 6 个候选各做一次**全文** `iconv.decode` + `countReplacement(text)`（全文遍历），最多 8MB × 7 遍；`/file` 只要求 `preview\|\|downloadFile`，访客默认可达（有 `rateLimit` 120/分 兜底） |
| **L-3** 压缩中间件 `decodeURIComponent` 未捕获 | `compress.js:139` | **未修**。`const abs = path.resolve(root, \`.\${decodeURIComponent(urlPath)}\`)` 无 `try/catch`；请求 `/%E0.js` + `Accept-Encoding: gzip` 会抛 `URIError` → 500（需扩展名命中 `TYPES` 才可达） |
| **L-7** 磁盘残留旧凭据 | `.migration-backup/20260927-135131/server.env`、`.../server-data/.jwt-secret` | **未修**。两份文件仍在盘上（本轮 `Get-ChildItem -Force` 确认）。虽然 `isSensitiveAbs` 已把 `*.env` 与 `.jwt-secret` 按**文件名**拦死（`safety.js:199-200`），即使软目录映射到项目根也拿不到——但"磁盘上存在旧口令/旧会话密钥"本身就是可被本地用户或备份带走的风险 |
| **L-9** 部分重接口无限流 | `fs.js:255`（`/download`）、`fs.js:613`（`/upload`）、`jobs.js:26-46` | **部分未修**。`/download`、`/upload` 仍无 `rateLimit`（`ratelimit.js:9-11` 说明这是**有意**的：普通下载/列目录不限流）；`download-url` 任务仍无并发上限（见 F-8） |

---

## 三、确认的新问题（按严重度）

### F-1【中高 · 匿名可触发】`/api/fs/zip` 用词法 `rel` 判可见性、用规范化 `abs` 读盘 → 8.3 短名可绕过「对访客隐藏」

**位置**
- `server/src/routes/fs.js:353-365`（`collectZipItems`，**核心**）
- `server/src/routes/fs.js:371-394`（`scanDirForZip`，递归时同样用词法 `dirRel`）
- `server/src/routes/fs.js:476-501`（`/zip`：`rels = parsed.map((p) => normRel(p))`，**没有**用 `resolved.rel`）
- `server/src/routes/fs.js:1260-1284`（`/compress`：`sourceRels = paths.map((p) => normRel(p))`，同一条路）
- 对照契约：`server/src/safety.js:130-132`

**证据（决定性 3 行）**

```js
// routes/fs.js:355-362  —— 判定用 rel（词法、用户给的原样字符串），读盘用 resolved.abs（规范化）
for (const rel of rels) {
  if (!vis.visible(rel)) continue                       // ← 词法判定：isHiddenFromGuest("GSAP-S~1") === false
  const resolved = resolveAny(rel)                       // ← 规范化：abs 已经是 .../data/files/gsap-skills-main
  items.push({ abs: resolved.abs, rel, name: path.basename(resolved.abs), ... })  // ← rel 仍是 "GSAP-S~1"
```

```js
// safety.js:130-132 —— 作者自己写下的契约，routes/fs.js 其余 20 个 handler 都遵守，唯独这里没有
// 返回**规范化**后的相对路径：后续所有判定（访客隐藏、小组可见范围、敏感名）
// 都基于它，因此 8.3 短名 / 符号链接无法再让同一个文件出现两种说法。
```

**机制（已用运行时验证，非推测）**

Windows NTFS 会为非 8.3 名生成短名；`fs.realpathSync.native`、`lstat`、`readdir` 都能**通过短名访问真实目录**，且 `realpath` 会把短名展开成长名。我在 `%TEMP%` 下实测（临时目录，测完删除）：

```
目录真名: supersecretfolder      8.3 短名: SUPERS~1
SUPERS~1 -> realpath: ...\zs-audit-83\supersecretfolder   ← 短名被展开成长名
SUPERS~1 -> lstat isDir: true   readdir: a.txt            ← 通过短名可以真实读到内容
```

本机 `D:` 卷确实生成短名（`dir /x D:\编程` 显示 `!废弃~1`）。于是：

1. `guestHiddenPaths` 里就有 `"gsap-skills-main"`、`"Screenshot.png"`、`"807班花名册-260913.xlsx"` 这类名字（当前 `data/config.json` 的 17 项，见下表）。
2. 匿名访客请求 `GET /api/fs/zip?path=GSAP-S~1`（或 `SCREEN~1.PNG`、`807班~1.XLS`）：
   - `normRel("GSAP-S~1")` → `"GSAP-S~1"`；
   - `vis.visible("GSAP-S~1")` → `isHiddenFromGuest("GSAP-S~1")` 与 `"gsap-skills-main"` 比较 → **false**（字符串不等、也不以 `gsap-skills-main/` 开头）→ 放行；
   - `resolveAny("GSAP-S~1")` → `realpathish` → `...\data\files\gsap-skills-main`（真实目录）；
   - `statSafe` → 目录 → `items.push({abs: ...\gsap-skills-main, rel: "GSAP-S~1"})`；
   - `addDirToArchive` 递归：子项 `entryRel = "GSAP-S~1/xxx"` → `vis.visible` 依然 false → **全部打包**。
3. `validateZipLimits` 也走同一条 `vis`，所以隐藏子树里的文件**会计入**上限（限制本身没被绕过，只是内容被打了出去）。
4. 同一个 `collectZipItems` 也服务 `/api/fs/compress` → 成员可以把隐藏目录压成 zip 放在可见目录里，再让访客下载（跨身份泄露）。

**影响**
- 违背 `guestHiddenPaths` 的全部意义：访客本应只看到空根目录（M-2 的部署修复被绕过），实际可**整包下载**被标记隐藏的目录。
- 同样绕过**小组可见范围**（`contextVisible` 也是按词法 `rel` 调的）：不同项目组的黑名单目录可被打包带走。

**命中面（对本机当前 `guestHiddenPaths` 的 17 项逐条实测，在 `%TEMP%` 建同名条目再 `dir /x` 看短名）**：9 项有短名 → 可直接绕过；8 项本身是合法 8.3 名、没有短名 → 不受此手法影响。

| 隐藏条目（当前配置） | 8.3 短名 | 可否绕过 |
|---|---|---|
| `Screenshot.png` | `SCREEN~1.PNG` | ✅ |
| `gsap-skills-main` | `GSAP-S~1` | ✅ |
| `gsap-skills-main.zip` | `GSAP-S~1.ZIP` | ✅ |
| `807班花名册-260913.xlsx` | `807班~1.XLS` | ✅ |
| `Minecraft版元素周期表.pptx` | `MINECR~1.PPT` | ✅ |
| `epicterrain-0.2.5.jar` | `EPICTE~1.JAR` | ✅ |
| `千万博主谈b站真相（完整版）.mp4` | 有（同类规则） | ✅ |
| `小号的板子.pptx` / `解压文件夹测试` / `新建文件夹` / `多文件测试` / `新建文本文档.txt` | `新建文~1`、`多文件~1` 等 | ✅ |
| `web` / `subdir` / `网站` / `web.zip` / `README.md` | 无（本身合法 8.3） | ❌ |

短名是**确定性**的（`名字前 6 个字符大写 + ~1`，扩展名截到 3 位），不需要读目录就能推出来。

**触发条件**
- Windows 部署（本项目主要部署平台）＋ `guestHiddenPaths` 或小组黑名单里有"存在 8.3 短名"的条目（上表 9/17 命中）。
- 攻击者需知道/猜到隐藏条目的名字 —— 但 `guestHiddenPaths` 挡的正是"名字已知但内容不该给"的场景（管理员把某个目录藏起来，名字往往在聊天里说过）。`/zip` 只需 `downloadFolder` 权限，**访客默认为 true** → 未登录即可。

**修复建议（改 3 行）**
```js
// routes/fs.js collectZipItems：先规范化，再用 resolved.rel 做一切判定与归档命名
const resolved = resolveAny(rel)
if (!vis.visible(resolved.rel)) continue          // ← 用规范化后的 rel
if (isSensitiveAbs(resolved.abs)) continue
items.push({ abs: resolved.abs, rel: resolved.rel, ... })   // ← 归档里也用规范化 rel
```
`scanDirForZip` / `addDirToArchive` 的 `dirRel` 继续用 `item.rel`（此时已是规范化值）即可。建议顺手在 `zipVisibility()` 里加一条断言：传入的 `rel` 必须等于 `resolveAny(rel).rel`，否则 400——把这类"词法/规范化混用"变成显式错误而不是静默放行。

---

### F-2【中低】`webdav.js` 的可见性判定发生在 `resolveAny()` 之前

**位置**：`server/src/webdav.js:414-428`（`resolveOrReply`）、`:722-725`（COPY/MOVE 的目标校验）、`:780-784`（LOCK）

**证据**

```js
// webdav.js:416-427
const rel = relFromUrl(req)          // 词法：normRel(decodeURIComponent(req.path))
if (!visible(req, rel)) { ... 404 }  // ← 判定用的是词法 rel
const resolved = resolveAny(rel)     // ← 规范化之后没有再判一次
return resolved
```

`visible()`（`:374-385`）只做 `isVisibleForContext(rel, {...})`，即 `isVisibleInVisibility()` 的 `inList/isSameOrInside` 字符串比较。

**影响**：成员用 `PROPFIND /dav/WEB~1/`（或 junction / macOS NFC-NFD 变体）可绕过小组黑名单读取目录与文件；`GET` 同样。DAV 只接受成员账号（`:305-314` 拒超管），所以不影响访客隐藏（那是 web 端语义，DAV 刻意不套，见 §五）。

**触发条件**：`webdavEnabled` 打开（默认 false）＋ 目标成员处于带黑名单的小组上下文 ＋ 隐藏名存在 8.3 短名（或净盘内存在 junction）。

**修复建议**：把 `visible()` 移到 `resolveAny()` 之后、并对 `resolved.rel` 判定：
```js
const resolved = resolveAny(rel)
if (!visible(req, resolved.rel)) return 404
```

---

### F-3【中低】分享链接的隐藏判定与可见范围快照基于词法 `rel`；分享存的是词法路径

**位置**：`server/src/routes/shares.js:145-166`（`resolveSharePath`）、`:429-470`（创建）、`:391-427`（precheck）、`server/src/shares.js:113-144`（`normalizeShare` 只做 `\`→`/`，不规范化）

**证据**

```js
// routes/shares.js:146-164
const sub = normRel(requested || "")
const rel = sub ? joinRel(share.path, sub) : share.path
if (!isSameOrInside(rel, share.path)) throw ...        // 词法边界
resolved = resolveAny(rel)                              // 规范化
if (!share.requirePassword && isHiddenFromGuest(rel)) throw 404   // ← 词法判定
assertShareVisible(share, rel)                          // ← 词法判定（小组白/黑名单）
```

且创建时 `createShare({ rel })` 传的是 `normRel(req.body.path)`（`:432`），**不是** `resolved.rel`；`hidden = isHiddenFromGuest(rel)`（`:449`）与 `isVisibleForContext(rel, ...)`（`:434`）也都是词法判定。

**影响**
- 一个**无密码**分享挂在可见父目录上时，请求 `?path=WEB~1/sub/x.txt`（或 `?path=子目录8.3名`）即可读到本该被 `guestHiddenPaths` / 黑名单挡住的子目录 → 与 F-1 叠加时等于"把隐藏内容变成公网可下载"。
- 创建侧：成员可在一个自己**本不该看见**的路径上建分享（词法检查通过、真实路径是黑名单目录），且 `requirePassword` 会被错误地算成 `false`。

**触发条件**：同 F-1（Windows + 8.3/junction）＋ 存在无密码分享。当前 `sharePublicAccess=true`，匿名可达。

**修复建议**：`resolveSharePath` 里改成 `const rel = resolved.rel;` 之后再跑 `isSameOrInside(rel, canonicalSharePath)`、`isHiddenFromGuest`、`assertShareVisible`；创建时 `createShare({ rel: resolved.rel })`，并用 `isHiddenFromGuest(resolved.rel)` 决定 `requirePassword`。同时把 `share.path` 在 `normalizeShare` 里做一次 `resolveAny`（失败则标记 stale），免得旧记录里存着非规范字符串。

---

### F-4【中低】WebDAV `PUT` 覆盖已存在文件：不需要 `delete` 权限、也不进回收站

**位置**：`server/src/webdav.js:563-644`

**证据**

```js
// webdav.js:564  —— 只校验 upload，没有 delete
if (!req.dav.perms.fileWrite || !req.dav.perms.upload) return deny(res, "upload")
...
// webdav.js:632-637  —— 直接 rename 覆盖（失败则先 rm 再 rename），全程不经回收站
await fs.promises.rename(tmp, resolved.abs).catch(async () => {
  await fs.promises.rm(resolved.abs, { force: true })
  await fs.promises.rename(tmp, resolved.abs)
})
```

对照 Web 端：`/api/fs/upload` 覆盖走 `removeForOverwrite()`（`fs.js:805-818`），它**强制要求 `delete` 权限并进回收站**，注释还专门解释了原因（"否则只有 upload 权限的成员也能直接抹掉别人的文件，且无从恢复"）；`/rename`（`:841`）、`transfer`（`:1021`）、`DELETE`（`:682`）、DAV `DELETE`/`MOVE`+`COPY`+`Overwrite:T`（`webdav.js:757`）也全都遵守这条规则。**只有 DAV PUT 例外。**

**影响**：只读成员（`fileWrite=true` 但 `delete=false`）可以通过挂载盘把任意已知路径的文件内容清空/覆盖，且原内容**不可恢复**（不进回收站）。这既是权限绕过（delete 权限形同虚设），也是数据丢失风险（与 D-4 同一性质）。

**触发条件**：`webdavEnabled` 打开 ＋ 成员账号 ＋ 该成员 `upload=true && delete=false`。

**修复建议**：`handlePut` 在 `existing` 为真时，先 `if (!req.dav.perms.delete) return deny(res,"delete")`，再 `await moveToTrash({abs, rel}, {user, role:"member", ip})`（与 `handleDelete` 一致），最后 rename。

---

### F-5【中低】分享密码锁定只按 IP，且 `/api/share/:token/verify` 未挂 `rateLimit`

**位置**：`server/src/routes/shares.js:258-286`（`POST /:token/verify` 无 `rateLimit`）、`server/src/shares.js:418-477`（锁定表键只有 `s:${ip}:${token}` 与 `i:${ip}`）

**证据**

```js
// routes/shares.js:258 —— 注意：没有 rateLimit（同文件里 /:token、/:token/list、/:token/download 都挂了）
publicShareRouter.post("/:token/verify", async (req, res, next) => {
  const locked = passwordLocked(req.ip, share.token)      // ← 只按 req.ip
  ...
  const ok = share.passwordHash ? await bcrypt.compare(password, share.passwordHash) : false
  if (!ok) { recordPasswordFail(req.ip, share.token) ... }
```

```js
// shares.js:418-419 —— 键里没有"账号/分享自身"这一维，两个桶都带 ip
const PER_SHARE_MAX = 8; const PER_IP_MAX = 20;
```

**影响**：`TRUST_PROXY` 一旦开启（`.env` 模板在"隧道/反代"场景下主动建议填 `TRUST_PROXY=loopback`），`req.ip` 就取自可伪造的 `X-Forwarded-For`。攻击者每请求换一个 XFF 值即得到全新的 `s:`/`i:` 桶 → **分享密码可无限次尝试**，且每次尝试都是一次 `bcrypt(10)`（约 60–100ms CPU），单机即可打满一个核。分享密码允许 6–10 位（`shares.js:36-37`），弱口令（数字/生日）在无锁定下会被穷举。

**为什么这条值得单列**：同类问题在另外两处**已经被防住**——`ratelimit.js:52-54` 专门加了不可伪造的 `req.socket.remoteAddress` 兜底桶；`auth.js` 的登录锁定是"IP + **用户名**"双维度（`auth.js:194-218`，`routes/auth.js:51` 注释明确写了"伪造 X-Forwarded-For 也绕不过"）。只有分享密码这一条漏了"与 IP 无关"的那一维。

**触发条件**：`TRUST_PROXY` 非 false（部署级/反代场景）＋ 目标分享要求密码（= 该路径对访客隐藏，正是最需要保护的内容）。

**修复建议**：①给 `/:token/verify` 挂上 `rateLimit`；②在 `recordPasswordFail/passwordLocked` 里增加一个 `share:${token}` 维度的全局失败桶（与 IP 无关，阈值可设为 50/15 分钟），超过后**无论来自哪个 IP** 都锁该分享；③更进一步，把 `req.ip` 换成 `req.socket.remoteAddress` 参与锁定（与 `ratelimit.js` 的 peer 桶一致）。

---

### F-6【低】ZIP 解压不挡 `:`，Windows 下可写出 NTFS 备用数据流（ADS）

**位置**：`server/src/routes/fs.js:1395-1421`

**证据**

```js
// fs.js:1399-1403 —— 只挡长度与 ".."，没有像 normRel(safety.js:32) 那样挡 ":"
const segments = entryPath.replace(/\\/g, "/").split("/")
if (segments.some((s) => s.length > 200 || s === "..")) continue
const outPath = path.resolve(extractDestAbs, entryPath)
...
await fs.promises.writeFile(outPath, read.buffer)     // outPath 可以是 "x.txt:evil"
```

**影响**：`extractZip` 权限者（成员默认 true）可让解压写出 `x.txt:evil` 这类 **NTFS 备用数据流**：内容不体现在 `stat.size`、不出现在 `readdir`、不计入 `dirStats` 的字节数（于是 `/stat`、状态页、配额类展示全部看不见），但可以被本机任意按名读取的程序读到。可用于隐藏数据（"免审计寄存"）。中间段带 `:` 会因 `mkdirSync` 失败而中止整个解压任务（一次性 DoS，已被 `abortExtract` 清干净）。

**触发条件**：Windows ＋ `extractZip` 权限 ＋ 自造 zip（条目名含 `:`）。

**修复建议**：逐段复用 `normRel` 的规则（`process.platform === "win32" && seg.includes(":") → continue`），并顺手加保留设备名与尾点/尾空格过滤。

---

### F-7【低】可以创建"敏感名"文件，创建后立即对所有接口不可见且不可删除（含超管）

**位置**：`server/src/safety.js:199`（`baseName === ".env" \|\| baseName.endsWith(".env") \|\| /^\.env[.\-_]/`）、`:200`（`.jwt-secret*`）；创建侧未做对称检查：`routes/fs.js:576-611`（`/create-file`）、`:613-793`（`/upload`，`sanitizeFileName` 允许 `.env`）、`:820-855`（`/rename`，`validateName(".env")` 通过）、`:1762-1785`（`/download-url`，文件名取自 URL 末段）

**证据（代码 + 现场）**

```js
// safety.js:198-200 —— 按“文件名”拦凭据（与目录无关），这是防泄密的正确做法
const baseName = ...
if (baseName === ".env" || baseName.endsWith(".env") || /^\.env[.\-_]/.test(baseName)) return true
if (baseName === ".jwt-secret" || baseName.startsWith(".jwt-secret")) return true
```

`isSensitiveAbs` 在 `resolveAny` 里对**任何**路径生效（`safety.js:116,129`）→ 一旦文件名叫 `.env`，`/list` 过滤掉它（`fs.js:236`）、`/download`/`/file`/`/delete`/`/rename` 全部在 `resolveAny` 处直接 404。

现场证据（只读 `Get-ChildItem`）：

```
data\files\新建文件夹\新建文件夹 (3)\新建文件夹\.env    337 字节   2026/7/18 15:34
```

**影响**：成员（或任何有 `upload`/`editFiles` 的人）可以制造一个"看不见、删不掉、也搜不到"的文件：不入列表、不进打包、不改名、不进回收站，管理员只能上文件系统手工清理。若把 `.env` 换成 `x.env` / `.jwt-secret` 同样命中。属于**可用性/卫生**问题，不构成越权（内容仍然拿不到，方向是对的）。

**触发条件**：任意写权限 ＋ 文件名命中上述规则（最常见的是上传一个真的 `.env`）。

**修复建议**：二选一。①创建侧对称拒绝：`/rename`、`/create-file`、`/upload`、`/download-url` 对最终文件名调用一个 `isForbiddenFileName(name)`（与 `isSensitiveAbs` 同名规则）并回 400，把"不可见孤儿"挡在入口；②或把 `isSensitiveAbs` 的"按文件名"规则收窄为"仅当该路径是服务自身文件（在 `DATA_DIR` / `ROOT_DIR` 下）"，网盘内容本体里则允许 `.env`（但那时 `.env` 就能被下载——所以更推荐 ①）。

---

### F-8【低】`download-url` 没有并发/总量上限，单任务最多 4GB

**位置**：`server/src/routes/fs.js:1762-1785`（每次请求 `createJob` 后立即 `void downloadFileFromUrl(...)`）、`server/src/jobs.js:26-46`（`createJob` 不检查每用户任务数）、`config.js:15`（`downloadUrlMaxMB: 4096`）

**证据**：`/download-url` 除了 `rateLimit`（120/分）之外没有任何并发门；`downloadFileFromUrl` 把内容先写到 `TMP_DIR`（`fs.js:1739`），成功后 `moveEntry` 到目标。没有"每用户最多 N 个并发下载"或"总量上限"。

**影响**：一个成员（`downloadUrl` 权限，默认 true）可以并发发起 100 个任务，每个最多 4GB → 写满 `data/tmp` 所在磁盘，服务与全站数据一起受影响。`sweep()` 只清"闲置 10 分钟"的任务且不动临时文件（临时文件由 `downloadFileFromUrl` 的 `catch` 清）。

**修复建议**：与 `thumbs.js` 相同模式加一个全局并发闸门（例如同时 3 个、每用户 1 个），并对 `TMP_DIR` 做总量预算检查。

---

### F-9【信息】没有磁盘配额；缩略图单张上限偏高

- **无配额**：全库只有单文件上限（`uploadLimitBytes`）与单次打包/解压上限；没有任何"每用户/总量"配额，也没有写盘前的剩余空间检查（`metrics.js:83`、`status.js:32` 只把 `statfs` 用于展示）。任何成员都能写到 `ENOSPC`；`ENOSPC` 时上传会给出"服务器磁盘空间不足"（`fs.js:753-760`），行为正确但**不可预防**。
- **缩略图**：`MAX_INPUT_PIXELS = 80_000_000`，`MAX_CONCURRENT = 2`（`thumbs.js:39,41`）。理论峰值 80M×4B×2 ≈ 640MB RGBA（libvips 是分块/流式的，实际远低于此，但这条上限对"2 核 2G 的工控机"明显偏高）。访客默认有 `preview` → 可触发。建议降到 24–40M 像素。

---

## 四、疑似待验证（需要运行时/特定平台，未在本轮证实）

| 编号 | 事项 | 为什么是"疑似" | 建议验证方式 |
|---|---|---|---|
| S-1 | **macOS（APFS）上的 Unicode 规范化绕过**：APFS 对名字做规范化不敏感，`isHiddenFromGuest` / `isSameOrInside` 只做字符串（含大小写折叠）比较，从不 `normalize("NFC")` | 代码里确实没有任何 `normalize()`（`grep` 全库无命中）；Windows NTFS 不做规范化，所以本机无法复现 | 在 macOS 上建一个 NFD 名的隐藏目录、用 NFC 拼写请求 `/api/fs/list`、`/api/fs/zip`；若放行即确认（严重度同 F-1） |
| S-2 | **净盘内 junction / 目录符号链接**导致 `resolved.rel` 与词法 `rel` 分叉：F-1/F-2/F-3 的判定全部会被绕过；此外 `/zip` 的 `collectZipItems` 用 `statSafe(resolved.abs)`（lstat **规范化后的**真实目标），所以"中间层是链接"会被跟随 | 需要本机先在 `FILES_DIR` 里造一个 junction（需要本地权限，我按规则未创建任何文件到工作区） | 在 `data/files` 下 `mklink /J link ..\..\.env` 之类，然后匿名请求 `/api/fs/zip?path=link` 与无密码分享的 `?path=link/x` |
| S-3 | **`/api/fs/extract` 的半成品目录清理**：`abortExtract()` 用 `fs.promises.rm(extractDestAbs, ...)`，而 `extractDestAbs` 来自 `uniqueName(destAbs, zipBaseName)`；`zipBaseName` 未过 `validateName`（`fs.js:1376`） | zip 文件名可以含 `.env`、尾点、保留名等（来源是上传/下载）。目前看只影响"写到哪"的可用性，未找到越权读回的路径（`isSensitiveAbs` 会让它不可见） | 上传 `x.env.zip` 后解压，观察是否生成不可见目录；再试 `CON.zip` |
| S-4 | **`restoreTrash` 的 `dest` 来自超管请求体**（`routes/admin.js:532-538`）：`resolveAny(normRel(dest))` 已挡住越界与敏感路径，但**没有** `isHiddenFromGuest` / 可见范围校验 | 仅超管可达，越权意义不大 | 无需处理，记录在案 |
| S-5 | **`/api/fs/upload` 的 `overwrite` 语义**：`overwriteNames.includes(item.name)` 只看 basename，前端传 `overwrite:["a.txt"]` 可覆盖**任意子目录**下的同名文件（仍在同一 `uploadDir`，且已过 `delete` 权限 + 回收站） | 逻辑上像是有意（单文件上传只传 basename）；需确认前端是否可能把 A 目录的选择带到 B 目录 | 前端 `state/uploads.tsx` 的 overwrite 构造 |
| S-6 | **`thumbs.js` 的 `MAX_INPUT_PIXELS` 实际内存峰值** | 取决于 libvips 的 `failOn:"none"` + `rotate()` 是否会整图解码 | 用一个 8000×10000 的 PNG 请求 `/api/fs/thumb`，观察 RSS |

---

## 五、设计取舍（复核后认为**不是**漏洞，不建议"顺手改"）

1. **WebDAV 不套 `guestHiddenPaths`**（`webdav.js:374-385` 注释）：DAV 只接受成员账号（`:305-314` 明确拒绝超管与 Cookie），而 Web 端的 `guestBlocked()` 本来就只对 `role === "guest"` 生效（`safety.js:347-349`）。让 DAV 遵守访客隐藏反而会让"成员在 Web 端看得见、在挂载盘里 404"。**一致，正确。**
2. **WebDAV 不吃 CSRF**：只认 Basic（`webdav.js:289-291`），写方法无法由浏览器表单/跨站请求触发（`PUT`/`PROPFIND` 都需要自定义方法或预检）。这是协议代价下的正确取舍（L-2 保留）。
3. **`/list`、`/download`、`/upload` 不限流**（`ratelimit.js:9-11` 明确写了理由）：画廊预览与连续下载会产生大量请求，限流直接伤体验。代价是"匿名可高频列目录/下载"——但这两件事本身不放大 CPU/磁盘，属可接受。
4. **不限制普通成员读全盘**：这是"共享网盘"的语义（不是多租户隔离）。真正的隔离维度是小组可见范围与访客隐藏，这两条已实现。
5. **软目录一律只读 + `softDirAllowCopyOut` 默认 false**：`blockSoft/blockSoftCopyOut` 的默认策略是对的；即使打开开关，`assertCopySourceSafe` 仍始终生效（F 域已闭环）。
6. **用 `lstat` 拒末级符号链接**：净盘里**不跟随**末级链接（`files.js:10,82`）是有意的（避免"上传一个链接就把服务器任意文件变成网盘内容"），代价是用户不能用符号链接整理目录。中间层链接靠 `realpathish` 规范化 + 边界复判兜住。
7. **回收站覆盖还原直接 `rm`（D-4）**：从"回收站自己不该再进回收站"的角度有一点道理，但**与项目在别处的一致承诺相反**（覆盖=删除→必须可恢复），我仍建议按 D-4 修掉；如果保留，至少要在前端把"覆盖"改成红色危险操作并二次确认。
8. **`validateName` 不拦保留设备名（D-5）**：前一轮已实测"Node 能正常创建、内容不丢"，属健壮性瑕疵而非安全漏洞；修它的收益主要是避免"僵尸条目"。
9. **`pinnedLookup` 在 `DOWNLOAD_URL_ALLOW_HOSTS` 命中时跳过地址判段**：这是"显式放行"的语义（管理员点名要访问 NAS），且仍然固定 IP，不构成 rebinding。
10. **分享密码 6–10 位**（`shares.js:36-37`）：空间不大，但配合 bcrypt(10) + 双维度失败锁定（在**不伪造 IP**的前提下）已够用于"防手滑/防随手转发"。真正的补强点是 F-5。

---

## 六、修复优先级建议

| 顺序 | 事项 | 工作量 |
|---|---|---|
| 1 | **F-1**：`collectZipItems` 改用 `resolved.rel` 做判定与归档名（3 行） | 10 分钟 |
| 2 | **F-4**：DAV `PUT` 覆盖补 `delete` 权限 + 进回收站（5 行） | 15 分钟 |
| 3 | **F-2 / F-3**：`webdav.js` 与 `routes/shares.js` 把可见性判定挪到 `resolveAny()` 之后，统一用 `resolved.rel` | 30 分钟 |
| 4 | **D-3**：`/compress` 拒绝 `dest` 落在任一源目录内部（与 `transfer()` 的 `isSameOrInside` 对称） | 10 分钟 |
| 5 | **F-5**：`/:token/verify` 挂 `rateLimit` + 增加与 IP 无关的 `share:${token}` 失败桶 | 30 分钟 |
| 6 | **D-4 / F-6 / F-7**：覆盖还原进回收站；解压逐段复用 `normRel`；创建侧拒绝敏感名 | 45 分钟 |
| 7 | **L-3 / D-6 / F-8**：`try/catch` 包 `decodeURIComponent`；编码探测只看头 256KB；`download-url` 并发闸门 | 1 小时 |
| 8 | 清理 **L-7** 的 `.migration-backup` 旧凭据；给 `validateName` 补保留名表（D-5） | 10 分钟 |

---

*本报告只读产出，未修改任何源码或数据文件。所有行号对应当前工作区快照；`%TEMP%` 下的验证目录已删除。报告中不含任何口令、密钥或哈希明文。*
