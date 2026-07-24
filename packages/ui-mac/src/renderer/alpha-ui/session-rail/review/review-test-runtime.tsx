// REQ-125 C2 — harness runtime for the review panel component cases.
// Mounts the presentational view with fixture data; the typed data container
// (`SessionRailReviewPanel`) is exercised through its pure pieces in
// review-core.test.ts and stays out of the DOM harness.
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { REVIEW_PATCH_MAX_LENGTH, reviewFileChangeOf, type ReviewFileChange, type ReviewPhase } from "./review-core"
import { SessionRailReviewPanelView, type ReviewLineCommentIntent } from "./review-panel-view"

const MODIFIED_PATCH = [
  "--- alpha-ui/button.css",
  "+++ alpha-ui/button.css",
  "@@ -1,9 +1,9 @@",
  " ctx1",
  " ctx2",
  " ctx3",
  "-.a-btn:focus { outline: none; }",
  "+.a-btn:focus-visible {",
  "+  box-shadow: var(--a-ring-focus);",
  " mid1",
  " mid2",
  "-gone",
  " tail1",
  " tail2",
  "",
].join("\n")

const ADDED_PATCH = ["--- 架构说明.md", "+++ 架构说明.md", "@@ -0,0 +1,2 @@", "+# 架构", "+说明正文", ""].join("\n")

const DELETED_PATCH = [
  "--- alpha-ui/legacy-focus.css",
  "+++ alpha-ui/legacy-focus.css",
  "@@ -1,2 +0,0 @@",
  "-.legacy { outline: none; }",
  "-.legacy:hover { }",
  "",
].join("\n")

function bigFoldPatch(): string {
  const context = Array.from({ length: 450 }, (_, i) => ` line ${i + 1}`)
  return ["--- big.txt", "+++ big.txt", "@@ -1,451 +1,451 @@", ...context, "-old end", "+new end", ""].join("\n")
}

export function defaultReviewChanges(): ReviewFileChange[] {
  return [
    reviewFileChangeOf({ file: "alpha-ui/button.css", additions: 8, deletions: 2, status: "modified", patch: MODIFIED_PATCH })!,
    reviewFileChangeOf({ file: "架构说明.md", additions: 96, deletions: 0, status: "added", patch: ADDED_PATCH })!,
    reviewFileChangeOf({ file: "alpha-ui/legacy-focus.css", additions: 0, deletions: 19, status: "deleted", patch: DELETED_PATCH })!,
  ]
}

export function bigFoldReviewChange(): ReviewFileChange {
  return reviewFileChangeOf({ file: "big.txt", additions: 1, deletions: 1, status: "modified", patch: bigFoldPatch() })!
}

/** Patch text beyond the hard pre-parse limit — must never reach the parser. */
export function oversizedReviewChange(): ReviewFileChange {
  return reviewFileChangeOf({
    file: "huge.bin.txt",
    additions: 9000,
    deletions: 4000,
    status: "modified",
    patch: "x".repeat(REVIEW_PATCH_MAX_LENGTH + 1),
  })!
}

/** File names that collide with Object.prototype members must behave like any other. */
export function prototypeNamedReviewChanges(): ReviewFileChange[] {
  const patchFor = (file: string) =>
    [`--- ${file}`, `+++ ${file}`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n")
  return [
    reviewFileChangeOf({ file: "__proto__", additions: 1, deletions: 1, status: "modified", patch: patchFor("__proto__") })!,
    reviewFileChangeOf({ file: "constructor", additions: 1, deletions: 1, status: "modified", patch: patchFor("constructor") })!,
  ]
}

const [phase, setPhase] = createSignal<ReviewPhase>("changes")
const [changes, setChanges] = createSignal<ReviewFileChange[]>(defaultReviewChanges())
const [resetKey, setResetKey] = createSignal("identity-a")
const [focusTarget, setFocusTarget] = createSignal<{ file: string } | undefined>(undefined)
const commentLog: ReviewLineCommentIntent[] = []

export { render }

export function ReviewPanelHarness() {
  return (
    <SessionRailReviewPanelView
      phase={phase()}
      changes={changes()}
      resetKey={resetKey()}
      onLineComment={(intent) => commentLog.push(intent)}
      focusTarget={focusTarget()}
    />
  )
}

/** Files→review linkage: mint a fresh target object (same-file re-jumps retrigger). */
export function setReviewFocusTarget(file: string | undefined) {
  setFocusTarget(file === undefined ? undefined : { file })
}

export function setReviewPhase(next: ReviewPhase) {
  setPhase(next)
}

export function setReviewChanges(next: ReviewFileChange[]) {
  setChanges(next)
}

export function setReviewResetKey(next: string) {
  setResetKey(next)
}

export function reviewCommentLog(): readonly ReviewLineCommentIntent[] {
  return commentLog
}

export function resetReviewHarness() {
  setPhase("changes")
  setChanges(defaultReviewChanges())
  setResetKey("identity-a")
  setFocusTarget(undefined)
  commentLog.length = 0
}
