/**
 * mdx-fallbacks.tsx —— 12 个 MDX 组件的自包含实现
 *
 * 用途：当你的 Fumadocs 版本（或二次开发时手写的 mdx-components.tsx）
 * 缺少某个组件时，用它兜底。报错长这样：
 *
 *   Expected component `Step` to be defined: you likely forgot to import, pass, or provide it.
 *
 * 这些实现**不依赖 fumadocs-ui**，只用 React + Tailwind，所以任何 Fumadocs
 * 版本都能跑。样式刻意做得克制，与你站点的主题（浅色/深色）都能共存。
 *
 * 把这个文件放到你站点里，例如：
 *   <你的站点>/components/mdx-fallbacks.tsx
 */

import * as React from "react"

/* ------------------------------------------------------------------ Callout */

type CalloutType = "info" | "warn" | "error" | "success"

const CALLOUT_STYLE: Record<CalloutType, { box: string; title: string; badge: string }> = {
  info: {
    box: "border-blue-500/40 bg-blue-500/5",
    title: "text-blue-700 dark:text-blue-300",
    badge: "ℹ",
  },
  warn: {
    box: "border-amber-500/45 bg-amber-500/5",
    title: "text-amber-700 dark:text-amber-300",
    badge: "⚠",
  },
  error: {
    box: "border-red-500/45 bg-red-500/5",
    title: "text-red-700 dark:text-red-300",
    badge: "✕",
  },
  success: {
    box: "border-emerald-500/45 bg-emerald-500/5",
    title: "text-emerald-700 dark:text-emerald-300",
    badge: "✓",
  },
}

export function Callout({
  type = "info",
  title,
  children,
}: {
  type?: CalloutType
  title?: string
  children?: React.ReactNode
}) {
  const style = CALLOUT_STYLE[type] ?? CALLOUT_STYLE.info
  return (
    <div className={`not-prose my-4 rounded-lg border border-l-4 px-4 py-3 ${style.box}`}>
      <div className={`mb-1 flex items-center gap-2 text-sm font-semibold ${style.title}`}>
        <span aria-hidden>{style.badge}</span>
        <span>{title ?? { info: "说明", warn: "注意", error: "警告", success: "完成" }[type]}</span>
      </div>
      <div className="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {children}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- Cards */

export function Cards({ children }: { children?: React.ReactNode }) {
  return (
    <div className="not-prose my-4 grid gap-3 sm:grid-cols-2">
      {children}
    </div>
  )
}

export function Card({
  title,
  description,
  href,
  children,
}: {
  title?: string
  description?: string
  href?: string
  children?: React.ReactNode
}) {
  const inner = (
    <>
      <div className="font-medium">{title}</div>
      {(description || children) && (
        <div className="mt-1 text-sm opacity-70">{description ?? children}</div>
      )}
    </>
  )
  const base =
    "block rounded-lg border bg-fd-card px-4 py-3 text-sm transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/40"
  return href ? (
    <a href={href} className={base}>
      {inner}
    </a>
  ) : (
    <div className={base}>{inner}</div>
  )
}

/* --------------------------------------------------------------- Steps/Step */

export function Steps({ children }: { children?: React.ReactNode }) {
  return (
    <div className="not-prose my-4 border-l border-dashed border-fd-border pl-6">{children}</div>
  )
}

export function Step({ children }: { children?: React.ReactNode }) {
  // 序号由 CSS 计数器生成，这样作者不需要自己写 1. 2. 3.
  return (
    <div className="relative pb-6 last:pb-0 [counter-increment:fd-step]">
      <span
        className="absolute -left-[35px] flex h-6 w-6 items-center justify-center rounded-full border bg-fd-card text-xs font-medium
                   before:content-[counter(fd-step)]"
      />
      <div className="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {children}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Tabs/Tab */

export function Tabs({ items, children }: { items?: string[]; children?: React.ReactNode }) {
  const tabs = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<
    { value?: string; children?: React.ReactNode }
  >[]
  const labels = items?.length ? items : tabs.map((t) => t.props.value ?? "")
  return <TabsClient labels={labels} panels={tabs.map((t) => t.props.children)} />
}

/** 只给 Tabs 内部用；因为要用 useState，必须是客户端组件 */
function TabsClient({ labels, panels }: { labels: string[]; panels: React.ReactNode[] }) {
  const [active, setActive] = React.useState(0)
  return (
    <div className="not-prose my-4 overflow-hidden rounded-lg border">
      <div role="tablist" className="flex flex-wrap gap-1 border-b bg-fd-muted/40 px-2 py-1.5">
        {labels.map((label, i) => (
          <button
            key={label || i}
            role="tab"
            type="button"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={
              "rounded-md px-3 py-1 text-sm transition-colors " +
              (i === active
                ? "bg-fd-card font-medium shadow-sm"
                : "opacity-65 hover:opacity-100")
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div className="prose prose-sm max-w-none p-4 dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {panels[active]}
      </div>
    </div>
  )
}

/** 占位组件：真正的内容由 Tabs 从 children 里取走，这里不会被单独渲染 */
export function Tab({ children }: { value?: string; children?: React.ReactNode }) {
  return <>{children}</>
}

/* ------------------------------------------------------------ Files/File/Folder */

export function Files({ children }: { children?: React.ReactNode }) {
  return (
    <div className="not-prose my-4 rounded-lg border bg-fd-muted/20 px-4 py-3 font-mono text-sm">
      {children}
    </div>
  )
}

export function Folder({
  name,
  children,
  defaultOpen = true,
}: {
  name?: string
  children?: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="cursor-pointer list-none select-none py-0.5 hover:opacity-80">
        <span className="text-fd-muted-foreground">▸ </span>
        <span className="font-medium">{name}/</span>
      </summary>
      <div className="ml-3 border-l border-fd-border pl-3">{children}</div>
    </details>
  )
}

export function File({ name }: { name?: string }) {
  return <div className="py-0.5 pl-4 opacity-80">{name}</div>
}

/* ---------------------------------------------------- Accordions/Accordion */

export function Accordions({ children }: { children?: React.ReactNode }) {
  return <div className="not-prose my-4 divide-y rounded-lg border">{children}</div>
}

export function Accordion({ title, children }: { title?: string; children?: React.ReactNode }) {
  // 用原生 <details>：不需要 JS，天然支持键盘与无障碍，也不受版本影响
  return (
    <details className="group px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium hover:opacity-80">
        <span>{title}</span>
        <span className="shrink-0 opacity-50 transition-transform group-open:rotate-90">▸</span>
      </summary>
      <div className="prose prose-sm mt-3 max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {children}
      </div>
    </details>
  )
}

/* ------------------------------------------------------- 合并助手（推荐用法） */

/** 本文档用到的全部组件名 */
export const ZEROSHADOW_COMPONENTS = [
  "Callout",
  "Cards",
  "Card",
  "Steps",
  "Step",
  "Tabs",
  "Tab",
  "Files",
  "File",
  "Folder",
  "Accordions",
  "Accordion",
] as const

const IMPLEMENTATIONS: Record<string, unknown> = {
  Callout,
  Cards,
  Card,
  Steps,
  Step,
  Tabs,
  Tab,
  Files,
  File,
  Folder,
  Accordions,
  Accordion,
}

/**
 * 把本文档需要的组件补进一份**已有的**组件表里 —— 只补缺失的，绝不覆盖你已有的。
 *
 * 你的站点已经有大量文档，所以千万不要整份替换 mdx-components.tsx：
 * 那会把其它文档依赖的组件定义一起冲掉。正确做法是**只加两行**：
 *
 *   import defaultMdxComponents from 'fumadocs-ui/mdx';
 *   import { mergeZeroshadowComponents } from './components/mdx-fallbacks';  // ← 加这行
 *
 *   export function getMDXComponents(components?: MDXComponents) {
 *     return {
 *       ...defaultMdxComponents,
 *       ...mergeZeroshadowComponents(defaultMdxComponents),                 // ← 加这行
 *       ...components,
 *     };
 *   }
 *
 * 这样：fumadocs-ui 有的就用它自己的（样式最贴合你的站），
 * 只有它没有的（例如你的版本缺 Step）才用这里的实现。
 */
export function mergeZeroshadowComponents(
  defaults?: Record<string, unknown> | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const missing: string[] = []
  for (const name of ZEROSHADOW_COMPONENTS) {
    if (!defaults || !defaults[name]) {
      out[name] = IMPLEMENTATIONS[name]
      missing.push(name)
    }
  }
  if (missing.length && typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    console.info(
      "[mdx] fumadocs-ui 未提供以下组件，已使用本地兜底实现：" + missing.join(", ")
    )
  }
  return out
}
