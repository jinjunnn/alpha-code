// Unit tests for ~/Alpha user workspace supply (REQ-071 / ADR-025). The module reads its root from
// ALPHA_USER_WORKSPACE_DIR, so all cases run against a temp dir: lazy supply scoping (only the
// default dir is ever created), file-squatting honesty, and the Outputs visible-copy guard.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  alphaUserWorkspaceDir,
  ensureUserWorkspaceDir,
  isUserWorkspaceDir,
  mirrorRunArtifacts,
  saveVisibleOutputs,
} from "./alpha-user-workspace"

let base: string
let ws: string
const envBefore = process.env.ALPHA_USER_WORKSPACE_DIR

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-userws-"))
  ws = path.join(base, "Alpha")
  process.env.ALPHA_USER_WORKSPACE_DIR = ws
})
afterEach(() => {
  if (envBefore === undefined) delete process.env.ALPHA_USER_WORKSPACE_DIR
  else process.env.ALPHA_USER_WORKSPACE_DIR = envBefore
  fs.rmSync(base, { recursive: true, force: true })
})

describe("alphaUserWorkspaceDir / isUserWorkspaceDir", () => {
  test("env override wins; default is ~/Alpha", () => {
    expect(alphaUserWorkspaceDir()).toBe(ws)
    delete process.env.ALPHA_USER_WORKSPACE_DIR
    expect(alphaUserWorkspaceDir()).toBe(path.join(os.homedir(), "Alpha"))
  })

  test("identity is path-resolved, not string equality", () => {
    expect(isUserWorkspaceDir(ws)).toBe(true)
    expect(isUserWorkspaceDir(path.join(base, ".", "Alpha"))).toBe(true)
    expect(isUserWorkspaceDir(path.join(base, "Other"))).toBe(false)
    expect(isUserWorkspaceDir(undefined)).toBe(false)
  })
})

describe("ensureUserWorkspaceDir (lazy supply)", () => {
  test("creates the default dir on demand, idempotent", () => {
    expect(fs.existsSync(ws)).toBe(false)
    expect(ensureUserWorkspaceDir()).toBe(ws)
    expect(fs.statSync(ws).isDirectory()).toBe(true)
    expect(ensureUserWorkspaceDir()).toBe(ws) // second call is a no-op success
  })

  test("scoped: any other path is a no-op (never a generic mkdir)", () => {
    const other = path.join(base, "some-project")
    expect(ensureUserWorkspaceDir(other)).toBe(null)
    expect(fs.existsSync(other)).toBe(false)
  })

  test("dir arg equal to the default supplies it", () => {
    expect(ensureUserWorkspaceDir(ws)).toBe(ws)
    expect(fs.statSync(ws).isDirectory()).toBe(true)
  })

  test("a FILE squatting the name is never replaced (ADR-025 §2)", () => {
    fs.writeFileSync(ws, "user file")
    expect(ensureUserWorkspaceDir()).toBe(null)
    expect(fs.readFileSync(ws, "utf8")).toBe("user file") // untouched
  })
})

describe("saveVisibleOutputs (Outputs contract)", () => {
  const NOW = new Date("2026-07-09T12:00:00Z")

  function seedSource(name: string, content: string): string {
    const p = path.join(base, name)
    fs.writeFileSync(p, content)
    return p
  }

  test("copies deliverables into ~/Alpha/Outputs/<date>-<runId>/", () => {
    ensureUserWorkspaceDir()
    const from = seedSource("report.md", "# hi")
    const r = saveVisibleOutputs(ws, "run-1", [{ name: "report.md", from }], NOW)
    if (!r.ok) throw new Error(r.reason)
    expect(r.dir).toBe(path.join(ws, "Outputs", "2026-07-09-run-1"))
    expect(fs.readFileSync(path.join(r.dir, "report.md"), "utf8")).toBe("# hi")
  })

  test("refuses non-workspace projects (guard, not generic writer)", () => {
    const from = seedSource("report.md", "x")
    const r = saveVisibleOutputs(path.join(base, "proj"), "run-1", [{ name: "report.md", from }], NOW)
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(base, "proj"))).toBe(false)
  })

  test("refuses unsafe run ids and sanitizes hostile file names", () => {
    ensureUserWorkspaceDir()
    const from = seedSource("a.txt", "a")
    expect(saveVisibleOutputs(ws, "../evil", [{ name: "a.txt", from }], NOW).ok).toBe(false)
    const r = saveVisibleOutputs(ws, "run-2", [{ name: "../../escape.txt", from }], NOW)
    if (!r.ok) throw new Error(r.reason)
    // path bits stripped → plain basename lands inside the run dir
    expect(r.files).toEqual(["escape.txt"])
    expect(fs.existsSync(path.join(r.dir, "escape.txt"))).toBe(true)
    expect(fs.existsSync(path.join(ws, "escape.txt"))).toBe(false)
  })

  test("missing source files degrade per-file, not whole-call", () => {
    ensureUserWorkspaceDir()
    const from = seedSource("ok.md", "ok")
    const r = saveVisibleOutputs(
      ws,
      "run-3",
      [
        { name: "gone.md", from: path.join(base, "does-not-exist.md") },
        { name: "ok.md", from },
      ],
      NOW,
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.files).toEqual(["ok.md"])
  })
})

describe("mirrorRunArtifacts (cloud manifest → Outputs)", () => {
  test("mirrors artifacts/* only; machine files stay in .alpha", () => {
    ensureUserWorkspaceDir()
    const runDir = path.join(base, "rundir")
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true })
    fs.writeFileSync(path.join(runDir, "status.json"), "{}")
    fs.writeFileSync(path.join(runDir, "artifacts", "report.md"), "R")
    const r = mirrorRunArtifacts(ws, "job-9", {
      dir: runDir,
      files: ["status.json", "contract.json", path.join("artifacts", "report.md")],
    })
    if (!r.ok) throw new Error(r.reason)
    expect(r.files).toEqual(["report.md"])
  })

  test("non-workspace project → honest refusal", () => {
    const r = mirrorRunArtifacts(path.join(base, "proj"), "job-1", { dir: base, files: [] })
    expect(r.ok).toBe(false)
  })
})
