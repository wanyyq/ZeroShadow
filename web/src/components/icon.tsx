import { cn } from "@/lib/utils"

interface IconProps extends Omit<React.ComponentProps<"span">, "children"> {
  name: string
  strokeWidth?: number
}

/**
 * AIGC.md 图标规范：<i data-lucide="..."> 占位，
 * 由 /resources/lucide.min.js 的 createIcons() 渲染，
 * 颜色恒为 currentColor，随文字状态联动。
 *
 * 其余 props 会透传到外层 span，因此可以写 data-icon="inline-start|inline-end"，
 * 触发 Button / TabsTrigger 等组件内置的图标内边距（has-data-[icon=...] 选择器）。
 */
export function Icon({ name, className, strokeWidth, ...props }: IconProps) {
  const extra =
    strokeWidth !== undefined ? { "stroke-width": String(strokeWidth) } : undefined
  return (
    <span key={name} className={cn("lucide-icon size-4", className)} aria-hidden="true" {...props}>
      <i data-lucide={name} {...extra} />
    </span>
  )
}
