/**
 * 前端统一的产品版本号。
 *
 * 之所以要有这个文件：版本号不能从 package.json 读（浏览器里拿不到），
 * 以前它是散落在页面里的字面量，改一次要翻多处。现在 web 侧只认这一份。
 *
 * 改版本号时必须同步的地方（见 docs/开发者指南.md「常见改动指引」）：
 *   1. 根 package.json
 *   2. server/index.js 的 /api/meta
 *   3. 本文件
 */
export const VERSION = "1.1.0"
