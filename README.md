<a id="top"></a>

<p align="center">
  <img src="" width="120" alt="ZeroShadow Logo" />
</p>

<h1 align="center">ZeroShadow</h1>

<p align="center">
  <strong>轻量级局域网网盘 · 安全 · 现代 · 开箱即用</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22%2B-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React" />
  <img src="https://img.shields.io/badge/Tailwind-v4-38bdf8" alt="Tailwind" />
  <img src="https://img.shields.io/badge/Shadcn_UI-4.13-black" alt="Shadcn" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License" />
</p>

---

> **ZeroShadow** 是一款基于 Node.js + React 的轻量网盘应用，支持局域网文件共享与公网穿透访问。内置三级权限体系（超级管理员 / 团队成员 / 访客），确保文件安全可控。

---

## 截图预览

> 以下为占位图，请自行替换为实际截图。

<!-- TODO: 替换为实际截图 -->

<div align="center">
  <img src="" width="800" alt="主界面 - 文件浏览" />
  <p><em>图 1：文件浏览器（列表/网格视图、右键菜单、多选操作）</em></p>

<img src="" width="800" alt="设置 - 公网隧道" />
  <p><em>图 2：超管设置 —— 权限管理 & SSH 公网隧道</em></p>

<img src="" width="800" alt="文件预览" />
  <p><em>图 3：文件预览（图片 / 视频 / PDF / 文本）</em></p>

<img src="" width="800" alt="暗色模式" />
  <p><em>图 4：暗色模式</em></p>
</div>

---

## 功能特性

### 文件管理

- **上传** 批量文件 / 文件夹拖拽上传，支持超大文件（超管 2GB，可调）
- **下载** 单文件流式下载 / 文件夹 ZIP 打包下载（可配置大小上限）
- **预览** 图片缩放拖拽、音视频播放、PDF 内嵌、文本高亮、HTML 渲染
- **编辑** 在线文本编辑器，支持保存回写
- **操作** 复制、粘贴、移动、重命名、删除（均支持覆盖/合并策略）
- **搜索** 递归全目录搜索
- **压缩/解压** 在线 ZIP 压缩与解压

### 权限体系

| 角色        | 浏览  | 下载  | 上传         | 编辑  | 管理  | 设置    |
|:--------- |:---:|:---:|:----------:|:---:|:---:|:-----:|
| **超级管理员** | 全部  | 全部  | 全部（≤2GB）   | 全部  | 全部  | 全部    |
| **团队成员**  | 全部  | 可配  | 可配（≤512MB） | 可配  | 可配  | 客户端设置 |
| **访客**    | 可配  | 可配  | 不可         | 不可  | 不可  | 客户端设置 |

- 超级管理员为全局唯一账户，密码仅通过 `.env` 修改
- 团队成员由超管批量创建、启/禁用、重置密码
- 访客无需登录即可访问（可设定隐藏文件夹）

### 公网穿透

- 内置 SSH 反向隧道，一键暴露至公网
- 支持 **pinggy.io** / **localhost.run** / **serveo.net** 三种免费隧道服务，以及自定义 SSH 服务器
- 自动断线重连（指数退避），实时日志展示

### 安全加固

- 前后端双重 JWT 认证，httpOnly + SameSite Cookie
- CSRF 保护（`X-Requested-With` 校验）
- 登录暴力破解锁定（IP + 用户名双维度，15 分钟窗口）
- 密码 bcrypt 哈希 + 定时安全比较
- 路径穿越防护，符号链接拒绝
- 安全响应头（`nosniff`、`SAMEORIGIN`、`no-referrer`）

### 跨平台

- Windows / macOS / Linux 均可运行
- 支持打包为独立 `.exe`（Windows）

---

## 快速开始

### 环境要求

- **Node.js** >= 22
- **pnpm** >= 9

### 安装与启动

```bash
# 1. 克隆项目
git clone <your-repo-url> && cd EPan

# 2. 安装依赖
pnpm setup

# 3. 配置环境变量
# 首次运行会自动生成 .env 及随机超管密码，亦可手动创建：
# cp .env.example .env
# 编辑 .env 中 SUPER_ADMIN_PASSWORD 等配置

# 4. 开发模式
pnpm dev:server   # 终端 1：启动后端（--watch 热重载）
pnpm dev:web      # 终端 2：启动前端 (http://localhost:5173)

# 5. 生产模式
pnpm build        # 构建前端
pnpm start        # 启动服务 (http://localhost:12345)
```

启动后控制台会打印局域网地址，同一网络下其他设备可直接访问。

---

## 配置参考

完整的 `.env` 配置项：

| 变量                     | 默认值            | 说明                               |
|:---------------------- |:-------------- |:-------------------------------- |
| `PORT`                 | `12345`        | 服务端口                             |
| `HOST`                 | `0.0.0.0`      | 监听地址（`0.0.0.0` 局域网可访问）           |
| `SUPER_ADMIN_USER`     | `admin`        | 超管用户名                            |
| `SUPER_ADMIN_PASSWORD` | 自动生成           | 超管密码（修改后需重启）                     |
| `SESSION_HOURS`        | `72`           | 登录有效期（小时）                        |
| `FILES_DIR`            | `./data/files` | 文件存储根目录                          |
| `FILES_SOFT_DIR`       | 无              | 外部只读映射，JSON 格式：`{"显示名":"/真实路径"}` |
| `NOLOG`                | `false`        | 静默模式（仅写日志文件，不输出控制台）              |

> 启动参数：`node server/index.js -nolog` 可临时关闭控制台日志。

---

## 项目结构

```
EPan/
├── server/                 # 后端 (Express)
│   ├── index.js            # 入口，中间件注册
│   └── src/
│       ├── auth.js         # JWT 认证 · CSRF · 暴力破解防御
│       ├── config.js       # 运行时配置 (JSON 持久化)
│       ├── env.js          # .env 解析 · 密钥管理
│       ├── files.js        # 文件系统操作
│       ├── logger.js       # 结构化日志
│       ├── safety.js       # 路径校验 · 文件名清洗
│       ├── status.js       # 服务器状态收集
│       ├── store.js        # 原子写入 · 文件锁
│       ├── tunnel.js       # SSH 公网隧道管理
│       ├── users.js        # 用户增删改查 · bcrypt 验证
│       └── routes/
│           ├── auth.js     # /api/auth/*
│           ├── fs.js       # /api/fs/*
│           └── admin.js    # /api/admin/* (超管专属)
│
├── web/                    # 前端 (React + Shadcn UI)
│   ├── src/
│   │   ├── pages/          # 页面组件
│   │   │   ├── browser-page.tsx   # 文件浏览器
│   │   │   ├── login-page.tsx     # 登录
│   │   │   ├── settings/          # 设置面板
│   │   │   ├── preview-page.tsx   # 文件预览
│   │   │   ├── editor-page.tsx    # 文本编辑器
│   │   │   └── html-page.tsx      # HTML 渲染
│   │   ├── components/     # UI 组件 · 布局
│   │   ├── state/          # 状态管理 (auth · clipboard · uploads · settings)
│   │   └── lib/            # 工具函数 · API 客户端 · 类型定义
│   └── dist/               # 构建产物
│
├── data/                   # 运行时数据 (自动生成)
│   ├── config.json         # 服务配置
│   ├── users.json          # 用户数据
│   ├── files/              # 网盘文件根目录
│   ├── logs/               # 运行日志
│   └── tmp/                # 临时文件
│
├── public/resources/       # 静态资源
│   ├── lucide.min.js       # 图标库
│   ├── gsap.min.js         # 动画库
│   └── google_sans_flex.woff  # 字体
│
├── Auto-building.bat       # 一键打包脚本 (→ .exe)
└── smoke-test.ps1          # 冒烟测试脚本
```

---

## 一键打包

在 Windows 上运行 `Auto-building.bat` 可自动完成：

1. 检查 Node.js 版本
2. 安装依赖
3. 构建前端 (`web/dist/`)
4. 打包后端 (`esbuild` → `pkg` → `ZeroShadow.exe`)
5. 生成发布目录 `ZeroShadow-Release/`（含 `.exe` + `web/dist/` + `data/`）

---

## 开发

```bash
# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 后端打包为 CJS
cd server && pnpm bundle
```

### 技术栈

| 层级        | 技术                          |
|:--------- |:--------------------------- |
| **后端运行时** | Node.js (ESM)               |
| **后端框架**  | Express 4                   |
| **认证**    | JWT + bcrypt + CSRF         |
| **文件上传**  | Busboy                      |
| **压缩**    | Archiver / Unzipper         |
| **前端**    | React 19 + TypeScript       |
| **样式**    | Tailwind CSS v4 + Shadcn UI |
| **UI 设计** | Fumadocs 风格 (自定义主题令牌)       |
| **图标**    | Lucide                      |
| **动画**    | GSAP + CSS Transition       |
| **构建**    | Vite / esbuild / pkg        |

---

## 冒烟测试

```powershell
# 确保服务运行在 localhost:12345
.\smoke-test.ps1
```

覆盖：CSRF 防护、登录认证、文件 CRUD、权限隔离、访客访问、ZIP 操作、隧道状态等 15 个场景。

---

## License

[Apache 2.0](LICENSE)

---

Copyright@Wanyyq(Github账户) 2026
