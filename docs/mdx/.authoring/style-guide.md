# MDX 写作规范（内部，不随文档站发布）

这份规范是为了让所有页面风格一致、并且**能真正通过 Fumadocs 构建**。
最后一条最重要：MDX 同时按 Markdown 和 JSX 解析，写错一个字符就是构建失败，不是显示不好看。

---

## 一、铁律：转义（构建失败的头号原因）

### 1. 花括号 `{` `}`

MDX 把 `{...}` 当 JavaScript 表达式求值，裸写必炸。

| 想写 | 不能写 | 应该写 |
|:--|:--|:--|
| 显示 `{"显示名":"/真实路径"}` | `{"显示名":"/真实路径"}` | `` `{"显示名":"/真实路径"}` `` |
| 显示 `{a,b}` | `{a,b}` | `` `{a,b}` `` 或 `\{a,b\}` |
| 显示 `password={pw}` | `password={pw}` | `` `password={pw}` `` |

**规则：凡是正文里出现 `{` 或 `}`，一律裹进反引号（行内代码）。** 代码块（``` 围栏）内部不受影响。

### 2. 尖括号 `<` `>`

`<` 后面紧跟字母、下划线或大写字母时，MDX 会当成 JSX 标签开始解析。

| 想写 | 不能写 | 应该写 |
|:--|:--|:--|
| 小于 2048MB | `<2048MB` | `` `<2048MB` `` 或 `&lt;2048MB` |
| 占位符 | `<版本>` | `` `<版本>` `` |
| 上传(<512MB) | `(<512MB)` | `(` `` `<512MB` `` `)` |
| 泛型 | `Array<string>` | `` `Array<string>` `` |

**注意 `>` 单独出现是安全的**（例如 `-&gt;`、`a > b`），只有 `<` 危险。

### 3. 其它

- 反引号本身要显示时，用双反引号包裹：`` `` `code` `` ``
- 竖线 `|` 在表格单元格里要写成 `\|`
- 禁止 HTML 注释 `<!-- -->`，需要注释就写成普通段落，或用 `{/* 注释 */}`

---

## 二、Frontmatter（每页必须有）

```yaml
---
title: 快速开始
description: 从安装依赖到第一次登录，五步把 ZeroShadow 跑起来。
icon: Rocket
---
```

- `title` **必填**：页面大标题，也是导航和搜索结果里的名字。简短，不超过 12 个汉字。
- `description` **必填**：一句话说清本页解决什么问题。会显示在页面顶部和搜索摘要里。
- `icon` 可选：lucide 图标名，**PascalCase**，例如 `Rocket`、`ShieldCheck`、`Terminal`、`Settings`、`Users`、`KeyRound`、`Network`、`BookOpen`、`Wrench`、`CircleHelp`、`Plug`、`Boxes`、`FlaskConical`、`Cable`。
- `full: true` 可选：让页面全宽（一般不用）。

---

## 三、正文结构

- **正文里不要再写 `#` 一级标题**，标题由 frontmatter 的 `title` 渲染。
- 从 `##` 开始，需要细分用 `###`。
- 每个 `##` / `###` 会自动进入右侧目录（TOC），所以标题要写得像一个目录条目。
- 页尾不要再加"上一篇/下一篇"，Fumadocs 会自己生成翻页。

---

## 四、可用组件

**只用下面这些**，它们都来自 `fumadocs-ui/mdx` 的默认导出，任何 Fumadocs 站点都有。
不要用其它组件——用户站点不一定装了，会导致构建失败。

### Callout（提示框）

```mdx
<Callout type="info" title="可选标题">
这里写正文，前后要留空行，内部支持 Markdown。
</Callout>
```

- `type` 取 `info` / `warn` / `error` / `success`，默认 `info`。
- **不要嵌套 Callout。**

### Cards / Card（卡片导航）

```mdx
<Cards>
  <Card title="快速开始" href="/docs/getting-started/quickstart" description="五步跑起来" />
  <Card title="安全设计" href="/docs/security/design" description="逐项拆解防护机制" />
</Cards>
```

### Steps / Step（步骤）

```mdx
<Steps>
<Step>
### 第一步
正文。
</Step>
<Step>
### 第二步
正文。
</Step>
</Steps>
```

### Tabs / Tab（分栏，适合多平台命令）

```mdx
<Tabs items={['Windows', 'macOS / Linux']}>
<Tab value="Windows">
正文
</Tab>
<Tab value="macOS / Linux">
正文
</Tab>
</Tabs>
```

### Files / File / Folder（目录树）

```mdx
<Files>
  <Folder name="server" defaultOpen>
    <File name="index.js" />
  </Folder>
</Files>
```

### Accordions / Accordion（折叠，适合 FAQ）

```mdx
<Accordions>
<Accordion title="问题标题">
答案。
</Accordion>
</Accordions>
```

---

## 五、代码块

- **必须写语言**，不要用裸 ```。
- 目录树、纯输出用 `text`：```` ```text ````。
- 常用语言名：`bash`、`powershell`、`bat`、`js`、`json`、`text`、`http`、`ini`。
- 围栏内部**不需要转义**，MDX 不解析它。
- 一段命令带输出时，命令与输出可以放同一个 `text` 块，也可以分开成 `bash` + `text`。

---

## 六、表格

直接用 GFM 表格。数值、默认值、开关这类信息**尽量用表格**，别写成大段文字。

---

## 七、链接

- 站内页面一律用**绝对路径且不带后缀**：`[快速开始](/docs/getting-started/quickstart)`
- 锚点用中文标题的拼音式 slug，Fumadocs 会去掉标点：标题 `### 工作目录（重要）` → `#工作目录重要`
- 指向仓库文件的链接用 GitHub 完整地址：`https://github.com/wanyyq/ZeroShadow/blob/main/server/src/env.js`

---

## 八、图片

- 源文件在仓库的 `docs/img/`，接入时要复制到文档站的 `public/img/`。
- MDX 里写绝对路径：`![文件浏览器界面](/img/file.png)`
- 被引用的图只有四张：`file.png`（文件浏览）、`ssh.png`（隧道设置）、`vidio.png`（预览）、`dark.png`（暗色模式）。

---

## 九、内容纪律

1. **完整保留原文**。源仓库 `docs/*.md` 里的表格、代码块、数值、默认值、注意事项，一个都不能少，不能"精简"。
2. 允许并且鼓励：把大段文字改写成表格、把并列要点改成列表、把长段落拆成小标题、把重复内容合并。
3. 不允许：删掉任何一个配置项、接口、权限点、错误码、开关默认值。
4. 语言：全中文，与仓库现有文档一致。技术名词保留英文原样（如 `pnpm`、`FILES_DIR`）。
5. 口径统一：产品名 **ZeroShadow**（不要写 EPan、网盘系统等别名）；"超管"= 超级管理员；"成员"= 团队成员。
6. 不要写"本文档由……生成"之类的元信息。

---

## 十、自查清单（每页写完过一遍）

- [ ] frontmatter 有 `title` 和 `description`
- [ ] 正文没有 `#` 一级标题
- [ ] 全文搜一遍 `{` 和 `}`，逐个确认都在反引号或代码块里
- [ ] 全文搜一遍 `<`，确认要么是合法组件标签，要么在反引号里
- [ ] 所有代码块都标了语言
- [ ] 只用了第四节列出的组件
- [ ] 原文的表格与数值一个都没丢
- [ ] 站内链接形如 `/docs/xxx/yyy`
