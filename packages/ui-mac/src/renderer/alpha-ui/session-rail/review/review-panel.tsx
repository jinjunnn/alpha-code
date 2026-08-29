// REQ-125 C2 / REQ-142 — right-rail review panel, typed data container.
//
// Reads the latest turn's diff records by projecting the synced message store
// (`turnDiffsOf`: the engine persists each turn's changes into that turn's
// user message, REQ-142) keyed by the C1 live identity, and triggers the
// idempotent message sync. All async results stay inside the upstream keyed
// store — the panel keeps no local copy, so a session switch can never surface
// another session's diff (I8). Form and interaction live in
// `review-panel-view.tsx` (I1: alpha-owned, layout-free of upstream session
// components).
import { useServerSync } from "@opencode-ai/app"
import { createEffect, createMemo, untrack } from "solid-js"
import type { AlphaSessionLiveContext, SessionRailApi } from "../../session-workspace/session-workspace-shell"
import { projectVcsFor, reviewFileChangeOf, reviewIdentityKeyOf, reviewPhaseOf } from "./review-core"
import { turnDiffsOf } from "./review-turn-diffs"
import { SessionRailReviewPanelView, type ReviewLineCommentIntent } from "./review-panel-view"

export function SessionRailReviewPanel(props: {
  live: AlphaSessionLiveContext
  /** Rail linkage api: `reviewTarget` (identity-gated in the shell) opens + focuses a file card;
   *  `openFileViewer` (REQ-108) hands a file to the files-panel viewer. */
  rail?: Pick<SessionRailApi, "reviewTarget" | "openFileViewer">
  onLineComment?: (intent: ReviewLineCommentIntent) => void
}) {
  const serverSync = useServerSync()
  const identity = () => props.live.current()?.identity

  const changes = createMemo(() => {
    const id = identity()
    if (!id) return undefined
    return turnDiffsOf(serverSync().session.data.message[id.sessionID])
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

  // Idempotent initial load: sync the session's messages into the upstream
  // store keyed by sessionID (no panel-local async state); live
  // `message.updated` events keep the projection fresh afterwards.
  createEffect(() => {
    const id = identity()
    if (!id) return
    if (!serverSync().ready) return
    if (!props.live.accepts(id)) return
    if (untrack(() => serverSync().session.data.message[id.sessionID] !== undefined)) return
    void serverSync().session.sync(id.sessionID)
  })

  return (
    <SessionRailReviewPanelView
      phase={phase()}
      changes={rows()}
      resetKey={reviewIdentityKeyOf(identity())}
      onLineComment={props.onLineComment}
      focusTarget={props.rail?.reviewTarget()}
      onOpenFile={props.rail?.openFileViewer ? (file) => props.rail!.openFileViewer!(file) : undefined}
    />
  )
}
