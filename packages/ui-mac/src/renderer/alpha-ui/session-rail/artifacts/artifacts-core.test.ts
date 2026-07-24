import { describe, expect, test } from "bun:test"
import type { ArtifactCard } from "../../artifact-workbench/workbench-core"
import { artifactsIdentityKeyOf, artifactsPhaseOf, findArtifactCard } from "./artifacts-core"

function card(input: Partial<ArtifactCard> & { key: string }): ArtifactCard {
  return { name: input.key, state: "verified", bytes: 1, warnings: [], downloadable: false, ...input }
}

describe("REQ-125 C4 artifacts phase (fail-closed)", () => {
  test("nothing proven readable renders as loading, failures as error", () => {
    expect(artifactsPhaseOf({ usage: undefined, runId: undefined, list: undefined, cardCount: 0 })).toBe("loading")
    expect(artifactsPhaseOf({ usage: { ok: false }, runId: undefined, list: undefined, cardCount: 0 })).toBe("error")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: undefined, cardCount: 0 })).toBe("loading")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: { ok: false }, cardCount: 0 })).toBe("error")
  })

  test("no runs or no cards is an honest empty; cards otherwise", () => {
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: undefined, list: undefined, cardCount: 0 })).toBe("empty")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: { ok: true }, cardCount: 0 })).toBe("empty")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: { ok: true }, cardCount: 2 })).toBe("cards")
  })
})

describe("REQ-125 C4 focus-target resolution", () => {
  const cards = [
    card({ key: "art-1", descriptor: { id: "art-1" } as never }),
    card({ key: "legacy:report.md" }),
  ]

  test("matches by descriptor id first, card key as fallback, nothing on unknown ids", () => {
    expect(findArtifactCard(cards, "art-1")?.key).toBe("art-1")
    expect(findArtifactCard(cards, "legacy:report.md")?.key).toBe("legacy:report.md")
    expect(findArtifactCard(cards, "art-unknown")).toBeUndefined()
    expect(findArtifactCard([], "art-1")).toBeUndefined()
  })
})

describe("REQ-125 C4 identity key (I8)", () => {
  test("binds the full triple and distinguishes every component", () => {
    const identity = { serverKey: "s", directory: "/d", sessionID: "x" }
    const key = artifactsIdentityKeyOf(identity)!
    expect(artifactsIdentityKeyOf(undefined)).toBeUndefined()
    expect(artifactsIdentityKeyOf({ ...identity })).toBe(key)
    expect(artifactsIdentityKeyOf({ ...identity, serverKey: "s2" })).not.toBe(key)
    expect(artifactsIdentityKeyOf({ ...identity, directory: "/d2" })).not.toBe(key)
    expect(artifactsIdentityKeyOf({ ...identity, sessionID: "y" })).not.toBe(key)
  })
})
