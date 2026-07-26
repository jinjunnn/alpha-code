import { describe, expect, test } from "bun:test"
import { createDeepLinkPublisher, type DeepLinkBufferTarget } from "./deep-link-bridge"
import { DEEP_LINK_EVENT, decodeDeepLink, type DeepLinkDelivery } from "../shared/route-manifest"
// The receiving half lives in the upstream renderer. Importing the real drain (instead of
// restating it) is what makes this an end-to-end exactly-once proof across the package boundary.
import { drainPendingDeepLinks } from "../../../app/src/pages/layout/deep-links"

const delivery = (url: string): DeepLinkDelivery => {
  const decoded = decodeDeepLink(url)
  if (!decoded) throw new Error(`fixture is not a decodable deep link: ${url}`)
  return decoded
}

const NEW_SESSION = delivery("opencode://new-session?directory=/tmp/demo&prompt=ship%20it")
const OPEN_PROJECT = delivery("opencode://open-project?directory=/tmp/other")

function target() {
  const bus = new EventTarget()
  const events: Event[] = []
  bus.addEventListener(DEEP_LINK_EVENT, (event) => events.push(event))
  const buffer: DeepLinkBufferTarget = { dispatchEvent: (event) => bus.dispatchEvent(event) }
  return { buffer, events, publish: createDeepLinkPublisher(buffer), asWindow: () => buffer as unknown as Window }
}

describe("shell → renderer deep-link bridge", () => {
  test("the wake-up event carries no payload, so nothing can be consumed off it", () => {
    const t = target()
    t.publish({ id: 1, links: [NEW_SESSION] })

    expect(t.events).toHaveLength(1)
    expect(t.events[0]!.type).toBe(DEEP_LINK_EVENT)
    expect((t.events[0] as CustomEvent).detail).toBeNull()
  })

  test("published deliveries are drained exactly once", () => {
    const t = target()
    t.publish({ id: 1, links: [NEW_SESSION] })

    expect(drainPendingDeepLinks(t.asWindow())).toEqual([NEW_SESSION])
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([])
  })

  test("deliveries that land before the layout mounts accumulate and drain together, once", () => {
    const t = target()
    t.publish({ id: 1, links: [OPEN_PROJECT] })
    t.publish({ id: 2, links: [NEW_SESSION] })

    expect(t.events).toHaveLength(2)
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([OPEN_PROJECT, NEW_SESSION])
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([])
  })

  test("a delivery published after a drain is a new one, not a replay of the old", () => {
    const t = target()
    t.publish({ id: 1, links: [OPEN_PROJECT] })
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([OPEN_PROJECT])

    t.publish({ id: 2, links: [NEW_SESSION] })
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([NEW_SESSION])
  })

  test("publishing nothing neither buffers nor wakes the layout", () => {
    const t = target()
    t.publish({ id: 1, links: [] })
    expect(t.events).toEqual([])
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([])
  })

  test("a batch id redelivered to the same document is published once", () => {
    // Main re-queues an unacknowledged batch and retries it; if that retry reaches a document that
    // already has the deliveries, the retry must not become a second consumption.
    const t = target()
    expect(t.publish({ id: 7, links: [NEW_SESSION] })).toBe(true)
    expect(t.publish({ id: 7, links: [NEW_SESSION] })).toBe(false)

    expect(t.events).toHaveLength(1)
    expect(drainPendingDeepLinks(t.asWindow())).toEqual([NEW_SESSION])
  })

  test("a fresh document starts with an empty dedupe, so a reload can be redelivered", () => {
    // The reload case: the buffer died with the old document, so the SAME batch id must publish
    // again into the new one.
    const before = target()
    before.publish({ id: 7, links: [NEW_SESSION] })

    const after = target()
    expect(after.publish({ id: 7, links: [NEW_SESSION] })).toBe(true)
    expect(drainPendingDeepLinks(after.asWindow())).toEqual([NEW_SESSION])
  })
})
