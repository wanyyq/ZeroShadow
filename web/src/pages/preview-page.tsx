import * as React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { downloadUrl, triggerDownload } from "@/lib/api"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { officePreviewKind, parentOf, previewType } from "@/lib/format"
import { hasUnsupportedHtml } from "@/lib/markdown-html"
import { PluginFrame } from "@/components/plugins/plugin-frame"
import { loadRuntimePlugins, matchPlugin, type PluginRuntime } from "@/lib/plugin-registry"
import { isMarkdown, renderMarkdown } from "@/lib/markdown"
import { translate, useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useAuth } from "@/state/auth"

/**
 * Office 文档（OOXML 容器）走独立的懒加载预览器。
 * 这里只做扩展名判断 —— 真正的解析器在 `components/preview/office-preview.tsx`
 * 里动态 import，不会进主 chunk。`.doc/.xls/.ppt` 是二进制老格式，不在此列。
 *
 * 扩展名清单统一放在 `lib/format.ts`（`officePreviewKind`），
 * 文件列表的"能不能双击预览"用的是同一个函数，两边不会漂移。
 */
const OfficePreview = React.lazy(() => import("@/components/preview/office-preview"))

/**
 * 复制纯文本并给反馈。
 * 显式判断 navigator.clipboard：可选链在它缺失时会让整条 then 短路，
 * 成功与失败回调都不执行 —— 用户点了「复制链接」没有任何反应。
 */
function copyToClipboard(text: string, okMsg: string) {
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

export default function PreviewPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { me } = useAuth()
  const t = useT()
  const entryPath = params.get("path") || ""
  const name = entryPath.split("/").pop() || ""
  // 只认 format.ts 的 previewType：未知扩展名（docx / zip / exe …）返回 null，
  // 绝不能当文本抓取 —— 二进制会被渲染成一大片乱码，还没有任何兜底提示。
  const previewKind = previewType(name)
  // Office 文档是二进制 ZIP：绝不能被当成文本抓取（会渲染成一大片乱码）
  const officeKind = officePreviewKind(name)
  const supported = !!entryPath && (previewKind !== null || officeKind !== null)
  // html/htm 在 previewType 里就是 "text"：正常走 /html-preview 专用路由；
  // 若因权限被路由到这里，按文本预览（否则没有分支匹配会得到空白页）
  const kind: string = officeKind ? "office" : previewKind ?? "text"
  const url = supported ? downloadUrl(entryPath, true) : ""
  const [text, setText] = React.useState<string | null>(null)
  // Markdown 文件默认渲染，可切回源码；其余文本文件只有源码视图
  const markdown = supported && kind === "text" && isMarkdown(name)
  const [sourceView, setSourceView] = React.useState(false)
  const [scale, setScale] = React.useState(0)
  const [pos, setPos] = React.useState({ x: 0, y: 0 })
  const [fitScale, setFitScale] = React.useState(1)

  /**
   * 插件预览（v2.0 P2）：内置渲染器不认的后缀，交给已启用的 `fileType` 插件。
   *
   * 只在 `!supported` 时匹配 —— 内置渲染器永远优先，插件不能"抢"已有的格式，
   * 这样"装了插件反而看不了 PDF"这种事不会发生。
   */
  const [runtimePlugins, setRuntimePlugins] = React.useState<PluginRuntime[] | null>(null)
  React.useEffect(() => {
    if (supported) return
    let alive = true
    void loadRuntimePlugins().then((list) => {
      if (alive) setRuntimePlugins(list)
    })
    return () => {
      alive = false
    }
  }, [supported])
  const filePlugin = !supported && runtimePlugins ? matchPlugin(runtimePlugins, name, "preview") : null

  // 插件预览下要能保存，得有 editFiles 且不是只读映射目录里的文件
  const pluginCanWrite = me.perms.editFiles === true
  const imgRef = React.useRef<HTMLImageElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)
  const lastMouse = React.useRef({ x: 0, y: 0 })

  const displayScale = scale || fitScale

  // 渲染结果只跟正文有关，切换视图/缩放时不必重算。
  // baseDir 必须传：.md 里的相对图片 / 链接要按「该文件所在目录」解析，
  // 否则 `![](./a.png)` 会被浏览器当站点根相对地址 → 404（图片、链接全打不开）。
  const baseDir = React.useMemo(() => parentOf(entryPath), [entryPath])
  const html = React.useMemo(
    () => (markdown && text ? renderMarkdown(text, { baseDir }) : ""),
    [markdown, text, baseDir]
  )
  // 渲染器只把「白名单以外的原始 HTML」当纯文本（安全前提），命中时给个提示，
  // 免得用户以为是渲染坏了。白名单内（<br> / <kbd> / <div> …）已正常渲染，
  // 不该再弹这条提示 —— 判定逻辑与渲染器共用同一份（lib/markdown-html.ts）。
  const rawHtml = React.useMemo(
    () => markdown && !!text && hasUnsupportedHtml(text),
    [markdown, text]
  )

  React.useEffect(() => {
    if (!me.perms.preview) {
      toast.warning(t("ui.common.no_permission"))
      navigate(-1)
    }
  }, [me.perms.preview, navigate, t])

  React.useEffect(() => {
    if (supported && kind === "text" && url) {
      // 不要在这里做 HTML 转义：内容是交给 JSX 文本节点渲染的，React 本身就会转义，
      // 手动再转一次会让引号、尖括号在屏幕上显示成 &quot; / &lt; 字面量。
      fetch(url, { credentials: "same-origin" })
        .then(async (r) => { if (r.ok) setText(await r.text()); else setText(t("ui.dialogs.load_failed")) })
        .catch(() => setText(t("ui.dialogs.load_failed")))
    }
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") navigate(-1) }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [url, kind, supported, navigate, t])

  React.useEffect(() => { setScale(0); setPos({ x: 0, y: 0 }); setFitScale(1); setSourceView(false) }, [url])

  /**
   * 按容器尺寸算出"适应窗口"的缩放比。
   *
   * 注意这里**不要再引用 `scale`**：原来的 `if (!scale) setScale(0)` 是个空操作
   * （`scale` 为 0 时再设 0），却会让这个回调在每次缩放时重建、并让
   * React Compiler 报"无法保留手动记忆化"。依赖只留 `kind`。
   */
  const calcFit = React.useCallback(() => {
    const img = imgRef.current
    const con = containerRef.current
    if (!img || !con || kind !== "image") return
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    if (!nw || !nh) return
    setFitScale(Math.min(con.clientWidth / nw, con.clientHeight / nh, 1))
    // `setFitScale` 是 useState 的 setter（引用恒定），写进依赖只是为了配合
    // React Compiler 的依赖推断，不会造成额外重建。
  }, [kind, setFitScale])

  React.useEffect(() => {
    if (kind !== "image") return
    calcFit()
    const onResize = () => calcFit()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [kind, calcFit])

  const isZoomed = scale > 0

  const handleWheel = (e: React.WheelEvent) => {
    if (kind !== "image") return
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left - rect.width / 2
    const my = e.clientY - rect.top - rect.height / 2
    const current = scale || fitScale
    const factor = 1 - e.deltaY * 0.001
    const newScale = Math.max(0.1, Math.min(10, current * factor))
    const ratio = newScale / current
    setScale(newScale > fitScale * 1.05 ? newScale : 0)
    setPos((p) => ({ x: p.x * ratio + mx * (1 - ratio), y: p.y * ratio + my * (1 - ratio) }))
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (kind !== "image") return
    if (e.button !== 0) return
    dragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - lastMouse.current.x
    const dy = e.clientY - lastMouse.current.y
    lastMouse.current = { x: e.clientX, y: e.clientY }
    setPos((p) => ({ x: p.x + dx, y: p.y + dy }))
  }

  const handleMouseUp = () => { dragging.current = false }

  const handleDoubleClick = () => {
    if (kind !== "image") return
    if (isZoomed) {
      setScale(0)
      setPos({ x: 0, y: 0 })
    } else {
      setScale(Math.min(fitScale * 2.5, 3))
    }
  }

  const zoomIn = () => {
    // 只调用一次 setScale：旧实现连调两次，第二次在"尚未进入缩放态"时会
    // 覆盖第一次的结果，于是第一次放大只能到 fitScale*1.5（而不是 1.25）。
    const current = isZoomed ? scale : fitScale
    setScale(Math.min(10, current * 1.25))
  }
  const zoomOut = () => {
    if (!isZoomed) return
    const ns = scale * 0.8
    if (ns < fitScale * 1.05) { setScale(0); setPos({ x: 0, y: 0 }) }
    else setScale(ns)
  }
  const resetZoom = () => { setScale(0); setPos({ x: 0, y: 0 }) }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="fixed inset-0 z-50" />}>
        <div className="flex h-full flex-col bg-background">
      <div className="relative z-10 flex shrink-0 items-center justify-between border-b border-border bg-background px-4 py-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <div className="flex items-center gap-1">
          {kind === "image" && (
            <>
              <span className="mr-1 text-xs text-muted-foreground tabular-nums">{Math.round(displayScale * 100)}%</span>
              <Button size="icon-xs" variant="ghost" onClick={zoomIn}><Icon name="zoom-in" /></Button>
              <Button size="icon-xs" variant="ghost" onClick={zoomOut}><Icon name="zoom-out" /></Button>
              <Button size="icon-xs" variant="ghost" onClick={resetZoom}><Icon name="rotate-cw" /></Button>
            </>
          )}
          {markdown && (
            <Button size="xs" variant="ghost" onClick={() => setSourceView((v) => !v)}>
              <Icon name={sourceView ? "eye" : "code"} /> {sourceView ? t("ui.common.preview") : t("ui.preview.source_code")}
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" onClick={() => navigate(-1)}><Icon name="x" /></Button>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        {kind === "image" && (
          <div
            ref={containerRef}
            className="relative h-full w-full cursor-grab select-none bg-background active:cursor-grabbing"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={handleDoubleClick}
          >
            <img
              ref={imgRef}
              src={url}
              alt={name}
              draggable={false}
              onLoad={calcFit}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px)) scale(${displayScale})`,
                transformOrigin: "center center",
                maxWidth: isZoomed ? "none" : undefined,
                maxHeight: isZoomed ? "none" : undefined,
              }}
              className="pointer-events-none shadow-lg"
            />
          </div>
        )}
        {kind === "video" && (
          <video src={url} controls autoPlay className="h-full w-full bg-background" />
        )}
        {kind === "audio" && (
          <div className="flex h-full items-center justify-center p-8">
            <div className="w-full max-w-md text-center">
              <Icon name="music" className="mx-auto size-16 text-muted-foreground" />
              <p className="mt-3 mb-6 truncate text-lg font-medium">{name}</p>
              <audio src={url} controls autoPlay className="w-full" />
            </div>
          </div>
        )}
        {kind === "pdf" && (
          <iframe src={url} title={name} className="h-full w-full" />
        )}
        {kind === "office" && officeKind && (
          // Suspense 只负责「解析器 chunk 还没下载完」这一段，解析本身在组件内部有 loading 态
          <React.Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
                {t("ui.common.loading")}
              </div>
            }
          >
            <OfficePreview url={url} name={name} kind={officeKind} />
          </React.Suspense>
        )}
        {!supported && filePlugin && (
          <PluginFrame
            plugin={filePlugin}
            path={entryPath}
            name={name}
            size={0}
            mtime={0}
            canWrite={pluginCanWrite}
          />
        )}
        {!supported && !filePlugin && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Icon name="circle-slash" className="size-10 text-muted-foreground" />
            <p className="text-sm font-medium">{t("ui.preview.unsupported_format")}</p>
            <p className="max-w-md truncate text-xs text-muted-foreground">{name}</p>
          </div>
        )}
        {supported && kind === "text" && markdown && !sourceView && (
          <div className="h-full overflow-auto bg-background">
            {rawHtml && (
              <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                <Icon name="info" className="mt-0.5 size-3.5 shrink-0" />
                <span>{t("ui.preview.raw_html_notice")}</span>
              </div>
            )}
            {text === null ? (
              <p className="p-6 text-sm text-muted-foreground">{t("ui.common.loading")}</p>
            ) : (
              // html 由 lib/markdown.ts 生成：源文本先整体转义再解析，输出里不含
              // 任何来自文件的标签（白名单标签是渲染器自己拼的字面标签，且无属性），
              // 因此这里的 dangerouslySetInnerHTML 没有 XSS 通道。
              //
              // `select-text` 是必须的：本页最外层是 ContextMenuTrigger，而它的
              // 样式里带 `select-none`（.ui/context-menu.tsx 的默认 className），
              // 于是整页文字都选不中 —— 表现就是"Markdown 正文无法复制"。
              <article className="md-body select-text" dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </div>
        )}
        {supported && kind === "text" && (!markdown || sourceView) && (
          <div className="h-full overflow-auto bg-muted/30">
            <pre className={cn("select-text p-6 font-mono text-sm whitespace-pre-wrap", text ? "" : "opacity-50")}>
              {text ?? t("ui.common.loading")}
            </pre>
          </div>
        )}
      </div>
        </div>
      </ContextMenuTrigger>
      {/* 查看页的右键菜单：下载、新标签打开、复制链接、返回 */}
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!me.perms.downloadFile} onClick={() => { if (!me.perms.downloadFile) return toast.warning(t("ui.common.no_permission")); triggerDownload(url).catch(() => toast.error(t("ui.operations.download_failed"))) }}>
          <Icon name="download" /> {t("ui.preview.download_original")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => window.open(url, "_blank", "noopener")}>
          <Icon name="external-link" /> {t("ui.common.open_new_tab")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copyToClipboard(new URL(url, window.location.origin).href, t("ui.preview.link_copied"))}>
          <Icon name="clipboard-copy" /> {t("ui.common.copy_link")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyToClipboard(entryPath, t("ui.browser.copied_relative_path"))}>
          <Icon name="clipboard-list" /> {t("ui.browser.copy_relative_path")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => navigate(-1)}>
          <Icon name="arrow-left" /> {t("ui.common.back")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
