import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { UploadPanel } from "@/components/browser/upload-panel"
import { DeleteDialog, DetailsDialog, NewFolderDialog, PreviewDialog, RenameDialog } from "@/components/browser/dialogs"
import { DestPickerDialog } from "@/components/browser/dest-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Icon } from "@/components/icon"
import { api, downloadUrl, triggerDownload, zipUrl } from "@/lib/api"
import { fileKind, formatBytes, formatDate, joinPath, previewType } from "@/lib/format"
import { animateListIn } from "@/lib/lucide"
import type { Entry, SearchResult } from "@/lib/types"
import { useAuth } from "@/state/auth"
import { useClientSettings } from "@/state/client-settings"
import { useClipboard } from "@/state/clipboard"
import { useUploads } from "@/state/uploads"
import { cn } from "@/lib/utils"

const ROLE_LABEL: Record<string, string> = { superadmin: "超级管理员", member: "团队成员", guest: "访客" }

type DialogKind = "newFolder" | "rename" | "delete" | "details" | "preview" | null

function noPermToast() { toast.warning("您没有权限执行此操作") }

export function BrowserPage() {
  const [params, setParams] = useSearchParams()
  const path = params.get("path") || ""
  const query = params.get("q") || ""
  const { me } = useAuth()
  const settings = useClientSettings()
  const clipboard = useClipboard()
  const uploads = useUploads()

  const [entries, setEntries] = React.useState<Entry[]>([])
  const [results, setResults] = React.useState<SearchResult[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [dialog, setDialog] = React.useState<DialogKind>(null)
  const [dialogEntry, setDialogEntry] = React.useState<Entry | null>(null)
  const [picker, setPicker] = React.useState<"copy" | "move" | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [searchText, setSearchText] = React.useState("")
  const listRef = React.useRef<HTMLDivElement>(null)
  const lastIndexRef = React.useRef(-1)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const refresh = React.useCallback(() => {
    setLoading(true)
    if (query) {
      api.get<{ results: SearchResult[] }>("/fs/search", { q: query, path: "" })
        .then((d) => setResults(d.results))
        .catch((err) => toast.error((err as Error).message))
        .finally(() => setLoading(false))
    } else {
      api.get<{ path: string; entries: Entry[] }>("/fs/list", { path })
        .then((d) => { setEntries(d.entries); requestAnimationFrame(() => animateListIn(listRef.current)) })
        .catch((err) => { toast.error((err as Error).message); setEntries([]) })
        .finally(() => setLoading(false))
    }
    setSelected(new Set())
    lastIndexRef.current = -1
  }, [path, query])

  React.useEffect(refresh, [refresh])
  React.useEffect(() => uploads.onCompleted((dest) => dest === path && refresh()), [uploads, path, refresh])

  const sorted = React.useMemo(() => {
    const list = [...entries]
    const dir = settings.sortDir === "asc" ? 1 : -1
    list.sort((a, b) => {
      if (settings.foldersFirst && a.type !== b.type) return a.type === "dir" ? -1 : 1
      if (settings.sortBy === "size") return (a.size - b.size) * dir
      if (settings.sortBy === "mtime") return (a.mtime - b.mtime) * dir
      return a.name.localeCompare(b.name, "zh-CN") * dir
    })
    return list
  }, [entries, settings.sortBy, settings.sortDir, settings.foldersFirst])

  const goto = (p: string) => setParams(p ? { path: p } : {})
  const openEntry = (entry: Entry) => {
    if (entry.type === "dir") return goto(joinPath(path, entry.name))
    const rel = joinPath(path, entry.name)
    if (previewType(entry.name) && me.perms.download) {
      setDialogEntry(entry); setDialog("preview")
    } else if (me.perms.download) {
      triggerDownload(downloadUrl(rel))
    }
  }

  const select = (entry: Entry, index: number, e: React.MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && lastIndexRef.current >= 0) {
        const [from, to] = [Math.min(lastIndexRef.current, index), Math.max(lastIndexRef.current, index)]
        for (let i = from; i <= to; i += 1) next.add(sorted[i].name)
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name)
      } else {
        if (next.size === 1 && next.has(entry.name)) { next.clear() } else { next.clear(); next.add(entry.name) }
      }
      return next
    })
    if (!e.shiftKey) lastIndexRef.current = index
  }

  const selectedEntries = sorted.filter((e) => selected.has(e.name))
  const targetsOf = (entry?: Entry) =>
    entry && !selected.has(entry.name) ? [entry] : selectedEntries.length ? selectedEntries : entry ? [entry] : []

  const doDownload = (targets: Entry[]) => {
    if (!me.perms.download) return noPermToast()
    if (targets.length === 1 && targets[0].type === "file") triggerDownload(downloadUrl(joinPath(path, targets[0].name)))
    else if (targets.length) triggerDownload(zipUrl(targets.map((t) => joinPath(path, t.name))))
  }

  const doClipboard = (mode: "copy" | "cut", targets: Entry[]) => {
    if (!me.perms[mode === "copy" ? "copy" : "move"]) return noPermToast()
    clipboard.set(mode, targets.map((t) => ({ path: joinPath(path, t.name), name: t.name, type: t.type })))
    toast.info(`已${mode === "copy" ? "复制" : "剪切"} ${targets.length} 项`)
  }

  const doPaste = async () => {
    if (!clipboard.mode || !clipboard.items.length) return
    if (!me.perms[clipboard.mode === "copy" ? "copy" : "move"]) return noPermToast()
    try {
      await api.post(`/fs/${clipboard.mode === "copy" ? "copy" : "move"}`, { sources: clipboard.items.map((i) => i.path), dest: path })
      toast.success(clipboard.mode === "copy" ? "复制完成" : "移动完成")
      if (clipboard.mode === "cut") clipboard.clear()
      refresh()
    } catch (err) { toast.error((err as Error).message) }
  }

  const doVisibility = async (entry: Entry, hidden: boolean) => {
    if (!me.perms.manageGuestVisibility) return noPermToast()
    try {
      await api.post("/fs/guest-visibility", { path: joinPath(path, entry.name), hidden })
      toast.success(hidden ? "已对访客隐藏" : "已对访客可见"); refresh()
    } catch (err) { toast.error((err as Error).message) }
  }

  const openDialog = (kind: DialogKind, entry?: Entry) => { setDialogEntry(entry ?? null); setDialog(kind) }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    if (!me.perms.upload) return noPermToast()
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) uploads.start(path, files)
  }

  const submitSearch = () => {
    const q = searchText.trim()
    if (q) setParams({ q })
    else setParams(path ? { path } : {})
  }

  // 快捷键
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const key = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey

      if (key === "f2" && selected.size === 1) {
        e.preventDefault()
        const entry = sorted.find((en) => selected.has(en.name))
        if (entry && me.perms.rename) openDialog("rename", entry)
        else if (entry) noPermToast()
      }
      if (key === "delete" && selected.size > 0) {
        e.preventDefault()
        if (me.perms.delete) openDialog("delete")
        else noPermToast()
      }
      if (mod && key === "a") {
        e.preventDefault()
        setSelected(new Set(sorted.map((en) => en.name)))
        lastIndexRef.current = sorted.length - 1
      }
      if (mod && key === "c" && selected.size > 0) {
        e.preventDefault()
        if (me.perms.copy) doClipboard("copy", selectedEntries)
        else noPermToast()
      }
      if (mod && key === "x" && selected.size > 0) {
        e.preventDefault()
        if (me.perms.move) doClipboard("cut", selectedEntries)
        else noPermToast()
      }
      if (mod && key === "v") {
        e.preventDefault(); doPaste()
      }
      if (key === "enter" && selected.size === 1) {
        const entry = sorted.find((en) => selected.has(en.name))
        if (entry) openEntry(entry)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [selected, sorted, me.perms])

  const crumbs = path ? path.split("/") : []

  // ---------- 上下文菜单内容（提取为函数，供三个点和右键共用） ----------
  const buildMenuItems = (entry: Entry) => {
    const targets = targetsOf(entry)
    const single = targets.length === 1
    const items: React.ReactNode[] = []

    if (entry.type === "dir" && single) {
      items.push(<ContextMenuItem key="open" onClick={() => openEntry(entry)}><Icon name="folder-open" /> 打开</ContextMenuItem>)
    }
    items.push(
      <ContextMenuItem key="download" disabled={!me.perms.download} onClick={() => { if (!me.perms.download) noPermToast(); else doDownload(targets) }}>
        <Icon name="download" /> 下载{!single || entry.type === "dir" ? " (Zip)" : ""}
      </ContextMenuItem>
    )
    if (single && entry.type === "file" && previewType(entry.name)) {
      items.push(
        <ContextMenuItem key="preview" disabled={!me.perms.download} onClick={() => { if (!me.perms.download) noPermToast(); else openDialog("preview", entry) }}>
          <Icon name="eye" /> 预览
        </ContextMenuItem>
      )
    }
    items.push(<ContextMenuSeparator key="s1" />)
    items.push(
      <ContextMenuItem key="copy" disabled={!me.perms.copy} onClick={() => { if (!me.perms.copy) noPermToast(); else doClipboard("copy", targets) }}>
        <Icon name="copy" /> 复制
      </ContextMenuItem>
    )
    items.push(
      <ContextMenuItem key="cut" disabled={!me.perms.move} onClick={() => { if (!me.perms.move) noPermToast(); else doClipboard("cut", targets) }}>
        <Icon name="scissors" /> 剪切
      </ContextMenuItem>
    )
    if (me.perms.copy) {
      items.push(<ContextMenuItem key="copyto" onClick={() => { setSelected(new Set(targets.map((t) => t.name))); setPicker("copy") }}><Icon name="copy-plus" /> 复制到…</ContextMenuItem>)
    } else {
      items.push(<ContextMenuItem key="copyto-d" disabled onClick={noPermToast}><Icon name="copy-plus" /> 复制到…</ContextMenuItem>)
    }
    if (me.perms.move) {
      items.push(<ContextMenuItem key="moveto" onClick={() => { setSelected(new Set(targets.map((t) => t.name))); setPicker("move") }}><Icon name="folder-input" /> 移动到…</ContextMenuItem>)
    } else {
      items.push(<ContextMenuItem key="moveto-d" disabled onClick={noPermToast}><Icon name="folder-input" /> 移动到…</ContextMenuItem>)
    }
    if (single) {
      items.push(
        <ContextMenuItem key="rename" disabled={!me.perms.rename} onClick={() => { if (!me.perms.rename) noPermToast(); else openDialog("rename", entry) }}>
          <Icon name="pencil-line" /> 重命名
        </ContextMenuItem>
      )
    }
    if (entry.type === "dir" && single) {
      items.push(<ContextMenuSeparator key="s2" />)
      items.push(
        <ContextMenuItem key="hide" disabled={!me.perms.manageGuestVisibility} onClick={() => { if (!me.perms.manageGuestVisibility) noPermToast(); else doVisibility(entry, !entry.hiddenFromGuest) }}>
          <Icon name={entry.hiddenFromGuest ? "eye" : "eye-off"} /> {entry.hiddenFromGuest ? "对访客可见" : "对访客隐藏"}
        </ContextMenuItem>
      )
    }
    if (single) {
      items.push(
        <ContextMenuItem key="details" disabled={!me.perms.details} onClick={() => { if (!me.perms.details) noPermToast(); else openDialog("details", entry) }}>
          <Icon name="info" /> 详细信息
        </ContextMenuItem>
      )
    }
    items.push(<ContextMenuSeparator key="s3" />)
    items.push(
      <ContextMenuItem key="delete" variant="destructive" disabled={!me.perms.delete} onClick={() => { if (!me.perms.delete) noPermToast(); else { setSelected(new Set(targets.map((t) => t.name))); openDialog("delete", entry) } }}>
        <Icon name="trash-2" /> 删除
      </ContextMenuItem>
    )
    return items
  }

  const entryMenu = (entry: Entry) => (
    <ContextMenuContent className="w-52">{buildMenuItems(entry)}</ContextMenuContent>
  )

  // 文件悬浮提示
  const HoverInfo = ({ entry }: { entry: Entry }) => {
    const kind = fileKind(entry.name, entry.type)
    return (
      <div className="grid gap-0.5">
        <p className="text-xs font-medium">{entry.name}</p>
        <p className="text-[10px] text-muted-foreground">
          {kind.label}{entry.type === "file" ? ` · ${formatBytes(entry.size)}` : ""}
        </p>
        <p className="text-[10px] text-muted-foreground">{formatDate(entry.mtime)}</p>
        {entry.hiddenFromGuest && me.role !== "guest" && <p className="text-[10px] text-muted-foreground">对访客隐藏</p>}
      </div>
    )
  }

  // 三个点按钮的下拉菜单
  const threeDotMenu = (entry: Entry) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            className="flex size-5 shrink-0 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <Icon name="ellipsis-vertical" className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {buildMenuItems(entry)}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const renderRow = (entry: Entry, index: number) => {
    const isSelected = selected.has(entry.name)
    const kind = fileKind(entry.name, entry.type)
    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger render={<div />}>
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  data-animate-item
                  className={cn(
                    "group flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 transition-colors select-none",
                    isSelected ? "bg-accent" : "hover:bg-muted/70"
                  )}
                  onClick={(e) => select(entry, index, e)}
                  onDoubleClick={() => openEntry(entry)}
                />
              }
            >
              <Icon name={kind.icon} className={cn("size-4 shrink-0", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")} />
              <div className="min-w-0 flex-1"><span className="block truncate text-sm">{entry.name}</span></div>
              {entry.hiddenFromGuest && me.role !== "guest" && <Icon name="eye-off" className="hidden size-3 shrink-0 text-muted-foreground sm:block" />}
              <span className="hidden w-18 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
                {entry.type === "dir" ? "文件夹" : formatBytes(entry.size)}
              </span>
              <span className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums lg:block">
                {formatDate(entry.mtime)}
              </span>
              {isSelected && <span className="ml-1">{threeDotMenu(entry)}</span>}
            </TooltipTrigger>
            <TooltipContent side="left"><HoverInfo entry={entry} /></TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        {entryMenu(entry)}
      </ContextMenu>
    )
  }

  const renderCard = (entry: Entry, index: number) => {
    const kind = fileKind(entry.name, entry.type)
    const isSelected = selected.has(entry.name)
    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger render={<div />}>
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  data-animate-item
                  className={cn(
                    "edge-highlight flex cursor-default flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 transition-all select-none",
                    isSelected ? "border-ring bg-accent" : "hover:bg-muted/60"
                  )}
                  onClick={(e) => select(entry, index, e)}
                  onDoubleClick={() => openEntry(entry)}
                />
              }
            >
              <Icon name={kind.icon} className={cn("size-9", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")} strokeWidth={1.5} />
              <span className="w-full truncate text-center text-xs" title={entry.name}>{entry.name}</span>
              <span className="text-[10px] text-muted-foreground">{entry.type === "dir" ? kind.label : formatBytes(entry.size)}</span>
              {entry.hiddenFromGuest && me.role !== "guest" && <Icon name="eye-off" className="absolute top-2 right-2 size-3 text-muted-foreground" />}
              {isSelected && <div className="flex justify-center">{threeDotMenu(entry)}</div>}
            </TooltipTrigger>
            <TooltipContent><HoverInfo entry={entry} /></TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        {entryMenu(entry)}
      </ContextMenu>
    )
  }

  const canUpload = me.perms.upload
  const canMkdir = me.perms.mkdir

  return (
    <AppShell>
      <div
        className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-2 sm:px-5"
        onDragOver={(e) => { e.preventDefault(); if (canUpload && !query) setDragOver(true) }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
        onDrop={onDrop}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
          {/* 工具栏 */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={!canUpload} onClick={() => { if (!canUpload) noPermToast(); else fileInputRef.current?.click() }}>
              <Icon name="upload" /> 上传
            </Button>
            <Button size="sm" variant="outline" disabled={!canMkdir} onClick={() => { if (!canMkdir) noPermToast(); else openDialog("newFolder") }}>
              <Icon name="folder-plus" /> 新建文件夹
            </Button>
            {/* 桌面端搜索框 */}
            <div className="relative ml-2 hidden sm:block">
              <Icon name="search" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchText}
                placeholder="搜索文件…"
                className="h-8 w-44 rounded-md border border-input bg-background pl-8 text-sm shadow-sm transition-all focus:w-56 hover:border-ring"
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitSearch() }}
              />
            </div>
            {clipboard.mode && clipboard.items.length > 0 && (
              <Button size="sm" variant="secondary" onClick={doPaste}>
                <Icon name="clipboard-paste" /> 粘贴 {clipboard.items.length} 项
              </Button>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button size="icon-sm" variant="ghost" aria-label="刷新" onClick={refresh}><Icon name="refresh-cw" /></Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="排序" />}><Icon name="arrow-up-down" /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(["name", "size", "mtime"] as const).map((key) => (
                    <DropdownMenuItem key={key} onClick={() => settings.update(settings.sortBy === key ? { sortDir: settings.sortDir === "asc" ? "desc" : "asc" } : { sortBy: key, sortDir: "asc" })}>
                      <Icon name={settings.sortBy === key ? (settings.sortDir === "asc" ? "arrow-up" : "arrow-down") : "minus"} />
                      {{ name: "按名称", size: "按大小", mtime: "按修改时间" }[key]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="icon-sm" variant="ghost" aria-label="切换视图" onClick={() => settings.update({ view: settings.view === "list" ? "grid" : "list" })}>
                <Icon name={settings.view === "list" ? "layout-grid" : "list"} />
              </Button>
            </div>
          </div>

          {/* 面包屑 */}
          {!query && (
            <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
              <button className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => goto("")}>
                <Icon name="house" className="size-3.5" /> 根目录
              </button>
              {crumbs.map((seg, i) => (
                <React.Fragment key={`${seg}-${i}`}>
                  <Icon name="chevron-right" className="size-3.5 text-muted-foreground/60" />
                  {i === crumbs.length - 1 ? (
                    <span className="px-1.5 py-0.5 font-medium">{seg}</span>
                  ) : (
                    <button className="rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => goto(crumbs.slice(0, i + 1).join("/"))}>{seg}</button>
                  )}
                </React.Fragment>
              ))}
            </div>
          )}

          {query && (
            <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="search" className="size-4" /> “{query}”（{results.length}）
              <Button size="xs" variant="ghost" onClick={() => setParams({})}><Icon name="x" /> 清除</Button>
            </div>
          )}

          {/* 文件列表（填满高度） */}
          <div
            ref={listRef}
            className={cn("edge-highlight relative flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card", dragOver && "border-ring")}
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(new Set()) }}
          >
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/80">
                <div className="flex items-center gap-2 text-sm font-medium"><Icon name="upload" className="size-5" /> 松开以上传到当前文件夹</div>
              </div>
            )}
            {loading ? (
              <div className="flex flex-1 items-center justify-center"><Spinner className="size-5" /></div>
            ) : query ? (
              results.length === 0 ? (<EmptyState icon="search-x" title="未找到" desc="换个关键词试试" />) : (
                <div className="flex-1 overflow-auto p-2">
                  {results.map((r) => (
                    <div key={r.path} className="flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/70"
                      onDoubleClick={() => r.type === "dir" ? goto(r.path) : me.perms.download && triggerDownload(downloadUrl(r.path))}>
                      <Icon name={fileKind(r.name, r.type).icon} className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{r.name}</p>
                        <button className="block max-w-full truncate text-xs text-muted-foreground hover:underline" onClick={() => goto(r.parent)}>/{r.parent || "根目录"}</button>
                      </div>
                      <span className="w-18 shrink-0 text-right text-xs text-muted-foreground">{r.type === "dir" ? "文件夹" : formatBytes(r.size)}</span>
                    </div>
                  ))}
                </div>
              )
            ) : sorted.length === 0 ? (
              <EmptyState icon="folder-open" title="此文件夹为空" desc={canUpload || canMkdir ? "上传文件或新建文件夹开始使用" : "暂无可见内容"} />
            ) : settings.view === "list" ? (
              <div className="flex flex-1 flex-col overflow-hidden p-2">
                <div className="mb-1 flex items-center gap-3 border-b border-border px-2 pb-1.5 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1">名称</span>
                  <span className="hidden w-18 shrink-0 text-right sm:block">大小</span>
                  <span className="hidden w-32 shrink-0 text-right lg:block">修改时间</span>
                </div>
                <div className="flex-1 overflow-auto">{sorted.map(renderRow)}</div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">{sorted.map(renderCard)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部信息 */}
      <div className="border-t border-border/30 px-3 py-2 sm:px-5">
        <div className="mx-auto w-full max-w-4xl text-center text-[11px] leading-relaxed text-muted-foreground">
          当前为“{ROLE_LABEL[me.role]}”模式{me.role !== "superadmin" ? "，其他功能需要管理员模式" : ""}<br />Copyright © Wangyq 2026
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden"
        onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) uploads.start(path, files); e.target.value = "" }}
      />
      <UploadPanel />
      <NewFolderDialog open={dialog === "newFolder"} onOpenChange={(o) => !o && setDialog(null)} path={path} onDone={refresh} />
      <RenameDialog open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(null)} entry={dialogEntry} path={path} onDone={refresh} />
      <DeleteDialog
        open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}
        names={dialog === "delete" ? (selectedEntries.length ? selectedEntries.map((e) => e.name) : dialogEntry ? [dialogEntry.name] : []) : []}
        path={path} onDone={refresh}
      />
      <DetailsDialog open={dialog === "details"} onOpenChange={(o) => !o && setDialog(null)} entryPath={dialogEntry ? joinPath(path, dialogEntry.name) : null} />
      <PreviewDialog open={dialog === "preview"} onOpenChange={(o) => !o && setDialog(null)} entryPath={dialogEntry ? joinPath(path, dialogEntry.name) : null} name={dialogEntry?.name || ""} />
      <DestPickerDialog open={picker !== null} onOpenChange={(o) => !o && setPicker(null)} title={picker === "copy" ? "复制到…" : "移动到…"}
        sourcePaths={selectedEntries.map((e) => joinPath(path, e.name))} mode={picker || "copy"} onDone={refresh}
      />
    </AppShell>
  )
}

function EmptyState({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <Empty className="flex-1">
      <EmptyMedia variant="icon"><Icon name={icon} className="size-5" /></EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{desc}</EmptyDescription>
    </Empty>
  )
}
