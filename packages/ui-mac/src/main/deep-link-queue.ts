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
}

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
   * `"reloading"` keeps it on that renderer's books for its next document, `"gone"` returns it to
   * the queue for the renderers still there. See `RENDERER_EXIT_BY_EVENT` for why.
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

  /** Push what is queued at the current owner, in order, until it refuses or nothing is left. */
  const flush = () => {
    while (pending.length > 0 && owners.length > 0) {
      const rendererId = owners[owners.length - 1]!
      const batch = pending[0]!
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
      // A fresh document is the only thing that can take over a batch no live owner is answerable
      // for: this renderer's own batches held across a reload or a crash, plus anything a departed
      // renderer left owing that no surviving window could be given. What a LIVE owner still holds
      // stays with it — that is the ownership rule, and taking it here would be the second
      // consumption this queue exists to prevent.
      const taken: HeldBatch[] = []
      for (let index = inFlight.length - 1; index >= 0; index -= 1) {
        const batch = inFlight[index]!
        if (batch.handedTo !== rendererId && owners.includes(batch.handedTo!)) continue
        taken.push(inFlight.splice(index, 1)[0]!)
      }
      taken.push(...pending.splice(0))
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
      // A reloading or crashed renderer keeps its id and its books: its next document drains them
      // back. Only a retired id hands them over, because only then is there no next document.
      if (exit === "gone") reclaim(rendererId)
      flush()
    },
  }
}
