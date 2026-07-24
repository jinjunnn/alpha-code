import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const core = readFileSync(join(import.meta.dir, "files-core.ts"), "utf8")
const state = readFileSync(join(import.meta.dir, "files-state.ts"), "utf8")
const view = readFileSync(join(import.meta.dir, "files-view.tsx"), "utf8")
const wiring = readFileSync(join(import.meta.dir, "session-rail-files.tsx"), "utf8")
const css = readFileSync(join(import.meta.dir, "session-rail-files.css"), "utf8")
const shell = readFileSync(join(import.meta.dir, "../../session-workspace/session-workspace-shell.tsx"), "utf8")
const workspace = readFileSync(join(import.meta.dir, "../../session-workspace/alpha-session-workspace.tsx"), "utf8")

const production = { core, state, view, wiring }
const productionSource = Object.values(production).join("\n")

describe("REQ-125 C3 files panel real Solid mount", () => {
  test("component cases run green in a real Solid+happy-dom mount", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        resolve(import.meta.dir, "../../../../../test-component/session-rail-files.cases.ts"),
      ],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("8 pass")
    expect(output).toContain("0 fail")
  })
})

describe("REQ-125 C3 I1 whitelist ratchet (baseline §③)", () => {
  test("never touches upstream session DOM, components, or non-whitelisted modules", () => {
    const forbidden = [
      "@opencode-ai/app/surface/session",
      "app/src/pages/session",
      "MessageTimeline",
      "MessagePart",
      "basic-tool",
      "tool-error-card",
      "querySelector",
      "MutationObserver",
      "SessionPage",
      "UpstreamSessionLeaf",
    ]
    forbidden.forEach((token) => expect(productionSource).not.toContain(token))
  })

  test("every production import stays inside the whitelist (public app hooks, solid, own files)", () => {
    const allowed = [
      /^solid-js(\/store)?$/,
      /^@opencode-ai\/app$/,
      /^\.\.?\//, // relative within the renderer — climbing out is checked separately below
    ]
    for (const [name, source] of Object.entries(production)) {
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!)
      const offenders = specifiers.filter((spec) => !allowed.some((pattern) => pattern.test(spec)))
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] })
      // Relative imports must stay within alpha-ui — no climbing into upstream packages.
      const climbs = specifiers.filter((spec) => spec.includes("../../../../"))
      expect({ file: name, climbs }).toEqual({ file: name, climbs: [] })
    }
  })

  test("data wiring uses exactly the whitelisted typed channels and binds results to identity", () => {
    expect(wiring).toContain("useServerSDK")
    expect(wiring).toContain("useServerSync")
    expect(wiring).toContain("useLayout")
    expect(wiring).toContain("props.live.accepts(identity)")
    expect(wiring).toContain("session_diff")
  })
})

describe("REQ-125 C3 path-security ratchet (baseline §③.3)", () => {
  test("no path ever leaves the renderer toward a generic opener or filesystem API", () => {
    const forbidden = [
      "openPath",
      "openExternal",
      "shell.open",
      "window.api",
      "ipcRenderer",
      "node:fs",
      "node:path",
      "process.cwd",
      "require(",
      ".absolute",
      "file.read",
    ]
    forbidden.forEach((token) => expect(productionSource).not.toContain(token))
  })

  test("inbound paths are funneled through the fail-closed guards", () => {
    expect(core).toContain("export function isSafeRelPath")
    expect(core).toContain("export function normalizeToRel")
    // Every consumer of outside paths goes through the guards.
    expect(state).toContain("normalizeToRel")
    expect(state).toContain("toTreeEntries")
    expect(state).toContain("sanitizeSearchRows")
    expect(state).toContain("relPathFromTab")
    // The renderer never concatenates the workspace root onto a path.
    expect(state).not.toContain("io.root +")
    expect(state).not.toContain("${io.root}")
    expect(wiring).not.toContain("identity.directory +")
    expect(wiring).not.toContain("${identity.directory}/")
  })
})

describe("REQ-125 C3 design-token and shell-seam ratchets", () => {
  test("panel css is token-only with reduced-motion and the approved focus ring", () => {
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token!.startsWith("--a-")),
    ).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i)
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("var(--a-ring-focus)")
  })

  test("shell state machine carries the files panel isomorphic to review/terminal", () => {
    expect(shell).toContain(`export type SessionRailPanel = "review" | "files" | "terminal" | "artifacts"`)
    expect(shell).toContain(`data-alpha-session-rail-tab={kind}`)
    expect(shell).toContain("jumpToReview")
    expect(workspace).toContain("SessionRailFiles")
  })

  test("review target stays identity-bound (I8): payload carries the triple, reads are gated by accepts", () => {
    expect(shell).toContain("SessionRailReviewTarget")
    expect(shell).toContain("props.live.accepts(target.identity)")
    expect(shell).toContain("sameSessionIdentity(previous, identity)")
  })

  test("tree rendering is bounded (I7): per-level and total caps with a truncation hint", () => {
    expect(state).toContain("treeDirCap")
    expect(state).toContain("treeTotalCap")
    expect(view).toContain("filesTruncated")
  })
})
