/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { toast } from "sonner"
import { uploadFiles } from "@/lib/api"
import { uid } from "@/lib/format"
import type { UploadResult } from "@/lib/types"
import type { UploadOptions } from "@/lib/api"

export interface UploadJob {
  id: string
  destPath: string
  label: string
  totalBytes: number
  loaded: number
  status: "uploading" | "done" | "error" | "cancelled"
  error?: string
  abort?: () => void
}

interface UploadsState {
  jobs: UploadJob[]
  start: (destPath: string, files: File[], options?: UploadOptions) => void
  cancel: (id: string) => void
  dismiss: (id: string) => void
  clearFinished: () => void
  onCompleted: (listener: (destPath: string) => void) => () => void
}

const Ctx = React.createContext<UploadsState | undefined>(undefined)

// 与 server/src/routes/fs.js 的 MAX_FILES_PER_REQUEST 保持一致：服务端用 busboy 的
// files 限制，超出部分会被直接跳过且只发一次 filesLimit 事件。前端按这个值分片，
// 才不会出现「选了 300 个文件、只上传 100 个、还提示全部成功」。
const MAX_FILES_PER_REQUEST = 100

export function UploadsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = React.useState<UploadJob[]>([])
  const listeners = React.useRef(new Set<(destPath: string) => void>())

  const patch = React.useCallback((id: string, partial: Partial<UploadJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...partial } : j)))
  }, [])

  const start = React.useCallback(
    (destPath: string, files: File[], options?: UploadOptions) => {
      if (!files.length) return
      const id = uid()
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      const label =
        files.length === 1 ? files[0].name : `${files[0].name} 等 ${files.length} 个文件`

      const batches: File[][] = []
      for (let i = 0; i < files.length; i += MAX_FILES_PER_REQUEST) {
        batches.push(files.slice(i, i + MAX_FILES_PER_REQUEST))
      }

      let aborted = false
      let currentAbort: (() => void) | null = null
      const abort = () => { aborted = true; currentAbort?.() }

      setJobs((prev) => {
        // 只淘汰已结束的任务：旧实现直接 slice(0,19) 会把仍在传输的那条挤出面板，
        // 于是它既看不到进度、也再点不到取消（abort 句柄已经丢了）。
        const keep = prev.filter((j) => j.status === "uploading")
        const next: UploadJob = { id, destPath, label, totalBytes, loaded: 0, status: "uploading", abort }
        return [next, ...keep].slice(0, 20)
      })

      void (async () => {
        const results: UploadResult["results"] = []
        let truncated = false
        let doneBytes = 0
        try {
          for (const batch of batches) {
            if (aborted) throw new Error("已取消上传")
            const batchBytes = batch.reduce((sum, f) => sum + f.size, 0)
            const base = doneBytes
            const task = uploadFiles(destPath, batch, (loaded) => patch(id, { loaded: base + loaded }), options)
            currentAbort = task.abort
            const raw = (await task.promise) as UploadResult
            results.push(...raw.results)
            if (raw.truncated) truncated = true
            doneBytes += batchBytes
            patch(id, { loaded: doneBytes })
          }

          const failed = results.filter((r) => !r.ok)
          const okCount = results.length - failed.length
          if (failed.length) {
            // 部分失败只发一条汇总提示：旧实现先报错再无条件报成功，
            // 两条 toast 同时出现，用户根本分不清到底成功几个。
            patch(id, {
              status: "error",
              loaded: totalBytes,
              error: failed.map((f) => `${f.name}: ${f.error}`).join("；"),
            })
            toast.error(okCount > 0 ? `已上传 ${okCount} 个，${failed.length} 个失败` : "上传失败", {
              description: failed.map((f) => `${f.name}：${f.error}`).join("\n"),
            })
          } else {
            patch(id, { status: "done", loaded: totalBytes })
            toast.success(`已上传 ${okCount} 个文件`)
          }
          if (truncated) {
            toast.warning(`单次最多上传 ${MAX_FILES_PER_REQUEST} 个文件，超出部分未处理`, {
              description: "请分批再次上传剩余文件",
            })
          }
          for (const fn of listeners.current) fn(destPath)
        } catch (err) {
          const message = (err as Error).message
          const cancelled = message.includes("取消")
          patch(id, { status: cancelled ? "cancelled" : "error", error: message })
          if (!cancelled) toast.error("上传失败", { description: message })
        }
      })()
    },
    [patch]
  )

  const cancel = React.useCallback(
    (id: string) => {
      setJobs((prev) => {
        prev.find((j) => j.id === id)?.abort?.()
        return prev
      })
    },
    []
  )

  const dismiss = React.useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }, [])

  const clearFinished = React.useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status === "uploading"))
  }, [])

  const onCompleted = React.useCallback((listener: (destPath: string) => void) => {
    listeners.current.add(listener)
    return () => listeners.current.delete(listener)
  }, [])

  const value = React.useMemo(
    () => ({ jobs, start, cancel, dismiss, clearFinished, onCompleted }),
    [jobs, start, cancel, dismiss, clearFinished, onCompleted]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useUploads() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useUploads must be used within UploadsProvider")
  return ctx
}
