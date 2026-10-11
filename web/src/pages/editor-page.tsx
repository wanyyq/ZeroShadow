import * as React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { Icon } from "@/components/icon"
import { fetchFileText, isVersionConflict, saveFileText } from "@/lib/api"
import type { FileTextResponse } from "@/lib/types"
import { cn } from "@/lib/utils"
import { currentLang, useT } from "@/lib/i18n"

/**
 * 在线文本编辑器。
 *
 * 旧版只有「下载地址 + fetch().text() + 一个大 textarea」：
 *   - 一律按 UTF-8 解码，GBK/Big5 的文件打开就是乱码；
 *   - 保存固定写 UTF-8，等于把原编码的文件改坏；
 *   - 没有行号、查找替换、跳转、字号、自动换行，也没有未保存拦截。
 *
 * 现在编码交给服务端识别与写回（见 server/src/encoding.js）：
 *   - 打开时带上识别结果与原始换行风格；
 *   - 用户可手动改编码重新解码（改编码需要原始字节，所以会重新拉一次）；
 *   - 保存时按选定编码编码，目标编码表示不了的字符由服务端拒绝并说明。
 */

const EOL_LABEL: Record<string, string> = { crlf: "CRLF", lf: "LF", cr: "CR" }
const FONT_MIN = 11
const FONT_MAX = 22
/** 超过这个大小给个提示：textarea 处理几 MB 文本会明显卡顿 */
const BIG_FILE_BYTES = 2 * 1024 * 1024

interface Match {
  start: number
  end: number
}

export default function EditorPage() {
  const t = useT()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const entryPath = params.get("path") || ""

  const [file, setFile] = React.useState<FileTextResponse | null>(null)
  const [content, setContent] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const [encoding, setEncoding] = React.useState("utf8")
  const [eol, setEol] = React.useState("lf")
  const [wrap, setWrap] = React.useState(false)
  const [showLineNumbers, setShowLineNumbers] = React.useState(true)
  const [fontSize, setFontSize] = React.useState(13)

  const [bar, setBar] = React.useState<"none" | "find" | "replace">("none")
  const [needle, setNeedle] = React.useState("")
  const [replacement, setReplacement] = React.useState("")
  const [caseSensitive, setCaseSensitive] = React.useState(false)
  const [useRegex, setUseRegex] = React.useState(false)
  const [matchInfo, setMatchInfo] = React.useState<{ count: number; index: number }>({ count: 0, index: 0 })
  const [gotoLine, setGotoLine] = React.useState("")
  const [cursor, setCursor] = React.useState({ line: 1, col: 1, selected: 0 })
  const [pendingEncoding, setPendingEncoding] = React.useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = React.useState(false)
  // 保存时与服务端版本冲突后置为非空：界面持续提示，直到用户重新加载或强制覆盖
  const [staleSince, setStaleSince] = React.useState<string | null>(null)

  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const gutterRef = React.useRef<HTMLDivElement>(null)
  // 用户明确选择"强制覆盖"后，这一次保存不带 baseVersion（服务端据此放行）
  const forceOverwriteRef = React.useRef(false)
  // 保存实现放在 ref 里：冲突提示里的「强制覆盖」需要重新触发保存，而直接让
  // save 递归引用自己会触发 react-hooks 的"声明前访问"报错，也让依赖数组写得别扭。
  const saveRef = React.useRef<() => void>(() => {})

  const dirty = content !== original
  const lineHeight = Math.round(fontSize * 1.6)
  const lineCount = React.useMemo(() => content.split("\n").length, [content])
  const showGutter = showLineNumbers && !wrap

  /* ---------------- 读取 ---------------- */
  const load = React.useCallback((enc?: string) => {
    if (!entryPath) return
    setLoading(true)
    setLoadError(null)
    fetchFileText(entryPath, enc)
      .then((d) => {
        setFile(d)
        setContent(d.content)
        setOriginal(d.content)
        setEncoding(d.encoding)
        setEol(d.eol)
        setStaleSince(null)
        forceOverwriteRef.current = false
        if (!d.encodingConfident) {
          toast.warning(t("ui.editor.encoding_guess_warning", { encoding: d.encoding }))
        }
      })
      .catch((err) => setLoadError((err as Error).message))
      .finally(() => setLoading(false))
  }, [entryPath, t])

  React.useEffect(() => { load() }, [load])

  /* ---------------- 保存 ---------------- */
  const save = React.useCallback(async () => {
    if (!entryPath || saving || !file || file.softReadOnly) return
    setSaving(true)
    // 正常情况下带上打开时的版本，让服务端能发现"别人已经改过"
    const baseVersion = forceOverwriteRef.current ? undefined : file.baseVersion
    forceOverwriteRef.current = false
    try {
      const r = await saveFileText({ path: entryPath, content, encoding, eol, baseVersion })
      setOriginal(content)
      setStaleSince(null)
      // 版本变了（写成功本身就是一次变更）：重新取一次，拿到新的 baseVersion，
      // 否则连续保存第二次会被自己的上一次写入判成冲突。
      void fetchFileText(entryPath, encoding).then((d) => {
        setFile(d)
        setEncoding(d.encoding)
        setEol(d.eol)
      }).catch(() => {})
      toast.success(t("ui.editor.saved_toast", {
        size: (r.bytes / 1024).toFixed(1),
        encoding,
        eol: r.eol !== "lf" ? " · " + EOL_LABEL[r.eol] : "",
      }))
    } catch (err) {
      if (isVersionConflict(err)) {
        // 关键：**不覆盖**。客户端手里的内容基于旧版本，直接写会抹掉对方的改动。
        // 时间戳跟随当前界面语言，而不是写死 zh-CN：英文界面下冒出中文格式的日期很突兀
        const at = new Date().toLocaleString(currentLang())
        setStaleSince(at)
        toast.error(t("ui.editor.conflict_title"), {
          duration: 20000,
          description: t("ui.editor.conflict_description"),
          action: {
            label: t("ui.common.reload"),
            onClick: () => load(encoding),
          },
          cancel: {
            label: t("ui.editor.force_overwrite"),
            onClick: () => {
              forceOverwriteRef.current = true
              saveRef.current()
            },
          },
        })
      } else {
        // 服务端会明确说明「哪些字符用目标编码表示不了」，原样展示即可
        toast.error((err as Error).message, { duration: 8000 })
      }
    } finally {
      setSaving(false)
    }
  }, [entryPath, saving, file, content, encoding, eol, load, t])

  // 每次渲染后把最新的 save 放进 ref，供冲突提示里的「强制覆盖」调用。
  // 放在 effect 里而不是渲染期：React 19 的 lint 禁止在渲染期间写 ref。
  // toast 的动作按钮必然是在渲染（与本次 effect）之后才被点击，所以取到的
  // 一定是最新实现。
  React.useEffect(() => {
    saveRef.current = save
  }, [save])

  /* ---------------- 查找 ---------------- */
  const matches = React.useMemo<Match[]>(() => {
    if (!needle) return []
    const out: Match[] = []
    if (useRegex) {
      let re: RegExp
      try {
        re = new RegExp(needle, caseSensitive ? "g" : "gi")
      } catch {
        return []
      }
      let m: RegExpExecArray | null
      let guard = 0
      while ((m = re.exec(content)) !== null && guard < 5000) {
        if (m[0] === "") { re.lastIndex += 1; continue }
        out.push({ start: m.index, end: m.index + m[0].length })
        guard += 1
      }
      return out
    }
    const hay = caseSensitive ? content : content.toLowerCase()
    const nee = caseSensitive ? needle : needle.toLowerCase()
    let from = 0
    while (from <= hay.length - nee.length) {
      const i = hay.indexOf(nee, from)
      if (i < 0) break
      out.push({ start: i, end: i + nee.length })
      from = i + Math.max(1, nee.length)
      if (out.length > 5000) break
    }
    return out
  }, [needle, content, caseSensitive, useRegex])

  React.useEffect(() => {
    setMatchInfo((prev) => ({ count: matches.length, index: matches.length ? Math.min(prev.index, matches.length - 1) : 0 }))
  }, [matches])

  const revealMatch = React.useCallback((index: number) => {
    const ta = taRef.current
    const m = matches[index]
    if (!ta || !m) return
    ta.focus()
    ta.setSelectionRange(m.start, m.end)
    // 滚到中间，避免命中行贴着边缘
    const before = content.slice(0, m.start)
    const line = before.split("\n").length
    const target = (line - 3) * lineHeight
    ta.scrollTop = Math.max(0, target)
  }, [matches, content, lineHeight])

  const findNext = (dir: 1 | -1 = 1) => {
    if (!matches.length) return
    const ta = taRef.current
    const pos = ta ? ta.selectionEnd : 0
    let idx: number
    if (dir === 1) {
      idx = matches.findIndex((m) => m.start > pos - 1)
      if (idx < 0) idx = 0
    } else {
      idx = -1
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        if (matches[i].end < pos) { idx = i; break }
      }
      if (idx < 0) idx = matches.length - 1
    }
    setMatchInfo((p) => ({ ...p, index: idx }))
    revealMatch(idx)
  }

  const replaceCurrent = () => {
    const m = matches[matchInfo.index]
    if (!m) return
    const next = content.slice(0, m.start) + replacement + content.slice(m.end)
    setContent(next)
    requestAnimationFrame(() => revealMatch(Math.min(matchInfo.index, Math.max(0, matches.length - 1))))
  }

  const replaceAll = () => {
    if (!matches.length) return
    let next: string
    if (useRegex) {
      try {
        next = content.replace(new RegExp(needle, caseSensitive ? "g" : "gi"), replacement)
      } catch {
        toast.error(t("ui.editor.invalid_regex"))
        return
      }
    } else {
      next = matches
        .slice()
        .reverse()
        .reduce((acc, m) => acc.slice(0, m.start) + replacement + acc.slice(m.end), content)
    }
    setContent(next)
    toast.success(t("ui.editor.replaced_count", { count: matches.length }))
    setMatchInfo({ count: 0, index: 0 })
  }

  /* ---------------- 光标与跳转 ---------------- */
  const syncCursor = React.useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const before = content.slice(0, ta.selectionStart)
    const lines = before.split("\n")
    setCursor({
      line: lines.length,
      col: (lines[lines.length - 1]?.length || 0) + 1,
      selected: ta.selectionEnd - ta.selectionStart,
    })
  }, [content])

  const jumpToLine = () => {
    const n = Number(gotoLine)
    if (!Number.isFinite(n) || n < 1) return
    const lines = content.split("\n")
    const target = Math.min(Math.floor(n), lines.length)
    let offset = 0
    for (let i = 0; i < target - 1; i += 1) offset += lines[i].length + 1
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(offset, offset)
    ta.scrollTop = Math.max(0, (target - 3) * lineHeight)
    setGotoLine("")
    syncCursor()
  }

  /* ---------------- 离开拦截 ---------------- */
  const requestClose = () => {
    if (dirty) setConfirmLeave(true)
    else navigate(-1)
  }

  /* ---------------- 快捷键 ---------------- */
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return }
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); setBar("find") }
      else if (mod && e.key.toLowerCase() === "h") { e.preventDefault(); setBar("replace") }
      else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); setBar("find") }
      else if (e.key === "F3") { e.preventDefault(); findNext(e.shiftKey ? -1 : 1) }
      else if (e.key === "Escape") {
        if (bar !== "none") setBar("none")
        else requestClose()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  })

  // Tab 插入两个空格而不是跳走焦点（编辑器里更符合直觉）。
  // 带修饰键的 Tab 不拦截：否则键盘用户没法把焦点移出编辑区。
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    const ta = e.currentTarget
    const { selectionStart: s, selectionEnd: en } = ta
    const next = content.slice(0, s) + "  " + content.slice(en)
    setContent(next)
    requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2))
  }

  /* ---------------- 换编码：需要原始字节，重新拉一次 ---------------- */
  const changeEncoding = (next: string) => {
    if (next === encoding) return
    if (dirty) { setPendingEncoding(next); return }
    load(next === file?.encoding ? undefined : next)
  }
  const confirmEncodingSwitch = () => {
    if (!pendingEncoding) return
    const next = pendingEncoding
    setPendingEncoding(null)
    load(next === file?.encoding ? undefined : next)
  }

  const sizeText = file ? `${(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB` : ""

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* 工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <Icon name="pencil-line" className="size-4 shrink-0 text-muted-foreground" />
        <span className="max-w-56 truncate text-sm font-medium" title={file?.name || entryPath}>
          {file?.name || entryPath.split("/").pop() || t("ui.editor.untitled")}
        </span>
        {dirty && <Badge variant="secondary" className="text-[10px]">{t("ui.common.unsaved")}</Badge>}
        {file?.softReadOnly && <Badge variant="outline" className="text-[10px]">{t("ui.editor.readonly_dir")}</Badge>}
        {/* 版本冲突后持续可见：避免用户以为"保存成功"了 */}
        {staleSince && (
          <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive" title={t("ui.editor.conflict_detected_at", { time: staleSince })}>
            {t("ui.editor.modified_by_others")}
          </Badge>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* 编码 */}
          <Select value={encoding} onValueChange={(v) => changeEncoding(v || "utf8")}>
            <SelectTrigger size="sm" className="h-8 w-[13.5rem] text-xs" title={t("ui.editor.encoding_title")}>
              <SelectValue render={(_p, s) => <>{file?.encodings.find((x) => x.id === s.value)?.label || s.value}</>}>
                {encoding}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(file?.encodings || []).map((x) => (
                <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* 换行符 */}
          <Select value={eol} onValueChange={(v) => setEol(v || "lf")}>
            <SelectTrigger size="sm" className="h-8 w-24 text-xs" title={t("ui.editor.eol_title")}>
              <SelectValue render={(_p, s) => <>{EOL_LABEL[s.value || "lf"]}</>}>{EOL_LABEL[eol]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="crlf">{t("ui.editor.eol_crlf")}</SelectItem>
              <SelectItem value="lf">{t("ui.editor.eol_lf")}</SelectItem>
              <SelectItem value="cr">{t("ui.editor.eol_cr")}</SelectItem>
            </SelectContent>
          </Select>

          <Button
            size="icon-xs" variant={bar === "find" ? "secondary" : "ghost"} title={t("ui.editor.find_title")}
            aria-pressed={bar === "find"} onClick={() => setBar(bar === "find" ? "none" : "find")}
          >
            <Icon name="search" />
          </Button>
          <Button
            size="icon-xs" variant={bar === "replace" ? "secondary" : "ghost"} title={t("ui.editor.replace_title")}
            aria-pressed={bar === "replace"} onClick={() => setBar(bar === "replace" ? "none" : "replace")}
          >
            <Icon name="replace" />
          </Button>
          <Button
            size="icon-xs" variant={wrap ? "secondary" : "ghost"} title={t("ui.editor.wrap_title")}
            aria-pressed={wrap} onClick={() => setWrap(!wrap)}
          >
            <Icon name="wrap-text" />
          </Button>
          <Button
            size="icon-xs" variant={showLineNumbers ? "secondary" : "ghost"} title={t("ui.editor.line_numbers_title")}
            aria-pressed={showLineNumbers} onClick={() => setShowLineNumbers(!showLineNumbers)}
          >
            <Icon name="list-ordered" />
          </Button>
          <Button size="icon-xs" variant="ghost" title={t("ui.editor.font_decrease")} disabled={fontSize <= FONT_MIN} onClick={() => setFontSize((s) => Math.max(FONT_MIN, s - 1))}>
            <Icon name="minus" />
          </Button>
          <span className="w-6 text-center text-xs tabular-nums text-muted-foreground">{fontSize}</span>
          <Button size="icon-xs" variant="ghost" title={t("ui.editor.font_increase")} disabled={fontSize >= FONT_MAX} onClick={() => setFontSize((s) => Math.min(FONT_MAX, s + 1))}>
            <Icon name="plus" />
          </Button>

          <Button size="sm" disabled={!dirty || saving || !!file?.softReadOnly} onClick={save} title={t("ui.editor.save_title")}>
            {saving ? <Icon name="loader-2" className="animate-spin" data-icon="inline-start" /> : null}
            {t("ui.common.save")}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={requestClose} title={t("ui.editor.close_title")}><Icon name="x" /></Button>
        </div>
      </div>

      {/* 查找 / 替换条 */}
      {bar !== "none" && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-2">
          <Input
            autoFocus value={needle} onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findNext(e.shiftKey ? -1 : 1) } }}
            placeholder={useRegex ? t("ui.editor.regex_placeholder") : t("ui.editor.find_placeholder")}
            className="h-8 w-56 font-mono text-xs"
          />
          <span className="w-16 text-center text-xs tabular-nums text-muted-foreground">
            {matches.length ? `${matchInfo.index + 1}/${matches.length}` : t("ui.editor.no_matches")}
          </span>
          <Button size="icon-xs" variant="ghost" title={t("ui.editor.prev_match_title")} disabled={!matches.length} onClick={() => findNext(-1)}>
            <Icon name="chevron-up" />
          </Button>
          <Button size="icon-xs" variant="ghost" title={t("ui.editor.next_match_title")} disabled={!matches.length} onClick={() => findNext(1)}>
            <Icon name="chevron-down" />
          </Button>
          <Button
            size="xs" variant={caseSensitive ? "secondary" : "ghost"} aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive(!caseSensitive)}
          >
            {t("ui.editor.case_sensitive")}
          </Button>
          <Button
            size="xs" variant={useRegex ? "secondary" : "ghost"} aria-pressed={useRegex}
            onClick={() => setUseRegex(!useRegex)}
          >
            {t("ui.editor.regex_toggle")}
          </Button>

          {bar === "replace" && (
            <>
              <Input
                value={replacement} onChange={(e) => setReplacement(e.target.value)}
                placeholder={t("ui.editor.replace_placeholder")} className="h-8 w-48 font-mono text-xs"
              />
              <Button size="xs" variant="outline" disabled={!matches.length} onClick={replaceCurrent}>{t("ui.editor.replace")}</Button>
              <Button size="xs" variant="outline" disabled={!matches.length} onClick={replaceAll}>{t("ui.editor.replace_all")}</Button>
            </>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t("ui.editor.go_to_line")}</span>
            <Input
              value={gotoLine}
              onChange={(e) => setGotoLine(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); jumpToLine() } }}
              placeholder={t("ui.editor.line_number_placeholder")} inputMode="numeric" className="h-8 w-20 text-xs"
            />
          </div>
        </div>
      )}

      {/* 正文 */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon name="loader-2" className="size-4 animate-spin" /> {t("ui.editor.reading_file")}
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Icon name="file-warning" className="size-10 text-muted-foreground" />
          <p className="text-sm font-medium">{t("ui.editor.cannot_open")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{loadError}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => load()}>{t("ui.common.retry")}</Button>
            <Button size="sm" variant="ghost" onClick={() => navigate(-1)}>{t("ui.common.back")}</Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {showGutter && (
            <div
              ref={gutterRef}
              aria-hidden="true"
              className="w-14 shrink-0 overflow-hidden border-r border-border/50 bg-muted/20 py-3 text-right font-mono text-muted-foreground/60 select-none"
              style={{ fontSize, lineHeight: `${lineHeight}px` }}
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="pr-2">{i + 1}</div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onSelect={syncCursor}
            onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop }}
            spellCheck={false}
            readOnly={!!file?.softReadOnly}
            placeholder={t("ui.editor.empty_file_placeholder")}
            className={cn(
              "min-h-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono outline-none",
              wrap ? "whitespace-pre-wrap break-words" : "overflow-auto whitespace-pre"
            )}
            style={{ fontSize, lineHeight: `${lineHeight}px`, tabSize: 2 }}
          />
        </div>
      )}

      {/* 状态栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>{t("ui.editor.cursor_position", { line: cursor.line, col: cursor.col })}</span>
        {cursor.selected > 0 && <span>{t("ui.editor.selected_count", { count: cursor.selected })}</span>}
        <span>{t("ui.editor.total_lines", { n: lineCount })}</span>
        <span>{t("ui.editor.char_count", { n: content.length })}</span>
        <span>{encoding}</span>
        <span>{EOL_LABEL[eol]}</span>
        {sizeText && <span>{sizeText}</span>}
        {file && file.size > BIG_FILE_BYTES && (
          <span className="text-amber-600 dark:text-amber-500">{t("ui.editor.big_file_hint")}</span>
        )}
        <span className="ml-auto">{t("ui.editor.shortcuts_hint")}</span>
      </div>

      {/* 未保存确认 */}
      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.editor.unsaved_changes_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ui.editor.unsaved_changes_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ui.editor.keep_editing")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => { setConfirmLeave(false); navigate(-1) }}
            >
              {t("ui.editor.discard_and_leave")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 换编码确认（需要重新读取原始字节，会丢弃未保存改动） */}
      <AlertDialog open={pendingEncoding !== null} onOpenChange={(o) => !o && setPendingEncoding(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.editor.encoding_switch_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ui.editor.encoding_switch_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmEncodingSwitch}>{t("ui.editor.encoding_switch_confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
