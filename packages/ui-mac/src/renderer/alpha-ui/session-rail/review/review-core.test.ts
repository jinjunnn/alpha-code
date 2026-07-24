import { describe, expect, test } from "bun:test"
import {
  effectiveDiffView,
  foldRevealCount,
  parseReviewPatch,
  projectVcsFor,
  REVIEW_FOLD_CHUNK,
  REVIEW_PATCH_MAX_LENGTH,
  REVIEW_PATCH_MAX_LINES,
  reviewFileChangeOf,
  reviewIdentityKeyOf,
  reviewPatchOversized,
  reviewPhaseOf,
  reviewTotals,
  splitReviewPath,
  splitRowsOf,
} from "./review-core"

const FULL_CONTEXT_PATCH = [
  "--- alpha-ui/button.css",
  "+++ alpha-ui/button.css",
  "@@ -1,9 +1,9 @@",
  " ctx1",
  " ctx2",
  " ctx3",
  "-old line",
  "+new line A",
  "+new line B",
  " mid1",
  " mid2",
  "-gone",
  " tail1",
  " tail2",
  "",
].join("\n")

const GAPPED_PATCH = [
  "--- f",
  "+++ f",
  "@@ -5,3 +5,3 @@",
  " c1",
  "-a",
  "+b",
  " c2",
  "@@ -20,3 +21,3 @@",
  " d1",
  "-x",
  "+y",
  " d2",
  "",
].join("\n")

describe("REQ-125 C2 review file rows", () => {
  test("narrows SDK records at the consumption point and drops malformed entries", () => {
    expect(reviewFileChangeOf({})).toBeUndefined()
    expect(reviewFileChangeOf({ file: "" })).toBeUndefined()

    const row = reviewFileChangeOf({ file: "alpha-ui/button.css", additions: 8, deletions: 2, status: "modified" })
    expect(row).toEqual({
      file: "alpha-ui/button.css",
      dir: "alpha-ui/",
      name: "button.css",
      kind: "modified",
      additions: 8,
      deletions: 2,
      patch: undefined,
    })

    // Unknown status falls back to "modified"; counts are clamped to sane integers.
    expect(reviewFileChangeOf({ file: "x", status: "renamed", additions: -3, deletions: Number.NaN })?.kind).toBe(
      "modified",
    )
    expect(reviewFileChangeOf({ file: "x", additions: -3 })?.additions).toBe(0)
  })

  test("splits the path into a weakened dir prefix and file name", () => {
    expect(splitReviewPath("alpha-ui/button.css")).toEqual({ dir: "alpha-ui/", name: "button.css" })
    expect(splitReviewPath("架构说明.md")).toEqual({ dir: "", name: "架构说明.md" })
    expect(splitReviewPath("a/b/c.ts")).toEqual({ dir: "a/b/", name: "c.ts" })
  })

  test("totals aggregate files, additions and deletions", () => {
    const rows = [
      reviewFileChangeOf({ file: "a", additions: 8, deletions: 2 })!,
      reviewFileChangeOf({ file: "b", additions: 96, deletions: 0 })!,
      reviewFileChangeOf({ file: "c", additions: 0, deletions: 19 })!,
    ]
    expect(reviewTotals(rows)).toEqual({ files: 3, additions: 104, deletions: 21 })
  })
})

describe("REQ-125 C2 patch parsing (server patch is the single diff source)", () => {
  test("full-context patch folds every unchanged run and numbers both sides", () => {
    const parsed = parseReviewPatch(FULL_CONTEXT_PATCH)!
    expect(parsed.blockCount).toBe(2)
    expect(parsed.segments.map((segment) => segment.type)).toEqual(["fold", "block", "fold", "block", "fold"])

    const [lead, block0, mid, block1, tail] = parsed.segments
    expect(lead).toMatchObject({ type: "fold", count: 3 })
    expect((lead as { lines: unknown[] }).lines).toHaveLength(3)

    expect(block0).toMatchObject({ type: "block", index: 0 })
    const block0Lines = (block0 as { lines: { kind: string; oldLine?: number; newLine?: number; text: string }[] }).lines
    expect(block0Lines).toEqual([
      { kind: "del", oldLine: 4, text: "old line" },
      { kind: "add", newLine: 4, text: "new line A" },
      { kind: "add", newLine: 5, text: "new line B" },
    ])

    expect(mid).toMatchObject({ type: "fold", count: 2 })
    expect(block1).toMatchObject({ type: "block", index: 1 })
    expect(tail).toMatchObject({ type: "fold", count: 2 })
  })

  test("inter-hunk gaps become non-expandable folds with the gap size", () => {
    const parsed = parseReviewPatch(GAPPED_PATCH)!
    const folds = parsed.segments.filter((segment) => segment.type === "fold")
    // Leading gap (lines 1-4) and the gap between hunks (lines 8-19) carry no line data.
    expect(folds[0]).toMatchObject({ count: 4, lines: [] })
    const gap = folds.find((fold) => fold.count === 12)!
    expect(gap.lines).toEqual([])
    expect(parsed.blockCount).toBe(2)
  })

  test("malformed and empty patches fail closed to undefined", () => {
    expect(parseReviewPatch("")).toBeUndefined()
    expect(parseReviewPatch("not a patch")).toBeUndefined()
  })

  test("non-object diff records fail closed to undefined", () => {
    expect(reviewFileChangeOf(null)).toBeUndefined()
    expect(reviewFileChangeOf(undefined)).toBeUndefined()
    expect(reviewFileChangeOf(42)).toBeUndefined()
    expect(reviewFileChangeOf("diff")).toBeUndefined()
    expect(reviewFileChangeOf([])).toBeUndefined()
  })

  test("oversized patches are refused before the parser runs (I6/I7)", () => {
    expect(reviewPatchOversized("x".repeat(REVIEW_PATCH_MAX_LENGTH))).toBe(false)
    expect(reviewPatchOversized("x".repeat(REVIEW_PATCH_MAX_LENGTH + 1))).toBe(true)
    expect(reviewPatchOversized("\n".repeat(REVIEW_PATCH_MAX_LINES - 1))).toBe(false)
    expect(reviewPatchOversized("\n".repeat(REVIEW_PATCH_MAX_LINES))).toBe(true)
    expect(parseReviewPatch("x".repeat(REVIEW_PATCH_MAX_LENGTH + 1))).toBeUndefined()
  })

  test("a payload containing more than one patch file is refused", () => {
    const twoFiles = [
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1,1 +1,1 @@",
      "-p",
      "+q",
      "",
    ].join("\n")
    expect(parseReviewPatch(twoFiles)).toBeUndefined()
    expect(parseReviewPatch(twoFiles, "one.ts")).toBeUndefined()
  })

  test("parsed patch file names must agree with the record's file", () => {
    expect(parseReviewPatch(FULL_CONTEXT_PATCH, "alpha-ui/button.css")).toBeDefined()
    expect(parseReviewPatch(FULL_CONTEXT_PATCH, "other.css")).toBeUndefined()

    const gitStyle = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n")
    expect(parseReviewPatch(gitStyle, "x.ts")).toBeDefined()
    expect(parseReviewPatch(gitStyle, "y.ts")).toBeUndefined()

    const added = ["--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,1 @@", "+hello", ""].join("\n")
    expect(parseReviewPatch(added, "new.ts")).toBeDefined()
    expect(parseReviewPatch(added, "stale.ts")).toBeUndefined()
  })

  test("a headerless patch carries no file evidence and cannot bind to any card", () => {
    // Second-round audit repro: without this, "@@ …" patches attach to any file.
    expect(parseReviewPatch("@@ -1,1 +1,1 @@\n-old\n+new\n", "victim.ts")).toBeUndefined()
  })
})

describe("REQ-125 C2 bounded reveal and split pairing", () => {
  test("fold reveals are chunked, never unbounded (I7)", () => {
    expect(foldRevealCount(1000, 0)).toBe(0)
    expect(foldRevealCount(1000, 1)).toBe(REVIEW_FOLD_CHUNK)
    expect(foldRevealCount(1000, 2)).toBe(800)
    expect(foldRevealCount(1000, 3)).toBe(1000)
    expect(foldRevealCount(41, 1)).toBe(41)
  })

  test("split rows pair deletions left with additions right and pad with blanks", () => {
    const parsed = parseReviewPatch(FULL_CONTEXT_PATCH)!
    const block0 = parsed.segments.find((segment) => segment.type === "block")!
    const rows = splitRowsOf(block0.lines)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.left?.text).toBe("old line")
    expect(rows[0]!.right?.text).toBe("new line A")
    expect(rows[1]!.left).toBeUndefined()
    expect(rows[1]!.right?.text).toBe("new line B")
  })

  test("split view falls back to unified below the approved width", () => {
    expect(effectiveDiffView("split", 320)).toBe("unified")
    expect(effectiveDiffView("split", 360)).toBe("split")
    expect(effectiveDiffView("split", undefined)).toBe("split")
    expect(effectiveDiffView("unified", 900)).toBe("unified")
  })
})

describe("REQ-125 C2 panel phase and identity binding", () => {
  test("phase distinguishes loading, no-vcs, clean, and changes (fail-closed order)", () => {
    expect(reviewPhaseOf({ ready: false, vcs: "git", diffs: [] })).toBe("loading")
    expect(reviewPhaseOf({ ready: true, vcs: undefined, diffs: [] })).toBe("no-vcs")
    expect(reviewPhaseOf({ ready: true, vcs: "git", diffs: undefined })).toBe("loading")
    expect(reviewPhaseOf({ ready: true, vcs: "git", diffs: [] })).toBe("clean")
    expect(reviewPhaseOf({ ready: true, vcs: "git", diffs: [{}] })).toBe("changes")
  })

  test("project vcs resolves by worktree containment, longest match wins", () => {
    const projects = [
      { worktree: "/repo", vcs: "git" },
      { worktree: "/repo/nested", vcs: undefined },
      { worktree: "/other", vcs: "git" },
    ]
    expect(projectVcsFor(projects, "/repo")).toBe("git")
    expect(projectVcsFor(projects, "/repo/nested/dir")).toBeUndefined()
    expect(projectVcsFor(projects, "/repo/src")).toBe("git")
    expect(projectVcsFor(projects, "/elsewhere")).toBeUndefined()
    // A prefix that is not a path boundary must not match.
    expect(projectVcsFor([{ worktree: "/repo", vcs: "git" }], "/repository")).toBeUndefined()
  })

  test("identity keys are unambiguous for I8 view-state resets", () => {
    const a = reviewIdentityKeyOf({ serverKey: "s", directory: "/a b", sessionID: "c" })
    const b = reviewIdentityKeyOf({ serverKey: "s", directory: "/a", sessionID: "b c" })
    expect(a).not.toBe(b)
    expect(reviewIdentityKeyOf(undefined)).toBe("")
  })
})
