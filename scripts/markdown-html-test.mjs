// Markdown 预览「安全 HTML 白名单」单测（不需要浏览器、不需要构建）
// 运行：node --experimental-strip-types scripts/markdown-html-test.mjs
//
// 覆盖两件事：
//   1. renderSafeTags —— 白名单标签被还原成真标签，其余（含带属性的危险标签）原样保留；
//   2. hasUnsupportedHtml —— 只有"真的不会被渲染"的 HTML 才触发预览页顶部提示。
import assert from "node:assert/strict"

const { SAFE_HTML_TAGS, renderSafeTags, hasUnsupportedHtml } = await import(
  "../web/src/lib/markdown-html.ts"
)

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n     ${err.message}`)
    process.exitCode = 1
  }
}

/** markdown.ts 里 escapeHtml 的等价实现（这里只需要这 4 个字符） */
const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch])
const render = (src) => renderSafeTags(esc(src))

console.log("白名单标签被还原")
check("<br> → <br />", () => assert.equal(render("a<br>b"), "a<br />b"))
check("<br/> 与 <br /> 都认", () => {
  assert.equal(render("a<br/>b"), "a<br />b")
  assert.equal(render("a<br />b"), "a<br />b")
})
check("标签名大小写不敏感", () => assert.equal(render("a<BR>b"), "a<br />b"))
check("<hr> 也走自闭合", () => assert.equal(render("<hr>"), "<hr />"))
check("成对标签保留结构", () => assert.equal(render("<sub>2</sub>"), "<sub>2</sub>"))
check("行内排版标签：kbd / mark / u / s / small / sup", () => {
  assert.equal(render("<kbd>Ctrl</kbd>+<kbd>S</kbd>"), "<kbd>Ctrl</kbd>+<kbd>S</kbd>")
  assert.equal(render("<mark>重点</mark>"), "<mark>重点</mark>")
  assert.equal(render("<u>下划线</u>"), "<u>下划线</u>")
  assert.equal(render("<s>删除</s>"), "<s>删除</s>")
  assert.equal(render("<small>小字</small>"), "<small>小字</small>")
  assert.equal(render("<sup>1</sup>"), "<sup>1</sup>")
})
check("块级标签：div / p / center / span", () => {
  assert.equal(render("<div>x</div>"), "<div>x</div>")
  assert.equal(render("<p>x</p>"), "<p>x</p>")
  assert.equal(render("<center>x</center>"), "<center>x</center>")
  assert.equal(render("<span>x</span>"), "<span>x</span>")
})
check("自闭合的闭合标签被丢掉", () => assert.equal(render("a</br>b"), "ab"))

console.log("属性一律丢弃（标签本身保留）")
check('<div align="center"> 只保留 <div>', () =>
  assert.equal(render('<div align="center">x</div>'), "<div>x</div>")
)
check("<span style=…> 只保留 <span>", () =>
  assert.equal(render('<span style="color:red">x</span>'), "<span>x</span>")
)
check("<p onclick=…> 只保留 <p>", () =>
  assert.equal(render('<p onclick="alert(1)">x</p>'), "<p>x</p>")
)
check("<br clear=all> 只保留 <br />", () => assert.equal(render('<br clear="all">'), "<br />"))

console.log("白名单以外的一切仍是纯文本（XSS 前提不变）")
check("<script> 不渲染", () => assert.equal(render("<script>alert(1)</script>"), esc("<script>alert(1)</script>")))
check("<iframe> 不渲染", () => assert.equal(render('<iframe src="x"></iframe>'), esc('<iframe src="x"></iframe>')))
check("<a href=javascript:> 不渲染", () =>
  assert.equal(render('<a href="javascript:alert(1)">x</a>'), esc('<a href="javascript:alert(1)">x</a>'))
)
check("<img onerror=…> 不渲染", () =>
  assert.equal(render('<img src="x" onerror="alert(1)">'), esc('<img src="x" onerror="alert(1)">'))
)
check("<style> / <svg> 不渲染", () => {
  assert.equal(render("<style>body{}</style>"), esc("<style>body{}</style>"))
  assert.equal(render("<svg></svg>"), esc("<svg></svg>"))
})
check("残句里长得像标签的片段不吞正文", () => {
  const src = "<span and more text>"
  assert.equal(render(src), esc(src))
})
check("未转义的原文不会被当成已转义文本处理（契约：只接受 escapeHtml 之后的串）", () => {
  assert.equal(renderSafeTags("<br>"), "<br>")
})
check("纯文本里的 < 与 > 原样保留", () => assert.equal(render("5 < 6 and 7 > 8"), "5 &lt; 6 and 7 &gt; 8"))

console.log("提示判定：哪些 HTML 才算「显示了源码」")
check("白名单标签不触发提示", () => {
  assert.equal(hasUnsupportedHtml("a<br>b"), false)
  assert.equal(hasUnsupportedHtml('<div align="center">x</div>'), false)
  assert.equal(hasUnsupportedHtml("<kbd>Ctrl</kbd>"), false)
  assert.equal(hasUnsupportedHtml("5 < 6 and 7 > 8"), false)
})
check("白名单以外的标签触发提示", () => {
  assert.equal(hasUnsupportedHtml("<script>alert(1)</script>"), true)
  assert.equal(hasUnsupportedHtml('<img src="x">'), true)
  assert.equal(hasUnsupportedHtml('<a href="x">y</a>'), true)
})
check("HTML 注释触发提示", () => assert.equal(hasUnsupportedHtml("<!-- hidden -->"), true))
check("围栏代码块里的标签不触发提示", () => {
  assert.equal(hasUnsupportedHtml("```html\n<script>alert(1)</script>\n```"), false)
  assert.equal(hasUnsupportedHtml("~~~\n<div>\n~~~"), false)
})
check("未闭合的围栏按「一直到文件末尾」处理", () => {
  assert.equal(hasUnsupportedHtml("```\n<script>alert(1)</script>\n"), false)
})
check("行内代码里的标签不触发提示", () => assert.equal(hasUnsupportedHtml("写 `<script>` 这样"), false))

console.log("白名单本身")
check("白名单是固定的 13 个标签", () => assert.equal(SAFE_HTML_TAGS.length, 13))
check("白名单不含 script / iframe / a / img / style", () => {
  for (const bad of ["script", "iframe", "a", "img", "style", "object", "embed", "link", "meta", "form"]) {
    assert.equal(SAFE_HTML_TAGS.includes(bad), false, `${bad} 不该在白名单里`)
  }
})

console.log(`\n${passed} 项通过${process.exitCode ? "（有失败）" : "，全部通过"}`)
