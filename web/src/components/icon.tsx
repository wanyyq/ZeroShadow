import { cn } from "@/lib/utils"

interface IconProps {
  name: string
  className?: string
  strokeWidth?: number
}

/**
 * AIGC.md 图标规范：<i data-lucide="..."> 占位，
 * 由 /resources/lucide.min.js 的 createIcons() 渲染，
 * 颜色恒为 currentColor，随文字状态联动。
 */
export function Icon({ name, className, strokeWidth }: IconProps) {
  const extra =
    strokeWidth !== undefined ? { "stroke-width": String(strokeWidth) } : undefined
  return (
    <span key={name} className={cn("lucide-icon size-4", className)} aria-hidden="true">
      <i data-lucide={name} {...extra} />
    </span>
  )
}
