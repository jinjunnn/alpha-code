// REQ-125 C2 — right-rail review panel, typed data container.
//
// Reads the session's diff records from the typed `useServerSync` channel keyed
// by the C1 live identity, and triggers the idempotent SDK-side load. All async
// results stay inside the upstream keyed store — the panel keeps no local copy,
// so a session switch can never surface another session's diff (I8). Form and
// interaction live in `review-panel-view.tsx` (I1: alpha-owned, layout-free of
// upstream session components).
import { useServerSync } from "@opencode-ai/app"
import { createEffect, createMemo, untrack } from "solid-js"
import type { AlphaSessionLiveContext } from "../../session-workspace/session-workspace-shell"
import { projectVcsFor, reviewFileChangeOf, reviewIdentityKeyOf, reviewPhaseOf } from "./review-core"
import { SessionRailReviewPanelView, type ReviewLineCommentIntent } from "./review-panel-view"

export function SessionRailReviewPanel(props: {
  live: AlphaSessionLiveContext
  onLineComment?: (intent: ReviewLineCommentIntent) => void
}) {
  const serverSync = useServerSync()
  const identity = () => props.live.current()?.identity

  const changes = createMemo(() => {
    const id = identity()
    if (!id) return undefined
    return serverSync().session.data.session_diff[id.sessionID]
  })
  // Fail-closed narrowing of the channel payload: a non-array or malformed
  // record never reaches the view (it degrades to the clean empty state).
  const rows = createMemo(() => {
    const list = changes()
    if (!Array.isArray(list)) return []
    return list.flatMap((diff) => {
      const row = reviewFileChangeOf(diff)
      return row ? [row] : []
    })
  })
  const phase = createMemo(() => {
    const id = identity()
    if (!id) return "loading" as const
    return reviewPhaseOf({
      ready: serverSync().ready,
      vcs: projectVcsFor(serverSync().data.project, id.directory),
      // Emptiness is judged on the narrowed rows; only a missing channel value
      // means "still loading".
      diffs: changes() === undefined ? undefined : rows(),
    })
  })

  // Idempotent initial load: the result lands in the upstream store keyed by
  // sessionID (no panel-local async state); live `session.diff` events keep it fresh.
  createEffect(() => {
    const id = identity()
    if (!id) return
    if (!serverSync().ready) return
    if (!props.live.accepts(id)) return
    if (untrack(() => serverSync().session.data.session_diff[id.sessionID] !== undefined)) return
    void serverSync().session.diff(id.sessionID)
  })

  return (
    <SessionRailReviewPanelView
      phase={phase()}
      changes={rows()}
      resetKey={reviewIdentityKeyOf(identity())}
      onLineComment={props.onLineComment}
    />
  )
}
