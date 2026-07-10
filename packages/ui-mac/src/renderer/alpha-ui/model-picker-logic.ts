// REQ-083:模型选择框 respawn 竞态的纯决策核(单测覆盖,组件侧只做接线)。
//
// 背景(2026-07-10 真机日志定案):sidecar respawn 窗口内,弹窗一次性拉取引擎模型表失败被
// 静默吞掉 → BYOK 已配置供应商整体消失 + 代理行全 locked;此时 member/balance 态点 locked 行
// 会无条件 enableProxy() → 又一次 respawn + renderer reload,形成「点灰行 → 重启 → 再点」的
// 自续循环。这里把两件事抽成纯函数:
//   1. lockedPickAction —— locked 行点击该干什么。关键裁决:只有「引擎在线(engineReady)且
//      代理节点确实缺席(!proxyLive)」才允许 activate(respawn 是修复);引擎不可达时一律
//      none —— respawn 只会扩大故障面。
//   2. nextEngineRetryDelay —— 引擎模型表拉取失败后的退避重试节奏(弹窗存活期间自愈)。

export type AccountState = "member" | "balance" | "empty" | "out" | "error"

export type LockedPickAction = "login" | "recharge" | "activate" | "none"

export function lockedPickAction(state: AccountState, engineReady: boolean, proxyLive: boolean): LockedPickAction {
  if (state === "out") return "login"
  if (state === "empty") return "recharge"
  if (engineReady && !proxyLive) return "activate"
  return "none"
}

/** 0-based 尝试次数 → 1s / 2s / 4s / 8s 封顶(弹窗短命,持续重试直到卸载)。 */
export function nextEngineRetryDelay(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.min(attempt, 3))
}
