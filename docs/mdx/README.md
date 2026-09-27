# ZeroShadow 文档（Fumadocs 版）

这个目录是一套**可直接放进 Fumadocs 文档站**的完整文档内容，目标站点是
`wiki.hellowyq.com`。

## 目录里有什么

```text
docs/mdx/
├── README.md                  ← 本文件（接入说明，不用放进站点）
├── .authoring/                ← 写作规范，只给维护者看，不要放进站点
├── public/                    ← 静态资源，对应站点根的 public/
│   └── img/                   ← 文档里引用的截图
└── content/
    └── docs/                  ← 对应站点的 content/docs/
        ├── meta.json
        ├── index.mdx
        ├── getting-started/   quickstart · faq
        ├── guide/             manual · permissions
        ├── admin/             admin-guide · configuration · tunnel
        ├── security/          design
        ├── development/       architecture · build · testing · release
        └── api/               reference
```

## 接入步骤

### 1. 复制内容

把 `content/docs/` 里的**全部内容**复制到你站点的 `content/docs/` 下：

```bash
cp -r docs/mdx/content/docs/* <你的站点>/content/docs/
```

如果 `wiki.hellowyq.com` 上已经有别的文档，而你想把 ZeroShadow 当成一个**子栏目**，
那就整包放进一个文件夹里，例如放到 `content/docs/zeroshadow/`：

```bash
mkdir -p <你的站点>/content/docs/zeroshadow
cp -r docs/mdx/content/docs/* <你的站点>/content/docs/zeroshadow/
```

然后在 `<你的站点>/content/docs/meta.json` 的 `pages` 里加一项 `"zeroshadow"`。

> 注意：**嵌套之后站内链接会失效**。本套文档里的站内链接写的是绝对路径
> `/docs/...`（例如 `/docs/guide/manual`）。如果改成放在 `/docs/zeroshadow/` 下，
> 需要把所有 `/docs/` 前缀批量替换成 `/docs/zeroshadow/`。
> 例如：
> ```bash
> grep -rl '/docs/' content/docs/zeroshadow | xargs sed -i 's#/docs/#/docs/zeroshadow/#g'
> ```
> 替换后记得人工检查一遍有没有把 `/docs/zeroshadow/zeroshadow/` 这类重复前缀弄出来。

### 2. 复制图片

```bash
mkdir -p <你的站点>/public/img
cp docs/mdx/public/img/* <你的站点>/public/img/
```

文档里用 `/img/xxx.png` 引用这四张截图，所以目标路径必须是站点根的 `public/img/`。

### 3. 确认组件可用

这套 MDX 只用了 Fumadocs 的**默认组件**，正常情况下不需要任何额外配置。
用到的组件：

| 组件 | 用途 |
|:--|:--|
| `Callout` | 提示框（`type` 取 `info` / `warn` / `error` / `success`） |
| `Cards` / `Card` | 卡片导航 |
| `Steps` / `Step` | 分步操作 |
| `Tabs` / `Tab` | 平台分栏 |
| `Files` / `File` / `Folder` | 目录树 |
| `Accordions` / `Accordion` | 折叠问答 |

如果你的 `mdx-components.tsx` 是从 `fumadocs-ui/mdx` 的 `getMDXComponents()` 生成的，
它们**全部已内置**，无需改动。若你自定义过组件表，请确认上面这些仍然被导出。

### 4. 可选：首页入口

`index.mdx` 是这套文档的落地页，已经包含产品介绍、功能列表、技术栈与阅读指引，
以及一个指向各章节的 `<Cards>` 导航块。

## 内容说明

| 页面 | 路径 | 内容 |
|:--|:--|:--|
| 介绍 | `/docs` | 产品定位、功能特性、权限概览、技术栈、阅读指引 |
| 快速开始 | `/docs/getting-started/quickstart` | 环境要求、三步启动、开发模式、工作目录规则、从发布包运行 |
| 常见问题 | `/docs/getting-started/faq` | 按现象分类的排查清单 |
| 使用手册 | `/docs/guide/manual` | 界面、上传下载、预览、在线编辑、搜索、压缩解压、快捷方式、链接下载器、冲突处理、快捷键 |
| 权限与角色 | `/docs/guide/permissions` | 三角色完整权限矩阵、权限依赖、访客隐藏规则 |
| 管理员指南 | `/docs/admin/admin-guide` | 设置页七个标签页逐项说明 |
| 配置参考 | `/docs/admin/configuration` | `.env` 全部变量 + `config.json` 全部字段与默认值 |
| 公网访问与隧道 | `/docs/admin/tunnel` | 四种隧道模式、真实 ssh 命令、`TRUST_PROXY` 用法与排查 |
| 安全设计 | `/docs/security/design` | 认证、CSRF、路径安全、SSRF 防护、沙箱、限流、密钥卫生 |
| 架构与目录结构 | `/docs/development/architecture` | 技术底座、目录树、请求链、权限判定、数据存放、前端组织 |
| 开发与构建 | `/docs/development/build` | 工作目录规则、本地开发、构建、常见坑 |
| 测试脚本 | `/docs/development/testing` | 冒烟测试与安全回归测试的用法与断言清单 |
| 打包与 CI | `/docs/development/release` | 五平台矩阵、发布包组成、密钥门禁、GitHub Actions |
| API 参考 | `/docs/api/reference` | 全部 HTTP 接口、参数、权限要求与错误码 |

## 兼容性说明

- **面向 Fumadocs v14 / v15 / v16 均可**。内容只用标准 MDX 语法与默认组件，没有依赖
  特定版本的 API。
- 内容**全中文**，`title` / `description` 也是中文，导航将显示中文。
- 侧边栏顺序由各级 `meta.json` 的 `pages` 数组控制，不是按文件名排序。
- 每页的 `icon` 用的是 **lucide 图标名（PascalCase）**，例如 `Rocket`、`ShieldCheck`、
  `Users`。如果你的站点没开启图标显示，这个字段会被忽略，不影响构建。

## 需要留意的 MDX 转义

这套内容已经逐字检查过 MDX 转义规则，你**修改时请留意**：

- 正文里出现 `{` 或 `}` **必须**裹在反引号里（例如 `` `{"显示名":"/真实路径"}` ``），
  否则 MDX 会把它当 JavaScript 表达式求值，构建直接失败；
- 正文里出现 `<` 且后面紧跟字母时（例如 `` `<512MB` ``、`` `<版本>` ``），同样必须裹反引号，
  否则会被当成 JSX 标签；
- 代码块（``` 围栏）内部不受影响，无需转义。

详细规范见 `.authoring/style-guide.md`（那个目录是给维护者看的，**不要**复制进站点）。

## 维护这套文档

`.authoring/` 目录里有三个工具，**只给维护者用，不要复制进站点**：

| 文件 | 作用 |
|:--|:--|
| `style-guide.md` | MDX 写作规范：转义铁律、frontmatter 要求、可用组件清单、自查清单 |
| `validate-mdx.mjs` | **构建安全校验器**：检查裸 `{}` / 可疑 `<` / 代码块语言 / H1 / 组件白名单 / 站内链接 / 图片 / `meta.json` |
| `check-coverage.mjs` | **内容完整性核对**：从源文档抽特征 token，确认没有内容被漏掉 |

改完文档跑一遍这两个脚本：

```bash
node docs/mdx/.authoring/validate-mdx.mjs docs/mdx   # 退出码 = 问题数，0 表示可安全构建
node docs/mdx/.authoring/check-coverage.mjs docs/mdx # 退出码 = 疑似丢失的 token 数
```

### 为什么需要它们

- **`validate-mdx.mjs`**：MDX 把裸 `{` 当 JS 表达式、把裸 `<abc` 当 JSX 标签，两者都让构建
  **直接失败**，而且报错位置常常离真正的问题很远。几千行中文文档靠人眼通读必漏。
  它已针对一个关键细节做了处理：**组件标签内部的 `{}` 是合法的**
  （`<Tabs items={['a','b']}>` 就是这么写的），所以会先把组件标签整体掩码掉再检查，
  否则会满屏误报。
- **`check-coverage.mjs`**：语法校验只能证明"不会构建失败"，证明不了"内容没丢"。
  这个脚本反过来做——把源文档里的配置键、环境变量、接口路径、数值等特征 token 抽出来，
  逐个确认在目标 MDX 里存在，**少一个就报出来**。

当前状态：`validate-mdx.mjs` 退出码 0；`check-coverage.mjs` 剩 4 个 token 命中不到，
已人工确认全部是**有意的重排**（数值单位间的空格、把 `{ ... }` 展开成更明确的写法、
把一行报错拆成多行代码块），内容本身没有丢失。

## 与仓库内旧文档的关系

仓库的 `docs/*.md` 是这些内容的**源**（GitHub 上直接读的版本，用相对链接互跳）。
`docs/mdx/` 是面向文档站的**改编版**：重新组织了导航、做了组件化改写、并把站内链接
换成了站点绝对路径。两边内容应当保持一致；如果要长期维护，建议以 `docs/mdx/` 为准，
改动后回过来同步 `docs/*.md`。
