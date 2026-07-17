import path from "node:path"
import { DATA_DIR } from "./env.js"
import { readJsonSync, withLock, writeJsonAtomic } from "./store.js"

const CONFIG_FILE = path.join(DATA_DIR, "config.json")

const DEFAULTS = {
  superUploadLimitMB: 2048,
  memberUploadLimitMB: 512,
  memberPerms: {
    upload: true,
    download: true,
    copy: true,
    move: true,
    rename: true,
    delete: true,
    mkdir: true,
    manageGuestVisibility: true,
  },
  guestPerms: {
    download: true,
    zip: true,
  },
  guestHiddenPaths: [],
  tunnel: {
    enabled: false,
    mode: "serveo",
    customHost: "",
  },
}

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
      upload: true,
      download: true,
      copy: true,
      move: true,
      rename: true,
      delete: true,
      mkdir: true,
      manageGuestVisibility: true,
      details: true,
      zip: true,
    }
  }
  if (role === "member") {
    const p = config.memberPerms
    return {
      upload: !!p.upload,
      download: !!p.download,
      copy: !!p.copy,
      move: !!p.move,
      rename: !!p.rename,
      delete: !!p.delete,
      mkdir: !!p.mkdir,
      manageGuestVisibility: !!p.manageGuestVisibility,
      details: true,
      zip: !!p.download,
    }
  }
  return {
    upload: false,
    download: !!config.guestPerms.download,
    copy: false,
    move: false,
    rename: false,
    delete: false,
    mkdir: false,
    manageGuestVisibility: false,
    details: false,
    zip: !!config.guestPerms.download && !!config.guestPerms.zip,
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
