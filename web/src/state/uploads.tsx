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
      const task = uploadFiles(destPath, files, (loaded) => patch(id, { loaded }), options)
      setJobs((prev) => [
        { id, destPath, label, totalBytes, loaded: 0, status: "uploading", abort: task.abort },
        ...prev.slice(0, 19),
      ])
      task.promise
        .then((raw) => {
          const result = raw as UploadResult
          const failed = result.results.filter((r) => !r.ok)
          patch(id, { status: "done", loaded: totalBytes })
          if (failed.length) {
            patch(id, { status: "error", error: failed.map((f) => `${f.name}: ${f.error}`).join("；") })
            toast.error(`部分文件未上传成功`, {
              description: failed.map((f) => `${f.name}：${f.error}`).join("\n"),
            })
          }
          const okCount = result.results.length - failed.length
          if (okCount > 0) toast.success(`已上传 ${okCount} 个文件`)
          for (const fn of listeners.current) fn(destPath)
        })
        .catch((err: Error) => {
          const cancelled = err.message.includes("取消")
          patch(id, { status: cancelled ? "cancelled" : "error", error: err.message })
          if (!cancelled) toast.error("上传失败", { description: err.message })
        })
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
