import path from "node:path"
import fs from "node:fs"
import { DATA_DIR, ENV_FILE, FILES_DIR, SOFT_DIRS } from "./env.js"
import { getConfig } from "./config.js"

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin"

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
  }
  return parts.join("/")
}

function badPath() {
  const err = new Error("非法路径")
  err.status = 400
  return err
}

export function resolveSafe(input = "") {
  const rel = normRel(input)
  if (!rel) return { abs: FILES_DIR, rel: "", isSoft: false }
  return resolveAny(rel)
}

export function resolveAny(rel) {
  const first = rel.split("/")[0]
  // SOFT_DIRS 是无原型对象（见 env.js），因此这里不会命中 constructor/toString
  // 之类的继承属性；再做一次类型校验作为双保险
  const softDirAbs = typeof SOFT_DIRS[first] === "string" ? SOFT_DIRS[first] : null
  if (softDirAbs) {
    const base = path.resolve(softDirAbs)
    const sub = rel.slice(first.length)
    const subRel = sub.startsWith("/") ? sub.slice(1) : sub
    const resolved = subRel ? path.resolve(base, subRel) : base
    // 必须按路径分隔符判断边界，否则 "D:\soft" 会误认为 "D:\soft-secret" 在内部
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw badPath()
    // 软目录常被用来映射项目目录（模板里甚至给过 "./"），那里放着 .env（超管明文
    // 密码）与 data/（会话签名密钥、口令哈希、日志、备份）。这些属于服务自身，
    // 永远不能通过网盘接口读写 —— 与访客/成员身份无关。
    if (isSensitiveAbs(resolved)) throw notFound()
    return { abs: resolved, rel, isSoft: true, softName: first, softBase: base }
  }
  const abs = rel ? path.join(FILES_DIR, ...rel.split("/")) : FILES_DIR
  const resolved = path.resolve(abs)
  const root = path.resolve(FILES_DIR)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw badPath()
  // 同样的拦截也要作用在网盘本体这一侧：如果有人把 FILES_DIR 设成项目根目录，
  // 那么 .env 与 data/ 就都落在"网盘里"了，凭据与运行数据必须依然拿不到。
  // 默认布局（FILES_DIR=data/files）下这条永远不成立，因此不影响正常使用。
  if (isSensitiveAbs(resolved)) throw notFound()
  return { abs: resolved, rel, isSoft: false }
}

function notFound() {
  const err = new Error("文件或目录不存在")
  err.status = 404
  return err
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
  "backups",
  "logs",
  "metrics",
  "tmp",
  "trash",
  "avatars",
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
  if (resolved === path.resolve(ENV_FILE)) return true
  const dataRoot = path.resolve(DATA_DIR)
  // data/ 目录**本身**放行：FILES_DIR 有可能就设在 data/ 上（把文件直接放在
  // 配置旁边），那样网盘根目录就是 data/，把根目录整个挡掉会让网盘全空。
  // 需要挡的是它里面的具体条目（下一段的判断）。
  if (resolved === dataRoot) return false
  if (!resolved.startsWith(dataRoot + path.sep)) return false
  const first = resolved.slice(dataRoot.length + 1).split(path.sep)[0]
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
