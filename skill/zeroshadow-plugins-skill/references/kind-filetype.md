# fileType 插件：沙箱 iframe + postMessage

`fileType` 负责内置渲染器不认识的格式。插件是**一个自包含的 HTML**，跑在
`sandbox="allow-scripts"`（**没有** `allow-same-origin`）的 iframe 里，靠 `postMessage` 请宿主代跑文件读写。

## 包结构

```
org.example.fooviewer.zip
├── manifest.json
└── index.html          ← entry，必须自包含（CSS/JS 全内联）
```

## manifest.json

```json
{
  "id": "org.example.fooviewer",
  "name": "Foo 预览器",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "fileType",
  "permissions": ["fs.read", "fs.write", "ui.toast"],
  "entry": "index.html",
  "extensions": ["foo"],
  "modes": ["preview", "edit"],
  "settings": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "wrap": { "type": "boolean", "title": "自动换行", "default": true }
    }
  }
}
```

- `permissions` 是**真的会被强制执行**的：不写 `fs.read` 就 `readText` 会被宿主直接拒绝，请求根本不出浏览器
- 只做预览就只声明 `fs.read`；只有要保存才加 `fs.write`
- `modes: ["edit"]` 表示愿意接管编辑（宿主还会看当前用户有没有 `editFiles`，通过 `canWrite` 告诉你）

## 运行环境（决定你能写什么代码）

入口 HTML 的响应头：

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
                         img-src data: blob:; connect-src 'none'; base-uri 'none';
                         form-action 'none'; sandbox allow-scripts
```

由此得到几条硬约束：

| 能做 | 不能做 |
|---|---|
| 内联 `<style>` / `<script>` | 外部 `<script src>`、`<link rel=stylesheet>`、CDN |
| `<img src="data:...">`、`blob:` URL | 任何 `fetch` / XHR / WebSocket（`connect-src 'none'`） |
| `URL.createObjectURL(blob)` 显示二进制 | `<form>` 提交、`<base>` |
| 内存里保存状态 | `localStorage` / `sessionStorage` / `indexedDB`（不透明源直接抛异常） |
| `parent.postMessage` | `document.cookie`、访问父页面 DOM |

**推论**：插件是一个"纯函数式"的渲染器——想要持久状态只能存到文件里（`saveText`）或请管理员做成设置项。

## 协议（apiVersion: 1）

```
plugin → host   { type: "zs:ready" }                                  ← 必须发，否则宿主不会发 init
host   → plugin { type: "zs:init", apiVersion: 1,
                  file: { path, name, size, mtime },
                  settings: {...}, canWrite: boolean, dark: boolean }
plugin → host   { type: "zs:request", id: <number>, method, params }
host   → plugin { type: "zs:response", id, ok: boolean, result?, error? }
plugin → host   { type: "zs:dirty", dirty: boolean }                   ← 可选，驱动"未保存"角标
```

- `id` 必须是数字，自己递增；宿主按它配对请求与响应
- 宿主**只认** `event.source === iframe.contentWindow`；插件侧同理只能认 `event.source === parent`
  （不透明源下 `event.origin` 恒为字符串 `"null"`，拿它判断等于没判断）
- 发 `zs:ready` 两次会收到两次 `zs:init`

## 四个方法的参数与返回值

### `readText` —— 需要 `fs.read`

```js
params:  { path?: string, encoding?: string }   // 省略 path 表示"当前文件"；encoding 省略=自动识别
result:  {
  path, name, size, mtime,
  baseVersion,                  // 保存时原样带回，用于乐观锁
  encoding,                     // utf8 | utf8bom | utf16le | utf16be | gb18030 | big5 | shift_jis | euc-kr | windows-1252 | iso-8859-1
  encodingConfident,            // false = 编码是猜的，建议提示用户可手动切换
  eol,                          // "crlf" | "lf" | "cr"
  content,                      // 换行已统一成 \n
  softReadOnly,                 // true = 该文件在只读的外部映射目录里，保存必然失败
  encodings                     // 可选项 [{id,label,bom}]，可直接做下拉框
}
```

限制：单文件 ≤ 8 MB，超出返回 413。二进制文件返回 415。

### `readBinary` —— 需要 `fs.read`

```js
params:  { path?: string }
result:  { buffer: ArrayBuffer, mime: string }   // ArrayBuffer 以 transfer 方式给你，零拷贝
```

上限 **16 MB**（宿主侧 `MAX_BINARY_BYTES`）。典型用法：

```js
const { buffer, mime } = await call("readBinary", {})
const url = URL.createObjectURL(new Blob([buffer], { type: mime }))
img.src = url            // img-src 允许 blob:
```

### `saveText` —— 需要 `fs.write`（且用户要有 `editFiles`）

```js
params: { path?, content, encoding, eol, baseVersion }
result: { ok: true, bytes, encoding, eol }
```

- `baseVersion` **必须**是最近一次 `readText` 拿到的值。服务端比对不一致 → 抛错（原文含"已被其他人修改"，
  底层 `code: "VERSION_CONFLICT"`），**不会静默覆盖**
- 编码表示不了的字符 → 抛错（服务端宁可拒绝也不写成 `?`）
- 保存**成功之后**版本串就变了：必须重新 `readText`，不能拿旧的 `baseVersion` 再存一次

### `notify` —— 需要 `ui.toast`

```js
params: { message: string }      // 由宿主弹一个提示
result: null
```

## 完整可用示例（`index.html`）

一个能读、能改、能存（带冲突提示与"未保存"角标）的最小实现：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Foo 预览</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; flex-direction: column;
    font: 13px/1.65 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: var(--foreground, #222); background: var(--background, #fff);
  }
  header {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    border-bottom: 1px solid var(--border, rgba(0,0,0,.12));
  }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { margin-left: auto; font-size: 12px; opacity: .65; }
  button {
    font: inherit; padding: 3px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border, rgba(0,0,0,.2)); background: transparent; color: inherit;
  }
  button:hover { background: var(--accent, rgba(0,0,0,.06)); }
  #body {
    flex: 1; min-height: 0; box-sizing: border-box; padding: 16px;
    border: 0; outline: 0; resize: none; font: inherit; color: inherit; background: transparent;
  }
  body.nowrap #body { white-space: pre; overflow: auto; }
</style>
</head>
<body>
<header>
  <span class="name" id="name">加载中…</span>
  <span class="meta" id="meta"></span>
  <button id="save" hidden>保存</button>
</header>
<textarea id="body" spellcheck="false" readonly></textarea>

<script>
(() => {
  "use strict";

  /* ---------- 与宿主通信：把 postMessage 包成 Promise ---------- */
  let seq = 0;
  const pending = new Map();

  function call(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ type: "zs:request", id: id, method: method, params: params || {} }, "*");
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;              // 只认宿主
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "zs:init") { onInit(msg); return; }

    if (msg.type === "zs:response" && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "宿主拒绝了请求"));
    }
  });

  /* ---------- 状态 ---------- */
  const $ = (id) => document.getElementById(id);
  let loaded = null;      // 最近一次 readText 的结果
  let canWrite = false;

  async function onInit(msg) {
    const file = msg.file || {};
    canWrite = msg.canWrite === true;
    $("name").textContent = file.name || "";
    document.body.classList.toggle("nowrap", msg.settings && msg.settings.wrap === false);
    $("save").hidden = !canWrite;
    $("body").readOnly = !canWrite;
    await reload();
  }

  async function reload() {
    try {
      loaded = await call("readText", {});
      $("body").value = loaded.content;
      $("meta").textContent =
        loaded.encoding + " · " + loaded.eol + " · " + loaded.size + " B" +
        (loaded.encodingConfident ? "" : " · 编码为自动猜测");
      markDirty(false);
    } catch (err) {
      $("body").value = "";
      $("meta").textContent = "读取失败：" + err.message;
    }
  }

  /* ---------- 未保存角标 ---------- */
  function markDirty(dirty) {
    parent.postMessage({ type: "zs:dirty", dirty: dirty }, "*");
  }
  $("body").addEventListener("input", () => {
    if (loaded) markDirty($("body").value !== loaded.content);
  });

  /* ---------- 保存 ---------- */
  $("save").addEventListener("click", async () => {
    if (!loaded) return;
    const btn = $("save");
    btn.disabled = true;
    try {
      await call("saveText", {
        content: $("body").value,
        encoding: loaded.encoding,
        eol: loaded.eol,
        baseVersion: loaded.baseVersion,   // ← 少了它就会覆盖别人的改动
      });
      await reload();                      // 版本串已变，必须重读
      await call("notify", { message: "已保存" });
    } catch (err) {
      $("meta").textContent = "保存失败：" + err.message;
      markDirty(true);
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- 告诉宿主：可以发 init 了 ---------- */
  parent.postMessage({ type: "zs:ready" }, "*");
})();
</script>
</body>
</html>
```

## 常见坑

| 现象 | 原因 |
|---|---|
| 预览区一片空白 / 一直"加载中" | 没发 `zs:ready`；或入口不是 `.html`（安装时就该失败） |
| 请求永远不返回 | 忘了在 `zs:request` 里带数字 `id`；或监听器里用了 `event.origin === window.origin` 判断（恒 false） |
| `readText` 报"未声明 fs.read 权限" | manifest 的 `permissions` 漏了 |
| `saveText` 报"没有编辑权限" | 用户没有 `editFiles`，或你只声明了 preview 模式 |
| 保存 409 | 别人改过文件；重新 `readText` 拿新 `baseVersion` 再存 |
| 保存成功但再存一次必 409 | 保存后没重新 `readText` |
| 图标/字体显示不出来 | `default-src 'none'`：字体一律不可用，图片只能 `data:` / `blob:` |
| 用了 `localStorage` 直接白屏 | 不透明源访问存储会抛异常；改用内存变量或设置项 |
| 想请求外部 API | 做不到。需要外部数据请用 `server` 类插件拿数据、写进文件，再由本插件读 |

## 自测清单

- [ ] 未启用时：`GET /api/plugins/list` 里没有它；`GET /api/plugins/entry/<id>` 404
- [ ] 启用后 `GET /api/plugins/list` 出现，且 `permissions` 与 manifest 一致
- [ ] `GET /api/plugins/entry/<id>` 的响应头含 `sandbox allow-scripts` 与 `connect-src 'none'`
- [ ] 打开一个 `.foo` 文件 → 内容正确显示，`meta` 里的编码/换行与服务端一致
- [ ] 在预览页里改动 → 标题栏出现"有未保存的改动"角标
- [ ] 保存 → 提示"已保存"，重新打开内容一致
- [ ] 两个标签页同时改同一文件：后保存的那个看到"已被其他人修改"
- [ ] 把 `permissions` 里的 `fs.read` 去掉重装 → 打开时报"未声明 fs.read 权限"
