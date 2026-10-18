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
  DocxSpacing,
  OfficeDoc,
  OfficeErrorCode,
  OfficeKind,
  PptxDeck,
  PptxParagraph,
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
        ) : run.href && /^(https?:|mailto:)/i.test(run.href) ? (
          <a
            key={i}
            href={run.href}
            target="_blank"
            rel="noopener noreferrer"
            style={runStyle(run)}
            className="text-primary underline underline-offset-2"
          >
            {run.text}
          </a>
        ) : (
          <span key={i} style={runStyle(run)}>
            {run.text}
          </span>
        )
      )}
    </>
  )
}

/** 段前/段后与行距 → 内联样式（Word 的 twips 在解析层已换成磅） */
function spacingStyle(spacing: DocxSpacing | undefined): React.CSSProperties {
  if (!spacing) return {}
  const style: React.CSSProperties = {}
  if (spacing.beforePt !== undefined) style.marginTop = `${spacing.beforePt}pt`
  if (spacing.afterPt !== undefined) style.marginBottom = `${spacing.afterPt}pt`
  if (spacing.linePt !== undefined) style.lineHeight = `${spacing.linePt}pt`
  else if (spacing.line !== undefined) style.lineHeight = spacing.line
  return style
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
            ...spacingStyle(item.spacing),
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
        {block.widths ? (
          <colgroup>
            {block.widths.map((w, i) => (
              <col key={i} style={{ width: `${w}%` }} />
            ))}
          </colgroup>
        ) : null}
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                cell ? (
                  <td
                    key={c}
                    colSpan={cell.span > 1 ? cell.span : undefined}
                    rowSpan={cell.rowSpan}
                    style={{ backgroundColor: cell.shade }}
                    className="border border-border px-2 py-1 align-top"
                  >
                    <Blocks blocks={cell.blocks} media={media} />
                  </td>
                ) : null
              )}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  const heading = block.heading && block.heading >= 1 && block.heading <= 6 ? block.heading : 0
  const content = <Runs runs={block.runs} media={media} />
  const style: React.CSSProperties = {
    textAlign: block.align,
    ...spacingStyle(block.spacing),
  }
  if (block.indentPt) style.textIndent = `${block.indentPt}pt`
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
            <tr key={r} className="even:bg-muted/30" style={row.height ? { height: row.height } : undefined}>
              {row.cells.map((cell, c) =>
                cell ? (
                  <td
                    key={c}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    title={cell.formula ? t("ui.office.xlsx.formula", { formula: `=${cell.formula}` }) : undefined}
                    style={{
                      backgroundColor: cell.fill,
                      color: cell.color,
                      fontWeight: cell.bold ? 600 : undefined,
                      fontStyle: cell.italic ? "italic" : undefined,
                      textAlign: cell.align,
                    }}
                    className={cn(
                      "overflow-hidden border border-border px-2 align-middle",
                      row.height ? "h-full" : "h-7",
                      cell.wrap ? "whitespace-normal break-words" : "text-ellipsis whitespace-nowrap",
                      cell.numeric && !cell.align && "text-right tabular-nums"
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

/** 磅值 → cqw（1cqw = 幻灯片宽度的 1%）。字号、行距、缩进共用这一套基准 */
function ptToCqw(sizePt: number, slideWidth: number): number {
  return ((sizePt * 12700) / slideWidth) * 100
}

function fontCqw(sizePt: number, slideWidth: number): string {
  return `max(6px, ${ptToCqw(sizePt, slideWidth).toFixed(3)}cqw)`
}

function PptxRunSpans({
  paragraph,
  scale,
  textColor,
  slideWidth,
}: {
  paragraph: PptxParagraph
  scale: number
  textColor: string
  slideWidth: number
}) {
  return (
    <>
      {paragraph.runs.map((run, i) => {
        const decoration = run.underline
          ? run.strike
            ? "underline line-through"
            : "underline"
          : run.strike
            ? "line-through"
            : undefined
        return (
          <span
            key={i}
            style={{
              fontSize: fontCqw((run.sizePt ?? 18) * scale, slideWidth),
              fontWeight: run.bold ? 600 : undefined,
              fontStyle: run.italic ? "italic" : undefined,
              textDecoration: decoration,
              color: run.color ?? textColor,
            }}
          >
            {run.text}
          </span>
        )
      })}
    </>
  )
}

/** 一个段落：处理项目符号 / 编号 / 缩进 / 段前段后 / 行距 */
function PptxParagraphView({
  paragraph,
  number,
  scale,
  reduction,
  textColor,
  slideWidth,
  nowrap,
}: {
  paragraph: PptxParagraph
  number?: number
  scale: number
  reduction: number
  textColor: string
  slideWidth: number
  nowrap?: boolean
}) {
  const before = ptToCqw(paragraph.spaceBeforePt ?? 0, slideWidth)
  const after = ptToCqw(paragraph.spaceAfterPt ?? 0, slideWidth)
  const lineHeight = paragraph.lineHeightPt
    ? `${ptToCqw(paragraph.lineHeightPt * scale * (1 - reduction), slideWidth).toFixed(3)}cqw`
    : Math.max(0.8, (paragraph.lineSpacing ?? 1.2) * (1 - reduction))
  const left = paragraph.marL ?? 0
  const indent = paragraph.indent ?? 0
  // 悬挂缩进（indent 为负）时，符号占住左侧那一段，正文从 marL 开始
  const hang = Math.min(0, indent)
  const marker = paragraph.autoNum ? `${number ?? 1}.` : paragraph.bullet
  const whiteSpace = nowrap ? "pre" : "pre-wrap"

  if (marker) {
    return (
      <div
        style={{
          display: "flex",
          marginLeft: `${left + hang}cqw`,
          marginTop: `${before}cqw`,
          marginBottom: `${after}cqw`,
          lineHeight,
          textAlign: paragraph.align,
          whiteSpace,
        }}
      >
        <span aria-hidden style={{ flex: `0 0 ${-hang}cqw`, whiteSpace: "pre" }}>
          <PptxRunSpans paragraph={{ ...paragraph, runs: [{ text: marker }] }} scale={scale} textColor={textColor} slideWidth={slideWidth} />
        </span>
        <span style={{ flex: "1 1 auto" }}>
          <PptxRunSpans paragraph={paragraph} scale={scale} textColor={textColor} slideWidth={slideWidth} />
        </span>
      </div>
    )
  }
  return (
    <p
      style={{
        margin: `${before}cqw 0 ${after}cqw`,
        marginLeft: `${left}cqw`,
        textIndent: `${indent}cqw`,
        lineHeight,
        textAlign: paragraph.align,
        whiteSpace,
      }}
    >
      <PptxRunSpans paragraph={paragraph} scale={scale} textColor={textColor} slideWidth={slideWidth} />
    </p>
  )
}

function PptxParagraphs({
  paragraphs,
  scale,
  reduction,
  textColor,
  slideWidth,
  nowrap,
}: {
  paragraphs: PptxParagraph[]
  scale: number
  reduction: number
  textColor: string
  slideWidth: number
  nowrap?: boolean
}) {
  // 自动编号按级别累计；同一形状内跨段落连续（PowerPoint 的行为）
  const counters = new Map<number, number>()
  return (
    <>
      {paragraphs.map((paragraph, i) => {
        let number: number | undefined
        if (paragraph.autoNum) {
          const level = paragraph.level ?? 0
          const current = counters.get(level) ?? (paragraph.startAt ?? 1) - 1
          number = current + 1
          counters.set(level, number)
        }
        return (
          <PptxParagraphView
            key={i}
            paragraph={paragraph}
            number={number}
            scale={scale}
            reduction={reduction}
            textColor={textColor}
            slideWidth={slideWidth}
            nowrap={nowrap}
          />
        )
      })}
    </>
  )
}

function PptxTableShape({
  shape,
  textColor,
  slideWidth,
  slideHeight,
}: {
  shape: PptxShape
  textColor: string
  slideWidth: number
  slideHeight: number
}) {
  const table = shape.table
  if (!table) return null
  const scale = shape.fontScale ?? 1
  const reduction = shape.lnSpcReduction ?? 0
  const ratio = slideHeight / slideWidth
  const box: React.CSSProperties = {
    position: "absolute",
    left: `${shape.x}%`,
    top: `${shape.y}%`,
    width: `${shape.w}%`,
    height: `${shape.h}%`,
    transform: shape.rotation ? `rotate(${shape.rotation}deg)` : undefined,
  }
  return (
    <div style={box}>
      <table
        className="border-collapse"
        style={{ width: "100%", height: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}
      >
        <colgroup>
          {table.cols.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} style={{ height: row.height ? `${row.height}%` : undefined }}>
              {row.cells.map((cell, c) =>
                cell ? (
                  <td
                    key={c}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    style={{
                      backgroundColor: cell.fill,
                      border: cell.border ? "1px solid rgba(0,0,0,.28)" : undefined,
                      padding: cell.inset
                        ? `${cell.inset.t * ratio}cqw ${cell.inset.r}cqw ${cell.inset.b * ratio}cqw ${cell.inset.l}cqw`
                        : "0.35cqw 0.75cqw",
                      verticalAlign:
                        cell.anchor === "center" ? "middle" : cell.anchor === "bottom" ? "bottom" : "top",
                    }}
                  >
                    {cell.paragraphs ? (
                      <div style={{ textAlign: cell.align, fontSize: fontCqw(18 * scale, slideWidth) }}>
                        <PptxParagraphs
                          paragraphs={cell.paragraphs}
                          scale={scale}
                          reduction={reduction}
                          textColor={textColor}
                          slideWidth={slideWidth}
                        />
                      </div>
                    ) : null}
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

function SlideShape({
  shape,
  media,
  slideWidth,
  slideHeight,
  textColor,
}: {
  shape: PptxShape
  media: Map<string, string>
  slideWidth: number
  slideHeight: number
  textColor: string
}) {
  if (shape.table) {
    return <PptxTableShape shape={shape} textColor={textColor} slideWidth={slideWidth} slideHeight={slideHeight} />
  }
  const box: React.CSSProperties = {
    position: "absolute",
    left: `${shape.x}%`,
    top: `${shape.y}%`,
    width: `${shape.w}%`,
    height: `${shape.h}%`,
    backgroundColor: shape.fill,
    border: shape.line ? `1px solid ${shape.line}` : undefined,
    transform: shape.rotation ? `rotate(${shape.rotation}deg)` : undefined,
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
  const scale = shape.fontScale ?? 1
  const reduction = shape.lnSpcReduction ?? 0
  const ratio = slideHeight / slideWidth
  const inset = shape.inset
  return (
    <div
      style={{
        ...box,
        display: "flex",
        flexDirection: "column",
        justifyContent:
          shape.anchor === "center" ? "center" : shape.anchor === "bottom" ? "flex-end" : "flex-start",
        overflow: shape.nowrap ? "visible" : "hidden",
        padding: inset
          ? `${inset.t * ratio}cqw ${inset.r}cqw ${inset.b * ratio}cqw ${inset.l}cqw`
          : "0.5cqw 0.75cqw",
        writingMode: shape.vert ? "vertical-rl" : undefined,
        transform: shape.vert === "vert270" ? "rotate(180deg)" : undefined,
      }}
    >
      <PptxParagraphs
        paragraphs={shape.paragraphs}
        scale={scale}
        reduction={reduction}
        textColor={textColor}
        slideWidth={slideWidth}
        nowrap={shape.nowrap}
      />
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
      style={{ backgroundColor: slide.bg ?? "#ffffff" }}
    >
      {slide.shapes.map((shape, i) => (
        <SlideShape
          key={i}
          shape={shape}
          media={media}
          slideWidth={deck.width}
          slideHeight={deck.height}
          textColor={deck.textColor}
        />
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
