/**
 * scripts/download-mode-test.mjs —— 下载决策的单测（`web/src/lib/download-mode.ts`）。
 *
 * 为什么值得单测：v2.1.0 修过一次"点击下载没反应"，根因是**代码把失败吞掉了**，
 * 而且"内置浏览器拦 blob 下载"这种事在桌面浏览器里永远不会复现。把判断抽成纯函数
 * 之后，这些边界就能在这里钉死，不必等用户来报"点了没反应"。
 *
 * 运行：node --experimental-strip-types scripts/download-mode-test.mjs
 */
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const mod = await import(pathToFileURL(path.join(ROOT, "web", "src", "lib", "download-mode.ts")).href)
const { isInAppUserAgent, pickDownloadMode, BLOB_DOWNLOAD_MAX } = mod

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

console.log("== 下载决策（lib/download-mode.ts）")

check("内置浏览器 UA 全部被识别", () => {
  for (const ua of [
    "Mozilla/5.0 (iPhone) MicroMessenger/8.0.44",
    "Mozilla/5.0 QQ/8.9.63",
    "Mozilla/5.0 Weibo/12.0",
    "Mozilla/5.0 DingTalk/7.0",
    "Mozilla/5.0 AlipayClient/10.5",
    "Mozilla/5.0 UCBrowser/13.4",
    "Mozilla/5.0 Quark/5.0",
    "Mozilla/5.0 baiduboxapp/13.0",
    "Mozilla/5.0 FBAN/FBIOS",
    "Mozilla/5.0 Instagram 250",
    "Mozilla/5.0 Line/13.0",
  ]) {
    assert.equal(isInAppUserAgent(ua), true, `未识别：${ua}`)
  }
})

check("普通浏览器 UA 不会被误判", () => {
  for (const ua of [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/141.0",
    "Mozilla/5.0 (Linux; Android 14) Chrome/141.0 Mobile Safari/537.36",
    "",
  ]) {
    assert.equal(isInAppUserAgent(ua), false, `误判：${ua}`)
  }
})

check("4xx 探路结果一律报错（不能把 JSON 当文件下下来）", () => {
  for (const status of [400, 401, 403, 404, 429]) {
    assert.equal(pickDownloadMode({ status, size: 10 }), "error", `status=${status}`)
    // 即使是"内置浏览器 + 小文件"也要报错
    assert.equal(pickDownloadMode({ status, size: 10 }, { inApp: true }), "error", `status=${status} inApp`)
  }
})

check("内置浏览器走原生下载（blob 会被 WebView 拦掉）", () => {
  assert.equal(pickDownloadMode({ status: 200, size: 1024 }, { inApp: true }), "native")
  assert.equal(pickDownloadMode({ status: 200, size: 0 }, { inApp: true }), "native")
})

check("大文件走原生下载（不在内存里缓冲）", () => {
  assert.equal(pickDownloadMode({ status: 200, size: BLOB_DOWNLOAD_MAX + 1 }), "native")
  assert.equal(pickDownloadMode({ status: 200, size: BLOB_DOWNLOAD_MAX }), "blob")
})

check("普通浏览器的小文件仍走 blob（能精确控制中文文件名）", () => {
  assert.equal(pickDownloadMode({ status: 200, size: 2048 }), "blob")
  // 体积未知（0）也走 blob：小文件 + 未知长度是常见情况
  assert.equal(pickDownloadMode({ status: 200, size: 0 }), "blob")
})

check("探路没做成（status=0 / 5xx）也走 blob，由 GET 再兜一次", () => {
  assert.equal(pickDownloadMode({ status: 0, size: 0 }), "blob")
  assert.equal(pickDownloadMode({ status: 500, size: 0 }), "blob")
  assert.equal(pickDownloadMode({}, {}), "blob")
})

console.log("")
console.log(fail ? `❌ 通过 ${pass} / 失败 ${fail}` : `✅ 全部 ${pass} 项通过`)
process.exit(fail ? 1 : 0)
