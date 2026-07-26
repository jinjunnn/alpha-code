// REQ-125 C5/C6 — 组件测试运行时:以受控 signals 驱动 SessionTimelineView(呈现层合同的真实挂载)。
// 数据绑定层(AlphaSessionTimeline)依赖 useServerSync,组件测试不伪造其 provider;
// 行投影 → 视图的组合正确性由 cases 直接用 projectTimelineRows 产 rows 覆盖。
// C6:intents 可开关(记录调用),覆盖「handler 缺席 → 行降级纯展示」的 fail-closed 合同。
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { TimelineFocusArtifactIntent, TimelineOpenFileIntent } from "./cards/timeline-intents"
import type { TimelineRow } from "./timeline-model"
import { SessionTimelineView, type SessionTimelineHistory } from "./session-timeline-view"

const initialEpoch = "sidecar /tmp/workspace ses_harness"

const [rows, setRows] = createSignal<TimelineRow[]>([])
const [ready, setReady] = createSignal(true)
const [history, setHistory] = createSignal<SessionTimelineHistory>({ more: false, loading: false })
const [epoch, setEpoch] = createSignal(initialEpoch)
const [settleTimeoutMs, setSettleTimeoutMs] = createSignal<number | undefined>(undefined)
const [intentsEnabled, setIntentsEnabled] = createSignal(false)

let loadOlderCalls = 0
let pendingMode = false
let pendingResolvers: Array<() => void> = []
const intentLog: {
  focusArtifact: TimelineFocusArtifactIntent[]
  openSession: string[]
  openFile: TimelineOpenFileIntent[]
  continueTurn: number
} = {
  focusArtifact: [],
  openSession: [],
  openFile: [],
  continueTurn: 0,
}

// 稳定对象 + 反应式 getter:开关翻转时,卡片内 <Show when={intents.x}> 立即重估
// (与生产合同一致 —— handler 缺席即降级纯展示)。
const harnessIntents = {
  get focusArtifact() {
    return intentsEnabled() ? (intent: TimelineFocusArtifactIntent) => intentLog.focusArtifact.push(intent) : undefined
  },
  get openSession() {
    return intentsEnabled() ? (sessionID: string) => intentLog.openSession.push(sessionID) : undefined
  },
  get openFile() {
    return intentsEnabled() ? (intent: TimelineOpenFileIntent) => intentLog.openFile.push(intent) : undefined
  },
  get continueTurn() {
    return intentsEnabled() ? () => (intentLog.continueTurn += 1) : undefined
  },
}

export { render }

export function SessionTimelineHarness() {
  return (
    <SessionTimelineView
      rows={rows()}
      ready={ready()}
      epoch={epoch()}
      emptyTitle="整理架构说明"
      history={history()}
      onLoadOlder={() => {
        loadOlderCalls += 1
        if (!pendingMode) return Promise.resolve()
        return new Promise<void>((resolve) => pendingResolvers.push(resolve))
      }}
      settleTimeoutMs={settleTimeoutMs()}
      intents={harnessIntents}
    />
  )
}

/** settling 生命周期上限的测试注入(undefined = 生产默认)。 */
export function setSettleTimeout(next: number | undefined) {
  setSettleTimeoutMs(next)
}

export function setTimelineIntentsEnabled(next: boolean) {
  setIntentsEnabled(next)
}

export function getIntentLog() {
  return intentLog
}

/** true = onLoadOlder 挂起不 resolve(模拟慢加载),用 resolvePendingLoads 手动放行。 */
export function setLoadOlderPending(next: boolean) {
  pendingMode = next
}

export function resolvePendingLoads() {
  pendingResolvers.splice(0).forEach((resolve) => resolve())
}

export function setTimelineRows(next: TimelineRow[]) {
  setRows(next)
}

export function setTimelineReady(next: boolean) {
  setReady(next)
}

export function setTimelineHistory(next: SessionTimelineHistory) {
  setHistory(next)
}

export function setTimelineEpoch(next: string) {
  setEpoch(next)
}

export function getLoadOlderCalls() {
  return loadOlderCalls
}

export function resetTimelineHarness() {
  setRows([])
  setReady(true)
  setHistory({ more: false, loading: false })
  setEpoch(initialEpoch)
  setSettleTimeoutMs(undefined)
  setIntentsEnabled(false)
  loadOlderCalls = 0
  pendingMode = false
  intentLog.focusArtifact.length = 0
  intentLog.openSession.length = 0
  intentLog.openFile.length = 0
  intentLog.continueTurn = 0
  resolvePendingLoads()
}
