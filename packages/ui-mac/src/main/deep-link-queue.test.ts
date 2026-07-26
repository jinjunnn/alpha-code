import { describe, expect, test } from "bun:test"
import {
  createDeepLinkQueue,
  trackRendererLifecycle,
  RENDERER_LIFECYCLE_EVENTS,
  type DeepLinkBatch,
  type DeepLinkQueue,
  type DeepLinkQueueDeps,
  type RendererExit,
  type RendererLifecycleEvent,
} from "./deep-link-queue"
import type { DeepLinkDelivery } from "../shared/route-manifest"

const NEW_SESSION = "opencode://new-session?directory=/tmp/demo&prompt=ship%20it"
const OPEN_PROJECT = "opencode://open-project?directory=/tmp/demo"

/** The boot window; `window.new` and reload-after-crash produce the other ids used below. */
const BOOT = 1
const SECOND = 2
const THIRD = 3

/**
 * A stand-in for Electron's WebContents, and deliberately NOT a synchronous ledger of deliveries.
 * `webContents.send` returns long before the renderer has run a line of code, so a fake that
 * counts a batch as delivered the moment the queue calls `deliver` cannot see the very gap this
 * queue has to survive. Here a sent batch lands in `transit` and becomes consumed only when
 * `receive()` runs the renderer's own step — buffer the deliveries, then acknowledge. A reload or
 * crash empties `transit`, exactly as a real one drops an IPC message no listener ever handled.
 */
function renderer(id: number) {
  const listeners = new Map<RendererLifecycleEvent, (() => void)[]>()
  const transit: DeepLinkBatch[] = []
  /** Everything this renderer's documents actually consumed, across its whole lifetime. */
  const consumed: DeepLinkDelivery[] = []
  /** Batch ids already published into the CURRENT document — the per-document dedupe. */
  let publishedHere = new Set<number>()

  return {
    id,
    live: true,
    transit,
    consumed,
    on(event: RendererLifecycleEvent, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    /** The transport hands a batch over; nothing has been consumed yet. */
    accept(this: { live: boolean }, batch: DeepLinkBatch) {
      if (!this.live) return false
      transit.push(batch)
      return true
    },
    /** The renderer's IPC listener runs: buffer the payload, then acknowledge it. */
    receive(queue: DeepLinkQueue) {
      for (const batch of transit.splice(0)) {
        if (!publishedHere.has(batch.id)) {
          publishedHere.add(batch.id)
          consumed.push(...batch.links)
        }
        queue.acknowledge(id, batch.id)
      }
    },
    /** The initial drain: invoke, buffer what comes back, acknowledge it. */
    drain(queue: DeepLinkQueue) {
      transit.push(...queue.consumeInitial(id))
      this.receive(queue)
    },
    /** Acknowledge without consuming — used to drive the ack/death race explicitly. */
    ackOnly(queue: DeepLinkQueue) {
      for (const batch of transit) queue.acknowledge(id, batch.id)
    },
    /** Consume with the acknowledgement still on the wire: the other half of that race. */
    consumeHoldingAck() {
      const held = transit.splice(0)
      for (const batch of held) {
        if (publishedHere.has(batch.id)) continue
        publishedHere.add(batch.id)
        consumed.push(...batch.links)
      }
      return held
    },
    /** Fire a real Electron lifecycle event; the second argument is what Electron would do to it. */
    emit(this: { live: boolean }, event: RendererLifecycleEvent, stillReachable = false) {
      this.live = stillReachable
      // The document is going away: anything the transport had not handed to a running listener is
      // gone, and the next document starts with an empty buffer.
      transit.length = 0
      publishedHere = new Set()
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
}

function harness(overrides: Partial<DeepLinkQueueDeps> = {}) {
  const auth: string[] = []
  const renderers = new Map<number, ReturnType<typeof renderer>>()
  const queue = createDeepLinkQueue({
    consumeAuth: (url) => {
      if (!url.startsWith("alpha-code://auth/")) return false
      auth.push(url)
      return true
    },
    // Mirrors the production `deliver`: a renderer that is not reachable refuses, it does not
    // silently swallow — and one that IS reachable has only been handed the batch, not consumed it.
    deliver: (rendererId, batch) => renderers.get(rendererId)?.accept(batch) ?? false,
    ...overrides,
  })
  return {
    queue,
    auth,
    /** Create a window and wire it exactly as `createMainWindow` does. */
    open(id: number) {
      const created = renderer(id)
      renderers.set(id, created)
      trackRendererLifecycle(created, queue)
      return created
    },
    /** Every delivery the app actually acted on, across every window. */
    consumed: () => [...renderers.values()].flatMap((win) => win.consumed),
  }
}

describe("deep-link queue delivers each link exactly once", () => {
  test("cold start: the link is queued, drained once, and never replayed", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.ingest([NEW_SESSION])

    expect(win.consumed).toEqual([])
    win.drain(h.queue)
    expect(win.consumed.map((link) => link.deepLinkId)).toEqual(["new-session"])
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("renderer already owns the stream: the link goes live and is NOT left in the queue", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue) // renderer's initial drain
    expect(win.consumed).toEqual([])

    h.queue.ingest([NEW_SESSION])
    win.receive(h.queue)

    expect(win.consumed).toHaveLength(1)
    // A later drain (what a reloaded renderer would do) must find nothing to replay.
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("IPC subscribed but the initial invoke has not returned: queued once, not doubled", () => {
    const h = harness()
    const win = h.open(BOOT)
    // The renderer registers onDeepLink synchronously and then awaits consumeInitialDeepLinks;
    // a link that lands inside that window must not be sent live AND queued.
    h.queue.ingest([OPEN_PROJECT])

    expect(win.transit).toEqual([])
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("sidecar respawn reloads the renderer: the link is queued for the new one, once", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue) // first renderer takes ownership

    win.emit("did-start-loading", true) // webContents.reload(); the contents survive the reload
    h.queue.ingest([NEW_SESSION])

    expect(win.transit).toEqual([]) // nothing shipped to the document that is going away
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("a link handled live before a reload is not replayed after it", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)
    h.queue.ingest([NEW_SESSION]) // handled live by the current renderer
    win.receive(h.queue)
    expect(win.consumed).toHaveLength(1)

    win.emit("did-start-loading", true)
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("the render process crashes after draining: the link is queued, not sent into the void", () => {
    // The exact timing a "is there a window" ownership model loses: the WINDOW is still there and
    // not destroyed, but its render process is gone, so webContents.send neither throws nor
    // arrives. Ownership must lapse on render-process-gone or the link vanishes.
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    win.emit("render-process-gone")
    h.queue.ingest([NEW_SESSION])

    expect(win.transit).toEqual([])
    win.live = true // Electron reloads the crashed contents; same webContents id
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("the window is destroyed after draining: the link waits for the next renderer", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    win.emit("destroyed")
    h.queue.ingest([OPEN_PROJECT])

    expect(win.consumed).toEqual([])
    const next = h.open(SECOND)
    next.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("window.new: the link goes to the renderer that drained last, exactly once", () => {
    // `window.new` (desktop-menu-actions) creates a SECOND renderer through createMainWindow. It
    // drains too, and from then on it — not the boot window — owns the stream.
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue)

    h.queue.ingest([NEW_SESSION])
    second.receive(h.queue)
    boot.receive(h.queue)

    expect(boot.consumed).toEqual([])
    expect(second.consumed).toHaveLength(1)
  })

  test("closing the newer window hands the stream back to the one still on screen", () => {
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue)

    second.emit("destroyed")
    h.queue.ingest([NEW_SESSION])
    boot.receive(h.queue)

    expect(boot.consumed).toHaveLength(1)
    expect(h.consumed()).toHaveLength(1)
  })

  test("live delivery refused (window destroyed with no event) falls back to the queue, still once", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)
    win.live = false // gone without the lifecycle event ever firing

    h.queue.ingest([OPEN_PROJECT])

    expect(win.transit).toEqual([])
    const next = h.open(SECOND)
    next.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("a stale renderer id never steals the stream back", () => {
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue)

    h.queue.rendererGone(BOOT, "gone") // the old window goes away; the newer one still owns the stream
    h.queue.ingest([NEW_SESSION])
    second.receive(h.queue)

    expect(second.consumed).toHaveLength(1)
    expect(second.live).toBe(true)
  })
})

/**
 * The gap `deliver` returning true cannot speak for: the batch is on the wire and the renderer has
 * not run yet. Every test here kills the renderer inside that window and demands the link still be
 * consumed exactly once — never zero times, never twice.
 */
describe("a batch in flight survives the renderer dying before it arrives", () => {
  test("reload right after the live send: redelivered to the new document, once", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([NEW_SESSION]) // sent live…
    expect(win.transit).toHaveLength(1) // …and still only on the wire
    win.emit("did-start-loading", true) // reload before the listener ever ran

    win.drain(h.queue) // the new document drains
    expect(win.consumed.map((link) => link.deepLinkId)).toEqual(["new-session"])
    expect(h.consumed()).toHaveLength(1)
  })

  test("render process crash right after the live send: redelivered, once", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([OPEN_PROJECT])
    win.emit("render-process-gone")

    win.live = true // Electron reloads the crashed contents
    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("the window closes with the batch in flight: the surviving window gets it, once", () => {
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue) // the newer window owns the stream

    h.queue.ingest([NEW_SESSION])
    second.emit("destroyed") // dies holding the batch
    boot.receive(h.queue) // …which is retried against the window still on screen

    expect(second.consumed).toEqual([])
    expect(boot.consumed).toHaveLength(1)
  })

  test("the initial drain is retained too: a reload before the reply lands does not lose it", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.ingest([NEW_SESSION])

    win.transit.push(...h.queue.consumeInitial(BOOT)) // invoke returned…
    win.emit("did-start-loading", true) // …but the renderer reloaded before handling the reply

    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("acknowledged then reloaded: the retry does not hand the same link out twice", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([NEW_SESSION])
    win.receive(h.queue) // consumed and acknowledged
    win.emit("did-start-loading", true)

    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("a duplicate ack after the reload changes nothing", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([NEW_SESSION])
    const inFlight = [...win.transit]
    win.receive(h.queue) // buffered + acknowledged in the doomed document
    win.emit("did-start-loading", true)
    for (const batch of inFlight) h.queue.acknowledge(BOOT, batch.id) // the late duplicate ack

    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("the ack loses the race to the reload: still exactly once, not twice", () => {
    // The same two messages in the opposite order at main: `rendererGone` re-queues the batch
    // first and the ack lands afterwards. The delivery was already acted on, so the retry must be
    // cancelled by that late ack rather than handed out a second time.
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([NEW_SESSION])
    const held = win.consumeHoldingAck() // the document acted on it; the ack is still on the wire
    win.emit("did-start-loading", true) // main sees the reload first and re-queues
    for (const batch of held) h.queue.acknowledge(BOOT, batch.id) // …then the ack arrives

    win.drain(h.queue)
    expect(h.consumed()).toHaveLength(1)
  })

  test("another window cannot acknowledge away a batch it was never handed", () => {
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue) // second owns the stream

    h.queue.ingest([NEW_SESSION])
    const [batch] = second.transit
    h.queue.acknowledge(BOOT, batch!.id) // a forged/stale ack from the other window
    second.emit("destroyed") // the real holder dies without acknowledging

    boot.receive(h.queue)
    expect(boot.consumed).toHaveLength(1)
  })

  test("acknowledging twice is a no-op, not a second retirement", () => {
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([NEW_SESSION])
    const [first] = win.transit
    win.receive(h.queue)
    h.queue.acknowledge(BOOT, first!.id)

    h.queue.ingest([OPEN_PROJECT]) // the next batch must be unaffected by the duplicate ack
    win.receive(h.queue)
    expect(h.consumed().map((link) => link.deepLinkId)).toEqual(["new-session", "open-project"])
  })

  test("a redelivered batch id is published once per document", () => {
    // Belt and braces on the renderer side: even if main handed the same id over twice, the
    // document publishes it once.
    const h = harness()
    const win = h.open(BOOT)
    win.drain(h.queue)

    h.queue.ingest([NEW_SESSION])
    const [batch] = win.transit
    win.transit.push(batch!) // the same batch arrives a second time
    win.receive(h.queue)

    expect(h.consumed()).toHaveLength(1)
  })

  test("a reload with another window open does not hand the consumed batch to that window", () => {
    // R4's timing, and the one a sidecar structural respawn produces on any machine with two
    // windows open: the owner acted on the batch, its ack is still on the wire, and main sees the
    // reload first. Retrying against the OTHER window there is a second consumption — in a window
    // the user was not even working in — and the late ack can no longer stop it.
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue) // the newer window owns the stream

    h.queue.ingest([NEW_SESSION])
    const held = second.consumeHoldingAck() // acted on; the acknowledgement has not landed yet
    second.emit("did-start-loading", true) // main processes the reload first

    boot.receive(h.queue)
    expect(boot.consumed).toEqual([]) // nothing was pushed at the window still on screen

    for (const batch of held) h.queue.acknowledge(SECOND, batch.id) // …and then the ack arrives
    second.drain(h.queue) // the reloaded document finds nothing left to replay
    expect(h.consumed()).toHaveLength(1)
  })

  test("a late ack retires the batch even after it was re-handed to another window", () => {
    // The other half: `destroyed` DOES release the batch, because nothing will ever drain under
    // that id again. The renderer that already consumed it must still be able to retire it once
    // its ack lands, or the retry becomes a chain — every further window death hands it out again.
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue)
    const third = h.open(THIRD) // opened, not yet drained

    h.queue.ingest([NEW_SESSION])
    const held = second.consumeHoldingAck()
    second.emit("destroyed") // gone for good: the batch is retried against the boot window
    for (const batch of held) h.queue.acknowledge(SECOND, batch.id) // the late ack lands
    boot.emit("destroyed") // …and the retry target dies without acknowledging anything

    third.drain(h.queue)
    expect(third.consumed).toEqual([])
    expect(h.consumed()).toHaveLength(1)
  })

  test("a renderer that refuses a delivery gives back everything it never acknowledged", () => {
    // Unreachable with no lifecycle event — the path `deliver` returning false exists for. Popping
    // it as an owner is not enough: the batch it was already holding stays in `inFlight` against a
    // renderer that will never drain again, so the window still on screen receives only the newer
    // one and the older link is lost for the life of the process.
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue) // the newer window owns the stream

    h.queue.ingest([OPEN_PROJECT]) // batch 1: on the wire to the owner, never acknowledged
    expect(second.transit).toHaveLength(1)
    second.live = false // gone, and the lifecycle event never arrives
    second.transit.length = 0 // …so nothing it was handed was ever consumed

    h.queue.ingest([NEW_SESSION]) // batch 2 is what discovers the refusal
    boot.receive(h.queue)

    expect(boot.consumed.map((link) => link.deepLinkId)).toEqual(["open-project", "new-session"])
  })

  test("order survives a requeue: the redelivered batch is consumed before the newer one", () => {
    const h = harness()
    const boot = h.open(BOOT)
    boot.drain(h.queue)
    const second = h.open(SECOND)
    second.drain(h.queue)

    h.queue.ingest([OPEN_PROJECT]) // batch 1, in flight to `second`
    h.queue.ingest([NEW_SESSION]) // batch 2, also in flight to `second`
    second.emit("destroyed")
    boot.receive(h.queue)

    expect(boot.consumed.map((link) => link.deepLinkId)).toEqual(["open-project", "new-session"])
  })
})

describe("renderer lifecycle wiring drops ownership on every exit path", () => {
  test("all three Electron events are subscribed, each with what it means for the batches held", () => {
    // The reload/crash pair keeps the webContents id, so its unacknowledged batches wait for its
    // next document; only `destroyed` retires the id and releases them to the other windows.
    const gone: { id: number; exit: RendererExit }[] = []
    const win = renderer(7)
    trackRendererLifecycle(win, { rendererGone: (id, exit) => gone.push({ id, exit }) })

    for (const event of RENDERER_LIFECYCLE_EVENTS) win.emit(event)

    expect(gone).toEqual([
      { id: 7, exit: "reloading" },
      { id: 7, exit: "reloading" },
      { id: 7, exit: "gone" },
    ])
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
    const win = h.open(BOOT)
    h.queue.ingest(["C:\\Program Files\\alpha-code\\alpha-code.exe", "--no-sandbox", NEW_SESSION])

    win.drain(h.queue)
    expect(win.consumed).toHaveLength(1)
    expect(win.consumed[0]).toMatchObject({ deepLinkId: "new-session", directory: "/tmp/demo", prompt: "ship it" })
    expect(win.consumed[0]!.href).toContain("/session")
  })

  test("a command line without a deep link yields nothing", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.ingest(["/usr/bin/alpha-code", "--enable-features=Foo", "/home/me/project"])
    win.drain(h.queue)
    expect(h.consumed()).toEqual([])
  })

  test("auth transport is consumed, never queued and never navigated", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.ingest(["alpha-code://auth/callback?code=abc&state=xyz"])

    expect(h.auth).toHaveLength(1)
    win.drain(h.queue)
    expect(h.consumed()).toEqual([])
  })

  test("anything the manifest refuses to decode is dropped fail-closed", () => {
    const h = harness()
    const win = h.open(BOOT)
    h.queue.ingest([
      "https://example.com/new-session?directory=/tmp",
      "opencode://unknown-host?directory=/tmp",
      "opencode://new-session",
      "opencode://new-session?directory=",
    ])

    win.drain(h.queue)
    expect(h.consumed()).toEqual([])
  })
})
