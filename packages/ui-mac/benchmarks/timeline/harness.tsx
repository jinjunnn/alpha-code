import { createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { MarkedProvider } from "../../../ui/src/context/marked"
import { setLocale } from "../../src/renderer/i18n"
import { SessionTimelineView } from "../../src/renderer/alpha-ui/session-timeline/session-timeline-view"
import type { TimelineRow } from "../../src/renderer/alpha-ui/session-timeline/timeline-model"
import "../../src/renderer/alpha-ui/session-timeline/session-timeline.css"
import { materializeTimelineBenchmarkFixture, timelineBenchmarkFixture, timelineBenchmarkStreamRowKey } from "./fixture"
import type {
  TimelineBenchmarkApi,
  TimelineHistoryResult,
  TimelineLongTask,
  TimelineReadyResult,
  TimelineStreamResult,
} from "./types"

setLocale("en")

const fixture = materializeTimelineBenchmarkFixture()
const streamIndex = fixture.initialRows.findIndex((row) => row.key === timelineBenchmarkStreamRowKey)
const streamRow = fixture.initialRows[streamIndex] as Extract<TimelineRow, { kind: "markdown" }>
const [streamPart, setStreamPart] = createStore({ ...streamRow.part })
const [rows, setRows] = createSignal<TimelineRow[]>([
  ...fixture.initialRows.slice(0, streamIndex),
  { ...streamRow, part: streamPart },
  ...fixture.initialRows.slice(streamIndex + 1),
])
const [history, setHistory] = createStore({ more: true, loading: false })

let resolveHistory: ((value: TimelineHistoryResult) => void) | undefined
let historyStartedAt = 0
let anchorBefore: { element: HTMLElement; offset: number } | undefined

let resolveReady!: (value: TimelineReadyResult) => void
let rejectReady!: (error: unknown) => void
const ready = new Promise<TimelineReadyResult>((resolve, reject) => {
  resolveReady = resolve
  rejectReady = reject
})

const api: TimelineBenchmarkApi = {
  ready,
  runStreaming,
  runHistoryLoad,
}
window.__alphaTimelineBenchmark = api

function App() {
  onMount(() => {
    void waitForTimelineReady(resolveReady).catch(rejectReady)
  })
  return (
    <MarkedProvider>
      <SessionTimelineView
        rows={rows()}
        ready={true}
        epoch="sidecar:/fixture:ses_alpha_timeline_benchmark"
        emptyTitle="Alpha timeline benchmark"
        history={history}
        onLoadOlder={loadOlder}
      />
    </MarkedProvider>
  )
}

render(() => <App />, document.getElementById("root")!)

async function waitForTimelineReady(resolve: (value: TimelineReadyResult) => void) {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    await nextFrame()
    const scroller = timelineScroller()
    const mountedRows = document.querySelectorAll("[data-alpha-timeline-row]").length
    const markdown = document.querySelector('[data-component="markdown"] [data-markdown-block]')
    if (scroller && mountedRows === rows().length && markdown) {
      await nextFrame()
      resolve({
        coldOpenMs: performance.now(),
        mountedRows,
        expectedRows: rows().length,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      })
      return
    }
  }
  throw new Error("Alpha timeline did not become ready within 15 seconds")
}

async function runStreaming(durationMs: number): Promise<TimelineStreamResult> {
  const scroller = requireTimelineScroller()
  scroller.scrollTop = scroller.scrollHeight
  await nextFrame()

  const rafTimestampsMs: number[] = []
  const longTasks: TimelineLongTask[] = []
  const observer =
    typeof PerformanceObserver === "undefined"
      ? undefined
      : new PerformanceObserver((list) => {
          list
            .getEntries()
            .forEach((entry) => longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration }))
        })
  observer?.observe({ type: "longtask", buffered: false })

  let sampling = true
  const sample = (timestamp: number) => {
    if (!sampling) return
    rafTimestampsMs.push(timestamp)
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)

  const startedAt = performance.now()
  let updates = 0
  let text = streamPart.text
  const interval = setInterval(() => {
    updates += 1
    text += `\nstream delta ${String(updates).padStart(4, "0")} ${"alpha ".repeat(4)}`
    setStreamPart("text", text)
  }, timelineBenchmarkFixture.streamIntervalMs)

  await delay(durationMs)
  clearInterval(interval)
  sampling = false
  observer?.disconnect()
  await nextFrame()

  const rafGapsMs = rafTimestampsMs.slice(1).map((timestamp, index) => timestamp - rafTimestampsMs[index]!)
  const frameIntervalMs = 1000 / 60
  const missedFrameIntervals = rafGapsMs.reduce(
    (sum, gap) => sum + Math.max(0, Math.round(gap / frameIntervalMs) - 1),
    0,
  )
  const estimatedFrames = rafGapsMs.length + missedFrameIntervals
  return {
    requestedDurationMs: durationMs,
    observedDurationMs: performance.now() - startedAt,
    updates,
    rafTimestampsMs,
    rafGapsMs,
    p95RafGapMs: percentile(rafGapsMs, 0.95),
    maxRafGapMs: Math.max(0, ...rafGapsMs),
    missedFrameIntervals,
    estimatedFrameLossRatio: estimatedFrames === 0 ? 0 : missedFrameIntervals / estimatedFrames,
    longTasks,
  }
}

function runHistoryLoad(): Promise<TimelineHistoryResult> {
  if (!history.more || history.loading) throw new Error("History fixture can only be loaded once per run")
  const scroller = requireTimelineScroller()
  historyStartedAt = performance.now()
  return new Promise((resolve) => {
    resolveHistory = resolve
    scroller.scrollTop = 0
    anchorBefore = firstVisibleRow(scroller)
    scroller.dispatchEvent(new Event("scroll"))
  })
}

async function loadOlder() {
  const resolve = resolveHistory
  if (!resolve || history.loading || !history.more) return
  setHistory("loading", true)
  await nextFrame()
  const scrollToTopLatencyMs = performance.now() - historyStartedAt
  const rowsBefore = rows().length
  setRows((current) => [...fixture.olderRows, ...current])
  setHistory({ more: false, loading: false })
  setTimeout(() => {
    void finishHistoryLoad(resolve, scrollToTopLatencyMs, rowsBefore)
  }, 0)
}

async function finishHistoryLoad(
  resolve: (value: TimelineHistoryResult) => void,
  scrollToTopLatencyMs: number,
  rowsBefore: number,
) {
  // Return from onLoadOlder first so SessionTimelineView can run its real
  // prepend coordinator and settling pass before the benchmark samples it.
  await nextFrame()
  await nextFrame()
  const scroller = requireTimelineScroller()
  const anchorOffsetDeltaPx = anchorBefore?.element.isConnected
    ? anchorBefore.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchorBefore.offset
    : null
  resolveHistory = undefined
  resolve({
    scrollToTopLatencyMs,
    historyPrependLatencyMs: performance.now() - historyStartedAt,
    rowsBefore,
    rowsAfter: rows().length,
    insertedRows: fixture.olderRows.length,
    anchorOffsetDeltaPx,
  })
}

function timelineScroller() {
  return document.querySelector<HTMLElement>(".a-tl-scroll")
}

function requireTimelineScroller() {
  const scroller = timelineScroller()
  if (!scroller) throw new Error("Alpha timeline scroller is missing")
  return scroller
}

function firstVisibleRow(scroller: HTMLElement) {
  const top = scroller.getBoundingClientRect().top
  return [...document.querySelectorAll<HTMLElement>("[data-alpha-timeline-row]")]
    .map((element) => ({ element, offset: element.getBoundingClientRect().top - top }))
    .find((entry) => entry.element.getBoundingClientRect().bottom > top)
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function percentile(values: number[], quantile: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!
}
