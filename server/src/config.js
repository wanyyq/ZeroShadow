import path from "node:path"
import { DATA_DIR } from "./env.js"
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
  // ===== 头像 =====
  avatarEnabled: true,
  avatarMaxKB: 200,
  // ===== 团队 Todo =====
  todoEnabled: true,
  // ===== 备份与数据保留 =====
  backupEnabled: true,
  backupKeep: 20,
  logRetentionDays: 30,
  metricsRetentionDays: 7,
  metricsMemMinutes: 15,
  requestMetricsEnabled: true,
  slowRequestMs: 1000,
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
      editFiles: !!p.editFiles,
      compressZip: !!p.compressZip,
      extractZip: !!p.extractZip,
      downloadUrl: !!p.downloadUrl,
      changePassword: !!p.changePassword,
    }
    const gp = group && group.perms
    if (gp && typeof gp === "object") {
      for (const key of Object.keys(base)) {
        if (key in gp) base[key] = base[key] && !!gp[key]
      }
    }
    return base
  }
  const g = config.guestPerms
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
    editFiles: !!g.editFiles,
    compressZip: !!g.compressZip,
    extractZip: !!g.extractZip,
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
