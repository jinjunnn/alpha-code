// Executable authority judgement for the deep-link consumer (REQ-089 AC2/AC4).
//
// The previous gate asked whether layout.tsx *mentioned* certain names. That is a text rule, and a
// text rule was twice narrowed and twice walked around (rewrite the `navigate` callback, or rewrite
// the delivery before it goes in — both silently retarget the navigation while every name the rule
// looked for stays put). The repo's own lesson applies: a gate that asserts source text is not a
// gate.
//
// So this file executes the real thing instead. It runs the manifest's encoder, the manifest's
// decoder, and the app's real consumer — `createDeepLinkConsumer`, the whole path from "a delivery
// is in the buffer" to "the app navigates" — and asserts the observed navigation target is the one
// the manifest derives, independently computed. Any transformation anywhere along that path shows
// up as a different target. The text rules in route-authority-ratchet.test.ts remain, but only as
// the fallback that pins the one adapter line this test cannot reach into.
import { describe, expect, test } from "bun:test"
import { createDeepLinkConsumer } from "../../../app/src/pages/layout/deep-links"
import { decodeDeepLink, deepLinkFor, encodeDirectory, hrefFor } from "./route-manifest"

// A space and a non-ASCII character: if any hop re-encodes or re-assembles the target instead of
// forwarding the manifest's, the byte-for-byte comparison below moves.
const DIRECTORY = "/tmp/alpha demo/项目"
const PROMPT = "ship it"

interface ConsumerCalls {
  openProject: [string, boolean][]
  navigate: string[]
  handoff: [string, string][]
}

/** Drive the app's real consumer over a buffer, exactly as the layout's onMount does. */
function consume(deliveries: readonly unknown[], options: { enabled?: boolean } = {}) {
  const calls: ConsumerCalls = { openProject: [], navigate: [], handoff: [] }
  const buffer = { __alphaDeepLinks: [...deliveries] } as unknown as Window
  const run = createDeepLinkConsumer({
    enabled: () => options.enabled ?? true,
    buffer: () => buffer,
    openProject: (directory, navigate) => calls.openProject.push([directory, navigate]),
    navigate: (href) => calls.navigate.push(href),
    handoff: (directory, prompt) => calls.handoff.push([directory, prompt]),
  })
  run() // the layout's first drain on mount
  return { calls, buffer, run }
}

/** The full production ingress path for one OS deep link, minus Electron's transport. */
function deliveryFor(url: string) {
  const delivery = decodeDeepLink(url)
  expect(delivery).toBeDefined()
  return delivery!
}

describe("a deep link navigates to the target the manifest derives, and to nothing else", () => {
  test("new-session: the observed navigation target IS the manifest's href", () => {
    const delivery = deliveryFor(deepLinkFor.newSession(DIRECTORY, PROMPT))
    const { calls } = consume([delivery])

    // Independently derived from the manifest — not read back off the delivery.
    expect(calls.navigate).toEqual([hrefFor.sessionAdmission(DIRECTORY, PROMPT)])
    // And pinned to the literal value, so a change to the derivation itself is also visible here.
    expect(calls.navigate).toEqual([`/${encodeDirectory(DIRECTORY)}/session?prompt=ship%20it`])
    expect(calls.openProject).toEqual([[DIRECTORY, false]])
    expect(calls.handoff).toEqual([[DIRECTORY, PROMPT]])
  })

  test("open-project: the project opens and navigates, with no second target invented", () => {
    const delivery = deliveryFor(deepLinkFor.openProject(DIRECTORY))
    const { calls } = consume([delivery])

    expect(calls.openProject).toEqual([[DIRECTORY, true]])
    expect(calls.navigate).toEqual([])
    expect(calls.handoff).toEqual([])
  })

  test("a prompt-less new-session link seeds no handoff and still lands on the manifest's href", () => {
    const delivery = deliveryFor(deepLinkFor.newSession(DIRECTORY))
    const { calls } = consume([delivery])

    expect(calls.navigate).toEqual([hrefFor.sessionAdmission(DIRECTORY)])
    expect(calls.handoff).toEqual([])
  })

  test("two links in one buffer keep their order and their own targets", () => {
    const other = "/tmp/second"
    const links = [
      deliveryFor(deepLinkFor.newSession(DIRECTORY, PROMPT)),
      deliveryFor(deepLinkFor.newSession(other)),
    ]
    const { calls } = consume(links)

    expect(calls.navigate).toEqual([hrefFor.sessionAdmission(DIRECTORY, PROMPT), hrefFor.sessionAdmission(other)])
  })

  test("consuming twice acts once: the buffer IS the queue", () => {
    const delivery = deliveryFor(deepLinkFor.newSession(DIRECTORY))
    const { calls, run } = consume([delivery])

    run() // a layout remount, or a late wake-up signal

    expect(calls.navigate).toEqual([hrefFor.sessionAdmission(DIRECTORY)])
  })

  test("no local server yet: nothing is acted on AND nothing is thrown away", () => {
    const delivery = deliveryFor(deepLinkFor.newSession(DIRECTORY))
    const { calls, buffer } = consume([delivery], { enabled: false })

    expect(calls.navigate).toEqual([])
    expect((buffer as unknown as { __alphaDeepLinks: unknown[] }).__alphaDeepLinks).toEqual([delivery])
  })

  test("anything that is not a complete delivery is dropped fail-closed", () => {
    const { calls } = consume([
      "opencode://new-session?directory=/tmp",
      null,
      { deepLinkId: "new-session", directory: DIRECTORY },
      { deepLinkId: "new-session", directory: DIRECTORY, href: "" },
      { deepLinkId: "unknown", directory: DIRECTORY, href: "/somewhere" },
    ])

    expect(calls).toEqual({ openProject: [], navigate: [], handoff: [] })
  })
})

describe("the consumer runs the manifest's ingress, not a second reading of the URL", () => {
  test("what the shell decodes is what the consumer navigates to, with no re-derivation", () => {
    const url = deepLinkFor.newSession(DIRECTORY, PROMPT)
    const delivery = deliveryFor(url)
    const { calls } = consume([delivery])

    expect(delivery.href).toBe(hrefFor.sessionAdmission(DIRECTORY, PROMPT))
    expect(calls.navigate).toEqual([delivery.href])
  })

  test("a link the manifest refuses never reaches the consumer at all", () => {
    for (const url of [
      "https://example.com/new-session?directory=/tmp",
      "opencode://unknown-host?directory=/tmp",
      "opencode://new-session",
      "opencode://new-session?directory=",
    ])
      expect(decodeDeepLink(url)).toBeUndefined()
  })
})
