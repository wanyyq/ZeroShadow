import os from "node:os"
import fs from "node:fs"
import { env, FILES_DIR } from "./env.js"
import { dirStats } from "./files.js"
import { tunnelStatus } from "./tunnel.js"

const startedAt = Date.now()
let cachedUsage = null
let cachedUsageAt = 0

export function lanAddresses() {
  const addrs = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        addrs.push(net.address)
      }
    }
  }
  return addrs
}

export async function getStatus() {
  const now = Date.now()
  if (!cachedUsage || now - cachedUsageAt > 30000) {
    cachedUsage = await dirStats(FILES_DIR)
    cachedUsageAt = now
  }
  let disk = null
  try {
    const stat = await fs.promises.statfs(FILES_DIR)
    disk = {
      free: Number(stat.bavail) * Number(stat.bsize),
      total: Number(stat.blocks) * Number(stat.bsize),
    }
  } catch {
    disk = null
  }
  const mem = process.memoryUsage()
  return {
    startedAt,
    uptimeSec: Math.floor((now - startedAt) / 1000),
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    port: env.port,
    host: env.host,
    lan: lanAddresses(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      systemFree: os.freemem(),
      systemTotal: os.totalmem(),
    },
    storage: {
      files: cachedUsage.files,
      dirs: cachedUsage.dirs,
      bytes: cachedUsage.bytes,
      partial: cachedUsage.partial,
      root: FILES_DIR,
    },
    disk,
    tunnel: tunnelStatus(),
  }
}
