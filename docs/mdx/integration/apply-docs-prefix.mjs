#!/usr/bin/env node
/**
 * apply-docs-prefix.mjs —— 给文档里的站内链接批量加路径前缀
 *
 * 为什么需要它：
 *   这套文档是按"内容根 = 文档包根"写的，站内链接形如 /docs/guide/manual。
 *   但若把它嵌进已有文档库的一层子目录（例如 content/docs/zeroshadow/），
 *   页面真实 URL 就变成 /docs/zeroshadow/guide/manual —— 链接少一层，点了就 404。
 *
 * 特点：
 *   - **幂等**：已经带前缀的不会被改成 /docs/zeroshadow/zeroshadow/...
 *   - 覆盖两种写法：Markdown 链接 `](...)` 与组件属性 `href="..."`
 *   - 处理不带子路径的裸 /docs
 *   - 跳过 ``` 代码围栏内部（那里的 /docs 不该动）
 *   - 默认只预览，加 --write 才写入
 *
 * 用法：
 *   node apply-docs-prefix.mjs <内容目录> <前缀>            # 预览
 *   node apply-docs-prefix.mjs <内容目录> <前缀> --write    # 写入
 *
 * 例：
 *   node apply-docs-prefix.mjs content/docs/zeroshadow zeroshadow --write
 *
 * 退出码：0 成功；1 参数错误或目录不存在。
 */

import fs from "node:fs"
import path from "node:path"

const [, , targetDir, prefix, ...flags] = process.argv
const write = flags.includes("--write")

if (!targetDir || !prefix) {
  console.error("用法: node apply-docs-prefix.mjs <内容目录> <前缀> [--write]")
  console.error("例:   node apply-docs-prefix.mjs content/docs/zeroshadow zeroshadow --write")
  process.exit(1)
}
if (!fs.existsSync(targetDir)) {
  console.error(`目录不存在：${targetDir}`)
  process.exit(1)
}

const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "")
const PREFIX = `/docs/${cleanPrefix}`

/**
 * 给一个站内路径加前缀。这是全部逻辑的核心，刻意写得一眼能看懂。
 * 非 /docs 开头的路径原样返回。
 */
function addPrefix(target) {
  if (target === "/docs") return PREFIX
  if (!target.startsWith("/docs/")) return target

  const rest = target.slice("/docs/".length)
  // 幂等：已经是 <前缀> 或 <前缀>/xxx 就不动
  if (rest === cleanPrefix || rest.startsWith(cleanPrefix + "/")) return target

  return `${PREFIX}/${rest}`
}

function rewrite(text) {
  let inFence = false
  const hits = []

  const out = text.split(/\r?\n/).map((line) => {
    // 代码围栏：只翻转状态，围栏内一律不动
    if (/^\s*(```+|~~~+)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line

    let next = line

    // Markdown 链接 / 图片：](...)  目标里可能带 #锚点
    next = next.replace(/\]\((\/docs[^)\s]*)/g, (_m, target) => {
      const replaced = addPrefix(target)
      if (replaced !== target) hits.push(line.trim())
      return `](${replaced}`
    })

    // 组件属性：href="..."
    next = next.replace(/href="(\/docs[^"\s]*)"/g, (_m, target) => {
      const replaced = addPrefix(target)
      if (replaced !== target) hits.push(line.trim())
      return `href="${replaced}"`
    })

    return next
  })

  return { text: out.join("\n"), hits: [...new Set(hits)] }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith(".mdx")) out.push(full)
  }
  return out
}

const files = walk(targetDir).sort()
let touched = 0
let totalLines = 0

console.log(`${write ? "改写" : "预览"}：内容目录 ${targetDir}，前缀 ${PREFIX}\n`)

for (const file of files) {
  const original = fs.readFileSync(file, "utf8")
  const { text, hits } = rewrite(original)
  if (text === original) continue

  touched++
  totalLines += hits.length
  console.log(`  ${path.relative(targetDir, file)}  (${hits.length} 行)`)
  for (const line of hits.slice(0, 5)) console.log(`      ${line.slice(0, 108)}`)

  if (write) fs.writeFileSync(file, text, "utf8")
}

console.log("")
if (touched === 0) {
  console.log("没有需要改动的行（可能已经改过了）。")
} else {
  console.log(`涉及 ${touched} 个文件、${totalLines} 行。`)
  console.log(write ? "已写入。" : "这是预览，加 --write 才会写入。")
}
console.log("")
console.log("改完请自检：下面这条命令应输出 0（没有重复前缀）：")
console.log(`  grep -r '${PREFIX}/${cleanPrefix}' ${targetDir} | wc -l`)
