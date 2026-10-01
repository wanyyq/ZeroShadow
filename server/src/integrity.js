import fs from "node:fs"
import path from "node:path"
import { DATA_DIR, FILES_DIR, TMP_DIR, LOGS_DIR } from "./env.js"
import { info, warn } from "./logger.js"

// ============================================================================
//  integrity.js - 启动自检与数据修复
//
//  在模块加载后、服务启动前运行：
//   1. 确保运行时目录存在；
//   2. 校验受管 JSON 文件的合法性，损坏的文件移入 data/backups/corrupt/ 隔离
//      （绝不直接删除，保留人工恢复可能），随后由调用方重载内存态；
//   3. 清理 tmp 残留。
// ============================================================================

const MANAGED = [
  { file: "config.json", type: "object" },
  { file: "users.json", type: "array" },
  { file: "groups.json", type: "array" },
  { file: "todos.json", type: "array" },
]

function quarantine(name) {
  const src = path.join(DATA_DIR, name)
  const dir = path.join(DATA_DIR, "backups", "corrupt")
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    fs.renameSync(src, path.join(dir, `${stamp}-${name}`))
    return true
  } catch {
    try {
      fs.rmSync(src, { force: true })
      return true
    } catch {
      return false
    }
  }
}

function checkFile(name, type) {
  const abs = path.join(DATA_DIR, name)
  if (!fs.existsSync(abs)) return { name, status: "absent" }
  try {
    const value = JSON.parse(fs.readFileSync(abs, "utf8"))
    const ok =
      type === "array"
        ? Array.isArray(value)
        : typeof value === "object" && value !== null && !Array.isArray(value)
    if (!ok) {
      quarantine(name)
      return { name, status: "quarantined", reason: `顶层类型应为 ${type}` }
    }
    return { name, status: "ok" }
  } catch {
    quarantine(name)
    return { name, status: "quarantined", reason: "JSON 解析失败" }
  }
}

export function runIntegrityCheck() {
  const issues = []
  for (const dir of [DATA_DIR, FILES_DIR, TMP_DIR, LOGS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      issues.push({ name: dir, status: "error", reason: String(err?.message || err) })
    }
  }

  for (const item of MANAGED) {
    const result = checkFile(item.file, item.type)
    if (result.status === "quarantined" || result.status === "error") {
      issues.push(result)
      warn("integrity_repair", { msg: `${result.name}: ${result.reason || "已隔离"}` })
    }
  }

  // 清理上传/下载临时残留
  let cleaned = 0
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      try {
        fs.rmSync(path.join(TMP_DIR, name), { recursive: true, force: true })
        cleaned += 1
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  if (issues.length) {
    info("integrity_done", { msg: `发现并处理 ${issues.length} 项问题` })
  }
  return { issues, cleanedTmp: cleaned }
}
