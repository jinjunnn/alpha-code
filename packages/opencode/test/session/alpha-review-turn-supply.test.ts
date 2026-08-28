// REQ-142 AC2 — the alpha review surface's data entry is fed by the PRODUCTION
// engine supply chain, not by fixtures.
//
// Chain under test: real git snapshots (`Snapshot.track`) → production
// `SessionSummary.summarize` persists the turn's diffs onto the turn's user
// message → production `SessionSummary.diff` (the same call the HTTP endpoint
// delegates to) → the alpha renderer projection `turnDiffsOf` — the exact
// module the review panel / files badges / tab count consume — receives a
// non-empty change set. Fixtures appear only at the storage byte layer
// (`session.updateMessage` / `updatePart`), which AC2 explicitly allows.
//
// Mutation drill (part of the AC evidence, run at PR time): deleting the
// `summary.summarize(...)` call below turns this test red — the assertions
// depend on the engine really computing and persisting the diffs.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
// The alpha review surface's data entry point (dependency-free renderer module).
import { turnDiffsOf } from "../../../ui-mac/src/renderer/alpha-ui/session-rail/review/review-turn-diffs"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionSummary.node,
      Snapshot.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const user = Effect.fn("alphaReviewSupply.user")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("alphaReviewSupply.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  dir: string,
) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: ModelV2.ID.make("gpt-4"),
    providerID: ProviderV2.ID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

/** A real turn: snapshot → optional edit → snapshot, recorded as step parts. */
const turn = Effect.fn("alphaReviewSupply.turn")(function* (
  sessionID: SessionID,
  dir: string,
  edit?: () => Promise<void>,
) {
  const session = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const u = yield* user(sessionID)
  const a = yield* assistant(sessionID, u.id, dir)
  const before = yield* snapshot.track()
  if (!before) throw new Error("expected snapshot")
  if (edit) yield* Effect.promise(edit)
  const after = yield* snapshot.track()
  if (!after) throw new Error("expected snapshot")
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: a.id,
    sessionID,
    type: "step-start",
    snapshot: before,
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: a.id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: after,
    cost: 0,
    tokens,
  })
  return u
})

describe("REQ-142 AC2: production summary supply chain feeds the alpha review entry", () => {
  it.live(
    "summarize+diff on a real turn reach turnDiffsOf non-empty; known-empty arms stay empty",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const summary = yield* SessionSummary.Service

          yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.txt"), "line1\n"))
          const info = yield* session.create({})
          const sid = info.id

          // — turn 1: the assistant edits a.txt between two real git snapshots —
          const u1 = yield* turn(sid, dir, () => fs.writeFile(path.join(dir, "a.txt"), "line1\nline2-changed\n"))

          // PRODUCTION supply chain: summarize computes the diffs and persists
          // them onto the turn's user message.
          yield* summary.summarize({ sessionID: sid, messageID: u1.id })

          // PRODUCTION read the HTTP endpoint delegates to.
          const diffs = yield* summary.diff({ sessionID: sid, messageID: u1.id })
          expect(diffs.length).toBeGreaterThan(0)

          // ALPHA DATA ENTRY: the renderer projection over the synced messages —
          // the exact module the review panel / badges / tab count consume.
          const messages = yield* session.messages({ sessionID: sid })
          const projected = turnDiffsOf(messages.map((m) => m.info))
          expect(projected).toBeDefined()
          expect(projected!.length).toBeGreaterThan(0)
          const entry = projected!.find(
            (item) => typeof item === "object" && item !== null && (item as { file?: unknown }).file === "a.txt",
          ) as { additions?: number; deletions?: number; status?: string } | undefined
          expect(entry).toBeDefined()
          expect(entry!.additions).toBeGreaterThan(0)
          expect(entry!.status).toBe("modified")

          // — known-empty arm 1: no messageID (the pre-REQ-142 dead channel) —
          const noMessage = yield* summary.diff({ sessionID: sid })
          expect(noMessage.length).toBe(0)

          // — known-empty arm 2: a fresh turn that changed nothing must project
          //   empty (AC4: no residue from turn 1) —
          const u2 = yield* turn(sid, dir)
          yield* summary.summarize({ sessionID: sid, messageID: u2.id })
          const after = yield* session.messages({ sessionID: sid })
          const projectedEmpty = turnDiffsOf(after.map((m) => m.info))
          expect(projectedEmpty).toBeDefined()
          expect(projectedEmpty!.length).toBe(0)
        }),
      { git: true },
    ),
  )
})
