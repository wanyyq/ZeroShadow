/* ============================================================================
 * ZeroShadow 兼容模式（robustness）
 *
 * 用途：在跑不动 React / Tailwind 的老机器（IE11、Win7 上的老 Chrome 等）上，
 *       提供最基本的登录 + 文件操作能力。
 *
 * 硬性约束（改这个文件时请一并遵守）：
 *   1. **ES5**：不用 let/const/箭头函数/模板字符串/解构/默认参数/class/for-of。
 *   2. **不用 Promise / fetch**：旧浏览器没有。全部 XHR + 回调，回调签名统一
 *      `function (err, data)`，err 为 null 表示成功。
 *   3. **不引入任何外部库**：离线可用性 + 避免再踩 CDN / 构建工具的坑。
 *   4. **不用现代 DOM API**：classList / dataset / closest / Object.assign /
 *      Array.prototype.includes / String.prototype.startsWith 一律不用。
 *   5. 所有 HTML 输出必须经 esc() 转义 —— 文件名与路径都是用户可控输入。
 *   6. 不用内联事件属性（CSP 的 script-src 'self' 会拦），全部用 JS 赋值。
 *
 * 安全设计（与后端约定，请对照 server/src/auth.js 的 csrfGuard）：
 *   - 每个请求都带 `X-Requested-With: XMLHttpRequest`，这是 CSRF 第一道校验。
 *     同源 XHR 设置该头不触发 CORS 预检，因此服务端无需为此做任何放行。
 *   - 不使用 JSONP、不 eval、不把服务端返回的内容当 HTML 插入
 *     （除经 esc() 的文件名外，预览文本一律走文本节点）。
 *   - 会话沿用服务端的 httpOnly Cookie；本页不读也不写任何凭据。
 * ========================================================================== */
(function () {
  "use strict";

  /* ======================================================== 配置与常量 == */

  var CFG = {
    /** 与服务端 MAX_FILES_PER_REQUEST 保持一致（单次请求的文件数上限） */
    batchSize: 100,
    /** localStorage 键：主题。与正常页面的 zs-theme 刻意区分，互不干扰 */
    themeKey: "zs-robustness-theme",
    /** localStorage 键：最近使用的账号（只为少打一次字） */
    userKey: "zs-robustness-user",
    srvErr: "服务器内部错误"
  };

  /** 可按行内方式预览（交给 <img>/<video>/<audio>/<iframe> 原生渲染）的扩展名 */
  var NATIVE = {
    jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
    bmp: "image", avif: "image", ico: "image", svg: "image",
    mp4: "video", webm: "video", ogv: "video", mov: "video", m4v: "video",
    mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio",
    pdf: "pdf"
  };

  /** 按纯文本预览的扩展名（与正常页面 lib/format.ts 的清单对齐） */
  var TEXTUAL = {
    txt: 1, md: 1, json: 1, log: 1, csv: 1, js: 1, ts: 1, css: 1, py: 1,
    yml: 1, yaml: 1, xml: 1, ini: 1, conf: 1, rst: 1, adoc: 1, tex: 1,
    bat: 1, ps1: 1, vbs: 1, lua: 1, rb: 1, php: 1, pl: 1, sql: 1,
    toml: 1, properties: 1, graphql: 1, rtf: 1, org: 1, cmake: 1, gradle: 1,
    dockerfile: 1, makefile: 1, ".gitignore": 1, ".env": 1
  };

  /** 列表里显示的图标标记（纯 ASCII，避免老系统缺字形） */
  var ICONS = {
    image: "[I]", video: "[V]", audio: "[A]", pdf: "[P]", text: "[T]",
    archive: "[Z]", app: "[E]", file: "[-]", dir: "[D]", dirsoft: "[R]", link: "[>]"
  };

  var KIND_BY_EXT = {
    jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
    bmp: "image", avif: "image", ico: "image", svg: "image",
    mp4: "video", webm: "video", mov: "video", mkv: "video", wmv: "video",
    flv: "video", "3gp": "video", m4v: "video",
    mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio",
    pdf: "pdf",
    zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
    exe: "app", msi: "app", apk: "app", iso: "app"
  };

  /* ============================================================== 工具 == */

  function isFn(v) { return typeof v === "function"; }
  function noop() {}

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function has(obj, key) {
    return obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function trim(s) {
    return String(s === null || s === undefined ? "" : s).replace(/^\s+|\s+$/g, "");
  }

  /** 名称 → 小写扩展名；无点则返回整个名称的小写（让 .env / Dockerfile 能命中） */
  function extOf(name) {
    var s = String(name === null || name === undefined ? "" : name);
    var i = s.lastIndexOf(".");
    return (i > 0 ? s.substring(i + 1) : s).toLowerCase();
  }

  function isDir(e) { return !!(e && e.type === "dir"); }
  function isShortcut(e) { return !!(e && e.type === "shortcut"); }
  function isSoft(e) { return !!(e && e.softReadOnly); }

  /** 显示名：快捷方式用自定义名，其余用文件名 */
  function displayName(e) {
    if (isShortcut(e) && e.shortcut && e.shortcut.displayName) return String(e.shortcut.displayName);
    return String((e && e.name) || "");
  }

  function joinPath(dir, name) {
    return dir ? dir + "/" + name : name;
  }

  function parentOf(p) {
    var s = String(p === null || p === undefined ? "" : p);
    var i = s.lastIndexOf("/");
    return i > 0 ? s.substring(0, i) : "";
  }

  /** 取 basename（同时兼容 / 与 \ 两种分隔符） */
  function lastSegment(p) {
    var s = String(p === null || p === undefined ? "" : p).replace(/\\/g, "/");
    var parts = s.split("/");
    return parts[parts.length - 1] || "";
  }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return "-";
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var value = n;
    var unit = "";
    for (var i = 0; i < units.length; i++) {
      value = value / 1024;
      unit = units[i];
      if (value < 1024) break;
    }
    return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + unit;
  }

  function formatDate(ms) {
    var n = Number(ms);
    if (!n) return "-";
    var d = new Date(n);
    if (isNaN(d.getTime())) return "-";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /** HTML 转义：凡是把用户可控字符串拼进 innerHTML 的地方都必须先过这里 */
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function byId(id) { return document.getElementById(id); }

  /**
   * 建元素。extra 里：
   *   text / html  → 文本或 HTML 内容（html 只用于已转义的串）
   *   cls          → className
   *   函数         → 直接赋值给同名属性（onclick / onchange / onkeydown …）
   *   其它         → setAttribute
   * 刻意支持函数赋值，是为了避免内联事件属性（CSP 不允许）。
   */
  function el(tag, extra, children) {
    var node = document.createElement(tag);
    if (extra) {
      for (var k in extra) {
        if (!has(extra, k)) continue;
        var v = extra[k];
        if (v === null || v === undefined) continue;
        if (k === "text") { node.appendChild(document.createTextNode(String(v))); }
        else if (k === "html") { node.innerHTML = String(v); }
        else if (k === "cls") { node.className = String(v); }
        else if (k === "value") { node.value = String(v); }
        else if (k === "checked") { node.checked = !!v; }
        else if (isFn(v)) { node[k] = v; }
        else { node.setAttribute(k, String(v)); }
      }
    }
    if (children && children.length) {
      for (var i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i]);
      }
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /**
   * 解析响应体。
   * 为什么不用 XHR 的 `responseType = "json"`：IE11 不支持（会抛异常），
   * 所以一律拿 responseText 自己 JSON.parse；解析失败再退回原始文本，
   * 便于识别"服务端返回了非 JSON"这种真实故障。
   */
  function parseResponse(xhr) {
    var text = "";
    try { text = xhr.responseText || ""; } catch (e) { text = ""; }
    if (!text) return null;
    try { return JSON.parse(text); }
    catch (e2) { return { __raw: text }; }
  }

  function errMessage(status, data) {
    if (data && typeof data === "object" && data.error) return String(data.error);
    if (data && data.__raw) return "请求失败 (" + status + ")";
    if (status === 0) return "网络连接失败，请检查服务是否在线";
    if (status === 413) return "请求体过大";
    if (status >= 500) return CFG.srvErr;
    return "请求失败 (" + status + ")";
  }

  /* ============================================================ 本地存储 == */
  /* 全部包在 try 里：隐私模式 / 组策略禁用本地存储时读写都会抛异常 */

  function storeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storeSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  /* ================================================================ API == */

  function encodeQuery(params) {
    if (!params) return "";
    var parts = [];
    for (var k in params) {
      if (!has(params, k)) continue;
      var v = params[k];
      if (v === undefined || v === null || v === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  /**
   * 通用请求。回调 callback(err, data)：err 为 Error 或 null。
   * 所有请求都带 X-Requested-With —— csrfGuard 的第一道校验，删了会 403。
   */
  function req(method, path, options, callback) {
    var opts = options || {};
    var cb = isFn(callback) ? callback : noop;
    var xhr;
    try {
      xhr = new XMLHttpRequest();
    } catch (e) {
      cb(new Error("当前浏览器不支持 XMLHttpRequest，无法使用兼容模式"));
      return;
    }

    var url = "/api" + path + encodeQuery(opts.query);
    var body = null;
    if (opts.body !== undefined && opts.body !== null) {
      try { body = JSON.stringify(opts.body); }
      catch (e2) { cb(new Error("请求内容无法序列化")); return; }
    }

    try { xhr.open(method, url, true); }
    catch (e3) { cb(new Error("请求地址无效")); return; }

    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
    if (body !== null) xhr.setRequestHeader("Content-Type", "application/json");

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var status = xhr.status;
      var data = parseResponse(xhr);
      if (status === 0) { cb(new Error("网络连接失败，请检查服务是否在线")); return; }
      if (status >= 200 && status < 300) { cb(null, data); return; }
      var err = new Error(errMessage(status, data));
      err.status = status;
      cb(err, data);
    };

    try { xhr.send(body); }
    catch (e4) { cb(new Error("请求发送失败：" + (e4 && e4.message ? e4.message : "未知原因"))); }
  }

  var API = {
    get: function (path, query, cb) { req("GET", path, { query: query }, cb); },
    post: function (path, body, query, cb) { req("POST", path, { body: body, query: query }, cb); }
  };

  /** 下载 / 打包 / 预览用的直链（GET 无需 CSRF 头，让浏览器自己导航过去即可） */
  function downloadHref(path, inline) {
    return "/api/fs/download?path=" + encodeURIComponent(path) + (inline ? "&inline=1" : "");
  }

  function zipHref(paths) {
    return "/api/fs/zip?paths=" + encodeURIComponent(JSON.stringify(paths));
  }

  /** 触发下载但不离开当前页：用一个隐藏 iframe（比 window.open 不容易被拦截） */
  function navigateToDownload(href) {
    var frame = el("iframe", {
      cls: "hidden-dl",
      style: "position:absolute;width:0;height:0;border:0;visibility:hidden;"
    });
    frame.src = href;
    document.body.appendChild(frame);
    // 10 秒后回收：旧浏览器上 iframe 必须在文档里才会真正开始下载
    window.setTimeout(function () {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }, 10000);
  }

  /**
   * 上传一批文件。
   * 用 FormData；旧浏览器取不到上传进度（没有 xhr.upload），
   * 此时 onProgress 不会被调用，界面显示"上传中…"而不是假进度。
   */
  function upload(path, files, overwriteNames, onProgress, callback) {
    var cb = isFn(callback) ? callback : noop;
    if (!window.FormData) { cb(new Error("当前浏览器不支持 FormData，无法上传")); return; }

    var xhr;
    try { xhr = new XMLHttpRequest(); }
    catch (e) { cb(new Error("当前浏览器不支持 XMLHttpRequest")); return; }

    var form = new FormData();
    // 字段名必须是 files（服务端 busboy 只认这个）
    for (var i = 0; i < files.length; i++) form.append("files", files[i], files[i].name);

    var query = { path: path };
    if (overwriteNames && overwriteNames.length) {
      query.overwrite = JSON.stringify(overwriteNames);
    }
    var url = "/api/fs/upload" + encodeQuery(query);

    try { xhr.open("POST", url, true); }
    catch (e2) { cb(new Error("上传地址无效")); return; }

    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

    if (xhr.upload && isFn(onProgress)) {
      xhr.upload.onprogress = function (evt) {
        if (!evt) return;
        if (evt.lengthComputable === false) return;
        onProgress(evt.loaded || 0, evt.total || 0);
      };
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var status = xhr.status;
      var data = parseResponse(xhr);
      if (status === 0) { cb(new Error("网络中断，上传失败")); return; }
      if (status >= 200 && status < 300) { cb(null, data); return; }
      // 413 的响应体形如 { results: [...], limitMB }，没有 error 字段，
      // 真正有用的原因（"超出大小限制 (512MB)"）藏在 results[].error 里。
      var detail = "";
      if (data && isArray(data.results)) {
        for (var j = 0; j < data.results.length; j++) {
          if (data.results[j] && !data.results[j].ok && data.results[j].error) {
            detail = String(data.results[j].error);
            break;
          }
        }
      }
      var err = new Error(detail || errMessage(status, data));
      err.status = status;
      cb(err, data);
    };

    try { xhr.send(form); }
    catch (e3) { cb(new Error("上传发送失败：" + (e3 && e3.message ? e3.message : "未知原因"))); }
  }

  /* =============================================================== 状态 == */

  var LOGIN_PERMS = {
    fileWrite: false, browse: false, upload: false, uploadFolders: false,
    downloadFile: false, downloadFolder: false, preview: false, copy: false,
    move: false, rename: false, delete: false, mkdir: false,
    manageGuestVisibility: false, details: false, htmlPreview: false,
    editFiles: false, compressZip: false, extractZip: false,
    downloadUrl: false, changePassword: false
  };

  var state = {
    ready: false,
    me: { role: "guest", username: null, userId: null, perms: LOGIN_PERMS, groupId: "default", group: null },
    authError: "",
    path: "",
    query: "",
    entries: [],
    loading: false,
    selected: {},
    clipboard: null, // { mode: "copy"|"cut", items: [{path,name,type}] }
    dialog: null,
    preview: null
  };

  function perm(name) {
    var p = state.me && state.me.perms;
    return !!(p && p[name]);
  }

  function roleLabel(role) {
    if (role === "superadmin") return "超级管理员";
    if (role === "member") return "团队成员";
    return "访客";
  }

  function selectedEntries() {
    var out = [];
    for (var i = 0; i < state.entries.length; i++) {
      var e = state.entries[i];
      if (state.selected[e.name]) out.push(e);
    }
    return out;
  }

  function selectedCount() {
    var n = 0;
    for (var k in state.selected) {
      if (has(state.selected, k) && state.selected[k]) n++;
    }
    return n;
  }

  function clearSelection() { state.selected = {}; }

  /** 当前列表里的所有条目名（用于冲突检测与自动改名） */
  function knownNames() {
    var s = {};
    for (var i = 0; i < state.entries.length; i++) s[state.entries[i].name] = true;
    return s;
  }

  function allSoft(list) {
    if (!list || !list.length) return false;
    for (var i = 0; i < list.length; i++) {
      if (!isSoft(list[i])) return false;
    }
    return true;
  }

  /* ============================================================== Toast == */

  var toastTimer = null;

  function toast(message, kind) {
    var node = byId("toast");
    if (!node) return;
    node.className = "toast on" + (kind === "error" ? " is-error" : kind === "ok" ? " is-ok" : "");
    node.innerHTML = esc(message);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      node.className = "toast";
      toastTimer = null;
    }, kind === "error" ? 5200 : 2600);
  }

  /* ============================================================== 主题 == */

  function currentTheme() {
    var stored = storeGet(CFG.themeKey);
    if (stored === "dark") return "dark";
    if (stored === "light") return "light";
    return "system";
  }

  function applyTheme(theme) {
    var dark = theme === "dark";
    if (theme === "system") {
      dark = false;
      if (window.matchMedia) {
        try { dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { dark = false; }
      }
    }
    var root = document.documentElement;
    var cls = (" " + root.className + " ").replace(/ dark /g, " ").replace(/\s+/g, " ");
    root.className = trim(cls) + (dark ? " dark" : "");
  }

  function cycleTheme() {
    var cur = currentTheme();
    var next = cur === "light" ? "dark" : cur === "dark" ? "system" : "light";
    storeSet(CFG.themeKey, next);
    applyTheme(next);
    render();
  }

  /* ============================================================= 渲染层 == */

  var app = null;

  function appRoot() {
    if (!app) app = byId("app");
    return app;
  }

  function render() {
    var root = appRoot();
    if (!root) return;
    clear(root);
    if (!state.ready) {
      root.appendChild(el("div", { cls: "loading", text: "正在加载…" }));
      return;
    }
    if (state.me.role === "guest") {
      root.appendChild(viewLogin());
      return;
    }
    root.appendChild(viewShell());
    if (state.preview) root.appendChild(viewPreview());
    if (state.dialog) renderDialog(root);
  }

  /* ------------------------------------------------------------ 登录页 -- */

  function viewLogin() {
    var card = el("div", { cls: "login-card" });

    var nameInput = el("input", {
      id: "lg-user", cls: "form-input", type: "text",
      autocomplete: "username", spellcheck: "false"
    });
    // 旧浏览器不一定会按 autocomplete 自动填充，手动补一个最近用户名
    var lastUser = storeGet(CFG.userKey);
    if (lastUser) nameInput.value = lastUser;

    var pwdInput = el("input", {
      id: "lg-pwd", cls: "form-input", type: "password", autocomplete: "current-password"
    });

    var errBox = el("div", { cls: "err", text: state.authError || "" });
    var btn = el("button", {
      cls: "btn btn-primary", type: "button", text: "登录",
      style: "width:100%;padding:8px 0;"
    });

    var submit = function () {
      var username = trim(nameInput.value);
      var password = String(pwdInput.value || "");
      if (!username || !password) {
        state.authError = "请输入用户名和密码";
        errBox.innerHTML = esc(state.authError);
        return;
      }
      state.authError = "";
      errBox.innerHTML = "";
      setBusy(btn, true, "登录中…");
      API.post("/auth/login", { username: username, password: password }, null, function (err) {
        setBusy(btn, false, "登录");
        if (err) {
          state.authError = err.message || "登录失败";
          errBox.innerHTML = esc(state.authError);
          return;
        }
        storeSet(CFG.userKey, username);
        state.path = "";
        state.query = "";
        clearSelection();
        bootstrap();
      });
    };
    btn.onclick = submit;

    var enterKey = function (e) {
      var ev = e || window.event;
      if (ev && ev.keyCode === 13) { submit(); return false; }
      return true;
    };
    nameInput.onkeydown = enterKey;
    pwdInput.onkeydown = enterKey;

    card.appendChild(el("h1", { cls: "login-title", text: "ZeroShadow" }));
    card.appendChild(el("p", { cls: "login-sub", text: "兼容模式 · 适配旧浏览器" }));
    card.appendChild(el("div", { cls: "form-row" }, [
      el("label", { cls: "form-label", "for": "lg-user", text: "用户名" }),
      nameInput
    ]));
    card.appendChild(el("div", { cls: "form-row" }, [
      el("label", { cls: "form-label", "for": "lg-pwd", text: "密码" }),
      pwdInput
    ]));
    card.appendChild(errBox);
    card.appendChild(el("div", { cls: "form-row" }, [btn]));

    var foot = el("div", { cls: "login-foot" }, [
      el("a", { href: "/", cls: "linkbtn", text: "返回正常页面" })
    ]);

    return el("div", { cls: "login-page" }, [card, foot]);
  }

  /** 按钮忙碌态：禁用 + 换文案，避免重复提交 */
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.setAttribute("data-label", btn.innerHTML);
      btn.disabled = true;
      btn.innerHTML = esc(label || "处理中…");
    } else {
      btn.disabled = false;
      btn.innerHTML = esc(label || btn.getAttribute("data-label") || "确定");
    }
  }

  /* ------------------------------------------------------------- 主框架 -- */

  function viewShell() {
    var row = el("div", { cls: "shell-row" });
    row.appendChild(viewSide());
    row.appendChild(viewMain());
    return el("div", { cls: "shell" }, [row]);
  }

  function viewSide() {
    var side = el("div", { cls: "side" });

    var brand = el("div", { cls: "brand" });
    brand.appendChild(el("span", { cls: "brand-mark", text: "ZS" }));
    brand.appendChild(el("span", { cls: "brand-name", text: "ZeroShadow" }));
    brand.appendChild(el("span", { cls: "brand-ver", text: "兼容模式" }));
    side.appendChild(brand);

    var list = el("ul", { cls: "nav-list" });
    list.appendChild(el("li", null, [el("a", { cls: "nav-item is-active", href: "javascript:void(0)", text: "文件" })]));
    side.appendChild(list);

    side.appendChild(el("div", { cls: "nav-sep" }));
    side.appendChild(el("div", {
      cls: "side-note",
      text: "此页面不依赖现代框架，仅提供登录与基本文件操作。管理、小组、待办、在线编辑请回正常页面。"
    }));
    side.appendChild(el("div", { cls: "nav-sep" }));
    side.appendChild(el("div", { cls: "side-note" }, [
      el("a", { href: "/", cls: "linkbtn", text: "返回正常页面" })
    ]));

    return side;
  }

  function viewMain() {
    var cell = el("div", { cls: "main-cell" });

    /* 顶栏 */
    var topbar = el("div", { cls: "topbar" });
    var right = el("div", { cls: "topbar-right" });
    right.appendChild(el("span", {
      cls: "who",
      text: (state.me.username || "访客") + "（" + roleLabel(state.me.role) + "）"
    }));
    right.appendChild(themeButton());
    right.appendChild(el("button", { cls: "btn btn-sm", type: "button", text: "退出", onclick: doLogout }));
    topbar.appendChild(right);
    topbar.appendChild(el("span", { cls: "topbar-title", text: "文件" }));
    cell.appendChild(topbar);

    /* 加载条 */
    cell.appendChild(el("div", { cls: "loadbar" + (state.loading ? " on" : "") }));

    /* 工具栏 / 面包屑 / 兼容性提示 / 列表 / 状态条 */
    cell.appendChild(viewToolbar());
    cell.appendChild(viewCrumbs());

    var warns = compatWarnings();
    if (warns) cell.appendChild(warns);

    cell.appendChild(viewList());
    cell.appendChild(viewStatusBar());

    return cell;
  }

  function themeButton() {
    var t = currentTheme();
    var label = t === "dark" ? "深色" : t === "light" ? "浅色" : "跟随系统";
    return el("button", {
      cls: "btn btn-sm", type: "button",
      text: "主题：" + label,
      title: "在 浅色 / 深色 / 跟随系统 之间切换",
      onclick: cycleTheme
    });
  }

  /** 这个浏览器支持"选择文件夹"吗？用 in 检测，不能读属性值——
   *  用 setAttribute 设上的自定义属性在多数浏览器里不会变成同名 JS 属性。 */
  function supportsFolderPick() {
    try {
      return "webkitdirectory" in document.createElement("input");
    } catch (e) {
      return false;
    }
  }

  function viewToolbar() {
    // id 用于 refreshToolbar()：勾选变化时只替换这一段，避免整表重绘丢滚动位置
    var bar = el("div", { cls: "bar", id: "toolbar" });

    var fileInput = el("input", {
      id: "up-file", type: "file", multiple: "multiple",
      style: "position:absolute;left:-9999px;width:1px;height:1px;"
    });
    fileInput.onchange = function () {
      var files = fileInput.files;
      if (files && files.length) startUpload(files, false);
      try { fileInput.value = ""; } catch (e) { /* 老 IE 不允许清空，忽略 */ }
    };
    bar.appendChild(fileInput);

    var folderInput = el("input", {
      id: "up-dir", type: "file", multiple: "multiple",
      webkitdirectory: "true", directory: "true",
      style: "position:absolute;left:-9999px;width:1px;height:1px;"
    });
    folderInput.onchange = function () {
      var files = folderInput.files;
      if (files && files.length) startUpload(files, true);
      try { folderInput.value = ""; } catch (e) { /* 同上 */ }
    };
    bar.appendChild(folderInput);

    var inSoft = state.entries.length > 0 && allSoft(state.entries);
    var canUpload = perm("upload") && !inSoft;
    var canMkdir = perm("mkdir") && !inSoft;

    bar.appendChild(buttonWithPerm("上传文件", canUpload, function () {
      if (!canUpload) { deny(inSoft); return; }
      fileInput.click();
    }));

    if (supportsFolderPick() && perm("uploadFolders")) {
      bar.appendChild(buttonWithPerm("上传文件夹", canUpload, function () {
        if (!canUpload) { deny(inSoft); return; }
        folderInput.click();
      }));
    }

    bar.appendChild(buttonWithPerm("新建文件夹", canMkdir, function () {
      if (!canMkdir) { deny(inSoft); return; }
      newFolderDialog();
    }));

    bar.appendChild(el("span", { cls: "sep-v" }));

    /* 粘贴：剪贴板有内容时才出现 */
    if (state.clipboard && state.clipboard.items.length) {
      var n = state.clipboard.items.length;
      var modeOk = state.clipboard.mode === "copy" ? perm("copy") : perm("move");
      bar.appendChild(buttonWithPerm("粘贴 " + n + " 项", modeOk, function () {
        if (inSoft) { toast("外部映射目录仅支持只读操作", "error"); return; }
        if (!modeOk) { toast("没有权限执行此操作", "error"); return; }
        doPaste(state.path);
      }));
      bar.appendChild(el("button", {
        cls: "btn btn-sm", type: "button", text: "清空剪贴板",
        onclick: function () { state.clipboard = null; render(); }
      }));
      bar.appendChild(el("span", { cls: "sep-v" }));
    }

    var count = selectedCount();
    if (count > 0) {
      bar.appendChild(el("span", { cls: "hint", style: "margin-right:6px;", text: "已选 " + count + " 项：" }));
      bar.appendChild(el("button", {
        cls: "btn btn-sm", type: "button", text: "下载",
        onclick: function () { doDownload(selectedEntries()); }
      }));
      if (count === 1 && perm("rename")) {
        bar.appendChild(el("button", {
          cls: "btn btn-sm", type: "button", text: "重命名",
          onclick: function () { doRename(selectedEntries()[0]); }
        }));
      }
      if (perm("copy")) {
        bar.appendChild(el("button", {
          cls: "btn btn-sm", type: "button", text: "复制",
          onclick: function () { doClipboard("copy"); }
        }));
        bar.appendChild(el("button", {
          cls: "btn btn-sm", type: "button", text: "复制到…",
          onclick: function () { pickDestination("copy"); }
        }));
      }
      if (perm("move")) {
        bar.appendChild(el("button", {
          cls: "btn btn-sm", type: "button", text: "剪切",
          onclick: function () { doClipboard("cut"); }
        }));
        bar.appendChild(el("button", {
          cls: "btn btn-sm", type: "button", text: "移动到…",
          onclick: function () { pickDestination("move"); }
        }));
      }
      if (perm("delete")) {
        bar.appendChild(el("button", {
          cls: "btn btn-sm btn-danger", type: "button", text: "删除",
          onclick: function () { doDelete(selectedEntries()); }
        }));
      }
      bar.appendChild(el("button", {
        cls: "btn btn-sm", type: "button", text: "取消选择",
        onclick: function () { clearSelection(); render(); }
      }));
    }

    /* 右侧：搜索 + 刷新 */
    var rightSide = el("span", { style: "float:right;" });

    var searchInput = el("input", {
      cls: "field field-search", type: "text",
      placeholder: "搜索文件名…", value: state.query || ""
    });
    var runSearch = function () { doSearch(trim(searchInput.value)); };
    searchInput.onkeydown = function (e) {
      var ev = e || window.event;
      if (ev && ev.keyCode === 13) { runSearch(); return false; }
      return true;
    };

    rightSide.appendChild(el("button", { cls: "btn btn-sm", type: "button", text: "搜索", onclick: runSearch }));
    rightSide.appendChild(searchInput);
    if (state.query) {
      rightSide.appendChild(el("button", {
        cls: "btn btn-sm", type: "button", text: "清除",
        onclick: function () { state.query = ""; reload(); }
      }));
    }
    rightSide.appendChild(el("button", {
      cls: "btn btn-sm", type: "button", text: "刷新",
      onclick: function () { reload(); }
    }));
    bar.appendChild(rightSide);

    return bar;
  }

  /** 统一的无权限提示：区分"只读映射目录"与"真的没权限" */
  function deny(inSoft) {
    toast(inSoft ? "外部映射目录仅支持只读操作" : "没有权限执行此操作", "error");
  }

  function buttonWithPerm(label, allowed, onclick) {
    var b = el("button", { cls: "btn", type: "button", text: label, onclick: onclick });
    if (!allowed) b.className = "btn is-disabled";
    return b;
  }

  function viewCrumbs() {
    var bar = el("div", { cls: "pathbar" });

    if (state.query) {
      bar.appendChild(el("span", { text: "搜索“" + state.query + "”的结果（点「清除」返回目录浏览）" }));
      return bar;
    }

    var home = el("a", { cls: "crumb", href: "javascript:void(0)", text: "根目录" });
    home.onclick = function () { goto(""); return false; };
    bar.appendChild(home);

    var parts = state.path ? state.path.split("/") : [];
    var acc = "";
    for (var i = 0; i < parts.length; i++) {
      acc = acc ? acc + "/" + parts[i] : parts[i];
      bar.appendChild(el("span", { cls: "crumb-sep", text: "›" }));
      if (i === parts.length - 1) {
        bar.appendChild(el("span", { cls: "crumb-here", text: parts[i] }));
      } else {
        bar.appendChild(crumbLink(acc.split("/").pop(), acc));
      }
    }
    return bar;
  }

  function crumbLink(label, target) {
    var a = el("a", { cls: "crumb", href: "javascript:void(0)", text: label });
    a.onclick = function () { goto(target); return false; };
    return a;
  }

  /** 这个浏览器缺哪些能力：只在真的缺时才提示，不制造噪音 */
  function compatWarnings() {
    var missing = [];
    if (typeof XMLHttpRequest === "undefined") missing.push("所有网络操作（不支持 XMLHttpRequest）");
    if (!window.FormData) missing.push("上传（不支持 FormData）");
    if (!window.JSON) missing.push("数据解析（不支持 JSON）");
    if (document.querySelector === undefined) { /* 只影响内部小工具，不提示 */ }
    if (!missing.length) return null;
    var box = el("div", { cls: "warnbox" });
    box.appendChild(el("strong", { text: "此浏览器缺少以下能力：" }));
    box.appendChild(el("span", { text: missing.join("、") + "。建议换用较新版本的 Chrome / Edge / Firefox。" }));
    return box;
  }

  function viewList() {
    var wrap = el("div", { cls: "list-wrap" });
    var card = el("div", { cls: "listcard", id: "dropcard" });

    if (state.loading && !state.entries.length) {
      card.appendChild(el("div", { cls: "empty", text: "正在加载…" }));
      wrap.appendChild(card);
      return wrap;
    }

    if (!state.entries.length) {
      var empty = el("div", { cls: "empty" });
      if (state.query) {
        empty.appendChild(el("div", { cls: "empty-title", text: "未找到" }));
        empty.appendChild(el("div", { text: "换个关键词试试" }));
      } else {
        empty.appendChild(el("div", { cls: "empty-title", text: "此文件夹为空" }));
        empty.appendChild(el("div", {
          text: perm("upload") || perm("mkdir") ? "上传文件或新建文件夹开始使用" : "暂无可见内容"
        }));
      }
      card.appendChild(empty);
      wrap.appendChild(card);
      return wrap;
    }

    var table = el("table", { cls: "files" });
    var thead = el("thead");
    var htr = el("tr");
    htr.appendChild(el("th", { cls: "col-check" }));
    htr.appendChild(el("th", { text: "名称" }));
    htr.appendChild(el("th", { cls: "col-size", text: "大小" }));
    htr.appendChild(el("th", { cls: "col-mtime", text: "修改时间" }));
    htr.appendChild(el("th", { cls: "col-act" }));
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el("tbody");
    for (var i = 0; i < state.entries.length; i++) {
      tbody.appendChild(rowFor(state.entries[i]));
    }
    table.appendChild(tbody);
    card.appendChild(table);
    wrap.appendChild(card);
    return wrap;
  }

  function rowFor(entry) {
    var name = entry.name;
    var shown = displayName(entry);
    var isSel = !!state.selected[name];

    var tr = el("tr", { cls: isSel ? "is-sel" : "" });

    /* 勾选框 */
    var box = el("input", { type: "checkbox", checked: isSel });
    box.onclick = function (ev) {
      var e = ev || window.event;
      if (e && e.stopPropagation) e.stopPropagation();
      if (box.checked) state.selected[name] = true; else delete state.selected[name];
      tr.className = box.checked ? "is-sel" : "";
      // 工具栏里的"已选 N 项"要跟着变，但整表重绘会丢滚动位置 → 只重画工具栏那段
      refreshToolbar();
    };
    tr.appendChild(el("td", { cls: "col-check" }, [box]));

    /* 名称 */
    var nameCell = el("td");
    nameCell.appendChild(el("span", { cls: "icon-cell", text: ICONS[kindOf(entry)] || ICONS.file }));

    var a = el("a", { cls: "entry-name", href: "javascript:void(0)", title: shown, text: shown });
    a.onclick = function () { openEntry(entry); return false; };
    nameCell.appendChild(a);

    if (isSoft(entry)) nameCell.appendChild(el("span", { cls: "tag-ro", text: "只读" }));
    if (state.me.role !== "guest" && entry.hiddenFromGuest) {
      nameCell.appendChild(el("span", { cls: "tag-hide", text: "对访客隐藏" }));
    }
    tr.appendChild(nameCell);

    /* 大小 / 时间 */
    tr.appendChild(el("td", { cls: "col-size", text: isDir(entry) ? "文件夹" : formatBytes(entry.size) }));
    tr.appendChild(el("td", { cls: "col-mtime", text: formatDate(entry.mtime) }));

    /* 行内快捷操作 */
    var actCell = el("td", { cls: "col-act" });
    if (isDir(entry)) {
      actCell.appendChild(rowAction("打包", "打包下载此文件夹", function () {
        if (!perm("downloadFolder")) { toast("没有权限下载文件夹", "error"); return; }
        doDownload([entry]);
      }));
    } else {
      actCell.appendChild(rowAction("下载", "下载此文件", function () {
        if (!perm("downloadFile") && !perm("preview")) { toast("没有权限下载文件", "error"); return; }
        doDownload([entry]);
      }));
    }
    tr.appendChild(actCell);

    return tr;
  }

  function rowAction(label, title, onclick) {
    var a = el("a", { cls: "btn btn-sm", href: "javascript:void(0)", text: label, title: title });
    a.onclick = function () { onclick(); return false; };
    return a;
  }

  function kindOf(entry) {
    if (isShortcut(entry)) return "link";
    if (isDir(entry)) return isSoft(entry) ? "dirsoft" : "dir";
    return KIND_BY_EXT[extOf(entry.name)] || "file";
  }

  /**
   * 只重画工具栏（勾选变化时用）。
   * 为什么不做局部更新：省下的复杂度换来的是"永远与 state 一致"，
   * 而列表区的滚动位置只在整页重绘时才会丢——这里列表节点不动，只换工具栏。
   */
  function refreshToolbar() {
    var bar = byId("toolbar");
    if (!bar || !bar.parentNode) { render(); return; }
    var next = viewToolbar();
    next.id = "toolbar";
    bar.parentNode.replaceChild(next, bar);
  }

  function viewStatusBar() {
    var bar = el("div", { cls: "statusbar" });
    var wrap = el("span");
    wrap.appendChild(el("span", { text: "当前为“" + roleLabel(state.me.role) + "”模式" }));

    if (state.me.groupId && state.me.groupId !== "default" && state.me.group) {
      wrap.appendChild(el("span", { cls: "sep", text: "|" }));
      wrap.appendChild(el("span", { text: "小组：" + (state.me.group.name || "") }));
    }

    wrap.appendChild(el("span", { cls: "sep", text: "|" }));
    wrap.appendChild(el("a", { href: "/", cls: "linkbtn", text: "无法正常渲染？返回正常页面" }));

    wrap.appendChild(el("span", { cls: "sep", text: "|" }));
    wrap.appendChild(el("span", { text: "兼容模式（旧浏览器专用）" }));

    bar.appendChild(wrap);
    return bar;
  }

  /* -------------------------------------------------------------- 预览 -- */

  function viewPreview() {
    var p = state.preview;
    var wrap = el("div", { cls: "preview-wrap" });

    var head = el("div", { cls: "preview-head" });
    var right = el("span", { style: "float:right;" });
    right.appendChild(el("a", { cls: "btn btn-sm", href: downloadHref(p.path, false), text: "下载" }));
    right.appendChild(el("button", {
      cls: "btn btn-sm", type: "button", text: "关闭",
      onclick: function () { closePreview(); }
    }));
    head.appendChild(right);
    head.appendChild(el("span", { cls: "name", text: p.name }));
    wrap.appendChild(head);

    var body = el("div", { cls: "preview-body" });
    wrap.appendChild(body);

    // 内容延迟一帧再填：大文件读取不阻塞首帧
    window.setTimeout(function () { fillPreview(body, p); }, 0);
    return wrap;
  }

  function fillPreview(body, p) {
    if (!body || !body.parentNode) return; // 已经被关掉了
    var kind = p.kind;

    if (kind === "text") {
      body.appendChild(el("pre", { cls: "preview-text", text: "正在加载…" }));
      API.get("/fs/file", { path: p.path }, function (err, data) {
        if (!body.parentNode) return;
        clear(body);
        if (err) {
          body.appendChild(el("div", { cls: "preview-note" }, [
            el("div", { cls: "big", text: "无法预览此文件" }),
            el("div", { text: err.message || "读取失败" }),
            el("div", { cls: "hint", text: "可以点右上角「下载」用本地程序打开。" })
          ]));
          return;
        }
        var content = data && data.content !== undefined ? String(data.content) : "";
        if (data && data.encodingConfident === false) {
          body.appendChild(el("div", {
            cls: "warnbox",
            text: "编码识别为 " + (data.encoding || "未知") + "，若显示乱码请下载后用本地编辑器打开"
          }));
        }
        // 用文本节点渲染：不做任何 HTML 解释，杜绝文件内容被当标签执行
        body.appendChild(el("pre", { cls: "preview-text", text: content }));
        if (data && data.size) {
          body.appendChild(el("div", {
            cls: "hint",
            style: "padding:0 16px 20px;",
            text: "大小：" + formatBytes(data.size) + " · 兼容模式只提供只读预览，不提供在线编辑"
          }));
        }
      });
      return;
    }

    if (kind === "image") {
      var holder = el("div", { cls: "preview-center" });
      holder.appendChild(el("span", { cls: "preview-valign" }));
      var ibox = el("span", { cls: "holder" });
      var img = el("img", { cls: "preview-img", alt: p.name, src: downloadHref(p.path, true) });
      img.onerror = function () {
        clear(ibox);
        ibox.appendChild(unsupportedNote("浏览器无法显示这张图片（可能是不支持的格式，如 HEIC / TIFF）。"));
      };
      ibox.appendChild(img);
      holder.appendChild(ibox);
      body.appendChild(holder);
      return;
    }

    if (kind === "video") {
      var v = el("video", { cls: "preview-media", controls: "controls", autoplay: "autoplay" });
      v.src = downloadHref(p.path, true);
      v.onerror = function () {
        clear(body);
        body.appendChild(unsupportedNote("浏览器无法播放此视频（可能是不支持的编码，如 HEVC / H.265）。"));
      };
      body.appendChild(v);
      return;
    }

    if (kind === "audio") {
      var ac = el("div", { cls: "preview-center" });
      ac.appendChild(el("span", { cls: "preview-valign" }));
      var abox = el("span", { cls: "holder" });
      var au = el("audio", { controls: "controls", autoplay: "autoplay" });
      au.src = downloadHref(p.path, true);
      au.onerror = function () {
        clear(abox);
        abox.appendChild(unsupportedNote("浏览器无法播放此音频。"));
      };
      abox.appendChild(au);
      ac.appendChild(abox);
      body.appendChild(ac);
      return;
    }

    if (kind === "pdf") {
      var frame = el("iframe", { cls: "preview-frame", title: p.name });
      frame.src = downloadHref(p.path, true);
      body.appendChild(frame);
      body.appendChild(el("div", {
        cls: "hint",
        style: "padding:8px 16px;",
        text: "若上方空白，说明此浏览器没有内置 PDF 阅读器，请点「下载」用本地程序打开。"
      }));
      return;
    }

    body.appendChild(el("div", { cls: "preview-note" }, [
      el("div", { cls: "big", text: "无法预览此格式" }),
      el("div", { text: "当前浏览器不支持直接显示该文件类型。" }),
      el("div", { cls: "hint", text: "请点右上角「下载」用本地程序打开。" })
    ]));
  }

  function unsupportedNote(text) {
    return el("div", { cls: "preview-note" }, [
      el("div", { cls: "big", text: "浏览器不支持此格式" }),
      el("div", { text: text }),
      el("div", { cls: "hint", text: "请点右上角「下载」用本地程序打开。" })
    ]);
  }

  function closePreview() {
    state.preview = null;
    render();
  }

  /* ============================================================ 对话框 == */

  function closeDialog() {
    state.dialog = null;
    render();
  }

  function renderDialog(root) {
    var d = state.dialog;
    if (!d) return;

    root.appendChild(el("div", {
      cls: "mask",
      onclick: function () { if (!d.sticky) closeDialog(); }
    }));

    var modal = el("div", { cls: "modal" + (d.wide ? " modal-wide" : "") });
    modal.appendChild(el("div", { cls: "modal-head", text: d.title || "" }));
    var body = el("div", { cls: "modal-body" });
    modal.appendChild(body);
    root.appendChild(modal);

    if (d.build) d.build(body, modal);

    // 自动聚焦第一个输入框（旧浏览器不会替我们做）
    window.setTimeout(function () {
      var inputs = modal.getElementsByTagName("input");
      if (inputs.length) { try { inputs[0].focus(); inputs[0].select(); } catch (e) { /* ignore */ } }
      else {
        var btns = modal.getElementsByTagName("button");
        if (btns.length) { try { btns[0].focus(); } catch (e2) { /* ignore */ } }
      }
    }, 0);
  }

  /** 确认框 */
  function dlgConfirm(opts) {
    state.dialog = {
      title: opts.title,
      build: function (body, modal) {
        body.appendChild(el("div", { text: opts.message || "" }));
        if (opts.detail) {
          body.appendChild(el("div", { cls: "hint", style: "margin-top:8px;", text: opts.detail }));
        }
        var foot = el("div", { cls: "modal-foot" });
        foot.appendChild(el("button", { cls: "btn", type: "button", text: "取消", onclick: closeDialog }));
        foot.appendChild(el("button", {
          cls: "btn " + (opts.danger ? "btn-danger" : "btn-primary"),
          type: "button",
          text: opts.okText || "确定",
          onclick: function () {
            closeDialog();
            if (opts.onOk) opts.onOk();
          }
        }));
        modal.appendChild(foot);
      }
    };
    render();
  }

  /**
   * 单输入框对话框（新建文件夹 / 重命名）。
   * onOk(name) 返回 true 表示"校验没过，别关"。
   */
  function dlgPrompt(opts) {
    state.dialog = {
      title: opts.title,
      build: function (body, modal) {
        var input = el("input", { cls: "form-input", type: "text", value: opts.value || "" });
        body.appendChild(el("div", { cls: "form-row" }, [
          el("label", { cls: "form-label", text: opts.label || "名称" }),
          input
        ]));
        body.appendChild(el("div", { cls: "err" }));
        if (opts.hint) body.appendChild(el("div", { cls: "hint", text: opts.hint }));

        var submit = function () {
          var v = trim(input.value);
          if (opts.onOk && opts.onOk(v) === true) return;
          closeDialog();
        };
        input.onkeydown = function (e) {
          var ev = e || window.event;
          if (ev && ev.keyCode === 13) { submit(); return false; }
          return true;
        };

        var foot = el("div", { cls: "modal-foot" });
        foot.appendChild(el("button", { cls: "btn", type: "button", text: "取消", onclick: closeDialog }));
        foot.appendChild(el("button", {
          cls: "btn btn-primary", type: "button", text: opts.confirmText || "确定",
          onclick: submit
        }));
        modal.appendChild(foot);
      }
    };
    render();
  }

  /**
   * 同名冲突处理。
   * items:     [{ name, isDir }]
   * existing:  目标位置已有的名字集合（对象，键为原始名）
   * done(decisions)：decisions 是 { 名字: { action, newName } }
   *
   * 关键：用户点「取消」时 **不会** 调用 done。调用方必须把"没被调用"
   * 理解为中止 —— 旧实现把"取消"当成"无冲突"，于是剪切模式下点了取消，
   * 文件反而真的被移走了。
   */
  function dlgConflict(opts) {
    var items = opts.items;
    var taken = {};
    var k;
    for (k in opts.existing) {
      if (has(opts.existing, k)) taken[k.toLowerCase()] = true;
    }
    var allowMerge = opts.allowMerge !== false;

    var decisions = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.isDir && allowMerge) {
        decisions[it.name] = { action: "merge" };
      } else {
        decisions[it.name] = { action: "rename", newName: uniqueName(it.name, taken) };
      }
    }

    state.dialog = {
      title: "同名文件处理",
      wide: true,
      build: function (body, modal) {
        body.appendChild(el("div", {
          cls: "hint",
          style: "margin-bottom:10px;",
          text: "目标位置已存在 " + items.length + " 个同名项目，请逐项选择处理方式。"
        }));

        var listBox = el("div");
        body.appendChild(listBox);

        var rerenderList = function () {
          clear(listBox);
          for (var j = 0; j < items.length; j++) {
            listBox.appendChild(conflictRow(items[j], decisions, allowMerge));
          }
        };

        var applyAll = el("input", { type: "checkbox" });
        body.appendChild(el("label", { cls: "hint", style: "display:block;margin-top:6px;" }, [
          applyAll,
          el("span", { text: " 对接下来所有同名项目执行同样的选择（「重命名」仍会各自取名）" })
        ]));

        // 事件委托：选项按钮是动态重画的，逐个绑监听不如在容器上兜一次
        listBox.onclick = function (ev) {
          var e = ev || window.event;
          var target = e.target || e.srcElement;
          if (!target || !target.getAttribute) return true;
          var nm = target.getAttribute("data-name");
          var act = target.getAttribute("data-action");
          if (!nm || !act) return true;

          if (act === "rename") decisions[nm] = { action: "rename", newName: uniqueName(nm, taken) };
          else decisions[nm] = { action: act };

          if (applyAll.checked) {
            var startIdx = -1;
            for (var m = 0; m < items.length; m++) if (items[m].name === nm) { startIdx = m; break; }
            for (var n = startIdx + 1; n < items.length; n++) {
              var other = items[n];
              if (act === "rename") {
                decisions[other.name] = { action: "rename", newName: uniqueName(other.name, taken) };
              } else if (act === "merge" && !other.isDir) {
                // 文件不能合并：退回重命名，避免发出服务端会无效的动作
                decisions[other.name] = { action: "rename", newName: uniqueName(other.name, taken) };
              } else {
                decisions[other.name] = { action: act };
              }
            }
          }
          rerenderList();
          return false;
        };

        rerenderList();

        var foot = el("div", { cls: "modal-foot" });
        foot.appendChild(el("button", {
          cls: "btn", type: "button", text: "取消",
          onclick: function () { state.dialog = null; render(); }
        }));
        foot.appendChild(el("button", {
          cls: "btn btn-primary", type: "button", text: "确认",
          onclick: function () {
            var out = {};
            for (var p = 0; p < items.length; p++) out[items[p].name] = decisions[items[p].name];
            closeDialog();
            opts.done(out);
          }
        }));
        modal.appendChild(foot);
      }
    };
    render();
  }

  function conflictRow(item, decisions, allowMerge) {
    var box = el("div", { cls: "conflict-item" });
    box.appendChild(el("div", { cls: "conflict-name", text: item.name }));

    var cur = decisions[item.name] || { action: "skip" };
    var opts = el("div", { cls: "conflict-opts" });

    var add = function (action, label) {
      opts.appendChild(el("button", {
        cls: "btn btn-sm" + (cur.action === action ? " is-on" : ""),
        type: "button",
        text: label,
        "data-name": item.name,
        "data-action": action
      }));
    };

    add("rename", "重命名为 " + (cur.newName || item.name));
    add("skip", "跳过");
    add("overwrite", "覆盖");
    if (item.isDir && allowMerge) add("merge", "合并");

    box.appendChild(opts);
    return box;
  }

  /** 生成不冲突的名字：name.ext → name (1).ext（大小写不敏感，与正常页面一致） */
  function uniqueName(name, takenLower) {
    if (!takenLower[String(name).toLowerCase()]) return name;
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.substring(0, dot) : name;
    var ext = dot > 0 ? name.substring(dot) : "";
    for (var i = 1; i < 1000; i++) {
      var candidate = base + " (" + i + ")" + ext;
      if (!takenLower[candidate.toLowerCase()]) return candidate;
    }
    return base + " (" + new Date().getTime() + ")" + ext;
  }

  /* ---------------------------------------------------------- 目录选择器 -- */

  /** 给「复制到…」「移动到…」用：逐层点进去选目标目录 */
  function dlgPicker(opts) {
    var cur = { path: "", dirs: [], loading: true };

    state.dialog = {
      title: opts.title || "选择目录",
      wide: true,
      build: function (body, modal) {
        var pathBox = el("div", { cls: "picker-path" });
        var listBox = el("div", { cls: "picker-list" });
        body.appendChild(pathBox);
        body.appendChild(listBox);

        var isBlocked = function (target) {
          var sources = opts.sourcePaths || [];
          for (var s = 0; s < sources.length; s++) {
            var src = sources[s];
            if (target === src || target.indexOf(src + "/") === 0) return true;
          }
          return false;
        };

        var paint = function () {
          pathBox.innerHTML = esc("/" + cur.path);
          clear(listBox);

          if (cur.path) {
            var up = el("div", { cls: "picker-row", text: "↑ 返回上级" });
            up.onclick = function () { load(cur, parentOf(cur.path), paint); return false; };
            listBox.appendChild(up);
          }
          if (cur.loading) {
            listBox.appendChild(el("div", { cls: "picker-row is-disabled", text: "加载中…" }));
            return;
          }
          if (!cur.dirs.length) {
            listBox.appendChild(el("div", { cls: "picker-row is-disabled", text: "没有子文件夹" }));
            return;
          }
          for (var i = 0; i < cur.dirs.length; i++) {
            paintRow(cur, cur.dirs[i], listBox, paint, isBlocked);
          }
        };

        var foot = el("div", { cls: "modal-foot" });
        foot.appendChild(el("button", { cls: "btn", type: "button", text: "取消", onclick: closeDialog }));
        foot.appendChild(el("button", {
          cls: "btn btn-primary", type: "button", text: "选择此目录",
          onclick: function () {
            var target = cur.path;
            closeDialog();
            opts.done(target);
          }
        }));
        modal.appendChild(foot);

        load(cur, "", paint);
      }
    };
    render();
  }

  function paintRow(cur, dir, listBox, paint, isBlocked) {
    var target = joinPath(cur.path, dir.name);
    var blocked = isBlocked(target);
    var row = el("div", {
      cls: "picker-row" + (blocked ? " is-disabled" : ""),
      text: (blocked ? "⊘ " : "▸ ") + dir.name
    });
    if (!blocked) {
      row.onclick = function () { load(cur, target, paint); return false; };
    }
    listBox.appendChild(row);
  }

  /** 读一个目录的子目录列表，写进 picker 状态后重画 */
  function load(picker, path, paint) {
    picker.loading = true;
    paint();
    API.get("/fs/list", { path: path }, function (err, data) {
      picker.loading = false;
      if (err) {
        toast(err.message, "error");
        // 失败时留在原目录，避免界面卡在"加载中"
        paint();
        return;
      }
      var dirs = [];
      var entries = (data && data.entries) || [];
      for (var i = 0; i < entries.length; i++) {
        if (isDir(entries[i])) dirs.push(entries[i]);
      }
      picker.path = (data && data.path) || path;
      picker.dirs = dirs;
      paint();
    });
  }

  /* ========================================================== 文件操作 == */

  /** 目录列表 / 搜索结果的统一加载 */
  function reload() {
    state.loading = true;
    render();

    if (state.query) {
      API.get("/fs/search", { q: state.query, path: "" }, function (err, data) {
        state.loading = false;
        if (err) { toast(err.message, "error"); state.entries = []; render(); return; }
        var rows = (data && data.results) || [];
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          // 搜索结果要多带原始路径：它的上级目录不一定是当前目录
          out.push({
            name: r.name, type: r.type, size: r.size, mtime: r.mtime,
            softReadOnly: r.softReadOnly, hiddenFromGuest: false,
            __fullPath: r.path, __isSearch: true
          });
        }
        state.entries = out;
        render();
      });
      return;
    }

    API.get("/fs/list", { path: state.path }, function (err, data) {
      state.loading = false;
      if (err) { toast(err.message, "error"); state.entries = []; render(); return; }
      state.path = (data && data.path) || state.path;
      state.entries = (data && data.entries) || [];
      clearSelection(); // 目录变了，旧勾选不再有意义
      render();
    });
  }

  function goto(path) {
    state.query = "";
    state.path = path || "";
    clearSelection();
    reload();
  }

  function doSearch(q) {
    if (!q) { state.query = ""; reload(); return; }
    state.query = q;
    clearSelection();
    state.path = "";
    reload();
  }

  /** 搜索结果的路径是完整的，普通列目录要按当前目录拼 */
  function entryPath(entry) {
    if (entry.__isSearch) return String(entry.__fullPath || entry.name);
    return joinPath(state.path, entry.name);
  }

  function openEntry(entry) {
    if (isShortcut(entry)) { openShortcut(entry); return; }
    if (isDir(entry)) { goto(joinPath(state.path, entry.name)); return; }

    var kind = previewKindOf(entry.name);
    if (perm("preview") && kind) { openPreview(entry); return; }
    if (perm("downloadFile")) { doDownload([entry]); return; }
    if (perm("preview")) { openPreview(entry); return; }
    toast("没有权限打开此文件", "error");
  }

  function openShortcut(entry) {
    var s = entry.shortcut;
    if (!s || !s.targetUrl) { toast("快捷方式数据损坏", "error"); return; }
    if (s.targetType === "path" || s.targetType === "soft_path") { goto(s.targetUrl); return; }

    // 文件类快捷方式：按目标路径当成一个"搜索结果"来处理
    var fake = {
      name: lastSegment(s.targetUrl), type: "file", size: 0, mtime: 0,
      __fullPath: s.targetUrl, __isSearch: true
    };
    if (perm("preview") && previewKindOf(fake.name)) { openPreview(fake); return; }
    if (perm("downloadFile")) { doDownload([fake]); return; }
    toast("快捷方式目标不存在或无权访问", "error");
  }

  /** 返回 "" / "text" / "image" / "video" / "audio" / "pdf" */
  function previewKindOf(name) {
    var e = extOf(name);
    if (NATIVE[e]) return NATIVE[e];
    if (TEXTUAL[e]) return "text";
    return "";
  }

  function openPreview(entry) {
    var kind = previewKindOf(entry.name);
    if (!kind) { toast("此格式无法预览，请下载后用本地程序打开", "error"); return; }
    state.preview = { path: entryPath(entry), name: displayName(entry), kind: kind };
    render();
  }

  function doDownload(targets) {
    if (!targets || !targets.length) return;

    if (targets.length === 1 && !isDir(targets[0])) {
      // 只有「预览」没有「下载」时也允许：服务端会强制 inline 返回
      if (!perm("downloadFile") && !perm("preview")) { toast("没有权限下载文件", "error"); return; }
      navigateToDownload(downloadHref(entryPath(targets[0]), false));
      return;
    }

    if (!perm("downloadFolder")) { toast("没有权限下载文件夹", "error"); return; }
    var paths = [];
    for (var i = 0; i < targets.length; i++) paths.push(entryPath(targets[i]));
    navigateToDownload(zipHref(paths));
  }

  function doClipboard(mode) {
    var targets = selectedEntries();
    if (!targets.length) return;
    if (mode === "copy" && !perm("copy")) { toast("没有权限执行此操作", "error"); return; }
    if (mode === "cut" && !perm("move")) { toast("没有权限执行此操作", "error"); return; }
    if (mode === "cut") {
      for (var i = 0; i < targets.length; i++) {
        if (isSoft(targets[i])) { toast("外部映射目录仅支持只读操作", "error"); return; }
      }
    }
    var items = [];
    for (var j = 0; j < targets.length; j++) {
      items.push({ path: entryPath(targets[j]), name: targets[j].name, type: targets[j].type });
    }
    state.clipboard = { mode: mode, items: items };
    toast("已" + (mode === "copy" ? "复制" : "剪切") + " " + items.length + " 项", "ok");
    render();
  }

  /** 「复制到…」「移动到…」：先选目录，再按该目录的现有条目做冲突处理 */
  function pickDestination(mode) {
    var targets = selectedEntries();
    if (!targets.length) return;
    if (mode === "cut") {
      for (var i = 0; i < targets.length; i++) {
        if (isSoft(targets[i])) { toast("外部映射目录仅支持只读操作", "error"); return; }
      }
    }
    var sourcePaths = [];
    var srcDirs = {};
    for (var j = 0; j < targets.length; j++) {
      var p = entryPath(targets[j]);
      sourcePaths.push(p);
      srcDirs[p] = isDir(targets[j]);
    }

    dlgPicker({
      title: mode === "copy" ? "复制到…" : "移动到…",
      sourcePaths: sourcePaths,
      done: function (dest) { runTransfer(mode, sourcePaths, srcDirs, dest); }
    });
  }

  function doPaste(dest) {
    var clip = state.clipboard;
    if (!clip || !clip.items.length) return;
    var sources = [];
    var srcDirs = {};
    for (var i = 0; i < clip.items.length; i++) {
      sources.push(clip.items[i].path);
      srcDirs[clip.items[i].path] = clip.items[i].type === "dir";
    }
    runTransfer(clip.mode, sources, srcDirs, dest, function () {
      if (clip.mode === "cut") state.clipboard = null;
    });
  }

  /**
   * 复制 / 移动的公共实现。
   * 与服务端的约定（见 docs/API参考.md）：冲突选「重命名」时要传
   *   targetNames: { 原始来源路径: 期望的新名字 }
   * 而不是把来源路径改成新名字 —— 后者会让服务端找不到来源（必然 404）。
   */
  function runTransfer(mode, sources, srcDirs, dest, onAllDone) {
    var apiPath = mode === "copy" ? "/fs/copy" : "/fs/move";

    API.get("/fs/list", { path: dest }, function (err, data) {
      if (err) { toast(err.message, "error"); return; }

      var entries = (data && data.entries) || [];
      var existing = {};
      for (var i = 0; i < entries.length; i++) existing[entries[i].name] = true;

      var conflicts = [];
      for (var j = 0; j < sources.length; j++) {
        var nm = lastSegment(sources[j]);
        if (existing[nm]) conflicts.push({ name: nm, isDir: !!srcDirs[sources[j]] });
      }

      if (!conflicts.length) { sendTransfer(apiPath, sources, dest, false, null, false, onAllDone); return; }

      dlgConflict({
        items: conflicts,
        existing: existing,
        done: function (decisions) {
          var plain = [];
          var mergeList = [];
          var overwrite = false;
          var targetNames = {};
          for (var k = 0; k < sources.length; k++) {
            var name = lastSegment(sources[k]);
            var dec = decisions[name];
            if (!dec) { plain.push(sources[k]); continue; }
            if (dec.action === "skip") continue;
            if (dec.action === "overwrite") { overwrite = true; plain.push(sources[k]); continue; }
            if (dec.action === "merge") { mergeList.push(sources[k]); continue; }
            plain.push(sources[k]);
            if (dec.newName) targetNames[sources[k]] = dec.newName;
          }
          if (!plain.length && !mergeList.length) { toast("已全部跳过，未做任何改动"); return; }

          sendTransfer(apiPath, plain, dest, overwrite, targetNames, false, function () {
            if (mergeList.length) {
              // merge 单独发一批：服务端只在"双方都是目录"时才按合并处理
              sendTransfer(apiPath, mergeList, dest, false, null, true, onAllDone);
            } else if (onAllDone) {
              onAllDone();
            }
            reload();
          });
        }
      });
    });
  }

  function sendTransfer(apiPath, sources, dest, overwrite, targetNames, isMerge, done) {
    if (!sources.length) { if (done) done(); return; }
    var body = { sources: sources, dest: dest };
    if (overwrite) body.overwrite = true;
    if (isMerge) body.merge = true;
    if (targetNames) {
      var hasAny = false;
      for (var k in targetNames) { if (has(targetNames, k)) { hasAny = true; break; } }
      if (hasAny) body.targetNames = targetNames;
    }
    API.post(apiPath, body, null, function (err) {
      if (err) { toast(err.message, "error"); reload(); return; }
      toast(apiPath === "/fs/copy" ? "复制完成" : "移动完成", "ok");
      if (done) done();
    });
  }

  function doRename(entry) {
    if (!entry) return;
    var oldName = entry.name;
    var isLink = isShortcut(entry);

    dlgPrompt({
      title: "重命名",
      label: "新名称",
      value: displayName(entry),
      confirmText: "确定",
      hint: "不能包含 \\ / : * ? \" < > | 这些字符，也不能以空格或点结尾。",
      onOk: function (newName) {
        if (!newName) { toast("名称不能为空", "error"); return true; }
        var finalName = newName;
        if (isLink && !/\.zeropath$/i.test(finalName)) finalName += ".zeropath";
        if (finalName === oldName) return false; // 没改，直接关掉

        var taken = knownNames();
        delete taken[oldName];

        if (taken[finalName]) {
          dlgConflict({
            items: [{ name: finalName, isDir: isDir(entry) }],
            existing: taken,
            done: function (decisions) {
              var dec = decisions[finalName] || { action: "skip" };
              if (dec.action === "skip") { toast("已取消"); return; }
              var body = { path: entryPath(entry), newName: finalName };
              if (dec.action === "overwrite") body.overwrite = true;
              if (dec.action === "merge") body.merge = true;
              if (dec.action === "rename" && dec.newName) body.newName = dec.newName;
              API.post("/fs/rename", body, null, function (err) {
                if (err) { toast(err.message, "error"); return; }
                toast("已重命名", "ok");
                reload();
              });
            }
          });
          return true; // 保持原对话框关闭、交给冲突对话框处理
        }

        API.post("/fs/rename", { path: entryPath(entry), newName: finalName }, null, function (err) {
          if (err) { toast(err.message, "error"); return; }
          toast("已重命名", "ok");
          reload();
        });
        return false;
      }
    });
  }

  function newFolderDialog() {
    dlgPrompt({
      title: "新建文件夹",
      label: "文件夹名称",
      value: "新建文件夹",
      confirmText: "创建",
      onOk: function (name) {
        if (!name) { toast("名称不能为空", "error"); return true; }
        API.post("/fs/mkdir", { path: state.path, name: name }, null, function (err) {
          if (err) { toast(err.message, "error"); return; }
          toast("文件夹已创建", "ok");
          reload();
        });
        return false;
      }
    });
  }

  function doDelete(targets) {
    if (!targets || !targets.length) return;
    var names = [];
    var paths = [];
    for (var i = 0; i < targets.length; i++) {
      names.push(displayName(targets[i]));
      paths.push(entryPath(targets[i]));
    }
    dlgConfirm({
      title: "确认删除",
      message: targets.length === 1
        ? "将永久删除「" + names[0] + "」，此操作不可撤销。"
        : "将永久删除选中的 " + targets.length + " 项，此操作不可撤销。",
      detail: names.slice(0, 8).join("、") + (names.length > 8 ? " 等" : ""),
      okText: "删除",
      danger: true,
      onOk: function () {
        API.post("/fs/delete", { paths: paths }, null, function (err) {
          if (err) { toast(err.message, "error"); return; }
          toast("已删除 " + paths.length + " 项", "ok");
          clearSelection();
          reload();
        });
      }
    });
  }

  /* ========================================================== 上传流程 == */

  /**
   * 上传入口。files 可以是 FileList 或数组；isFolder 表示是否来自目录选择。
   *
   * 与服务端的两个约定：
   *   1. 单次请求最多 100 个文件，超出部分被**静默丢弃**（只回 truncated: true），
   *      所以这里必须自己分批。
   *   2. 文件夹上传靠 filename 里带相对路径来还原目录结构。浏览器只在
   *      `webkitRelativePath` 里给相对路径，而 busboy 读的是 filename，
   *      因此必须把 File 的 name 改写成相对路径再上传 —— 否则整个目录会被压平。
   */
  function startUpload(files, isFolder) {
    var inSoft = state.entries.length > 0 && allSoft(state.entries);
    if (!perm("upload") || inSoft) { deny(inSoft); return; }
    if (isFolder && !perm("uploadFolders")) { toast("没有权限上传文件夹", "error"); return; }

    var list = [];
    for (var i = 0; i < files.length; i++) list.push(files[i]);
    if (!list.length) return;

    // 归一化：把相对路径写回 File.name（能改写就改写，改不了就按原名）
    var normalized = [];
    var topFolders = {};
    var hasPaths = false;
    for (var j = 0; j < list.length; j++) {
      var rel = relativeName(list[j]);
      var item = list[j];
      if (rel !== list[j].name) item = renameFile(list[j], rel);
      normalized.push(item);
      if (rel.indexOf("/") > 0) {
        hasPaths = true;
        topFolders[rel.split("/")[0]] = true;
      }
    }

    var proceed = function (overwriteNames) { runUploadBatches(normalized, overwriteNames); };

    if (!hasPaths) { proceed(null); return; }

    // 顶层文件夹与当前目录里的同名项冲突时，先问怎么处理
    var known = knownNames();
    var conflicts = [];
    for (var folder in topFolders) {
      if (has(topFolders, folder) && known[folder]) conflicts.push({ name: folder, isDir: true });
    }
    if (!conflicts.length) { proceed(null); return; }

    dlgConflict({
      items: conflicts,
      existing: known,
      done: function (decisions) {
        var skip = {};
        var renameMap = {};
        var overwriteNames = [];
        for (var c = 0; c < conflicts.length; c++) {
          var nm = conflicts[c].name;
          var dec = decisions[nm] || { action: "skip" };
          if (dec.action === "skip") { skip[nm] = true; continue; }
          if (dec.action === "overwrite" || dec.action === "merge") {
            // overwrite 列表要展开成"每个文件的相对路径"：
            // 服务端同时按 basename 与相对路径匹配，只传文件夹名会静默失效。
            for (var f = 0; f < normalized.length; f++) {
              var rn = normalized[f].name;
              if (rn.split("/")[0] === nm) overwriteNames.push(rn);
            }
            continue;
          }
          if (dec.action === "rename" && dec.newName) renameMap[nm] = dec.newName;
        }

        var out = [];
        for (var g = 0; g < normalized.length; g++) {
          var path = normalized[g].name;
          var top = path.indexOf("/") > 0 ? path.split("/")[0] : null;
          if (top && skip[top]) continue;
          if (top && renameMap[top]) out.push(renameFile(normalized[g], renameMap[top] + path.substring(top.length)));
          else out.push(normalized[g]);
        }
        if (!out.length) { toast("已全部跳过，未上传任何文件"); return; }
        runUploadBatches(out, overwriteNames);
      }
    });
  }

  /** 取"相对路径"形式的文件名：优先 webkitRelativePath，其次原始 name */
  function relativeName(file) {
    var rel = "";
    try { rel = file.webkitRelativePath || ""; } catch (e) { rel = ""; }
    return rel || file.name;
  }

  /** 复制一个 File 并改名（IE11 没有 File 构造器时退回原对象） */
  function renameFile(file, newName) {
    try {
      return new File([file], newName, { type: file.type, lastModified: file.lastModified });
    } catch (e) {
      return file;
    }
  }

  /** 按 100 个一批依次上传；全部批次结束才刷新列表 */
  function runUploadBatches(list, overwriteNames) {
    var batches = [];
    for (var i = 0; i < list.length; i += CFG.batchSize) {
      batches.push(list.slice(i, i + CFG.batchSize));
    }

    var doneBatches = 0;
    var failed = [];
    var savedCount = 0;
    var truncated = false;
    var progressNode = null;

    var setProgressText = function (text) {
      if (!progressNode || !progressNode.parentNode) {
        progressNode = el("div", { cls: "warnbox" });
        var listWrap = null;
        var wraps = document.getElementsByClassName ? document.getElementsByClassName("list-wrap") : null;
        if (wraps && wraps.length) listWrap = wraps[0];
        if (listWrap && listWrap.parentNode) listWrap.parentNode.insertBefore(progressNode, listWrap);
        else {
          var main = document.getElementsByClassName ? document.getElementsByClassName("main-cell")[0] : null;
          if (main) main.appendChild(progressNode);
        }
      }
      if (progressNode) progressNode.innerHTML = esc(text);
    };

    var next = function () {
      if (doneBatches >= batches.length) {
        if (failed.length) {
          toast("已上传 " + savedCount + " 个，" + failed.length + " 个失败", "error");
        } else {
          toast("已上传 " + savedCount + " 个文件", "ok");
        }
        if (truncated) toast("单次请求文件数超过上限，已自动分批，请确认是否有遗漏", "error");
        if (progressNode && progressNode.parentNode) progressNode.parentNode.removeChild(progressNode);
        progressNode = null;
        reload();
        return;
      }

      var batch = batches[doneBatches];
      var batchIndex = doneBatches + 1;
      var bytesOf = 0;
      for (var b = 0; b < batch.length; b++) bytesOf += batch[b].size || 0;

      setProgressText("正在上传第 " + batchIndex + "/" + batches.length + " 批（本批 " +
        batch.length + " 个，共 " + formatBytes(bytesOf) + "）…");

      var onProgress = function (loaded, total) {
        var pct = total ? Math.round((loaded / total) * 100) : 0;
        setProgressText("正在上传第 " + batchIndex + "/" + batches.length + " 批：" +
          formatBytes(loaded) + " / " + formatBytes(total) + "（" + pct + "%）");
      };

      upload(state.path, batch, overwriteNames, onProgress, function (err, data) {
        if (err) {
          // 整批失败：记下原因继续下一批，不让一批拖垮全部
          failed.push(err.message || "上传失败");
        } else {
          var results = (data && data.results) || [];
          for (var r = 0; r < results.length; r++) {
            if (results[r] && results[r].ok) savedCount++;
            else {
              failed.push(((results[r] && results[r].name) ? results[r].name + "：" : "") +
                ((results[r] && results[r].error) || "失败"));
            }
          }
          if (data && data.truncated) truncated = true;
        }
        doneBatches++;
        next();
      });
    };

    next();
  }

  /* ============================================================ 启动 == */

  function bootstrap() {
    API.get("/auth/me", null, function (err, data) {
      if (err) {
        state.me = { role: "guest", username: null, userId: null, perms: LOGIN_PERMS, groupId: "default", group: null };
        state.authError = err.message || "无法获取身份";
      } else if (data) {
        state.me = data;
        if (!state.me.perms) state.me.perms = LOGIN_PERMS;
      }
      state.ready = true;
      if (state.me.role === "guest") { render(); return; }
      reload();
    });
  }

  function doLogout() {
    API.post("/auth/logout", {}, null, function () {
      // 不论服务端返回什么，本地状态都必须清掉
      state.me = { role: "guest", username: null, userId: null, perms: LOGIN_PERMS, groupId: "default", group: null };
      state.entries = [];
      state.path = "";
      state.query = "";
      state.clipboard = null;
      state.preview = null;
      state.dialog = null;
      clearSelection();
      render();
    });
  }

  /* ------------------------------------------------ 拖拽上传（仅顶层文件） -- */
  /* 刻意只支持"文件"：拖文件夹进来时旧浏览器拿不到递归内容
     （DataTransfer.items / webkitGetAsEntry 在 IE11 上行为不一致），
     因此这里只用 dataTransfer.files，并在拿不到文件时给出明确提示。 */

  function bindDrop() {
    var body = document.body;
    if (!body) return;

    var card = null;
    var getCard = function () {
      if (!card || !card.parentNode) card = byId("dropcard");
      return card;
    };

    var stopEvent = function (e) {
      var ev = e || window.event;
      if (ev.preventDefault) ev.preventDefault();
      ev.returnValue = false;
      return false;
    };

    body.ondragover = function (e) {
      var c = getCard();
      if (c) c.className = "listcard is-drop";
      return stopEvent(e);
    };

    body.ondragleave = function () {
      var c = getCard();
      if (c) c.className = "listcard";
      return false;
    };

    body.ondrop = function (e) {
      var ev = e || window.event;
      stopEvent(ev);
      var c = getCard();
      if (c) c.className = "listcard";

      if (!perm("upload")) { toast("没有权限上传文件", "error"); return false; }
      var dt = ev.dataTransfer;
      if (!dt) return false;
      var files = dt.files;
      if (!files || !files.length) {
        toast("拖入的是文件夹或不受支持的内容；请用「上传文件夹」按钮", "error");
        return false;
      }

      // 拖进来的文件夹无法在这里递归读取（旧浏览器行为不一致），
      // 而它会被当成一个 0 字节的"文件"传给服务端 → 存下一个同名空文件。
      // 宁可拦住并明说，也不要让用户在服务端看到一堆无意义的空文件。
      var real = [];
      var skippedFolders = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if ((f.size || 0) === 0 && !f.type) skippedFolders++;
        else real.push(f);
      }
      if (skippedFolders) {
        toast("已忽略 " + skippedFolders + " 个文件夹（拖拽不支持目录），请用「上传文件夹」按钮", "error");
      }
      if (!real.length) return false;
      startUpload(real, false);
      return false;
    };
  }

  /* -------------------------------------------------------------- 入口 -- */

  function init() {
    applyTheme(currentTheme());
    bindDrop();

    // 先把"正在加载"画出来，再拉身份（旧机器上首屏白屏最容易被当成坏了）
    render();
    bootstrap();

    // 回到前台时刷新一次（老机器常被切走/挂起，回来看到的是过期列表）
    if (document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && state.ready && state.me.role !== "guest" && !state.preview && !state.dialog) {
          reload();
        }
      }, false);
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    window.setTimeout(init, 0);
  } else if (document.addEventListener) {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    window.attachEvent("onload", init);
  }
})();
