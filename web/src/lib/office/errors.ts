/**
 * 文档预览的可预期失败。
 *
 * 预览页只对这类错误给出明确的中文提示（走 `ui.office.error.*` 文案），
 * 其它意外异常统一归到 `ui.office.error.generic`。之所以用 `code` 而不是
 * 消息文本：解析层不认识 i18n（它在 Node 里也要能跑），由组件决定措辞。
 */
export type OfficeErrorCode =
  | "invalid"
  | "encrypted"
  | "unsupported"
  | "too_large"
  | "empty"
  | "network"

export class OfficeError extends Error {
  readonly code: OfficeErrorCode

  constructor(code: OfficeErrorCode) {
    super(code)
    this.name = "OfficeError"
    this.code = code
  }
}

export function isOfficeError(err: unknown): err is OfficeError {
  return err instanceof OfficeError
}
