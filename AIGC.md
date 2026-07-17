# Role

你是一位精通文档美学与现代前端工程化的资深全栈工程师。
请基于 React 19 + Shadcn UI + Tailwind CSS v4 搭建项目。

# Project Initialization (⚠️ 强制首步执行)

必须使用以下命令初始化项目，这是shadcn-create的在线可视化风格编辑器里由我调好的参数：
pnpm dlx shadcn@latest init --preset b1Z74QJ7q
初始化完成后，再按下方规范补充静态资源与组件定制。

# Static Assets (已就绪，位于 public/resources/)

以下资源已存在于项目的 public/resources/ 目录中，构建后将被原样复制至 dist/resources/，请通过绝对路径 /resources/xxx 引用：

- google_sans_flex.woff2 → 英文数字字体，通过 @font-face 加载
- lucide.min.js → 图标库，通过 <script> 标签引入并使用 lucide.createIcons() 初始化
- gsap.min.js → 动画库，通过 <script> 标签引入

# Design System: Fumadocs Aesthetic (v16.9.3 Reverse-Engineered)

严格复刻 Fumadocs UI 的视觉基因，本作者喜欢Fumadocs UI的UI风格。所有样式通过 Tailwind CSS v4 @theme 指令定义。

## 1. 几何与圆角令牌

在 app.css 的 @theme 中定义，组件仅通过 token 引用：

- --radius-sm: 0.25rem → Badge, Tag, Inline Code
- --radius-md: 0.5rem → Button, Input, Tab
- --radius-lg: 0.75rem → Card, Dialog, Code Block
- --radius-xl: 1rem → Modal, Large Container

## 2. 色彩工程

- 基础色：Zinc/Slate 中性色阶，禁用纯黑(#000)/纯白(#fff)作边框或正文
- 强调色：HSL 定义，Saturation ≤ 60%，Lightness 随 dark/light 模式动态调整
- 边框色：带透明度，如 hsl(var(--border) / 0.5)，视觉"退后"
- 色彩空间：优先 oklch() 或 hsl()，确保感知均匀
- 背景纹理：可选 1-3% SVG 噪点（base64 内联）消除塑料感

## 3. 深度与边界

- 禁用生硬 box-shadow，改用：
  - inset shadow 模拟凹陷
  - gradient border 模拟玻璃质感
  - 1px 高光线条置于组件顶部/左侧
- 过渡动画：基础用 transition-all duration-200 ease-out；复杂入场/滚动联动用 GSAP（通过 /resources/gsap.min.js 加载）

## 4. 图标规范 (⚠️ 强制静态资源加载)

- 加载方式：必须在 index.html 中通过 <script src="/resources/lucide.min.js"></script> 引入
- 渲染方式：使用 <i data-lucide="icon-name"></i> 占位，DOM Ready 后调用 lucide.createIcons() 初始化
- 尺寸：固定容器宽高，inline-flex items-center justify-center 光学居中
- 颜色：始终 currentColor，随文字状态联动
- 自定义图标：stroke-width=2, linecap=round, linejoin=round
- 动态内容：新增 DOM 节点后需重新调用 lucide.createIcons()

## 5. 排版节奏

- 字体：'Google Sans Flex', system-ui, sans-serif（通过 @font-face 加载 /resources/google_sans_flex.woff2）
- 比例：Major Third (1.25) 模块化比例
- 间距：全部通过 Tailwind spacing token 控制

# Tech Stack & Build Constraints

- 框架：React 19 (非 Next.js)
- 样式：Tailwind CSS v4
- 组件：Shadcn UI（通过 CLI 初始）
- 图标：lucide.min.js（public/resources/ 静态资源，<script> 引入）
- 字体：google_sans_flex.woff2（public/resources/ 静态资源，@font-face 加载）
- 动画：GSAP（public/resources/gsap.min.js）+ CSS Transition

# Deliverables

1. 完整项目结构（含 package.json, , tsconfig.json）
2. index.html 中的静态资源 <script> 引入顺序
3. app.css 中的 @theme 令牌定义（含 light/dark 变量及 @font-face）
4. 图标使用 data-lucide 属性
5. Lucide 初始化脚本封装（含 MutationObserver 监听动态内容）
6. 页面布局代码（响应式三栏/单栏结构）
7. 对齐 Fumadocs 美学

# Anti-Patterns (严禁出现)

- ❌ 使用 Shadcn 默认主题色/圆角
- ❌ 字体/图标/GSAP 使用 CDN 链接（必须 /resources/,要资源请通知我并且告诉我链接，我下载到本地才行）
- ❌ 高饱和品牌色大面积使用
- ❌ 纯黑/纯白边框
- ❌ 未使用 @theme token 的硬编码值
- ❌ 图标与文字颜色/动画不同步
- ❌ 使用 box-shadow 代替内阴影/渐变边框
- ❌ 忽略字体加载失败回退方案
- ❌ 动态插入 DOM 后未重新调用 createIcons()
- ❌ 修改初始化命令、预设 ID 或模板类型