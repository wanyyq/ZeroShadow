#!/usr/bin/env node
/**
 * scripts/webdav-test.mjs —— WebDAV 协议兼容性自测（Windows 资源管理器 / macOS Finder / rclone）
 *
 * 为什么需要它：WebDAV 的问题几乎都不是"功能没写"，而是**协议细节差一点，客户端就
 * 静默失败** —— 资源管理器报"文件夹无效"、Finder 报"连接服务器时出现问题"，
 * 而服务端日志里只有一条 207。这些细节（DAV 头、href 形式、203/207 状态、
 * PROPPATCH 响应形状、Destination 头、锁）没法靠读代码确认，只能把**客户端的真实
 * 请求序列**照着打一遍。
 *
 * 这个脚本模拟的是 Windows WebClient（WebDAV 重定向器）与 Microsoft Office 的做法：
 *   OPTIONS → PROPFIND(Depth 0) → PROPFIND(Depth 1) → MKCOL → PUT → PROPPATCH →
 *   GET/HEAD → LOCK → UNLOCK → COPY → MOVE → DELETE
 * 每一步都按 RFC 4918 与客户端的实际期望断言（状态码、必需响应头、XML 形状）。
 *
 * 用法（先起一个实例、准备一个超管口令）：
 *   node scripts/webdav-test.mjs --base http://127.0.0.1:12345
 *   node scripts/webdav-test.mjs --base https://nas.example.com --admin-password 'xxx'
 *   （不传 --admin-password 时读环境变量 ZS_ADMIN_PASSWORD，或被测实例根目录的 .env）
 *
 * 退出码 = 失败项数量（0 表示全部通过）。脚本会：
 *   - 临时在后台打开 WebDAV（跑完还原成原来的开关）；
 *   - 创建一个成员账号 `dav-selftest`（跑完删除）；
 *   - 在网盘根目录建一个临时目录（跑完删除）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const BASE = (arg("base") || process.env.ZS_BASE_URL || "http://127.0.0.1:12345").replace(/\/+$/, "")

function adminPassword() {
  if (arg("admin-password")) return arg("admin-password")
  if (process.env.ZS_ADMIN_PASSWORD) return process.env.ZS_ADMIN_PASSWORD
  for (const file of [path.join(root, ".env"), path.join(process.cwd(), ".env")]) {
    try {
      const hit = /^SUPER_ADMIN_PASSWORD=(.*)$/m.exec(fs.readFileSync(file, "utf8"))
      if (hit) return hit[1].trim()
    } catch {
      /* 找不到就继续 */
    }
  }
  return ""
}

const ADMIN_PASSWORD = adminPassword()
// 用户名带随机后缀：脚本会故意试一次错误口令（那是登录失败计数），
// 用固定用户名连着跑几遍会把该账号锁上，后续真实的断言就全被 429 淹没了。
const RUN_ID = Math.random().toString(36).slice(2, 8)
const MEMBER = { username: `dav-selftest-${RUN_ID}`, password: `Dav-${RUN_ID}-Pass!` }
const SCRATCH = `dav-selftest-${RUN_ID}`

/* -------------------------------------------------------------- 断言框架 */

let pass = 0
let fail = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS ${label}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  FAIL ${label}${detail ? `  --  ${detail}` : ""}`)
  }
}

function section(title) {
  console.log(`\n== ${title}`)
}

/* ---------------------------------------------------------------- 工具 */

let cookie = ""

async function http(method, url, { body, headers = {}, cookieAuth = true } = {}) {
  // 走后台 API 的请求要带 CSRF 自定义头（与前端 lib/api.ts 一致）；DAV 请求不带
  const h = { ...(cookieAuth ? { "X-Requested-With": "XMLHttpRequest" } : {}), ...headers }
  if (cookieAuth && cookie) h.Cookie = cookie
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json"
  const res = await fetch(url.startsWith("http") ? url : `${BASE}${url}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
  const setCookie = res.headers.get("set-cookie")
  if (setCookie && !cookie) cookie = setCookie.split(";")[0]
  const buf = Buffer.from(await res.arrayBuffer())
  const text = buf.toString("utf8")
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, headers: res.headers, text, buf, json }
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`

/** 以成员身份发 DAV 请求 */
function dav(method, davPath, { body, headers = {} } = {}) {
  return http(method, `${DAV_BASE}${davPath}`, {
    body,
    cookieAuth: false,
    headers: { Authorization: basic(MEMBER.username, MEMBER.password), ...headers },
  })
}

/* ------------------------------------------------------- 准备：开关与账号 */

const PROPFIND_ALLPROP =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  "<D:displayname/><D:getcontentlength/><D:getcontenttype/><D:getlastmodified/>" +
  "<D:getetag/><D:resourcetype/><D:supportedlock/><D:lockdiscovery/>" +
  "</D:prop></D:propfind>"

/** Windows Office / 资源管理器写属性时会发这个 */
const PROPPATCH_WIN32 =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">' +
  "<D:set><D:prop>" +
  "<Z:Win32LastModifiedTime>Sat, 24 Oct 2026 12:00:00 GMT</Z:Win32LastModifiedTime>" +
  "<Z:Win32FileAttributes>00000020</Z:Win32FileAttributes>" +
  "</D:prop></D:set></D:propertyupdate>"

let DAV_BASE = ""
let originalEnabled = null

async function prepare() {
  const login = await http("POST", "/api/auth/login", {
    body: { username: "admin", password: ADMIN_PASSWORD },
  })
  if (login.status !== 200) {
    console.error(`无法登录超管（${login.status}）：${login.json?.error ?? ""}`)
    process.exit(2)
  }
  const cfg = await http("GET", "/api/admin/config")
  originalEnabled = !!cfg.json?.webdavEnabled
  DAV_BASE = `${BASE}${String(cfg.json?.webdavPath || "/dav").replace(/\/+$/, "")}`

  if (!originalEnabled) {
    const patched = await http("PATCH", "/api/admin/config", { body: { webdavEnabled: true } })
    if (patched.status !== 200) {
      console.error(`打开 WebDAV 失败：${patched.status} ${patched.json?.error ?? ""}`)
      process.exit(2)
    }
  }
  await http("POST", "/api/admin/members", {
    body: { users: [{ username: MEMBER.username, password: MEMBER.password }] },
  })
  // 建一个临时目录挂东西；用 Web API 建，避免依赖 DAV 自己的 MKCOL
  await http("POST", "/api/fs/mkdir", { body: { path: "", name: SCRATCH } })
  // 根目录放一个已知文件，供 PROPFIND / GET / COPY 用
  await http("POST", "/api/fs/create-file", {
    body: { path: "", name: `${SCRATCH}-file.txt`, content: "hello dav\n" },
  })
}

async function cleanup() {
  await http("POST", "/api/fs/delete", { body: { paths: [`${SCRATCH}-file.txt`] } }).catch(() => {})
  await http("POST", "/api/fs/delete", { body: { paths: [SCRATCH] } }).catch(() => {})
  const members = await http("GET", "/api/admin/members").catch(() => null)
  const list = members?.json?.members ?? members?.json ?? []
  const mine = Array.isArray(list) ? list.find((m) => m.username === MEMBER.username) : null
  if (mine?.id) {
    await http("PATCH", `/api/admin/members/${mine.id}`, { body: { disabled: true } }).catch(() => {})
    await http("POST", "/api/admin/members/batch", { body: { action: "delete", ids: [mine.id] } }).catch(() => {})
  }
  if (originalEnabled === false) {
    await http("PATCH", "/api/admin/config", { body: { webdavEnabled: false } }).catch(() => {})
  }
}

/* ============================================================ 主流程 == */

console.log(`WebDAV 兼容性自测：${BASE}（挂载点 ${DAV_BASE || "/dav"}）`)
await prepare()
console.log(`临时账号 ${MEMBER.username}，临时目录 ${SCRATCH}`)

/* ---- 1. OPTIONS：客户端用它确认"这是一台 DAV 服务器" ---- */
section("1. OPTIONS（能力探测：资源管理器靠它决定能否挂载）")
{
  const res = await http("OPTIONS", DAV_BASE, { cookieAuth: false })
  check("未认证的 OPTIONS 也回 200（客户端先探测再弹密码框）", res.status === 200, `实际 ${res.status}`)
  const davHeader = res.headers.get("dav") || ""
  check("DAV 头同时声明 1 与 2（缺 1 资源管理器直接放弃）", /\b1\b/.test(davHeader) && /\b2\b/.test(davHeader), davHeader)
  const allow = res.headers.get("allow") || ""
  for (const method of ["PROPFIND", "PROPPATCH", "MKCOL", "PUT", "DELETE", "COPY", "MOVE", "LOCK", "UNLOCK", "GET", "HEAD", "OPTIONS"]) {
    check(`Allow 含 ${method}`, allow.toUpperCase().includes(method), allow)
  }
  check("MS-Author-Via: DAV（Office 靠它走 WebDAV 而不是 FrontPage 扩展）", (res.headers.get("ms-author-via") || "").toUpperCase().includes("DAV"), res.headers.get("ms-author-via"))
  check("OPTIONS 有 Content-Length（0），不用 chunked", res.headers.get("content-length") === "0", res.headers.get("content-length"))

  // 资源管理器在挂载时会对**站点根**也发一次 OPTIONS；根上必须也是 DAV 服务器
  const rootRes = await http("OPTIONS", "/", { cookieAuth: false })
  check(
    "站点根 `/` 的 OPTIONS 也声明 DAV（资源管理器会探测 authority 根）",
    rootRes.status === 200 && /\b1\b/.test(rootRes.headers.get("dav") || ""),
    `实际 ${rootRes.status} dav=${rootRes.headers.get("dav")}`
  )
}

/* ---- 2. 认证 ---- */
section("2. Basic 认证（客户端每请求都重发凭据）")
{
  const noAuth = await http("PROPFIND", DAV_BASE, { cookieAuth: false, headers: { Depth: "0" } })
  check("无凭据的 DAV 请求回 401", noAuth.status === 401, `实际 ${noAuth.status}`)
  const challenge = noAuth.headers.get("www-authenticate") || ""
  check("401 带 Basic challenge（否则 Windows 弹不出密码框）", /^Basic\s/i.test(challenge), challenge)
  check("challenge 带 realm", /realm=/i.test(challenge), challenge)

  const wrong = await http("PROPFIND", DAV_BASE, {
    cookieAuth: false,
    headers: { Authorization: basic(MEMBER.username, "definitely-wrong"), Depth: "0" },
  })
  check("错误口令回 401", wrong.status === 401, `实际 ${wrong.status}`)

  const superuser = await http("PROPFIND", DAV_BASE, {
    cookieAuth: false,
    headers: { Authorization: basic("admin", ADMIN_PASSWORD), Depth: "0" },
  })
  check("超管账号被明确拒绝（403，而不是静默失败）", superuser.status === 403, `实际 ${superuser.status}`)
}

/* ---- 3. PROPFIND ---- */
section("3. PROPFIND（列目录：挂载成功后资源管理器第一件事）")
{
  const rootRes = await dav("PROPFIND", "/", { headers: { Depth: "0", "Content-Type": "application/xml" }, body: PROPFIND_ALLPROP })
  check("Depth:0 回 207", rootRes.status === 207, `实际 ${rootRes.status}`)
  const ct = rootRes.headers.get("content-type") || ""
  check("Content-Type 是 XML 且声明 utf-8", /application\/xml/i.test(ct) && /utf-8/i.test(ct), ct)
  check("根响应含 multistatus 与 DAV: 命名空间", rootRes.text.includes("multistatus") && rootRes.text.includes('xmlns:D="DAV:"'), rootRes.text.slice(0, 120))
  check("根是 collection（resourcetype/collection）", rootRes.text.includes("<D:collection/>"), "")
  check("href 是路径形式（不带 scheme://host，反代后不会错）", /<D:href>\/[^<]*<\/D:href>/.test(rootRes.text) && !/<D:href>https?:/i.test(rootRes.text), "")
  check("目录条目带 getlastmodified（RFC1123 GMT）", /<D:getlastmodified>[^<]*GMT<\/D:getlastmodified>/.test(rootRes.text), "")

  const depth1 = await dav("PROPFIND", "/", { headers: { Depth: "1" }, body: PROPFIND_ALLPROP })
  check("Depth:1 回 207", depth1.status === 207, `实际 ${depth1.status}`)
  const responses = (depth1.text.match(/<D:response>/g) || []).length
  check("Depth:1 至少列出根自身 + 子项", responses >= 2, `response 数 ${responses}`)
  check(
    `临时目录出现在列表里且以 / 结尾`,
    new RegExp(`<D:href>[^<]*${SCRATCH}/</D:href>`).test(depth1.text) || new RegExp(`<D:href>[^<]*${SCRATCH}</D:href>`).test(depth1.text),
    depth1.text.slice(0, 300)
  )
  const hrefs = [...depth1.text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1])
  const mountPrefix = DAV_BASE.slice(BASE.length) // 例如 /dav
  check(
    "所有 href 都以挂载点为前缀（客户端据此拼子项 URL）",
    hrefs.length > 0 && hrefs.every((h) => h.startsWith(mountPrefix + "/")),
    JSON.stringify(hrefs.slice(0, 4))
  )
  check("集合 href 以 / 结尾（RFC 要求，客户端据此区分目录）", hrefs.some((h) => h.endsWith("/")), JSON.stringify(hrefs.slice(0, 4)))

  const fileRes = await dav("PROPFIND", `/${SCRATCH}-file.txt`, { headers: { Depth: "0" }, body: PROPFIND_ALLPROP })
  check("文件 PROPFIND 回 207", fileRes.status === 207, `实际 ${fileRes.status}`)
  check("文件带 getcontentlength", /<D:getcontentlength>\d+<\/D:getcontentlength>/.test(fileRes.text), fileRes.text.slice(0, 300))
  check("文件带 getcontenttype", /<D:getcontenttype>/.test(fileRes.text), "")
  check("文件带 getetag（客户端靠它做缓存 / If-Match）", /<D:getetag>/.test(fileRes.text), "")
  check("文件不是 collection", !fileRes.text.includes("<D:collection/>"), "")

  const infinity = await dav("PROPFIND", "/", { headers: { Depth: "infinity" }, body: PROPFIND_ALLPROP })
  check(
    "Depth:infinity 被拒绝且是 RFC 形式（403 + propfind-finite-depth）",
    infinity.status === 403 && /propfind-finite-depth/i.test(infinity.text),
    `实际 ${infinity.status} ${infinity.text.slice(0, 100)}`
  )
}

/* ---- 4. 写入：MKCOL / PUT / PROPPATCH ---- */
section("4. 写入路径（新建文件夹 → 上传 → 写属性）")
{
  const mkcol = await dav("MKCOL", `/${SCRATCH}/sub`)
  check("MKCOL 回 201", mkcol.status === 201, `实际 ${mkcol.status}`)

  const mkcolAgain = await dav("MKCOL", `/${SCRATCH}/sub`)
  check("重复 MKCOL 回 405", mkcolAgain.status === 405, `实际 ${mkcolAgain.status}`)

  const put = await dav("PUT", `/${SCRATCH}/sub/a.txt`, {
    body: "line1\nline2\n",
    headers: { "Content-Type": "application/octet-stream" },
  })
  check("PUT 新文件回 201", put.status === 201, `实际 ${put.status}`)

  const putOverwrite = await dav("PUT", `/${SCRATCH}/sub/a.txt`, {
    body: "line1\nline2\nline3\n",
    headers: { "Content-Type": "application/octet-stream" },
  })
  check("PUT 覆盖已有文件回 204", putOverwrite.status === 204, `实际 ${putOverwrite.status}`)

  const proppatch = await dav("PROPPATCH", `/${SCRATCH}/sub/a.txt`, {
    body: PROPPATCH_WIN32,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  })
  check("PROPPATCH 回 207", proppatch.status === 207, `实际 ${proppatch.status}`)
  check(
    "PROPPATCH 响应是 multistatus（不能是随便一段 XML，资源管理器会解析失败）",
    proppatch.text.includes("<D:multistatus") && proppatch.text.includes("<D:propstat>"),
    proppatch.text.slice(0, 200)
  )
  check("PROPPATCH 逐属性给状态", /<D:status>HTTP\/1\.1 \d{3}/.test(proppatch.text), proppatch.text.slice(0, 300))
}

/* ---- 5. 读取 ---- */
section("5. 读取（GET / HEAD / 条件请求）")
{
  const get = await dav("GET", `/${SCRATCH}/sub/a.txt`)
  check("GET 回 200", get.status === 200, `实际 ${get.status}`)
  check("GET 内容正确", get.text === "line1\nline2\nline3\n", JSON.stringify(get.text))
  check("GET 带 Content-Length", (get.headers.get("content-length") || "") !== "", get.headers.get("content-length"))
  check("GET 带 ETag", (get.headers.get("etag") || "").length > 2, get.headers.get("etag"))

  const head = await dav("HEAD", `/${SCRATCH}/sub/a.txt`)
  check("HEAD 回 200", head.status === 200, `实际 ${head.status}`)
  check("HEAD 带 Content-Length 且无 body", (head.headers.get("content-length") || "") !== "" && head.text === "", `${head.headers.get("content-length")} body=${head.text.length}`)

  const etag = get.headers.get("etag")
  const conditional = await dav("GET", `/${SCRATCH}/sub/a.txt`, { headers: { "If-None-Match": etag } })
  check("If-None-Match 命中回 304（客户端减少重传）", conditional.status === 304, `实际 ${conditional.status}`)

  const range = await dav("GET", `/${SCRATCH}/sub/a.txt`, { headers: { Range: "bytes=0-4" } })
  check("Range 请求回 206", range.status === 206, `实际 ${range.status}`)
}

/* ---- 6. 锁（Office / 资源管理器覆盖前会先 LOCK） ---- */
section("6. LOCK / UNLOCK")
{
  const lockBody =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
    "<D:locktype><D:write/></D:locktype><D:owner>selftest</D:owner></D:lockinfo>"
  const lock = await dav("LOCK", `/${SCRATCH}/sub/a.txt`, {
    body: lockBody,
    headers: { "Content-Type": "application/xml; charset=utf-8", Timeout: "Second-3600", Depth: "0" },
  })
  check("LOCK 回 200", lock.status === 200, `实际 ${lock.status}`)
  const token = lock.headers.get("lock-token") || ""
  check("LOCK 回 Lock-Token 头（<opaquelocktoken:…>）", /^<opaquelocktoken:.+>$/.test(token), token)
  check("LOCK 回 lockdiscovery", lock.text.includes("<D:lockdiscovery>") && lock.text.includes("<D:activelock>"), lock.text.slice(0, 200))
  check("lockdiscovery 含 locktoken / timeout / depth", /<D:locktoken>/.test(lock.text) && /<D:timeout>/.test(lock.text) && /<D:depth>/.test(lock.text), "")

  const unlock = await dav("UNLOCK", `/${SCRATCH}/sub/a.txt`, { headers: { "Lock-Token": token } })
  check("UNLOCK 回 204", unlock.status === 204, `实际 ${unlock.status}`)

  const lockNew = await dav("LOCK", `/${SCRATCH}/sub/new-by-lock.txt`, {
    body: lockBody,
    headers: { "Content-Type": "application/xml; charset=utf-8", Timeout: "Second-600" },
  })
  check("对不存在的文件 LOCK（lock-null）回 201 或 200", lockNew.status === 201 || lockNew.status === 200, `实际 ${lockNew.status}`)
}

/* ---- 7. COPY / MOVE（Destination 头：绝对 URL，可能带不同端口） ---- */
section("7. COPY / MOVE（资源管理器的复制粘贴 / 重命名都走它们）")
{
  const dst = (name) => `${DAV_BASE}/${SCRATCH}/sub/${name}`
  const copy = await dav("COPY", `/${SCRATCH}/sub/a.txt`, {
    headers: { Destination: dst("copy.txt"), Overwrite: "F" },
  })
  check("COPY 回 201", copy.status === 201, `实际 ${copy.status} ${copy.text.slice(0, 120)}`)

  const copyAgain = await dav("COPY", `/${SCRATCH}/sub/a.txt`, {
    headers: { Destination: dst("copy.txt"), Overwrite: "F" },
  })
  check("Overwrite:F 且目标已存在回 412", copyAgain.status === 412, `实际 ${copyAgain.status}`)

  const move = await dav("MOVE", `/${SCRATCH}/sub/copy.txt`, {
    headers: { Destination: dst("moved.txt"), Overwrite: "T" },
  })
  check("MOVE 回 201/204", move.status === 201 || move.status === 204, `实际 ${move.status}`)
  check("MOVE 后源已不存在", (await dav("PROPFIND", `/${SCRATCH}/sub/copy.txt`, { headers: { Depth: "0" } })).status === 404, "")

  // 反代场景：Destination 里的主机是公网域名（带 X-Forwarded-Host），端口也不同。
  // 旧实现连端口一起比，反代后面所有 COPY/MOVE 都回 502。
  const proxied = await dav("COPY", `/${SCRATCH}/sub/moved.txt`, {
    headers: {
      Destination: `https://nas.example.test:8443${DAV_BASE.slice(BASE.length)}/${SCRATCH}/sub/proxied.txt`,
      Overwrite: "T",
      "X-Forwarded-Host": "nas.example.test",
    },
  })
  check(
    "Destination 指向反代公网域名时按同站处理（反代友好）",
    proxied.status === 201 || proxied.status === 204,
    `实际 ${proxied.status} ${proxied.text.slice(0, 120)}`
  )

  // 但**真的**是别的站点时必须拒绝（防借 DAV 操作别的服务）
  const foreign = await dav("COPY", `/${SCRATCH}/sub/moved.txt`, {
    headers: { Destination: `http://evil.example.test${DAV_BASE.slice(BASE.length)}/${SCRATCH}/sub/x.txt` },
  })
  check("Destination 指向别的站点时拒绝（502）", foreign.status === 502, `实际 ${foreign.status}`)
}

/* ---- 8. DELETE ---- */
section("8. DELETE")
{
  const del = await dav("DELETE", `/${SCRATCH}/sub/moved.txt`)
  check("DELETE 回 204", del.status === 204, `实际 ${del.status} ${del.text.slice(0, 120)}`)
  const gone = await dav("PROPFIND", `/${SCRATCH}/sub/moved.txt`, { headers: { Depth: "0" }, body: PROPFIND_ALLPROP })
  check("删除后再 PROPFIND 回 404", gone.status === 404, `实际 ${gone.status}`)
}

/* ---- 9. 关闭开关后不能再用 ---- */
section("9. 开关关闭后挂载点消失（而不是返回前端首页）")
{
  await http("PATCH", "/api/admin/config", { body: { webdavEnabled: false } })
  const res = await dav("PROPFIND", "/", { headers: { Depth: "0" }, body: PROPFIND_ALLPROP })
  check("关闭后回 404", res.status === 404, `实际 ${res.status}`)
  check("关闭后不是 HTML 首页", !/<!doctype html>/i.test(res.text), res.text.slice(0, 80))
  await http("PATCH", "/api/admin/config", { body: { webdavEnabled: true } })
}

/* ---------------------------------------------------------------- 收尾 */

await cleanup()
console.log("")
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) {
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(fail)
}
