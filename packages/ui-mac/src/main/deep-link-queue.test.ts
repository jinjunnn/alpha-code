import { describe, expect, test } from "bun:test"
import {
  createDeepLinkQueue,
  trackRendererLifecycle,
  RENDERER_LIFECYCLE_EVENTS,
  type DeepLinkQueueDeps,
  type RendererLifecycleEvent,
} from "./deep-link-queue"
import type { DeepLinkDelivery } from "../shared/route-manifest"

const NEW_SESSION = "opencode://new-session?directory=/tmp/demo&prompt=ship%20it"
const OPEN_PROJECT = "opencode://open-project?directory=/tmp/demo"

/** The boot window; `window.new` and reload-after-crash produce the other ids used below. */
const BOOT = 1
const SECOND = 2

/**
 * A stand-in for Electron's WebContents: it holds an id, records real listeners, and can be put
 * into the states that make `webContents.send` a black hole (crashed / destroyed). The queue is
 * driven through the SAME `trackRendererLifecycle` wiring production uses, so these are the
 * production callbacks firing, not a re-description of them.
 */
function renderer(id: number) {
  const listeners = new Map<RendererLifecycleEvent, (() => void)[]>()
  return {
    id,
    live: true,
    on(event: RendererLifecycleEvent, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    /** Fire a real Electron lifecycle event; the second argument is what Electron would do to it. */
    emit(this: { live: boolean }, event: RendererLifecycleEvent, stillReachable = false) {
      this.live = stillReachable
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
}

function harness(overrides: Partial<DeepLinkQueueDeps> = {}) {
  const delivered: { rendererId: number; links: DeepLinkDelivery[] }[] = []
  const auth: string[] = []
  const renderers = new Map<number, ReturnType<typeof renderer>>()
  const queue = createDeepLinkQueue({
    consumeAuth: (url) => {
      if (!url.startsWith("alpha-code://auth/")) return false
      auth.push(url)
      return true
    },
    // Mirrors the production `deliver`: a renderer that is not reachable refuses, it does not
    // silently swallow. That refusal is the only thing standing between a crash and a lost link.
    deliver: (rendererId, links) => {
      if (!renderers.get(rendererId)?.live) return false
      delivered.push({ rendererId, links })
      return true
    },
    ...overrides,
  })
  return {
    queue,
    delivered,
    auth,
    /** Create a window and wire it exactly as `createMainWindow` does. */
    open(id: number) {
      const created = renderer(id)
      renderers.set(id, created)
      trackRendererLifecycle(created, queue)
      return created
    },
    /** Every delivery the app would act on, in order, across both transports. */
    consumed: (initial: DeepLinkDelivery[][]) => [...initial, ...delivered.map((entry) => entry.links)].flat(),
  }
}

describe("deep-link queue delivers each link exactly once", () => {
  test("cold start: the link is queued, drained once, and never replayed", () => {
    const h = harness()
    h.open(BOOT)
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered).toEqual([])
    const first = h.queue.consumeInitial(BOOT)
    expect(first.map((link) => link.deepLinkId)).toEqual(["new-session"])
    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.consumed([first])).toHaveLength(1)
  })

  test("renderer already owns the stream: the link goes live and is NOT left in the queue", () => {
    const h = harness()
    h.open(BOOT)
    expect(h.queue.consumeInitial(BOOT)).toEqual([]) // renderer's initial drain

    h.queue.ingest([NEW_SESSION])

    expect(h.delivered).toEqual([{ rendererId: BOOT, links: h.delivered[0]!.links }])
    expect(h.delivered.flatMap((entry) => entry.links)).toHaveLength(1)
    // A later drain (what a reloaded renderer would do) must find nothing to replay.
    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.consumed([])).toHaveLength(1)
  })

  test("IPC subscribed but the initial invoke has not returned: queued once, not doubled", () => {
    const h = harness()
    h.open(BOOT)
    // The renderer registers onDeepLink synchronously and then awaits consumeInitialDeepLinks;
    // a link that lands inside that window must not be sent live AND queued.
    h.queue.ingest([OPEN_PROJECT])

    expect(h.delivered).toEqual([])
    const initial = h.queue.consumeInitial(BOOT)
    expect(initial).toHaveLength(1)
    expect(h.consumed([initial])).toHaveLength(1)
  })

  test("sidecar respawn reloads the renderer: the link is queued for the new one, once", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.consumeInitial(BOOT) // first renderer takes ownership

    win.emit("did-start-loading", true) // webContents.reload(); the contents survive the reload
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered).toEqual([]) // nothing shipped to the document that is going away
    const afterReload = h.queue.consumeInitial(BOOT)
    expect(afterReload).toHaveLength(1)
    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.consumed([afterReload])).toHaveLength(1)
  })

  test("a link handled live before a reload is not replayed after it", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.consumeInitial(BOOT)
    h.queue.ingest([NEW_SESSION]) // handled live by the current renderer
    expect(h.delivered.flatMap((entry) => entry.links)).toHaveLength(1)

    win.emit("did-start-loading", true)
    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.consumed([])).toHaveLength(1)
  })

  test("the render process crashes after draining: the link is queued, not sent into the void", () => {
    // The exact timing a "is there a window" ownership model loses: the WINDOW is still there and
    // not destroyed, but its render process is gone, so webContents.send neither throws nor
    // arrives. Ownership must lapse on render-process-gone or the link vanishes.
    const h = harness()
    const win = h.open(BOOT)
    h.queue.consumeInitial(BOOT)

    win.emit("render-process-gone")
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered).toEqual([])
    win.live = true // Electron reloads the crashed contents; same webContents id
    const afterCrash = h.queue.consumeInitial(BOOT)
    expect(afterCrash).toHaveLength(1)
    expect(h.consumed([afterCrash])).toHaveLength(1)
  })

  test("the window is destroyed after draining: the link waits for the next renderer", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.consumeInitial(BOOT)

    win.emit("destroyed")
    h.queue.ingest([OPEN_PROJECT])

    expect(h.delivered).toEqual([])
    h.open(SECOND)
    const next = h.queue.consumeInitial(SECOND)
    expect(next).toHaveLength(1)
    expect(h.consumed([next])).toHaveLength(1)
  })

  test("window.new: the link goes to the renderer that drained last, exactly once", () => {
    // `window.new` (desktop-menu-actions) creates a SECOND renderer through createMainWindow. It
    // drains too, and from then on it — not the boot window — owns the stream.
    const h = harness()
    h.open(BOOT)
    h.queue.consumeInitial(BOOT)
    h.open(SECOND)
    h.queue.consumeInitial(SECOND)

    h.queue.ingest([NEW_SESSION])

    expect(h.delivered.map((entry) => entry.rendererId)).toEqual([SECOND])
    expect(h.consumed([])).toHaveLength(1)
  })

  test("closing the newer window hands the stream back to the one still on screen", () => {
    const h = harness()
    h.open(BOOT)
    h.queue.consumeInitial(BOOT)
    const second = h.open(SECOND)
    h.queue.consumeInitial(SECOND)

    second.emit("destroyed")
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered.map((entry) => entry.rendererId)).toEqual([BOOT])
    expect(h.consumed([])).toHaveLength(1)
  })

  test("live delivery refused (window destroyed with no event) falls back to the queue, still once", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.consumeInitial(BOOT)
    win.live = false // gone without the lifecycle event ever firing

    h.queue.ingest([OPEN_PROJECT])

    expect(h.delivered).toEqual([])
    h.open(SECOND)
    const drained = h.queue.consumeInitial(SECOND)
    expect(drained).toHaveLength(1)
    expect(h.consumed([drained])).toHaveLength(1)
  })

  test("a stale renderer id never steals the stream back", () => {
    const h = harness()
    h.open(BOOT)
    h.queue.consumeInitial(BOOT)
    const second = h.open(SECOND)
    h.queue.consumeInitial(SECOND)

    h.queue.rendererGone(BOOT) // the old window goes away; the newer one still owns the stream
    h.queue.ingest([NEW_SESSION])

    expect(h.delivered.map((entry) => entry.rendererId)).toEqual([SECOND])
    expect(second.live).toBe(true)
  })
})

describe("renderer lifecycle wiring drops ownership on every exit path", () => {
  test("all three Electron events are subscribed for the renderer that was tracked", () => {
    const gone: number[] = []
    const win = renderer(7)
    trackRendererLifecycle(win, { rendererGone: (id) => gone.push(id) })

    for (const event of RENDERER_LIFECYCLE_EVENTS) win.emit(event)

    expect(gone).toEqual([7, 7, 7])
  })

  test("each renderer reports its own id, so one window's exit cannot evict another", () => {
    const gone: number[] = []
    const first = renderer(1)
    const second = renderer(2)
    for (const win of [first, second]) trackRendererLifecycle(win, { rendererGone: (id) => gone.push(id) })

    second.emit("destroyed")

    expect(gone).toEqual([2])
  })
})

describe("deep-link queue ingests every OS entry point", () => {
  test("first-process command line: the executable path and switches are ignored", () => {
    // Windows/Linux cold start — this process holds the single-instance lock, so `second-instance`
    // never fires and there is no macOS open-url either.
    const h = harness()
    h.open(BOOT)
    h.queue.ingest(["C:\\Program Files\\alpha-code\\alpha-code.exe", "--no-sandbox", NEW_SESSION])

    const drained = h.queue.consumeInitial(BOOT)
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ deepLinkId: "new-session", directory: "/tmp/demo", prompt: "ship it" })
    expect(drained[0]!.href).toContain("/session")
  })

  test("a command line without a deep link yields nothing", () => {
    const h = harness()
    h.open(BOOT)
    h.queue.ingest(["/usr/bin/alpha-code", "--enable-features=Foo", "/home/me/project"])
    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.delivered).toEqual([])
  })

  test("auth transport is consumed, never queued and never navigated", () => {
    const h = harness()
    h.open(BOOT)
    h.queue.ingest(["alpha-code://auth/callback?code=abc&state=xyz"])

    expect(h.auth).toHaveLength(1)
    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.delivered).toEqual([])
  })

  test("anything the manifest refuses to decode is dropped fail-closed", () => {
    const h = harness()
    h.open(BOOT)
    h.queue.ingest([
      "https://example.com/new-session?directory=/tmp",
      "opencode://unknown-host?directory=/tmp",
      "opencode://new-session",
      "opencode://new-session?directory=",
    ])

    expect(h.queue.consumeInitial(BOOT)).toEqual([])
    expect(h.delivered).toEqual([])
  })
})
