// Deep links are decoded by the Alpha shell's route manifest before they ever reach this
// renderer. This module is the passthrough on the receiving end: it validates the shape of the
// decoded deliveries and hands them to the layout. It owns no URL parsing, no scheme literal and
// no route/query schema — those live in exactly one place now.
//
// The event name is the single wire constant this side must spell out (packages/app cannot import
// from the shell). packages/ui-mac/src/shared/route-upstream-shape.test.ts anchors it against the
// manifest so the two copies cannot drift apart silently.
export const deepLinkEvent = "opencode:deep-link"

export interface DeepLinkDelivery {
  /** Which declared deep link this was — the shell's identity, not a hostname parsed here. */
  deepLinkId: string
  directory: string
  prompt?: string
  /** Ready-to-use in-app route href, derived from the same manifest that decoded the link. */
  href: string
}

declare global {
  interface Window {
    __alphaDeepLinks?: DeepLinkDelivery[]
  }
}

const isDelivery = (value: unknown): value is DeepLinkDelivery => {
  if (typeof value !== "object" || value === null) return false
  const link = value as Record<string, unknown>
  return (
    typeof link.deepLinkId === "string" &&
    typeof link.directory === "string" &&
    link.directory.length > 0 &&
    typeof link.href === "string" &&
    link.href.length > 0 &&
    (link.prompt === undefined || typeof link.prompt === "string")
  )
}

const deliveriesFor = (deepLinkId: string, links: readonly unknown[]) =>
  links.filter(isDelivery).filter((link) => link.deepLinkId === deepLinkId)

export const collectOpenProjectDeepLinks = (links: readonly unknown[]) => deliveriesFor("open-project", links)

export const collectNewSessionDeepLinks = (links: readonly unknown[]) => deliveriesFor("new-session", links)

export const drainPendingDeepLinks = (target: Window) => {
  const pending = target.__alphaDeepLinks ?? []
  if (pending.length === 0) return []
  target.__alphaDeepLinks = []
  return pending
}
