// REQ-125 C2 — harness runtime for the data container (`SessionRailReviewPanel`).
// The cases file mocks "@opencode-ai/app" with review-fake-sync BEFORE importing
// this module, so the real container code runs end-to-end against a
// controllable typed channel: real load trigger, real keyed-store reads, real
// identity binding (I8) — behavior, not source-string, assertions.
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { sameSessionIdentity, type AlphaSessionLiveSnapshot } from "../../session-workspace/session-workspace-core"
import type { AlphaSessionLiveContext } from "../../session-workspace/session-workspace-shell"
import { SessionRailReviewPanel } from "./review-panel"
import type { ReviewLineCommentIntent } from "./review-panel-view"

export function containerSnapshotFor(sessionID: string): AlphaSessionLiveSnapshot {
  return {
    identity: { serverKey: "sidecar", directory: "/tmp/workspace", sessionID },
    project: "workspace",
    title: "整理架构说明",
    activity: "idle",
  }
}

/** A well-formed SDK-shaped diff record whose patch header matches its file. */
export function containerDiffFixture() {
  return {
    file: "alpha-ui/button.css",
    additions: 1,
    deletions: 1,
    status: "modified",
    patch: [
      "--- alpha-ui/button.css",
      "+++ alpha-ui/button.css",
      "@@ -1,1 +1,1 @@",
      "-.a-btn:focus { outline: none; }",
      "+.a-btn:focus-visible { box-shadow: var(--a-ring-focus); }",
      "",
    ].join("\n"),
  }
}

const [snapshot, setSnapshot] = createSignal<AlphaSessionLiveSnapshot | undefined>(containerSnapshotFor("ses_a"))
const intents: ReviewLineCommentIntent[] = []

export { render }

export function ReviewContainerHarness() {
  const live: AlphaSessionLiveContext = {
    current: snapshot,
    accepts: (identity) => sameSessionIdentity(identity, snapshot()?.identity),
  }
  return <SessionRailReviewPanel live={live} onLineComment={(intent) => intents.push(intent)} />
}

export function setContainerSession(sessionID: string) {
  setSnapshot(containerSnapshotFor(sessionID))
}

export function containerIntents(): readonly ReviewLineCommentIntent[] {
  return intents
}

export function resetContainerHarness() {
  setSnapshot(containerSnapshotFor("ses_a"))
  intents.length = 0
}
