import crypto from "node:crypto"

// ============================================================================
//  version.js - 内容版本标识（并发编辑保护 + HTTP ETag）
//
//  为什么需要它：
//    在线编辑器从打开到保存之间可能隔了很久，期间别人（或另一个标签页）完全
//    可能已经改过同一个文件。旧实现直接覆盖，后保存的人**静默抹掉**先保存的
//    内容 —— 这类数据丢失没有任何提示，事后也无法追溯。
//
//  版本串的构成：`<mtimeMs>-<size>-<内容哈希>`
//    - mtime + size 能挡住绝大多数改动，且不需要读文件就能比对；
//    - 内容哈希负责兜住"mtime 精度不足"的情况（Windows 的 mtime 粒度可达
//      秒级，同一秒内的两次保存用 mtime 区分不开），也顺便让这个串可以直接
//      当 ETag 用（WebDAV 客户端与编辑器认的是同一套版本）。
//
//  哈希选 sha1 的理由：这里它不是密码学用途，只是"内容变没变"的指纹；
//  sha1 比 sha256 快、摘要短（base64url 后 27 字符），在 8MB 的编辑器上限
//  内开销可以忽略。
// ============================================================================

/** 内容指纹：同一内容永远得到同一个串，不同内容几乎不可能碰撞 */
export function contentHash(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("base64url")
}

/**
 * 由 buffer + stat 算出对外暴露的版本串。
 * @param {Buffer} buffer 文件内容
 * @param {{mtimeMs:number,size:number}} stat fs.stat 结果
 */
export function versionOf(buffer, stat) {
  return `${Math.trunc(stat.mtimeMs)}-${stat.size}-${contentHash(buffer)}`
}

/** 只由 stat 算出"轻量版本"（不含内容哈希），用于列目录时给 ETag 之类 */
export function statVersion(stat) {
  return `${Math.trunc(stat.mtimeMs)}-${stat.size}`
}

/**
 * 比对客户端提交的版本与当前版本。
 *
 * 返回值刻意区分三种情况，因为调用方的处置不同：
 *   - "match"     ：一致，可以写
 *   - "conflict"  ：不一致，**必须拒绝**
 *   - "no-base"   ：客户端没提交版本（老客户端 / 第三方脚本），放行但调用方
 *                   可以选择记一条日志
 *   - "absent"    ：目标文件不存在（新建），不算冲突
 */
export function compareVersion(base, current) {
  if (current === null) return "absent"
  const given = String(base ?? "").trim()
  if (!given) return "no-base"
  return given === current ? "match" : "conflict"
}
