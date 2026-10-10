import * as React from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Icon } from "@/components/icon"
import { api, downloadUrl } from "@/lib/api"
import { fileKind, formatBytes, formatDate, joinPath, previewType } from "@/lib/format"
import type { Entry, EntryDetails, EntryStat } from "@/lib/types"
import { toast } from "sonner"
import { detectConflicts } from "@/lib/conflict"
import { CONFLICT_CANCELLED, isCaseInsensitive } from "@/lib/conflict"
import type { ConflictResolution } from "@/lib/conflict"
import { ConflictDialog } from "@/components/browser/conflict-dialog"

export function NewFolderDialog({
  open,
  onOpenChange,
  path,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string
  onDone: () => void
}) {
  const [name, setName] = React.useState("新建文件夹")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setName("新建文件夹")
  }, [open])

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await api.post("/fs/mkdir", { path, name: name.trim() })
      toast.success("文件夹已创建")
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建文件夹</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="folder-name">名称</Label>
          <Input
            id="folder-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />} 创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RenameDialog({
  open,
  onOpenChange,
  entry,
  path,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: Entry | null
  path: string
  onDone: () => void
}) {
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [conflictOpen, setConflictOpen] = React.useState(false)
  const [conflictNames, setConflictNames] = React.useState<string[]>([])
  const [conflictExisting, setConflictExisting] = React.useState<Set<string>>(new Set())
  const [conflictDirs, setConflictDirs] = React.useState<Set<string>>(new Set())
  const conflictResolveRef = React.useRef<((items: ConflictResolution) => void) | null>(null)

  React.useEffect(() => {
    if (open && entry) setName(entry.shortcut?.displayName || entry.name)
  }, [open, entry])

  const submit = async () => {
    if (!entry || !name.trim() || busy) return
    setBusy(true)
    let newName = name.trim()
    if (entry.type === "shortcut" && !newName.toLowerCase().endsWith(".zeropath")) {
      newName = newName + ".zeropath"
    }
    try {
      const parentPath = path
      const listData = await api.get<{ entries: Entry[] }>("/fs/list", { path: parentPath })
      const filtered = listData.entries.filter((e) => e.name.toLowerCase() !== entry.name.toLowerCase())
      const existingNames = filtered.map((e) => e.name)
      // 冲突判定必须与服务端同规则（Windows/macOS 不区分大小写）。这里原先用
      // 裸 === 比较，于是"仅改大小写的重命名"撞上已存在的同名目录时会被归类成
      // 文件冲突，并给出「覆盖 / 合并」这两个对文件无意义的选项。
      const ci = isCaseInsensitive()
      const same = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
      const isDirConflict = filtered.some((e) => same(e.name, newName) && e.type === "dir")
      const conflicts = detectConflicts([newName], new Set(existingNames))
      if (conflicts.length === 0) {
        await api.post("/fs/rename", { path: joinPath(path, entry.name), newName })
        toast.success("已重命名")
        onOpenChange(false)
        setBusy(false)
        onDone()
      } else {
        setConflictNames([newName])
        setConflictExisting(new Set(existingNames))
        setConflictDirs(isDirConflict ? new Set([newName]) : new Set())
        conflictResolveRef.current = async (items) => {
          // 取消：直接结束，不要再往下走
          if (items === CONFLICT_CANCELLED) { setBusy(false); return }
          const item = items[0]
          // 旧实现把「取消」当成空数组传进来，item 为 undefined，
          // 读 item.action 抛出的 TypeError 被 catch 成一条英文报错 toast
          if (!item) { setBusy(false); return }
          setBusy(true)
          try {
            if (item.action === "skip") {
              onOpenChange(false)
              setBusy(false)
              return
            }
            if (item.action === "overwrite") {
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName, overwrite: true })
              toast.success("已重命名（覆盖）")
              onOpenChange(false)
              onDone()
            } else if (item.action === "merge") {
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName, merge: true })
              toast.success("已重命名（合并）")
              onOpenChange(false)
              onDone()
            } else if (item.action === "rename" && item.resolvedName) {
              let resolved = item.resolvedName
              if (entry.type === "shortcut" && !resolved.toLowerCase().endsWith(".zeropath")) {
                resolved = resolved + ".zeropath"
              }
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName: resolved })
              toast.success("已重命名")
              onOpenChange(false)
              onDone()
            }
          } catch (err) { toast.error((err as Error).message) }
          finally { setBusy(false) }
        }
        setConflictOpen(true)
        setBusy(false)
      }
    } catch (err) {
      toast.error((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="rename-input">新名称</Label>
          <Input
            id="rename-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />} 确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConflictDialog
      open={conflictOpen}
      onOpenChange={(o) => { setConflictOpen(o); if (!o && conflictResolveRef.current) { conflictResolveRef.current(CONFLICT_CANCELLED); conflictResolveRef.current = null } }}
      conflicts={conflictNames}
      existingNames={conflictExisting}
      directoryNames={conflictDirs}
      onResolved={(items) => { conflictResolveRef.current?.(items); conflictResolveRef.current = null }}
    />
    </>
  )
}

export function DeleteDialog({
  open,
  onOpenChange,
  names,
  path,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  names: string[]
  path: string
  onDone: () => void
}) {
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.post<{
        deleted: number
        trashed: number
        permanentlyDeleted?: string[]
        failed?: { path: string; error: string }[]
      }>("/fs/delete", { paths: names.map((n) => joinPath(path, n)) })
      if (r.failed && r.failed.length) {
        // 回收站可用、但这些条目没能入站：服务端已经**保留原文件**并跳过删除。
        // 必须明确报错，否则用户会以为删掉了，而文件其实还在（旧实现是把它们
        // 直接彻底删除，静默销毁数据）。
        toast.error(`${r.failed.length} 项未能删除（原文件仍保留）`, {
          description: r.failed.map((f) => `${f.path}：${f.error}`).join("\n"),
        })
      } else if (r.permanentlyDeleted && r.permanentlyDeleted.length) {
        // 回收站没兜住（目录不可用等）：必须明确告知，不能让用户以为还能还原
        toast.warning(`已删除 ${names.length} 项，其中 ${r.permanentlyDeleted.length} 项未进入回收站`, {
          description: `以下项目已被彻底删除，无法还原：${r.permanentlyDeleted.join("、")}`,
        })
      } else if (r.trashed > 0) {
        toast.success(`已将 ${r.trashed} 项移入回收站`)
      } else {
        toast.success(`已删除 ${names.length} 项`)
      }
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除</AlertDialogTitle>
          <AlertDialogDescription>
            将把 {names.length === 1 ? `“${names[0]}”` : `选中的 ${names.length} 项`}
            移入<strong>回收站</strong>，可在「设置 → 回收站」里还原（管理员操作）。
            超过保留期或被清空后将无法恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {busy && <Icon name="loader-2" className="animate-spin" />} 删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 复制一行文本并给反馈（沿用模块内其它地方的 clipboard 兜底写法） */
function copyLine(text: string, label: string) {
  const clipboard = navigator.clipboard
  if (!clipboard?.writeText) {
    toast.error("当前环境不支持自动复制，请手动选择后复制")
    return
  }
  void clipboard.writeText(text).then(
    () => toast.success(`已复制${label}`),
    () => toast.error("复制失败，请手动选择文本")
  )
}

/** 详情里的一行：[标签, 值]，可带一个复制按钮 */
function DetailRow({
  label,
  value,
  copy,
}: {
  label: string
  value: React.ReactNode
  copy?: string
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-2">
      <span className="pt-0.5 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-start gap-1">
        <span className="min-w-0 break-all">{value}</span>
        {copy ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            title="复制"
            onClick={() => copyLine(copy, label)}
          >
            <Icon name="copy" />
          </Button>
        ) : null}
      </span>
    </div>
  )
}

/** 把 [标签, 值] 数组渲染成若干行（EXIF / 文档属性 / 媒体信息共用） */
function DetailPairs({ pairs }: { pairs: [string, string][] }) {
  return (
    <>
      {pairs.map(([label, value]) => (
        <DetailRow key={label} label={label} value={value} copy={value} />
      ))}
    </>
  )
}

export function DetailsDialog({
  open,
  onOpenChange,
  entryPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
}) {
  const [stat, setStat] = React.useState<EntryStat | null>(null)
  const [details, setDetails] = React.useState<EntryDetails | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [detailError, setDetailError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open || entryPath === null) return
    let alive = true
    setLoading(true)
    setStat(null)
    setDetails(null)
    setDetailError(null)
    api
      .get<EntryStat>("/fs/stat", { path: entryPath })
      .then((value) => {
        if (!alive) return
        setStat(value)
        setLoading(false)
        // 详情要真读文件（哈希、EXIF、文档属性），所以等基础字段先渲染出来再补；
        // 目录没有这些信息，也就不必发这个请求（服务端会回 400）
        if (value.type !== "file") return
        return api
          .get<EntryDetails>("/fs/details", { path: entryPath })
          .then((d) => {
            if (alive) setDetails(d)
          })
          .catch((err) => {
            if (alive) setDetailError((err as Error).message)
          })
      })
      .catch((err) => {
        if (!alive) return
        toast.error((err as Error).message)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, entryPath])

  const rows: [string, React.ReactNode][] = stat
    ? [
        ["名称", stat.name],
        ["类型", stat.type === "dir" ? "文件夹" : fileKind(stat.name, "file").label],
        ["位置", `/${stat.path.split("/").slice(0, -1).join("/")}`],
        ["大小", `${formatBytes(stat.size)}${stat.partial ? "（部分统计）" : ""}`],
        ...(stat.type === "dir"
          ? ([["包含", `${stat.files ?? 0} 个文件，${stat.dirs ?? 0} 个文件夹`]] as [
              string,
              React.ReactNode,
            ][])
          : []),
        ["修改时间", formatDate(stat.mtime)],
        ["创建时间", formatDate(stat.created)],
        ...(details
          ? ([
              ["访问时间", formatDate(details.timestamps.atime)],
              ["状态变更时间", formatDate(details.timestamps.ctime)],
            ] as [string, React.ReactNode][])
          : []),
        [
          "访客可见性",
          stat.hiddenFromGuest ? (
            <Badge variant="secondary">
              <Icon name="eye-off" className="size-3" /> 对访客隐藏
            </Badge>
          ) : (
            "可见"
          ),
        ],
        ...(details?.softReadOnly
          ? ([
              [
                "存储位置",
                <Badge variant="secondary" key="soft">
                  <Icon name="folder-lock" className="size-3" /> 外部映射目录（只读）
                </Badge>,
              ],
            ] as [string, React.ReactNode][])
          : []),
      ]
    : []

  const im = details?.image
  const tx = details?.text
  const summary = () =>
    [
      `名称：${stat?.name ?? ""}`,
      `路径：/${stat?.path ?? ""}`,
      `大小：${stat ? formatBytes(stat.size) : ""}`,
      `修改时间：${stat ? formatDate(stat.mtime) : ""}`,
      details?.magic ? `内容识别：${details.magic.label}${details.magic.mime ? ` (${details.magic.mime})` : ""}` : "",
      details?.magic?.signature ? `签名：${details.magic.signature}` : "",
      details?.hashes ? `MD5：${details.hashes.md5}` : "",
      details?.hashes ? `SHA-1：${details.hashes.sha1}` : "",
      details?.hashes ? `SHA-256：${details.hashes.sha256}` : "",
      im ? `尺寸：${im.width} × ${im.height}` : "",
      tx?.encodingLabel ? `文本编码：${tx.encodingLabel}${tx.bom ? "（带 BOM）" : ""}` : "",
      tx?.lines !== undefined ? `行数：${tx.lines}` : "",
    ]
      .filter(Boolean)
      .join("\n")

  const section = (title: string, body: React.ReactNode) =>
    body ? (
      <div className="grid gap-2">
        <div className="text-xs font-medium tracking-wide text-muted-foreground">{title}</div>
        {body}
      </div>
    ) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>详细信息</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="grid gap-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : stat ? (
          <div className="max-h-[65vh] overflow-y-auto pr-3">
            {/* 用原生 overflow 容器而不是 ScrollArea：对话框高度是内容撑开的
                （没有确定高度），而 ScrollArea 的 Viewport 是 size-full，
                百分比高度在自动高度父元素上会退化成内容高度 —— 超出的部分会
                被裁掉且没有滚动条 */}
            <div className="grid gap-5 text-sm">
              {section(
                "基本信息",
                rows.map(([label, value]) => (
                  <DetailRow key={label} label={label} value={value} />
                ))
              )}

              {/* 以下都是"读一遍文件才能拿到"的信息，只有文件才有（目录不显示这些分区） */}
              {stat.type === "file" ? (
                <>
                  {/* 扩展名可能与真实内容不符（把 .zip 改成 .png 之类），
                      这里显示的是按文件内容认出来的结果 */}
                  {section(
                    "内容识别",
                    details?.magic ? (
                      <>
                        <DetailRow label="识别结果" value={details.magic.label} copy={details.magic.label} />
                        {details.magic.mime ? (
                          <DetailRow label="MIME 类型" value={details.magic.mime} copy={details.magic.mime} />
                        ) : null}
                        {details.magic.signature ? (
                          <DetailRow
                            label="文件签名"
                            value={<code className="font-mono text-xs">{details.magic.signature}</code>}
                            copy={details.magic.signature}
                          />
                        ) : null}
                      </>
                    ) : detailError ? (
                      <div className="text-muted-foreground">读取失败：{detailError}</div>
                    ) : (
                      <div className="text-muted-foreground">正在读取文件内容…</div>
                    )
                  )}
                </>
              ) : null}

              {section(
                "校验和",
                <>
                  {details?.hashes ? (
                    <>
                      {(["md5", "sha1", "sha256"] as const).map((algo) => (
                        <DetailRow
                          key={algo}
                          label={algo === "sha1" ? "SHA-1" : algo.toUpperCase()}
                          value={<code className="font-mono text-xs">{details.hashes![algo]}</code>}
                          copy={details.hashes![algo]}
                        />
                      ))}
                      {details.contentVersion ? (
                        <DetailRow
                          label="内容版本"
                          value={<code className="font-mono text-xs">{details.contentVersion}</code>}
                          copy={details.contentVersion}
                        />
                      ) : null}
                    </>
                  ) : details?.hashNote ? (
                    <div className="text-muted-foreground">{details.hashNote}</div>
                  ) : detailError ? (
                    <div className="text-muted-foreground">{detailError}</div>
                  ) : (
                    <div className="text-muted-foreground">正在计算…</div>
                  )}
                </>
              )}

              {section(
                "图像",
                im ? (
                  <>
                    <DetailRow label="尺寸" value={`${im.width} × ${im.height} 像素`} copy={`${im.width}x${im.height}`} />
                    {im.megapixels !== undefined ? <DetailRow label="像素量" value={`${im.megapixels} MP`} /> : null}
                    {im.aspect ? <DetailRow label="宽高比" value={im.aspect} /> : null}
                    {im.bitDepth !== undefined ? <DetailRow label="位深" value={`${im.bitDepth} bit`} /> : null}
                    {im.colorType ? <DetailRow label="色彩模式" value={im.colorType} /> : null}
                    {im.interlaced ? <DetailRow label="交错扫描" value="是" /> : null}
                    {details?.exif ? <DetailPairs pairs={details.exif} /> : null}
                  </>
                ) : details?.exif ? (
                  <DetailPairs pairs={details.exif} />
                ) : null
              )}

              {section("文档属性", details?.doc ? <DetailPairs pairs={details.doc} /> : null)}
              {section("媒体信息", details?.media ? <DetailPairs pairs={details.media} /> : null)}

              {section(
                "文本信息",
                tx?.truncated ? (
                  <div className="text-muted-foreground">文件较大，未统计编码与行数</div>
                ) : tx?.encodingLabel ? (
                  <>
                    <DetailRow
                      label="编码"
                      value={`${tx.encodingLabel}${tx.encodingConfident === false ? "（推测）" : ""}`}
                      copy={tx.encodingLabel}
                    />
                    <DetailRow label="BOM" value={tx.bom ? "有" : "无"} />
                    <DetailRow label="换行风格" value={tx.eolLabel || tx.eol || "-"} />
                    <DetailRow label="行数" value={String(tx.lines ?? "-")} />
                    <DetailRow label="字符数" value={String(tx.chars ?? "-")} />
                  </>
                ) : null
              )}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={!stat}
            onClick={() => copyLine(summary(), "全部信息")}
          >
            <Icon name="clipboard-copy" /> 复制全部信息
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PreviewDialog({
  open,
  onOpenChange,
  entryPath,
  name,
  isHtml,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
  name: string
  isHtml?: boolean
}) {
  const kind = previewType(name)
  const url = entryPath !== null ? downloadUrl(entryPath, true) : ""
  const [text, setText] = React.useState<string | null>(null)
  const [imgScale, setImgScale] = React.useState(1)
  const imgRef = React.useRef<HTMLImageElement>(null)

  React.useEffect(() => {
    setText(null)
    setImgScale(1)
    if (open && kind === "text" && entryPath !== null) {
      fetch(url, { credentials: "same-origin" })
        .then(async (r) => {
          if (!r.ok) throw new Error("加载失败")
          const value = await r.text()
          setText(value.length > 200000 ? `${value.slice(0, 200000)}\n… (内容过长已截断)` : value)
        })
        .catch(() => setText("无法加载预览"))
    }
  }, [open, kind, url, entryPath])

  const handleWheel = (e: React.WheelEvent) => {
    if (kind !== "image") return
    e.preventDefault()
    setImgScale((prev) => {
      const next = prev - e.deltaY * 0.001
      return Math.max(0.1, Math.min(10, next))
    })
  }

  const ext = name.split(".").pop()?.toLowerCase() || ""
  const isHtmlFile = isHtml || ext === "html" || ext === "htm"

  if (!kind && !isHtmlFile) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[95vh] w-[95vw] max-w-none p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <div className="flex items-center gap-1">
              {kind === "image" && (
                <>
                  <Button size="icon-xs" variant="ghost" onClick={() => setImgScale((s) => Math.min(10, s + 0.25))}><Icon name="zoom-in" /></Button>
                  <Button size="icon-xs" variant="ghost" onClick={() => setImgScale((s) => Math.max(0.1, s - 0.25))}><Icon name="zoom-out" /></Button>
                  <Button size="icon-xs" variant="ghost" onClick={() => setImgScale(1)}><Icon name="rotate-cw" /></Button>
                </>
              )}
              <Button size="icon-xs" variant="ghost" onClick={() => onOpenChange(false)}><Icon name="x" /></Button>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {kind === "image" && (
              <div className="flex h-full items-center justify-center overflow-auto bg-muted/40" onWheel={handleWheel}>
                <img ref={imgRef} src={url} alt={name} style={{ transform: `scale(${imgScale})`, transition: "transform 0.1s" }} className="max-w-full" />
              </div>
            )}
            {kind === "video" && (
              <video src={url} controls autoPlay className="h-full w-full bg-black" />
            )}
            {kind === "audio" && (
              <div className="flex h-full items-center justify-center bg-muted/40 p-8">
                <div className="w-full max-w-md">
                  <div className="mb-4 text-center">
                    <Icon name="music" className="mx-auto size-12 text-muted-foreground" />
                    <p className="mt-2 truncate text-sm font-medium">{name}</p>
                  </div>
                  <audio src={url} controls autoPlay className="w-full" />
                </div>
              </div>
            )}
            {kind === "pdf" && <iframe src={url} title={name} className="h-full w-full" />}
            {/* 预览 HTML 时必须去掉 allow-same-origin：与 allow-scripts 同时出现的
                组合等同无沙箱，被预览页面可反过来操作父页面与本站接口。 */}
            {isHtmlFile && <iframe src={url} title={name} className="h-full w-full" sandbox="allow-scripts" />}
            {kind === "text" && (
              <ScrollArea className="h-full w-full bg-muted/30">
                <pre className="p-4 font-mono text-xs whitespace-pre-wrap">{text ?? "加载中…"}</pre>
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function EditorDialog({
  open,
  onOpenChange,
  entryPath,
  name,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryPath: string | null
  name: string
  onDone: () => void
}) {
  const [content, setContent] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)

  React.useEffect(() => {
    if (open && entryPath !== null) {
      setContent("")
      setDirty(false)
      fetch(downloadUrl(entryPath, true), { credentials: "same-origin" })
        .then(async (r) => { if (r.ok) setContent(await r.text()); else toast.error("加载失败") })
        .catch(() => toast.error("加载失败"))
    }
  }, [open, entryPath])

  const save = async () => {
    if (!entryPath || saving) return
    setSaving(true)
    try {
      await api.post("/fs/save-file", { path: entryPath, content })
      toast.success("已保存")
      setDirty(false)
      onDone()
    } catch (err) { toast.error((err as Error).message) }
    finally { setSaving(false) }
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save() }
    }
    if (open) window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, content, entryPath])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && dirty && !confirm("有未保存的更改，确定关闭？")) return; onOpenChange(o); if (!o) setDirty(false) }}>
      <DialogContent className="h-[90vh] w-[90vw] max-w-none p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">编辑 {name}</DialogTitle>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <Icon name="pencil-line" className="size-4 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{name}{dirty ? " ●" : ""}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
                {saving && <Icon name="loader-2" className="animate-spin" />} 保存
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => onOpenChange(false)}><Icon name="x" /></Button>
            </div>
          </div>
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true) }}
            className="flex-1 resize-none border-none bg-muted/20 p-4 font-mono text-xs leading-relaxed whitespace-pre outline-none"
            spellCheck={false}
            placeholder="加载中…"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
