# 接入步骤（照这个做就行）

你的情况：站点是二次开发的 Fumadocs，文档库有大量文档，**每个软件的根目录都带 `"root": true`**
（Fumadocs 的 root folder 机制 → 也就是顶部那些 Layout Tab）。
目标 URL：`http://localhost:3000/docs/zeroshadow/getting-started/quickstart`。
当前报错：`Expected component \`Step\` to be defined`。

下面 7 步，按顺序做。**先做第 1、2 步就能解决你现在的报错。**

> 全程两条纪律，因为你的文档库里已经有大量内容：
> 1. **不要覆盖 `mdx-components.tsx`** —— 那是整个文档库共用的组件总表。只加两行。
> 2. **不要重排 `content/docs/meta.json` 里已有的条目** —— 只在末尾追加一项。

下面用 `<站点>` 表示你站点的根目录（就是有 `content/`、`public/`、`mdx-components.tsx` 的那一层），
用 `<文档包>` 表示这套文档的 `docs/mdx/` 目录。

---

## 第 1 步：在 `components/mdx.tsx` 里补齐组件（推荐做法）

### 先说结论：Fumadocs v16 把默认组件精简了

你的站点是 **fumadocs-ui 16.9.3**。这个版本的 `defaultMdxComponents`（也就是
`fumadocs-ui/mdx` 的默认导出）**只包含**：

```text
pre, Card, Cards, a, img, h1 h2 h3 h4 h5 h6, table,
Callout, CalloutContainer, CalloutTitle, CalloutDescription,
CodeBlockTab, CodeBlockTabs, CodeBlockTabsList, CodeBlockTabsTrigger
```

**`Steps` / `Step` / `Tabs` / `Tab` / `Files` / `File` / `Folder` / `Accordions` /
`Accordion` 都不在里面。** 这就是你报 `Expected component \`Step\` to be defined` 的原因——
不是你的配置错了，是 v16 改成需要**显式导入**了。

### 这些组件官方仍然提供，只是换了子路径

我核对过你的 `node_modules/fumadocs-ui`，这 4 个子路径都存在，导出名如下：

| 子路径 | 导出 |
|:--|:--|
| `fumadocs-ui/components/steps` | `Step`, `Steps` |
| `fumadocs-ui/components/tabs` | `Tab`, `Tabs`（另有 `TabsList`/`TabsTrigger`/`TabsContent`） |
| `fumadocs-ui/components/files` | `File`, `Files`, `Folder` |
| `fumadocs-ui/components/accordion` | `Accordion`, `Accordions` |

**所以正确做法是导入官方组件**，样式与你站点主题一致、也有人维护。

### 要改的文件

你站点**没有** `mdx-components.tsx`——你的组件总表是：

```text
D:\编程\YQ全新网站\Wangyq Wiki\wangyqwiki\components\mdx.tsx
```

把它改成下面这样（其余内容照旧）：

```tsx
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Files, File, Folder } from 'fumadocs-ui/components/files';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // Fumadocs v16 起这些不再包含在 defaultMdxComponents 里，需要显式补上
    Steps,
    Step,
    Tabs,
    Tab,
    Files,
    File,
    Folder,
    Accordions,
    Accordion,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
```

`app/docs/[[...slug]]/page.tsx` **不用改**——它已经在用 `getMDXComponents({ a: createRelativeLink(...) })`，
你这边的链路是通的。

> **CSS 不用额外配置。** Fumadocs 自带 `@source inline(...)` 声明
> （在 `fumadocs-ui/css/generated/*.css` 里），Tailwind 会为这些组件生成类，
> 所以导入官方组件即有完整样式。

### 第 1 步的方案 B：用我的兜底实现

如果哪天官方子路径变了、或者你想少依赖一个包，可以用 `mdx-fallbacks.tsx`——
它用 React + Tailwind 自己实现了全部 12 个组件，**不依赖 fumadocs-ui**：

```bash
cp <文档包>/integration/mdx-fallbacks.tsx <站点>/components/mdx-fallbacks.tsx
```

然后在 `components/mdx.tsx` 里加两行：

```diff
  import defaultMdxComponents from 'fumadocs-ui/mdx';
+ import { mergeZeroshadowComponents } from './mdx-fallbacks';
  ...
      ...defaultMdxComponents,
+     ...mergeZeroshadowComponents(defaultMdxComponents),
      ...components,
```

`mergeZeroshadowComponents()` 只返回**缺失**的组件，所以两种方案可以叠加：
导入了官方的就用官方的，没导入的自动兜底。开发模式下控制台会打印哪些走了兜底：

```text
[mdx] fumadocs-ui 未提供以下组件，已使用本地兜底实现：Step
```

**到这里，你的报错就好了。**

## 第 2 步：复制文档内容

```bash
mkdir -p <站点>/content/docs/zeroshadow
cp -r <文档包>/content/docs/* <站点>/content/docs/zeroshadow/
```

复制后 `content/docs/zeroshadow/meta.json` 里已经带了 `"root": true`（我已经写好了），
所以它会成为**顶部一个独立 Tab**，和你其它软件并列，侧边栏只显示它自己的页面。

## 第 3 步：链接前缀 —— **已经帮你加好了**

> ✅ 文档包里的链接**已经是** `/docs/zeroshadow/...`（84 处改完，无缺漏、无重复、代码块未被误改）。
> **直接覆盖过去就行，不需要再跑脚本。**

背景（知道一下有用）：链接原本写的是 `/docs/guide/manual`，而真实 URL 是
`/docs/zeroshadow/guide/manual`——**少一层**。渲染没问题，所以不点进去不会发现，
一旦点"相关链接"就全是 404。这就是你遇到的那个问题。

### 如果挂载点不是 `zeroshadow`

`apply-docs-prefix.mjs` 只负责**加**前缀，**不会把已有前缀换成另一个**。
所以换挂载点时要先把 `/docs/zeroshadow/` 替换成 `/docs/<新名字>/`，
或者从原始版本重新加一次。

未加前缀的原始版本备份在仓库根 `build/mdx-unprefixed-backup/`（21 个文件，已 gitignore）。

### 校验

加了前缀后，校验器要用 `--route-prefix` 告诉它挂载点：

```bash
node <文档包>/.authoring/validate-mdx.mjs <文档包> --route-prefix=/docs/zeroshadow
```

实测 **0 问题**；不加这个参数会报 84 个「缺少前缀」，说明检查确实生效。

> **`--route-prefix` 与 `--scope` 的分工** —— 两者针对**两种不同布局**，别混：
>
> | 你在校验什么 | 用什么 |
> |:--|:--|
> | 文档包本体（`content/docs` 就是 zeroshadow 的内容） | `--route-prefix=/docs/zeroshadow` |
> | 站点整体（扫 `content/docs`，里面含 `zeroshadow/` 子目录） | `--scope=zeroshadow` |


## 第 4 步：在父级 `meta.json` 里登记

`<站点>/content/docs/meta.json` 的 `pages` 数组**末尾追加** `"zeroshadow"`：

```diff
  {
    "title": "你的文档库",
    "pages": [
      "现有条目1",
      "现有条目2",
+     "zeroshadow"
    ]
  }
```

**只追加，不要重排**。`pages` 数组同时也起「只显示列出的项」的作用，
所以不登记的话这个 Tab 不会出现。

## 第 5 步：复制图片（小心同名覆盖）

```bash
ls <站点>/public/img/          # ← 先看有没有同名文件！
cp <文档包>/public/img/* <站点>/public/img/
```

那 4 张图名字很通用：`file.png`、`ssh.png`、`vidio.png`、`dark.png`。
**你文档库很大，很可能已有同名文件**，直接 `cp` 会静默覆盖掉你自己的图。
若冲突，改成带前缀的名字（如 `zeroshadow-file.png`），并同步改 MDX 里的引用：

```bash
grep -rl '/img/' content/docs/zeroshadow | xargs sed -i 's#/img/file.png#/img/zeroshadow-file.png#g'
```

## 第 6 步：跑一次校验

我把校验器改成支持你的嵌套布局了。**在 `<站点>` 根目录执行**：

```bash
node <文档包>/.authoring/validate-mdx.mjs . --scope=zeroshadow
```

它会检查：MDX 转义（裸 `{}`、可疑 `<`）、代码块语言、组件白名单、
**站内链接前缀对不对**、图片是否存在、`meta.json` 是否完整。
退出码 = 问题数，**0 表示可以放心构建**。

三种情形我都实测过：

| 情形 | 结果 |
|:--|:--|
| 文档包本体（内容在顶层） | 0 问题 ✅ |
| 嵌套 + 已加前缀 + `--scope=zeroshadow`（你的布局） | 0 问题 ✅ |
| 嵌套 + **忘了加前缀** + `--scope=zeroshadow` | **84 个问题，全部指出"缺少前缀"** ✅ |

---

## 如果还报别的组件缺失

打开任意页面看控制台那行提示，它会列出所有走了兜底的组件名。
如果连 `Callout` 都缺，说明你站点的 `fumadocs-ui/mdx` 导入路径和我的假设不同——
那就不用管它，`mdx-fallbacks.tsx` 里的 12 个实现本身就是完整的，把
`mergeZeroshadowComponents()` 的第一个参数传 `{}` 即可全部走本地实现：

```tsx
...mergeZeroshadowComponents({}),
```

## 为什么报错偏偏是 `Step`

MDX 把 `<Step>` 编译成 JSX，渲染时去取组件：

```js
const { Step } = _components            // 从传进来的 components 里取
if (!Step) _missingMdxReference("Step") // 取不到就抛错
```

报错**只点名 `Step`**（不是 `Steps`、也不是 `Callout`），说明你的组件传递链路是通的、
`Callout` 之类也都有，只是组件表缺了 `Step` 这一个键。所以第 1、2 步就够了，不用动架构。

## 这套文档用到哪些组件

12 个，`mdx-fallbacks.tsx` 全部实现了：

| 组件 | 页面数 | 次数 | 用途 |
|:--|:--|:--|:--|
| `Callout` | 13 | 73 | 提示框（`type` = `info`/`warn`/`error`/`success`） |
| `Accordion` | 4 | 88 | 折叠项（FAQ 用了 80 个） |
| `Step` | 8 | 54 | 分步里的单步 |
| `File` | 1 | 34 | 目录树文件 |
| `Card` | 7 | 29 | 卡片 |
| `Folder` | 1 | 20 | 目录树文件夹 |
| `Accordions` | 4 | 17 | 折叠容器 |
| `Steps` | 8 | 12 | 分步容器 |
| `Cards` | 7 | 7 | 卡片容器 |
| `Tab` | 2 | 7 | 分栏单栏 |
| `Tabs` | 2 | 3 | 分栏容器（`items={[...]}`） |
| `Files` | 1 | 1 | 目录树容器 |

## 附：目录对照

```text
<文档包>/integration/
├── README.md                   ← 本文件
├── mdx-fallbacks.tsx           → <站点>/components/mdx-fallbacks.tsx
└── apply-docs-prefix.mjs       ← 就地运行，不用复制

<文档包>/content/docs/          → <站点>/content/docs/zeroshadow/
<文档包>/public/img/            → <站点>/public/img/（注意同名文件）
<文档包>/.authoring/            ← 校验脚本，就地运行或另存均可
```

## 附：怎么彻底绕开组件问题

若组件问题反复折腾不完，可以把内容改成**只用标准 Markdown + 原生 `<details>`**，
一个自定义组件都不需要，任何 Fumadocs 版本零配置可用：

| 现在 | 纯 Markdown 替代 |
|:--|:--|
| `<Callout type="warn">` | `> **注意** …` 引用块 |
| `<Steps>` / `<Step>` | 有序列表 `1.` `2.` `3.` |
| `<Cards>` / `<Card>` | 「页面 / 说明」两列表格 |
| `<Tabs>` / `<Tab>` | 拆成 `### 小标题` 并列 |
| `<Accordions>` / `<Accordion>` | 原生 `<details><summary>` |
| `<Files>` / `<File>` / `<Folder>` | 代码块里的缩进目录树 |

代价是失去折叠与分栏、页面变长；好处是再也不会因组件缺失而构建失败。
需要的话说一声，我转一整套给你。
