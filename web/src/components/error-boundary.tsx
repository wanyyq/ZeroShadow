import { Component, type ErrorInfo, type ReactNode } from "react"
import { Icon } from "@/components/icon"
import { translate } from "@/lib/i18n"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// 全局错误边界：任一子树抛错时不让整个应用白屏。
// 这里是 class 组件（React 的错误边界只能用 class 写），用不了 useT()，
// 所以直接调 translate()：它读的是当前语言，代价只是切换语言时这张兜底页不会自己重渲染。
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
            <h1 className="text-lg font-medium">{translate("ui.misc.page_error")}</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {this.state.error.message || translate("ui.misc.unknown_error")}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="rounded-md border border-border bg-background px-4 py-2 text-sm hover:bg-accent"
              onClick={() => this.setState({ error: null })}
            >
              {translate("ui.common.retry")}
            </button>
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90"
              onClick={() => window.location.reload()}
            >
              {translate("ui.common.reload")}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
