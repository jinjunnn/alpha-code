// Renderer half of the deep-link exactly-once rule (REQ-089 AC4).
//
// The window buffer IS the queue; the event is only a wake-up signal and deliberately carries no
// payload. That makes double consumption structurally impossible: a listener cannot read the
// deliveries off the event, so the only way to obtain them is to drain the buffer — and draining
// empties it. A layout that remounts, or a listener that fires before the layout mounts, therefore
// sees each delivery exactly once.

import { DEEP_LINK_EVENT, type DeepLinkDelivery } from "../shared/route-manifest"

export interface DeepLinkBufferTarget {
  __alphaDeepLinks?: DeepLinkDelivery[]
  dispatchEvent: (event: Event) => boolean
}

export function publishDeepLinks(target: DeepLinkBufferTarget, links: readonly DeepLinkDelivery[]): void {
  if (links.length === 0) return
  target.__alphaDeepLinks = [...(target.__alphaDeepLinks ?? []), ...links]
  target.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT))
}
