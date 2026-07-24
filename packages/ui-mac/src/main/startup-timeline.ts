import {
  RENDERER_STARTUP_MARK_NAMES,
  STARTUP_TIMELINE_CHANNEL,
  type RendererStartupMarkName,
  type RendererStartupMarkPayload,
  type StartupTimelineExtra,
  type StartupTimelineValue,
} from "../preload/types"

export type StartupTimelineRecord = {
  seq: number
  name: string
  t: number
} & StartupTimelineExtra

type StartupTimelineSink = (record: StartupTimelineRecord) => void
type Clock = () => number
type IpcMainLike = {
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => unknown
}

const DENIED_EXTRA_KEY_PARTS = [
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "env",
  "environment",
  "header",
  "password",
  "secret",
  "token",
]
const RESERVED_EXTRA_KEYS = new Set(["name", "seq", "t"])
const MAX_RENDERER_RETRY_MARKS = 25
const registeredIpc = new WeakSet<object>()

export function createStartupTimeline(options: {
  now?: Clock
  timeOrigin?: number
  epoch?: string
} = {}) {
  const now = options.now ?? (() => performance.now())
  const epochNow = now()
  const pending: StartupTimelineRecord[] = []
  let sink: StartupTimelineSink | undefined
  let seq = 0
  let lastT = 0

  const deliver = (record: StartupTimelineRecord) => {
    if (!sink) {
      pending.push(record)
      return
    }
    try {
      sink(record)
    } catch {
      // Observation must never perturb startup.
    }
  }

  const record = (name: string, extra?: Record<string, unknown>) => {
    if (!isMarkName(name)) return
    const t = Math.max(lastT, now() - epochNow)
    lastT = t
    const next = {
      seq: ++seq,
      name,
      t,
      ...sanitizeExtra(extra),
    }
    deliver(next)
    return next
  }

  deliver({
    seq: ++seq,
    name: "main.timeline.epoch",
    t: 0,
    epoch: options.epoch ?? "main-module-load",
    timeOrigin: options.timeOrigin ?? performance.timeOrigin,
  })

  return {
    mark: record,
    initialize(nextSink: StartupTimelineSink) {
      if (sink) return false
      sink = nextSink
      pending.splice(0).forEach(deliver)
      return true
    },
  }
}

const timeline = createStartupTimeline()
export const markStartupTimeline = timeline.mark
export const initStartupTimeline = timeline.initialize

export function errorOutcome(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code
    if (typeof code === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/.test(code)) return `error:${code}`
  }
  if (error instanceof Error) {
    const name = error.constructor.name
    if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) return `error:${name}`
  }
  return "error:unknown"
}

export function registerStartupTimelineIpc(
  ipc: IpcMainLike,
  record: (name: string, extra?: Record<string, unknown>) => unknown = markStartupTimeline,
) {
  if (registeredIpc.has(ipc)) return false
  registeredIpc.add(ipc)
  const occurrences = new Map<string, number>()
  ipc.on(STARTUP_TIMELINE_CHANNEL, (_event, payload) => {
    const decoded = decodeRendererPayload(payload)
    if (!decoded.ok) {
      record("main.renderer_ipc.invalid", { outcome: "ignored", reason: decoded.reason })
      return
    }
    const occurrence = (occurrences.get(decoded.payload.name) ?? 0) + 1
    occurrences.set(decoded.payload.name, occurrence)
    if (
      decoded.payload.name === "renderer.home.model_list.retry_tick" &&
      occurrence > MAX_RENDERER_RETRY_MARKS
    )
      return
    record(decoded.payload.name, {
      ...decoded.payload.extra,
      source: "renderer",
      rendererNow: decoded.payload.rendererNow,
      occurrence,
    })
  })
  return true
}

function decodeRendererPayload(
  value: unknown,
): { ok: true; payload: RendererStartupMarkPayload } | { ok: false; reason: string } {
  if (!isPlainRecord(value)) return { ok: false, reason: "payload" }
  if (!isRendererMarkName(value.name)) return { ok: false, reason: "name" }
  if (typeof value.rendererNow !== "number" || !Number.isFinite(value.rendererNow) || value.rendererNow < 0)
    return { ok: false, reason: "renderer-clock" }
  if (value.extra !== undefined && !isPlainRecord(value.extra)) return { ok: false, reason: "extra" }
  return {
    ok: true,
    payload: {
      name: value.name,
      rendererNow: value.rendererNow,
      ...(value.extra === undefined ? {} : { extra: value.extra as StartupTimelineExtra }),
    },
  }
}

function sanitizeExtra(extra?: Record<string, unknown>) {
  if (!extra) return {}
  return Object.fromEntries(
    Object.entries(extra).flatMap(([key, value]) => {
      if (!isSafeExtraKey(key) || !isTimelineValue(value)) return []
      return [[key, typeof value === "string" ? value.slice(0, 4096) : value]]
    }),
  ) as StartupTimelineExtra
}

function isSafeExtraKey(key: string) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || RESERVED_EXTRA_KEYS.has(key)) return false
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return !DENIED_EXTRA_KEY_PARTS.some((part) => normalized.includes(part))
}

function isTimelineValue(value: unknown): value is StartupTimelineValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isMarkName(value: string) {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)
}

function isRendererMarkName(value: unknown): value is RendererStartupMarkName {
  return typeof value === "string" && RENDERER_STARTUP_MARK_NAMES.some((name) => name === value)
}
