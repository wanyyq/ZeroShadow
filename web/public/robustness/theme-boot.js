/**
 * theme-boot.js —— 兼容模式的"首帧"主题应用。
 *
 * 为什么单独一个文件、且在 <head> 里同步加载：
 *   1. 正常页面由 React 的 ThemeProvider 在 effect 里加 .dark，那已经是首帧之后，
 *      深色用户会先看到一闪的亮色（FOUC）。这里在解析阶段就把 class 写上去。
 *   2. 后端给 web/dist 下的 .html 挂了 `script-src 'self'` 的 CSP（server/index.js
 *      的 SHELL_CSP），内联 <script> 会被直接拦掉，所以只能放外部文件。
 *
 * 只做一件事：读 localStorage 的键，决定要不要给 <html> 加 .dark。
 * 键名刻意与正常页面（zs-theme）区分开，两者互不干扰。
 *
 * ES5 写法：目标浏览器包含 IE11，不能用 let/const/箭头函数。
 */
(function () {
  var KEY = "zs-robustness-theme";

  function readStored() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (e) {
      // 隐私模式 / 本地存储被禁用：退化为跟随系统
      return null;
    }
  }

  var stored = readStored();
  var dark = false;

  if (stored === "dark") {
    dark = true;
  } else if (stored === "light") {
    dark = false;
  } else if (window.matchMedia) {
    // 未显式选择过：跟随系统
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      dark = false;
    }
  }

  var root = document.documentElement;
  if (dark) {
    root.className += (root.className ? " " : "") + "dark";
  }
})();
