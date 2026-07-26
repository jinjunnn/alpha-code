// Deep-link ingress queue (REQ-089 AC4).
//
// One delivery must reach the renderer EXACTLY ONCE, whatever the timing. Two facts make that
// non-trivial:
//   * the OS can hand us a link before a renderer exists (cold start, first process command line);
//   * a renderer that has already drained can go away in four different ways — reload (sidecar
//     structural respawn), renderer-process crash, window close, and "there is now a NEWER window"
//     (the `window.new` menu action).
//
// Ownership is therefore keyed on the IDENTITY of the webContents that drained, never on "is there
// a window". A boolean cannot tell a crashed renderer from a live one, and `webContents.send` to a
// crashed renderer neither throws nor arrives — the link is simply lost. So the queue holds a
// stack of renderers that have drained and are still live; a link goes to the most recent one that
// accepts it, and only when none does is it queued for whoever drains next.
//
// The module is pure state + injected effects so every timing above is a unit test
// (`deep-link-queue.test.ts`), not a claim — including the lifecycle wiring itself
// (`trackRendererLifecycle`), which is what the four "went away" paths run through.

import { decodeDeepLink, isDeepLink, type DeepLinkDelivery } from "../shared/route-manifest"

export interface DeepLinkQueueDeps {
  /** Auth transport (PKCE callback) is consumed here and never becomes a navigation. */
  consumeAuth: (url: string) => boolean
  /**
   * Hand the deliveries to one specific renderer. `false` = that renderer could not take them
   * (destroyed, crashed, gone); the queue then tries the next owner down and finally buffers.
   */
  deliver: (rendererId: number, links: DeepLinkDelivery[]) => boolean
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
   * to that exact renderer instance.
   */
  consumeInitial: (rendererId: number) => DeepLinkDelivery[]
  /**
   * That renderer instance stopped being a live consumer — reload, crash, or destruction. A stale
   * id (already dropped, or never an owner) is a no-op.
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

export function createDeepLinkQueue(deps: DeepLinkQueueDeps): DeepLinkQueue {
  const pending: DeepLinkDelivery[] = []
  // Renderers that have drained and are still live, oldest first. The last one is the current
  // owner: with two windows open, the newest one to have drained takes the stream, and closing it
  // hands the stream back to the one still on screen rather than stranding links in the buffer.
  const owners: number[] = []

  return {
    ingest(args) {
      const deliveries: DeepLinkDelivery[] = []
      for (const arg of args) {
        if (!isDeepLink(arg)) continue
        if (deps.consumeAuth(arg)) continue
        const delivery = decodeDeepLink(arg)
        if (delivery) deliveries.push(delivery)
      }
      if (deliveries.length === 0) return
      // Live delivery and the queue are alternatives, never both: that is the exactly-once rule.
      // A refusal means that renderer is not there any more, so it stops being an owner.
      while (owners.length > 0) {
        if (deps.deliver(owners[owners.length - 1]!, deliveries)) return
        owners.pop()
      }
      pending.push(...deliveries)
    },
    consumeInitial(rendererId) {
      const at = owners.indexOf(rendererId)
      if (at !== -1) owners.splice(at, 1)
      owners.push(rendererId)
      return pending.splice(0)
    },
    rendererGone(rendererId) {
      const at = owners.indexOf(rendererId)
      if (at !== -1) owners.splice(at, 1)
    },
  }
}
