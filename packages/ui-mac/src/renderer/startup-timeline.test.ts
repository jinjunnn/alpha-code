import { describe, expect, test } from "bun:test"
import { createRendererStartupTimeline } from "./startup-timeline"

describe("renderer startup timeline", () => {
  test("is a safe no-op when the preload bridge is absent", () => {
    let clockReads = 0
    const mark = createRendererStartupTimeline(
      () => undefined,
      () => {
        clockReads++
        return 42
      },
    )

    expect(() => mark("renderer.root.mount")).not.toThrow()
    expect(clockReads).toBe(0)
  })

  test("sends the mark and renderer clock through an injected bridge", () => {
    const sent: unknown[] = []
    const mark = createRendererStartupTimeline(
      () => ({
        mark: (name, rendererNow, extra) => sent.push({ name, rendererNow, extra }),
      }),
      () => 42.25,
    )

    mark("renderer.composer.mount", { mode: "home" })

    expect(sent).toEqual([
      {
        name: "renderer.composer.mount",
        rendererNow: 42.25,
        extra: { mode: "home" },
      },
    ])
  })

  test("swallows bridge failures because observation cannot affect rendering", () => {
    const mark = createRendererStartupTimeline(() => ({
      mark: () => {
        throw new Error("bridge unavailable")
      },
    }))

    expect(() => mark("renderer.root.mount")).not.toThrow()
  })
})
