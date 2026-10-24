// 审计用探针（只读，不修改任何源码）：验证 markdown 白名单 / URL 解析在恶意输入下的行为
// 运行：node --experimental-strip-types .audit/payload-probe.mjs
const { renderSafeTags } = await import("../web/src/lib/markdown-html.ts")
const { resolveRef } = await import("../web/src/lib/markdown-urls.ts")

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c])
// markdown.ts 里的 BAD_URL（逐字复制，用于观察"过滤之后还剩什么"）
const BAD_URL = /^\s*(?:javascript|vbscript|data):/i

const htmlPayloads = [
  '<span onmouseover="alert(1)">x</span>',
  '<div style="position:fixed;inset:0">x</div>',
  '<span/title="a">',
  '<span =x>',
  '<span\tonmouseover=alert(1)>x</span>',
  '<center><script>alert(1)</script></center>',
  '<mark onmouseover=alert(1)>x</mark>',
  '<p>&lt;script&gt;x</p>',
  '<div><img src=x onerror=alert(1)></div>',
  '<span title="&quot;><img src=x onerror=alert(1)>">x</span>',
]

console.log("== renderSafeTags(escapeHtml(src)) ==")
for (const p of htmlPayloads) {
  console.log(JSON.stringify(p), "->", JSON.stringify(renderSafeTags(esc(p))))
}

const urlPayloads = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)",
  "javascript\t:alert(1)",
  "jav\u0001ascript:alert(1)",
  "\u0001javascript:alert(1)",
  "\u0000javascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD4=",
  "vbscript:msgbox(1)",
  "//evil.example/x",
  "\\\\evil.example/x",
  "..\\..\\..\\windows\\win.ini",
  "%6a%61vascript:alert(1)",
  "java%0ascript:alert(1)",
  "#anchor",
  "/abs/path.png",
]

console.log("\n== BAD_URL(resolveRef) 组合判定 ==")
for (const u of urlPayloads) {
  const bad = BAD_URL.test(u)
  const r = resolveRef("dir/sub", u)
  console.log(
    JSON.stringify(u),
    "BAD_URL=", bad,
    "external=", r.external,
    "path=", JSON.stringify(r.path)
  )
}
