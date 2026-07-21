// REQ-083:模型 contract 拉取在 sidecar respawn 窗口内的重试参数(单测覆盖)。
//
// 背景(2026-07-10 真机日志定案):sidecar respawn 窗口内,弹窗一次性拉取引擎模型表失败被
// 静默吞掉会让已配置供应商整体消失。canonical picker 现在由 typed model.list 驱动；失败时
// fail-closed 呈现目录行，并在弹窗存活期间按下列节奏自愈，不触发任何 sidecar 重启。

/** 0-based 尝试次数 → 1s / 2s / 4s / 8s 封顶(弹窗短命,持续重试直到卸载)。 */
export function nextEngineRetryDelay(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.min(attempt, 3))
}

/**
 * 引擎取数硬超时(ms)。2026-07-12 真机验收发现第四种故障形态:请求「悬挂」——
 * 连接被接受但响应永不到达(respawn 竞态下 1/5 复现),fetch 既不 resolve 也不 reject,
 * 状态机进不了 stalled → 全灰假象且不自愈。异步取数四态 = 成功/失败/悬挂/中途作废,
 * 悬挂必须由超时转成可重试失败(AbortSignal.timeout → catch → scheduleEngineRetry),
 * abort 同时会关闭底层连接,避免 Chromium 连接池继续复用死套接字。
 * 取值:远大于健康路径首拉(~ms 级),小到用户可忍受的「诚实提示」延迟上限。
 */
export const ENGINE_FETCH_TIMEOUT_MS = 10_000
