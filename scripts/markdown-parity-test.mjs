/**
 * scripts/markdown-parity-test.mjs —— **预览与 PDF 的内容一致性**回归测试。
 *
 * 用户的要求很直白："PDF 和预览内容除了字体以外其他一模一样"。这条要求靠人眼盯不住，
 * 所以这里用代码钉死：
 *
 *   左边 = 前端**预览渲染器**（`web/src/lib/markdown.ts`，用户实际看到的那个）输出的 HTML，
 *          去掉标签后得到的"可见文字行"；
 *   右边 = 服务端 `convert/markdown.js` 解析出的块，按同样的规则投影成"可见文字行"。
 *
 * 两边必须逐行相同。差异点就是真实的 bug —— 例如"软换行少一个空格"、"删除线文字丢了"、
 * "白名单标签被删掉导致少字"、"图片只在预览里有"。
 *
 * 怎么拿到预览渲染器：它依赖 `@/` 别名与 `.ts`，Node 直接 import 不了。这里用项目里
 * 已经存在的 `esbuild`（Vite 的依赖）把它打成临时 ESM 再加载 —— 不引入任何新依赖，
 * 也不需要起浏览器。
 *
 * 运行：node scripts/markdown-parity-test.mjs
 * 退出码：0 全部一致；1 有不一致（会打印第一处差异的上下几行）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const WEB_SRC = path.join(ROOT, "web", "src")

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    failures.push({ name, detail })
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

/* ============================== 加载预览渲染器 ============================== */

/**
 * 加载**前端预览渲染器**（唯一基准）。
 *
 * 它依赖 `@/` 别名与 `.ts`，Node 直接 import 不了。这里用项目自己的 `typescript`
 * 把用到的三个纯函数模块编译到临时目录（不打包、不跑 Vite、不引新依赖），
 * 再把 `./format` 换成桩 —— 渲染器只用它的 `canPreview()` 拼链接地址，
 * 而本测试比较的是**可见文字**。
 */
async function loadPreviewRenderer() {
  const tscPath = path.join(ROOT, "web", "node_modules", "typescript", "lib", "typescript.js")
  const ts = await import(pathToFileURL(tscPath).href).then((m) => m.default ?? m)
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "zs-parity-"))
  const sources = ["markdown.ts", "markdown-html.ts", "markdown-urls.ts"]

  for (const file of sources) {
    const source = fs.readFileSync(path.join(WEB_SRC, "lib", file), "utf8")
    const transpiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    }).outputText
    // 依赖解析：相对路径补上 .mjs（Node 需要扩展名），@/ 别名换成桩
    const fixed = transpiled
      .replace(/from "\.\/([a-zA-Z-]+)"/g, 'from "./$1.mjs"')
      .replace(/from "@\/[^"]*"/g, 'from "./format-stub.mjs"')
      .replace(/from "\.\/format\.mjs"/g, 'from "./format-stub.mjs"')
    fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, ".mjs")), fixed, "utf8")
  }
  fs.writeFileSync(
    path.join(outDir, "format-stub.mjs"),
    "export function canPreview() { return false }\nexport function previewType() { return null }\nexport function isImageName() { return false }\n",
    "utf8"
  )
  fs.writeFileSync(path.join(outDir, "package.json"), '{ "type": "module" }\n', "utf8")

  const mod = await import(pathToFileURL(path.join(outDir, "markdown.mjs")).href + `?t=${Date.now()}`)
  return {
    renderMarkdown: mod.renderMarkdown,
    close: () => fs.rmSync(outDir, { recursive: true, force: true }),
  }
}

/* ============================== 两种投影 ============================== */

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

/** 预览的 HTML → 可见文字行（浏览器语义：块边界换行、空白折叠、<br> 换行） */
function htmlToLines(html) {
  const codeBlocks = []
  let s = html
  // 代码块：内容里的换行是**真的换行**，先整段抽出来（否则会被后面的"源码换行=空格"吃掉）
  s = s.replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => {
    codeBlocks.push(decodeEntities(code))
    return `\u0001PRE${codeBlocks.length - 1}\u0001`
  })
  // 图片按"有没有这张图"参与比较（预览里是 <img>，PDF 里是内嵌图像）
  s = s.replace(/<img\b[^>]*>/g, (tag) => {
    const alt = /\balt="([^"]*)"/.exec(tag)
    return `IMG:${alt ? decodeEntities(alt[1]) : ""}`
  })
  // 块级元素的开始与结束都是视觉边界；<br>/<hr> 同样是
  s = s.replace(/<br\s*\/?>/g, "\u0000B\u0000")
  s = s.replace(/<hr\s*\/?>/g, "\u0000B\u0000")
  s = s.replace(/<\/?(?:p|h[1-6]|li|td|th|tr|table|div|ul|ol|blockquote)\b[^>]*>/g, "\u0000B\u0000")
  s = s.replace(/<[^>]+>/g, "")
  s = decodeEntities(s)
  // 浏览器把**源码里的换行**折叠成一个空格（软换行）
  s = s.replace(/[ \t]*\n[ \t]*/g, " ")
  s = s.replace(/\u0000B\u0000/g, "\n")

  const out = []
  for (const raw of s.split("\n")) {
    const pre = /^\u0001PRE(\d+)\u0001$/.exec(raw.trim())
    if (pre) {
      for (const line of codeBlocks[Number(pre[1])].split("\n")) {
        out.push(line.replace(/[ \t]+/g, " ").trim())
      }
      continue
    }
    out.push(raw.replace(/[ \t]+/g, " ").trim())
  }
  return out.filter((line) => line.length > 0)
}

/** 服务端块列表 → 同样的"可见文字行" */
function blocksToLines(blocks) {
  const lines = []
  const pushText = (runs) => {
    let current = ""
    for (const run of runs || []) {
      if (run.br) {
        lines.push(current)
        current = ""
        continue
      }
      current += run.image ? `IMG:${run.text || run.src || ""}` : run.text
    }
    lines.push(current)
  }
  const walk = (list) => {
    for (const block of list) {
      switch (block.type) {
        case "heading":
          pushText(block.inlines)
          break
        case "para":
          pushText(block.inlines)
          break
        case "list":
          for (const item of block.items) pushText(item.inlines)
          break
        case "code":
          for (const line of (block.lines || String(block.text ?? "").split("\n"))) lines.push(line)
          break
        case "table":
          for (const cell of block.header || []) pushText(cell)
          for (const row of block.rows || []) for (const cell of row) pushText(cell)
          break
        case "quote":
          walk(block.blocks || [])
          break
        case "hr":
          break
        default:
          break
      }
    }
  }
  walk(blocks)
  return lines
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
}

/* ============================== 语料 ============================== */

const CASES = [
  {
    name: "标题：ATX / setext / 结尾井号",
    md: ["# 一级标题", "", "## 二级 ###", "", "Setext 标题", "===", "", "另一个", "---"].join("\n"),
  },
  {
    name: "软换行 = 一个空格（与浏览器折叠一致）",
    md: "第一行\n第二行\n同一段里还有第三行",
  },
  {
    name: "中文软换行也要一个空格",
    md: "这是第一句\n这是第二句",
  },
  {
    name: "硬换行：行尾两个空格 / 反斜杠",
    md: ["第一行  ", "第二行\\", "第三行"].join("\n"),
  },
  {
    name: "行内：粗体 / 斜体 / 删除线 / 代码",
    md: "**粗** 与 *斜* 与 ~~删~~ 与 `code` 混排",
  },
  {
    name: "链接与自动链接",
    md: "见 [链接文字](https://example.com) 与 <https://auto.example.com>",
  },
  {
    name: "图片按 alt 参与比较",
    md: ["前文", "", "![示意图](pic.png)", "", "后文"].join("\n"),
  },
  {
    name: "白名单 HTML：br / kbd / span",
    md: "换行<br>之后 <kbd>Ctrl</kbd> 与 <span>span 里的字</span>",
  },
  {
    name: "白名单外的 HTML 当纯文本（不吞字）",
    md: "未知标签 <script>alert(1)</script> 必须原样保留",
  },
  {
    name: "无序列表 / 有序列表 / 嵌套 / 任务列表",
    md: [
      "- 第一项",
      "- 第二项",
      "  - 嵌套项",
      "",
      "1. 步骤一",
      "2. 步骤二",
      "",
      "- [x] 已完成项",
      "- [ ] 未完成项",
    ].join("\n"),
  },
  {
    name: "引用（含嵌套块）",
    md: ["> 引用第一行", "> 引用第二行", ">", "> - 引用里的列表", "", "正文"].join("\n"),
  },
  {
    name: "表格（含对齐与行内强调）",
    md: ["| 列 A | 列 B |", "|:--|--:|", "| **粗** | `x` |", "| 2 | 3 |"].join("\n"),
  },
  {
    name: "围栏代码块保留缩进与符号",
    md: ["```js", "const a = 1", "  if (a) { b() }", "```"].join("\n"),
  },
  {
    name: "水平分割线",
    md: ["上文", "", "---", "", "下文"].join("\n"),
  },
  {
    name: "转义与特殊字符",
    md: "\\*不是斜体\\* 与 A & B 与 < 尖括号 > 与 100%",
  },
  {
    name: "中文标点与全角内容",
    md: "他说：「今天下雨。」\n然后，就走了。",
  },
  {
    name: "空文档",
    md: "",
  },
]

/* ============================== 主流程 ============================== */

const { parseMarkdown } = await import(pathToFileURL(path.join(ROOT, "server", "src", "convert", "markdown.js")).href)
const preview = await loadPreviewRenderer()
const renderMarkdown = preview.renderMarkdown

console.log("== 预览 ↔ PDF 内容一致性（同一份 Markdown 两种投影必须逐行相同）")

for (const testCase of CASES) {
  const previewLines = htmlToLines(renderMarkdown(testCase.md))
  const pdfLines = blocksToLines(parseMarkdown(testCase.md))
  const same = previewLines.length === pdfLines.length && previewLines.every((line, i) => line === pdfLines[i])
  let detail = ""
  if (!same) {
    const n = Math.max(previewLines.length, pdfLines.length)
    for (let i = 0; i < n; i += 1) {
      if ((previewLines[i] ?? "") !== (pdfLines[i] ?? "")) {
        detail = `第 ${i + 1} 行不同：预览=${JSON.stringify(previewLines[i] ?? "")} / PDF=${JSON.stringify(pdfLines[i] ?? "")}`
        break
      }
    }
  }
  check(testCase.name, same, detail)
}

console.log("")
if (fail) {
  console.log(`失败明细：`)
  for (const item of failures) console.log(`  - ${item.name}: ${item.detail}`)
  console.log("")
}
console.log(fail === 0 ? `✅ 全部 ${pass} 项一致` : `❌ 通过 ${pass} / 失败 ${fail}`)
await preview.close()
process.exit(fail === 0 ? 0 : 1)
