// REQ-125 C4 — pure model for the right-rail artifacts host.
//
// The panel embeds the approved artifact-workbench language verbatim (I5); this module only
// owns the rail-specific decisions: honest phase derivation, focus-target matching for the
// timeline linkage mount point, and the I8 identity key. Card derivation stays in
// workbench-core (REQ-093/094 truth), untouched.
import type { ArtifactCard } from "../../artifact-workbench/workbench-core"
import type { AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"

export type ArtifactsPhase = "loading" | "error" | "empty" | "cards"

/**
 * Honest panel phase from the two read channels. Fail-closed: anything not proven readable
 * renders as loading/error, never as an optimistic empty.
 */
export function artifactsPhaseOf(input: {
  usage: { ok: boolean } | undefined
  runId: string | undefined
  list: { ok: boolean } | undefined
  cardCount: number
}): ArtifactsPhase {
  if (input.usage === undefined) return "loading"
  if (!input.usage.ok) return "error"
  if (input.runId === undefined) return "empty"
  if (input.list === undefined) return "loading"
  if (!input.list.ok) return "error"
  return input.cardCount === 0 ? "empty" : "cards"
}

/**
 * Resolve a timeline focus target to a card: manifest artifact id first (the linkage
 * contract's identity), card key as fallback (covers legacy keys). Unknown ids resolve to
 * nothing — the panel keeps its current selection instead of guessing.
 */
export function findArtifactCard(cards: readonly ArtifactCard[], artifactId: string): ArtifactCard | undefined {
  return (
    cards.find((card) => card.descriptor?.id === artifactId) ?? cards.find((card) => card.key === artifactId)
  )
}

/** Stable key for I8 remounts: any identity change rebuilds the panel from scratch. */
export function artifactsIdentityKeyOf(identity: AlphaSessionIdentity | undefined): string | undefined {
  if (!identity) return undefined
  return [identity.serverKey, identity.directory, identity.sessionID].join("\u0000")
}
