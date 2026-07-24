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
export function reviewFileChangeOf(input: unknown): ReviewFileChange | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as { file?: unknown; patch?: unknown; additions?: unknown; deletions?: unknown; status?: unknown }
  if (typeof record.file !== "string" || record.file.length === 0) return undefined
  if (record.patch !== undefined && typeof record.patch !== "string") return undefined
  const additions = typeof record.additions === "number" && Number.isFinite(record.additions) ? record.additions : 0
  const deletions = typeof record.deletions === "number" && Number.isFinite(record.deletions) ? record.deletions : 0
  const status = typeof record.status === "string" ? record.status : ""
  const { dir, name } = splitReviewPath(record.file)
  return {
    file: record.file,
    dir,
    name,
    kind: KINDS[status] ?? "modified",
    additions: Math.max(0, Math.floor(additions)),
    deletions: Math.max(0, Math.floor(deletions)),
    patch: record.patch,
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
 * Hard pre-parse limits (I6/I7): a patch beyond either bound never reaches the
 * parser — the panel shows a bounded "too large" placeholder instead. The
 * length cap is in UTF-16 code units, a lower bound on the byte size, so the
 * byte cost is bounded within 2x of it.
 */
export const REVIEW_PATCH_MAX_LENGTH = 1_500_000
export const REVIEW_PATCH_MAX_LINES = 20_000

export function reviewPatchOversized(patch: string): boolean {
  if (patch.length > REVIEW_PATCH_MAX_LENGTH) return true
  let lines = 1
  for (let i = 0; i < patch.length; i += 1) {
    if (patch.charCodeAt(i) === 10) {
      lines += 1
      if (lines > REVIEW_PATCH_MAX_LINES) return true
    }
  }
  return false
}

/** A present patch file name matches only /dev/null or the expected path (± git a/ b/ prefix). */
function patchNameMatches(name: string | undefined, expected: string): boolean {
  if (!name) return true // absence is handled fail-closed by the both-missing check
  if (name === "/dev/null") return true
  return name === expected || name === `a/${expected}` || name === `b/${expected}`
}

/**
 * Parse a server-computed unified patch into fold/block segments.
 * Returns undefined when the patch cannot be parsed or fails a fail-closed
 * check (oversized, binary, malformed, multiple patch files, or a file name
 * that contradicts `expectedFile`); the panel then renders a bounded notice
 * instead of guessing.
 */
export function parseReviewPatch(patch: string, expectedFile?: string): ReviewFileDiff | undefined {
  if (reviewPatchOversized(patch)) return undefined
  let files
  try {
    files = parsePatch(patch)
  } catch {
    return undefined
  }
  // Exactly one patched file per SnapshotFileDiff record; anything else is rejected.
  if (files.length !== 1) return undefined
  const parsed = files[0]
  if (!parsed || parsed.hunks.length === 0) return undefined
  if (expectedFile !== undefined) {
    // Fail-closed: a patch with no file header on either side carries no
    // evidence for the record's file and could bind to any card — reject.
    if (!parsed.oldFileName && !parsed.newFileName) return undefined
    if (!patchNameMatches(parsed.oldFileName, expectedFile) || !patchNameMatches(parsed.newFileName, expectedFile)) {
      return undefined
    }
  }

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
