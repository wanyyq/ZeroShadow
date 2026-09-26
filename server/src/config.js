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
  // 单 IP 每分钟可执行的"重型操作"次数（打包/解压/搜索/详情/链接下载）
  rateLimitEnabled: true,
  rateLimitPerMin: 120,
  // 只读外部映射目录的内容是否允许复制/压缩进网盘主目录
  softDirAllowCopyOut: false,
  // 作业进度是否只有创建者（与超管）可查询
  jobStatusOwnerOnly: true,
  // 链接下载是否允许访问内网地址（等效于环境变量 DOWNLOAD_URL_ALLOW_PRIVATE）
  downloadUrlAllowPrivate: false,
  // 写操作是否校验来源（Origin / Sec-Fetch-Site）；若反向代理会改写 Host 头
  // 导致误拦，可在后台关闭（仍保留自定义请求头校验）
  csrfOriginCheck: true,
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

let config = deepMerge(structuredClone(DEFAULTS), readJsonSync(CONFIG_FILE, {}))

export function getConfig() {
  return config
}

export async function saveConfig(mutator) {
  return withLock("config", async () => {
    const draft = structuredClone(config)
    mutator(draft)
    config = deepMerge(structuredClone(DEFAULTS), draft)
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

export function effectivePerms(role) {
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
    return {
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
