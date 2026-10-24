/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { toast } from "sonner"
import { compressJobStatus, convertJobStatus, downloadUrlJobStatus, extractJobStatus, startCompressJob, startConvertJob, startDownloadUrlJob, startExtractJob } from "@/lib/api"
import { uid } from "@/lib/format"
import { useT } from "@/lib/i18n"
import type { OpType } from "@/lib/types"

export interface OpJob {
  id: string
  type: OpType
  label: string
  percent: number
  status: "running" | "done" | "error"
  error?: string
  count?: number
  /** 服务端给的补充说明（转换时可能是"字体缺字"这类提醒） */
  notes?: string[]
  /** 产出物的相对路径（转换成功时给出，便于提示"已生成 xxx"） */
  output?: string | null
}

interface OpsState {
  jobs: OpJob[]
  startCompress: (paths: string[]) => void
  startExtract: (path: string, dest: string) => void
  startDownloadUrl: (url: string, dest: string, filename?: string) => void
  startConvert: (path: string, target: string, label: string) => void
  dismiss: (id: string) => void
  clearFinished: () => void
  onCompleted: (listener: (job: OpJob) => void) => () => void
}

const Ctx = React.createContext<OpsState | undefined>(undefined)

const POLL_MS = 400

export function OperationsProvider({ children }: { children: React.ReactNode }) {
  const t = useT()
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

  /** 按 uiId 停掉它对应的轮询（成功、失败、被移除三条路径都走这里） */
  const stopByUiId = React.useCallback(
    (uiId: string) => {
      const serverId = uiToServer.current.get(uiId)
      if (serverId) {
        stopPolling(serverId)
        uiToServer.current.delete(uiId)
      }
    },
    [stopPolling]
  )

  const patch = React.useCallback((id: string, partial: Partial<OpJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...partial } : j)))
  }, [])

  /**
   * 加入一条新任务。
   * 只保留**仍在跑**的旧任务：旧实现是 `prev.slice(0, 9)`，会把还在轮询的任务
   * 挤出面板，而它的 interval 还在跑、还会继续弹 toast，界面上却再也看不到它。
   * 被移除条目的轮询由下面的 effect 统一回收（updater 必须保持纯函数）。
   */
  const pushJob = React.useCallback((job: OpJob) => {
    setJobs((prev) => [job, ...prev.filter((j) => j.status === "running").slice(0, 19)])
  }, [])

  /**
   * 轮询生命周期对齐：只让"仍在列表里的 running 任务"持有 interval。
   *
   * 旧实现只在 done / error / gone / dismiss 时停表，一旦任务被挤出列表
   * （或 start 请求本身失败）interval 就变成孤儿，继续对已不在界面上的
   * uiId 调 patch / finish —— 于是出现"任务看不见，却还在弹完成/失败提示"。
   * 这里做一次幂等对账，任何移除路径都自动生效。
   */
  React.useEffect(() => {
    const active = new Set<string>()
    for (const job of jobs) {
      if (job.status === "running") active.add(job.id)
    }
    for (const uiId of Array.from(uiToServer.current.keys())) {
      if (!active.has(uiId)) stopByUiId(uiId)
    }
  }, [jobs, stopByUiId])

  const finish = React.useCallback(
    (job: OpJob) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id
            ? {
                ...j,
                status: job.status,
                percent: job.percent,
                error: job.error,
                count: job.count,
                notes: job.notes,
                output: job.output,
              }
            : j
        )
      )
      if (job.status === "done") {
        if (job.type === "compress") toast.success(t("ui.operations.compress_done"))
        else if (job.type === "download") toast.success(t("ui.operations.download_done"))
        else if (job.type === "convert") {
          // 转换成功的提示带上产物名；服务端给了提示（例如字体缺字）就作为副标题展示
          const name = job.output ? String(job.output).split("/").pop() : undefined
          const text = name
            ? t("ui.operations.convert_done_named", { name })
            : t("ui.operations.convert_done")
          if (job.notes?.length) {
            // 产物有瑕疵（缺字 / 截断）时用 warning 而不是 success，避免"看起来一切正常"
            toast.warning(text, { description: job.notes.join("；") })
          } else {
            toast.success(text)
          }
        } else {
          toast.success(
            job.count !== undefined
              ? t("ui.operations.extract_done_count", { count: job.count })
              : t("ui.operations.extract_done")
          )
        }
      } else if (job.status === "error") {
        // 键（compress/extract/download/convert）是代码值，只有文案取自字典
        const labels: Record<string, string> = {
          compress: t("ui.operations.compress_failed"),
          extract: t("ui.operations.extract_failed"),
          download: t("ui.operations.download_failed"),
          convert: t("ui.operations.convert_failed"),
        }
        toast.error(labels[job.type] || t("ui.common.operation_failed"), { description: job.error })
      }
      for (const fn of listeners.current) fn(job)
    },
    [t]
  )

  const pollUntilDone = React.useCallback(
    (uiId: string, serverJobId: string, type: OpType, label: string, onDone: (count?: number) => void) => {
      const getStatus =
        type === "compress"
          ? compressJobStatus
          : type === "extract"
            ? extractJobStatus
            : type === "convert"
              ? convertJobStatus
              : downloadUrlJobStatus
      const apply = async (first = false) => {
        if (first && !timers.current.has(serverJobId)) return
        try {
          const s = await getStatus(serverJobId)
          if (s.state === "done") {
            stopPolling(serverJobId)
            uiToServer.current.delete(uiId)
            finish({
              id: uiId,
              type,
              label,
              percent: 100,
              status: "done",
              count: s.count,
              notes: s.notes,
              output: s.output,
            })
            onDone(s.count)
          } else if (s.state === "error" || s.state === "gone") {
            stopPolling(serverJobId)
            uiToServer.current.delete(uiId)
            finish({ id: uiId, type, label, percent: s.percent, status: "error", error: s.error || (s.state === "gone" ? t("ui.operations.job_expired") : undefined) })
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
    [finish, patch, stopPolling, t]
  )

  const startCompress = React.useCallback(
    (paths: string[]) => {
      if (!paths.length) return
      const id = uid()
      const label = paths.length === 1 ? `${paths[0].split("/").pop()} (Zip)` : t("ui.operations.compress_label_batch", { count: paths.length })
      pushJob({ id, type: "compress", label, percent: 0, status: "running" })
      void startCompressJob(paths)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "compress", label, () => {}) })
        .catch((err) => {
          // 任务根本没建起来：不会有轮询，但要把维护态里的映射清掉
          stopByUiId(id)
          finish({ id, type: "compress", label, percent: 0, status: "error", error: (err as Error).message })
        })
    },
    [finish, pollUntilDone, pushJob, stopByUiId, t]
  )

  const startExtract = React.useCallback(
    (path: string, dest: string) => {
      const id = uid()
      const label = t("ui.operations.extract_label", { name: path.split("/").pop() ?? "" })
      pushJob({ id, type: "extract", label, percent: 0, status: "running" })
      void startExtractJob(path, dest)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "extract", label, () => {}) })
        .catch((err) => {
          stopByUiId(id)
          finish({ id, type: "extract", label, percent: 0, status: "error", error: (err as Error).message })
        })
    },
    [finish, pollUntilDone, pushJob, stopByUiId, t]
  )

  const startDownloadUrl = React.useCallback(
    (url: string, dest: string, filename?: string) => {
      const id = uid()
      const label = filename || url.split("/").pop()?.split("?")[0] || t("ui.operations.remote_file")
      pushJob({ id, type: "download", label, percent: 0, status: "running" })
      void startDownloadUrlJob(url, dest, filename)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "download", label, () => {}) })
        .catch((err) => {
          stopByUiId(id)
          finish({ id, type: "download", label, percent: 0, status: "error", error: (err as Error).message })
        })
    },
    [finish, pollUntilDone, pushJob, stopByUiId, t]
  )

  /**
   * 文件转换：一条任务对应一次转换。
   * label 由调用方给（形如 `note.md → .pdf`），这样面板里能一眼看出转了哪个文件。
   */
  const startConvert = React.useCallback(
    (path: string, target: string, label: string) => {
      const id = uid()
      pushJob({ id, type: "convert", label, percent: 0, status: "running" })
      void startConvertJob(path, target)
        .then(({ jobId }) => { pollUntilDone(id, jobId, "convert", label, () => {}) })
        .catch((err) => {
          stopByUiId(id)
          finish({ id, type: "convert", label, percent: 0, status: "error", error: (err as Error).message })
        })
    },
    [finish, pollUntilDone, pushJob, stopByUiId]
  )

  const dismiss = React.useCallback(
    (id: string) => {
      stopByUiId(id)
      setJobs((prev) => prev.filter((j) => j.id !== id))
    },
    [stopByUiId]
  )

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
    () => ({ jobs, startCompress, startExtract, startDownloadUrl, startConvert, dismiss, clearFinished, onCompleted }),
    [jobs, startCompress, startExtract, startDownloadUrl, startConvert, dismiss, clearFinished, onCompleted]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOperations() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useOperations must be used within OperationsProvider")
  return ctx
}
