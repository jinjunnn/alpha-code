// Deep links are decoded by the Alpha shell's route manifest before they ever reach this
// renderer. This module is the WHOLE receiving end: it validates the shape of the decoded
// deliveries, drains the buffer, and dispatches them. It owns no URL parsing, no scheme literal
// and no route/query schema — those live in exactly one place now, and the navigation target is
// whatever the shell decoded, never a path this side assembles.
//
// Keeping the dispatch here (rather than inline in layout.tsx) is what lets the route-authority
// ratchet hold this file to the FULL rule set — including "parameterized session hrefs belong in
// the manifest". layout.tsx cannot be held to that rule: upstream's own sidebar legitimately
// writes `/${slug}/session` literals.
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

/**
 * Take everything the shell has buffered. The buffer is the queue and the shell's event carries
 * no payload, so this is the single consumption point: whatever a second caller (a remounted
 * layout, a late listener) sees, it is not a replay.
 */
export const drainPendingDeepLinks = (target: Window) => {
  const pending = target.__alphaDeepLinks ?? []
  if (pending.length === 0) return []
  target.__alphaDeepLinks = []
  return pending
}

export interface DeepLinkHandlers {
  /** Open (and by default navigate to) a project directory. */
  openProject: (directory: string, navigate: boolean) => void
  /** Navigate to the shell-decoded href verbatim. */
  navigate: (href: string) => void
  /** Seed the session composer for a link that carried a prompt. */
  handoff: (directory: string, prompt: string) => void
}

/**
 * Dispatch decoded deliveries. The navigation target is `link.href` — produced by the manifest
 * that decoded the link — and is passed through untouched; this side never assembles a route.
 */
export const applyDeepLinks = (links: readonly unknown[], handlers: DeepLinkHandlers) => {
  for (const link of collectOpenProjectDeepLinks(links)) {
    handlers.openProject(link.directory, true)
  }

  for (const link of collectNewSessionDeepLinks(links)) {
    handlers.openProject(link.directory, false)
    if (link.prompt) handlers.handoff(link.directory, link.prompt)
    handlers.navigate(link.href)
  }
}
