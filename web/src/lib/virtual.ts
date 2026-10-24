import * as React from "react"

/**
 * lib/virtual.ts —— 定高列表的窗口化渲染（"虚拟滚动"）
 *
 * 用途：文件列表在几百项时，原来会把每一行都渲染成真实 DOM。每行都带
 * Tooltip / ContextMenu / 事件处理器，滚动时既占内存又掉帧。
 *
 * 做法：调用方把 `ref` / `onScroll` 挂到**滚动容器**上，并按 `start..end`
 * 切片渲染；上下各垫一个等高占位块，保证滚动条长度与真实内容一致。
 *
 * 约束（改之前先看）：
 *   - 只适用于**等高**的行。文件列表行高由 CSS 的 `--row-py` 决定（舒适 / 紧凑
 *     两档），所以行高由调用方量出来再传进来，不要在这里写死；
 *   - 网格视图**不用**它：卡片高度会随文件名行数变化，硬套定高会把内容裁掉，
 *     那边用"渐进渲染"（滚到底再多渲染一批）更稳。
 */
export interface VirtualRows {
  /** 挂到滚动容器的 onScroll */
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
  start: number
  end: number
  /** 顶部占位块高度（px） */
  padTop: number
  /** 底部占位块高度（px） */
  padBottom: number
}

/**
 * @param containerRef 滚动容器的 ref —— 由**调用方**持有并挂到 JSX 上。
 *   刻意不从这个 hook 里返回 ref：eslint 的 `react-hooks/refs` 会把
 *   "渲染期间读取 hook 返回值里的 .ref" 判成错误，而让调用方持有 ref 既符合
 *   惯例、也不会误报。
 * @param count 总行数
 * @param rowHeight 单行高度（px），建议由调用方测量
 * @param resetKey 变化时把滚动位置归零（切换目录 / 搜索词时用）
 * @param overscan 视口上下各多渲染几行，缓解快速滚动时的白屏
 */
export function useVirtualRows(
  containerRef: React.RefObject<HTMLDivElement | null>,
  count: number,
  rowHeight: number,
  resetKey?: string,
  overscan = 6
): VirtualRows {
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewport, setViewport] = React.useState(0)

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setViewport(el.clientHeight)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])

  // 换目录 / 换搜索词：容器复用，但滚动位置必须回到顶部，
  // 否则窗口会停在上一个目录的偏移量上、只显示中间几行。
  React.useEffect(() => {
    setScrollTop(0)
    if (containerRef.current) containerRef.current.scrollTop = 0
  }, [resetKey, containerRef])

  const onScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const height = viewport || 480
  const perRow = Math.max(1, rowHeight)
  const first = Math.max(0, Math.floor(scrollTop / perRow) - overscan)
  const visible = Math.ceil(height / perRow) + overscan * 2
  const start = Math.min(first, Math.max(0, count - 1))
  const end = Math.min(count, start + visible)

  return {
    onScroll,
    start,
    end,
    padTop: start * perRow,
    padBottom: Math.max(0, (count - end) * perRow),
  }
}

/**
 * 网格视图的"渐进渲染"：先渲染 `step` 个，滚到接近底部再追加一批。
 *
 * 相比定高虚拟滚动，它不需要知道卡片高度，也不会因为文件名换行而裁掉内容；
 * 代价是 DOM 会随滚动累积（但网格一屏最多几十个，几百项时仍远好于全量渲染）。
 */
export function useProgressiveReveal(count: number, step = 120, resetKey?: string) {
  const [limit, setLimit] = React.useState(step)
  React.useEffect(() => {
    setLimit(step)
  }, [resetKey, step])
  const revealMore = React.useCallback(() => {
    setLimit((cur) => Math.min(cur + step, count))
  }, [count, step])
  // 实际渲染量永远不超过总数（count 变小后不必额外收敛 state）
  const shown = Math.min(limit, count)
  return { limit: shown, revealMore, done: shown >= count }
}
