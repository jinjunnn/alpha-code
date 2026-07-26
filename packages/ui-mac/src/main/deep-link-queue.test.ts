import { describe, expect, test } from "bun:test"
import { createDeepLinkQueue, type DeepLinkQueueDeps } from "./deep-link-queue"
import type { DeepLinkDelivery } from "../shared/route-manifest"

const NEW_SESSION = "opencode://new-session?directory=/tmp/demo&prompt=ship%20it"
const OPEN_PROJECT = "opencode://open-project?directory=/tmp/demo"

function harness(overrides: Partial<DeepLinkQueueDeps> = {}) {
  const delivered: DeepLinkDelivery[][] = []
  const auth: string[] = []
  let rendererPresent = true
  const queue = createDeepLinkQueue({
    consumeAuth: (url) => {
      if (!url.startsWith("alpha-code://auth/")) return false
      auth.push(url)
      return true
    },
    deliver: (links) => {
      if (!rendererPresent) return false
      delivered.push(links)
      return true
    },
    ...overrides,
  })
  return {
    queue,
    delivered,
    auth,
    setRendererPresent: (present: boolean) => {
      rendererPresent = present
    },
    /** Every delivery the renderer would act on, in order, across both transports. */
    consumed: (initial: DeepLinkDelivery[][]) => [...initial, ...delivered].flat(),
  }
}

describe("deep-link queue delivers each link exactly once", () => {
  test("cold start: the link is queued, drained once, and never replayed", () => {
    const h = harness()
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered).toEqual([])
    const first = h.queue.consumeInitial()
    expect(first.map((link) => link.deepLinkId)).toEqual(["new-session"])
    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.consumed([first])).toHaveLength(1)
  })

  test("renderer already owns the stream: the link goes live and is NOT left in the queue", () => {
    const h = harness()
    expect(h.queue.consumeInitial()).toEqual([]) // renderer's initial drain

    h.queue.ingest([NEW_SESSION])

    expect(h.delivered.flat()).toHaveLength(1)
    // A later drain (what a reloaded renderer would do) must find nothing to replay.
    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.consumed([])).toHaveLength(1)
  })

  test("IPC subscribed but the initial invoke has not returned: queued once, not doubled", () => {
    const h = harness()
    // The renderer registers onDeepLink synchronously and then awaits consumeInitialDeepLinks;
    // a link that lands inside that window must not be sent live AND queued.
    h.queue.ingest([OPEN_PROJECT])

    expect(h.delivered).toEqual([])
    const initial = h.queue.consumeInitial()
    expect(initial).toHaveLength(1)
    expect(h.consumed([initial])).toHaveLength(1)
  })

  test("sidecar respawn reloads the renderer: the link is queued for the new one, once", () => {
    const h = harness()
    h.queue.consumeInitial() // first renderer takes ownership

    h.queue.rendererGone() // webContents.reload()
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered).toEqual([]) // nothing shipped to the renderer that is going away
    const afterReload = h.queue.consumeInitial()
    expect(afterReload).toHaveLength(1)
    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.consumed([afterReload])).toHaveLength(1)
  })

  test("a link handled live before a reload is not replayed after it", () => {
    const h = harness()
    h.queue.consumeInitial()
    h.queue.ingest([NEW_SESSION]) // handled live by the current renderer
    expect(h.delivered.flat()).toHaveLength(1)

    h.queue.rendererGone()
    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.consumed([])).toHaveLength(1)
  })

  test("live delivery refused (window destroyed) falls back to the queue, still once", () => {
    const h = harness()
    h.queue.consumeInitial()
    h.setRendererPresent(false)

    h.queue.ingest([OPEN_PROJECT])

    expect(h.delivered).toEqual([])
    const drained = h.queue.consumeInitial()
    expect(drained).toHaveLength(1)
    expect(h.consumed([drained])).toHaveLength(1)
  })
})

describe("deep-link queue ingests every OS entry point", () => {
  test("first-process command line: the executable path and switches are ignored", () => {
    // Windows/Linux cold start — this process holds the single-instance lock, so `second-instance`
    // never fires and there is no macOS open-url either.
    const h = harness()
    h.queue.ingest(["C:\\Program Files\\alpha-code\\alpha-code.exe", "--no-sandbox", NEW_SESSION])

    const drained = h.queue.consumeInitial()
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ deepLinkId: "new-session", directory: "/tmp/demo", prompt: "ship it" })
    expect(drained[0]!.href).toContain("/session")
  })

  test("a command line without a deep link yields nothing", () => {
    const h = harness()
    h.queue.ingest(["/usr/bin/alpha-code", "--enable-features=Foo", "/home/me/project"])
    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.delivered).toEqual([])
  })

  test("auth transport is consumed, never queued and never navigated", () => {
    const h = harness()
    h.queue.ingest(["alpha-code://auth/callback?code=abc&state=xyz"])

    expect(h.auth).toHaveLength(1)
    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.delivered).toEqual([])
  })

  test("anything the manifest refuses to decode is dropped fail-closed", () => {
    const h = harness()
    h.queue.ingest([
      "https://example.com/new-session?directory=/tmp",
      "opencode://unknown-host?directory=/tmp",
      "opencode://new-session",
      "opencode://new-session?directory=",
    ])

    expect(h.queue.consumeInitial()).toEqual([])
    expect(h.delivered).toEqual([])
  })
})
