<a id="top"></a>

<h1 align="center">ZeroShadow</h1>

<p align="center">
  <strong>轻量级局域网网盘 · 一款极简好用的工作室网盘</strong><br />
  Node.js + React · 三级权限 · 只读目录映射 · 一键公网穿透
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React" />
  <img src="https://img.shields.io/badge/Tailwind-v4-38bdf8" alt="Tailwind" />
  <img src="https://img.shields.io/badge/Shadcn_UI-4.13-black" alt="Shadcn" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License" />
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/README.md">文档中心</a> ·
  <a href="docs/使用手册.md">使用手册</a> ·
  <a href="docs/管理员指南.md">管理员指南</a> ·
  <a href="docs/常见问题.md">常见问题</a>
</p>

---

## 它是什么

把一台电脑变成团队共用的私有网盘：**服务端一个命令跑起来，客户端只要有浏览器**。

- 同一个局域网里，同事打开 `http://<你的局域网IP>:12345` 就能存取文件，**无需安装任何客户端**；
- 需要给外部的人访问时，内置 SSH 反向隧道，**一次点击拿到公网地址**；
- 角色只有三种（超级管理员 / 团队成员 / 访客），**每个权限点都能在后台单独开关**。

没有数据库、没有 Docker、也没有外部服务依赖：文件直接躺在磁盘目录里，配置就是 `.env` 和 `data/config.json` 两个文件，随时可迁移、可备份、可整目录带走。

---

## 为什么值得一用

|               | ZeroShadow 的做法 |
|:-------------- |:--------------- |
| **开箱即用** | `pnpm setup && pnpm build && pnpm start`，首次启动**自动生成 `.env` 与随机超管密码**并打印在控制台；也可以直接双击打包出的 `ZeroShadow.exe` |
| **跨平台** | 服务端 Windows / macOS / Linux 都能跑；客户端现代浏览器即可，手机、平板都能用 |
| **权限够细** | 19 个权限开关，成员"文件操作"还有一个总开关统一收口；访客可**按文件夹**隐藏 |
| **看得见的进度** | 上传、ZIP 压缩、ZIP 解压、链接下载都是**带百分比的任务**，不怕大文件没反馈 |
| **不搬数据** | `FILES_SOFT_DIR` 把服务器上任意目录挂成**只读文件夹**，视频、素材库、软件包原地播放，零拷贝 |
| **安全是默认值** | 默认**禁止**链接下载访问内网（防 SSRF）、默认**禁止**把只读目录内容复制进网盘、默认限制单 IP 重型操作频率；所有开关都在后台可见 |
| **可验证** | 仓库自带安全回归测试与冒烟测试，断言写成脚本，改完代码跑一遍就知道有没有退化 |

---

## 截图预览

<div align="center">
  <img src="./docs/img/file.png" width="800" alt="主界面 - 文件浏览" />
  <p><em>图 1：文件浏览器（列表 / 网格视图、右键菜单、多选操作）</em></p>

  <img src="./docs/img/ssh.png" width="800" alt="设置 - 公网隧道" />
  <p><em>图 2：超管设置 —— 权限管理 &amp; SSH 公网隧道</em></p>

  <img src="./docs/img/vidio.png" width="800" alt="文件预览" />
  <p><em>图 3：文件预览（图片 / 视频 / 音频 / PDF / 文本）</em></p>

  <img src="./docs/img/dark.png" width="800" alt="暗色模式" />
  <p><em>图 4：暗色模式</em></p>
</div>

---

## 功能特性

### 文件管理

- **上传** 点击上传、拖拽上传、整目录拖拽上传（保留目录结构），单次请求最多 100 个文件
- **下载** 单文件流式下载；多选或文件夹自动 ZIP 打包下载（文件数 / 单文件 / 总量三重上限）
- **预览** 图片（滚轮缩放、拖拽平移、双击放大）、视频、音频、PDF 内嵌、文本原样预览
- **在线编辑** 文本文件直接在浏览器里改并保存回写（`Ctrl + S`）
- **HTML 预览** 上传的 HTML 可以全屏渲染，并在沙箱 iframe 中运行，拿不到网盘自身的会话
- **文件操作** 新建文件夹、复制 / 剪切 / 粘贴、复制到…、移动到…、重命名、删除，遇到同名可逐项选择**重命名 / 跳过 / 覆盖 / 合并**
- **递归搜索** 按文件名递归查找（界面从根目录开始搜，最多返回 200 条，避免把服务器搜爆）
- **压缩 / 解压** 在线打包 ZIP、在线解压 ZIP（带进度、带体积上限、失败自动清理半成品）
- **只读映射目录** 把服务器其他路径挂成网盘里的只读文件夹，不占空间、不复制
- **快捷方式** `.zeropath` 文件可以把入口指向任意目录或文件，并自定义显示名与图标
- **链接下载器** 填一个 `http/https` 直链，服务端帮你抓进网盘目录（带进度、可自定义文件名）
- **实用工具** 内置文件大小单位换算

### 权限体系

> 提示：下文"可配"指的是超级管理员可在「设置 → 权限」中自由调整。完整矩阵见 [权限与角色](docs/权限与角色.md)。

| 角色 | 浏览 | 下载 | 上传 | 编辑 | 成员管理 | 服务器设置 |
|:--------- |:---:|:---:|:------------:|:---:|:---:|:-----:|
| **超级管理员** | 全部 | 全部 | 全部（默认 ≤ 2048MB） | 全部 | 全部 | 全部 |
| **团队成员** | 全部 | 可配 | 可配（默认 ≤ 512MB） | 可配 | 不可 | 仅客户端设置 |
| **访客** | 可配 | 可配 | 不可 | 不可 | 不可 | 仅客户端设置 |

- 超级管理员**全局唯一**，密码只能改 `.env`，改后重启生效（旧会话同时失效）
- 团队成员由超管**批量创建**（一次最多 200 个）、启用 / 禁用、改用户名、重置密码，人数上限 500
- 访客**无需登录**即可浏览与下载，可对指定文件夹逐个设置为"对访客隐藏"

### 客户端体验

- 列表 / 网格两种视图，名称 / 大小 / 修改时间排序，文件夹置顶
- 浅色 / 深色 / 跟随系统三态主题，按 `D` 键快速切换
- 常用快捷键：`F2` 重命名、`Delete` 删除、`Ctrl/⌘ + A/C/X/V` 全选 / 复制 / 剪切 / 粘贴、`Enter` 打开
- 窄屏自适应，手机浏览器同样可上传下载；面包屑、悬浮信息卡、右键菜单一应俱全

### 公网穿透

- 内置 SSH 反向隧道，后台一键开启，实时日志与公网地址直接显示在界面上
- 内置四种模式：**pinggy.io** / **localhost.run** / **serveo.net** / **自定义 SSH 服务器**
- 掉线自动重连（5 秒起指数退避，最长 60 秒一轮），并记录重连次数

### 安全加固

- 会话走 **httpOnly + SameSite=Lax** Cookie，服务端每次请求校验 JWT 与账号状态
- **CSRF 双重校验**：自定义请求头 + 浏览器来源信息（`Origin` / `Sec-Fetch-Site`）
- **登录暴破防护**：按 IP 与用户名双维度计数，连续触发时锁定时长递增
- 成员密码 **bcrypt** 哈希存储；超管密码使用 `timingSafeEqual` 定时安全比较
- **路径穿越防护**：拒绝 `..`、NUL 字节、越界符号链接；上传文件名统一清洗
- **链接下载防 SSRF**：解析全部 A/AAAA 记录后逐条校验地址段，并把已校验 IP 固定给 socket
- 上传的 HTML / SVG 内联返回时强制 `CSP: sandbox`，不会在网盘自身的源里执行脚本
- 安全响应头：`Content-Security-Policy`、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`

更完整的机制说明（含每一项的开关与默认值）见 [安全设计](docs/安全设计.md)。

---

## 快速开始

### 环境要求

- **Node.js** ≥ 18
- **pnpm** ≥ 9

### 三步跑起来

```bash
# 1. 安装依赖（会自动安装 server 与 web 两个子项目的依赖）
pnpm setup

# 2. 构建前端（生成 web/dist）
pnpm build

# 3. 启动服务（默认 12345 端口）
pnpm start
```

启动后控制台会打印访问地址，**同一局域网内的其他设备直接用浏览器打开即可**：

```
  ZeroShadow 网盘已启动
  本机访问:   http://localhost:12345
  局域网访问: http://192.168.x.x:12345
  文件目录:   <项目目录>\data\files
  客户端 IP:  直连（不信任代理头）
```

> **首次启动会自动生成 `.env`**，并写入一个随机生成的超级管理员密码，控制台上会以醒目方式打印出来，请第一时间保存。用户名默认为 `admin`。
>
> 如果 `.env` 里没有写 `SUPER_ADMIN_PASSWORD`，或者写的还是模板值 `change-me`，服务也会自动生成一个随机密码并回写到 `.env`。

### 开发模式

```bash
pnpm dev:server   # 终端 1：后端（node --watch 热重载），默认 12345
pnpm dev:web      # 终端 2：前端 Vite 开发服务器，默认 5173
```

开发时请访问 **http://localhost:5173**：Vite 会把 `/api` 请求代理到 `http://localhost:12345`。
（生产模式不需要 Vite，后端直接托管 `web/dist`。）

---

## 文档中心

| 文档 | 内容 |
|:-------------------- |:--------------------------------------- |
| [docs/README.md](docs/README.md) | 文档索引与阅读路径建议 |
| [快速开始](docs/快速开始.md) | 安装、启动、首次登录、局域网 / 公网访问、从 exe 发布包运行 |
| [使用手册](docs/使用手册.md) | 界面导览、上传下载、预览、在线编辑、搜索、压缩解压、快捷方式、链接下载器 |
| [权限与角色](docs/权限与角色.md) | 三种角色的完整权限矩阵与每一项权限的实际效果 |
| [管理员指南](docs/管理员指南.md) | 设置页七个标签页逐项说明：状态、日志、成员、权限、安全、公网、外观 |
| [配置参考](docs/配置参考.md) | `.env` 全部变量、`data/config.json` 全部字段、默认值与取值范围 |
| [公网访问与隧道](docs/公网访问与隧道.md) | 四种隧道模式、`TRUST_PROXY` 正确用法、公网部署注意事项 |
| [安全设计](docs/安全设计.md) | 认证、CSRF、路径安全、SSRF 防护、沙箱、限流、日志与密钥卫生 |
| [常见问题](docs/常见问题.md) | 启动失败、端口占用、忘记密码、上传被拒、隧道不通等排查清单 |
| [开发者指南](docs/开发者指南.md) | 目录结构、代码组织、构建与测试脚本、发布打包流程 |
| [API 参考](docs/API参考.md) | 全部 HTTP 接口、参数、权限要求与错误码 |

---

## 配置速查

完整说明见 [配置参考](docs/配置参考.md)。`.env` 放在项目根目录（打包成 exe 后放在 `ZeroShadow.exe` 同目录）：

| 变量 | 默认值 | 说明 |
|:---------------------- |:-------------- |:-------------------------------- |
| `PORT` | `12345` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址（`0.0.0.0` 时局域网可访问） |
| `SUPER_ADMIN_USER` | `admin` | 超管用户名 |
| `SUPER_ADMIN_PASSWORD` | 自动生成 | 超管密码（修改后需重启） |
| `SESSION_HOURS` | `72` | 登录有效期（小时） |
| `FILES_DIR` | `./data/files` | 网盘文件根目录 |
| `FILES_SOFT_DIR` | 无 | 外部只读映射目录，JSON：`{"显示名":"/真实路径"}` |
| `TRUST_PROXY` | 关闭 | 经隧道 / 反代访问时取真实客户端 IP，见 [公网访问与隧道](docs/公网访问与隧道.md) |
| `DOWNLOAD_URL_ALLOW_PRIVATE` | 关闭 | 允许链接下载访问内网地址 |
| `DOWNLOAD_URL_ALLOW_HOSTS` | 无 | 仅放开指定主机的内网访问，逗号分隔 |
| `DOWNLOAD_URL_INSECURE_TLS` | 关闭 | 跳过链接下载的 TLS 证书校验（不推荐） |
| `NOLOG` | 关闭 | 只写日志文件，不输出控制台 |

---

## 项目结构

```
ZeroShadow/
├── server/                 # 后端 (Express, ESM)
│   ├── index.js            # 入口：中间件、路由挂载、静态托管、优雅退出
│   └── src/
│       ├── auth.js         # JWT 认证 · CSRF 校验 · 登录暴破防护
│       ├── config.js       # 运行时配置（权限矩阵、各类上限）
│       ├── env.js          # .env 解析 · 密钥生成 · 目录准备
│       ├── files.js        # 文件系统操作（列目录、搜索、统计、复制移动）
│       ├── jobs.js         # 长任务进度（压缩 / 解压 / 链接下载）
│       ├── logger.js       # 结构化日志（按天 JSONL）
│       ├── netguard.js     # 出站目标校验（DNS + 地址段 + 固定 IP，防 SSRF）
│       ├── ratelimit.js    # 重型接口按 IP 限流
│       ├── safety.js       # 路径校验 · 名称清洗 · 访客可见性
│       ├── status.js       # 服务器状态采集
│       ├── store.js        # 原子写入 · 串行锁
│       ├── tunnel.js       # SSH 反向隧道管理
│       ├── users.js        # 成员增删改查 · bcrypt 校验
│       └── routes/
│           ├── auth.js     # /api/auth/*
│           ├── fs.js       # /api/fs/*
│           └── admin.js    # /api/admin/*（超管专属）
│
├── web/                    # 前端 (React 19 + Tailwind v4 + shadcn)
│   ├── src/
│   │   ├── pages/          # 页面：浏览 / 登录 / 设置 / 预览 / 编辑 / HTML / 工具 / 关于
│   │   ├── components/     # UI 组件 · 布局 · 业务弹窗
│   │   ├── state/          # 状态：认证 · 剪贴板 · 上传 · 长任务 · 客户端偏好
│   │   └── lib/            # API 客户端 · 类型 · 格式化 · 冲突检测
│   └── dist/               # 构建产物（pnpm build 生成）
│
├── public/resources/       # 静态资源（字体 / lucide / gsap / tailwind）
├── docs/                   # 文档与截图
├── data/                   # 运行时数据（自动生成，已 gitignore）
│   ├── config.json         # 服务配置
│   ├── users.json          # 成员数据（bcrypt 哈希）
│   ├── .jwt-secret         # 会话签名密钥
│   ├── files/              # 网盘文件根目录
│   ├── logs/               # 运行日志
│   └── tmp/                # 临时文件（每次启动清空）
│
├── build-release.ps1       # 多平台构建编排（本地与 CI 共用；产物 ZeroShadow-<版本>-<平台>.zip）
├── Auto-building.bat       # Windows 一键打包（build-release.ps1 的薄封装）
├── package-release.ps1     # 发布打包 + 文档暂存 + 密钥门禁
├── security-test.ps1       # 安全回归测试（16 组断言）
├── smoke-test.ps1          # 冒烟测试（38 项断言，跑完自动还原现场）
└── .github/workflows/      # GitHub Actions：五平台 node18 自动编译
```

> **工作目录很重要**：`server/src/env.js` 用 `process.cwd()` 推导项目根目录，
> 因此请一律在**仓库根**执行 `pnpm start` / `pnpm dev:server`。在 `server/` 里直接
> `node index.js` 会把 `server/` 当成项目根，凭空生成 `server/.env` 与 `server/data/`，
> 看起来就像"数据丢了"。详见 [开发者指南](docs/开发者指南.md#工作目录重要)。

---

## 开发与测试

```bash
pnpm typecheck              # 前端类型检查（tsc --noEmit）
pnpm lint                   # 前端代码检查（eslint）
cd server && pnpm bundle    # 后端打包为单个 CJS（esbuild，供 pkg 使用）
```

### 冒烟测试

```powershell
# 1) 先确认服务在运行（pnpm dev:server 或 pnpm start）
# 2) 另开一个终端执行——端口与超管账号会自动从 .env 读取
powershell -NoProfile -ExecutionPolicy Bypass -File smoke-test.ps1

# 也可以指定别的实例（例如独立测试实例）
powershell -NoProfile -ExecutionPolicy Bypass -File smoke-test.ps1 -BaseUrl http://127.0.0.1:5179
```

覆盖 CSRF 拦截、登录、目录创建、路径穿越拦截、上传、访客隐藏文件夹、访客权限边界、
成员创建与登录、复制 / 重命名 / 移动 / 详情 / 删除、禁用成员后会话失效、ZIP 打包、
搜索、日志、服务器状态、隧道状态、SPA 与静态资源等 **9 组共 38 项断言**。

脚本的行为约定：

- **端口与超管凭据从 `.env` 读取**，不再写死；可用 `-BaseUrl` / `-User` / `-Password` 覆盖；
- 只在自己的临时目录里活动（随机命名 `_smoketest-<随机>`），**跑完自动删除**；
- 临时创建的成员账号跑完自动删除，因此 `data/users.json` 不会被改动；
- 若 `data/config.json` 是本轮才第一次生成的（访客可见性测试会写它），跑完会删掉，
  让实例回到「纯用代码内默认值」的原状；已被别人改过配置则原样保留、不做删改；
- **退出码 = 失败项数量**，`0` 表示全部通过；连不上服务退 `1`，超管登录失败退 `2`；
- 断言「错误凭据返回 401」时故意用**不存在的用户名**，而不是超管自己的账号——
  登录失败计数按提交的用户名累计，超管全局唯一，用他的账号做这个断言会让每跑一次就
  给他记一笔失败，多跑几轮可能把自己锁在门外。

> 它会**真实改动你的网盘内容**（创建/删除自己那个临时目录），建议对测试实例运行。
> 详见 [开发者指南](docs/开发者指南.md#smoke-testps1冒烟测试)。

### 安全回归测试

`security-test.ps1` 把安全审计结论固化成可重复执行的断言，共 16 组：

```powershell
# 1) 起一个测试实例（建议独立端口，避免打扰正在使用的服务）
$env:HOST='127.0.0.1'; $env:PORT='5179'; node server/index.js

# 2) 另开一个终端执行
powershell -NoProfile -ExecutionPolicy Bypass -File security-test.ps1 -BaseUrl http://127.0.0.1:5179
```

覆盖：传输层加固、认证与授权、路径穿越、访客开关语义、SSRF 12 种写法、HTML/SVG 沙箱、
zip-slip、凭据与发布卫生、客户端 IP 解析、登录锁定、解压上限与清理、限流、只读映射目录、
作业归属、访客可见性随重命名同步、路径解析加固。**退出码 = 失败项数量，0 表示全部通过。**

可选参数：`-PositiveProbeUrl`（正向下载验证，需服务端用 `DOWNLOAD_URL_ALLOW_HOSTS` 放开该主机）、
`-LoopbackAllowlisted`、`-TrustProxyMode`、`-TestLockout`（会消耗 IP 失败额度，建议对全新实例运行）、
`-SoftDirName`（验证只读映射目录）、`-TestJobOwnership`（临时创建并删除一个成员账号）、
`-KeepScratch`（保留测试临时目录）。详见 [开发者指南](docs/开发者指南.md)。

---

## 一键打包

构建逻辑集中在 **`build-release.ps1`** 一个脚本里，本地与 GitHub Actions 都调用它，
所以两边的产物不会跑偏。

### Windows：双击 `Auto-building.bat`

它会调用 `build-release.ps1`，依次完成：

1. 检查 Node.js 版本、确认 `pnpm` 与 `pkg` 可用（缺 `pkg` 时自动全局安装）
2. 安装 `server` 与 `web` 依赖
3. 构建前端（`web/dist/`）
4. 用 `esbuild` 把后端 ESM 打成单个 CJS（pkg 对 ESM 支持不佳）
5. 对每个目标平台跑 `pkg`，把结果暂存到 `build/<平台>/`
6. 调用 `package-release.ps1`：补上 `LICENSE` / `README.md` / `docs/`，清理运行期密钥，
   执行密钥门禁，产出 `ZeroShadow-<版本>-<平台>.zip`

也可以只构建指定平台（避免每次下载全部运行时）：

```bat
Auto-building.bat windows-x64
Auto-building.bat windows-x64,linux-x64
```

### 平台矩阵

| 平台标签 | pkg 目标 | 可执行文件 |
|:--------------- |:------------------------- |:------------------ |
| `windows-x64` | `node18-win-x64` | `ZeroShadow.exe` |
| `windows-arm64` | `node18-win-arm64` | `ZeroShadow.exe` |
| `linux-x64` | `node18-linux-x64` | `ZeroShadow` |
| `linux-arm64` | `node18-linux-arm64` | `ZeroShadow` |
| `linux-armv7` | `node18-linuxstatic-armv7` | `ZeroShadow` |

> **`windows-x32` 做不出来**（32 位 Windows）。`pkg` 依赖的 `pkg-fetch` 从来没有发布过
> win-x86 的基础运行时——不是 node18 没有，而是**任何 Node 版本都没有**。这一点经过三方核对：
> `pkg-fetch` 3.4.2 自带的 `EXPECTED_HASHES` 里没有任何 `*-win-x86` 键、它的 v3.4 release
> 共 178 个 asset 里没有 win-x86、社区维护分支 `@yao-pkg/pkg-fetch` 的 v3.5 release 共 997 个
> asset 里同样没有。向 `pkg` 请求该目标会直接报
> `404: Not Found ... {"tag":"v3.4","name":"node-v18.5.0-win-x86"}`。
> 若确实需要 32 位 Windows 包，得换用别的打包器（例如 nexe），那会产出一个结构完全不同的
> 二进制，需要单独一条打包路径，不是在这里多加一个 `--target` 就能解决的。
> `build-release.ps1` 收到 `windows-x32` 时会直接给出上述原因并退出，而不是抛一个难懂的 pkg 404。
>
> `linux-armv7` 用的是 **`linuxstatic-armv7`**：`pkg-fetch` 只有静态链接版的 armv7，
> 没有普通的 `linux-armv7`。静态链接对分发反而更好——产物不依赖目标机的 glibc 版本。

> **"node18" 指的是打进包里的运行时，不是构建时用的 Node。** `pkg` 会把 node18 运行时
> 嵌进产物，所以产物与构建机的 Node 版本无关；但构建机本身需要较新的 Node，因为
> Vite 8 要求 `^20.19.0 || >=22.12.0`——**前端在 Node 18 上根本构建不了**。

### Linux / macOS 上构建

```bash
pwsh -NoProfile -File build-release.ps1 -Targets linux-x64,linux-arm64,linux-armv7
```

Linux 归档里的 `ZeroShadow` 会带上可执行位（ZIP 的 external attributes 里写了 `0755`），
解压后可直接运行，不需要手工 `chmod +x`。

### GitHub Actions 自动编译

`.github/workflows/build-release.yml` 在 `windows-latest` 与 `ubuntu-latest` 上并行构建
上表中的五个平台，每个平台产出一个 `ZeroShadow-<版本>-<平台>.zip`：

- 推 `v*` 标签时，归档会自动附加到对应的 GitHub Release；
- 其它触发方式（`main` 分支、PR、手动 `workflow_dispatch`）只上传为 Actions 产物；
- 打包后会**校验归档内容**：必须含后端可执行文件、`web/dist/`、`.env.example`、
  `LICENSE`、`README.md` 与 `docs/*.md`，且不得含任何凭据——缺任何一项都会让 CI 失败。

### 发布包内容

```
ZeroShadow-1.1.0-windows-x64.zip
├── ZeroShadow.exe   /  ZeroShadow    后端可执行文件
├── web/dist/                         前端静态文件
├── .env.example                      配置模板（首次运行自动生成 .env）
├── data/                             运行期数据目录
├── LICENSE                           Apache 2.0
├── README.md                         项目说明
└── docs/                             全部用户手册 + 截图
```

使用方式与从源码运行完全一致：把包解压到目标机器，运行可执行文件，
首次启动会在它同目录生成 `.env` 与 `data/`，并在控制台打印随机超管密码。

> **密钥门禁**：`package-release.ps1` 会删除发布目录里的 `.env`、`data/.jwt-secret`、
> `data/users.json`、`data/config.json`、`data/logs/*.log`；如果发现 `data/files/*`、
> `data/tmp/*` 或任何 `.zip` 残留，则**拒绝出包**（退出码 2）。也正因如此，**永远不要把仓库根目录直接打成压缩包**。
> 另外请注意：**不要打包一个已经运行过的发布目录**——它内部已经生成了 `.env` 与
> `data/.jwt-secret`，一旦被打进归档，所有拿到该包的人都共用同一个超管密码与同一个
> 会话签名密钥（后者可被用来伪造任意登录态）。务必让脚本从干净目录重新组装。

---

## 技术栈

| 层级 | 技术 |
|:--------- |:--------------------------- |
| **后端运行时** | Node.js（ESM） |
| **后端框架** | Express 4 |
| **认证** | JWT（jsonwebtoken）+ bcryptjs + CSRF 校验 |
| **文件上传** | Busboy |
| **压缩** | Archiver / Unzipper |
| **前端** | React 19 + TypeScript + react-router-dom 7 |
| **样式** | Tailwind CSS v4 + shadcn 组件（base-vega 风格） |
| **图标 / 动画** | Lucide（本地 `lucide.min.js`）/ GSAP（本地） |
| **构建** | Vite / esbuild / pkg |

> 图标、字体、GSAP 全部走本地 `public/resources/`，**不依赖任何 CDN**，内网离线也能正常显示。

---

## License

[Apache 2.0](LICENSE)

---

Copyright © Wanyyq（GitHub: [wanyyq](https://github.com/wanyyq)）2026

<p align="right"><a href="#top">回到顶部 ↑</a></p>
