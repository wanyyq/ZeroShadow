import dns from "node:dns/promises"
import net from "node:net"
import { getConfig } from "./config.js"

// ============================================================================
//  netguard.js - 出站请求目标的地址校验（防 SSRF）
//
//  设计要点（旧实现只做字符串正则，已被证明可绕过）：
//   1. 先解析 URL，再对主机名做 DNS 解析，拿到**全部** A/AAAA 记录；
//   2. 逐个校验解析结果（而不是校验主机名字符串）—— 这样
//      "metadata.google.internal"、"localhost."、"127.0.0.1.nip.io" 这类
//      域名无法再绕过；
//   3. 校验通过后把 IP **固定**给 socket（见 pinnedLookup），连接时不再二次
//      解析 —— 彻底消除 DNS rebinding 的检查/使用时间差；
//   4. IPv6 按数值解析后判断，因此 ::1、[0:0:0:0:0:0:0:1]、::ffff:127.0.0.1
//      、6to4、NAT64 等写法都会被正确识别（旧代码里 `hostname === "::1"`
//      永远不成立，因为 WHATWG 的 IPv6 hostname 带方括号）。
//
//  默认拒绝一切内网/回环/链路本地/保留地址。确有需要时可用环境变量显式放开：
//    DOWNLOAD_URL_ALLOW_PRIVATE=1              放开所有内网地址（谨慎）
//    DOWNLOAD_URL_ALLOW_HOSTS=nas.local,10.0.0.5   仅放开指定主机
//    DOWNLOAD_URL_INSECURE_TLS=1                跳过 TLS 证书校验（不推荐）
// ============================================================================

const TRUE_RE = /^(1|true|yes|on)$/i

// 环境变量在每次调用时读取：既避免依赖模块导入顺序（.env 由 env.js 写入
// process.env），也让调整后无需关心初始化时机。
function envFlag(name) {
  return TRUE_RE.test(String(process.env[name] || "").trim())
}

function envHostList() {
  return new Set(
    String(process.env.DOWNLOAD_URL_ALLOW_HOSTS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  )
}

export const MAX_REDIRECTS = 5
export const MAX_URL_LENGTH = 2048
export const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

export function insecureTlsAllowed() {
  return envFlag("DOWNLOAD_URL_INSECURE_TLS")
}

export function privateAccessAllowed() {
  // 环境变量（部署级）与后台配置（超管可在设置里改动）任一开启即放行
  if (envFlag("DOWNLOAD_URL_ALLOW_PRIVATE")) return true
  try {
    return !!getConfig().downloadUrlAllowPrivate
  } catch {
    return false
  }
}

function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

// ---------------------------------------------------------------- IPv4 -----
function ipv4ToInt(ip) {
  const parts = String(ip).split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

const BLOCKED_V4 = [
  ["0.0.0.0", 8, "未指定或本机地址"],
  ["10.0.0.0", 8, "内网地址"],
  ["100.64.0.0", 10, "运营商级 NAT 地址"],
  ["127.0.0.0", 8, "回环地址"],
  ["169.254.0.0", 16, "链路本地或云元数据地址"],
  ["172.16.0.0", 12, "内网地址"],
  ["192.0.0.0", 24, "保留地址"],
  ["192.0.2.0", 24, "文档保留地址"],
  ["192.88.99.0", 24, "6to4 中继地址"],
  ["192.168.0.0", 16, "内网地址"],
  ["198.18.0.0", 15, "基准测试保留地址"],
  ["198.51.100.0", 24, "文档保留地址"],
  ["203.0.113.0", 24, "文档保留地址"],
  ["224.0.0.0", 4, "组播地址"],
  ["240.0.0.0", 4, "保留地址"],
].map(([base, bits, label]) => ({ base: ipv4ToInt(base), bits, label }))

function blockedIpv4Reason(ip) {
  const value = ipv4ToInt(ip)
  if (value === null) return "地址格式无效"
  for (const range of BLOCKED_V4) {
    const mask = range.bits >= 32 ? 0xffffffff : (0xffffffff << (32 - range.bits)) >>> 0
    if (((value & mask) >>> 0) === ((range.base & mask) >>> 0)) return range.label
  }
  return null
}

// ---------------------------------------------------------------- IPv6 -----
function parseIpv6(input) {
  let text = String(input)
  const zone = text.indexOf("%")
  if (zone >= 0) text = text.slice(0, zone)
  text = text.toLowerCase()

  // 末尾内嵌 IPv4（::ffff:127.0.0.1、::1.2.3.4）展开成两个十六进制组
  const lastColon = text.lastIndexOf(":")
  if (lastColon >= 0 && text.slice(lastColon + 1).indexOf(".") >= 0) {
    const v4 = ipv4ToInt(text.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = text.split("::")
  if (halves.length > 2) return null

  let head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []

  if (halves.length === 1) {
    if (head.length !== 8) return null
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    head = [...head, ...new Array(missing).fill("0"), ...tail]
    if (head.length !== 8) return null
  }

  const groups = []
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    groups.push(parseInt(group, 16))
  }
  return groups
}

function dottedFromGroups(hi, lo) {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

function blockedIpv6Reason(groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups

  if (groups.every((g) => g === 0)) return "未指定地址"
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return "回环地址"
  }
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  // IPv4-mapped（::ffff:a.b.c.d）与已废弃的 IPv4-compatible（::a.b.c.d）
  if (firstFiveZero && (g5 === 0xffff || (g5 === 0 && (g6 !== 0 || g7 !== 0)))) {
    const embedded = dottedFromGroups(g6, g7)
    const reason = blockedIpv4Reason(embedded)
    if (reason) return `${reason}（IPv6 内嵌 ${embedded}）`
    return null
  }
  // 6to4 2002::/16：内嵌 IPv4 位于 g1:g2
  if (g0 === 0x2002) {
    const embedded = dottedFromGroups(g1, g2)
    const reason = blockedIpv4Reason(embedded)
    if (reason) return `${reason}（6to4 内嵌 ${embedded}）`
    return null
  }
  // NAT64 64:ff9b::/96：内嵌 IPv4 位于 g6:g7
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const embedded = dottedFromGroups(g6, g7)
    const reason = blockedIpv4Reason(embedded)
    if (reason) return `${reason}（NAT64 内嵌 ${embedded}）`
    return null
  }
  // Teredo 2001:0000::/32
  if (g0 === 0x2001 && g1 === 0x0000) return "Teredo 隧道地址"
  // 本地地址
  if ((g0 & 0xfe00) === 0xfc00) return "唯一本地地址"
  if ((g0 & 0xffc0) === 0xfe80) return "链路本地地址"
  if ((g0 & 0xffc0) === 0xfec0) return "站点本地地址（已废弃）"
  if ((g0 & 0xff00) === 0xff00) return "组播地址"
  if (g0 === 0x2001 && g1 === 0x0db8) return "文档保留地址"
  return null
}

/** 返回该地址被禁止的原因；可公网访问则返回 null。 */
export function addressBlockReason(address) {
  const ip = String(address || "")
  const family = net.isIP(ip)
  if (family === 4) return blockedIpv4Reason(ip)
  if (family === 6) {
    const groups = parseIpv6(ip)
    if (!groups) return "地址格式无效"
    return blockedIpv6Reason(groups)
  }
  return "地址格式无效"
}

export function isHostAllowed(hostname) {
  const host = String(hostname || "").toLowerCase()
  if (!host) return false
  if (privateAccessAllowed()) return true
  return envHostList().has(host)
}

/**
 * 校验并解析一个下载目标。
 * 成功返回 { url, urlString, hostname, port, addresses, allowlisted }；
 * 失败抛出带 status=400 的错误（可直接交给 express 错误处理）。
 */
export async function resolveDownloadTarget(rawUrl) {
  const text = String(rawUrl || "").trim()
  if (!text) throw badRequest("请输入下载链接")
  if (text.length > MAX_URL_LENGTH) throw badRequest("下载链接过长")

  let url
  try {
    url = new URL(text)
  } catch {
    throw badRequest("URL 格式无效")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest("仅支持 http/https 链接")
  if (url.username || url.password) throw badRequest("下载链接不能包含用户名或密码")

  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "")
  if (!hostname) throw badRequest("URL 缺少主机名")

  const allowlisted = isHostAllowed(hostname)
  let addresses
  if (net.isIP(hostname)) {
    addresses = [hostname]
  } else {
    let resolved = []
    try {
      resolved = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch {
      throw badRequest("无法解析该域名")
    }
    addresses = [...new Set(resolved.map((entry) => entry.address).filter(Boolean))]
    if (!addresses.length) throw badRequest("无法解析该域名")
  }

  if (!allowlisted) {
    for (const address of addresses) {
      const reason = addressBlockReason(address)
      if (reason) throw badRequest(`不允许下载${reason}（${address}）`)
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  return { url, urlString: url.toString(), hostname, port, addresses, allowlisted }
}

/**
 * 把已校验的 IP 固定给 socket：连接阶段不再查询 DNS，
 * 因此攻击者无法在"检查通过"之后把域名重新指向内网。
 */
export function pinnedLookup(addresses) {
  const entries = addresses.map((address) => ({ address, family: net.isIP(address) }))
  return (hostname, options, callback) => {
    let opts = options
    let cb = callback
    if (typeof options === "function") {
      cb = options
      opts = {}
    }
    if (opts && opts.all) {
      process.nextTick(cb, null, entries)
      return
    }
    process.nextTick(cb, null, entries[0].address, entries[0].family)
  }
}
