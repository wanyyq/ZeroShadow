// 只做「语法」检查：这样即使 fumadocs-ui / mdx/types 没装，
// 也能确认我写的 TSX 本身是合法代码。
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.argv[2]
// typescript 装在 web/ 的 pnpm 目录里，用绝对路径导入（ESM 不认 NODE_PATH）
const tsEntry = process.argv[3]
if (!tsEntry) {
  console.error("用法: node check-tsx-syntax.mjs <项目根> <typescript/lib/typescript.js 的绝对路径>")
  process.exit(1)
}
const ts = (await import(pathToFileURL(tsEntry).href)).default

const files = [
  "docs/mdx/integration/mdx-fallbacks.tsx",
]

let bad = 0
for (const rel of files) {
  const full = path.join(root, rel)
  const source = fs.readFileSync(full, "utf8")
  const sf = ts.createSourceFile(full, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  // 只看语法诊断（syntactic），跳过类型与模块解析
  const diags = sf.parseDiagnostics ?? []
  if (diags.length === 0) {
    console.log(`  ${rel.padEnd(46)} 语法 OK  (${source.split("\n").length} 行)`)
  } else {
    bad += diags.length
    console.log(`  ${rel}  <<< ${diags.length} 处语法错误`)
    for (const d of diags.slice(0, 10)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(d.start)
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ")
      console.log(`      L${line + 1}:${character + 1}  ${msg}`)
    }
  }
}

// 确认 12 个组件都实现了，且 ZEROSHADOW_COMPONENTS 列表与之一致
const fb = fs.readFileSync(path.join(root, "docs/mdx/integration/mdx-fallbacks.tsx"), "utf8")
const required = [
  "Callout", "Cards", "Card", "Steps", "Step", "Tabs", "Tab",
  "Files", "File", "Folder", "Accordions", "Accordion",
]
const implemented = required.filter((n) => new RegExp(`export function ${n}\\b`).test(fb))
const notImplemented = required.filter((n) => !implemented.includes(n))
console.log("")
console.log(`组件实现：${implemented.length}/12${notImplemented.length ? "  <<< 缺: " + notImplemented.join(", ") : ""}`)

const listBlock = fb.match(/ZEROSHADOW_COMPONENTS = \[([\s\S]*?)\]/)?.[1] ?? ""
const inList = required.filter((n) => listBlock.includes(`"${n}"`))
console.log(`ZEROSHADOW_COMPONENTS 覆盖：${inList.length}/12${inList.length !== 12 ? "  <<< 缺: " + required.filter((n) => !inList.includes(n)).join(", ") : ""}`)

const implBlock = fb.match(/const IMPLEMENTATIONS[^=]*= \{([\s\S]*?)\}/)?.[1] ?? ""
const inMap = required.filter((n) => new RegExp(`\\b${n},`).test(implBlock))
console.log(`IMPLEMENTATIONS 映射覆盖：${inMap.length}/12${inMap.length !== 12 ? "  <<< 缺: " + required.filter((n) => !inMap.includes(n)).join(", ") : ""}`)

const hasMerge = /export function mergeZeroshadowComponents/.test(fb)
console.log(`合并助手导出：${hasMerge ? "有" : "缺失 <<<"}`)

process.exit(bad)
