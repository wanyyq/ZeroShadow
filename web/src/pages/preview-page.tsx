import * as React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/icon"
import { downloadUrl } from "@/lib/api"
import { cn } from "@/lib/utils"

const EXT_KIND: Record<string, "image" | "video" | "audio" | "pdf" | "text" | "html"> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", bmp: "image", avif: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video", mkv: "video",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", ogg: "audio", aac: "audio",
  pdf: "pdf",
  html: "html", htm: "html",
}

export default function PreviewPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const entryPath = params.get("path") || ""
  const name = entryPath.split("/").pop() || ""
  const ext = (name.split(".").pop() || "").toLowerCase()
  const kind: string = EXT_KIND[ext] || "text"
  const url = entryPath ? downloadUrl(entryPath, true) : ""
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
    if (kind === "text" && url) {
      fetch(url, { credentials: "same-origin" })
        .then(async (r) => { if (r.ok) setText(await r.text()); else setText("加载失败") })
        .catch(() => setText("加载失败"))
    }
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") navigate(-1) }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [url, kind, navigate])

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
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
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
        {kind === "text" && (
          <div className="h-full overflow-auto bg-muted/30">
            <pre className={cn("p-6 font-mono text-sm whitespace-pre-wrap", text ? "" : "opacity-50")}>
              {text ?? "加载中…"}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
