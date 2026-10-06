/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { getErrorMessage } from "@/lib/api"
import { Icon } from "@/components/icon"
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

/**
 * 统一的二次确认。
 *
 * 用法：
 *   const confirm = useConfirm()
 *   if (!(await confirm({ title: "删除成员？", description: "不可撤销。" }))) return
 *
 * 之所以做成 Promise 而不是每个页面各写一个 AlertDialog：
 * 破坏性操作散落在很多地方（删除成员、恢复默认头像、回滚备份、移出小组…），
 * 各写一遍很容易漏掉某一个，而漏掉的那个就会变成「一点就没了」。
 */

export interface ConfirmOptions {
  title: string
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  /** 默认 true：确认按钮用危险色。纯提示性确认可传 false */
  destructive?: boolean
  /**
   * 可选：确认后要执行的动作。
   * 传了它，对话框会在动作**成功完成后**才关闭；失败则保持打开并把错误
   * 显示在按钮上方。这是为了消灭"点了确定、对话框关了、但操作其实失败了"
   * 这类静默失败（throw 会让旧写法留下一个未处理的 Promise rejection）。
   */
  onConfirm?: () => void | Promise<void>
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = React.createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<ConfirmOptions | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState("")
  const resolverRef = React.useRef<((ok: boolean) => void) | null>(null)

  const confirm = React.useCallback<ConfirmFn>((options) => {
    // 上一次还没答复就先当取消，避免 Promise 永远悬着
    resolverRef.current?.(false)
    setFailure("")
    setBusy(false)
    setPending(options)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  const settle = React.useCallback((ok: boolean) => {
    resolverRef.current?.(ok)
    resolverRef.current = null
    setPending(null)
    setFailure("")
    setBusy(false)
  }, [])

  /** 确认：有 onConfirm 就先跑它，成功才关闭；失败保持打开并显示原因 */
  const handleConfirm = React.useCallback(async () => {
    const action = pending?.onConfirm
    if (!action) {
      settle(true)
      return
    }
    setFailure("")
    setBusy(true)
    try {
      await action()
      settle(true)
    } catch (err) {
      setFailure(getErrorMessage(err))
      setBusy(false)
    }
  }, [pending, settle])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !busy) settle(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description ? (
              <AlertDialogDescription>{pending.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} onClick={() => settle(false)}>
              {pending?.cancelText || "取消"}
            </AlertDialogCancel>
            <AlertDialogAction
              className={pending?.destructive === false ? undefined : "bg-destructive/10 text-destructive hover:bg-destructive/20"}
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void handleConfirm() }}
            >
              {busy && <Icon name="loader-2" className="animate-spin" data-icon="inline-start" />}
              {pending?.confirmText || "确定"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = React.useContext(ConfirmContext)
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider")
  return ctx
}
