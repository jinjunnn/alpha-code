// Deep-link ingress queue (REQ-089 AC4).
//
// One delivery must reach the renderer EXACTLY ONCE, whatever the timing. Two facts make that
// non-trivial:
//   * the OS can hand us a link before a renderer exists (cold start, first process command line);
//   * a live renderer can be torn down and reloaded (sidecar structural respawn), and the reloaded
//     renderer drains the initial queue again.
// So the queue holds a link only while there is no renderer that has taken ownership of the
// stream. Once a renderer has drained the initial queue it owns everything that follows and the
// links go straight out over IPC — never both. When that renderer starts a fresh document load,
// ownership lapses and the queue takes over again until the new one drains.
//
// The module is pure state + injected effects so every timing above is a unit test
// (`deep-link-queue.test.ts`), not a claim.

import { decodeDeepLink, isDeepLink, type DeepLinkDelivery } from "../shared/route-manifest"

export interface DeepLinkQueueDeps {
  /** Auth transport (PKCE callback) is consumed here and never becomes a navigation. */
  consumeAuth: (url: string) => boolean
  /** Hand the deliveries to a live renderer. `false` = there was no renderer to take them. */
  deliver: (links: DeepLinkDelivery[]) => boolean
}

export interface DeepLinkQueue {
  /**
   * Ingest raw OS arguments — first-process `process.argv`, `second-instance` argv, or a single
   * macOS `open-url`. Non-deep-link arguments (executable path, switches) are ignored; anything
   * the manifest refuses to decode is dropped fail-closed.
   */
  ingest: (args: readonly string[]) => void
  /** The renderer's initial drain. Also transfers stream ownership to that renderer. */
  consumeInitial: () => DeepLinkDelivery[]
  /** The owning renderer went away (reload / navigation / destroyed window). */
  rendererGone: () => void
}

export function createDeepLinkQueue(deps: DeepLinkQueueDeps): DeepLinkQueue {
  const pending: DeepLinkDelivery[] = []
  let rendererOwnsStream = false

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
      if (rendererOwnsStream && deps.deliver(deliveries)) return
      pending.push(...deliveries)
    },
    consumeInitial() {
      rendererOwnsStream = true
      return pending.splice(0)
    },
    rendererGone() {
      rendererOwnsStream = false
    },
  }
}
