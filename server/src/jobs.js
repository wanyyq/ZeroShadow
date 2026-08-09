import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { TMP_DIR } from "./env.js"

const TTL_MS = 10 * 60 * 1000

const jobs = new Map()

function now() {
  return Date.now()
}

function sweep() {
  const cutoff = now() - TTL_MS
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) {
      if (job.file) fs.promises.rm(job.file, { force: true }).catch(() => {})
      jobs.delete(id)
    }
  }
}

setInterval(sweep, 60 * 1000).unref()

export function createJob(type, { label, total = 0, totalBytes = 0 }) {
  const id = crypto.randomBytes(8).toString("hex")
  const job = {
    id,
    type,
    label,
    total,
    totalBytes,
    state: "running",
    processed: 0,
    processedBytes: 0,
    percent: 0,
    file: null,
    error: null,
    createdBy: null,
    createdAt: now(),
    updatedAt: now(),
  }
  jobs.set(id, job)
  return job
}

export function getJob(id) {
  const job = jobs.get(id)
  if (!job) return null
  job.updatedAt = now()
  return job
}

export function patchJob(id, patch) {
  const job = jobs.get(id)
  if (!job) return
  Object.assign(job, patch, { updatedAt: now() })
}

export function finishJob(id, { state = "done", error = null, file } = {}) {
  const job = jobs.get(id)
  if (!job) return
  const patch = { state, error, updatedAt: now() }
  if (file !== undefined) patch.file = file
  Object.assign(job, patch)
  if (state === "done") {
    job.percent = 100
    if (job.total > 0) job.processed = job.total
    if (job.totalBytes > 0) job.processedBytes = job.totalBytes
  }
}

export function jobStatus(id) {
  const job = jobs.get(id)
  if (!job) return null
  job.updatedAt = now()
  const { state, type, label, percent, processed, total, processedBytes, totalBytes, error, count } = job
  return { id, state, type, label, percent, processed, total, processedBytes, totalBytes, error, count }
}

export async function consumeJobFile(id) {
  const job = jobs.get(id)
  if (!job) return null
  const file = job.file
  job.file = null
  jobs.delete(id)
  return file
}

export async function failJob(id, error) {
  const job = jobs.get(id)
  if (!job) return
  const file = job.file
  finishJob(id, { state: "error", error: String(error?.message || error) })
  if (file) {
    fs.promises.rm(file, { force: true }).catch(() => {})
  }
}

export function tmpFilePath(prefix) {
  return path.join(TMP_DIR, `${prefix}-${crypto.randomBytes(8).toString("hex")}`)
}
