import path from "node:path"
import { DATA_DIR, WEBDAV_ENABLED, WEBDAV_PATH } from "./env.js"
import { readJsonSync, withLock, writeJsonAtomic } from "./store.js"

const CONFIG_FILE = path.join(DATA_DIR, "config.json")

const DEFAULTS = {
  superUploadLimitMB: 2048,
  memberUploadLimitMB: 512,
  zipMaxFiles: 100,
  zipMaxSingleMB: 50,
  zipMaxTotalMB: 128,
  extractMaxZipMB: 128,
  extractMaxTotalMB: 512,
  downloadUrlMaxMB: 4096,
  // ===== 安全开关（后台可调，默认均为较安全的取值）=====
  rateLimitEnabled: true,
  rateLimitPerMin: 120,
  softDirAllowCopyOut: false,
  jobStatusOwnerOnly: true,
  downloadUrlAllowPrivate: false,
  csrfOriginCheck: true,
  /**
   * 超管会话代次：每次「登出」+1，写进超管 JWT 的 `se` 声明。
   * 无状态 JWT 本身没法吊销，靠这个计数器实现「登出后旧令牌立即失效」。
   * 成员走 users.json 里的 tokenVersion，不需要这一项。
   */
  superSessionEpoch: 0,
  // ===== 头像 =====
  avatarEnabled: true,
  avatarMaxKB: 200,
  // ===== 团队 Todo =====
  todoEnabled: true,
  // ===== 备份与数据保留 =====
  backupEnabled: true,
  backupKeep: 20,
  logRetentionDays: 30,
  // ===== 回收站（删除改为移入回收站，超期自动清理）=====
  trashEnabled: true,
  trashRetentionDays: 30,
  metricsRetentionDays: 7,
  metricsMemMinutes: 15,
  requestMetricsEnabled: true,
  slowRequestMs: 1000,
  // ===== 分享链接（v1.2.1）=====
  /** 分享总开关：关掉后既有链接一律 403，也不能新建 */
  shareEnabled: true,
  /** 匿名可访问；设为 false 则分享链接必须登录网盘账号才能打开 */
  sharePublicAccess: true,
  // ===== WebDAV 挂载（v2.0 起为正式功能，默认仍关闭）=====
  /**
   * 是否启用 WebDAV。
   *
   * 默认值取自 `.env` 的 `WEBDAV`（老配置继续有效），但**一旦后台保存过这个字段，
   * 就以 `data/config.json` 为准** —— 后台开关优先级高于 `.env`。
   * 这样既不会让老部署升级后突然失去挂载，也不会让 `.env` 悄悄覆盖管理员的选择。
   */
  webdavEnabled: WEBDAV_ENABLED,
  /** 挂载路径，默认 /dav（同样以 .env 的 WEBDAV_PATH 为默认值） */
  webdavPath: WEBDAV_PATH,
  // ===== 插件（v2.0，默认关闭）=====
  /**
   * 插件总开关。**默认 false**：与项目其它"默认收紧"的开关一致 ——
   * 插件是第三方内容（哪怕这一轮只支持主题），管理员必须显式打开才谈得上安装。
   * 关掉后既有插件不再生效，但不会被删除（数据还在 data/plugins/）。
   */
  pluginsEnabled: false,
  // ===== 界面语言 =====
  /** 站点默认界面语言；用户在自己浏览器里选过的语言会覆盖它 */
  defaultLang: "zh",
  // ===== 未分组/默认上下文的可见范围 =====
  defaultVisibility: {
    whitelist: [],
    blacklist: [],
  },
  memberPerms: {
    fileWrite: true,
    browse: true,
    upload: true,
    uploadFolders: true,
    downloadFile: true,
    downloadFolder: true,
    preview: true,
    copy: true,
    move: true,
    rename: true,
    delete: true,
    mkdir: true,
    manageGuestVisibility: true,
    htmlPreview: true,
    editFiles: true,
    compressZip: true,
    extractZip: true,
    downloadUrl: true,
    changePassword: true,
  },
  guestPerms: {
    browse: true,
    downloadFile: true,
    downloadFolder: true,
    preview: true,
    htmlPreview: false,
    editFiles: false,
    compressZip: false,
    extractZip: false,
  },
  /**
   * 访客写权限总开关。
   *
   * 访客没有 fileWrite（恒为 false），但 guestPerms 里的 editFiles / compressZip /
   * extractZip 会产生真实写入。默认把这三个子权限整体锁死：只有显式打开这个总开关，
   * 管理员在下面勾选的子权限才会生效 —— "允许匿名访客改文件"必须是**单独一次**
   * 明确决定，而不是顺手勾了一个看起来无害的子项。
   */
  guestWrite: false,
  guestHiddenPaths: [],
  tunnel: {
    enabled: false,
    mode: "pinggy",
    customHost: "",
  },
};

// 成员权限键（顺序即后台展示顺序）；也是小组权限收窄的依据
export const MEMBER_PERM_KEYS = Object.keys(DEFAULTS.memberPerms)

function deepMerge(base, extra) {
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base
  if (base && typeof base === "object") {
    const out = { ...base }
    if (extra && typeof extra === "object") {
      for (const key of Object.keys(base)) {
        if (key in extra) out[key] = deepMerge(base[key], extra[key])
      }
    }
    return out
  }
  return extra === undefined ? base : extra
}

function normalizeConfig(raw) {
  return deepMerge(structuredClone(DEFAULTS), raw)
}

let config = normalizeConfig(readJsonSync(CONFIG_FILE, {}))

export function getConfig() {
  return config
}

/** 从磁盘重读配置（用于备份回滚后同步内存态） */
export function reloadConfig() {
  config = normalizeConfig(readJsonSync(CONFIG_FILE, {}))
  return config
}

export async function saveConfig(mutator) {
  return withLock("config", async () => {
    const draft = structuredClone(config)
    mutator(draft)
    config = normalizeConfig(draft)
    await writeJsonAtomic(CONFIG_FILE, config)
    return config
  })
}

function legacyDownload(p) {
  if (p.download !== undefined) return !!p.download
  return !!(p.downloadFile ?? true)
}

function legacyDownloadFolder(p) {
  if (p.downloadFolder !== undefined) return !!p.downloadFolder
  return !!(p.download ?? true)
}

function legacyPreview(p) {
  if (p.preview !== undefined) return !!p.preview
  return !!(p.download ?? true)
}

/**
 * 在已有权限上叠加若干个"收窄"（group.perms）—— 逐键取与，deny 优先。
 *
 * 单独抽出来是因为有两种调用方式：
 *   - 指定了小组上下文：`narrowPerms(global, [group.perms])`；
 *   - 没指定（或指定的小组不属于自己）：`narrowPerms(global, 我所属所有组)`，
 *     即"缺省上下文"取所属各组的**交集**，这样去掉请求头也拿不回被收窄的权限。
 */
export function narrowPerms(base, permsList = []) {
  const out = { ...base }
  for (const gp of permsList) {
    if (!gp || typeof gp !== "object") continue
    for (const key of Object.keys(out)) {
      if (key in gp) out[key] = out[key] && !!gp[key]
    }
  }
  return out
}

/**
 * 计算某角色的有效权限。
 * @param {string} role superadmin | member | guest
 * @param {{perms?: object}|null} group 当前小组上下文（仅对 member 生效）
 *
 * 小组权限只能"收窄"全局 memberPerms：两者取与。
 */
export function effectivePerms(role, group = null) {
  if (role === "superadmin") {
    return {
      fileWrite: true,
      browse: true,
      upload: true,
      uploadFolders: true,
      downloadFile: true,
      downloadFolder: true,
      preview: true,
      copy: true,
      move: true,
      rename: true,
      delete: true,
      mkdir: true,
      manageGuestVisibility: true,
      details: true,
      htmlPreview: true,
      editFiles: true,
      compressZip: true,
      extractZip: true,
      downloadUrl: true,
      changePassword: true,
    }
  }
  if (role === "member") {
    const p = config.memberPerms
    const fw = !!p.fileWrite
    const base = {
      fileWrite: fw,
      browse: !!p.browse,
      upload: fw && !!p.upload,
      uploadFolders: fw && !!p.uploadFolders,
      downloadFile: legacyDownload(p),
      downloadFolder: legacyDownloadFolder(p),
      preview: legacyPreview(p),
      copy: fw && !!p.copy,
      move: fw && !!p.move,
      rename: fw && !!p.rename,
      delete: fw && !!p.delete,
      mkdir: fw && !!p.mkdir,
      manageGuestVisibility: !!p.manageGuestVisibility,
      details: true,
      htmlPreview: !!p.htmlPreview,
      // 「在线编辑」会覆盖已有文件内容，属于写操作：fileWrite 关闭时必须一起关，
      // 否则「只读成员」仍能通过编辑器改写别人的文件（见安全审计）。
      editFiles: fw && !!p.editFiles,
      // 压缩 / 解压 / 链接下载都会往网盘里**写新文件**（zip、解压出的目录树、
      // 下载到的文件）。它们曾经漏了 fw 这一层，于是被设为"只读"的成员仍然能
      // 通过 /api/fs/extract（单次 512MB）或 /api/fs/download-url 往盘里写东西。
      compressZip: fw && !!p.compressZip,
      extractZip: fw && !!p.extractZip,
      downloadUrl: fw && !!p.downloadUrl,
      changePassword: !!p.changePassword,
    }
    return narrowPerms(base, group?.perms ? [group.perms] : [])
  }
  const g = config.guestPerms
  // 访客写权限总开关（默认关）：关掉时，下面三个子权限一律不生效
  const gw = !!config.guestWrite
  return {
    fileWrite: false,
    browse: !!g.browse,
    upload: false,
    uploadFolders: false,
    downloadFile: legacyDownload(g),
    downloadFolder: legacyDownloadFolder(g),
    preview: legacyPreview(g),
    copy: false,
    move: false,
    rename: false,
    delete: false,
    mkdir: false,
    manageGuestVisibility: false,
    details: false,
    htmlPreview: !!g.htmlPreview,
    editFiles: gw && !!g.editFiles,
    compressZip: gw && !!g.compressZip,
    extractZip: gw && !!g.extractZip,
    downloadUrl: false,
    changePassword: false,
  }
}

export function uploadLimitBytes(role) {
  if (role === "superadmin") return config.superUploadLimitMB * 1024 * 1024
  if (role === "member") return config.memberUploadLimitMB * 1024 * 1024
  return 0
}

export function uploadLimitMB(role) {
  if (role === "superadmin") return config.superUploadLimitMB
  if (role === "member") return config.memberUploadLimitMB
  return 0
}

export function zipLimits() {
  return {
    maxFiles: config.zipMaxFiles ?? 100,
    maxSingleBytes: (config.zipMaxSingleMB ?? 50) * 1024 * 1024,
    maxTotalBytes: (config.zipMaxTotalMB ?? 128) * 1024 * 1024,
    extractMaxBytes: (config.extractMaxZipMB ?? 128) * 1024 * 1024,
    extractMaxTotalBytes: (config.extractMaxTotalMB ?? 512) * 1024 * 1024,
  }
}

/** 链接下载工具的单个文件体积上限（默认 4096MB，可在后台调整） */
export function downloadUrlLimitBytes() {
  const mb = config.downloadUrlMaxMB ?? 4096
  return mb > 0 ? mb * 1024 * 1024 : 0
}

export function avatarMaxBytes() {
  const kb = config.avatarMaxKB ?? 200
  return Math.max(1, Number(kb) || 200) * 1024
}
