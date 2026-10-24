import path from "node:path"
import fs from "node:fs"
import { DATA_DIR, ENV_FILE, FILES_DIR, SOFT_DIRS } from "./env.js"
import { getConfig } from "./config.js"
import { httpError } from "./http.js"

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin"
const WIN = process.platform === "win32"

/**
 * 本机文件系统是否不区分大小写。
 *
 * 导出它是为了让前端用**同一个规则**做同名冲突检测：前端原先靠浏览器 UA 猜，
 * 「Windows 上的浏览器访问 Linux 服务端」就会分叉（误报冲突，或静默把一个文件
 * 存成 "A (1).txt"）。现在由服务端通过 /api/auth/me 告知，两边不可能不一致。
 */
export function filesystemCaseInsensitive() {
  return CASE_INSENSITIVE
}

export function normRel(input = "") {
  const raw = String(input).replace(/\\/g, "/")
  if (raw.includes("\0")) throw badPath()
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".")
  for (const part of parts) {
    if (part === "..") throw badPath()
    // Windows 上 `:` 同时代表 NTFS 备用数据流（`notes.txt::$DATA` / `:hidden`）与
    // 驱动器前缀，而这两个都是"同一个文件名、不同字符串"的绕过手段：
    // 判定逻辑按字符串比较，`path.resolve(".env::$DATA")` 不等于 `.env`，
    // 于是 isSensitiveAbs / isHiddenFromGuest 全部失效，但 OS 打开的仍是同一个文件。
    // Windows 文件名本身不允许 `:`，因此在这里一律拒绝不会误伤任何合法文件。
    if (WIN && part.includes(":")) throw badPath()
  }
  return parts.join("/")
}

/**
 * 把绝对路径换成**文件系统真实路径**。
 *
 * 这是所有"按路径字符串做安全判定"的前提：Windows 的 8.3 短名（`PRIVAT~1`）、
 * 符号链接 / junction、大小写变体都会让同一个文件拥有多个不同的字符串表示，
 * 而 `isHiddenFromGuest` / `isSensitiveAbs` 是按字符串比较的 —— 不规范化就等于
 * 用字符串黑名单挡文件系统，一绕就过。
 *
 * - 路径存在：直接 `realpathSync.native`（短名会被展开成长名，链接会被解开）；
 * - 路径不存在（新建/上传目标）：向上找到最近的已存在祖先做 realpath，再把
 *   余下的段拼回去，因此"在隐藏目录里新建文件"也会被规范化到真实目录名下；
 * - 全部失败：原样返回（调用方的边界检查依然有效，绝不因此放行）。
 */
function realpathish(abs) {
  const original = path.resolve(abs)
  let current = original
  const tail = []
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native(current)
      return tail.length ? path.join(real, ...[...tail].reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return original
      tail.push(path.basename(current))
      current = parent
    }
  }
  return original
}

/** Windows 分隔符 → 网盘相对路径使用的 `/` */
function toPosix(value) {
  return path.sep === "/" ? value : value.split(path.sep).join("/")
}

/**
 * 服务自身的临时文件（原子写的中间产物）。它们落在被服务托管的目录里，
 * 内容就是用户正在保存的正文，绝不能出现在列表里、也不能被下载。
 * 命名由 store.js / routes/fs.js / webdav.js / avatars.js 统一生成：
 *   `.<名字>.<pid>.<13 位时间戳>.tmp` / `.davtmp`、`<名字>.restore-<时间戳>`
 */
const INTERNAL_TEMP_RE = /^.+\.\d{1,7}\.\d{10,}\.(?:tmp|davtmp)$|^.+\.restore-\d{10,}$/

export function isInternalTempName(name) {
  return INTERNAL_TEMP_RE.test(String(name || ""))
}

// 错误提示带 errorKey（命名键）供前端本地化，中文原文照旧回传（见 http.js）
function badPath() {
  return httpError(400, "非法路径", { errorKey: "api.fs.path_invalid" })
}

export function resolveSafe(input = "") {
  const rel = normRel(input)
  // 空路径也要走 resolveAny：网盘根目录本身可能是符号链接或位于 8.3 路径下，
  // 这里必须拿到规范化后的根，后续 `abs + 子名` 的拼接才与真实路径一致。
  return resolveAny(rel)
}

export function resolveAny(rel) {
  const first = rel.split("/")[0]
  // SOFT_DIRS 是无原型对象（见 env.js），因此这里不会命中 constructor/toString
  // 之类的继承属性；再做一次类型校验作为双保险
  const softDirAbs = typeof SOFT_DIRS[first] === "string" ? SOFT_DIRS[first] : null
  if (softDirAbs) {
    // 基准目录也规范化：映射目录本身可能就是链接（或路径里带 8.3 短名）
    const base = realpathish(path.resolve(softDirAbs))
    const sub = rel.slice(first.length)
    const subRel = sub.startsWith("/") ? sub.slice(1) : sub
    const resolved = subRel ? realpathish(path.join(base, ...subRel.split("/"))) : base
    // 必须按路径分隔符判断边界，否则 "D:\soft" 会误认为 "D:\soft-secret" 在内部。
    // 这里判断的是**规范化之后**的路径，因此中间层符号链接指向根外时也会被拦下。
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw badPath()
    const canonicalRel = resolved === base ? first : joinRel(first, toPosix(path.relative(base, resolved)))
    if (isInternalTempName(path.basename(resolved))) throw notFound()
    // 软目录常被用来映射项目目录（模板里甚至给过 "./"），那里放着 .env（超管明文
    // 密码）与 data/（会话签名密钥、口令哈希、日志、备份）。这些属于服务自身，
    // 永远不能通过网盘接口读写 —— 与访客/成员身份无关。
    if (isSensitiveAbs(resolved)) throw notFound()
    return { abs: resolved, rel: canonicalRel, isSoft: true, softName: first, softBase: base }
  }
  // 同理：网盘根目录本身也可能是链接，先规范化再拼接与比较
  const root = realpathish(path.resolve(FILES_DIR))
  const abs = rel ? path.join(root, ...rel.split("/")) : root
  const resolved = realpathish(abs)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw badPath()
  const canonicalRel = resolved === root ? "" : toPosix(path.relative(root, resolved))
  if (isInternalTempName(path.basename(resolved))) throw notFound()
  // 同样的拦截也要作用在网盘本体这一侧：如果有人把 FILES_DIR 设成项目根目录，
  // 那么 .env 与 data/ 就都落在"网盘里"了，凭据与运行数据必须依然拿不到。
  // 默认布局（FILES_DIR=data/files）下这条永远不成立，因此不影响正常使用。
  if (isSensitiveAbs(resolved)) throw notFound()
  // 返回**规范化**后的相对路径：后续所有判定（访客隐藏、小组可见范围、敏感名）
  // 都基于它，因此 8.3 短名 / 符号链接无法再让同一个文件出现两种说法。
  return { abs: resolved, rel: canonicalRel, isSoft: false }
}

function notFound() {
  return httpError(404, "文件或目录不存在", { errorKey: "api.fs.not_found" })
}

/**
 * `data/` 下属于"服务自身运行数据"的条目名（相对 DATA_DIR 的第一段）。
 * 不在这个集合里的（也就是 `files/`）才是网盘内容本体。
 */
const SENSITIVE_DATA_ENTRIES = new Set([
  ".jwt-secret",
  "config.json",
  "users.json",
  "groups.json",
  "todos.json",
  "shares.json",
  "backups",
  "logs",
  "metrics",
  "tmp",
  "trash",
  "avatars",
  // 界面语言文件同样属于"服务自身可读写的数据"：写进去的译文会直接渲染到所有
  // 使用该语言的界面上，不该由网盘用户（哪怕是成员）随意改动
  "lang",
  // 图片缩略图缓存（v2.0）：只是派生数据，但同样不该经网盘接口被列举 / 下载
  "thumbs",
  // 插件包（v2.0）：第三方 JS/CSS 与清单，绝不能被网盘接口读到
  "plugins",
])

/**
 * 是不是"服务自身的运行时/凭据文件"。
 *
 * 背景：FILES_SOFT_DIR 可以把任意目录映射成只读虚拟文件夹，而自动生成的 .env
 * 模板给的示例就是 "./"（项目根目录）。一旦这样映射，匿名访客按路径就能把
 * .env（超管明文密码）和 data/.jwt-secret（签发会话的密钥）下载走 —— 等于全盘
 * 接管。这里把这类路径统一挡掉。
 *
 * 判定按"相对 DATA_DIR 的第一段名字"，因此与 FILES_DIR 放在哪里无关：
 *   - `data/files/**`（网盘内容本体）→ 放行；
 *   - `data/{config,users,groups,todos}.json`、`data/.jwt-secret`、`data/{backups,
 *     logs,metrics,tmp,trash,avatars}/**` → 拒绝；
 *   - `FILES_DIR` 在 data/ 之外时不受影响。
 * 这样即使有人把 FILES_DIR 设成项目根目录（那样 .env 与 data/ 都落在"网盘里"），
 * 凭据与运行数据依然拿不到。
 */
export function isSensitiveAbs(abs) {
  const resolved = path.resolve(abs)
  // Windows / macOS 的文件系统不区分大小写：`.ENV`、`Data\Config.json` 与真实文件
  // 是同一个。比较前统一归一，否则一个大小写变形就能把这条防线整个绕开。
  const norm = CASE_INSENSITIVE ? resolved.toLowerCase() : resolved
  // ---- 第一条：按**文件名**拦住凭据类文件，与它放在哪个目录无关 ----
  // 只知道"项目根下的 .env"是不够的：迁移备份目录里放着旧 .env 副本
  // （`.migration-backup/xxx/server.env`）、旧会话密钥（`server-data/.jwt-secret`），
  // 一旦软目录映射到项目根，这些就是现成的口令与签发密钥。
  // 也要覆盖常见的备份命名（`.env.bak` / `.env.local` / `.env.old` / `prod.env`），
  // 它们的内容同样是明文口令。
  const baseName = CASE_INSENSITIVE ? path.basename(norm) : path.basename(resolved)
  if (baseName === ".env" || baseName.endsWith(".env") || /^\.env[.\-_]/.test(baseName)) return true
  if (baseName === ".jwt-secret" || baseName.startsWith(".jwt-secret")) return true
  const envFile = path.resolve(ENV_FILE)
  if (norm === (CASE_INSENSITIVE ? envFile.toLowerCase() : envFile)) return true
  const dataRoot = path.resolve(DATA_DIR)
  const dataNorm = CASE_INSENSITIVE ? dataRoot.toLowerCase() : dataRoot
  // data/ 目录**本身**放行：FILES_DIR 有可能就设在 data/ 上（把文件直接放在
  // 配置旁边），那样网盘根目录就是 data/，把根目录整个挡掉会让网盘全空。
  // 需要挡的是它里面的具体条目（下一段的判断）。
  if (norm === dataNorm) return false
  if (!norm.startsWith(dataNorm + path.sep)) return false
  const firstRaw = norm.slice(dataNorm.length + 1).split(path.sep)[0]
  const first = CASE_INSENSITIVE ? firstRaw.toLowerCase() : firstRaw
  return SENSITIVE_DATA_ENTRIES.has(first)
}

export function getSoftDirEntries() {
  const entries = []
  for (const [name, absPath] of Object.entries(SOFT_DIRS)) {
    try {
      const stat = fs.statSync(absPath, { throwIfNoEntry: false })
      entries.push({
        name,
        type: "dir",
        size: 0,
        mtime: stat?.mtimeMs ?? 0,
        softReadOnly: true,
        hiddenFromGuest: isHiddenFromGuest(name),
      })
    } catch {
      entries.push({
        name,
        type: "dir",
        size: 0,
        mtime: 0,
        softReadOnly: true,
        hiddenFromGuest: isHiddenFromGuest(name),
      })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
}

export function isSoftPath(rel) {
  if (!rel) return false
  const first = rel.split("/")[0]
  return first in SOFT_DIRS
}

const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

export function validateName(name) {
  if (typeof name !== "string") return "名称无效"
  const trimmed = name.trim()
  if (!trimmed) return "名称不能为空"
  if (trimmed.length > 200) return "名称过长"
  if (trimmed === "." || trimmed === "..") return "名称无效"
  if (INVALID_NAME_CHARS.test(trimmed)) return '名称不能包含 \\ / : * ? " < > | 等字符'
  if (/[. ]$/.test(trimmed)) return "名称不能以空格或点结尾"
  return null
}

/**
 * `validateName` 的返回值（中文提示）→ 命名键。
 *
 * validateName 只回字符串（大量调用方按"有值即非法"判断），所以键只能按串反查。
 * 这里的键**必须与上面 return 的字面量逐字一致**，改文案时两张表要一起改。
 */
const NAME_ERROR_KEYS = {
  "名称无效": "api.fs.name_invalid",
  "名称不能为空": "api.fs.name_empty",
  "名称过长": "api.fs.name_too_long",
  "名称不能包含 \\ / : * ? \" < > | 等字符": "api.fs.name_invalid_chars",
  "名称不能以空格或点结尾": "api.fs.name_trailing_spaces",
}

/** 取 validateName 提示对应的命名键；未知提示返回 undefined（前端回落到中文原文） */
export function nameErrorKey(message) {
  return NAME_ERROR_KEYS[message]
}

export function sanitizeFileName(name) {
  const base = path.basename(String(name || "file")).trim()
  const cleaned = base.replace(INVALID_NAME_CHARS, "_").replace(/[. ]+$/, "")
  return cleaned || "file"
}

function comparable(rel) {
  return CASE_INSENSITIVE ? rel.toLowerCase() : rel
}

/** 路径比较：Windows/macOS 下不区分大小写，与访客可见性判定保持一致 */
export function samePath(a, b) {
  return comparable(String(a)) === comparable(String(b))
}

/** target 是否等于 base 或位于 base 之内（用于清理被删除/移动的隐藏项） */
export function isSameOrInside(target, base) {
  const t = comparable(String(target))
  const b = comparable(String(base))
  return t === b || t.startsWith(b + "/")
}

export function isHiddenFromGuest(rel) {
  const hidden = getConfig().guestHiddenPaths
  if (!hidden.length) return false
  return hidden.some((h) => isSameOrInside(rel, h))
}

export function isExactHidden(rel) {
  return getConfig().guestHiddenPaths.some((h) => samePath(h, rel))
}

export function guestBlocked(req, rel) {
  return req.auth.role === "guest" && isHiddenFromGuest(rel)
}

export function joinRel(rel, name) {
  return rel ? `${rel}/${name}` : name
}
