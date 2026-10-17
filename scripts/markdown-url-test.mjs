// Markdown 相对路径解析单测（不需要浏览器、不需要构建）
// 运行：node --experimental-strip-types scripts/markdown-url-test.mjs
import assert from "node:assert/strict"

const { resolveRef, inlineFileUrl, downloadFileUrl, looksLikeFile } = await import(
  "../web/src/lib/markdown-urls.ts"
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

console.log("相对路径解析（.md 所在目录为基准）")
check("同级图片：./img/a.png", () => {
  assert.equal(resolveRef("docs/guide", "./img/a.png").path, "docs/guide/img/a.png")
})
check("同级图片：img/a.png（无 ./ 前缀）", () => {
  assert.equal(resolveRef("docs/guide", "img/a.png").path, "docs/guide/img/a.png")
})
check("上一级：../a.png", () => {
  assert.equal(resolveRef("docs/guide", "../a.png").path, "docs/a.png")
})
check("根目录的 .md：a.png 不带任何前缀", () => {
  assert.equal(resolveRef("", "a.png").path, "a.png")
})
check("绝对站点路径 /root.png 按网盘根处理", () => {
  assert.equal(resolveRef("docs/guide", "/root.png").path, "root.png")
})
check("多层 . / .. 折叠", () => {
  assert.equal(resolveRef("a/b/c", "../../x/./y.png").path, "a/x/y.png")
})
check("锚点原样保留", () => {
  const r = resolveRef("docs", "#section-1")
  assert.equal(r.external, false)
  assert.equal(r.path, "#section-1")
})
check("外链标记为 external 且不改写", () => {
  const r = resolveRef("docs", "https://example.com/a.png")
  assert.equal(r.external, true)
  assert.equal(r.path, "https://example.com/a.png")
})
check("协议相对地址 //host 也算外链", () => {
  assert.equal(resolveRef("docs", "//cdn.example.com/a.png").external, true)
})
check("mailto: 算外链", () => {
  assert.equal(resolveRef("docs", "mailto:a@b.com").external, true)
})
check("去掉查询串与锚点后取文件路径", () => {
  assert.equal(resolveRef("docs", "b.md?raw=1#top").path, "docs/b.md")
})
check("中文与空格会保留在 path 里（编码交给 URL 构造）", () => {
  assert.equal(resolveRef("资料", "图片 1.png").path, "资料/图片 1.png")
})

console.log("下载 / 内联地址")
check("inlineFileUrl 编码路径并带 inline=1", () => {
  assert.equal(inlineFileUrl("资料/图片 1.png"), "/api/fs/download?path=%E8%B5%84%E6%96%99%2F%E5%9B%BE%E7%89%87%201.png&inline=1")
})
check("downloadFileUrl 编码路径", () => {
  assert.equal(downloadFileUrl("a b.txt"), "/api/fs/download?path=a%20b.txt")
})

console.log("文件 / 目录判定")
check("有扩展名 → 文件", () => assert.equal(looksLikeFile("a/b.txt"), true))
check("无扩展名 → 目录", () => assert.equal(looksLikeFile("a/b"), false))
check("隐藏文件 .env 不算扩展名", () => assert.equal(looksLikeFile("a/.env"), false))
check("多级扩展名 → 文件", () => assert.equal(looksLikeFile("a/b.tar.gz"), true))

console.log(`\n${passed} 项通过${process.exitCode ? "（有失败）" : "，全部通过"}`)
