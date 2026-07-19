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
  const [scale, setScale] = React.useState(1)

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

  const handleWheel = (e: React.WheelEvent) => {
    if (kind !== "image") return
    setScale((prev) => Math.max(0.1, Math.min(10, prev - e.deltaY * 0.001)))
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <div className="flex items-center gap-1">
          {kind === "image" && (
            <>
              <Button size="icon-xs" variant="ghost" onClick={() => setScale((s) => Math.min(10, s + 0.25))}><Icon name="zoom-in" /></Button>
              <Button size="icon-xs" variant="ghost" onClick={() => setScale((s) => Math.max(0.1, s - 0.25))}><Icon name="zoom-out" /></Button>
              <Button size="icon-xs" variant="ghost" onClick={() => setScale(1)}><Icon name="rotate-cw" /></Button>
            </>
          )}
          <Button size="icon-xs" variant="ghost" onClick={() => navigate(-1)}><Icon name="x" /></Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {kind === "image" && (
          <div className="flex h-full items-center justify-center overflow-auto bg-black/60" onWheel={handleWheel}>
            <img src={url} alt={name} style={{ transform: `scale(${scale})`, transition: "transform 0.1s" }} className="max-w-full shadow-2xl" />
          </div>
        )}
        {kind === "video" && (
          <video src={url} controls autoPlay className="h-full w-full bg-black" />
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
