import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { AppHeader } from "@/components/layout/app-header"
import { UploadPanel } from "@/components/browser/upload-panel"
import {
  DeleteDialog,
  DetailsDialog,
  NewFolderDialog,
  PreviewDialog,
  RenameDialog,
} from "@/components/browser/dialogs"
import { DestPickerDialog } from "@/components/browser/dest-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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

type DialogKind = "newFolder" | "rename" | "delete" | "details" | "preview" | null

export function BrowserPage() {
  const navigate = useNavigate()
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
  const [searchText, setSearchText] = React.useState(query)
  const [dragOver, setDragOver] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const lastIndexRef = React.useRef(-1)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const refresh = React.useCallback(() => {
    setLoading(true)
    if (query) {
      api
        .get<{ results: SearchResult[] }>("/fs/search", { q: query, path: "" })
        .then((d) => setResults(d.results))
        .catch((err) => toast.error((err as Error).message))
        .finally(() => setLoading(false))
    } else {
      api
        .get<{ path: string; entries: Entry[] }>("/fs/list", { path })
        .then((d) => {
          setEntries(d.entries)
          requestAnimationFrame(() => animateListIn(listRef.current))
        })
        .catch((err) => {
          toast.error((err as Error).message)
          setEntries([])
        })
        .finally(() => setLoading(false))
    }
    setSelected(new Set())
    lastIndexRef.current = -1
  }, [path, query])

  React.useEffect(refresh, [refresh])
  React.useEffect(() => uploads.onCompleted((dest) => dest === path && refresh()), [uploads, path, refresh])
  React.useEffect(() => setSearchText(query), [query])

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
      setDialogEntry(entry)
      setDialog("preview")
    } else if (me.perms.download) {
      triggerDownload(downloadUrl(rel))
    }
  }

  const select = (entry: Entry, index: number, e: React.MouseEvent) => {
    const name = entry.name
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && lastIndexRef.current >= 0) {
        const [from, to] = [Math.min(lastIndexRef.current, index), Math.max(lastIndexRef.current, index)]
        for (let i = from; i <= to; i += 1) next.add(sorted[i].name)
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(name)) next.delete(name)
        else next.add(name)
      } else {
        next.clear()
        next.add(name)
      }
      return next
    })
    if (!e.shiftKey) lastIndexRef.current = index
  }

  const selectedEntries = sorted.filter((e) => selected.has(e.name))
  const targetsOf = (entry?: Entry) =>
    entry && !selected.has(entry.name) ? [entry] : selectedEntries.length ? selectedEntries : entry ? [entry] : []

  const doDownload = (targets: Entry[]) => {
    if (targets.length === 1 && targets[0].type === "file") {
      triggerDownload(downloadUrl(joinPath(path, targets[0].name)))
    } else if (targets.length) {
      triggerDownload(zipUrl(targets.map((t) => joinPath(path, t.name))))
    }
  }

  const doClipboard = (mode: "copy" | "cut", targets: Entry[]) => {
    clipboard.set(mode, targets.map((t) => ({ path: joinPath(path, t.name), name: t.name, type: t.type })))
    toast.info(`已${mode === "copy" ? "复制" : "剪切"} ${targets.length} 项，请前往目标文件夹粘贴`)
  }

  const doPaste = async () => {
    if (!clipboard.mode || !clipboard.items.length) return
    try {
      await api.post(`/fs/${clipboard.mode === "copy" ? "copy" : "move"}`, {
        sources: clipboard.items.map((i) => i.path),
        dest: path,
      })
      toast.success(clipboard.mode === "copy" ? "复制完成" : "移动完成")
      if (clipboard.mode === "cut") clipboard.clear()
      refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doVisibility = async (entry: Entry, hidden: boolean) => {
    try {
      await api.post("/fs/guest-visibility", { path: joinPath(path, entry.name), hidden })
      toast.success(hidden ? "已对访客隐藏" : "已对访客可见")
      refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const openDialog = (kind: DialogKind, entry?: Entry) => {
    setDialogEntry(entry ?? null)
    setDialog(kind)
  }

  const submitSearch = () => {
    const q = searchText.trim()
    if (q) setParams({ q })
    else setParams(path ? { path } : {})
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!me.perms.upload) return
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) uploads.start(path, files)
  }

  const crumbs = path ? path.split("/") : []
  const canWrite = me.perms.upload || me.perms.mkdir

  const entryMenu = (entry: Entry) => {
    const targets = targetsOf(entry)
    const single = targets.length === 1
    return (
      <ContextMenuContent className="w-52">
        {entry.type === "dir" && single && (
          <ContextMenuItem onClick={() => openEntry(entry)}>
            <Icon name="folder-open" /> 打开
          </ContextMenuItem>
        )}
        {me.perms.download && (
          <ContextMenuItem onClick={() => doDownload(targets)}>
            <Icon name="download" /> 下载{!single || entry.type === "dir" ? " (Zip)" : ""}
          </ContextMenuItem>
        )}
        {single && entry.type === "file" && previewType(entry.name) && me.perms.download && (
          <ContextMenuItem onClick={() => openDialog("preview", entry)}>
            <Icon name="eye" /> 预览
          </ContextMenuItem>
        )}
        {(me.perms.copy || me.perms.move) && <ContextMenuSeparator />}
        {me.perms.copy && (
          <ContextMenuItem onClick={() => doClipboard("copy", targets)}>
            <Icon name="copy" /> 复制
          </ContextMenuItem>
        )}
        {me.perms.move && (
          <ContextMenuItem onClick={() => doClipboard("cut", targets)}>
            <Icon name="scissors" /> 剪切
          </ContextMenuItem>
        )}
        {me.perms.copy && (
          <ContextMenuItem
            onClick={() => {
              setSelected(new Set(targets.map((t) => t.name)))
              setPicker("copy")
            }}
          >
            <Icon name="copy-plus" /> 复制到…
          </ContextMenuItem>
        )}
        {me.perms.move && (
          <ContextMenuItem
            onClick={() => {
              setSelected(new Set(targets.map((t) => t.name)))
              setPicker("move")
            }}
          >
            <Icon name="folder-input" /> 移动到…
          </ContextMenuItem>
        )}
        {me.perms.rename && single && (
          <ContextMenuItem onClick={() => openDialog("rename", entry)}>
            <Icon name="pencil-line" /> 重命名
          </ContextMenuItem>
        )}
        {me.perms.manageGuestVisibility && entry.type === "dir" && single && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => doVisibility(entry, !entry.hiddenFromGuest)}>
              <Icon name={entry.hiddenFromGuest ? "eye" : "eye-off"} />
              {entry.hiddenFromGuest ? "对访客可见" : "对访客隐藏"}
            </ContextMenuItem>
          </>
        )}
        {me.perms.details && single && (
          <ContextMenuItem onClick={() => openDialog("details", entry)}>
            <Icon name="info" /> 详细信息
          </ContextMenuItem>
        )}
        {me.perms.delete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => {
              setSelected(new Set(targets.map((t) => t.name)))
              openDialog("delete", entry)
            }}>
              <Icon name="trash-2" /> 删除
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    )
  }

  const renderRow = (entry: Entry, index: number) => {
    const kind = fileKind(entry.name, entry.type)
    const isSelected = selected.has(entry.name)
    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger
          render={
            <div
              data-animate-item
              className={cn(
                "group grid cursor-default grid-cols-[minmax(0,1fr)_6rem_9rem] items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-200 select-none sm:grid-cols-[minmax(0,1fr)_6rem_9rem]",
                isSelected ? "bg-accent" : "hover:bg-muted/70"
              )}
              onClick={(e) => select(entry, index, e)}
              onDoubleClick={() => openEntry(entry)}
            />
          }
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon
              name={kind.icon}
              className={cn("size-4 shrink-0", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")}
            />
            <span className="truncate text-sm">{entry.name}</span>
            {entry.hiddenFromGuest && me.role !== "guest" && (
              <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
                <Icon name="eye-off" className="size-3" /> 访客不可见
              </Badge>
            )}
          </div>
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {entry.type === "dir" ? "—" : formatBytes(entry.size)}
          </span>
          <span className="hidden text-right text-xs text-muted-foreground tabular-nums sm:block">
            {formatDate(entry.mtime)}
          </span>
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
        <ContextMenuTrigger
          render={
            <div
              data-animate-item
              className={cn(
                "edge-highlight flex cursor-default flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 transition-all duration-200 select-none",
                isSelected ? "border-ring bg-accent" : "hover:bg-muted/60"
              )}
              onClick={(e) => select(entry, index, e)}
              onDoubleClick={() => openEntry(entry)}
            />
          }
        >
          <Icon
            name={kind.icon}
            className={cn("size-9", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")}
            strokeWidth={1.5}
          />
          <span className="w-full truncate text-center text-xs" title={entry.name}>
            {entry.name}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {entry.type === "dir" ? kind.label : formatBytes(entry.size)}
          </span>
          {entry.hiddenFromGuest && me.role !== "guest" && (
            <Icon name="eye-off" className="absolute top-2 right-2 size-3 text-muted-foreground" />
          )}
        </ContextMenuTrigger>
        {entryMenu(entry)}
      </ContextMenu>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader>
        <div className="mx-auto max-w-md">
          <div className="relative">
            <Icon name="search" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchText}
              placeholder="搜索文件…"
              className="h-8 pl-8 text-sm"
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSearch()}
            />
          </div>
        </div>
      </AppHeader>

      <main
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-4"
        onDragOver={(e) => {
          e.preventDefault()
          if (me.perms.upload && !query) setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={onDrop}
      >
        {/* 工具栏 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {me.perms.upload && (
            <Button size="sm" onClick={() => fileInputRef.current?.click()}>
              <Icon name="upload" /> 上传
            </Button>
          )}
          {me.perms.mkdir && (
            <Button size="sm" variant="outline" onClick={() => openDialog("newFolder")}>
              <Icon name="folder-plus" /> 新建文件夹
            </Button>
          )}
          {clipboard.mode && clipboard.items.length > 0 && (me.perms.copy || me.perms.move) && (
            <Button size="sm" variant="secondary" onClick={doPaste}>
              <Icon name="clipboard-paste" /> 粘贴 {clipboard.items.length} 项
            </Button>
          )}
          {selected.size > 0 && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <span className="text-xs text-muted-foreground">已选 {selected.size} 项</span>
              {me.perms.download && (
                <Button size="sm" variant="ghost" onClick={() => doDownload(selectedEntries)}>
                  <Icon name="download" /> 下载
                </Button>
              )}
              {me.perms.delete && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => openDialog("delete")}>
                  <Icon name="trash-2" /> 删除
                </Button>
              )}
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="icon-sm" variant="ghost" aria-label="刷新" onClick={refresh}>
              <Icon name="refresh-cw" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="排序" />}>
                <Icon name="arrow-up-down" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(
                  [
                    ["name", "按名称"],
                    ["size", "按大小"],
                    ["mtime", "按修改时间"],
                  ] as const
                ).map(([key, label]) => (
                  <DropdownMenuItem
                    key={key}
                    onClick={() =>
                      settings.update(
                        settings.sortBy === key
                          ? { sortDir: settings.sortDir === "asc" ? "desc" : "asc" }
                          : { sortBy: key, sortDir: "asc" }
                      )
                    }
                  >
                    <Icon
                      name={
                        settings.sortBy === key
                          ? settings.sortDir === "asc"
                            ? "arrow-up"
                            : "arrow-down"
                          : "minus"
                      }
                    />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="切换视图"
              onClick={() => settings.update({ view: settings.view === "list" ? "grid" : "list" })}
            >
              <Icon name={settings.view === "list" ? "layout-grid" : "list"} />
            </Button>
          </div>
        </div>

        {/* 面包屑 */}
        {!query && (
          <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => goto("")}
            >
              <Icon name="house" className="size-3.5" /> 根目录
            </button>
            {crumbs.map((seg, i) => (
              <React.Fragment key={`${seg}-${i}`}>
                <Icon name="chevron-right" className="size-3.5 text-muted-foreground/60" />
                {i === crumbs.length - 1 ? (
                  <span className="px-1.5 py-0.5 font-medium">{seg}</span>
                ) : (
                  <button
                    className="rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => goto(crumbs.slice(0, i + 1).join("/"))}
                  >
                    {seg}
                  </button>
                )}
              </React.Fragment>
            ))}
          </div>
        )}

        {query && (
          <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="search" className="size-4" />
            “{query}” 的搜索结果（{results.length}）
            <Button size="xs" variant="ghost" onClick={() => setParams({})}>
              <Icon name="x" /> 清除
            </Button>
          </div>
        )}

        {/* 内容区 */}
        <div
          ref={listRef}
          className={cn(
            "edge-highlight relative min-h-64 rounded-xl border border-border bg-card p-2",
            dragOver && "border-ring"
          )}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(new Set())
          }}
        >
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/80">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Icon name="upload" className="size-5" /> 松开以上传到当前文件夹
              </div>
            </div>
          )}
          {loading ? (
            <div className="flex h-56 items-center justify-center">
              <Spinner className="size-5" />
            </div>
          ) : query ? (
            results.length === 0 ? (
              <EmptyState icon="search-x" title="未找到匹配的文件" desc="换个关键词试试" />
            ) : (
              <div>
                {results.map((r) => (
                  <div
                    key={r.path}
                    className="grid cursor-default grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/70"
                    onDoubleClick={() =>
                      r.type === "dir" ? goto(r.path) : me.perms.download && triggerDownload(downloadUrl(r.path))
                    }
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Icon name={fileKind(r.name, r.type).icon} className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-sm">{r.name}</p>
                        <button
                          className="block max-w-full truncate text-xs text-muted-foreground hover:underline"
                          onClick={() => goto(r.parent)}
                        >
                          /{r.parent || "根目录"}
                        </button>
                      </div>
                    </div>
                    <span className="text-right text-xs text-muted-foreground">
                      {r.type === "dir" ? "文件夹" : formatBytes(r.size)}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : sorted.length === 0 ? (
            <EmptyState
              icon="folder-open"
              title="此文件夹为空"
              desc={canWrite ? "上传文件或新建文件夹开始使用" : "暂时没有可见的内容"}
            />
          ) : settings.view === "list" ? (
            <div>
              <div className="grid grid-cols-[minmax(0,1fr)_6rem_9rem] gap-2 border-b border-border px-2 pb-1.5 text-xs text-muted-foreground">
                <span>名称</span>
                <span className="text-right">大小</span>
                <span className="hidden text-right sm:block">修改时间</span>
              </div>
              <div className="pt-1">{sorted.map(renderRow)}</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {sorted.map(renderCard)}
            </div>
          )}
        </div>

        {me.role === "guest" && (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            当前为访客模式，仅可浏览与下载 · 管理员请
            <button className="mx-1 underline underline-offset-2" onClick={() => navigate("/login")}>
              登录
            </button>
          </p>
        )}
      </main>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (files.length) uploads.start(path, files)
          e.target.value = ""
        }}
      />

      <UploadPanel />
      <NewFolderDialog
        open={dialog === "newFolder"}
        onOpenChange={(o) => !o && setDialog(null)}
        path={path}
        onDone={refresh}
      />
      <RenameDialog
        open={dialog === "rename"}
        onOpenChange={(o) => !o && setDialog(null)}
        entry={dialogEntry}
        path={path}
        onDone={refresh}
      />
      <DeleteDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        names={
          dialog === "delete"
            ? selectedEntries.length
              ? selectedEntries.map((e) => e.name)
              : dialogEntry
                ? [dialogEntry.name]
                : []
            : []
        }
        path={path}
        onDone={refresh}
      />
      <DetailsDialog
        open={dialog === "details"}
        onOpenChange={(o) => !o && setDialog(null)}
        entryPath={dialogEntry ? joinPath(path, dialogEntry.name) : null}
      />
      <PreviewDialog
        open={dialog === "preview"}
        onOpenChange={(o) => !o && setDialog(null)}
        entryPath={dialogEntry ? joinPath(path, dialogEntry.name) : null}
        name={dialogEntry?.name || ""}
      />
      <DestPickerDialog
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        title={picker === "copy" ? "复制到…" : "移动到…"}
        sourcePaths={selectedEntries.map((e) => joinPath(path, e.name))}
        mode={picker || "copy"}
        onDone={refresh}
      />
    </div>
  )
}

function EmptyState({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <Empty className="h-56">
      <EmptyMedia variant="icon">
        <Icon name={icon} className="size-5" />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{desc}</EmptyDescription>
    </Empty>
  )
}
