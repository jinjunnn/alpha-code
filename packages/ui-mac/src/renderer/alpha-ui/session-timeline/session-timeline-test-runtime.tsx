// REQ-125 C5 — 组件测试运行时:以受控 signals 驱动 SessionTimelineView(呈现层合同的真实挂载)。
// 数据绑定层(AlphaSessionTimeline)依赖 useServerSync,组件测试不伪造其 provider;
// 行投影 → 视图的组合正确性由 cases 直接用 projectTimelineRows 产 rows 覆盖。
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { TimelineRow } from "./timeline-model"
import { SessionTimelineView, type SessionTimelineHistory } from "./session-timeline-view"

const initialEpoch = "sidecar /tmp/workspace ses_harness"

const [rows, setRows] = createSignal<TimelineRow[]>([])
const [ready, setReady] = createSignal(true)
const [history, setHistory] = createSignal<SessionTimelineHistory>({ more: false, loading: false })
const [epoch, setEpoch] = createSignal(initialEpoch)

let loadOlderCalls = 0

export { render }

export function SessionTimelineHarness() {
  return (
    <SessionTimelineView
      rows={rows()}
      ready={ready()}
      epoch={epoch()}
      emptyTitle="整理架构说明"
      history={history()}
      onLoadOlder={async () => {
        loadOlderCalls += 1
      }}
    />
  )
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
  loadOlderCalls = 0
}
