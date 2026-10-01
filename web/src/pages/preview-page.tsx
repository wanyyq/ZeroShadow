import * as React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { downloadUrl, triggerDownload } from "@/lib/api"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { previewType } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAuth } from "@/state/auth"

export default function PreviewPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { me } = useAuth()
  const entryPath = params.get("path") || ""
  const name = entryPath.split("/").pop() || ""
  // 只认 format.ts 的 previewType：未知扩展名（docx / zip / exe …）返回 null，
  // 绝不能当文本抓取 —— 二进制会被渲染成一大片乱码，还没有任何兜底提示。
  const previewKind = previewType(name)
  const supported = !!entryPath && previewKind !== null
  // html/htm 在 previewType 里就是 "text"：正常走 /html-preview 专用路由；
  // 若因权限被路由到这里，按文本预览（否则没有分支匹配会得到空白页）
  const kind: string = previewKind ?? "text"
  const url = supported ? downloadUrl(entryPath, true) : ""
  const [text, setText] = React.useState<string | null>(null)
  const [scale, setScale] = React.useState(0)
  const [pos, setPos] = React.useState({ x: 0, y: 0 })
  const [fitScale, setFitScale] = React.useState(1)
  const imgRef = React.useRef<HTMLImageElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)
  const lastMouse = React.useRef({ x: 0, y: 0 })

  const displayScale = scale || fitScale

  React.useEffect(() => {
    if (!me.perms.preview) {
      toast.warning("此功能您没权限")
      navigate(-1)
    }
  }, [me.perms.preview, navigate])

  React.useEffect(() => {
    if (supported && kind === "text" && url) {
      // 不要在这里做 HTML 转义：内容是交给 JSX 文本节点渲染的，React 本身就会转义，
      // 手动再转一次会让引号、尖括号在屏幕上显示成 &quot; / &lt; 字面量。
      fetch(url, { credentials: "same-origin" })
        .then(async (r) => { if (r.ok) setText(await r.text()); else setText("加载失败") })
        .catch(() => setText("加载失败"))
    }
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") navigate(-1) }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [url, kind, supported, navigate])

  React.useEffect(() => { setScale(0); setPos({ x: 0, y: 0 }); setFitScale(1) }, [url])

  const calcFit = React.useCallback(() => {
    const img = imgRef.current
    const con = containerRef.current
    if (!img || !con || kind !== "image") return
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    if (!nw || !nh) return
    const cw = con.clientWidth
    const ch = con.clientHeight
    const s = Math.min(cw / nw, ch / nh, 1)
    setFitScale(s)
    if (!scale) setScale(0)
  }, [kind, scale])

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
    const current = isZoomed ? scale : fitScale
    setScale(Math.min(10, current * 1.25))
    if (!isZoomed) setScale(Math.min(10, fitScale * 1.5))
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
        {!supported && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Icon name="circle-slash" className="size-10 text-muted-foreground" />
            <p className="text-sm font-medium">暂不支持预览此格式</p>
            <p className="max-w-md truncate text-xs text-muted-foreground">{name}</p>
          </div>
        )}
        {supported && kind === "text" && (
          <div className="h-full overflow-auto bg-muted/30">
            <pre className={cn("p-6 font-mono text-sm whitespace-pre-wrap", text ? "" : "opacity-50")}>
              {text ?? "加载中…"}
            </pre>
          </div>
        )}
      </div>
        </div>
      </ContextMenuTrigger>
      {/* 查看页的右键菜单：下载、新标签打开、复制链接、返回 */}
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!me.perms.downloadFile} onClick={() => { if (!me.perms.downloadFile) return toast.warning("此功能您没权限"); triggerDownload(url).catch(() => toast.error("下载失败")) }}>
          <Icon name="download" /> 下载原文件
        </ContextMenuItem>
        <ContextMenuItem onClick={() => window.open(url, "_blank", "noopener")}>
          <Icon name="external-link" /> 在新标签页打开
        </ContextMenuItem>
        <ContextMenuItem onClick={() => { void navigator.clipboard?.writeText(new URL(url, window.location.origin).href).then(() => toast.success("已复制链接"), () => toast.error("复制失败")) }}>
          <Icon name="clipboard-copy" /> 复制链接
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => { void navigator.clipboard?.writeText(entryPath).then(() => toast.success("已复制相对路径"), () => toast.error("复制失败")) }}>
          <Icon name="clipboard-list" /> 复制相对路径
        </ContextMenuItem>
        <ContextMenuItem onClick={() => navigate(-1)}>
          <Icon name="arrow-left" /> 返回
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
