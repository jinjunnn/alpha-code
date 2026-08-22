// #1056(REQ-109):冷启动时首页 composer 挂了一次**注定被丢弃**的实例。
//
// 事实(#1053 的 13/13 样本,`docs/verification/2026-08-21-req109-1053-catalog-p95/`):
// 一次 `renderer.root.mount` 下有**两条** home 模式的模型链 —— 先 `chain:2` 在 ~1.14s 起、
// 到某个时刻以 `outcome:"error:request"` 收场,紧接着 ~30–50ms 后 `chain:1` 起、几十毫秒内
// `outcome:"ok"`,`renderer.home.catalog_ready` 只在后者身上发过。两条链**不是同一个组件实例**
// (`chainSeq` 是实例本地的 `let`,新实例才会从 1 重新数),即 composer 真的挂了两次。
//
// 为什么会有第二次:`alpha-sidebar.tsx` 的启动效应(REQ-126 §4 序 3「落一个新 draft」)在
// 项目列表就绪后必然 `startDraft()` → `tabs.newDraft()` → 导航到 `/new-session?draftId=…`。
// 路由起点恒为 `/`,于是 **AlphaHome 与它的 composer 在启动路径上是一个必然被替换的过渡态**:
// 它挂载、起一条模型链(auth/keyStatus/catalog 读 + 目录就绪屏障探针 + 退避重试),然后在
// 导航那一拍被卸载 —— 链的在途请求被 `chainAbort` 取消,于是留下上面那条被误读成「客户端
// 10s 超时」的 `error:request`。
//
// 本模块是那一拍的**交接位**:侧栏在自己 setup 的同一拍(早于路由树挂 AlphaHome)armed,
// 首页据此**不挂** composer;启动 draft 落地(或如实失败)后 released,首页恢复常态。
//
// 纪律:
// · 这是**呈现层的推迟**,不是能力闸 —— 任何路径下 released 之后首页照常拿回 composer;
// · 一次进程只 arm 一次(`armedOnce`):用户已经在首页打字之后,任何再次 arm 都会把那份草稿
//   连组件一起卸掉,那是比本票要修的浪费更坏的结果;
// · fail-open 上限:启动 draft 的等待里有两处**无界** await(`tabs.ready()` / 默认目录 IPC)。
//   它们永不落定时(存储初始化被拒等)本模块必须自己让路 —— 首页没有 composer = 用户连
//   `startChat` 这条唯一的退路都没有。上限只是兜底,不是就绪信号,永远不用它冒充「已导航」。

import { createSignal } from "solid-js"

/** fail-open 兜底上限。健康启动里导航远早于它;超时只意味着「别再等了,把 composer 还给首页」。 */
export const LAUNCH_DRAFT_HANDOFF_CEILING_MS = 12_000

const [pending, setPending] = createSignal(false)
let ceilingTimer: ReturnType<typeof setTimeout> | undefined
let armedOnce = false

/** 首页读它:为真 = 启动 draft 还在路上,这一拍的首页是过渡态,不要挂 composer。 */
export const launchDraftPending = pending

/** 侧栏 setup 同一拍调用(必须早于路由树挂 AlphaHome)。整个进程只生效一次。 */
export function beginLaunchDraftHandoff(ceilingMs: number = LAUNCH_DRAFT_HANDOFF_CEILING_MS): void {
  if (armedOnce) return
  armedOnce = true
  setPending(true)
  ceilingTimer = setTimeout(() => {
    ceilingTimer = undefined
    setPending(false)
  }, ceilingMs)
}

/** 启动 draft 落地 / 如实失败 / 侧栏卸载 —— 任一发生即交接结束。幂等。 */
export function endLaunchDraftHandoff(): void {
  if (ceilingTimer !== undefined) {
    clearTimeout(ceilingTimer)
    ceilingTimer = undefined
  }
  setPending(false)
}

/** 仅供测试:模块级单例跨用例不自净,重置 armedOnce 才能重复驱动同一条启动路径。 */
export function resetLaunchDraftHandoff(): void {
  endLaunchDraftHandoff()
  armedOnce = false
}
