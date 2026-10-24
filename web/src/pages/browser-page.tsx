import * as React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { FileTasksPanel } from "@/components/browser/file-tasks-panel"
import { DeleteDialog, DetailsDialog, NewFolderDialog, RenameDialog } from "@/components/browser/dialogs"
import { DestPickerDialog } from "@/components/browser/dest-picker"
import { ConflictDialog } from "@/components/browser/conflict-dialog"
import { ShortcutEditorDialog } from "@/components/browser/shortcut-editor"
import { NewCustomFileDialog } from "@/components/browser/new-file-dialog"
import { createTextFileWithDefault } from "@/lib/new-file"
import { ShareDialog } from "@/components/browser/share-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Icon } from "@/components/icon"
import { api, downloadUrl, fetchConvertTargets, thumbUrl, triggerDownload, zipUrl } from "@/lib/api"
import { fileKind, formatBytes, formatDate, joinPath, canPreview, isThumbSourceName } from "@/lib/format"
import { animateListIn } from "@/lib/lucide"
import { useProgressiveReveal, useVirtualRows } from "@/lib/virtual"
import type { ConvertTarget, Entry, SearchResult } from "@/lib/types"
import { useAuth } from "@/state/auth"
import { useGroups } from "@/state/groups"
import { useClientSettings } from "@/state/client-settings"
import { useClipboard } from "@/state/clipboard"
import { useUploads } from "@/state/uploads"
import { useOperations } from "@/state/operations"
import { cn } from "@/lib/utils"
import { CONFLICT_CANCELLED, detectConflicts } from "@/lib/conflict"
import type { ConflictResolution } from "@/lib/conflict"
import { translate, useT } from "@/lib/i18n"

type DialogKind = "newFolder" | "rename" | "delete" | "details" | null

function noPermToast() { toast.warning(translate("ui.common.no_permission")) }
function noPermSoftToast() { toast.warning(translate("ui.browser.soft_readonly_only")) }

/**
 * 复制纯文本并给出反馈。
 * 注意分支：`navigator.clipboard` 不存在（非安全上下文 / 老浏览器）时，
 * 可选链会让整条 then 直接短路 —— 成功与失败两个回调都不会执行，
 * 用户点了「复制链接」却没有任何反应。所以这里要显式判断。
 */
function copyText(text: string, okMsg: string) {
  const clipboard = navigator.clipboard
  if (!clipboard?.writeText) {
    toast.error(translate("ui.common.copy_unsupported"))
    return
  }
  void clipboard.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error(translate("ui.common.copy_failed"))
  )
}

/** 可在线编辑的扩展名（模块级常量：原先内联在 JSX 里，且两处重复声明了 ext） */
const EDITABLE = [
  "txt", "md", "mdx", "py", "cpp", "log", "html", "htm", "js", "ts", "css", "json",
  "xml", "yml", "yaml", "ini", "conf", "sh", "java", "c", "rs", "go", "rst", "adoc",
  "tex", "bat", "ps1", "vbs", "lua", "rb", "php", "pl", "sql", "toml", "properties",
  "graphql", "rtf", "org", "cmake", "gradle", "gitignore", "env", "dockerfile", "makefile",
]

// 文件夹上传时，把 webkitRelativePath 写回 File.name，便于服务端还原目录结构
function withRelativePath(f: File): File {
  const wp = f.webkitRelativePath
  return wp ? new File([f], wp, { type: f.type, lastModified: f.lastModified }) : f
}

function anySoftReadOnly(entries: Entry[]) {
  return entries.some((e) => e.softReadOnly)
}
function isInSoftDir(entry?: Entry) {
  return entry?.softReadOnly === true
}

/**
 * 网格卡片里的缩略图（v2.0）。
 *
 * 为什么要组件化：`onError` 要落到每个卡片自己的状态上（某一张图解码失败
 * 不能影响别的卡片），而且服务端在没装 sharp / 图片过大时会回 501/413，
 * 那时必须**安静地退回图标**，不能弹一堆报错。
 *
 * 图片本身用 `loading="lazy"` + `decoding="async"`：浏览器只在接近视口时才请求，
 * 卡片再多也不会一次性打满请求。尺寸固定 `h-16`，避免卡片高度跳动。
 */
function EntryThumb({ path, name, icon, alt }: { path: string; name: string; icon: string; alt: string }) {
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => { setFailed(false) }, [path])
  if (failed) {
    return <Icon name={icon} className="size-9 text-muted-foreground" strokeWidth={1.5} aria-label={alt} />
  }
  return (
    <img
      src={thumbUrl(path)}
      alt={alt}
      title={name}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className="h-16 w-full rounded-md object-cover"
    />
  )
}

export function BrowserPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const path = params.get("path") || ""
  const query = params.get("q") || ""
  const { me } = useAuth()
  const { currentId: groupContextId } = useGroups()
  const settings = useClientSettings()
  const clipboard = useClipboard()
  const uploads = useUploads()
  const operations = useOperations()
  const t = useT()

  /** 底部状态栏里的角色标签（role 是代码值，只用来查键） */
  const roleLabel = (role: string) => {
    if (role === "superadmin") return t("ui.browser.role.superadmin")
    if (role === "member") return t("ui.browser.role.member")
    return t("ui.browser.role.guest")
  }

  const [entries, setEntries] = React.useState<Entry[]>([])
  const [results, setResults] = React.useState<SearchResult[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [dialog, setDialog] = React.useState<DialogKind>(null)
  const [dialogEntry, setDialogEntry] = React.useState<Entry | null>(null)
  // 对话框里操作项所在目录：普通列表是 path，搜索结果则是它自己的父目录
  const [dialogBase, setDialogBase] = React.useState("")
  const [picker, setPicker] = React.useState<"copy" | "move" | null>(null)
  // 「复制到 / 移动到」的源路径：搜索结果的路径不在当前目录里，不能靠 selected 反推
  const [pickerPaths, setPickerPaths] = React.useState<string[]>([])
  const [dragOver, setDragOver] = React.useState(false)
  const [searchText, setSearchText] = React.useState("")
  const listRef = React.useRef<HTMLDivElement>(null)
  const lastAnchorRef = React.useRef<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const folderInputRef = React.useRef<HTMLInputElement>(null)

  const [conflictOpen, setConflictOpen] = React.useState(false)
  const [conflictNames, setConflictNames] = React.useState<string[]>([])
  const [conflictDirs, setConflictDirs] = React.useState<Set<string>>(new Set())
  const conflictResolveRef = React.useRef<((items: ConflictResolution) => void) | null>(null)

  const [shortcutOpen, setShortcutOpen] = React.useState(false)
  const [shortcutEntry, setShortcutEntry] = React.useState<Entry | null>(null)
  // 新建 / 编辑快捷方式的目标目录（搜索结果可能在别的目录里）
  const [shortcutBase, setShortcutBase] = React.useState("")

  // 右键「新建…」与「分享」（v1.2.1）
  const [newFileOpen, setNewFileOpen] = React.useState(false)
  const [newFileDir, setNewFileDir] = React.useState("")
  const [shareTarget, setShareTarget] = React.useState<Entry | null>(null)

  // 「文件任务」右侧折叠栏：默认完全隐藏，上传/压缩/解压开始时自动弹出
  const [tasksOpen, setTasksOpen] = React.useState(false)

  /**
   * 文件转换的目标清单（服务端下发，见 server/src/convert/registry.js）。
   * 前端不硬编码任何格式：服务端加一种新转换，这里自动多一个菜单项。
   * 权限关闭时（访客 / 超管关掉了转换）根本不发这个请求。
   */
  const [convertTargets, setConvertTargets] = React.useState<ConvertTarget[]>([])
  React.useEffect(() => {
    if (!me.perms.convertFiles) {
      setConvertTargets([])
      return
    }
    let alive = true
    fetchConvertTargets()
      .then((list) => { if (alive) setConvertTargets(list) })
      .catch(() => { if (alive) setConvertTargets([]) })
    return () => { alive = false }
  }, [me.perms.convertFiles])

  // 请求序号：快速连续切目录时，先发出的慢响应会覆盖后发出的结果，
  // 表现为「面包屑已经是 B，列表还是 A」并且 loading 提前结束。只认最新一次。
  const reqSeqRef = React.useRef(0)
  // 上一次播放入场动画的「目录或搜索」标识，用来避免刷新同一目录时重复播放
  const animatedKeyRef = React.useRef<string | null>(null)

  const refresh = React.useCallback(() => {
    const seq = ++reqSeqRef.current
    const stale = () => seq !== reqSeqRef.current
    setLoading(true)
    if (query) {
      api.get<{ results: SearchResult[] }>("/fs/search", { q: query, path: "" })
        .then((d) => { if (!stale()) setResults(d.results) })
        .catch((err) => { if (!stale()) toast.error((err as Error).message) })
        .finally(() => { if (!stale()) setLoading(false) })
    } else {
      api.get<{ path: string; entries: Entry[] }>("/fs/list", { path })
        .then((d) => {
          if (stale()) return
          setEntries(d.entries)
          // 只在「换目录 / 换搜索」时做一次入场动画。上传、删除、重命名之后都会
          // refresh，如果每次都重放，列表会不停闪烁，还白白创建一大批 tween。
          const animKey = query ? `q:${query}` : `p:${path}`
          if (animatedKeyRef.current !== animKey) {
            animatedKeyRef.current = animKey
            requestAnimationFrame(() => animateListIn(listRef.current))
          }
        })
        .catch((err) => {
          if (stale()) return
          toast.error((err as Error).message)
          setEntries([])
        })
        .finally(() => { if (!stale()) setLoading(false) })
    }
    setSelected(new Set())
    lastAnchorRef.current = null
    // groupContextId 变化时需要重新拉取（小组上下文收窄可见范围），虽未在函数体内直接引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, query, groupContextId])

  React.useEffect(refresh, [refresh])

  // 切换小组上下文后回到根目录（当前位置可能不在新上下文的可见范围内）。
  // 注意：setParams 的标识会随导航变化，因此必须用 ref 记录上一次的小组 id，
  // 只在小组真正变化时才重置，否则每次进入文件夹都会被弹回根目录。
  const prevGroupRef = React.useRef(groupContextId)
  React.useEffect(() => {
    if (prevGroupRef.current === groupContextId) return
    prevGroupRef.current = groupContextId
    setParams({})
  }, [groupContextId, setParams])
  React.useEffect(() => uploads.onCompleted((dest) => dest === path && refresh()), [uploads, path, refresh])
  // 压缩产物、解压结果与转换产物都直接落在当前目录，完成后都要刷新列表
  React.useEffect(
    () => operations.onCompleted((job) => job.status === "done" && (job.type === "extract" || job.type === "compress" || job.type === "convert") && refresh()),
    [operations, refresh]
  )

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

  const isCurrentSoft = sorted.length > 0 && sorted.every((e) => e.softReadOnly)

  /* ---------------- 列表虚拟滚动 / 网格渐进渲染（v2.0） ----------------
   * 列表行是等高的（高度只由 CSS 的 --row-py 与 text-sm 决定），所以量一次就能
   * 做窗口化渲染；网格卡片高度会随文件名换行变化，强制定高会裁内容，因此网格
   * 用"滚到底再追加一批"的渐进渲染。
   * 两者的切换键都是「当前目录 + 搜索词 + 视图」，换目录时滚动位置必须归零。 */
  const listKey = `${path}|${query}|${settings.view}|${settings.density}`
  // 滚动容器的 ref 由页面持有（而不是从 hook 返回），见 lib/virtual.ts 的说明
  const listScrollRef = React.useRef<HTMLDivElement | null>(null)
  const [rowHeight, setRowHeight] = React.useState(32)
  React.useEffect(() => {
    if (settings.view !== "list") return
    const el = listRef.current?.querySelector<HTMLElement>("[data-file-row]")
    const h = el?.offsetHeight || 0
    // 只在明显不同的时候 setState，避免每次渲染都触发一轮重排
    if (h > 0 && Math.abs(h - rowHeight) > 1) setRowHeight(h)
  }, [listKey, sorted.length, settings.view, rowHeight])
  const virt = useVirtualRows(listScrollRef, sorted.length, rowHeight, listKey)
  const grid = useProgressiveReveal(sorted.length, 120, listKey)
  const onGridScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    // 距底部还有一屏时就开始追加，滚动过程中不会出现空白等待
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - el.clientHeight) grid.revealMore()
  }

  const goto = (p: string) => setParams(p ? { path: p } : {})
  const displayName = (entry: Entry) => entry.shortcut?.displayName || entry.name
  /** 普通列表项按「当前目录 + 文件名」拼；搜索结果带 fullPath，必须原样使用 */
  const entryPath = (entry: Entry) => entry.fullPath ?? joinPath(path, entry.name)
  const entryParent = (entry: Entry) => {
    if (entry.fullPath === undefined) return path
    const i = entry.fullPath.lastIndexOf("/")
    return i < 0 ? "" : entry.fullPath.slice(0, i)
  }
  /** 搜索结果来自不同目录：转成带 fullPath 的 Entry，右键菜单才能作用到正确路径 */
  const searchEntry = (r: SearchResult): Entry => ({
    name: r.name,
    type: r.type,
    size: r.size,
    mtime: r.mtime,
    softReadOnly: r.softReadOnly,
    fullPath: r.path,
  })

  // 任务栏自动弹出：只要有新任务进入列表（上传 / 压缩 / 解压 / 链接下载）就打开；
  // 用户手动关掉后，后续没有新任务不会再弹，避免一直干扰。
  const taskTotal = uploads.jobs.length + operations.jobs.length
  const activeTaskCount =
    uploads.jobs.filter((j) => j.status === "uploading").length +
    operations.jobs.filter((j) => j.status === "running").length
  const prevTaskTotal = React.useRef(taskTotal)
  React.useEffect(() => {
    if (taskTotal > prevTaskTotal.current) setTasksOpen(true)
    prevTaskTotal.current = taskTotal
  }, [taskTotal])
  const handleShortcut = (entry: Entry) => {
    if (!entry.shortcut) {
      toast.error(t("ui.browser.shortcut_corrupt"))
      return false
    }
    const { targetType, targetUrl } = entry.shortcut
    if (!targetUrl) {
      toast.error(t("ui.browser.shortcut_target_empty"))
      return false
    }
    if (targetType === "path" || targetType === "soft_path") {
      goto(targetUrl)
    } else if (targetType === "soft_file" || targetType === "file") {
      if (me.perms.preview) {
        navigate(`/preview?path=${encodeURIComponent(targetUrl)}`)
      } else {
        triggerDownload(downloadUrl(targetUrl)).catch(() => {
          toast.error(t("ui.browser.target_missing_or_denied"))
        })
      }
    } else {
      goto(targetUrl)
    }
    return true
  }

  const handleOpenFile = (entry: Entry) => {
    if (entry.type === "shortcut") { handleShortcut(entry); return }
    const rel = entryPath(entry)
    const ext = (entry.name.split(".").pop() || "").toLowerCase()
    // 注意用 canPreview()：它同时认 Office（docx/xlsx/pptx）。
    // 旧实现只判 previewType()，Office 文件返回 null，双击于是直接变成下载 ——
    // 预览页里的 Office 分支永远走不到。
    if (canPreview(entry.name) && me.perms.preview) {
      if (ext === "html" || ext === "htm") {
        if (me.perms.htmlPreview) navigate(`/html-preview?path=${encodeURIComponent(rel)}`)
        else navigate(`/preview?path=${encodeURIComponent(rel)}`)
      } else {
        navigate(`/preview?path=${encodeURIComponent(rel)}`)
      }
    } else if (me.perms.downloadFile) {
      triggerDownload(downloadUrl(rel)).catch(() => {})
    }
  }

  const openEntry = (entry: Entry) => {
    if (entry.type === "shortcut") { handleShortcut(entry); return }
    if (entry.type === "dir") return goto(entryPath(entry))
    handleOpenFile(entry)
  }

  // 双击打开文件夹 / 预览文件。Base UI 的 render 合并会丢失 render 元素上的
  // onDoubleClick，因此通过 ref 绑定原生监听，保证交互稳定。
  const openEntryRef = React.useRef(openEntry)
  React.useEffect(() => {
    openEntryRef.current = openEntry
  })
  const dblClickRef = React.useCallback(
    (entry: Entry) => (node: HTMLDivElement | null) => {
      if (node) node.ondblclick = () => openEntryRef.current(entry)
    },
    []
  )

  const select = (entry: Entry, index: number, e: React.MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev)
      // 锚点用「名称」而不是下标：改变排序后下标会失效，shift 连选会圈出错误范围
      const anchorName = lastAnchorRef.current
      const anchorIndex = anchorName ? sorted.findIndex((s) => s.name === anchorName) : -1
      if (e.shiftKey && anchorIndex >= 0) {
        const [from, to] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)]
        for (let i = from; i <= to; i += 1) next.add(sorted[i].name)
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name)
      } else {
        if (next.size === 1 && next.has(entry.name)) { next.clear() } else { next.clear(); next.add(entry.name) }
      }
      return next
    })
    if (!e.shiftKey) lastAnchorRef.current = entry.name
  }

  const selectedEntries = sorted.filter((e) => selected.has(e.name))
  const targetsOf = (entry?: Entry) =>
    entry && (query || !selected.has(entry.name))
      ? [entry]
      : selectedEntries.length
        ? selectedEntries
        : entry
          ? [entry]
          : []

  const doDownload = (targets: Entry[]) => {
    if (targets.length === 1 && targets[0].type === "file") {
      if (!me.perms.downloadFile) return noPermToast()
      triggerDownload(downloadUrl(entryPath(targets[0]))).catch(() => {})
    } else if (targets.length) {
      if (!me.perms.downloadFolder) return noPermToast()
      triggerDownload(zipUrl(targets.map((tgt) => entryPath(tgt)))).catch(() => {})
    }
  }

  const doClipboard = (mode: "copy" | "cut", targets: Entry[]) => {
    if (!me.perms[mode === "copy" ? "copy" : "move"]) return noPermToast()
    if (mode === "cut" && anySoftReadOnly(targets)) return noPermSoftToast()
    clipboard.set(mode, targets.map((tgt) => ({ path: entryPath(tgt), name: tgt.name, type: tgt.type })))
    toast.info(
      mode === "copy"
        ? t("ui.browser.copied_count", { n: targets.length })
        : t("ui.browser.cut_count", { n: targets.length })
    )
  }

  const pastingRef = React.useRef(false)
  const doPaste = async () => {
    if (!clipboard.mode || !clipboard.items.length) return
    if (isCurrentSoft) return noPermSoftToast()
    if (!me.perms[clipboard.mode === "copy" ? "copy" : "move"]) return noPermToast()
    // 重入标志必须在**最外层**就置位：旧实现只在冲突处理回调里判断/置位，而那个
    // 回调要等 dlg 里用户点完"覆盖/合并/取消"才执行 —— 对话框开着的时候再按一次
    // Ctrl+V 就能挤进第二次粘贴，最终发出重复的 copy/move 请求（服务端会用
    // uniqueName 生成 "x (1)" 副本）。
    if (pastingRef.current) return
    pastingRef.current = true
    const release = () => { pastingRef.current = false }
    const names = clipboard.items.map((i) => i.name)
    const dirNames = new Set(clipboard.items.filter((i) => i.type === "dir").map((i) => i.name))
    resolveConflicts(names, dirNames, async (resolved) => {
      // 用户取消了冲突处理：必须原样中止。旧实现把它当成「没有冲突」，
      // 于是点取消反而照常执行 —— 剪切模式下文件是真的会被移走的。
      if (resolved === CONFLICT_CANCELLED) { release(); return }
      const skipSet = new Set(resolved.filter((r) => r.action === "skip").map((r) => r.name))
      const overwrite = resolved.some((r) => r.action === "overwrite")
      const renameMap = new Map(resolved.filter((r) => r.action === "rename" && r.resolvedName).map((r) => [r.name, r.resolvedName!]))
      const mergeSet = new Set(resolved.filter((r) => r.action === "merge").map((r) => r.name))
      const sources: string[] = []
      const mergeSources: string[] = []
      const targetNames: Record<string, string> = {}
      for (const item of clipboard.items) {
        if (skipSet.has(item.name)) continue
        if (mergeSet.has(item.name)) {
          mergeSources.push(item.path)
          continue
        }
        sources.push(item.path)
        // 「重命名」交给服务端做：把期望的目标名作为映射传过去，
        // 而不是把来源路径改成新名字（那样源文件根本不存在，必然 404）。
        const renamed = renameMap.get(item.name)
        if (renamed) targetNames[item.path] = renamed
      }
      const apiPath = `/fs/${clipboard.mode === "copy" ? "copy" : "move"}`
      const promises: Promise<unknown>[] = []
      if (sources.length) {
        promises.push(api.post(apiPath, {
          sources,
          dest: path,
          ...(overwrite ? { overwrite: true } : {}),
          ...(Object.keys(targetNames).length ? { targetNames } : {}),
        }))
      }
      if (mergeSources.length) {
        promises.push(api.post(apiPath, { sources: mergeSources, dest: path, merge: true }))
      }
      if (promises.length === 0) { release(); return }
      try {
        await Promise.all(promises)
        toast.success(clipboard.mode === "copy" ? t("ui.browser.copy_done") : t("ui.browser.move_done"))
        if (clipboard.mode === "cut") clipboard.clear()
      } catch (err) {
        toast.error((err as Error).message)
      } finally {
        release()
        // 成败都要刷新：失败前可能已经有部分条目完成，旧实现不刷新，
        // 用户会看到「报错但目录里多了一半文件」。
        refresh()
      }
    })
  }

  const doVisibility = async (entry: Entry, hidden: boolean) => {
    if (!me.perms.manageGuestVisibility) return noPermToast()
    try {
      await api.post("/fs/guest-visibility", { path: entryPath(entry), hidden })
      toast.success(hidden ? t("ui.browser.hidden_to_guest") : t("ui.browser.visible_to_guest")); refresh()
    } catch (err) { toast.error((err as Error).message) }
  }

  const doCompress = (targets: Entry[]) => {
    if (!me.perms.compressZip) return noPermToast()
    operations.startCompress(targets.map((tgt) => entryPath(tgt)))
  }

  const doExtract = (entry: Entry) => {
    if (!me.perms.extractZip) return noPermToast()
    if (isInSoftDir(entry)) return noPermSoftToast()
    operations.startExtract(entryPath(entry), entryParent(entry))
  }

  /**
   * 文件转换。
   * 产物由服务端写在源文件旁边（重名自动 (1)(2)），这里只负责发起任务 ——
   * 进度/成功/失败都在「文件任务」面板与 toast 里，和压缩解压是同一套体验。
   */
  const doConvert = (entry: Entry, target: ConvertTarget) => {
    if (!me.perms.convertFiles) return noPermToast()
    if (isInSoftDir(entry) || entry.softReadOnly) return noPermSoftToast()
    operations.startConvert(entryPath(entry), target.id, `${displayName(entry)} → .${target.to}`)
  }

  /** 转换项文案：有译文用译文，没有就用服务端给的 label（新转换器不补译文也能用） */
  const convertLabel = (target: ConvertTarget) => {
    if (!target.labelKey) return target.label
    const text = t(target.labelKey)
    return text === target.labelKey ? target.label : text
  }

  const doEdit = (entry: Entry) => {
    if (!me.perms.editFiles) return noPermToast()
    navigate(`/editor?path=${encodeURIComponent(entryPath(entry))}`)
  }

  const doHtmlPreview = (entry: Entry) => {
    if (!me.perms.htmlPreview) return noPermToast()
    navigate(`/html-preview?path=${encodeURIComponent(entryPath(entry))}`)
  }

  const openDialog = (kind: DialogKind, entry?: Entry) => {
    setDialogEntry(entry ?? null)
    // 搜索结果的父目录不是当前 path，删除/重命名必须以它自己的父目录为基准
    setDialogBase(entry ? entryParent(entry) : path)
    setDialog(kind)
  }

  const existingNames = React.useMemo(
    () => new Set(entries.map((e) => e.name)),
    [entries]
  )

  const existingDirNames = React.useMemo(
    () => new Set(entries.filter((e) => e.type === "dir").map((e) => e.name)),
    [entries]
  )

  const resolveConflicts = React.useCallback(
    (names: string[], dirNames: Set<string>, onResolved: (items: ConflictResolution) => void) => {
      const conflicts = detectConflicts(names, existingNames)
      if (conflicts.length === 0) {
        onResolved([])
        return
      }
      conflictResolveRef.current = onResolved
      setConflictNames(conflicts)
      setConflictDirs(new Set(conflicts.filter((n) => dirNames.has(n))))
      setConflictOpen(true)
    },
    [existingNames]
  )

  const readEntry = async (entry: FileSystemEntry, basePath = ""): Promise<File[]> => {
    const files: File[] = []
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject)
      })
      const pathName = basePath ? `${basePath}/${file.name}` : file.name
      files.push(new File([file], pathName, { type: file.type, lastModified: file.lastModified }))
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        const all: FileSystemEntry[] = []
        const readBatch = () => { reader.readEntries((batch) => { if (batch.length) { all.push(...batch); readBatch() } else resolve(all) }) }
        readBatch()
      })
      const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name
      for (const child of entries) {
        const childFiles = await readEntry(child, dirPath)
        files.push(...childFiles)
      }
    }
    return files
  }

  // 上传的重入保护：与粘贴同理，冲突对话框开着的时候再来一次拖拽/选择，
  // 旧实现会真的发起第二轮上传（同名文件被写成 "x (1)"）。
  const uploadingRef = React.useRef(false)
  const handleUpload = React.useCallback(
    (files: File[]) => {
      if (!files.length || !me.perms.upload) return
      if (sorted.length > 0 && sorted.every((en) => en.softReadOnly)) { noPermSoftToast(); return }
      if (uploadingRef.current) return
      uploadingRef.current = true
      const release = () => { uploadingRef.current = false }
      const hasPaths = files.some((f) => f.name.includes("/"))
      if (hasPaths) {
        const rootFolders = new Set<string>()
        for (const f of files) {
          const slash = f.name.indexOf("/")
          if (slash > 0) rootFolders.add(f.name.slice(0, slash))
        }
        if (me.perms.uploadFolders) {
          resolveConflicts([...rootFolders], existingDirNames, (resolved) => {
            if (resolved === CONFLICT_CANCELLED) { release(); return }
            const skipSet = new Set(resolved.filter((r) => r.action === "skip").map((r) => r.name))
            if (skipSet.size === rootFolders.size) { release(); return }
            // 文件夹级的「覆盖 / 合并」都表示：同名文件用新版本替换，其余原样写入。
            // 旧实现把顶层文件夹名塞进 overwrite 列表，而服务端只拿它匹配文件 basename，
            // 于是两个选项都静默失效 —— 同名文件被存成了 "x (1).txt"。
            const replaceRoots = new Set(
              resolved.filter((r) => r.action === "overwrite" || r.action === "merge").map((r) => r.name)
            )
            const renameMap = new Map(resolved.filter((r) => r.action === "rename" && r.resolvedName).map((r) => [r.name, r.resolvedName!]))
            const overwriteNames: string[] = []
            const processed: File[] = []
            for (const f of files) {
              const slash = f.name.indexOf("/")
              const root = slash > 0 ? f.name.slice(0, slash) : f.name
              if (skipSet.has(root)) continue
              if (renameMap.has(root) && slash > 0) {
                processed.push(new File([f], renameMap.get(root)! + f.name.slice(slash), { type: f.type, lastModified: f.lastModified }))
                continue
              }
              processed.push(f)
              // 传完整相对路径：服务端会同时按 basename 与相对路径匹配，
              // 命中的替换、未命中的本来就写不冲突
              if (replaceRoots.has(root)) overwriteNames.push(f.name)
            }
            if (processed.length === 0) { release(); return }
            uploads.start(path, processed, overwriteNames.length ? { overwrite: overwriteNames } : undefined)
            release()
          })
          return
        }
      }
      const names = files.map((f) => f.name)
      resolveConflicts(names, new Set(), (resolved) => {
        if (resolved === CONFLICT_CANCELLED) { release(); return }
        if (!resolved.length) {
          uploads.start(path, files)
          release()
          return
        }
        const skipSet = new Set(resolved.filter((r) => r.action === "skip").map((r) => r.name))
        const overwriteNames = resolved.filter((r) => r.action === "overwrite").map((r) => r.name)
        const renameMap = new Map(resolved.filter((r) => r.action === "rename" && r.resolvedName).map((r) => [r.name, r.resolvedName!]))

        const processed: File[] = []
        for (const file of files) {
          if (skipSet.has(file.name)) continue
          if (renameMap.has(file.name)) {
            processed.push(new File([file], renameMap.get(file.name)!, { type: file.type, lastModified: file.lastModified }))
          } else {
            processed.push(file)
          }
        }
        if (processed.length === 0) { release(); return }
        uploads.start(path, processed, overwriteNames.length ? { overwrite: overwriteNames } : undefined)
        release()
      })
    },
    // existingDirNames 必须进依赖：resolveConflicts 的 dirNames 是**参数**，
    // 但这里的闭包捕获的是渲染时的那个集合；漏掉它会让"已存在同名文件夹"的
    // 判断用到过期数据（把文件夹冲突当文件冲突，只能覆盖、不能合并）。
    // （sorted 刻意不入依赖：React Compiler 无法证明它稳定，会直接放弃整个组件的
    //   memo 优化并报错；只读映射的判断在 onDrop 等非记忆化路径上另有一层兜底。）
    [path, me.perms.upload, me.perms.uploadFolders, resolveConflicts, uploads, existingDirNames]
  )

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    if (!me.perms.upload) return noPermToast()
    // 搜索模式下 onDragOver 不显示"松开以上传"遮罩，这里也必须一致地拒绝：
    // 否则拖进去会静默上传到 path（而 path 在搜索模式下是空的/上一次的目录），
    // 用户完全不知道文件去了哪里。
    if (query) {
      toast.warning(t("ui.browser.upload_blocked_in_search"))
      return
    }
    if (sorted.length > 0 && sorted.every((en) => en.softReadOnly)) return noPermSoftToast()
    const items = e.dataTransfer.items
    if (items && items.length) {
      // 注意：必须在 drop 事件同步阶段读取所有条目，异步阶段浏览器会使其失效
      const pending: Promise<File[]>[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind !== "file") continue
        const entry = item.webkitGetAsEntry?.()
        if (entry) {
          pending.push(readEntry(entry).catch(() => []))
        } else {
          const f = item.getAsFile()
          if (f) pending.push(Promise.resolve([f]))
        }
      }
      if (pending.length) {
        void Promise.all(pending).then((groups) => {
          const files = groups.flat()
          if (files.length) handleUpload(files)
        })
      }
    } else {
      const fileList = e.dataTransfer.files
      if (fileList.length) handleUpload(Array.from(fileList))
    }
  }

  const submitSearch = () => {
    const q = searchText.trim()
    if (q) setParams({ q })
    else setParams(path ? { path } : {})
  }

  // 快捷键。
  // 用 ref 保存「最新一版」handler、监听器只绑定一次：旧实现把 handler 直接绑在 window
  // 上，依赖数组是 [selected, sorted, me.perms] 而漏了 clipboard —— 于是 Ctrl+C 之后
  // 立刻按 Ctrl+V，跑的还是复制之前那一版闭包（里面 clipboard.mode 仍是 null），
  // 表现为「快捷键时灵时不灵」，而工具栏上的粘贴按钮却正常。
  const keyHandlerRef = React.useRef<(e: KeyboardEvent) => void>(() => {})
  React.useEffect(() => {
    keyHandlerRef.current = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const key = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey

      if (key === "f2" && selected.size === 1) {
        e.preventDefault()
        const entry = sorted.find((en) => selected.has(en.name))
        if (entry && me.perms.rename && !entry.softReadOnly) openDialog("rename", entry)
        else if (entry?.softReadOnly) noPermSoftToast()
        else if (entry) noPermToast()
      }
      if (key === "delete" && selected.size > 0) {
        e.preventDefault()
        if (me.perms.delete && !anySoftReadOnly(selectedEntries)) openDialog("delete")
        else if (anySoftReadOnly(selectedEntries)) noPermSoftToast()
        else noPermToast()
      }
      if (mod && key === "a") {
        e.preventDefault()
        setSelected(new Set(sorted.map((en) => en.name)))
        lastAnchorRef.current = sorted.length ? sorted[sorted.length - 1].name : null
      }
      if (mod && key === "c" && selected.size > 0) {
        e.preventDefault()
        if (me.perms.copy) doClipboard("copy", selectedEntries)
        else noPermToast()
      }
      if (mod && key === "x" && selected.size > 0) {
        e.preventDefault()
        if (me.perms.move && !anySoftReadOnly(selectedEntries)) doClipboard("cut", selectedEntries)
        else if (anySoftReadOnly(selectedEntries)) noPermSoftToast()
        else noPermToast()
      }
      if (mod && key === "v") {
        e.preventDefault(); doPaste()
      }
      if (key === "enter" && selected.size === 1) {
        const entry = sorted.find((en) => selected.has(en.name))
        if (entry) {
          if (entry.type === "dir") openEntry(entry)
          else handleOpenFile(entry)
        }
      }
    }
  })
  React.useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  const crumbs = path ? path.split("/") : []

  // 新建文本文档：文件名按当前界面语言生成（服务端只收到最终字符串）
  const handleCreateTextFile = async (dir: string) => {
    const created = await createTextFileWithDefault(dir, t("ui.create.text_file_default"))
    if (!created) return
    toast.success(t("ui.create.created", { name: created }))
    refresh()
  }

  // ---------- 新建… 子菜单（文件夹右键与空白处右键共用） ----------
  const newSubmenu = (dir: string, key: string) => {
    const canCreate = me.perms.upload && !isCurrentSoft
    return (
      <ContextMenuSub key={key}>
        <ContextMenuSubTrigger>
          <Icon name="file-plus" /> {t("ui.create.menu")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem
            onClick={() => {
              if (!canCreate) return noPermToast()
              void handleCreateTextFile(dir)
            }}
          >
            <Icon name="file-text" /> {t("ui.create.text_file")}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              if (!canCreate) return noPermToast()
              setNewFileDir(dir)
              setNewFileOpen(true)
            }}
          >
            <Icon name="file-plus-2" /> {t("ui.create.custom_file")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              if (!me.perms.downloadUrl) return noPermToast()
              // 现在不再弹一个独立对话框，直接带着当前目录跳到「工具 → 多线程下载器」，
              // 用户填完链接就能开始，同时能在同一页看见进度。
              const query = new URLSearchParams({ tab: "downloader" })
              if (dir) query.set("dest", dir)
              navigate(`/tools?${query.toString()}`)
            }}
          >
            <Icon name="download" /> {t("ui.create.download_task")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    )
  }

  // ---------- 上下文菜单内容（提取为函数，供三个点和右键共用） ----------
  // 排序原则：高频动作在上，破坏性动作（删除）永远在最后；
  // 「新建…」只出现在文件夹上 —— 在文件上它其实是在当前目录新建，容易误点。
  const buildMenuItems = (entry: Entry) => {
    const targets = targetsOf(entry)
    const single = targets.length === 1
    const items: React.ReactNode[] = []
    let pendingSep = false
    const markSep = () => {
      if (items.length) pendingSep = true
    }
    const push = (node: React.ReactNode) => {
      if (pendingSep && items.length) items.push(<ContextMenuSeparator key={`sep-${items.length}`} />)
      pendingSep = false
      items.push(node)
    }

    const entryExt = (entry.name.split(".").pop() || "").toLowerCase()
    const canShare = entry.type === "dir" ? me.perms.downloadFolder : me.perms.downloadFile

    // ---- 1. 打开 / 新建（文件夹内新建）----
    if (single) {
      push(
        <ContextMenuItem key="open" onClick={() => openEntry(entry)}>
          <Icon name={entry.type === "dir" ? "folder-open" : "external-link"} /> {t("ui.common.open")}
        </ContextMenuItem>
      )
    }
    if (single && entry.type === "dir") {
      push(newSubmenu(entryPath(entry), "newsub"))
    }

    // ---- 2. 预览类（仅文件）----
    if (single && entry.type === "file" && canPreview(entry.name)) {
      push(
        <ContextMenuItem key="preview" disabled={!me.perms.preview} onClick={() => { if (!me.perms.preview) noPermToast(); else handleOpenFile(entry) }}>
          <Icon name="eye" /> {t("ui.common.preview")}
        </ContextMenuItem>
      )
    }
    if (single && entry.type === "file" && (entryExt === "html" || entryExt === "htm")) {
      push(
        <ContextMenuItem key="htmlpreview" disabled={!me.perms.htmlPreview} onClick={() => { if (!me.perms.htmlPreview) noPermToast(); else doHtmlPreview(entry) }}>
          <Icon name="globe" /> {t("ui.browser.html_preview")}
        </ContextMenuItem>
      )
    }

    // ---- 3. 下载 / 分享 ----
    push(
      <ContextMenuItem key="download" disabled={single && entry.type === "file" ? !me.perms.downloadFile : !me.perms.downloadFolder} onClick={() => { doDownload(targets) }}>
        <Icon name="download" /> {t("ui.common.download")}{!single || entry.type === "dir" ? " (Zip)" : ""}
      </ContextMenuItem>
    )
    if (single && me.role !== "guest") {
      push(
        <ContextMenuItem key="share" disabled={!canShare} onClick={() => { if (!canShare) return noPermToast(); setShareTarget(entry) }}>
          <Icon name="share-2" /> {t("ui.share.menu")}
        </ContextMenuItem>
      )
    }

    // ---- 4. 编辑 / 重命名 ----
    markSep()
    if (single && entry.type === "file" && EDITABLE.includes(entryExt)) {
      push(
        <ContextMenuItem key="edit" disabled={!me.perms.editFiles || entry.softReadOnly} onClick={() => { if (entry.softReadOnly) noPermSoftToast(); else if (!me.perms.editFiles) noPermToast(); else doEdit(entry) }}>
          <Icon name="pencil-line" /> {t("ui.browser.edit_online")}
        </ContextMenuItem>
      )
    }
    if (single && entry.type === "shortcut") {
      push(
        <ContextMenuItem key="editShortcut" disabled={entry.softReadOnly} onClick={() => { if (entry.softReadOnly) noPermSoftToast(); else { setShortcutEntry(entry); setShortcutBase(entryParent(entry)); setShortcutOpen(true) } }}>
          <Icon name="pencil-line" /> {t("ui.browser.edit_shortcut")}
        </ContextMenuItem>
      )
    }
    if (single) {
      push(
        <ContextMenuItem key="rename" disabled={!me.perms.rename || entry.softReadOnly} onClick={() => { if (entry.softReadOnly) noPermSoftToast(); else if (!me.perms.rename) noPermToast(); else openDialog("rename", entry) }}>
          <Icon name="pencil-line" /> {t("ui.common.rename")}
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
      )
    }

    // ---- 5. 剪贴板类 ----
    markSep()
    push(
      <ContextMenuItem key="copy" disabled={!me.perms.copy} onClick={() => { if (!me.perms.copy) noPermToast(); else doClipboard("copy", targets) }}>
        <Icon name="copy" /> {t("ui.common.copy")}
        <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
      </ContextMenuItem>
    )
    push(
      <ContextMenuItem key="cut" disabled={!me.perms.move || anySoftReadOnly(targets)} onClick={() => { if (anySoftReadOnly(targets)) noPermSoftToast(); else if (!me.perms.move) noPermToast(); else doClipboard("cut", targets) }}>
        <Icon name="scissors" /> {t("ui.browser.cut")}
        <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
      </ContextMenuItem>
    )
    if (me.perms.copy) {
      push(<ContextMenuItem key="copyto" onClick={() => { setSelected(new Set(targets.map((tgt) => tgt.name))); setPickerPaths(targets.map((tgt) => entryPath(tgt))); setPicker("copy") }}><Icon name="copy-plus" /> {t("ui.browser.copy_to")}</ContextMenuItem>)
    } else {
      push(<ContextMenuItem key="copyto-d" disabled onClick={noPermToast}><Icon name="copy-plus" /> {t("ui.browser.copy_to")}</ContextMenuItem>)
    }
    if (me.perms.move && !anySoftReadOnly(targets)) {
      push(<ContextMenuItem key="moveto" onClick={() => { setSelected(new Set(targets.map((tgt) => tgt.name))); setPickerPaths(targets.map((tgt) => entryPath(tgt))); setPicker("move") }}><Icon name="folder-input" /> {t("ui.browser.move_to")}</ContextMenuItem>)
    } else {
      push(<ContextMenuItem key="moveto-d" disabled onClick={anySoftReadOnly(targets) ? noPermSoftToast : noPermToast}><Icon name="folder-input" /> {t("ui.browser.move_to")}</ContextMenuItem>)
    }
    push(
      <ContextMenuSub key="copyAs">
        <ContextMenuSubTrigger>
          <Icon name="clipboard-copy" /> {t("ui.browser.copy_submenu")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => copyText(targets.map((tgt) => displayName(tgt)).join("\n"), t("ui.browser.copied_name"))}>
            {t("ui.common.copy_name")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copyText(targets.map((tgt) => entryPath(tgt)).join("\n"), t("ui.browser.copied_relative_path"))}>
            {t("ui.browser.copy_relative_path")}
          </ContextMenuItem>
          {single && entry.type === "file" && (
            <ContextMenuItem onClick={() => copyText(new URL(downloadUrl(entryPath(entry)), window.location.origin).href, t("ui.browser.copied_download_link"))}>
              {t("ui.browser.copy_download_link")}
            </ContextMenuItem>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    )

    // ---- 6. 压缩 / 解压 / 快捷方式 ----
    markSep()
    if (single && entry.type === "file" && entry.name.toLowerCase().endsWith(".zip")) {
      push(
        <ContextMenuItem key="extract" disabled={!me.perms.extractZip || entry.softReadOnly} onClick={() => { if (entry.softReadOnly) noPermSoftToast(); else if (!me.perms.extractZip) noPermToast(); else doExtract(entry) }}>
          <Icon name="folder-open" /> {t("ui.browser.extract_here")}
        </ContextMenuItem>
      )
    }
    if (single && entry.type === "dir") {
      push(
        <ContextMenuItem key="compressDir" disabled={!me.perms.compressZip} onClick={() => { if (!me.perms.compressZip) noPermToast(); else doCompress([entry]) }}>
          <Icon name="folder-archive" /> {t("ui.browser.compress_zip")}
        </ContextMenuItem>
      )
    }
    if (!single) {
      push(
        <ContextMenuItem key="compress" disabled={!me.perms.compressZip} onClick={() => { if (!me.perms.compressZip) noPermToast(); else doCompress(targets) }}>
          <Icon name="folder-archive" /> {t("ui.browser.compress_selected_zip")}
        </ContextMenuItem>
      )
    }
    // 文件转换：子项按服务端下发的清单动态生成（前端不硬编码格式），
    // 因此"服务端加一种转换"在界面上会自动出现，见 server/src/convert/registry.js
    if (single && entry.type === "file") {
      const targetsForExt = convertTargets.filter((target) => target.from.includes(entryExt))
      if (targetsForExt.length) {
        push(
          <ContextMenuSub key="convert">
            <ContextMenuSubTrigger disabled={!me.perms.convertFiles}>
              <Icon name="file-output" /> {t("ui.browser.convert_to")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {targetsForExt.map((target) => (
                <ContextMenuItem
                  key={target.id}
                  disabled={entry.softReadOnly}
                  onClick={() => doConvert(entry, target)}
                >
                  {convertLabel(target)}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )
      }
    }
    if (single && entry.type !== "shortcut") {
      push(
        <ContextMenuItem key="createShortcut" onClick={() => { setShortcutEntry(entry); setShortcutBase(entryParent(entry)); setShortcutOpen(true) }}>
          <Icon name="link" /> {t("ui.browser.create_shortcut")}
        </ContextMenuItem>
      )
    }

    // ---- 7. 可见性 / 信息 / 删除 ----
    markSep()
    if (single && entry.type === "dir") {
      push(
        <ContextMenuItem key="hide" disabled={!me.perms.manageGuestVisibility} onClick={() => { if (!me.perms.manageGuestVisibility) noPermToast(); else doVisibility(entry, !entry.hiddenFromGuest) }}>
          <Icon name={entry.hiddenFromGuest ? "eye" : "eye-off"} /> {entry.hiddenFromGuest ? t("ui.browser.make_visible_to_guest") : t("ui.browser.hide_from_guest")}
        </ContextMenuItem>
      )
    }
    if (single) {
      push(
        <ContextMenuItem key="details" disabled={!me.perms.details} onClick={() => { if (!me.perms.details) noPermToast(); else openDialog("details", entry) }}>
          <Icon name="info" /> {t("ui.browser.details")}
        </ContextMenuItem>
      )
    }
    markSep()
    push(
      <ContextMenuItem key="delete" variant="destructive" disabled={!me.perms.delete || anySoftReadOnly(targets)} onClick={() => { if (anySoftReadOnly(targets)) noPermSoftToast(); else if (!me.perms.delete) noPermToast(); else { setSelected(new Set(targets.map((tgt) => tgt.name))); openDialog("delete", entry) } }}>
        <Icon name="trash-2" /> {t("ui.common.delete")}
        <ContextMenuShortcut>Delete</ContextMenuShortcut>
      </ContextMenuItem>
    )
    return items
  }

  // ---------- 空白处右键菜单（挂在列表容器上的那个 ContextMenu） ----------
  const buildEmptyMenuItems = () => {
    const items: React.ReactNode[] = []
    const canPaste = !!clipboard.mode && clipboard.items.length > 0 && !isCurrentSoft
    items.push(
      <ContextMenuItem key="upload" disabled={!canUpload} onClick={() => { if (!canUpload) noPermToast(); else fileInputRef.current?.click() }}>
        <Icon name="upload" /> {t("ui.browser.upload_files")}
      </ContextMenuItem>,
      <ContextMenuItem key="uploadFolder" disabled={!canUpload || !me.perms.uploadFolders} onClick={() => { if (!canUpload) noPermToast(); else folderInputRef.current?.click() }}>
        <Icon name="folder-up" /> {t("ui.browser.upload_folder")}
      </ContextMenuItem>,
      <ContextMenuItem key="mkdir" disabled={!canMkdir} onClick={() => { if (!canMkdir) noPermToast(); else openDialog("newFolder") }}>
        <Icon name="folder-plus" /> {t("ui.browser.new_folder")}
      </ContextMenuItem>,
      newSubmenu(path, "newsub"),
      <ContextMenuItem key="paste" disabled={!canPaste} onClick={() => { if (!canPaste) noPermToast(); else void doPaste() }}>
        <Icon name="clipboard-paste" /> {clipboard.items.length ? t("ui.browser.paste_n_items", { n: clipboard.items.length }) : t("ui.browser.paste")}
        <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
      </ContextMenuItem>
    )
    items.push(<ContextMenuSeparator key="s1" />)
    items.push(
      <ContextMenuItem key="selectAll" disabled={!sorted.length} onClick={() => {
        setSelected(new Set(sorted.map((e) => e.name)))
        lastAnchorRef.current = sorted.length ? sorted[sorted.length - 1].name : null
      }}>
        <Icon name="square-check-big" /> {t("ui.common.select_all")}
        <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
      </ContextMenuItem>,
      <ContextMenuItem key="invert" disabled={!sorted.length} onClick={() => setSelected((prev) => new Set(sorted.filter((e) => !prev.has(e.name)).map((e) => e.name)))}>
        <Icon name="square-dashed" /> {t("ui.common.invert_selection")}
      </ContextMenuItem>,
      <ContextMenuItem key="clearSel" disabled={!selected.size} onClick={() => setSelected(new Set())}>
        <Icon name="x" /> {t("ui.common.deselect")}
      </ContextMenuItem>
    )
    items.push(<ContextMenuSeparator key="s2" />)
    items.push(
      <ContextMenuItem key="refresh" onClick={refresh}>
        <Icon name="refresh-cw" /> {t("ui.common.refresh")}
      </ContextMenuItem>,
      <ContextMenuSub key="sort">
        <ContextMenuSubTrigger>
          <Icon name="arrow-up-down" /> {t("ui.browser.sort_menu")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => settings.update({ sortBy: "name" })}>{t("ui.browser.sort_by_name")}</ContextMenuItem>
          <ContextMenuItem onClick={() => settings.update({ sortBy: "size" })}>{t("ui.browser.sort_by_size")}</ContextMenuItem>
          <ContextMenuItem onClick={() => settings.update({ sortBy: "mtime" })}>{t("ui.browser.sort_by_mtime")}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => settings.update({ sortDir: settings.sortDir === "asc" ? "desc" : "asc" })}>
            {settings.sortDir === "asc" ? t("ui.browser.sort_desc") : t("ui.browser.sort_asc")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => settings.update({ foldersFirst: !settings.foldersFirst })}>
            {settings.foldersFirst ? t("ui.browser.folders_first_off") : t("ui.browser.folders_first_on")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>,
      <ContextMenuSub key="view">
        <ContextMenuSubTrigger>
          <Icon name="layout-grid" /> {t("ui.browser.view")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => settings.update({ view: "list" })}>{t("ui.browser.view_list")}</ContextMenuItem>
          <ContextMenuItem onClick={() => settings.update({ view: "grid" })}>{t("ui.browser.view_grid")}</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    )
    items.push(<ContextMenuSeparator key="s3" />)
    items.push(
      <ContextMenuItem key="zipHere" disabled={!me.perms.downloadFolder || !path} onClick={() => { if (!me.perms.downloadFolder) noPermToast(); else triggerDownload(zipUrl([path])).catch(() => {}) }}>
        <Icon name="folder-archive" /> {t("ui.browser.zip_current_dir")}
      </ContextMenuItem>,
      <ContextMenuItem key="shortcut" disabled={!canUpload} onClick={() => { if (!canUpload) noPermToast(); else { setShortcutEntry(null); setShortcutBase(path); setShortcutOpen(true) } }}>
        <Icon name="link" /> {t("ui.browser.create_shortcut")}
      </ContextMenuItem>,
      <ContextMenuItem key="copyPath" onClick={() => copyText(path ? `/${path}` : "/", t("ui.browser.copied_current_path"))}>
        <Icon name="clipboard-copy" /> {t("ui.browser.copy_current_path")}
      </ContextMenuItem>,
      <ContextMenuItem key="details" onClick={() => { setDialogEntry(null); setDialog("details") }}>
        <Icon name="info" /> {t("ui.browser.current_dir_details")}
      </ContextMenuItem>
    )
    return items
  }

  const entryMenu = (entry: Entry) => (
    <ContextMenuContent className="w-52">{buildMenuItems(entry)}</ContextMenuContent>
  )

  // 文件悬浮提示
  const HoverInfo = ({ entry }: { entry: Entry }) => {
    const kind = fileKind(entry.name, entry.type, undefined, entry.shortcut?.logo)
    return (
      <div className="grid gap-0.5">
        <p className="text-xs font-medium">{displayName(entry)}</p>
        <p className="text-[10px] text-muted-foreground">
          {kind.label}{entry.type === "file" ? ` · ${formatBytes(entry.size)}` : ""}
        </p>
        <p className="text-[10px] text-muted-foreground">{formatDate(entry.mtime)}</p>
        {entry.hiddenFromGuest && me.role !== "guest" && <p className="text-[10px] text-muted-foreground">{t("ui.browser.hide_from_guest")}</p>}
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
    const kind = fileKind(entry.name, entry.type, entry.softReadOnly, entry.shortcut?.logo)
    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger render={<div />}>
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  ref={dblClickRef(entry)}
                  data-animate-item
                  data-file-row
                  className={cn(
                    "group dense-row flex cursor-default items-center gap-3 rounded-md px-2 transition-colors select-none",
                    isSelected ? "bg-accent" : "hover:bg-muted/70"
                  )}
                  onClick={(e) => select(entry, index, e)}
                />
              }
            >
              <Icon name={kind.icon} className={cn("size-4 shrink-0", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")} />
              <div className="min-w-0 flex-1"><span className="block truncate text-sm">{displayName(entry)}</span></div>
              {entry.hiddenFromGuest && me.role !== "guest" && <Icon name="eye-off" className="hidden size-3 shrink-0 text-muted-foreground sm:block" />}
              <span className="hidden w-18 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
                {entry.type === "dir" ? t("ui.common.folder") : formatBytes(entry.size)}
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
    const kind = fileKind(entry.name, entry.type, entry.softReadOnly, entry.shortcut?.logo)
    const isSelected = selected.has(entry.name)
    return (
      <ContextMenu key={entry.name}>
        <ContextMenuTrigger render={<div />}>
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  ref={dblClickRef(entry)}
                  data-animate-item
                  className={cn(
                    "edge-highlight flex cursor-default flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 transition-all select-none",
                    isSelected ? "border-ring bg-accent" : "hover:bg-muted/60"
                  )}
                  onClick={(e) => select(entry, index, e)}
                />
              }
            >
              {/* 图片走缩略图（服务端 webp 小图），其它类型仍是图标；
                  固定 h-16 让两种卡片高度一致，网格滚动更稳 */}
              <div className="flex h-16 w-full items-center justify-center overflow-hidden">
                {entry.type === "file" && isThumbSourceName(entry.name) ? (
                  <EntryThumb
                    path={entry.fullPath ?? joinPath(path, entry.name)}
                    name={displayName(entry)}
                    icon={kind.icon}
                    alt={displayName(entry)}
                  />
                ) : (
                  <Icon name={kind.icon} className={cn("size-9", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")} strokeWidth={1.5} />
                )}
              </div>
              <span className="w-full truncate text-center text-xs" title={displayName(entry)}>{displayName(entry)}</span>
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

  const canUpload = me.perms.upload && !isCurrentSoft
  const canMkdir = me.perms.mkdir && !isCurrentSoft

  return (
    <AppShell>
      <div
        className="browser-main flex min-h-0 flex-1 flex-col px-3 pt-3 pb-2 sm:px-5"
        onDragOver={(e) => { e.preventDefault(); if (canUpload && !query) setDragOver(true) }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
        onDrop={onDrop}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
          {/* 工具栏 */}
          <div className="watch-toolbar mb-3 flex flex-wrap items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" disabled={!canUpload} title={t("ui.common.upload")} />}>
                <Icon name="upload" /> <span className="watch-btn-label">{t("ui.common.upload")}…</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem disabled={!canUpload} onClick={() => { if (!canUpload) return noPermToast(); fileInputRef.current?.click() }}>
                  <Icon name="file-up" /> {t("ui.browser.upload_files")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canUpload || !me.perms.uploadFolders} onClick={() => { if (!canUpload) return noPermToast(); folderInputRef.current?.click() }}>
                  <Icon name="folder-up" /> {t("ui.browser.upload_folder")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" title={t("ui.create.menu")} disabled={!canMkdir && !canUpload} />}>
                <Icon name="plus" /> <span className="watch-btn-label">{t("ui.create.menu")}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem disabled={!canMkdir} onClick={() => { if (!canMkdir) return noPermToast(); openDialog("newFolder") }}>
                  <Icon name="folder-plus" /> {t("ui.browser.new_folder")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canUpload} onClick={() => { if (!canUpload) return noPermToast(); void handleCreateTextFile(path) }}>
                  <Icon name="file-text" /> {t("ui.create.text_file")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canUpload} onClick={() => { if (!canUpload) return noPermToast(); setNewFileDir(path); setNewFileOpen(true) }}>
                  <Icon name="file-plus-2" /> {t("ui.create.custom_file")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant={tasksOpen ? "secondary" : "outline"}
              aria-expanded={tasksOpen}
              title={t("ui.tasks.title")}
              onClick={() => setTasksOpen((v) => !v)}
            >
              <Icon name="list-checks" /> <span className="watch-btn-label">{t("ui.tasks.title")}</span>
              {activeTaskCount > 0 && (
                <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground tabular-nums">
                  {activeTaskCount}
                </span>
              )}
            </Button>
            {/* 桌面端搜索框 */}
            <div className="relative ml-2 hidden sm:block">
              <Icon name="search" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchText}
                placeholder={t("ui.browser.search_placeholder")}
                className="h-8 w-44 rounded-md border border-input bg-background pl-8 text-sm shadow-sm transition-all focus:w-56 hover:border-ring"
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitSearch() }}
              />
            </div>
            {clipboard.mode && clipboard.items.length > 0 && !isCurrentSoft && (
              <Button size="sm" variant="secondary" title={t("ui.browser.paste_n_items", { n: clipboard.items.length })} onClick={doPaste}>
                <Icon name="clipboard-paste" /> <span className="watch-btn-label">{t("ui.browser.paste_n_items", { n: clipboard.items.length })}</span>
              </Button>
            )}
            <div className="watch-toolbar-extra ml-auto flex items-center gap-1">
              <Button size="icon-sm" variant="ghost" aria-label={t("ui.common.refresh")} onClick={refresh}><Icon name="refresh-cw" /></Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t("ui.browser.sort_label")} />}><Icon name="arrow-up-down" /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(["name", "size", "mtime"] as const).map((key) => (
                    <DropdownMenuItem key={key} onClick={() => settings.update(settings.sortBy === key ? { sortDir: settings.sortDir === "asc" ? "desc" : "asc" } : { sortBy: key, sortDir: "asc" })}>
                      <Icon name={settings.sortBy === key ? (settings.sortDir === "asc" ? "arrow-up" : "arrow-down") : "minus"} />
                      {t({ name: "ui.browser.sort_by_name", size: "ui.browser.sort_by_size", mtime: "ui.browser.sort_by_mtime" }[key])}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="icon-sm" variant="ghost" aria-label={t("ui.browser.toggle_view")} onClick={() => settings.update({ view: settings.view === "list" ? "grid" : "list" })}>
                <Icon name={settings.view === "list" ? "layout-grid" : "list"} />
              </Button>
            </div>
          </div>

          {/* 面包屑 */}
          {!query && (
            <div className="watch-crumbs mb-3 flex flex-wrap items-center gap-1 text-sm">
              <button className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => goto("")}>
                <Icon name="house" className="size-3.5" /> {t("ui.browser.root_dir")}
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
            <div className="watch-query mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="search" className="size-4" /> “{query}”（{results.length}）
              <Button size="xs" variant="ghost" onClick={() => setParams({})}><Icon name="x" /> {t("ui.common.clear")}</Button>
            </div>
          )}

          {/* 文件列表（填满高度）。整块挂一个 ContextMenu：行自带的菜单会 stopPropagation，
              所以空白处右键自然落到这里 —— 不必再靠 className 猜「是不是背景」 */}
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div className={cn("edge-highlight relative flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card", dragOver && "border-ring")} />
              }
            >
              <div
                ref={listRef}
                className="flex min-h-0 flex-1 flex-col"
                onClick={(e) => { if (e.target === e.currentTarget) setSelected(new Set()) }}
              >
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/80">
                <div className="flex items-center gap-2 text-sm font-medium"><Icon name="upload" className="size-5" /> {t("ui.browser.drop_to_upload")}</div>
              </div>
            )}
            {loading ? (
              <div className="flex flex-1 items-center justify-center"><Spinner className="size-5" /></div>
            ) : query ? (
              results.length === 0 ? (<EmptyState icon="search-x" title={t("ui.browser.search_empty_title")} desc={t("ui.browser.search_empty_desc")} />) : (
                <div className="flex-1 overflow-auto p-2">
                  {results.map((r) => {
                    const entry = searchEntry(r)
                    return (
                      <ContextMenu key={r.path}>
                        <ContextMenuTrigger render={<div />}>
                          <div
                            className="flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/70"
                            onDoubleClick={() => openEntry(entry)}
                          >
                            <Icon name={fileKind(r.name, r.type, r.softReadOnly).icon} className="size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">{r.name}</p>
                              <button className="block max-w-full truncate text-xs text-muted-foreground hover:underline" onClick={() => goto(r.parent)}>/{r.parent || t("ui.browser.root_dir")}</button>
                            </div>
                            <span className="w-18 shrink-0 text-right text-xs text-muted-foreground">{r.type === "dir" ? t("ui.common.folder") : formatBytes(r.size)}</span>
                          </div>
                        </ContextMenuTrigger>
                        {entryMenu(entry)}
                      </ContextMenu>
                    )
                  })}
                </div>
              )
            ) : sorted.length === 0 ? (
              <EmptyState icon="folder-open" title={t("ui.browser.empty_folder_title")} desc={canUpload || canMkdir ? t("ui.browser.empty_folder_desc_upload") : t("ui.browser.empty_folder_desc_none")} />
            ) : settings.view === "list" ? (
              <div className="flex flex-1 flex-col overflow-hidden p-2">
                <div className="mb-1 flex items-center gap-3 border-b border-border px-2 pb-1.5 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1">{t("ui.common.name")}</span>
                  <span className="hidden w-18 shrink-0 text-right sm:block">{t("ui.common.size")}</span>
                  <span className="hidden w-32 shrink-0 text-right lg:block">{t("ui.browser.mtime")}</span>
                </div>
                {/* 窗口化渲染：只挂视口附近的行，上下用等高占位块撑出滚动条长度 */}
                <div ref={listScrollRef} onScroll={virt.onScroll} className="flex-1 overflow-auto">
                  <div style={{ height: virt.padTop }} aria-hidden />
                  {sorted.slice(virt.start, virt.end).map((entry, i) => renderRow(entry, virt.start + i))}
                  <div style={{ height: virt.padBottom }} aria-hidden />
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-2" onScroll={onGridScroll}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">{sorted.slice(0, grid.limit).map(renderCard)}</div>
                {!grid.done && (
                  <div className="py-3 text-center text-xs text-muted-foreground">{t("ui.common.loading")}</div>
                )}
              </div>
              )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">{buildEmptyMenuItems()}</ContextMenuContent>
          </ContextMenu>
        </div>
      </div>

      {/* 底部信息 */}
      <div className="app-footer border-t border-border/30 px-3 py-2 sm:px-5">
        <div className="mx-auto w-full max-w-4xl text-center text-[11px] leading-relaxed text-muted-foreground">
          {t("ui.browser.current_mode", { role: roleLabel(me.role) })}{me.role !== "superadmin" ? t("ui.browser.admin_mode_hint") : ""}
          <span className="mx-1.5 text-border">|</span>
          {/* 兼容模式是独立的静态页（public/robustness/index.html），不参与前端构建，
              所以这里用原生 <a> + 新标签页打开，而不是 react-router 的 <Link>。 */}
          <a
            href="/robustness/index.html"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-foreground"
            title={t("ui.browser.compat_hint")}
          >
            {t("ui.browser.compat_link")}
          </a>
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden"
        onChange={(e) => { const files = Array.from(e.target.files || []).map(withRelativePath); if (files.length) handleUpload(files); e.target.value = "" }}
      />
      <input ref={folderInputRef} type="file" {...{ webkitdirectory: "" } as Record<string, string>} multiple className="hidden"
        onChange={(e) => { const files = Array.from(e.target.files || []).map(withRelativePath); if (files.length) handleUpload(files); e.target.value = "" }}
      />
      <FileTasksPanel open={tasksOpen} onClose={() => setTasksOpen(false)} />
      <NewFolderDialog open={dialog === "newFolder"} onOpenChange={(o) => !o && setDialog(null)} path={path} onDone={refresh} />
      <RenameDialog open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(null)} entry={dialogEntry} path={dialogBase} onDone={refresh} />
      <DeleteDialog
        open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}
        names={dialog === "delete" ? (query ? (dialogEntry ? [dialogEntry.name] : []) : selectedEntries.length ? selectedEntries.map((e) => e.name) : dialogEntry ? [dialogEntry.name] : []) : []}
        path={dialogBase} onDone={refresh}
      />
      <DetailsDialog open={dialog === "details"} onOpenChange={(o) => !o && setDialog(null)} entryPath={dialog === "details" ? (dialogEntry ? entryPath(dialogEntry) : path) : null} />
      <DestPickerDialog open={picker !== null} onOpenChange={(o) => !o && setPicker(null)} title={picker === "copy" ? t("ui.browser.copy_to") : t("ui.browser.move_to")}
        sourcePaths={pickerPaths} mode={picker || "copy"} onDone={refresh}
      />
      <ConflictDialog
        open={conflictOpen}
        onOpenChange={(o) => { setConflictOpen(o); if (!o && conflictResolveRef.current) { conflictResolveRef.current(CONFLICT_CANCELLED); conflictResolveRef.current = null } }}
        conflicts={conflictNames}
        existingNames={existingNames}
        directoryNames={conflictDirs}
        onResolved={(items) => { conflictResolveRef.current?.(items); conflictResolveRef.current = null }}
      />
      <ShortcutEditorDialog
        open={shortcutOpen}
        onOpenChange={setShortcutOpen}
        entry={shortcutEntry}
        currentPath={shortcutBase}
        onDone={refresh}
      />
      <NewCustomFileDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        dirPath={newFileDir}
        onDone={refresh}
      />
      <ShareDialog
        open={!!shareTarget}
        onOpenChange={(o) => !o && setShareTarget(null)}
        path={shareTarget ? entryPath(shareTarget) : ""}
        name={shareTarget ? displayName(shareTarget) : ""}
        isFolder={shareTarget?.type === "dir"}
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
