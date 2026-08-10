export type TimelineReadyResult = {
  coldOpenMs: number
  mountedRows: number
  expectedRows: number
  scrollHeight: number
  clientHeight: number
}

export type TimelineLongTask = {
  startTimeMs: number
  durationMs: number
}

export type TimelineStreamResult = {
  requestedDurationMs: number
  observedDurationMs: number
  updates: number
  rafTimestampsMs: number[]
  rafGapsMs: number[]
  p95RafGapMs: number
  maxRafGapMs: number
  missedFrameIntervals: number
  estimatedFrameLossRatio: number
  longTasks: TimelineLongTask[]
}

export type TimelineHistoryResult = {
  scrollToTopLatencyMs: number
  historyPrependLatencyMs: number
  rowsBefore: number
  rowsAfter: number
  insertedRows: number
  anchorOffsetDeltaPx: number | null
}

export type TimelineBenchmarkApi = {
  ready: Promise<TimelineReadyResult>
  runStreaming: (durationMs: number) => Promise<TimelineStreamResult>
  runHistoryLoad: () => Promise<TimelineHistoryResult>
}

declare global {
  interface Window {
    __alphaTimelineBenchmark: TimelineBenchmarkApi
  }
}
