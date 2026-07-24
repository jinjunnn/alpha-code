import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const core = readFileSync(join(import.meta.dir, "review-core.ts"), "utf8")
const container = readFileSync(join(import.meta.dir, "review-panel.tsx"), "utf8")
const view = readFileSync(join(import.meta.dir, "review-panel-view.tsx"), "utf8")
const css = readFileSync(join(import.meta.dir, "review-panel.css"), "utf8")
const workspace = readFileSync(join(import.meta.dir, "../../session-workspace/alpha-session-workspace.tsx"), "utf8")
const shell = readFileSync(join(import.meta.dir, "../../session-workspace/session-workspace-shell.tsx"), "utf8")

describe("REQ-125 C2 review panel behavior", () => {
  test("real Solid mount covers list, folds, split, empty states, reset, and comment entry", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        resolve(import.meta.dir, "../../../../../test-component/session-rail-review.cases.ts"),
      ],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("15 pass")
    expect(output).toContain("0 fail")
  })
})

describe("REQ-125 C2 I1 whitelist and token static ratchets", () => {
  const shipped = { core, container, view }

  test("review sources never import upstream session components or touch upstream DOM", () => {
    const forbidden = [
      "@opencode-ai/session-ui",
      "@opencode-ai/ui/",
      "@pierre/",
      "app/pages/session",
      "app/src/pages",
      "MessageTimeline",
      "MessagePart",
      "basic-tool",
      "tool-error-card",
      "querySelector",
      "MutationObserver",
      "innerHTML",
      "createElement(",
    ]
    Object.values(shipped).forEach((source) => forbidden.forEach((token) => expect(source).not.toContain(token)))
  })

  test("data flows only through the typed channel in the container; the view is channel-free", () => {
    expect(container).toContain('import { useServerSync } from "@opencode-ai/app"')
    expect(view).not.toContain("@opencode-ai/app")
    // The diff itself is never recomputed: the server patch is parsed with the
    // whitelisted jsdiff engine, in core only.
    expect(core).toContain('from "diff"')
    expect(view).not.toContain('from "diff"')
    expect(container).not.toContain('from "diff"')
  })

  test("async loads and view state are bound to the C1 session identity (I8)", () => {
    expect(container).toContain("props.live.accepts(")
    expect(container).toContain("reviewIdentityKeyOf(")
    expect(view).toContain("props.resetKey")
  })

  test("panel CSS uses only --a-* tokens and respects reduced motion", () => {
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token?.startsWith("--a-")),
    ).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i)
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  })

  test("the shell exposes the rail slot and the workspace wires the review panel into it", () => {
    expect(shell).toContain("SessionRailPanelRenderers")
    expect(shell).toContain("renderPanel(rail)")
    expect(workspace).toContain("SessionRailReviewPanel")
    expect(workspace).toContain("review: () => <SessionRailReviewPanel live={live} />")
  })
})
