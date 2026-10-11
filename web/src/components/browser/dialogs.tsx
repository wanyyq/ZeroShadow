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
import { translate, useT } from "@/lib/i18n"
import type { DetailPair, Entry, EntryDetails, EntryStat } from "@/lib/types"
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
  const t = useT()
  const [name, setName] = React.useState(() => t("ui.dialogs.new_folder_title"))
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setName(t("ui.dialogs.new_folder_title"))
  }, [open, t])

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await api.post("/fs/mkdir", { path, name: name.trim() })
      toast.success(t("ui.dialogs.folder_created"))
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
          <DialogTitle>{t("ui.dialogs.new_folder_title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="folder-name">{t("ui.common.name")}</Label>
          <Input
            id="folder-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("ui.common.cancel")}</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />} {t("ui.dialogs.create")}
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
  const t = useT()
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
        toast.success(t("ui.dialogs.renamed"))
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
              toast.success(t("ui.dialogs.renamed_overwrite"))
              onOpenChange(false)
              onDone()
            } else if (item.action === "merge") {
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName, merge: true })
              toast.success(t("ui.dialogs.renamed_merge"))
              onOpenChange(false)
              onDone()
            } else if (item.action === "rename" && item.resolvedName) {
              let resolved = item.resolvedName
              if (entry.type === "shortcut" && !resolved.toLowerCase().endsWith(".zeropath")) {
                resolved = resolved + ".zeropath"
              }
              await api.post("/fs/rename", { path: joinPath(path, entry.name), newName: resolved })
              toast.success(t("ui.dialogs.renamed"))
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
          <DialogTitle>{t("ui.common.rename")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="rename-input">{t("ui.dialogs.rename_new_name")}</Label>
          <Input
            id="rename-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("ui.common.cancel")}</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Icon name="loader-2" className="animate-spin" />} {t("ui.common.ok")}
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
  const t = useT()
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
        toast.error(t("ui.dialogs.delete_failed_count", { count: r.failed.length }), {
          description: r.failed
            .map((f) => t("ui.dialogs.item_error", { path: f.path, error: f.error }))
            .join("\n"),
        })
      } else if (r.permanentlyDeleted && r.permanentlyDeleted.length) {
        // 回收站没兜住（目录不可用等）：必须明确告知，不能让用户以为还能还原
        toast.warning(
          t("ui.dialogs.delete_partial_trashed", {
            count: names.length,
            notTrashed: r.permanentlyDeleted.length,
          }),
          {
            description: t("ui.dialogs.delete_permanent_hint", {
              names: r.permanentlyDeleted.join(t("ui.dialogs.list_separator")),
            }),
          }
        )
      } else if (r.trashed > 0) {
        toast.success(t("ui.dialogs.delete_trashed_count", { count: r.trashed }))
      } else {
        toast.success(t("ui.dialogs.delete_count", { count: names.length }))
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
          <AlertDialogTitle>{t("ui.dialogs.delete_confirm_title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("ui.dialogs.delete_confirm_lead", {
              target:
                names.length === 1
                  ? t("ui.dialogs.delete_confirm_named_target", { name: names[0] })
                  : t("ui.dialogs.delete_confirm_multi_target", { count: names.length }),
            })}
            <strong>{t("ui.dialogs.recycle_bin")}</strong>
            {t("ui.dialogs.delete_confirm_hint")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {busy && <Icon name="loader-2" className="animate-spin" />} {t("ui.common.delete")}
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
    toast.error(translate("ui.common.copy_unsupported"))
    return
  }
  void clipboard.writeText(text).then(
    () => toast.success(translate("ui.dialogs.copied_label", { label })),
    () => toast.error(translate("ui.common.copy_failed"))
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
  const t = useT()
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
            title={t("ui.common.copy")}
            onClick={() => copyLine(copy, label)}
          >
            <Icon name="copy" />
          </Button>
        ) : null}
      </span>
    </div>
  )
}

/**
 * 服务端给的命名键 → 当前语言文案，查不到就用它同时给出的**中文原文**兜底。
 *
 * 服务端不持有字典（它只在数据里多带一个键），所以任何键缺失都必须退回原文，
 * 否则界面会直接显示成一串 `meta.exif.make`。
 */
function localized(
  t: (key: string, vars?: Record<string, string | number>) => string,
  key: string | null | undefined,
  fallback: string,
  vars?: Record<string, string | number>
): string {
  if (!key) return fallback
  const text = t(key, vars)
  return text === key ? fallback : text
}

/** 把「字段名 / 值」列表渲染成若干行（EXIF / 文档属性 / 媒体信息共用） */
function DetailPairs({ pairs }: { pairs: DetailPair[] }) {
  const t = useT()
  return (
    <>
      {pairs.map((pair, i) => {
        const value = localized(t, pair.valueKey, pair.value, pair.valueParams)
        const text = `${value}${pair.unitKey ? " " + t(pair.unitKey) : ""}`
        return (
          <DetailRow
            key={`${pair.key}-${i}`}
            label={localized(t, pair.key, pair.label)}
            value={text}
            copy={text}
          />
        )
      })}
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
  const t = useT()
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
        [t("ui.common.name"), stat.name],
        [
          t("ui.common.type"),
          stat.type === "dir" ? t("ui.common.folder") : fileKind(stat.name, "file").label,
        ],
        [t("ui.common.position"), `/${stat.path.split("/").slice(0, -1).join("/")}`],
        [
          t("ui.common.size"),
          `${formatBytes(stat.size)}${stat.partial ? t("ui.dialogs.size_partial") : ""}`,
        ],
        ...(stat.type === "dir"
          ? ([
              [
                t("ui.dialogs.contains"),
                t("ui.dialogs.contains_summary", {
                  files: stat.files ?? 0,
                  dirs: stat.dirs ?? 0,
                }),
              ],
            ] as [string, React.ReactNode][])
          : []),
        [t("ui.dialogs.mtime"), formatDate(stat.mtime)],
        [t("ui.dialogs.created"), formatDate(stat.created)],
        ...(details
          ? ([
              [t("ui.dialogs.accessed"), formatDate(details.timestamps.atime)],
              [t("ui.dialogs.ctime"), formatDate(details.timestamps.ctime)],
            ] as [string, React.ReactNode][])
          : []),
        [
          t("ui.dialogs.guest_visibility"),
          stat.hiddenFromGuest ? (
            <Badge variant="secondary">
              <Icon name="eye-off" className="size-3" /> {t("ui.dialogs.hidden_from_guest")}
            </Badge>
          ) : (
            t("ui.dialogs.visible")
          ),
        ],
        ...(details?.softReadOnly
          ? ([
              [
                t("ui.dialogs.storage_location"),
                <Badge variant="secondary" key="soft">
                  <Icon name="folder-lock" className="size-3" />{" "}
                  {t("ui.dialogs.external_mapped_readonly")}
                </Badge>,
              ],
            ] as [string, React.ReactNode][])
          : []),
      ]
    : []

  const im = details?.image
  const tx = details?.text
  /** 签名识别结果：优先用命名键，查不到回落到服务端给的中文原文 */
  const magicText = details?.magic
    ? localized(t, details.magic.labelKey, details.magic.label, details.magic.labelParams)
    : ""
  const line = (label: string, value: string | number) =>
    t("ui.dialogs.summary_line", { label, value })
  const summary = () =>
    [
      line(t("ui.common.name"), stat?.name ?? ""),
      line(t("ui.common.path"), `/${stat?.path ?? ""}`),
      line(t("ui.common.size"), stat ? formatBytes(stat.size) : ""),
      line(t("ui.dialogs.mtime"), stat ? formatDate(stat.mtime) : ""),
      details?.magic
        ? line(
            t("ui.dialogs.details_section_magic"),
            `${magicText}${details.magic.mime ? ` (${details.magic.mime})` : ""}`
          )
        : "",
      details?.magic?.signature
        ? line(t("ui.dialogs.signature"), details.magic.signature)
        : "",
      details?.hashes ? line("MD5", details.hashes.md5) : "",
      details?.hashes ? line("SHA-1", details.hashes.sha1) : "",
      details?.hashes ? line("SHA-256", details.hashes.sha256) : "",
      im ? line(t("ui.dialogs.dimensions"), `${im.width} × ${im.height}`) : "",
      tx?.encodingLabel
        ? line(
            t("ui.dialogs.text_encoding"),
            `${tx.encodingLabel}${tx.bom ? t("ui.dialogs.with_bom") : ""}`
          )
        : "",
      tx?.lines !== undefined ? line(t("ui.dialogs.line_count"), tx.lines) : "",
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
          <DialogTitle>{t("ui.dialogs.details_title")}</DialogTitle>
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
                t("ui.dialogs.details_section_basic"),
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
                    t("ui.dialogs.details_section_magic"),
                    details?.magic ? (
                      <>
                        <DetailRow
                          label={t("ui.dialogs.detected_result")}
                          value={magicText}
                          copy={magicText}
                        />
                        {details.magic.mime ? (
                          <DetailRow
                            label={t("ui.dialogs.mime_type")}
                            value={details.magic.mime}
                            copy={details.magic.mime}
                          />
                        ) : null}
                        {details.magic.signature ? (
                          <DetailRow
                            label={t("ui.dialogs.file_signature")}
                            value={<code className="font-mono text-xs">{details.magic.signature}</code>}
                            copy={details.magic.signature}
                          />
                        ) : null}
                      </>
                    ) : detailError ? (
                      <div className="text-muted-foreground">
                        {t("ui.dialogs.read_failed", { error: detailError })}
                      </div>
                    ) : (
                      <div className="text-muted-foreground">
                        {t("ui.dialogs.reading_content")}
                      </div>
                    )
                  )}
                </>
              ) : null}

              {section(
                t("ui.dialogs.details_section_checksum"),
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
                          label={t("ui.dialogs.content_version")}
                          value={<code className="font-mono text-xs">{details.contentVersion}</code>}
                          copy={details.contentVersion}
                        />
                      ) : null}
                    </>
                  ) : details?.hashNote ? (
                    <div className="text-muted-foreground">
                      {localized(t, details.hashNoteKey, details.hashNote, details.hashNoteParams ?? undefined)}
                    </div>
                  ) : detailError ? (
                    <div className="text-muted-foreground">{detailError}</div>
                  ) : (
                    <div className="text-muted-foreground">{t("ui.dialogs.computing")}</div>
                  )}
                </>
              )}

              {section(
                t("ui.dialogs.details_section_image"),
                im ? (
                  <>
                    <DetailRow
                      label={t("ui.dialogs.dimensions")}
                      value={t("ui.dialogs.dimensions_px", { width: im.width, height: im.height })}
                      copy={`${im.width}x${im.height}`}
                    />
                    {im.megapixels !== undefined ? (
                      <DetailRow
                        label={t("ui.dialogs.megapixels")}
                        value={`${im.megapixels} ${t("meta.unit.megapixel")}`}
                      />
                    ) : null}
                    {im.aspect ? (
                      <DetailRow label={t("ui.dialogs.aspect_ratio")} value={im.aspect} />
                    ) : null}
                    {im.bitDepth !== undefined ? (
                      <DetailRow
                        label={t("ui.dialogs.bit_depth")}
                        value={`${im.bitDepth} ${t("meta.unit.bit")}`}
                      />
                    ) : null}
                    {im.colorType ? (
                      <DetailRow
                        label={t("ui.dialogs.color_mode")}
                        value={localized(t, im.colorTypeKey, im.colorType)}
                      />
                    ) : null}
                    {im.interlaced ? (
                      <DetailRow label={t("ui.dialogs.interlaced")} value={t("ui.common.yes")} />
                    ) : null}
                    {details?.exif ? <DetailPairs pairs={details.exif} /> : null}
                  </>
                ) : details?.exif ? (
                  <DetailPairs pairs={details.exif} />
                ) : null
              )}

              {section(
                t("ui.dialogs.details_section_doc"),
                details?.doc ? <DetailPairs pairs={details.doc} /> : null
              )}
              {section(
                t("ui.dialogs.details_section_media"),
                details?.media ? <DetailPairs pairs={details.media} /> : null
              )}

              {section(
                t("ui.dialogs.details_section_text"),
                tx?.truncated ? (
                  <div className="text-muted-foreground">{t("ui.dialogs.text_too_large")}</div>
                ) : tx?.encodingLabel ? (
                  <>
                    <DetailRow
                      label={t("ui.dialogs.encoding")}
                      value={`${tx.encodingLabel}${tx.encodingConfident === false ? t("ui.dialogs.encoding_guess") : ""}`}
                      copy={tx.encodingLabel}
                    />
                    <DetailRow
                      label="BOM"
                      value={tx.bom ? t("ui.dialogs.bom_present") : t("ui.dialogs.bom_absent")}
                    />
                    <DetailRow
                      label={t("ui.dialogs.eol_style")}
                      value={localized(t, tx.eolKey, tx.eolLabel || tx.eol || "-")}
                    />
                    <DetailRow label={t("ui.dialogs.line_count")} value={String(tx.lines ?? "-")} />
                    <DetailRow label={t("ui.dialogs.char_count")} value={String(tx.chars ?? "-")} />
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
            onClick={() => copyLine(summary(), t("ui.dialogs.all_info"))}
          >
            <Icon name="clipboard-copy" /> {t("ui.dialogs.copy_all_info")}
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
  const t = useT()
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
          if (!r.ok) throw new Error(t("ui.dialogs.load_failed"))
          const value = await r.text()
          setText(
            value.length > 200000
              ? `${value.slice(0, 200000)}\n${t("ui.dialogs.preview_truncated")}`
              : value
          )
        })
        .catch(() => setText(t("ui.dialogs.preview_load_failed")))
    }
  }, [open, kind, url, entryPath, t])

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
                <pre className="p-4 font-mono text-xs whitespace-pre-wrap">{text ?? t("ui.common.loading")}</pre>
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
  const t = useT()
  const [content, setContent] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)

  React.useEffect(() => {
    if (open && entryPath !== null) {
      setContent("")
      setDirty(false)
      fetch(downloadUrl(entryPath, true), { credentials: "same-origin" })
        .then(async (r) => { if (r.ok) setContent(await r.text()); else toast.error(t("ui.dialogs.load_failed")) })
        .catch(() => toast.error(t("ui.dialogs.load_failed")))
    }
  }, [open, entryPath, t])

  const save = async () => {
    if (!entryPath || saving) return
    setSaving(true)
    try {
      await api.post("/fs/save-file", { path: entryPath, content })
      toast.success(t("ui.common.saved"))
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
    <Dialog open={open} onOpenChange={(o) => { if (!o && dirty && !confirm(t("ui.dialogs.unsaved_confirm"))) return; onOpenChange(o); if (!o) setDirty(false) }}>
      <DialogContent className="h-[90vh] w-[90vw] max-w-none p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">{t("ui.dialogs.edit_title", { name })}</DialogTitle>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <Icon name="pencil-line" className="size-4 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{name}{dirty ? " ●" : ""}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
                {saving && <Icon name="loader-2" className="animate-spin" />} {t("ui.common.save")}
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => onOpenChange(false)}><Icon name="x" /></Button>
            </div>
          </div>
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true) }}
            className="flex-1 resize-none border-none bg-muted/20 p-4 font-mono text-xs leading-relaxed whitespace-pre outline-none"
            spellCheck={false}
            placeholder={t("ui.common.loading")}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
