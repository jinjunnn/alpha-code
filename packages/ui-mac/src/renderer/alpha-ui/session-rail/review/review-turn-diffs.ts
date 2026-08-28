// REQ-142 — turn-level diff projection over the synced message store.
//
// The engine persists each turn's file changes into that turn's *user* message
// (`SessionSummary.summarize` → `info.summary.diffs`, forked from the prompt
// loop at step 1 and again at step finish), and the renderer receives it
// through the ordinary message sync channel (`message.updated` →
// `session.data.message[sessionID]`). This module projects "the latest turn's
// changes" out of that store; it deliberately has zero dependencies so the
// engine-side supply-chain test (packages/opencode/test/session/alpha-*) can
// consume the exact same entry point the UI uses.
//
// Semantics (AC1/AC4):
// - `undefined` messages  → `undefined` (store not loaded yet → loading state)
// - no user message       → `[]` (nothing happened yet → clean state)
// - latest user message   → its `summary.diffs` when it is an array, else `[]`
//   (a fresh turn that changed nothing must clear the previous turn's cards —
//   never aggregate across turns).
// Every field access is fail-closed narrowing: malformed store content
// degrades to the clean empty state, it never throws into the view.

/** Project the latest turn's diff records out of a session's synced messages. */
export function turnDiffsOf(messages: readonly unknown[] | undefined): readonly unknown[] | undefined {
  if (messages === undefined) return undefined
  let last: { summary?: unknown } | undefined
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue
    const record = message as { role?: unknown; summary?: unknown }
    if (record.role !== "user") continue
    last = record
  }
  if (!last) return []
  const summary = last.summary
  if (typeof summary !== "object" || summary === null) return []
  const diffs = (summary as { diffs?: unknown }).diffs
  return Array.isArray(diffs) ? diffs : []
}
