// Deep-link ingress queue (REQ-089 AC4).
//
// One delivery must reach the renderer EXACTLY ONCE, whatever the timing. Three facts make that
// non-trivial:
//   * the OS can hand us a link before a renderer exists (cold start, first process command line);
//   * a renderer that has already drained can go away in four different ways — reload (sidecar
//     structural respawn), renderer-process crash, window close, and "there is now a NEWER window"
//     (the `window.new` menu action);
//   * handing a link to the renderer transport is NOT the same as the renderer having it.
//     `webContents.send` is fire-and-forget: it returns before the renderer has run a line of code,
//     and a reload or crash in that gap swallows the payload with no error anywhere. The same is
//     true of the initial drain, whose reply travels back over `invoke`.
//
// So the queue owns TWO things. Ownership is keyed on the IDENTITY of the webContents that drained,
// never on "is there a window": a link goes to the most recent renderer that accepts it, and only
// when none does is it queued for whoever drains next. And every batch handed over — live send or
// initial drain alike — is KEPT until that exact renderer acknowledges it. `deliver` returning true
// only means the transport took it.
//
// Where an unacknowledged batch goes when its renderer stops listening depends on WHY it stopped,
// because "it never got it" and "it got it and its ack is still on the wire" are indistinguishable
// from here:
//   * reload and render-process crash keep the webContents id, and a NEW document will drain under
//     it. The batch therefore stays on that renderer's own books and is re-handed to its next
//     document. Pushing it into a different window that is already running — which is what an
//     immediate retry does — hands the delivery out a second time whenever the ack was merely late,
//     and sends it to a window the user was not even working in;
//   * `destroyed` retires the id: nothing will drain under it again, so the batch does go back to
//     the queue and is retried against the windows that are left. So does a batch held by a
//     renderer that refuses a later delivery — unreachable with no lifecycle event is still gone.
//
// That retention is a PARK, not a promise, and it is bounded on both axes:
//   * LIVENESS. Nothing guarantees the next document ever arrives — the reload can land on a page
//     that mounts no layout, it can fail outright, and `render-process-gone` only pops a recovery
//     dialog the user may ignore. Electron's `did-start-loading` says a load STARTED, never that a
//     document mounted. So a park expires after `RENDERER_RETENTION_MS` and what it held goes back
//     to the queue for whoever is still on screen. Without that the link sits in `inFlight` for the
//     life of the process, because no existing window ever drains again on its own.
//   * ORDER. While a batch is parked, no NEWER batch may be handed to anyone. Otherwise batch 2
//     reaches the window still on screen immediately and batch 1 follows it whenever the park
//     resolves, and the app acts on the two links backwards. Parked batches therefore hold their
//     place in the delivery order, and the wait is bounded by the same retention window.
//     Known residual: two renderers parked AT ONCE (a sidecar respawn reloads every window) each
//     keep their own batch, so a document that mounts under one of them takes its own batch back
//     while the other park is still blocking older work. Ordering between two windows that both
//     died mid-delivery is not pinned; ordering at any one renderer, for one park, is.
//
// `acknowledge` is idempotent and identity-checked, and the identity is the set of renderers the
// batch has EVER been handed to, not whoever holds it now: a batch is in exactly one of `pending`
// or `inFlight`, an ack from a renderer the batch was never handed to is ignored, and an ack that
// races its own renderer's death retires the copy wherever the race left it — requeued, or already
// re-handed to another window. That is what stops one retry from becoming a chain of them.
//
// The module is pure state + injected effects so every timing above is a unit test
// (`deep-link-queue.test.ts`), not a claim — including the lifecycle wiring itself
// (`trackRendererLifecycle`), which is what the four "went away" paths run through.

import { decodeDeepLink, isDeepLink, type DeepLinkBatch, type DeepLinkDelivery } from "../shared/route-manifest"

// The unit of delivery AND of acknowledgement: the id is process-unique and travels to the
// renderer, which sends it back once the deliveries are in its own hands.
export type { DeepLinkBatch }

export interface DeepLinkQueueDeps {
  /** Auth transport (PKCE callback) is consumed here and never becomes a navigation. */
  consumeAuth: (url: string) => boolean
  /**
   * Hand one batch to one specific renderer. `false` = that renderer could not take it
   * (destroyed, crashed, gone); the queue then tries the next owner down and finally buffers.
   * `true` only means the transport accepted it — the batch is still owed an acknowledgement.
   */
  deliver: (rendererId: number, batch: DeepLinkBatch) => boolean
  /**
   * Run `expire` once, `delayMs` from now. The queue uses it for exactly one thing: ending a park.
   * It is a dependency rather than a bare `setTimeout` because the park is what makes the retention
   * safe — a queue that could not end one would hold a link forever — and a bound nothing can
   * observe is a bound nobody tests.
   */
  schedule: (delayMs: number, expire: () => void) => void
}

/**
 * How long a renderer that kept its id may keep batches nobody else can be given. Long enough to
 * cover a reload or a crash-and-reload (both are sub-second when they work at all), short enough
 * that a load which never mounts a document does not strand the user's link — or, because parks
 * hold their place in the delivery order, the links behind it.
 */
export const RENDERER_RETENTION_MS = 10_000

export interface DeepLinkQueue {
  /**
   * Ingest raw OS arguments — first-process `process.argv`, `second-instance` argv, or a single
   * macOS `open-url`. Non-deep-link arguments (executable path, switches) are ignored; anything
   * the manifest refuses to decode is dropped fail-closed.
   */
  ingest: (args: readonly string[]) => void
  /**
   * A renderer's initial drain, identified by its webContents id. Also transfers stream ownership
   * to that exact renderer instance. A fresh document is the only thing that can take over a batch
   * no LIVE owner is answerable for, so the drain also picks up what this renderer retained across
   * a reload and anything a departed renderer left owing. The batches handed back stay on main's
   * books until this renderer acknowledges them.
   */
  consumeInitial: (rendererId: number) => DeepLinkBatch[]
  /**
   * That renderer now holds the batch: retire main's copy. Only a renderer the batch has been
   * handed to at some point can retire it — including one it was since re-handed away from, whose
   * ack was simply late — and acknowledging twice, or acknowledging something already retired, is
   * a no-op.
   */
  acknowledge: (rendererId: number, batchId: number) => void
  /**
   * That renderer instance stopped being a live consumer. A stale id (already dropped, or never an
   * owner) is a no-op for ownership. `exit` decides what happens to what it never acknowledged:
   * `"reloading"` parks it on that renderer's books for its next document — for at most
   * `RENDERER_RETENTION_MS`, after which the queue stops waiting — and `"gone"` returns it to the
   * queue for the renderers still there straight away. See `RENDERER_EXIT_BY_EVENT` for why.
   */
  rendererGone: (rendererId: number, exit: RendererExit) => void
}

/**
 * Every way a renderer that has drained stops being able to receive links, and what each one says
 * about the batches it has not acknowledged. All of them must drop ownership: `webContents.send`
 * to a crashed or reloading renderer is silently discarded, so a missing wire here loses the link
 * with no error anywhere. Where the unacknowledged batches go is the part that differs.
 *
 * `did-start-loading` (reload — sidecar structural respawn drives it) and `render-process-gone`
 * both leave the webContents id in place, so a new document can still drain under it: the batch
 * waits for that document rather than jumping to another window, because the renderer may already
 * have acted on it with the ack still in transit.
 *
 * `destroyed` retires the id for good. Whatever that renderer did with the batch died with it, so
 * the honest move is to retry it against the windows that are left.
 */
export const RENDERER_EXIT_BY_EVENT = {
  "did-start-loading": "reloading",
  "render-process-gone": "reloading",
  destroyed: "gone",
} as const

export type RendererLifecycleEvent = keyof typeof RENDERER_EXIT_BY_EVENT

export type RendererExit = (typeof RENDERER_EXIT_BY_EVENT)[RendererLifecycleEvent]

export const RENDERER_LIFECYCLE_EVENTS = Object.keys(RENDERER_EXIT_BY_EVENT) as RendererLifecycleEvent[]

export interface RendererLifecycleSource {
  /** The webContents id — the identity ownership is keyed on. */
  readonly id: number
  on: (event: RendererLifecycleEvent, listener: () => void) => unknown
}

/**
 * Wire one renderer's lifecycle into the queue. Called for EVERY window creation path (boot and
 * the `window.new` menu action both go through `createMainWindow`), so a window that was never
 * wired cannot exist.
 */
export function trackRendererLifecycle(
  renderer: RendererLifecycleSource,
  queue: Pick<DeepLinkQueue, "rendererGone">,
): void {
  for (const [event, exit] of Object.entries(RENDERER_EXIT_BY_EVENT))
    renderer.on(event as RendererLifecycleEvent, () => queue.rendererGone(renderer.id, exit))
}

interface HeldBatch extends DeepLinkBatch {
  /** The renderer currently answerable for it. `undefined` = nobody has been handed it. */
  handedTo?: number
  /**
   * Every renderer this batch has been handed to. Retirement is keyed on this rather than on
   * `handedTo`, so an ack that arrives after the batch was re-handed to another window still
   * retires it instead of being dropped as a stranger's.
   */
  readonly heldBy: Set<number>
}

export function createDeepLinkQueue(deps: DeepLinkQueueDeps): DeepLinkQueue {
  // Batches nobody holds: never handed over, or returned by a renderer that died owing an ack.
  const pending: HeldBatch[] = []
  // Batches a renderer has been handed and has not acknowledged. Main's retained copy lives here.
  const inFlight: HeldBatch[] = []
  // Renderers that have drained and are still live, oldest first. The last one is the current
  // owner: with two windows open, the newest one to have drained takes the stream, and closing it
  // hands the stream back to the one still on screen rather than stranding links in the buffer.
  const owners: number[] = []
  // Renderers that kept their id but have no live document: a park. Their unacknowledged batches
  // stay on their own books — nobody else may adopt them, because "it never got it" and "its ack is
  // still on the wire" are indistinguishable — until their next document drains or the park expires.
  const parked = new Set<number>()
  let nextBatchId = 1

  const hand = (batch: HeldBatch, rendererId: number) => {
    batch.handedTo = rendererId
    batch.heldBy.add(rendererId)
  }

  /** Ids are monotonic, so sorting after any requeue restores delivery order. */
  const inOrder = (batches: HeldBatch[]) => batches.sort((left, right) => left.id - right.id)

  /** Take back everything one renderer still owes, for retry against whoever is left. */
  const reclaim = (rendererId: number) => {
    for (let index = inFlight.length - 1; index >= 0; index -= 1) {
      if (inFlight[index]!.handedTo !== rendererId) continue
      pending.push(inFlight.splice(index, 1)[0]!)
    }
    inOrder(pending)
  }

  /**
   * The oldest parked batch — the line nothing newer may cross. A batch handed out ahead of it
   * would be acted on first and then followed by the older link when the park resolves, which is
   * the same delivery order the user's two clicks did NOT have.
   */
  const parkedFloor = () => {
    let floor = Number.POSITIVE_INFINITY
    for (const batch of inFlight) if (parked.has(batch.handedTo!) && batch.id < floor) floor = batch.id
    return floor
  }

  /** Push what is queued at the current owner, in order, until it refuses or nothing is left. */
  const flush = () => {
    while (pending.length > 0 && owners.length > 0) {
      const rendererId = owners[owners.length - 1]!
      const batch = pending[0]!
      // Blocked behind a park, and only ever for the length of one: bounded delay, never reordering.
      if (batch.id > parkedFloor()) return
      // A refusal means that renderer is not there any more — unreachable with no lifecycle event
      // is still gone. It stops being an owner AND gives back what it never acknowledged; leaving
      // that behind strands the older batch in `inFlight` for the life of the process while the
      // next renderer receives only the newer ones.
      if (!deps.deliver(rendererId, { id: batch.id, links: batch.links })) {
        owners.pop()
        reclaim(rendererId)
        continue
      }
      hand(batch, rendererId)
      pending.shift()
      inFlight.push(batch)
    }
  }

  /**
   * End a park the queue has waited long enough for. Stale timers are the norm — a park usually
   * ends because the next document drained or the window was destroyed — so only a park still
   * standing gives anything back.
   */
  const release = (rendererId: number) => {
    if (!parked.delete(rendererId)) return
    reclaim(rendererId)
    flush()
  }

  const retire = (list: HeldBatch[], rendererId: number, batchId: number) => {
    const at = list.findIndex((batch) => batch.id === batchId && batch.heldBy.has(rendererId))
    if (at === -1) return false
    list.splice(at, 1)
    return true
  }

  return {
    ingest(args) {
      const links: DeepLinkDelivery[] = []
      for (const arg of args) {
        if (!isDeepLink(arg)) continue
        if (deps.consumeAuth(arg)) continue
        const delivery = decodeDeepLink(arg)
        if (delivery) links.push(delivery)
      }
      if (links.length === 0) return
      // A batch lives in exactly one place at a time — queued, or in flight against one renderer.
      // That single-home rule is the exactly-once rule.
      pending.push({ id: nextBatchId++, links, heldBy: new Set() })
      flush()
    },
    consumeInitial(rendererId) {
      const at = owners.indexOf(rendererId)
      if (at !== -1) owners.splice(at, 1)
      // Its next document is here, so this renderer's own park is over: what it kept comes back to
      // it below, and it stops blocking anyone else.
      parked.delete(rendererId)
      const floor = parkedFloor()
      // A fresh document takes over its OWN batches — held across a reload or a crash — plus
      // anything a departed renderer left owing that no surviving window could be given. What
      // another renderer still holds stays with it, whether that renderer is a LIVE owner or a
      // PARKED one: in both cases an ack may simply be late, and taking the batch here would be the
      // second consumption this queue exists to prevent. Parked is the case ownership-by-liveness
      // gets wrong — nobody is live, and the batch is still not free.
      const taken: HeldBatch[] = []
      for (let index = inFlight.length - 1; index >= 0; index -= 1) {
        const batch = inFlight[index]!
        if (batch.handedTo !== rendererId && (owners.includes(batch.handedTo!) || parked.has(batch.handedTo!))) continue
        taken.push(inFlight.splice(index, 1)[0]!)
      }
      // Queued batches newer than a standing park wait behind it here too; a drain is a delivery
      // like any other, and letting one jump the park is the same reordering `flush` refuses.
      let queued = 0
      while (queued < pending.length && pending[queued]!.id < floor) queued += 1
      taken.push(...pending.splice(0, queued))
      inOrder(taken)
      owners.push(rendererId)
      for (const batch of taken) {
        hand(batch, rendererId)
        inFlight.push(batch)
      }
      // The reply travels back asynchronously too, so the drain path keeps its copy exactly like
      // the live path: these batches leave main's books only when this renderer acknowledges them.
      return taken.map((batch) => ({ id: batch.id, links: batch.links }))
    },
    acknowledge(rendererId, batchId) {
      if (retire(inFlight, rendererId, batchId)) return
      // The ack/death race: a renderer that acknowledged and then immediately died has already had
      // its batch pushed back by `rendererGone`. Retire it there too, so the outcome does not
      // depend on which of the two messages main happened to process first — otherwise the retry
      // hands the same delivery out a second time.
      retire(pending, rendererId, batchId)
    },
    rendererGone(rendererId, exit) {
      const at = owners.indexOf(rendererId)
      if (at !== -1) owners.splice(at, 1)
      if (exit === "gone") {
        // A retired id: there is no next document, so there is nothing to wait for.
        parked.delete(rendererId)
        reclaim(rendererId)
      } else if (!parked.has(rendererId) && inFlight.some((batch) => batch.handedTo === rendererId)) {
        // It kept its id and still owes acknowledgements: park them for its next document, and
        // start the clock that ends the wait if that document never mounts. A second lifecycle
        // event (crash then reload) must not restart that clock — the bound is on the whole park.
        parked.add(rendererId)
        deps.schedule(RENDERER_RETENTION_MS, () => release(rendererId))
      }
      flush()
    },
  }
}
