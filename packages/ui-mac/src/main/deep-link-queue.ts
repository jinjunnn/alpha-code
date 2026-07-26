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
// initial drain alike — is KEPT until that exact renderer acknowledges it. An unacknowledged batch
// whose renderer goes away returns to the queue and is retried against whoever is still there;
// `deliver` returning true only means the transport took it.
//
// `acknowledge` is idempotent and identity-checked: a batch is in exactly one of `pending` or
// `inFlight`, an ack from a renderer the batch was never handed to is ignored, and an ack that
// races its own renderer's death retires the requeued copy too. That is what stops the retry from
// becoming a second consumption.
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
   * to that exact renderer instance. The batches handed back stay on main's books until that
   * renderer acknowledges them.
   */
  consumeInitial: (rendererId: number) => DeepLinkBatch[]
  /**
   * That renderer now holds the batch: retire main's copy. Only the renderer the batch was handed
   * to can retire it, and acknowledging twice — or acknowledging something already retired — is a
   * no-op.
   */
  acknowledge: (rendererId: number, batchId: number) => void
  /**
   * That renderer instance stopped being a live consumer — reload, crash, or destruction. A stale
   * id (already dropped, or never an owner) is a no-op for ownership; anything it never
   * acknowledged goes back to the queue and is retried against the renderers still there.
   */
  rendererGone: (rendererId: number) => void
}

/**
 * Every way a renderer that has drained stops being able to receive links. All three must drop
 * ownership: `webContents.send` to a crashed or reloading renderer is silently discarded, so a
 * missing wire here loses the link with no error anywhere.
 */
export const RENDERER_LIFECYCLE_EVENTS = ["did-start-loading", "render-process-gone", "destroyed"] as const

export type RendererLifecycleEvent = (typeof RENDERER_LIFECYCLE_EVENTS)[number]

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
  const gone = () => queue.rendererGone(renderer.id)
  for (const event of RENDERER_LIFECYCLE_EVENTS) renderer.on(event, gone)
}

/** A batch plus the renderer currently answerable for it. `undefined` = nobody has been handed it. */
interface HeldBatch extends DeepLinkBatch {
  handedTo?: number
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

  /** Push what is queued at the current owner, in order, until it refuses or nothing is left. */
  const flush = () => {
    while (pending.length > 0 && owners.length > 0) {
      const rendererId = owners[owners.length - 1]!
      const batch = pending[0]!
      // A refusal means that renderer is not there any more, so it stops being an owner.
      if (!deps.deliver(rendererId, { id: batch.id, links: batch.links })) {
        owners.pop()
        continue
      }
      batch.handedTo = rendererId
      pending.shift()
      inFlight.push(batch)
    }
  }

  const retire = (list: HeldBatch[], rendererId: number, batchId: number) => {
    const at = list.findIndex((batch) => batch.id === batchId && batch.handedTo === rendererId)
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
      pending.push({ id: nextBatchId++, links })
      flush()
    },
    consumeInitial(rendererId) {
      const at = owners.indexOf(rendererId)
      if (at !== -1) owners.splice(at, 1)
      owners.push(rendererId)
      const taken = pending.splice(0)
      for (const batch of taken) {
        batch.handedTo = rendererId
        inFlight.push(batch)
      }
      // The reply travels back asynchronously too, so the drain path keeps its copy exactly like
      // the live path: these batches leave main's books only when this renderer acknowledges them.
      return taken.map((batch) => ({ id: batch.id, links: batch.links }))
    },
    acknowledge(rendererId, batchId) {
      if (retire(inFlight, rendererId, batchId)) return
      // The ack/death race: a renderer that acknowledged and then immediately reloaded has already
      // had its batch pushed back by `rendererGone`. Retire it there too, so the outcome does not
      // depend on which of the two messages main happened to process first — otherwise the retry
      // hands the same delivery out a second time.
      retire(pending, rendererId, batchId)
    },
    rendererGone(rendererId) {
      const at = owners.indexOf(rendererId)
      if (at !== -1) owners.splice(at, 1)
      for (let index = inFlight.length - 1; index >= 0; index -= 1) {
        if (inFlight[index]!.handedTo !== rendererId) continue
        pending.push(inFlight.splice(index, 1)[0]!)
      }
      // Ids are monotonic, so this restores delivery order after a requeue.
      pending.sort((left, right) => left.id - right.id)
      flush()
    },
  }
}
