import { describe, expect, test } from "bun:test"
import {
  createStartupTimeline,
  errorOutcome,
  registerStartupTimelineIpc,
  type StartupTimelineRecord,
} from "./startup-timeline"
import { STARTUP_TIMELINE_CHANNEL } from "../preload/types"

describe("startup timeline", () => {
  test("buffers pre-init marks and flushes ordered monotonic records", () => {
    let now = 100
    const timeline = createStartupTimeline({ now: () => now, timeOrigin: 1_000, epoch: "test" })
    timeline.mark("main.before_init", { count: 1 })
    const records: StartupTimelineRecord[] = []

    expect(timeline.initialize((record) => records.push(record))).toBe(true)
    now = 103
    timeline.mark("main.after_init", { outcome: "ok" })
    now = 102
    timeline.mark("main.clock_clamped")

    expect(records.map((record) => record.name)).toEqual([
      "main.timeline.epoch",
      "main.before_init",
      "main.after_init",
      "main.clock_clamped",
    ])
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4])
    expect(records.map((record) => record.t)).toEqual([0, 0, 3, 3])
    expect(records[0]).toMatchObject({ epoch: "test", timeOrigin: 1_000 })
    expect(records[1]).toMatchObject({ count: 1 })
    expect(records[2]).toMatchObject({ outcome: "ok" })
    expect(timeline.initialize(() => {})).toBe(false)
  })

  test("serializes safe extra fields and drops secret-like or unsafe fields", () => {
    const records: StartupTimelineRecord[] = []
    const timeline = createStartupTimeline({ now: () => 10, timeOrigin: 0 })
    timeline.initialize((record) => records.push(record))
    timeline.mark("main.redaction", {
      outcome: "ok",
      directory: "/Users/example/project",
      count: 2,
      apiKey: "must-not-log",
      apiToken: "must-not-log",
      env: "must-not-log",
      secret_value: "must-not-log",
      Authorization: "must-not-log",
      password: "must-not-log",
      requestHeaders: "must-not-log",
      environment: "must-not-log",
      nested: { token: "must-not-log" },
    })

    const parsed = JSON.parse(JSON.stringify(records.at(-1)))
    expect(parsed).toEqual({
      seq: 2,
      name: "main.redaction",
      t: 0,
      outcome: "ok",
      directory: "/Users/example/project",
      count: 2,
    })
  })

  test("reduces thrown errors to errno or class without logging messages", () => {
    expect(errorOutcome(Object.assign(new Error("contains-sensitive-detail"), { code: "ETIMEDOUT" }))).toBe(
      "error:ETIMEDOUT",
    )
    expect(errorOutcome(new TypeError("contains-sensitive-detail"))).toBe("error:TypeError")
    expect(errorOutcome("contains-sensitive-detail")).toBe("error:unknown")
  })
})

describe("startup timeline IPC", () => {
  test("registers once, accepts allowlisted payloads, and ignores malformed input loudly and safely", () => {
    const listeners: Array<(event: unknown, payload: unknown) => void> = []
    const ipc = {
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
        expect(channel).toBe(STARTUP_TIMELINE_CHANNEL)
        listeners.push(listener)
      },
    }
    const marks: Array<{ name: string; extra?: Record<string, unknown> }> = []
    const record = (name: string, extra?: Record<string, unknown>) => marks.push({ name, extra })

    expect(registerStartupTimelineIpc(ipc, record)).toBe(true)
    expect(registerStartupTimelineIpc(ipc, record)).toBe(false)
    expect(listeners).toHaveLength(1)

    listeners[0](null, {
      name: "renderer.root.mount",
      rendererNow: 12.5,
      extra: { mode: "home" },
    })
    listeners[0](null, { name: "renderer.not-allowed", rendererNow: 13, token: "must-not-log" })
    listeners[0](null, { name: "renderer.root.mount", rendererNow: Number.NaN })
    listeners[0](null, "malformed")

    expect(marks[0]).toEqual({
      name: "renderer.root.mount",
      extra: {
        mode: "home",
        source: "renderer",
        rendererNow: 12.5,
        occurrence: 1,
      },
    })
    expect(marks.slice(1)).toEqual([
      { name: "main.renderer_ipc.invalid", extra: { outcome: "ignored", reason: "name" } },
      { name: "main.renderer_ipc.invalid", extra: { outcome: "ignored", reason: "renderer-clock" } },
      { name: "main.renderer_ipc.invalid", extra: { outcome: "ignored", reason: "payload" } },
    ])
    expect(JSON.stringify(marks)).not.toContain("must-not-log")
  })

  test("caps renderer retry ticks at 25 for the whole main-process run", () => {
    let listener: ((event: unknown, payload: unknown) => void) | undefined
    const marks: string[] = []
    registerStartupTimelineIpc(
      {
        on: (_channel, next) => {
          listener = next
        },
      },
      (name) => marks.push(name),
    )

    Array.from({ length: 30 }, (_, index) => index + 1).forEach((count) =>
      listener?.(null, {
        name: "renderer.home.model_list.retry_tick",
        rendererNow: count,
        extra: { count },
      }),
    )

    expect(marks).toHaveLength(25)
    expect(marks.every((name) => name === "renderer.home.model_list.retry_tick")).toBe(true)
  })
})
