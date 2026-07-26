// Renderer half of the deep-link exactly-once rule (REQ-089 AC4).
//
// The window buffer IS the queue; the event is only a wake-up signal and deliberately carries no
// payload. That makes double consumption structurally impossible: a listener cannot read the
// deliveries off the event, so the only way to obtain them is to drain the buffer — and draining
// empties it. A layout that remounts, or a listener that fires before the layout mounts, therefore
// sees each delivery exactly once.
//
// Main keeps its own copy of a batch until this side acknowledges the batch id, and re-queues it
// if the renderer dies first (`main/deep-link-queue.ts`). That retry is what closes the in-flight
// hole; this publisher is the other half of it — a batch id already published into THIS document
// is never published twice. The set is per document on purpose: a reload takes the buffer with it,
// so after one the same batch SHOULD arrive again.

import { DEEP_LINK_EVENT, type DeepLinkBatch, type DeepLinkDelivery } from "../shared/route-manifest"

export interface DeepLinkBufferTarget {
  __alphaDeepLinks?: DeepLinkDelivery[]
  dispatchEvent: (event: Event) => boolean
}

/**
 * One publisher per document. Returns whether the batch was newly published; either way the caller
 * must acknowledge it, because "already in this document's buffer" is as final as "put there now".
 */
export function createDeepLinkPublisher(target: DeepLinkBufferTarget) {
  const published = new Set<number>()
  return (batch: DeepLinkBatch): boolean => {
    if (published.has(batch.id)) return false
    published.add(batch.id)
    if (batch.links.length === 0) return false
    target.__alphaDeepLinks = [...(target.__alphaDeepLinks ?? []), ...batch.links]
    target.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT))
    return true
  }
}
