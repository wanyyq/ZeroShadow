import * as React from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Icon } from "@/components/icon"
import { useConfirm } from "@/components/confirm-dialog"
import { getErrorMessage } from "@/lib/api"
import { api, emptyTrash, fetchTrash, purgeTrash, restoreTrash } from "@/lib/api"
import type { AdminConfig, TrashResponse } from "@/lib/types"
import { formatBytes } from "@/lib/format"
/**
 * 回收站。
 *
 * 服务端的删除已经改为"移入回收站"，但**回收站的浏览与还原刻意只对超管开放**
 * （见 server/src/routes/admin.js 里的说明）：成员照常能删，但暂存区里的内容
 * 由超管统一管理，权限面更小，也避免成员之间互相看到对方删掉的文件。
 */
export function TrashSection() {
  const [data, setData] = React.useState<TrashResponse | null>(null)
  const [config, setConfig] = React.useState<AdminConfig | null>(null)
  const [retention, setRetention] = React.useState("")
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const confirm = useConfirm()

  const load = React.useCallback(() => {
    fetchTrash()
      .then((d) => {
        setData(d)
        setRetention(String(d.retentionDays ?? 30))
      })
      .catch((e) => toast.error(getErrorMessage(e)))
    api.get<AdminConfig>("/admin/config").then(setConfig).catch(() => {})
  }, [])
  React.useEffect(load, [load])

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch<AdminConfig>("/admin/config", body)
      toast.success(msg)
      load()
    } catch (e) {
      toast.error(getErrorMessage(e))
    }
  }

  // confirm() 返回的是"用户点完确认之后的 promise"，所以要 await 它，
  // busy 标记才有意义。旧实现 set→doRestore→set(null) 全在同一 tick，
  // disabled 永远不生效（连点会弹出两个确认框）。
  const runBusy = async (id: string, fn: () => Promise<void> | void) => {
    setBusyId(id)
    try {
      await fn()
    } finally {
      setBusyId(null)
    }
  }

  const doRestore = (id: string, rel: string) =>
    runBusy(id, () =>
      confirm({
        title: `还原「${rel}」？`,
        description: "内容会回到原来的位置。如果那个位置已经有了同名项目，还原会被拒绝，需要你先处理冲突。",
        confirmText: "还原",
        destructive: false,
        onConfirm: async () => {
          await restoreTrash(id)
          toast.success("已还原")
          load()
        },
      }).then(() => undefined)
    )

  /** 还原遇到同名冲突：让用户选择覆盖 */
  const doRestoreOverwrite = (id: string, rel: string) =>
    runBusy(id, () =>
      confirm({
        title: `用回收站里的版本覆盖「${rel}」？`,
        description: "当前位置上已有的同名项目会被删除，且此操作不可撤销。",
        confirmText: "覆盖还原",
        onConfirm: async () => {
          await restoreTrash(id, undefined, true)
          toast.success("已覆盖还原")
          load()
        },
      }).then(() => undefined)
    )

  const doPurge = (id: string, rel: string) =>
    runBusy(id, () =>
      confirm({
        title: `彻底删除「${rel}」？`,
        description: "内容会被永久删除，无法再还原。",
        confirmText: "彻底删除",
        onConfirm: async () => {
          await purgeTrash(id)
          toast.success("已彻底删除")
          load()
        },
      }).then(() => undefined)
    )

  const doEmpty = () => {
    void confirm({
      title: "清空回收站？",
      description: `回收站里的 ${data?.stats.count ?? 0} 个项目会被永久删除，无法还原。`,
      confirmText: "清空",
      onConfirm: async () => {
        const r = await emptyTrash()
        toast.success(`已清空 ${r.removed} 项`)
        load()
      },
    })
  }

  const items = data?.items || []
  const stats = data?.stats

  return (
    <div className="grid gap-5">
      {data && data.enabled && !data.available && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          回收站目录当前不可用（例如 data/ 只读或磁盘已满），因此<strong>删除会直接生效、不进入回收站</strong>。
          请检查服务端 data/ 目录的写权限。
        </div>
      )}

      <Card className="edge-highlight">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>回收站</CardTitle>
              <CardDescription>
                删除的项目会先放在这里，超过保留期自动清理
                {stats ? `；当前 ${stats.count} 项 · 占用 ${formatBytes(stats.bytes)}` : ""}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">保留</span>
                <Input
                  className="h-8 w-16 text-right"
                  inputMode="numeric"
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">天</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => patch({ trashRetentionDays: Number(retention) }, "保留天数已更新")}
                >
                  保存
                </Button>
              </div>
              <Button size="sm" variant="outline" onClick={load}>
                <Icon name="refresh-cw" /> 刷新
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" disabled={!items.length} onClick={doEmpty}>
                <Icon name="trash-2" /> 清空回收站
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {config && (
            <label className="flex cursor-pointer items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span>
                <span className="block text-sm font-medium">删除时移入回收站</span>
                <span className="block text-xs text-muted-foreground">
                  关闭后删除立即生效、不再保留副本
                </span>
              </span>
              <input
                type="checkbox"
                className="size-4"
                checked={config.trashEnabled !== false}
                onChange={(e) => patch({ trashEnabled: e.target.checked }, e.target.checked ? "已启用回收站" : "已关闭回收站")}
              />
            </label>
          )}
          <Separator />
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">回收站是空的</p>
          ) : (
            <ScrollArea className="h-80 rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>原位置</TableHead>
                    <TableHead className="w-24 text-right">大小</TableHead>
                    <TableHead className="w-40">删除时间</TableHead>
                    <TableHead className="w-24">删除者</TableHead>
                    <TableHead className="w-44 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="max-w-56 truncate font-medium" title={it.name}>
                        <Icon name={it.type === "dir" ? "folder" : "file"} className="mr-1.5 inline size-3.5 text-muted-foreground" />
                        {it.name}
                      </TableCell>
                      <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={it.rel}>
                        /{it.rel}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {it.size < 0 ? "目录" : formatBytes(it.size)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{it.deletedAt.replace("T", " ").slice(0, 19)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {it.deletedBy || "—"}
                        {it.deletedByRole === "superadmin" && <Badge variant="secondary" className="ml-1 text-[10px]">超管</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyId === it.id}
                          onClick={() => { void doRestore(it.id, it.rel) }}
                        >
                          还原
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-1"
                          title="同名冲突时用回收站里的版本覆盖"
                          disabled={busyId === it.id}
                          onClick={() => { void doRestoreOverwrite(it.id, it.rel) }}
                        >
                          覆盖还原
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-1 text-destructive"
                          disabled={busyId === it.id}
                          onClick={() => { void doPurge(it.id, it.rel) }}
                        >
                          彻底删除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
          <p className="text-xs text-muted-foreground">
            「还原」会放回原位置；若该位置已有同名项目，请先用「覆盖还原」或先改名/删除冲突项。
            超过保留期的项目会在服务启动或每 6 小时的维护任务中被自动清理。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
