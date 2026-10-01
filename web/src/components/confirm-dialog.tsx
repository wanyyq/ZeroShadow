/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
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
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = React.createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<ConfirmOptions | null>(null)
  const resolverRef = React.useRef<((ok: boolean) => void) | null>(null)

  const confirm = React.useCallback<ConfirmFn>((options) => {
    // 上一次还没答复就先当取消，避免 Promise 永远悬着
    resolverRef.current?.(false)
    setPending(options)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  const settle = React.useCallback((ok: boolean) => {
    resolverRef.current?.(ok)
    resolverRef.current = null
    setPending(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o) settle(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description ? (
              <AlertDialogDescription>{pending.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {pending?.cancelText || "取消"}
            </AlertDialogCancel>
            <AlertDialogAction
              className={pending?.destructive === false ? undefined : "bg-destructive/10 text-destructive hover:bg-destructive/20"}
              onClick={(e) => { e.preventDefault(); settle(true) }}
            >
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
