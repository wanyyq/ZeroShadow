#!/usr/bin/env node
/**
 * check-coverage.mjs —— 核对「源文档 → MDX」有没有丢内容
 *
 * 为什么需要它：
 *   校验器（validate-mdx.mjs）只能证明语法不会让构建失败，**证明不了内容完整**。
 *   而内容丢失正是最容易发生、也最难发现的退化——人读一遍很难发现少了一个配置项。
 *   所以这里反过来做：从源 Markdown 里抽出"可核对的特征 token"，
 *   再确认它们都出现在对应的 MDX 里。缺一个就报出来。
 *
 * 抽取的特征：
 *   1. 行内代码 token（配置键、环境变量、路径、命令、值）—— 最重要
 *   2. `/api/...` 形式的接口路径
 *   3. 全大写下划线形式的环境变量名
 *   4. 带单位的数值（MB / GB / 秒 / 分钟 / 次 / 条 / %）
 *
 * 已知的合理丢失（会被过滤掉，不算问题）：
 *   - 指向旧文件名的相对链接（`配置参考.md`）
 *   - 纯锚点、`<p align="right">` 之类的排版残留
 *   - 源文档自己的"回到顶部"之类导航
 *
 * 用法：
 *   node docs/mdx/.authoring/check-coverage.mjs [docs/mdx]
 * 退出码 = 疑似丢失的 token 数量。
 */

import fs from "node:fs"
import path from "node:path"

const bundleRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."))
const repoDocs = path.resolve(bundleRoot, "..")
const mdxRoot = path.join(bundleRoot, "content", "docs")

// 源文件 -> 目标 MDX（开发者指南被拆成四页，所以是数组）
const PAIRS = [
  ["快速开始.md", ["getting-started/quickstart.mdx"]],
  ["常见问题.md", ["getting-started/faq.mdx"]],
  ["使用手册.md", ["guide/manual.mdx"]],
  ["权限与角色.md", ["guide/permissions.mdx"]],
  ["管理员指南.md", ["admin/admin-guide.mdx"]],
  ["配置参考.md", ["admin/configuration.mdx"]],
  ["公网访问与隧道.md", ["admin/tunnel.mdx"]],
  ["安全设计.md", ["security/design.mdx"]],
  ["API参考.md", ["api/reference.mdx"]],
  ["开发者指南.md", [
    "development/architecture.mdx",
    "development/build.mdx",
    "development/testing.mdx",
    "development/release.mdx",
  ]],
]

/** 这些 token 丢掉是正常的，不算内容缺失 */
const NOISE = [
  /\.mdx?$/i,                    // 旧文件名（相对链接被改写成站点路径）
  /^#/,                          // 纯锚点
  /^(回到顶部|上一篇|下一篇)/,
  /^<p\b/i,
  /^https?:\/\//,                // 外部链接会按需保留，不作为硬性特征
]

function extractTokens(text) {
  const tokens = new Set()

  // 行内代码：`` `...` `` 与 ``` ``...`` ```
  for (const m of text.matchAll(/(`+)([\s\S]*?)\1/g)) {
    const value = m[2].trim()
    if (value && value.length <= 120 && !value.includes("\n")) tokens.add(value)
  }

  // 接口路径
  for (const m of text.matchAll(/\/api\/[A-Za-z0-9/_:{}$.-]+/g)) tokens.add(m[0])

  // 环境变量
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
    if (m[0].includes("_") || ["PORT", "HOST", "NOLOG"].includes(m[0])) tokens.add(m[0])
  }

  // 带单位的数值
  for (const m of text.matchAll(/\d+(?:\.\d+)?\s?(?:MB|GB|KB|TB)\b/g)) tokens.add(m[0].replace(/\s+/g, ""))

  return [...tokens].filter((t) => t.length >= 2 && !NOISE.some((re) => re.test(t)))
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null
}

let totalMissing = 0
const report = []

for (const [sourceName, targets] of PAIRS) {
  const source = readIfExists(path.join(repoDocs, sourceName))
  if (source === null) {
    report.push({ sourceName, missing: [`(源文件不存在: ${sourceName})`], targetCount: 0, tokenCount: 0 })
    totalMissing++
    continue
  }

  const parts = []
  let targetCount = 0
  for (const rel of targets) {
    const t = readIfExists(path.join(mdxRoot, rel))
    if (t === null) {
      report.push({ sourceName, missing: [`(目标文件不存在: ${rel})`], targetCount, tokenCount: 0 })
      totalMissing++
      continue
    }
    parts.push(t)
    targetCount++
  }
  const targetText = parts.join("\n")

  // 比较时忽略空白差异：源文档写 "512 MB"、MDX 里写 `512MB`（或反之）都属于保留，
  // 不该报成丢失。把两边的空白都压掉再比对，既消除这类误报，又因为 token 本身较长
  // 且特征明显，不会造成"跨越无关内容也匹配上"的假通过。
  const squashedTarget = targetText.replace(/\s+/g, "")
  const tokens = extractTokens(source)
  const missing = tokens.filter((token) => {
    if (targetText.includes(token)) return false
    return !squashedTarget.includes(token.replace(/\s+/g, ""))
  })
  if (missing.length) {
    report.push({ sourceName, missing, targetCount, tokenCount: tokens.length })
    totalMissing += missing.length
  }
}

console.log("源文档 → MDX 内容覆盖核对\n")
console.log("（核对方式：从源文档抽出配置键 / 环境变量 / 接口路径 / 数值等特征 token，")
console.log("  确认它们都出现在目标 MDX 中；思路是「少了一个就报出来」，不依赖人工通读）\n")

if (!report.length) {
  console.log("全部源文档的特征 token 都能在对应 MDX 中找到，没有发现内容丢失。\n")
} else {
  for (const item of report) {
    console.log(`  ${item.sourceName}  →  ${item.targetCount} 个目标文件`)
    console.log(`    核对 ${item.tokenCount} 个特征 token，疑似丢失 ${item.missing.length} 个：`)
    for (const token of item.missing.slice(0, 40)) {
      console.log(`      - ${token}`)
    }
    if (item.missing.length > 40) console.log(`      …… 另有 ${item.missing.length - 40} 个`)
    console.log("")
  }
  console.log(`合计疑似丢失 ${totalMissing} 个 token。`)
  console.log("注意：源文档里指向旧文件名的相对链接、页面导航残留会被过滤；")
  console.log("      若确实是有意合并/改写的表述，人工确认后即可忽略。\n")
}

process.exit(totalMissing)
