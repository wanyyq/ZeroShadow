import path from "node:path"
import { DATA_DIR } from "./env.js"
import { readJsonSync, withLock, writeJsonAtomic } from "./store.js"

const CONFIG_FILE = path.join(DATA_DIR, "config.json")

const DEFAULTS = {
  superUploadLimitMB: 2048,
  memberUploadLimitMB: 512,
  memberPerms: {
    fileWrite: true,
    upload: true,
    uploadFolders: true,
    download: true,
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
    changePassword: true,
  },
  guestPerms: {
    download: true,
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

export function effectivePerms(role) {
  if (role === "superadmin") {
    return {
      fileWrite: true,
      upload: true,
      uploadFolders: true,
      download: true,
      copy: true,
      move: true,
      rename: true,
      delete: true,
      mkdir: true,
      manageGuestVisibility: true,
      details: true,
      zip: true,
      htmlPreview: true,
      editFiles: true,
      compressZip: true,
      extractZip: true,
      changePassword: true,
    }
  }
  if (role === "member") {
    const p = config.memberPerms
    const fw = !!p.fileWrite
    return {
      fileWrite: fw,
      upload: fw && !!p.upload,
      uploadFolders: fw && !!p.uploadFolders,
      download: !!p.download,
      copy: fw && !!p.copy,
      move: fw && !!p.move,
      rename: fw && !!p.rename,
      delete: fw && !!p.delete,
      mkdir: fw && !!p.mkdir,
      manageGuestVisibility: !!p.manageGuestVisibility,
      details: true,
      zip: !!p.download,
      htmlPreview: !!p.htmlPreview,
      editFiles: !!p.editFiles,
      compressZip: !!p.compressZip,
      extractZip: !!p.extractZip,
      changePassword: !!p.changePassword,
    }
  }
  const g = config.guestPerms
  return {
    fileWrite: false,
    upload: false,
    uploadFolders: false,
    download: !!g.download,
    copy: false,
    move: false,
    rename: false,
    delete: false,
    mkdir: false,
    manageGuestVisibility: false,
    details: false,
    zip: !!g.download,
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
