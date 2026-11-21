# ZeroShadow / EPan 安全审计报告

- 审计对象：工作区 `D:\编程\Wangyq EPan 网盘\EPan`，`server/package.json` = **zerosha-server 2.1.0**
- 审计时间：2026-11-08
- 审计方式：只读静态审计。通读仓库全部 40+ 篇 Markdown（README / CHANGELOG / docs / .audit / skill / AI-input），逐模块核对 `server/src/**` 与 `web/src/**`，关键路径用 `file:line` 定位；**未修改任何源码，未启动服务，未触碰 `data/`**。
- 结论：整体防护水平高于同类自建网盘，历史审计的多数问题已闭合；本轮新发现 **1 个高危访问控制缺陷**、**1 个中危泄露缺陷**，并确认 6 项历史问题仍未修复。

---

## 一、结论总览

| 编号 | 等级 | 标题 | 位置 | 状态 |
|---|---|---|---|---|
| A | **高** | 小组可见范围（黑名单）可被"复制/移动/重命名/删除祖先目录"绕过 | `server/src/routes/fs.js:1013,1042-1053`、`server/src/groups.js:378-384` | **新发现** |
| B | 中 | 复制"对访客隐藏"目录会生成不受隐藏约束的新路径，匿名访客可读 | `server/src/routes/fs.js:1052`、`:342-353` | **新发现** |
| C | 中 | `/compress` 目标可落在被压缩目录内，输出 zip 被读进自身（磁盘耗尽 / 产物损坏） | `server/src/routes/fs.js:1287-1311,468-493` | 历史 D-3 未修 |
| D | 低中 | 可创建 `.env` / `.jwt-secret` 等"敏感名"文件，之后全局不可见、不可删 | `server/src/routes/fs.js:603-638`、`server/src/safety.js:187-217` | 历史 S-18 未修 |
| E | 低 | 解压不拦 `:` 与 Windows 保留名 → NTFS ADS 隐藏写入 | `server/src/routes/fs.js:1422-1430` | 历史 S-17 未修 |
| F | 低中 | 回收站先移内容后写 meta，写 meta 失败 → 内容从 UI 消失且无法还原 | `server/src/trash.js:123-149` | 新发现 |
| G | 低 | 改密接口无限流，bcrypt 可被已登录成员打满单核 | `server/src/routes/auth.js:98,117` | 历史 S-10 未修 |
| H | 低 | 限流 `peer:` 兜底桶会被自己的 evict 淘汰 | `server/src/ratelimit.js:69-77` | 历史 S-11 未修 |
| I | 低 | 插件安装 zip 先整体解压再查大小（仅超管可达） | `server/src/plugins/store.js:278-282` | 新发现 |
| J | 低 | PDF 链接注解无 URI scheme 白名单 | `server/src/convert/pdf/document.js:248-252` | 新发现 |
| K | 低 | Markdown 引用块递归，深嵌套 `>` 触发栈溢出 | `server/src/convert/markdown.js:351` | 新发现 |
| L | 信息 | 畸形 `%` 编码 500、缺 HSTS/COOP、分享 token 进 stdout、Cookie Secure 信 XFP、`plugins.json` 不在敏感名单、save-file 权限不一致 | 见 §五 | 混合 |

---

## 二、A（高危）：小组黑名单可用"祖先目录"绕过

### 2.1 机制

小组可见范围在 `server/src/groups.js:378-384` 实现为**纯路径字符串前缀匹配**：

```js
export function isVisibleInVisibility(rel, visibility) {
  const path = String(rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const { whitelist, blacklist } = visibility
  if (inList(path, blacklist)) return false      // 黑名单优先，前缀命中即隐藏
  if (!whitelist.length) return true
  return inList(path, whitelist)
}
```

而 `/api/fs/copy`、`/api/fs/move`、`/api/fs/rename`、`/api/fs/delete` 只对**入口路径**做 `assertContextVisible`，对整棵子树不做任何可见性判定：

- `server/src/routes/fs.js:1013`：`assertContextVisible(req, src.rel)`
- `server/src/routes/fs.js:1042-1043`：`mergeFolder(...)` 逐个搬移子项
- `server/src/routes/fs.js:1052-1053`：`copyEntry` / `moveEntry`（`server/src/files.js:138-146` 的 `fs.cp recursive` 无过滤）
- `server/src/routes/fs.js:847-878`：rename 只校验源，`remapHiddenPaths`（`:342-353`）只改 `guestHiddenPaths`，**不动小组可见范围**
- `server/src/routes/fs.js:884+`：delete 递归删除，同样不判子树

### 2.2 攻击链

管理员为组 `g` 配置 `visibility.blacklist = ["proj/finance"]`，成员 `m` 属于 `g`，默认拥有 `copy/move/rename/delete`：

1. `m` 能看到 `proj` 本身（未被隐藏），也能列出其中除 `finance` 以外的内容；
2. `m` 调 `POST /api/fs/copy` 把 `proj` 复制为 `proj-copy`（或 rename `proj` → `proj2`）；
3. 新路径 `proj-copy/finance` 不再命中前缀黑名单 → `m` 可以正常 list / download / 打包；
4. 若是 rename/move，原黑名单条目变成悬空路径，**同组其他成员**也一起获得访问权。

### 2.3 复现（成员会话）

```bash
# 复制祖先目录（dest="" 表示根，targetNames 的 key 必须是规范化 src.rel）
curl -b 'zs_token=<member-jwt>' -H 'X-Requested-With: XMLHttpRequest' \
     -H 'Content-Type: application/json' \
     -d '{"paths":["proj"],"dest":"","targetNames":{"proj":"proj-copy"}}' \
     http://127.0.0.1:12345/api/fs/copy

# 现在可以看见被黑名单隐藏的 finance
curl -b 'zs_token=<member-jwt>' 'http://127.0.0.1:12345/api/fs/list?path=proj-copy'
curl -b 'zs_token=<member-jwt>' 'http://127.0.0.1:12345/api/fs/list?path=proj-copy/finance'
```

rename 变体只需 `POST /api/fs/rename {"path":"proj","newName":"proj2"}`；delete 变体可直接删除包含隐藏内容的祖先目录（完整性破坏）。

### 2.4 影响

- 访问控制失效：成员可读取管理员明确对其隐藏的内容（财务、HR、其他项目）。
- 数据完整性：可删除/移走自己"看不见"的文件。
- 前提：部署使用小组黑名单（`defaultVisibility` 或组 `visibility.blacklist`），且成员保留 copy/move/rename/delete —— 这是默认配置。

### 2.5 修复建议（任一即可，建议 1+3）

1. **入口拒绝**：copy/move/rename/delete 前对源目录做一次"是否包含不可见后代"的检查（有界递归，命中即 403 `contains_hidden_items`）。
2. **路径重映射**：rename/move 时像 `remapHiddenPaths` 一样，把各组的 `visibility.whitelist/blacklist` 中命中源前缀的条目改写为新前缀（只能修 rename/move，修不了 copy）。
3. **复制时过滤**：copy 递归中逐项 `assertContextVisible`，跳过不可见子项（会静默丢内容，需产品确认是否可接受）。

---

## 三、B（中）：复制"对访客隐藏"目录 → 匿名访客可读

`guestHiddenPaths` 只在 move/rename 时重映射（`server/src/routes/fs.js:342-353`，rename 在 `:876` 调用），**copy 不重映射**（`:1052`）。

攻击链：管理员把 `secret/` 加入 `guestHiddenPaths` → 成员（能看到该目录）把它复制为 `secret (1)/` → 新路径不在隐藏列表，`isHiddenFromGuest("secret (1)")` 为 false → 匿名访客（`guestPerms.browse/downloadFile` 默认 true）即可浏览、下载。

这绕过了"访客隐藏"这一管理员控制，且无需分享密码。同类问题也适用于"复制后再打包/下载"。

修复：copy 时对源子树中每个 `guestHiddenPaths` 条目同步追加对应目标路径；或直接禁止复制含 guest-hidden 条目的子树（403）。

---

## 四、C（中）：压缩产物自包含

`POST /api/fs/compress`（`server/src/routes/fs.js:1287-1311`）只校验 `dest` 存在且可见，**没有** `isSameOrInside(dest, src)`：

```js
const dest = resolveSafe(destRel)
blockSoft(dest.rel); assertContextVisible(req, dest.rel); await assertDir(dest.abs)
...
void runCompressJob(job, items, paths, dest.abs, req, vis)
```

`runCompressJob` 先创建输出文件并 `archive.pipe(ws)`，随后 `addDirToArchive`（`:468-493`）遍历源目录，只过滤可见性/敏感名/符号链接，**不跳过正在写的 outFile**：

```js
} else if (stat.isFile()) {
  added += 1
  archive.file(abs, { name: `${zipBase}/${dirent.name}` })
}
```

当 `dest` 位于某个 source 目录内时（如 `{"paths":["proj"],"dest":"proj"}`），zip 会把自身作为条目读入：读到的字节又被写回文件，文件持续增长，直到磁盘写满/写入失败，产物损坏。成员默认有 `compressZip`，且系统无磁盘配额。

修复：`/compress` 拒绝 `dest` 位于任一 source 目录内（`isSameOrInside(dest.abs, item.abs)`），并在 `addDirToArchive` 中显式跳过 `outFile`。

---

## 五、其余问题（低危 / 加固）

| # | 问题 | 位置 | 说明与建议 |
|---|---|---|---|
| D | 可创建 `.env`、`.jwt-secret` 等敏感名文件 | `routes/fs.js:603-638`；`safety.js:283-294` | `create-file` 只做 `validateName`（不拦 `.env`），`/upload`、`/rename` 同理；`isSensitiveAbs`（`safety.js:187-217`）随后把所有列表/打包/下载过滤掉，`resolveAny` 直接 404 → 文件不可见、不可删，只能上机清理，且无配额可静默占盘。修复：目标名再判一次 `isSensitiveAbs(target)`，命中返回 400 `name_not_allowed`。 |
| E | 解压可写 NTFS ADS / 保留设备名 | `routes/fs.js:1422-1430` | 只查 `s.length>200 \|\| s===".."`，未拦 `:`、`CON/NUL/COM1…`。Windows 上 `a.txt:evil` 写入隐藏数据流；建议对每段复用 `normRel` 的规则（含 win32 冒号与保留名）。 |
| F | 回收站 meta 写失败导致内容失联 | `trash.js:123-149` | 先 `rename` 内容到 `data/trash/<id>/content`，后 `writeJsonAtomic(meta)`（`:149`）。若写 meta 抛错（磁盘满/只读/权限），内容已离开原路径，而 `listTrash`（`:173-175`）要求 `meta.id && meta.rel`，该条被跳过 → UI 不可见、无法还原。建议先写 `meta{state:"pending"}` 再移动，成功后改 `state:"ok"`；启动时扫描孤儿目录。 |
| G | 改密无限流 | `routes/auth.js:98,117` | 只有 `requireRole/requirePerm`，无 `rateLimit`，错误口令也照跑 `bcrypt.compare`。已登录成员可循环调用打满单核。建议挂 `rateLimit` 并对失败计数。 |
| H | 限流兜底桶被淘汰 | `ratelimit.js:69-77` | `evict()` 按 `windowStart` 排序删除最老 10%，`peer:` 桶（6× 上限）最先被删；开启 `TRUST_PROXY` 后可用 XFF 轮换 IP 桶，只剩 peer 桶兜底，而它又被优先淘汰。建议 `peer:` 桶不参与淘汰。 |
| I | 插件 zip 炸弹（超管） | `plugins/store.js:278-282` | `entry.buffer()` 先整块解压，之后才检查 `Buffer.length > 2MB`；2MB 包可解出 GB 级内存。改为流式计数（参考 `routes/fs.js:1330` 的 `readZipEntryLimited`）。 |
| J | PDF 链接无 scheme 白名单 | `convert/pdf/document.js:248-252` | `/URI (${escapeLiteral(link.url)})` 结构安全（转义了 `\()`），但 `javascript:`/`file:` 会写进 PDF，点击时由阅读器处理。建议只允许 `http/https/mailto`。 |
| K | 引用块递归栈溢出 | `convert/markdown.js:351` | `parseMarkdown(inner.join("\n"))` 递归，嵌套深度跟随 `>` 数量；深嵌套抛 RangeError（任务失败）。建议限制引用嵌套层数。 |
| L1 | 畸形 `%` 编码 500 | `compress.js:139` | `decodeURIComponent` 无 try/catch；静态资源路径可被构造 500（噪声/日志污染）。 |
| L2 | 缺 HSTS/COOP/CORP | `server/index.js:86-93` | 仅有 nosniff/XFO/Referrer-Policy/Permissions-Policy。HTTPS 部署建议补 HSTS。 |
| L3 | 分享 token 进 stdout | `server/index.js:81` | `[REQ] ${req.path}` 会把 `/api/share/<token>` 打进控制台/日志采集。建议对 `/api/share/` 路径脱敏。 |
| L4 | Cookie `Secure` 信客户端头 | `auth.js:41` | `req.secure \|\| x-forwarded-proto==="https"`，不受 `TRUST_PROXY` 约束；伪造该头只会让 Cookie 多一个 Secure 属性（低），但语义上应由 `req.secure` 决定。 |
| L5 | `plugins.json` 不在敏感名单 | `safety.js:143-163` | 名单里只有 `plugins` 目录。若软目录映射到项目根，`data/plugins.json`（含插件私有设置）可被读取。建议加入 `plugins.json`。 |
| L6 | save-file 权限不一致 | `routes/fs.js:1559-1648` | 仅需 `editFiles`：可覆盖已有文件而不要求 `delete`、不进回收站；无 `baseVersion` 时只告警；无 `upload` 也能新建文件。属权限模型取舍，建议至少对"新建"要求 `upload`。 |

---

## 六、历史审计中仍未修复的项（本次复核确认）

以下项在 `AUDIT-2026-10-24.md` / `.audit/*.md` 中已列出，2026-11-08 复核仍在：

- **S-10/A-1** 改密无限流（本报告 G）
- **S-11/A-2** `peer:` 兜底桶被淘汰（H）
- **S-12/A-3** 请求路径含分享 token 落 stdout（L3）
- **S-14/A-5** Cookie Secure 由 XFF 决定（L4）
- **S-17/F-6** 解压 ADS（E）
- **S-18/F-7** 创建敏感名文件（D）
- **S-9** `plugins.json` 未入敏感名单（L5）
- **D-3** 压缩自嵌套（C）
- **D-4** 回收站"覆盖还原"直接 `fs.rm`（`trash.js:222`）
- **D-5** Windows 保留设备名（`safety.js:283` 的 `INVALID_NAME_CHARS` 不含保留名）
- **D-6** 编码探测全文解码放大（`encoding.js:90,105`）
- **L-3/S-16** 畸形编码 500（L1）
- **L-4/S-15** 缺 HSTS/COOP（L2）
- **L-5** 登录锁定仅内存（重启清零）
- **A-6** 超管失败路径缺 dummy bcrypt（时间侧信道）
- **A-7/M-1** Windows 凭据文件 ACL（`chmod` 在 Win 无效，需 `icacls`）
- **S-20** 审计事件缺 `plugin_*`
- **L-7** 仓库残留 `.migration-backup/.../server.env`、`server-data/.jwt-secret`
- **D-7** `web/index.html` 第三方脚本无 SRI
- **fe-F-3** OOXML 预览无节点预算
- **fe-F-4** 分享票据放 URL 查询串
- **fe-F-6** `vite.config.ts` `host: true`
- **fe-F-7** 预览切换文件不清空 `text`

---

## 七、已核实为"防护到位"的设计（避免误报）

- `safety.js` 路径解析：`realpathSync.native` 归一化 + 根边界检查 + `..`/NUL/win32 `:` 拒绝 + 敏感名大小写折叠；8.3 短名、符号链接、junction 均在判定前展开。
- `/api/fs/download` 对软目录也执行 `guestBlocked`（`fs.js:261-263`）；HTML/SVG 内联强制 `CSP: sandbox allow-scripts`（`:300-304`）。
- 覆盖写统一走 `removeForOverwrite`：要求 `delete` 权限、优先入回收站（`fs.js:832-845`）；`/delete` 失败项进 `failed[]`，不静默降级。
- `/zip`、`/compress`、`/extract` 逐条过滤可见性与敏感名，解压用"实际字节"计数（`readZipEntryLimited`，`:1330`），不信 zip 声明。
- `/stat`、`/details`、`/thumb`、`/search` 均调用 `assertContextVisible`。
- WebDAV：默认关闭、只认 Basic、拒 Cookie、拒超管、`Depth: infinity` 403、锁表 2000、64KB 体、1200 req/min。
- CSRF 双层校验（`X-Requested-With` + `Sec-Fetch-Site`/`Origin`），DAV 走 Basic 故豁免。
- 插件：安装默认禁用、仅超管可装、包 2MB/解压 10MB/300 条目、manifest 白名单、iframe `sandbox="allow-scripts"` 无 `allow-same-origin`、`event.origin==="null"` 校验。
- 前端 Markdown：先整体转义再解析、13 个无属性白名单标签、`BAD_URL` 拦 `javascript:/vbscript:/data:`；全站仅一处 `dangerouslySetInnerHTML`。
- 日志：控制台换行注入已过滤，CSV 公式注入已加前导单引号；备份文件 0600；数据文件原子写 + 覆盖前快照。

---

## 八、文档与实现不一致（供维护者修正）

1. `docs/API参考.md` 写 `GET /api/fs/file` 需要 `browse`，代码实际要求 `preview || downloadFile`（代码更严）。
2. 插件 fileType/server 是否"已可用"：`管理员指南.md`/`常见问题.md` 说未生效，`插件开发.md` 说已实现。
3. 备份受管文件数量有 4/5/6 三种说法（实际 6）。
4. `downloadUrlMaxMB=0` 的语义：API 文档说不限，配置参考说非法。
5. README 版本 2.0.0 vs `CHANGELOG.md` 2.1.0。
6. `security-test.ps1` 的组数/项数描述与实际不符。
7. WebDAV 方法数文档写 11，实际 12（含 PROPPATCH）。
8. 组长默认能力、设置页标签数（12/13）描述不一致。

---

## 九、修复优先级

| 优先级 | 事项 |
|---|---|
| **P0** | A（黑名单祖先绕过）、B（guest-hidden 复制外泄） |
| **P1** | C（压缩自嵌套，磁盘耗尽）、D（敏感名隐形文件）、F（回收站 meta 失联）、G（改密限流）、E（ADS） |
| **P2** | H（peer 桶）、L3（token 日志）、L4（Cookie Secure）、L5（plugins.json）、L2（安全头）、L1（500） |
| **P3** | I/J/K（超管/PDF/Markdown 边缘）、文档一致性、历史遗留低危 |

---

*本报告为只读审计产物；所有结论均可在所列 `file:line` 复核。*
