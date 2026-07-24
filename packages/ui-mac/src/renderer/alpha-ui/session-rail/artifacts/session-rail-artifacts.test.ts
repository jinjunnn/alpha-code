import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const core = readFileSync(join(import.meta.dir, "artifacts-core.ts"), "utf8")
const view = readFileSync(join(import.meta.dir, "artifacts-panel-view.tsx"), "utf8")
const wiring = readFileSync(join(import.meta.dir, "session-rail-artifacts.tsx"), "utf8")
const css = readFileSync(join(import.meta.dir, "session-rail-artifacts.css"), "utf8")
const shell = readFileSync(join(import.meta.dir, "../../session-workspace/session-workspace-shell.tsx"), "utf8")
const shellCss = readFileSync(join(import.meta.dir, "../../session-workspace/session-workspace.css"), "utf8")
const workspace = readFileSync(join(import.meta.dir, "../../session-workspace/alpha-session-workspace.tsx"), "utf8")

const production = { core, view, wiring }
const productionSource = Object.values(production).join("\n")

describe("REQ-125 C4 artifacts panel real Solid mount", () => {
  test("component cases run green in a real Solid+happy-dom mount", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        resolve(import.meta.dir, "../../../../../test-component/session-rail-artifacts.cases.ts"),
      ],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("7 pass")
    expect(output).toContain("0 fail")
  })
})

describe("REQ-125 C4 I1 whitelist ratchet (baseline §③)", () => {
  test("never touches upstream session DOM, components, or non-whitelisted modules", () => {
    const forbidden = [
      "@opencode-ai/session-ui",
      "@opencode-ai/app/surface/session",
      "app/src/pages/session",
      "app/src/pages",
      "MessageTimeline",
      "MessagePart",
      "basic-tool",
      "tool-error-card",
      "querySelector",
      "MutationObserver",
      "innerHTML",
      "SessionPage",
      "UpstreamSessionLeaf",
    ]
    forbidden.forEach((token) => expect(productionSource).not.toContain(token))
  })

  test("every production import stays inside alpha-ui and the whitelisted engines", () => {
    const allowed = [
      /^solid-js(\/web)?$/,
      /^\.\.?\//, // relative within alpha-ui; the preload types climb is checked below
    ]
    for (const [name, source] of Object.entries(production)) {
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!)
      const offenders = specifiers.filter((spec) => !allowed.some((pattern) => pattern.test(spec)))
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] })
    }
    // The only out-of-tree climb is the type-only preload contract.
    expect(wiring).toContain(`import type { ArtifactReadRef } from "../../../../preload/types"`)
  })
})

describe("REQ-125 C4 verbatim workbench embed (I5) and channel discipline", () => {
  test("the view embeds the approved workbench language instead of redefining it", () => {
    // Verbatim pieces: card list markup, state/tab label keys, renderer components.
    expect(view).toContain("alpha-wb-cardlist")
    expect(view).toContain("alpha-wb-card-main")
    expect(view).toContain("STATE_LABEL_KEYS")
    expect(view).toContain("TAB_LABEL_KEYS")
    expect(view).toContain("RENDERER_COMPONENTS")
    expect(view).toContain("MetadataView")
    // The rail chrome css never redefines workbench selectors (workbench styles stay sovereign).
    expect(css).not.toContain(".alpha-wb")
    expect(css).not.toContain(".a-wb")
  })

  test("data flows only through the read-only run-artifact channels, in the container", () => {
    expect(wiring).toContain("window.api.runArtifacts.projectUsage(")
    expect(wiring).toContain("window.api.runArtifacts.list(")
    expect(wiring).toMatch(/window\.api\.runArtifacts\s*\.verify\(/)
    expect(wiring).toContain("window.api.runArtifacts.read(")
    // No write/download/open channels from the rail (they stay in the workbench page).
    const forbidden = ["downloadArtifact", "openExternal", "quickLook", "openPath", "htmlPreview.open"]
    forbidden.forEach((token) => expect(wiring).not.toContain(token))
    // The view is channel-free — the harness mounts it without any preload bridge.
    expect(view).not.toContain("window.api")
  })

  test("the panel remounts on any identity change (I8)", () => {
    expect(wiring).toContain("artifactsIdentityKeyOf")
    expect(wiring).toContain("keyed")
    expect(core).toContain("identity.serverKey, identity.directory, identity.sessionID")
  })

  test("verify-before-open is a barrier ahead of every byte read (REQ-093 AC#4)", () => {
    // The gate exists, failure is a first-class state, and both read paths consult it.
    expect(wiring).toContain("VerifyGate")
    expect(wiring).toContain(`{ status: "fail", reason`)
    expect(wiring.match(/if \(!verifyPassed\(\)\) return null/g)).toHaveLength(2)
  })

  test("rail chrome css is token-only", () => {
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token!.startsWith("--a-")),
    ).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i)
  })
})

describe("REQ-125 C4 shell seam: fourth tab, badge, dot, grip, and the focus mount point", () => {
  test("the shell carries the artifacts member and the timeline linkage api", () => {
    expect(shell).toContain(`export type SessionRailPanel = "review" | "files" | "terminal" | "artifacts"`)
    expect(shell).toContain("focusArtifact")
    expect(shell).toContain("artifactTarget")
    expect(shell).toContain("ArtifactFocusRequest")
    expect(workspace).toContain("SessionRailArtifacts")
    expect(workspace).toContain("railMeta={{ reviewCount }}")
  })

  test("tab decorations and the resize grip land in shell css with reduced-motion coverage", () => {
    expect(shell).toContain("data-alpha-session-review-count")
    expect(shell).toContain("data-alpha-session-terminal-dot")
    expect(shellCss).toContain(".a-swk-rail-tab-badge")
    expect(shellCss).toContain(".a-swk-rail-tab-dot")
    expect(shellCss).toContain(".a-swk-rail-grip")
    expect(shellCss).toContain("@media (prefers-reduced-motion: reduce)")
  })

  test("the 320-560 width contract is never undercut by responsive rules (audit Major-5)", () => {
    const railHost = shellCss.match(/\.a-swk-rail-host \{[^}]*\}/)?.[0] ?? ""
    expect(railHost).toContain("min-width: 320px")
    expect(railHost).toContain("max-width: 560px")
    // No media query may re-declare the rail host's width bounds — the JS constants
    // (rail-width.ts), storage clamp, ARIA range, and CSS must state one contract.
    const mediaBlocks = shellCss.split("@media").slice(1)
    mediaBlocks.forEach((block) => expect(block).not.toContain("a-swk-rail-host"))
  })

  test("the terminal dot consumes the panel-published projection by default (audit Major-2)", () => {
    expect(shell).toContain("terminalRailAnyRunning")
    const panel = readFileSync(join(import.meta.dir, "../terminal/terminal-rail-panel.tsx"), "utf8")
    expect(panel).toContain("publishTerminalAnyRunning(anyTerminalRunning(instances()))")
    expect(panel).toContain("onCleanup(() => publishTerminalAnyRunning(false))")
  })
})
