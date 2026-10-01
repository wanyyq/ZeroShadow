import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// 分段控件：2–7 个选项的互斥选择用它，而不是一排手写 active 状态的 Button。
// 视觉语言与 ui/tabs.tsx 的 default 变体保持一致：bg-muted 轨道 + 选中项浮起。
// Base UI 的 Toggle 用 data-pressed 表示选中（属性存在即选中，不是 data-pressed="true"）。

const toggleGroupVariants = cva(
  "group/toggle-group inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col",
  {
    variants: {
      size: {
        sm: "h-7",
        default: "h-8",
        lg: "h-9",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const toggleGroupItemVariants = cva(
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all duration-200 ease-out select-none hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:data-pressed:border-input dark:data-pressed:bg-input/30 dark:data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        sm: "px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        default: "text-sm",
        lg: "px-2.5 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

function ToggleGroup<Value extends string>({
  className,
  size = "default",
  orientation = "horizontal",
  ...props
}: ToggleGroupPrimitive.Props<Value> & VariantProps<typeof toggleGroupVariants>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(toggleGroupVariants({ size }), className)}
      {...props}
    />
  )
}

function ToggleGroupItem<Value extends string>({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props<Value> & VariantProps<typeof toggleGroupItemVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(toggleGroupItemVariants({ size }), className)}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem, toggleGroupVariants, toggleGroupItemVariants }
