import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/components/theme-provider"
import { Icon } from "@/components/icon"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme()

  return (
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
          zIndex: 9999,
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
}

export { Toaster }
