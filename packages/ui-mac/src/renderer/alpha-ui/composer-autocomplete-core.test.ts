// REQ-038 — home composer slash/@ trigger detection + mention part building (pure logic).
// The interesting cases are the ones the session page already gets right: a slash token closes on
// whitespace, @ only triggers on a word boundary, edited-away mentions must not send parts.

import { describe, expect, test } from "bun:test"
import {
  applyMention,
  buildMentionParts,
  detectTrigger,
  triggerSignature,
  type MentionPart,
} from "./composer-autocomplete-core"

describe("detectTrigger — slash", () => {
  test("bare '/' at caret 1 opens with empty query", () => {
    expect(detectTrigger("/", 1)).toEqual({ mode: "slash", query: "", tokenStart: 0, caret: 1 })
  })
  test("'/rev' filters by 'rev'", () => {
    expect(detectTrigger("/rev", 4)?.query).toBe("rev")
  })
  test("query lowercases", () => {
    expect(detectTrigger("/Rev", 4)?.query).toBe("rev")
  })
  test("a following space closes the menu (upstream parity)", () => {
    expect(detectTrigger("/review ", 8)).toBeNull()
    expect(detectTrigger("/review pr 12", 13)).toBeNull()
  })
  test("slash not at position 0 is not a command", () => {
    expect(detectTrigger("hi /rev", 7)?.mode).not.toBe("slash")
  })
})

describe("detectTrigger — @", () => {
  test("'@' at start opens with empty query", () => {
    expect(detectTrigger("@", 1)).toEqual({ mode: "at", query: "", tokenStart: 0, caret: 1 })
  })
  test("mid-text '@ge' after whitespace triggers with query", () => {
    const v = detectTrigger("ask @ge", 7)
    expect(v).toEqual({ mode: "at", query: "ge", tokenStart: 4, caret: 7 })
  })
  test("email-like text does NOT trigger (no word boundary)", () => {
    expect(detectTrigger("mail me a@b.com", 15)).toBeNull()
  })
  test("caret inside an earlier word does not see a later @", () => {
    expect(detectTrigger("hello @x", 4)).toBeNull()
  })
  test("token ends at whitespace — caret after a completed mention does not re-trigger", () => {
    expect(detectTrigger("ask @general ", 13)).toBeNull()
  })
})

describe("triggerSignature / dismissal identity", () => {
  test("same token → same signature; typing changes it", () => {
    const t1 = "/re"
    const v1 = detectTrigger(t1, 3)!
    const t2 = "/rev"
    const v2 = detectTrigger(t2, 4)!
    expect(triggerSignature(v1, t1)).not.toBe(triggerSignature(v2, t2))
    expect(triggerSignature(v1, t1)).toBe(triggerSignature(detectTrigger(t1, 3)!, t1))
  })
})

describe("applyMention", () => {
  test("replaces the @token and appends a space, caret lands after it", () => {
    const v = detectTrigger("ask @ge to check", 7)! // token [4,7)
    const r = applyMention("ask @ge to check", v, "@general")
    expect(r.text).toBe("ask @general  to check")
    expect(r.caret).toBe(4 + "@general".length + 1)
  })
})

describe("buildMentionParts", () => {
  const ws = "/Users/me/proj"
  test("agent part carries source offsets (upstream shape)", () => {
    const mentions: MentionPart[] = [{ type: "agent", name: "general", content: "@general" }]
    const parts = buildMentionParts("do it @general now", ws, mentions) as any[]
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({
      type: "agent",
      name: "general",
      source: { value: "@general", start: 6, end: 14 },
    })
  })
  test("file part gets an absolute file:// url + filename", () => {
    const mentions: MentionPart[] = [{ type: "file", path: "src/a b.ts", content: "@src/a b.ts" }]
    const parts = buildMentionParts("see @src/a b.ts", ws, mentions) as any[]
    expect(parts[0].type).toBe("file")
    expect(parts[0].url).toBe("file:///Users/me/proj/src/a%20b.ts")
    expect(parts[0].filename).toBe("a b.ts")
    expect(parts[0].mime).toBe("text/plain")
  })
  test("path with # / ? is fully encoded (per-segment, not encodeURI)", () => {
    const mentions: MentionPart[] = [{ type: "file", path: "docs/a#b?c.md", content: "@docs/a#b?c.md" }]
    const parts = buildMentionParts("see @docs/a#b?c.md", ws, mentions) as any[]
    expect(parts[0].url).toBe("file:///Users/me/proj/docs/a%23b%3Fc.md")
  })
  test("mention edited out of the text sends NO part", () => {
    const mentions: MentionPart[] = [{ type: "agent", name: "general", content: "@general" }]
    expect(buildMentionParts("do it yourself", ws, mentions)).toHaveLength(0)
  })
})
