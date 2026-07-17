import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Icon } from "@/components/icon"
import { formatBytes } from "@/lib/format"
import { useUploads } from "@/state/uploads"
import { cn } from "@/lib/utils"

export function UploadPanel() {
  const { jobs, cancel, dismiss, clearFinished } = useUploads()
  if (!jobs.length) return null
  const active = jobs.filter((j) => j.status === "uploading").length

  return (
    <div className="edge-highlight fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">
          {active > 0 ? `正在上传 ${active} 项` : "上传完成"}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="清除已完成" onClick={clearFinished}>
          <Icon name="x" />
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto p-2">
        {jobs.map((job) => {
          const pct = job.totalBytes ? Math.min(100, (job.loaded / job.totalBytes) * 100) : 0
          return (
            <div key={job.id} className="rounded-md px-2 py-1.5 hover:bg-muted/60">
              <div className="flex items-center gap-2">
                <Icon
                  name={
                    job.status === "done"
                      ? "circle-check"
                      : job.status === "error"
                        ? "circle-alert"
                        : job.status === "cancelled"
                          ? "circle-slash"
                          : "loader-2"
                  }
                  className={cn(
                    "size-3.5 shrink-0",
                    job.status === "uploading" && "animate-spin text-muted-foreground",
                    job.status === "done" && "text-foreground",
                    job.status === "error" && "text-destructive",
                    job.status === "cancelled" && "text-muted-foreground"
                  )}
                />
                <span className="flex-1 truncate text-xs">{job.label}</span>
                {job.status === "uploading" ? (
                  <Button variant="ghost" size="icon-xs" onClick={() => cancel(job.id)}>
                    <Icon name="x" />
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon-xs" onClick={() => dismiss(job.id)}>
                    <Icon name="x" />
                  </Button>
                )}
              </div>
              {job.status === "uploading" && (
                <div className="mt-1 flex items-center gap-2">
                  <Progress value={pct} className="h-1" />
                  <span className="w-20 text-right text-[10px] text-muted-foreground">
                    {formatBytes(job.loaded)}/{formatBytes(job.totalBytes)}
                  </span>
                </div>
              )}
              {job.error && job.status === "error" && (
                <p className="mt-0.5 line-clamp-2 text-[10px] text-destructive">{job.error}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
