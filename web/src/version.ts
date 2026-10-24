/**
 * 前端统一的产品版本号。
 *
 * 之所以要有这个文件：版本号不能从 package.json 读（浏览器里拿不到），
 * 以前它是散落在页面里的字面量，改一次要翻多处。现在 web 侧只认这一份。
 *
 * 改版本号时**必须同步这 6 处**（少一处就会不一致，第 6 项还会让冒烟测试变红）：
 *   1. 根 `package.json` 的 `version`
 *   2. `server/package.json` 的 `version`
 *   3. `web/package.json` 的 `version`
 *   4. `server/index.js` 里 `/api/meta` 的响应（是字面量，不从 package.json 读）
 *   5. 本文件
 *   6. `web/public/sw.js` 的 `VERSION`（`smoke-test.ps1` 第 16 组会断言它等于
 *      根 `package.json` 的 `version`；它只用于缓存名，忘了改不会报错但会让旧缓存留下来）
 */
export const VERSION = "2.1.0"
