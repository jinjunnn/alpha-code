import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const tsx = readFileSync(join(import.meta.dir, "alpha-session-workspace.tsx"), "utf8")
const shell = readFileSync(join(import.meta.dir, "session-workspace-shell.tsx"), "utf8")
const dock = readFileSync(join(import.meta.dir, "session-composer-dock.tsx"), "utf8")
const composerMount = readFileSync(join(import.meta.dir, "session-composer-mount.tsx"), "utf8")
const dockCore = readFileSync(join(import.meta.dir, "session-dock-core.ts"), "utf8")
const permissionFeed = readFileSync(join(import.meta.dir, "session-permission-feed.ts"), "utf8")
const css = readFileSync(join(import.meta.dir, "session-workspace.css"), "utf8")
const rendererIndex = readFileSync(join(import.meta.dir, "../../index.tsx"), "utf8")
const sidebar = readFileSync(join(import.meta.dir, "../../sidebar/alpha-sidebar.tsx"), "utf8")
const upstreamApp = readFileSync(join(import.meta.dir, "../../../../../app/src/app.tsx"), "utf8")
const upstreamSession = readFileSync(join(import.meta.dir, "../../../../../app/src/pages/session.tsx"), "utf8")

describe("REQ-125 C1b seam skeleton mount", () => {
  test("real Solid mount covers the skeleton, host toggles, and both status states", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        resolve(import.meta.dir, "../../../../test-component/session-workspace.cases.ts"),
      ],
      cwd: resolve(import.meta.dir, "../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("3 pass")
    expect(output).toContain("0 fail")
  })
})

describe("REQ-125 C1b I1 and Recovery static ratchets", () => {
  test("does not import or query upstream session DOM and no longer embeds SessionPage", () => {
    const forbidden = [
      "@opencode-ai/app/surface/session",
      "app/src/pages/session",
      "MessageTimeline",
      "MessagePart",
      "basic-tool",
      "tool-error-card",
      "querySelector",
      "MutationObserver",
      "UpstreamSessionLeaf",
      "SessionPage",
    ]
    forbidden.forEach((token) =>
      expect(`${tsx}\n${shell}\n${dock}\n${composerMount}\n${dockCore}\n${permissionFeed}`).not.toContain(token),
    )
    expect(tsx).not.toContain("preloadSessionLeaf")
    expect(sidebar).not.toContain("preloadSessionLeaf")
    expect(tsx).toContain("useServerSDK")
    expect(tsx).toContain("useServerSync")
    expect(tsx).toContain("<SessionLiveProvider")
  })

  test("uses one alpha 46px topbar and only --a-* CSS variables", () => {
    expect(shell.match(/<header\b/g)).toHaveLength(1)
    expect(css.match(/\.a-swk-topbar \{[^}]*\}/)?.[0]).toContain("height: 46px")
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token.startsWith("--a-")),
    ).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i)
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  })

  test("child-session state is mutually exclusive with a sendable composer (zero promptAsync path when child)", () => {
    // SessionComposerMount hosts the only send surface (AlphaComposer). It must mount exactly
    // once, and only as the fallback of the childSession() gate — so a child session renders
    // just the child card, with no composer host and hence no reachable prompt/send/promptAsync
    // path. The composer itself lives only inside the mount wrapper, never directly in the dock.
    expect(dock.match(/<SessionComposerMount\b/g)).toHaveLength(1)
    expect(dock).not.toContain("<AlphaComposer")
    expect(dock).toMatch(
      /when=\{childSession\(\)\}[\s\S]*?fallback=\{[\s\S]*?<SessionComposerMount\b[\s\S]*?SessionChildCard/,
    )
    expect(composerMount.match(/<AlphaComposer\b/g)).toHaveLength(1)
  })

  test("gate flip preserves the composer draft via a per-identity stash keyed at mount (I8-bound)", () => {
    // The gate unmounts the composer when a session turns out to be a child (info late). A
    // per-identity draft stash captures the draft on that unmount and re-injects it via
    // initialText on flip-back, so unmount is not unrecoverable loss.
    expect(dock).toContain("createComposerDraftStash")
    expect(dock).toMatch(/<SessionComposerMount\b[\s\S]*?drafts=\{draftStash\}/)
    // The identity key is FROZEN at mount (closure capture), so a same-workspace session switch
    // (identity becomes B before A's composer unmounts) cannot write A's draft under B's key.
    expect(composerMount).toContain("const mountedKey = identityKey(props.identity())")
    expect(composerMount).toMatch(/initialText=\{props\.drafts\.restore\(mountedKey\)\}/)
    expect(composerMount).toMatch(/onDraftCapture=\{[^}]*props\.drafts\.capture\(mountedKey,\s*draft\)/)
    // No re-reading of identity() inside the capture closure (the round-3 bug).
    expect(composerMount).not.toMatch(/capture\(identityKey\(identity/)
  })

  test("keeps the release seam and existing Alpha Recovery boundary", () => {
    expect(rendererIndex).toContain(`if (resolved?.session.mode !== "alpha") return undefined`)
    expect(rendererIndex).toContain(`return alphaSessionWorkspaceSurface(projects)`)
    expect(rendererIndex).toContain(`const session = productionRoutes.session.mount(resolved, alphaProjects)`)
    expect(upstreamApp).toContain(`function createTargetSessionRoute(`)
    expect(upstreamApp).toContain(`<TargetSessionRouteContent content={Content} />`)
    expect(upstreamApp).toContain(`<Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />`)
    expect(upstreamSession).toContain(`<TargetSessionPage content={props.content} />`)
    expect(tsx).toContain(`<SurfaceBoundary surface="session">`)
    expect(tsx).not.toMatch(/fallback|legacy/i)
  })
})
