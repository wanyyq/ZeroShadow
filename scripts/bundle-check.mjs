/**
 * scripts/bundle-check.mjs —— 发布包能不能打出来的**前置检查**（CI 失败过一次，这里补上）。
 *
 * 为什么需要它：服务端平时按 **ESM** 直接跑（`node index.js`），而发布包要先用
 * `esbuild --format=cjs` 打成单文件 CJS 再交给 pkg。这两者有两个差异是"本地能跑、
 * 发布必挂"的：
 *
 *   1. **顶层 await**：ESM 允许，CJS 不允许。写了 `const x = await f()` 在模块顶层，
 *      本地 `pnpm start` 一切正常，但 `pnpm bundle` 会直接报
 *      `Top-level await is currently not supported with the "cjs" output format`，
 *      于是五个平台的发布归档全部编译不出来（真实发生过：v2.1.0 的字体预热）。
 *   2. `import.meta` / ESM-only 语法：同样只在 CJS 打包时炸。
 *
 * 所以这里**照抄 `server/package.json` 的 bundle 命令**跑一遍 esbuild，输出到系统临时
 * 目录（不污染 `server/dist`），失败就非零退出。不需要网络、不需要 pkg。
 *
 * 用法：node scripts/bundle-check.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const SERVER = path.join(ROOT, "server")

/** 从 server/package.json 读 bundle 命令，保证与发布流程**完全一致** */
function readBundleArgs() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, "package.json"), "utf8"))
  const script = String(pkg.scripts?.bundle || "")
  if (!script) throw new Error("server/package.json 里没有 bundle 脚本")
  // 形如：esbuild index.js --bundle ... --outfile=dist/server-bundle.cjs ...
  const parts = script.split(/\s+/).slice(1)
  const outIndex = parts.findIndex((p) => p.startsWith("--outfile="))
  return { parts, outIndex, outFile: outIndex >= 0 ? parts[outIndex].slice("--outfile=".length) : null }
}

/**
 * 找到 esbuild 的启动方式。
 *
 * **优先走 JS 入口**（`esbuild/bin/esbuild` + node），而不是 `.bin/esbuild.cmd`：
 * 后者在 Windows 上必须经过 shell，一旦项目路径里有空格（本仓库就是
 * `D:\编程\... \EPan`）就会被 shell 拆成两段，报"不是内部或外部命令"。
 */
function findEsbuild() {
  const pnpmDir = path.join(SERVER, "node_modules", ".pnpm")
  if (fs.existsSync(pnpmDir)) {
    const entry = fs
      .readdirSync(pnpmDir)
      .filter((name) => name.startsWith("esbuild@"))
      .sort()
      .pop()
    if (entry) {
      const bin = path.join(pnpmDir, entry, "node_modules", "esbuild", "bin", "esbuild")
      if (fs.existsSync(bin)) return { kind: "js", file: bin }
    }
  }
  const flat = path.join(SERVER, "node_modules", "esbuild", "bin", "esbuild")
  if (fs.existsSync(flat)) return { kind: "js", file: flat }
  const shim = path.join(SERVER, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild")
  if (fs.existsSync(shim)) return { kind: "bin", file: shim }
  return null
}

const { parts, outIndex, outFile } = readBundleArgs()
if (!outFile) throw new Error("bundle 脚本里没有 --outfile=，无法定位产物")
const tmpOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zs-bundle-")), path.basename(outFile))
const args = parts.map((part, i) => (i === outIndex ? `--outfile=${tmpOut}` : part))

const esbuild = findEsbuild()
if (!esbuild) {
  console.log("跳过：没有找到 esbuild（先 `pnpm -C server install`）")
  process.exit(0)
}

console.log(`打包检查：esbuild ${args.join(" ")}`)
try {
  // stdio 用 inherit：esbuild 的报错原样打到终端（信息最全），
  // 也不依赖"捕获子进程管道"（某些受限环境里管道会被拒绝）
  if (esbuild.kind === "js") {
    execFileSync(process.execPath, [esbuild.file, ...args], { cwd: SERVER, stdio: "inherit" })
  } else {
    execFileSync(esbuild.file, args, { cwd: SERVER, shell: process.platform === "win32", stdio: "inherit" })
  }
} catch {
  console.error("")
  console.error("❌ 发布包**打不出来**：esbuild 把 ESM 转 CJS 失败（上面的报错就是原因）。")
  console.error("   最常见：服务端模块顶层写了 `await` —— CJS 不支持顶层 await。")
  console.error("   改法：把顶层 `await x()` 换成 `const p = x()`，或挪进异步函数里。")
  process.exit(1)
}

const size = fs.statSync(tmpOut).size
fs.rmSync(path.dirname(tmpOut), { recursive: true, force: true })
console.log(`✅ 打包检查通过（CJS 单文件 ${Math.round(size / 1024)} KB）`)
