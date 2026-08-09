/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { toast } from "sonner"
import { compressJobStatus, downloadUrlJobStatus, extractJobStatus, startCompressJob, startDownloadUrlJob, startExtractJob } from "@/lib/api"
import { uid } from "@/lib/format"
import type { OpType } from "@/lib/types"

export interface OpJob {
  id: string
  type: OpType
  label: string
  percent: number
  status: "running" | "done" | "error"
  error?: string
  count?: number
}

interface OpsState {
  jobs: OpJob[]
  startCompress: (paths: string[]) => void
  startExtract: (path: string, dest: string) => void
  startDownloadUrl: (url: string, dest: string, filename?: string) => void
  dismiss: (id: string) => void
  clearFinished: () => void
  onCompleted: (listener: (job: OpJob) => void) => () => void
}

const Ctx = React.createContext<OpsState | undefined>(undefined)

const POLL_MS = 400

export function OperationsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = React.useState<OpJob[]>([])
  const listeners = React.useRef(new Set<(job: OpJob) => void>())
  const timers = React.useRef(new Map<string, number>())
  const uiToServer = React.useRef(new Map<string, string>())

  const stopPolling = React.useCallback((key: string) => {
    const t = timers.current.get(key)
    if (t) {
      window.clearInterval(t)
      timers.current.delete(key)
    }
  }, [])

  const patch = React.useCallback((id: string, partial: Partial<OpJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...partial } : j)))
  }, [])

  const finish = React.useCallback(
    (job: OpJob) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id
            ? { ...j, status: job.status, percent: job.percent, error: job.error, count: job.count }
            : j
        )
      )
      if (job.status === "done") {
        if (job.type === "compress") toast.success("压缩完成")
        else if (job.type === "download") toast.success("下载完成")
        else toast.success(job.count !== undefined ? `已解压 ${job.count} 个文件` : "解压完成")
      } else if (job.status === "error") {
        const labels: Record<string, string> = { compress: "压缩失败", extract: "解压失败", download: "下载失败" }
        toast.error(labels[job.type] || "操作失败", { description: job.error })
      }
      for (const fn of listeners.current) fn(job)
    },
    []
  )

  const pollUntilDone = React.useCallback(
    (uiId: string, serverJobId: string, type: OpType, label: string, onDone: (count?: number) => void) => {
      const getStatus = type === "compress" ? compressJobStatus : type === "extract" ? extractJobStatus : downloadUrlJobStatus
      const apply = async (first = false) => {
        if (first && !timers.current.has(serverJobId)) return
        try {
          const s = await getStatus(serverJobId)
          if (s.state === "done") {
            stopPolling(serverJobId)
            uiToServer.current.delete(uiId)
            finish({ id: uiId, type, label, percent: 100, status: "done", count: s.count })
            onDone(s.count)
          } else if (s.state === "error" || s.state === "gone") {
            stopPolling(serverJobId)
            uiToServer.current.delete(uiId)
            finish({ id: uiId, type, label, percent: s.percent, status: "error", error: s.error || (s.state === "gone" ? "任务已过期，请重试" : undefined) })
          } else {
            patch(uiId, { percent: s.percent })
          }
        } catch (err) {
          stopPolling(serverJobId)
          uiToServer.current.delete(uiId)
          finish({ id: uiId, type, label, percent: 0, status: "error", error: (err as Error).message })
        }
      }
      uiToServer.current.set(uiId, serverJobId)
      timers.current.set(serverJobId, window.setInterval(() => void apply(), POLL_MS))
      void apply(true)
    },
    [finish, patch, stopPolling]
  )

  const startCompress = React.useCallback(
    (paths: string[]) => {
      if (!paths.length) return
      const id = uid()
      const label = paths.length === 1 ? `${paths[0].split("/").pop()} (Zip)` : `打包 ${paths.length} 项`
      setJobs((prev) => [{ id, type: "compress", label, percent: 0, status: "running" }, ...prev.slice(0, 9)])
      void startCompressJob(paths)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "compress", label, () => {}) })
        .catch((err) => { finish({ id, type: "compress", label, percent: 0, status: "error", error: (err as Error).message }) })
    },
    [finish, pollUntilDone]
  )

  const startExtract = React.useCallback(
    (path: string, dest: string) => {
      const id = uid()
      const label = `${path.split("/").pop()} 解压`
      setJobs((prev) => [{ id, type: "extract", label, percent: 0, status: "running" }, ...prev.slice(0, 9)])
      void startExtractJob(path, dest)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "extract", label, () => {}) })
        .catch((err) => { finish({ id, type: "extract", label, percent: 0, status: "error", error: (err as Error).message }) })
    },
    [finish, pollUntilDone]
  )

  const startDownloadUrl = React.useCallback(
    (url: string, dest: string, filename?: string) => {
      const id = uid()
      const label = filename || url.split("/").pop()?.split("?")[0] || "远程文件"
      setJobs((prev) => [{ id, type: "download", label, percent: 0, status: "running" }, ...prev.slice(0, 9)])
      void startDownloadUrlJob(url, dest, filename)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "download", label, () => {}) })
        .catch((err) => { finish({ id, type: "download", label, percent: 0, status: "error", error: (err as Error).message }) })
    },
    [finish, pollUntilDone]
  )

  const dismiss = React.useCallback((id: string) => {
    const serverId = uiToServer.current.get(id)
    if (serverId) {
      stopPolling(serverId)
      uiToServer.current.delete(id)
    }
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }, [stopPolling])

  React.useEffect(() => {
    const t = timers.current
    const map = uiToServer.current
    return () => {
      for (const timer of t.values()) window.clearInterval(timer)
      map.clear()
    }
  }, [])

  const clearFinished = React.useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status === "running"))
  }, [])

  const onCompleted = React.useCallback((listener: (job: OpJob) => void) => {
    listeners.current.add(listener)
    return () => listeners.current.delete(listener)
  }, [])

  const value = React.useMemo(
    () => ({ jobs, startCompress, startExtract, startDownloadUrl, dismiss, clearFinished, onCompleted }),
    [jobs, startCompress, startExtract, startDownloadUrl, dismiss, clearFinished, onCompleted]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOperations() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useOperations must be used within OperationsProvider")
  return ctx
}
