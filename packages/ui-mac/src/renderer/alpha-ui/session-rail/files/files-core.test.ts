import { describe, expect, test } from "bun:test"
// Real upstream implementations, imported only here to prove the parity clones stay honest.
import { base64Encode } from "../../../../../../core/src/util/encode"
import { createPathHelpers } from "../../../../../../app/src/context/file/path"
import { SessionRouteKey, SessionStateKey, type ServerScope } from "../../../../../../app/src/utils/server-scope"
import {
  base64UrlEncode,
  canonicalRelPath,
  fileName,
  isSafeRelPath,
  normalizeToRel,
  parentDir,
  relPathFromTab,
  relPathToTab,
  sanitizeSearchRows,
  sessionStateKey,
  statusByFile,
  toTreeEntries,
  watcherRefreshTarget,
} from "./files-core"
import { turnDiffsOf } from "../review/review-turn-diffs"

const ROOT = "/Users/demo/app/workspace"

describe("REQ-125 C3 files-core — path discipline (baseline §③.3)", () => {
  test("isSafeRelPath accepts plain workspace-relative paths only", () => {
    expect(isSafeRelPath("src/app.ts")).toBe(true)
    expect(isSafeRelPath("架构说明.md")).toBe(true)
    expect(isSafeRelPath("a b/c d.txt")).toBe(true)

    expect(isSafeRelPath("")).toBe(false)
    expect(isSafeRelPath("/etc/passwd")).toBe(false)
    expect(isSafeRelPath("C:/Windows/system32")).toBe(false)
    expect(isSafeRelPath("..")).toBe(false)
    expect(isSafeRelPath("src/../../etc/passwd")).toBe(false)
    expect(isSafeRelPath("./src")).toBe(false)
    expect(isSafeRelPath("src//app.ts")).toBe(false)
    expect(isSafeRelPath("src\\app.ts")).toBe(false)
    expect(isSafeRelPath("src/\u0000evil")).toBe(false)
  })

  test("normalizeToRel strips the workspace root and refuses everything unprovable", () => {
    expect(normalizeToRel(ROOT, `${ROOT}/src/app.ts`)).toBe("src/app.ts")
    expect(normalizeToRel(`${ROOT}/`, `${ROOT}/src/app.ts`)).toBe("src/app.ts")
    expect(normalizeToRel(ROOT, "src/app.ts")).toBe("src/app.ts")
    expect(normalizeToRel(ROOT, "./src/app.ts")).toBe("src/app.ts")
    expect(normalizeToRel(ROOT, `file://${ROOT}/src/app.ts`)).toBe("src/app.ts")

    // Real separator forms: directory trailing slash and Windows backslashes normalize.
    expect(normalizeToRel(ROOT, `${ROOT}/src/`)).toBe("src")
    expect(normalizeToRel(ROOT, "src/deep/")).toBe("src/deep")
    expect(normalizeToRel("C:\\work\\ws", "C:\\work\\ws\\src\\app.ts")).toBe("src/app.ts")
    expect(normalizeToRel("C:\\work\\ws", "src\\deep\\")).toBe("src/deep")

    // Foreign absolute paths, root escapes, and the bare root are all dropped fail-closed.
    expect(normalizeToRel(ROOT, "/etc/passwd")).toBeUndefined()
    expect(normalizeToRel(ROOT, `${ROOT}-sibling/file.ts`)).toBeUndefined()
    expect(normalizeToRel(ROOT, `${ROOT}/../escape.ts`)).toBeUndefined()
    expect(normalizeToRel("C:\\work\\ws", "C:\\work\\ws\\..\\escape.ts")).toBeUndefined()
    expect(normalizeToRel(ROOT, ROOT)).toBeUndefined()
    expect(normalizeToRel(ROOT, `${ROOT}/`)).toBeUndefined()
    expect(normalizeToRel(ROOT, "")).toBeUndefined()
  })

  test("canonicalRelPath normalizes real separator forms and stays fail-closed", () => {
    expect(canonicalRelPath("src/")).toBe("src")
    expect(canonicalRelPath("src//")).toBe("src")
    expect(canonicalRelPath("src\\deep")).toBe("src/deep")
    expect(canonicalRelPath("src\\deep\\")).toBe("src/deep")
    expect(canonicalRelPath("./src/a.ts")).toBe("src/a.ts")

    expect(canonicalRelPath("/")).toBeUndefined()
    expect(canonicalRelPath("//")).toBeUndefined()
    expect(canonicalRelPath("/etc/passwd")).toBeUndefined()
    expect(canonicalRelPath("src\\..\\..\\etc")).toBeUndefined()
    expect(canonicalRelPath("C:\\Windows")).toBeUndefined()
    expect(canonicalRelPath("src//a.ts")).toBeUndefined()
    expect(canonicalRelPath("")).toBeUndefined()
  })

  test("fileName / parentDir", () => {
    expect(fileName("src/app.ts")).toBe("app.ts")
    expect(fileName("app.ts")).toBe("app.ts")
    expect(parentDir("src/deep/app.ts")).toBe("src/deep")
    expect(parentDir("app.ts")).toBe("")
  })

  test("toTreeEntries sanitizes raw nodes fail-closed and preserves server order", () => {
    // Real server shapes: directories carry a trailing separator; Windows servers emit
    // backslash separators. Both must land as canonical entries, not be dropped.
    const entries = toTreeEntries("src", [
      { name: "b.ts", path: "src/b.ts", type: "file", ignored: false },
      { name: "a", path: "src/a/", type: "directory", ignored: false },
      { name: "deep", path: "src\\deep\\", type: "directory", ignored: false },
      { name: "win.ts", path: "src\\win.ts", type: "file", ignored: false },
      { name: "evil", path: "/etc/passwd", type: "file" },
      { name: "escape", path: "src/../../etc", type: "directory" },
      { name: "winescape", path: "src\\..\\..\\etc", type: "directory" },
      { name: "outside", path: "lib/x.ts", type: "file" },
      { name: "bad/name", path: "src/bad", type: "file" },
      { name: "dup", path: "src/b.ts", type: "file" },
      { name: "weird", path: "src/w", type: "symlink" },
      "not-an-object",
    ])
    expect(entries).toEqual([
      { name: "b.ts", path: "src/b.ts", type: "file", ignored: false },
      { name: "a", path: "src/a", type: "directory", ignored: false },
      { name: "deep", path: "src/deep", type: "directory", ignored: false },
      { name: "win.ts", path: "src/win.ts", type: "file", ignored: false },
    ])
  })

  test("toTreeEntries drops hidden (dot) directories and keeps dotfiles and regular entries", () => {
    // REQ-125 #576 finding: the workspace tree carried `.git` (approved frame omits it).
    const entries = toTreeEntries("", [
      { name: ".git", path: ".git/", type: "directory", ignored: false },
      { name: ".github", path: ".github/", type: "directory", ignored: false },
      { name: ".vscode", path: ".vscode", type: "directory", ignored: true },
      { name: "src", path: "src/", type: "directory", ignored: false },
      // Dotfiles are meaningful, not noise — they stay visible.
      { name: ".gitignore", path: ".gitignore", type: "file", ignored: false },
      { name: "README.md", path: "README.md", type: "file", ignored: false },
    ])
    expect(entries).toEqual([
      { name: "src", path: "src", type: "directory", ignored: false },
      { name: ".gitignore", path: ".gitignore", type: "file", ignored: false },
      { name: "README.md", path: "README.md", type: "file", ignored: false },
    ])
    expect(entries.some((entry) => entry.name.startsWith(".") && entry.type === "directory")).toBe(false)
  })

  test("toTreeEntries drops entries nested inside a hidden directory (fail-closed path segments)", () => {
    // Untrusted / non-normalized responses can hand back nodes whose ancestor is a dot dir
    // even when the leaf name is innocent; every directory segment is checked, not just the leaf.
    const entries = toTreeEntries("src", [
      { name: "config", path: "src/.git/config", type: "file", ignored: false },
      { name: "hooks", path: "src\\.git\\hooks", type: "directory", ignored: false },
      { name: "app.ts", path: "src/app.ts", type: "file", ignored: false },
    ])
    expect(entries).toEqual([{ name: "app.ts", path: "src/app.ts", type: "file", ignored: false }])
  })

  test("statusByFile maps the session change set to relative paths with valid kinds only", () => {
    const map = statusByFile(
      [
        { file: "src/app.ts", status: "modified" },
        { file: `${ROOT}/docs/说明.md`, status: "added" },
        { file: "gone.ts", status: "deleted" },
        { file: "/etc/passwd", status: "added" },
        { file: "src/odd.ts", status: "renamed" },
        { status: "added" },
      ],
      ROOT,
    )
    expect(map.get("src/app.ts")).toBe("modified")
    expect(map.get("docs/说明.md")).toBe("added")
    expect(map.get("gone.ts")).toBe("deleted")
    expect(map.size).toBe(3)
  })

  test("badges derive from the REQ-142 turn projection over a real-shaped user message", () => {
    // Real message shape as persisted by the engine (verified 2026-08-28 against a live
    // session: user message info carries summary.diffs after the turn's summarize).
    const messages = [
      {
        id: "msg_u1",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        summary: {
          diffs: [{ file: "notes.txt", patch: "…", additions: 1, deletions: 1, status: "modified" }],
        },
      },
      { id: "msg_a1", role: "assistant", parentID: "msg_u1", time: { created: 2 } },
    ]
    const map = statusByFile(turnDiffsOf(messages), ROOT)
    expect(map.get("notes.txt")).toBe("modified")
    expect(map.size).toBe(1)
    // Store not loaded → no badges; malformed entries → no badges (fail-closed).
    expect(statusByFile(turnDiffsOf(undefined), ROOT).size).toBe(0)
    expect(statusByFile([null, 42, { file: 7, status: "modified" }], ROOT).size).toBe(0)
  })

  test("sanitizeSearchRows bounds, dedupes, and normalizes results", () => {
    const rows = sanitizeSearchRows([`${ROOT}/a.ts`, "a.ts", "b.ts", "/etc/passwd", 42, "c.ts", "d.ts"], ROOT, 3)
    expect(rows).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  test("watcherRefreshTarget refreshes only loaded directories", () => {
    const loaded = new Set(["", "src"])
    const dirs = new Set(["src", "src/deep"])
    const ops = {
      isDirLoaded: (dir: string) => loaded.has(dir),
      isDirEntry: (path: string) => dirs.has(path),
    }
    expect(watcherRefreshTarget({ kind: "add", path: "src/new.ts", ...ops })).toBe("src")
    expect(watcherRefreshTarget({ kind: "unlink", path: "root.ts", ...ops })).toBe("")
    expect(watcherRefreshTarget({ kind: "add", path: "src/deep/x.ts", ...ops })).toBeUndefined()
    expect(watcherRefreshTarget({ kind: "change", path: "src", ...ops })).toBe("src")
    expect(watcherRefreshTarget({ kind: "change", path: "src/app.ts", ...ops })).toBeUndefined()
    expect(watcherRefreshTarget({ kind: "add", path: ".git/index", ...ops })).toBeUndefined()
    expect(watcherRefreshTarget({ kind: "rename", path: "src/x.ts", ...ops })).toBeUndefined()
  })
})

describe("REQ-125 C3 files-core — parity with the upstream encodings", () => {
  const samples = [
    "src/app.ts",
    "docs/架构说明.md",
    "a b/c d e.txt",
    "emoji/🚀.md",
    "deep/x/y/z/file.min.js",
    "percent/100%.txt",
  ]

  test("base64UrlEncode matches @opencode-ai/core base64Encode", () => {
    for (const value of [ROOT, "简体中文路径/工作区", "emoji 🚀 dir", ""]) {
      expect(base64UrlEncode(value)).toBe(base64Encode(value))
    }
  })

  test("sessionStateKey matches the upstream layout tab-store key", () => {
    const scope = "local" as ServerScope
    const expected = SessionStateKey.from(scope, SessionRouteKey.fromRoute(base64Encode(ROOT), "ses_123"))
    expect(sessionStateKey("local", ROOT, "ses_123")).toBe(expected)
  })

  test("relPathToTab matches upstream path.tab for workspace-relative inputs", () => {
    const upstream = createPathHelpers(() => ROOT)
    for (const sample of samples) {
      expect(relPathToTab(sample)).toBe(upstream.tab(sample))
    }
  })

  test("relPathFromTab matches upstream pathFromTab for relative tabs and drops hostile ones", () => {
    const upstream = createPathHelpers(() => ROOT)
    for (const sample of samples) {
      const tab = upstream.tab(sample)
      expect(relPathFromTab(tab)).toBe(upstream.pathFromTab(tab))
    }
    expect(relPathFromTab("review")).toBeUndefined()
    // Hardened divergence: a tab decoding to an absolute/escaping path is refused, not returned.
    expect(relPathFromTab("file:///etc/passwd")).toBeUndefined()
    expect(relPathFromTab("file://..%2F..%2Fetc%2Fpasswd")).toBeUndefined()
  })
})
