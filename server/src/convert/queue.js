/**
 * convert/queue.js —— 转换任务的并发闸门。
 *
 * 为什么要它：图片转换走原生的 sharp、PDF 排版是纯 CPU 循环，两者都会把单个核心吃满。
 * 网盘是"一个人的机器给全组人用"，没有配额也没有进程管理器 —— 十个大图同时转换就能
 * 让别人的文件列表卡住。所以这里限制**同时进行的转换数**，超出的排队，队列也满了直接
 * 让调用方回 503（前端得到的是"稍后再试"，而不是等到超时）。
 *
 * 与 `thumbs.js` 的队列是同一思路，但参数不同：缩略图是"可降级的辅助功能"（排队满了
 * 退回原图即可），转换是用户主动发起的操作，所以给更大的执行位与队列。
 *
 * 注意这里**不持有任何任务状态**：只在"开始真正干活"到"写出产物"之间占一个位。
 * 排队期间任务会停在 1%（前端看到的是"进行中"），不会超时也不会丢失。
 */

/** 同时进行的转换数上限 */
const MAX_CONCURRENT = 4
/** 允许排队的任务数上限；超过就立刻 503，避免把内存与用户耐心一起耗光 */
const MAX_WAITING = 32

let active = 0
const waiters = []

function busyError() {
  const err = new Error("转换任务过多，请稍后再试")
  err.status = 503
  err.errorKey = "api.fs.convert_busy"
  return err
}

/** 队列是否已经排满（路由用它决定"直接回 503"还是"建个任务排队"） */
export function convertQueueFull() {
  return active >= MAX_CONCURRENT && waiters.length >= MAX_WAITING
}

/** 当前正在执行的数量与排队数量（仅用于日志/诊断） */
export function convertQueueState() {
  return { active, waiting: waiters.length }
}

/**
 * 申请一个执行位。返回的 `release` 必须在 finally 里调用一次。
 * 队列已满时抛 503（调用方一般不 catch，交给统一错误处理）。
 */
export async function acquireConvertSlot() {
  if (active < MAX_CONCURRENT) {
    active += 1
    return release
  }
  if (waiters.length >= MAX_WAITING) throw busyError()
  await new Promise((resolve) => waiters.push(resolve))
  active += 1
  return release
}

function release() {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}
