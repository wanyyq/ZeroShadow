import { Component, type ErrorInfo, type ReactNode } from "react"
import { Icon } from "@/components/icon"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// 全局错误边界：任一子树抛错时不让整个应用白屏。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui-error]", error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <Icon name="triangle-alert" className="size-6" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-medium">页面出现了一些问题</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {this.state.error.message || "发生了未知错误"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="rounded-md border border-border bg-background px-4 py-2 text-sm hover:bg-accent"
              onClick={() => this.setState({ error: null })}
            >
              重试
            </button>
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90"
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
