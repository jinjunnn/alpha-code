// REQ-125 C2 — pure model for the right-rail review panel.
//
// Data enters through the typed `useServerSync` channel as SDK `SnapshotFileDiff`
// records; this module narrows them at the consumption point (I2), turns the
// server-computed unified patch into a bounded presentation model (I7: context
// collapses into folds, reveals are chunked), and stays free of any DOM or
// upstream session component (I1). The diff itself is never recomputed here —
// the server's patch is the single source, parsed with the jsdiff engine.
import { parsePatch } from "diff"
import type { AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"

export type ReviewFileKind = "added" | "modified" | "deleted"

export interface ReviewFileChange {
  file: string
  dir: string
  name: string
  kind: ReviewFileKind
  additions: number
  deletions: number
  patch?: string
}

export interface ReviewLine {
  kind: "context" | "add" | "del"
  oldLine?: number
  newLine?: number
  text: string
}

export type ReviewSegment =
  // A run of unchanged lines, collapsed by default. `lines` carries the run when
  // the patch includes it (full-context snapshot patches); an inter-hunk gap of a
  // partial-context patch has `lines: []` and stays a non-expandable bar.
  | { type: "fold"; count: number; lines: ReviewLine[] }
  // A contiguous run of added/deleted lines ("改动块"), navigable via the hunk bar.
  | { type: "block"; index: number; lines: ReviewLine[] }

export interface ReviewFileDiff {
  segments: ReviewSegment[]
  blockCount: number
}

export interface ReviewSplitRow {
  left?: ReviewLine
  right?: ReviewLine
}

/** How many folded lines a single click reveals (I7: chunked, never unbounded). */
export const REVIEW_FOLD_CHUNK = 400

const KINDS: Record<string, ReviewFileKind> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
}

export function splitReviewPath(file: string): { dir: string; name: string } {
  const at = file.lastIndexOf("/")
  if (at < 0) return { dir: "", name: file }
  return { dir: file.slice(0, at + 1), name: file.slice(at + 1) }
}

/** Narrow one SDK diff record at the consumption point; drop malformed entries (fail-closed). */
export function reviewFileChangeOf(input: {
  file?: string
  patch?: string
  additions?: number
  deletions?: number
  status?: string
}): ReviewFileChange | undefined {
  if (typeof input.file !== "string" || input.file.length === 0) return undefined
  if (input.patch !== undefined && typeof input.patch !== "string") return undefined
  const additions = typeof input.additions === "number" && Number.isFinite(input.additions) ? input.additions : 0
  const deletions = typeof input.deletions === "number" && Number.isFinite(input.deletions) ? input.deletions : 0
  const { dir, name } = splitReviewPath(input.file)
  return {
    file: input.file,
    dir,
    name,
    kind: KINDS[input.status ?? ""] ?? "modified",
    additions: Math.max(0, Math.floor(additions)),
    deletions: Math.max(0, Math.floor(deletions)),
    patch: input.patch,
  }
}

export function reviewTotals(changes: readonly ReviewFileChange[]): {
  files: number
  additions: number
  deletions: number
} {
  return changes.reduce(
    (sum, change) => ({
      files: sum.files + 1,
      additions: sum.additions + change.additions,
      deletions: sum.deletions + change.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}

/**
 * Parse a server-computed unified patch into fold/block segments.
 * Returns undefined when the patch cannot be parsed (binary or malformed);
 * the panel then renders a bounded "no text diff" notice instead of guessing.
 */
export function parseReviewPatch(patch: string): ReviewFileDiff | undefined {
  let parsed
  try {
    parsed = parsePatch(patch)[0]
  } catch {
    return undefined
  }
  if (!parsed || parsed.hunks.length === 0) return undefined

  const segments: ReviewSegment[] = []
  let blockCount = 0
  let contextRun: ReviewLine[] = []
  let changeRun: ReviewLine[] = []

  const flushContext = () => {
    if (contextRun.length === 0) return
    segments.push({ type: "fold", count: contextRun.length, lines: contextRun })
    contextRun = []
  }
  const flushChange = () => {
    if (changeRun.length === 0) return
    segments.push({ type: "block", index: blockCount, lines: changeRun })
    blockCount += 1
    changeRun = []
  }

  let previousEndOld: number | undefined
  for (const hunk of parsed.hunks) {
    const gapStart = previousEndOld ?? 1
    const gap = hunk.oldStart - gapStart
    if (gap > 0) {
      flushChange()
      segments.push({ type: "fold", count: gap, lines: [] })
    }
    previousEndOld = hunk.oldStart + hunk.oldLines

    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const raw of hunk.lines) {
      const sign = raw.charAt(0)
      const text = raw.slice(1)
      if (sign === "+") {
        flushContext()
        changeRun.push({ kind: "add", newLine, text })
        newLine += 1
        continue
      }
      if (sign === "-") {
        flushContext()
        changeRun.push({ kind: "del", oldLine, text })
        oldLine += 1
        continue
      }
      if (sign === "\\") continue // "\ No newline at end of file" marker
      flushChange()
      contextRun.push({ kind: "context", oldLine, newLine, text })
      oldLine += 1
      newLine += 1
    }
  }
  flushContext()
  flushChange()

  return { segments, blockCount }
}

/** Chunked fold reveal: how many lines are visible after `clicks` reveals. */
export function foldRevealCount(total: number, clicks: number): number {
  if (clicks <= 0) return 0
  return Math.min(total, clicks * REVIEW_FOLD_CHUNK)
}

/** Pair a change block's lines into split-view rows: deletions left, additions right. */
export function splitRowsOf(lines: readonly ReviewLine[]): ReviewSplitRow[] {
  const dels = lines.filter((line) => line.kind === "del")
  const adds = lines.filter((line) => line.kind === "add")
  const rows: ReviewSplitRow[] = []
  for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
    rows.push({ left: dels[i], right: adds[i] })
  }
  return rows
}

/** Below this panel width the split view falls back to unified (approved design rule). */
export const REVIEW_SPLIT_MIN_WIDTH = 360

export type ReviewDiffView = "unified" | "split"

export function effectiveDiffView(selected: ReviewDiffView, width: number | undefined): ReviewDiffView {
  if (selected === "split" && width !== undefined && width < REVIEW_SPLIT_MIN_WIDTH) return "unified"
  return selected
}

export type ReviewPhase = "loading" | "no-vcs" | "clean" | "changes"

export function reviewPhaseOf(input: {
  ready: boolean
  vcs: string | undefined
  diffs: readonly unknown[] | undefined
}): ReviewPhase {
  if (!input.ready) return "loading"
  if (input.vcs === undefined) return "no-vcs"
  if (input.diffs === undefined) return "loading"
  if (input.diffs.length === 0) return "clean"
  return "changes"
}

/** Resolve the session directory's project VCS from the typed global project list. */
export function projectVcsFor(
  projects: readonly { worktree: string; vcs?: string }[],
  directory: string,
): string | undefined {
  let best: { worktree: string; vcs?: string } | undefined
  for (const project of projects) {
    const worktree = project.worktree.replace(/\/+$/, "")
    if (worktree.length === 0) continue
    if (directory !== worktree && !directory.startsWith(`${worktree}/`)) continue
    if (!best || worktree.length > best.worktree.replace(/\/+$/, "").length) best = project
  }
  return best?.vcs
}

/** Stable key for I8 view-state resets: any identity change discards panel-local state. */
export function reviewIdentityKeyOf(identity: AlphaSessionIdentity | undefined): string {
  if (!identity) return ""
  return [identity.serverKey, identity.directory, identity.sessionID].join("\u0000")
}
