import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Icon } from "@/components/icon"
import { cn } from "@/lib/utils"
import { useOperations } from "@/state/operations"
import { useUploads } from "@/state/uploads"

export function OpsPanel() {
  const { jobs, dismiss, clearFinished } = useOperations()
  const { jobs: uploadJobs } = useUploads()
  const active = jobs.filter((j) => j.status === "running").length
  if (!jobs.length) return null
  const hasUploads = uploadJobs.length > 0

  return (
    <div
      className={cn(
        "edge-highlight fixed right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card",
        hasUploads ? "bottom-40" : "bottom-4"
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">
          {active > 0 ? `正在处理 ${active} 项` : "处理完成"}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="清除已完成" onClick={clearFinished}>
          <Icon name="x" />
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto p-2">
        {jobs.map((job) => (
          <div key={job.id} className="rounded-md px-2 py-1.5 hover:bg-muted/60">
            <div className="flex items-center gap-2">
              <Icon
                name={
                  job.status === "done"
                    ? "circle-check"
                    : job.status === "error"
                      ? "circle-alert"
                      : "loader-2"
                }
                className={cn(
                  "size-3.5 shrink-0",
                  job.status === "running" && "animate-spin text-muted-foreground",
                  job.status === "done" && "text-foreground",
                  job.status === "error" && "text-destructive"
                )}
              />
              <span className="flex-1 truncate text-xs">{job.label}</span>
              <Button variant="ghost" size="icon-xs" onClick={() => dismiss(job.id)}>
                <Icon name="x" />
              </Button>
            </div>
            {job.status === "running" && (
              <div className="mt-1 flex items-center gap-2">
                <Progress value={job.percent} className="h-1" />
                <span className="w-9 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                  {job.percent}%
                </span>
              </div>
            )}
            {job.error && job.status === "error" && (
              <p className="mt-0.5 line-clamp-2 text-[10px] text-destructive">{job.error}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
