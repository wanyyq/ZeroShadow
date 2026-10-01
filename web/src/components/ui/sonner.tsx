import { createPortal } from "react-dom"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/components/theme-provider"
import { Icon } from "@/components/icon"

/**
 * 通知必须盖在所有弹窗之上。
 *
 * 注意这里的 createPortal：`#root` 在 index.css 里是 `position: relative; z-index: 1`，
 * 也就是一个**层叠上下文**。Sonner 自己的 z-index 高达 999999999，但只要它渲染在 #root
 * 里面，这个值就只在 #root 内部有效；而对话框是 portal 到 document.body 的（z-40/50），
 * 属于 body 层级，于是**无论 Sonner 的 z-index 多大都会被弹窗盖住**。
 * 把它 portal 到 body 之后才真正生效。
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme()

  const node = (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <Icon name="circle-check" className="size-4" />,
        info: <Icon name="info" className="size-4" />,
        warning: <Icon name="triangle-alert" className="size-4" />,
        error: <Icon name="octagon-x" className="size-4" />,
        loading: <Icon name="loader-2" className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          zIndex: 2147483000,
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast edge-highlight",
        },
      }}
      {...props}
    />
  )

  // SSR / 非浏览器环境下没有 document
  if (typeof document === "undefined") return node
  return createPortal(node, document.body)
}

export { Toaster }
