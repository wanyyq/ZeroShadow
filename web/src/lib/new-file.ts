import { toast } from "sonner"
import { createEmptyFile } from "@/lib/api"

/**
 * 「新建…」的纯函数部分（与 React 无关，单独放一个文件是为了满足
 * react-refresh 的 "一个文件只导出组件" 规则）。
 */

/** Windows 与主流文件系统都不接受的字符 */
const FORBIDDEN_CHARS = '\\/:*?"<>|'

function hasControlChar(value: string) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

export type BadNameReason = "empty" | "invalid" | "trailing"

/** 校验用户输入的文件名；返回 null 表示合法 */
export function checkFileName(name: string): BadNameReason | null {
  const trimmed = name.trim()
  if (!trimmed) return "empty"
  if (trimmed === "." || trimmed === "..") return "invalid"
  if (trimmed.length > 200) return "invalid"
  if (hasControlChar(trimmed)) return "invalid"
  for (const ch of FORBIDDEN_CHARS) {
    if (trimmed.includes(ch)) return "invalid"
  }
  if (/[. ]$/.test(trimmed)) return "trailing"
  return null
}

/** 把文件名里不允许的字符换成下划线（用于自动生成的默认文件名） */
export function safeFileName(name: string, fallback = "document") {
  let out = ""
  for (const ch of name.trim()) {
    out += FORBIDDEN_CHARS.includes(ch) || ch.charCodeAt(0) < 32 ? "_" : ch
  }
  return out || fallback
}

/**
 * 新建「新建文本文档.txt」这类空文件。
 * `uniqueName` 由服务端保证（重名自动加 (1)），所以这里不处理冲突。
 */
export async function createTextFileWithDefault(dirPath: string, baseName: string): Promise<string | null> {
  const name = `${safeFileName(baseName)}.txt`
  try {
    const res = await createEmptyFile(dirPath, name, "", true)
    return res.name
  } catch (err) {
    toast.error((err as Error).message)
    return null
  }
}
