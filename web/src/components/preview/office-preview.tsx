import * as React from "react"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import type {
  DocxBlock,
  DocxDocument,
  DocxListItem,
  DocxRun,
  OfficeDoc,
  OfficeErrorCode,
  OfficeKind,
  PptxDeck,
  PptxShape,
  PptxSlide,
  XlsxSheet,
  XlsxWorkbook,
} from "@/lib/office"

/**
 * office-preview.tsx —— 浏览器端 Office 文档预览（docx / xlsx / pptx）
 *
 * 三层职责划分：
 *   1. 解析（`lib/office`，动态 import）产出纯数据；
 *   2. 本组件只做「数据 → React 元素」，**所有文档文本都走文本节点**，
 *      图片只允许 `blob:` URL（由包内字节现场创建并及时 revoke）；
 *   3. 样式复用项目已有的设计 token（`border-border` / `bg-card` / `text-muted-foreground`…），
 *      不引入任何硬编码配色。
 *
 * 体积约束：整个解析器通过 `await import("@/lib/office")` 拿到，Vite 会把它拆成
 * 独立 chunk，首屏只多一个 `React.lazy` 的空壳。
 */

/** 单份文档的下载上限：浏览器内存 + 解压后体积都不适合再大，超了就提示下载 */
const MAX_BYTES = 48 * 1024 * 1024

const ERROR_KEY: Record<OfficeErrorCode, string> = {
  invalid: "ui.office.error.invalid",
  encrypted: "ui.office.error.encrypted",
  unsupported: "ui.office.error.unsupported",
  too_large: "ui.office.error.too_large",
  empty: "ui.office.error.empty",
  network: "ui.office.error.network",
}

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; doc: OfficeDoc }
  | { status: "error"; code: OfficeErrorCode }

function errorCodeOf(err: unknown): OfficeErrorCode {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && code in ERROR_KEY) return code as OfficeErrorCode
  }
  return "invalid"
}

export default function OfficePreview({ url, name, kind }: { url: string; name: string; kind: OfficeKind }) {
  const t = useT()
  const [state, setState] = React.useState<PreviewState>({ status: "loading" })

  React.useEffect(() => {
    // 组件/文件变化时先回到「解析中」：Suspense 之外自己维护，避免闪空白
    setState({ status: "loading" })
    let alive = true
    const controller = new AbortController()

    void (async () => {
      try {
        const { parseOffice, OfficeError } = await import("@/lib/office")
        const res = await fetch(url, { credentials: "same-origin", signal: controller.signal })
        if (!res.ok) throw new OfficeError("network")
        const declared = Number(res.headers.get("content-length") ?? "0")
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          controller.abort()
          throw new OfficeError("too_large")
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.byteLength > MAX_BYTES) throw new OfficeError("too_large")
        const doc = await parseOffice(bytes, kind)
        if (alive) setState({ status: "ready", doc })
      } catch (err) {
        if (!alive) return
        setState({ status: "error", code: errorCodeOf(err) })
      }
    })()

    return () => {
      alive = false
      controller.abort()
    }
  }, [url, kind])

  if (state.status === "loading") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <Icon name="loader-2" className="size-6 animate-spin" />
        <span>{t("ui.office.loading")}</span>
        <span className="max-w-md truncate px-6 text-xs opacity-70">{name}</span>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-8 text-center">
        <Icon name="circle-slash" className="size-10 text-muted-foreground" />
        <p className="text-sm font-medium">{t(ERROR_KEY[state.code] ?? "ui.office.error.generic")}</p>
        <p className="max-w-md truncate text-xs text-muted-foreground">{name}</p>
      </div>
    )
  }

  return <OfficeDocument doc={state.doc} />
}

/** 把包内图片字节做成 `blob:` URL，卸载或换文档时回收 */
function useMediaUrls(doc: OfficeDoc): Map<string, string> {
  const [urls, setUrls] = React.useState<Map<string, string>>(() => new Map())
  React.useEffect(() => {
    const next = new Map<string, string>()
    for (const [path, file] of doc.media) {
      // 复制一份成 ArrayBuffer 视图：Blob 不接受 ArrayBufferLike 的 Uint8Array 类型
      next.set(path, URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mime })))
    }
    setUrls(next)
    return () => {
      for (const url of next.values()) URL.revokeObjectURL(url)
    }
  }, [doc])
  return urls
}

function OfficeDocument({ doc }: { doc: OfficeDoc }) {
  const media = useMediaUrls(doc)
  // 同一路由里换文件时组件不会卸载：用数据指纹做 key，让内部状态（当前工作表 / 当前页）跟着重置
  const key =
    doc.kind === "xlsx"
      ? `x:${doc.sheets.map((sheet) => sheet.name).join("\u0000")}`
      : doc.kind === "pptx"
        ? `p:${doc.slides.length}`
        : `d:${doc.blocks.length}`
  if (doc.kind === "docx") return <DocxView key={key} doc={doc} media={media} />
  if (doc.kind === "xlsx") return <XlsxView key={key} doc={doc} />
  return <PptxView key={key} doc={doc} media={media} />
}

/* ============================================================================
   DOCX
   ========================================================================== */

const HEADING_CLASS: Record<number, string> = {
  1: "mt-6 mb-3 text-2xl font-semibold leading-tight",
  2: "mt-5 mb-2 text-xl font-semibold leading-tight",
  3: "mt-4 mb-2 text-lg font-semibold leading-tight",
  4: "mt-3 mb-1 text-base font-semibold",
  5: "mt-3 mb-1 text-sm font-semibold",
  6: "mt-3 mb-1 text-sm font-medium text-muted-foreground",
}

function runStyle(run: DocxRun): React.CSSProperties {
  if (run.kind !== "text") return {}
  const style: React.CSSProperties = {}
  if (run.sizePt) style.fontSize = `${run.sizePt}pt`
  if (run.color) style.color = run.color
  if (run.bold) style.fontWeight = 600
  if (run.italic) style.fontStyle = "italic"
  const decoration = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean)
  if (decoration.length) style.textDecoration = decoration.join(" ")
  return style
}

function Runs({ runs, media }: { runs: DocxRun[]; media: Map<string, string> }) {
  const t = useT()
  return (
    <>
      {runs.map((run, i) =>
        run.kind === "image" ? (
          media.has(run.src) ? (
            <img
              key={i}
              src={media.get(run.src)}
              alt={t("ui.office.image_alt")}
              loading="lazy"
              className="my-2 inline-block h-auto max-w-full rounded-sm"
              style={{ width: run.width, height: run.height }}
            />
          ) : null
        ) : (
          <span key={i} style={runStyle(run)}>
            {run.text}
          </span>
        )
      )}
    </>
  )
}

function Blocks({ blocks, media }: { blocks: DocxBlock[]; media: Map<string, string> }) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} media={media} />
      ))}
    </>
  )
}

function ListBlock({ items, media }: { items: DocxListItem[]; media: Map<string, string> }) {
  return (
    <ul className="my-2 pl-6">
      {items.map((item, i) => (
        <li
          key={i}
          className="my-0.5 whitespace-pre-wrap"
          style={{
            listStyleType: item.listStyle,
            marginLeft: item.level ? `${item.level * 1.25}rem` : undefined,
            textAlign: item.align,
          }}
        >
          <Runs runs={item.runs} media={media} />
        </li>
      ))}
    </ul>
  )
}

function Block({ block, media }: { block: DocxBlock; media: Map<string, string> }) {
  const t = useT()
  if (block.kind === "break") {
    return <hr className="my-5 border-t border-border" aria-label={t("ui.office.docx.page_break")} />
  }
  if (block.kind === "list") return <ListBlock items={block.items} media={media} />
  if (block.kind === "table") {
    return (
      <table className="my-3 w-full border-collapse text-sm">
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  colSpan={cell.span > 1 ? cell.span : undefined}
                  className="border border-border px-2 py-1 align-top"
                >
                  <Blocks blocks={cell.blocks} media={media} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  const heading = block.heading && block.heading >= 1 && block.heading <= 6 ? block.heading : 0
  const content = <Runs runs={block.runs} media={media} />
  const style: React.CSSProperties = { textAlign: block.align }
  if (heading) {
    const Tag = `h${heading}` as "h1"
    return (
      <Tag className={HEADING_CLASS[heading]} style={style}>
        {content}
      </Tag>
    )
  }
  // 空段落保留行高，否则原文的分段间距会全部塌掉
  return (
    <p className="my-1 min-h-[1em] whitespace-pre-wrap leading-7" style={style}>
      {content}
    </p>
  )
}

function DocxView({ doc, media }: { doc: DocxDocument; media: Map<string, string> }) {
  return (
    <div className="h-full overflow-auto bg-muted/20">
      <article className="mx-auto my-4 max-w-3xl rounded-lg border border-border bg-card px-4 py-6 text-[15px] text-card-foreground shadow-sm sm:px-8 sm:py-10">
        <Blocks blocks={doc.blocks} media={media} />
      </article>
    </div>
  )
}

/* ============================================================================
   XLSX
   ========================================================================== */

function SheetTable({ sheet }: { sheet: XlsxSheet }) {
  const t = useT()
  if (!sheet.rows.length) {
    return <p className="p-6 text-sm text-muted-foreground">{t("ui.office.xlsx.empty")}</p>
  }
  const width = sheet.cols.reduce((sum, w) => sum + w, 0)
  return (
    <div className="h-full overflow-auto">
      {sheet.truncated && (
        <div className="sticky left-0 flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <Icon name="info" className="size-3.5 shrink-0" />
          <span>{t("ui.office.xlsx.truncated", { rows: sheet.rows.length })}</span>
        </div>
      )}
      <table className="table-fixed border-collapse text-sm" style={{ width }}>
        <colgroup>
          {sheet.cols.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <tbody>
          {sheet.rows.map((row, r) => (
            <tr key={r} className="even:bg-muted/30">
              {row.cells.map((cell, c) =>
                cell ? (
                  <td
                    key={c}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    title={cell.formula ? t("ui.office.xlsx.formula", { formula: `=${cell.formula}` }) : undefined}
                    className={cn(
                      "h-7 overflow-hidden border border-border px-2 text-ellipsis whitespace-nowrap align-middle",
                      cell.numeric && "text-right tabular-nums"
                    )}
                  >
                    {cell.text}
                  </td>
                ) : null
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function XlsxView({ doc }: { doc: XlsxWorkbook }) {
  const t = useT()
  const first = doc.sheets[0]?.name
  return (
    <Tabs defaultValue={first} className="flex h-full flex-col gap-0">
      <TabsList
        variant="line"
        aria-label={t("ui.office.xlsx.sheet_tabs")}
        className="w-full shrink-0 justify-start overflow-x-auto border-b border-border bg-transparent px-2 py-0"
      >
        {doc.sheets.map((sheet) => (
          <TabsTrigger key={sheet.name} value={sheet.name} className="shrink-0 px-3">
            {sheet.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {doc.sheets.map((sheet) => (
        <TabsContent key={sheet.name} value={sheet.name} className="min-h-0 flex-1">
          <SheetTable sheet={sheet} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

/* ============================================================================
   PPTX
   ========================================================================== */

/** 磅值 → 容器宽度单位。幻灯片 13.333in 宽时 1cqw ≈ 0.133in，字号要跟着缩放 */
function fontCqw(sizePt: number, slideWidth: number): string {
  const cqw = ((sizePt * 12700) / slideWidth) * 100
  return `max(6px, ${cqw.toFixed(3)}cqw)`
}

function SlideShape({ shape, media, slideWidth }: { shape: PptxShape; media: Map<string, string>; slideWidth: number }) {
  const box: React.CSSProperties = {
    position: "absolute",
    left: `${shape.x}%`,
    top: `${shape.y}%`,
    width: `${shape.w}%`,
    height: `${shape.h}%`,
    backgroundColor: shape.fill,
    border: shape.line ? `1px solid ${shape.line}` : undefined,
  }
  if (shape.image) {
    const src = media.get(shape.image)
    if (!src) return null
    return (
      <div style={box}>
        <img src={src} alt="" loading="lazy" className="h-full w-full object-contain" />
      </div>
    )
  }
  if (!shape.paragraphs) return <div style={box} />
  const inset = shape.inset
  return (
    <div
      style={{
        ...box,
        display: "flex",
        flexDirection: "column",
        justifyContent:
          shape.anchor === "center" ? "center" : shape.anchor === "bottom" ? "flex-end" : "flex-start",
        overflow: "hidden",
        padding: inset
          ? `${inset.t}cqw ${inset.r}cqw ${inset.b}cqw ${inset.l}cqw`
          : "0.6cqw 0.8cqw",
      }}
    >
      {shape.paragraphs.map((paragraph, i) => (
        <p
          key={i}
          className="whitespace-pre-wrap"
          style={{ margin: 0, lineHeight: 1.2, textAlign: paragraph.align }}
        >
          {paragraph.runs.map((run, j) => (
            <span
              key={j}
              style={{
                fontSize: fontCqw(run.sizePt ?? 18, slideWidth),
                fontWeight: run.bold ? 600 : undefined,
                fontStyle: run.italic ? "italic" : undefined,
                textDecoration: run.underline ? "underline" : undefined,
                color: run.color,
              }}
            >
              {run.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  )
}

function SlideCanvas({ slide, deck, media }: { slide: PptxSlide; deck: PptxDeck; media: Map<string, string> }) {
  const t = useT()
  if (!slide.shapes.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("ui.office.pptx.empty")}
      </div>
    )
  }
  return (
    <div
      className="relative h-full w-full [container-type:inline-size]"
      style={{ backgroundColor: slide.bg }}
    >
      {slide.shapes.map((shape, i) => (
        <SlideShape key={i} shape={shape} media={media} slideWidth={deck.width} />
      ))}
    </div>
  )
}

function PptxView({ doc, media }: { doc: PptxDeck; media: Map<string, string> }) {
  const t = useT()
  const [index, setIndex] = React.useState(0)
  const total = doc.slides.length
  const current = Math.min(index, total - 1)
  const go = React.useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(total - 1, next))),
    [total]
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-background md:flex-row">
      {/* 缩略条：窄屏在顶部横向滚动，宽屏在左侧纵向列表 */}
      <div
        aria-label={t("ui.office.pptx.slides")}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-28 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:border-r md:border-b-0"
      >
        {doc.slides.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => go(i)}
            aria-current={i === current ? "true" : undefined}
            className={cn(
              "flex h-11 w-14 shrink-0 items-center justify-center rounded-md border border-border bg-card text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground md:h-14 md:w-full",
              i === current && "border-ring bg-muted text-foreground"
            )}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center overflow-auto p-2 sm:p-4">
          <div
            className="w-full max-w-[960px] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm"
            style={{ aspectRatio: `${doc.width} / ${doc.height}` }}
          >
            <SlideCanvas slide={doc.slides[current]} deck={doc} media={media} />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border py-1.5">
          <Button size="icon-xs" variant="ghost" onClick={() => go(current - 1)} disabled={current <= 0}>
            <Icon name="chevron-left" />
            <span className="sr-only">{t("ui.office.pptx.prev")}</span>
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("ui.office.pptx.counter", { index: current + 1, total })}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => go(current + 1)}
            disabled={current >= total - 1}
          >
            <Icon name="chevron-right" />
            <span className="sr-only">{t("ui.office.pptx.next")}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
