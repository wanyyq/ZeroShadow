import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Icon } from "@/components/icon"
import { formatBytes } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useOperations } from "@/state/operations"
import { useUploads } from "@/state/uploads"
import type { OpJob } from "@/state/operations"
import type { UploadJob } from "@/state/uploads"

type TaskEntry = { kind: "upload"; job: UploadJob } | { kind: "op"; job: OpJob }

/**
 * 「文件任务」右侧折叠栏（v1.2.2）。
 *
 * 把原先右下角两个互不相干的浮层（UploadPanel / OpsPanel）合并成一个：
 *   - 上传、压缩、解压、链接下载都在同一个列表里，按类型分组；
 *   - 默认完全隐藏，由浏览器页的「文件任务」按钮控制；
 *   - 有新任务进入时由浏览器页自动打开（见 BrowserPage 的 taskTotal effect）。
 */
export function FileTasksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const uploads = useUploads()
  const ops = useOperations()

  const total = uploads.jobs.length + ops.jobs.length
  const active =
    uploads.jobs.filter((j) => j.status === "uploading").length +
    ops.jobs.filter((j) => j.status === "running").length

  const groups: { key: string; label: string; icon: string; jobs: TaskEntry[] }[] = [
    {
      key: "upload",
      label: t("ui.tasks.upload"),
      icon: "upload",
      jobs: uploads.jobs.map((job): TaskEntry => ({ kind: "upload", job })),
    },
    {
      key: "compress",
      label: t("ui.tasks.compress"),
      icon: "folder-archive",
      jobs: ops.jobs.filter((j) => j.type === "compress").map((job): TaskEntry => ({ kind: "op", job })),
    },
    {
      key: "extract",
      label: t("ui.tasks.extract"),
      icon: "folder-open",
      jobs: ops.jobs.filter((j) => j.type === "extract").map((job): TaskEntry => ({ kind: "op", job })),
    },
    {
      key: "convert",
      label: t("ui.tasks.convert"),
      icon: "file-output",
      jobs: ops.jobs.filter((j) => j.type === "convert").map((job): TaskEntry => ({ kind: "op", job })),
    },
    {
      key: "download",
      label: t("ui.tasks.download"),
      icon: "download",
      jobs: ops.jobs.filter((j) => j.type === "download").map((job): TaskEntry => ({ kind: "op", job })),
    },
  ].filter((group) => group.jobs.length > 0)

  const clearFinished = () => {
    uploads.clearFinished()
    ops.clearFinished()
  }

  return (
    <aside
      aria-label={t("ui.tasks.title")}
      aria-hidden={!open}
      inert={!open}
      data-state={open ? "open" : "closed"}
      className={cn(
        "file-tasks-panel fixed inset-y-0 right-0 z-40 flex w-80 max-w-[100vw] flex-col border-l border-border bg-card shadow-2xl",
        "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none",
        open ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="list-checks" className="size-4 shrink-0" />
          <span className="truncate text-sm font-medium">{t("ui.tasks.title")}</span>
          {active > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground tabular-nums">
              {active}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("ui.progress.clear_finished")}
            title={t("ui.progress.clear_finished")}
            onClick={clearFinished}
            disabled={total === 0}
          >
            <Icon name="eraser" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label={t("ui.common.close")} title={t("ui.common.close")} onClick={onClose}>
            <Icon name="x" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {total === 0 ? (
          <p className="px-2 py-10 text-center text-xs text-muted-foreground">{t("ui.tasks.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {groups.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <h3 className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                  <Icon name={group.icon} className="size-3" />
                  {group.label}
                  <span className="tabular-nums opacity-70">{group.jobs.length}</span>
                </h3>
                <div className="grid gap-1">
                  {group.jobs.map(({ kind, job }) =>
                    kind === "upload" ? (
                      <UploadTaskRow
                        key={job.id}
                        job={job}
                        onCancel={() => uploads.cancel(job.id)}
                        onDismiss={() => uploads.dismiss(job.id)}
                      />
                    ) : (
                      <OpTaskRow key={job.id} job={job} onDismiss={() => ops.dismiss(job.id)} />
                    )
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function UploadTaskRow({
  job,
  onCancel,
  onDismiss,
}: {
  job: UploadJob
  onCancel: () => void
  onDismiss: () => void
}) {
  const t = useT()
  const pct = job.totalBytes ? Math.min(100, (job.loaded / job.totalBytes) * 100) : 0
  const running = job.status === "uploading"
  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-muted/60">
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
            running && "animate-spin text-muted-foreground",
            job.status === "done" && "text-foreground",
            job.status === "error" && "text-destructive",
            job.status === "cancelled" && "text-muted-foreground"
          )}
        />
        <span className="flex-1 truncate text-xs" title={job.label}>
          {job.label}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={running ? t("ui.common.cancel") : t("ui.common.close")}
          onClick={running ? onCancel : onDismiss}
        >
          <Icon name="x" />
        </Button>
      </div>
      {running && (
        <div className="mt-1 flex items-center gap-2">
          <Progress value={pct} className="h-1" />
          <span className="w-24 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
            {formatBytes(job.loaded)}/{formatBytes(job.totalBytes)}
          </span>
        </div>
      )}
      {job.error && job.status === "error" && (
        <p className="mt-0.5 line-clamp-2 text-[10px] text-destructive">{job.error}</p>
      )}
    </div>
  )
}

function OpTaskRow({
  job,
  onDismiss,
}: {
  job: OpJob
  onDismiss: () => void
}) {
  const t = useT()
  const running = job.status === "running"
  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-muted/60">
      <div className="flex items-center gap-2">
        <Icon
          name={job.status === "done" ? "circle-check" : job.status === "error" ? "circle-alert" : "loader-2"}
          className={cn(
            "size-3.5 shrink-0",
            running && "animate-spin text-muted-foreground",
            job.status === "done" && "text-foreground",
            job.status === "error" && "text-destructive"
          )}
        />
        <span className="flex-1 truncate text-xs" title={job.label}>
          {job.label}
        </span>
        {!running && (
          <Button variant="ghost" size="icon-xs" aria-label={t("ui.common.close")} onClick={onDismiss}>
            <Icon name="x" />
          </Button>
        )}
      </div>
      {running && (
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
  )
}
