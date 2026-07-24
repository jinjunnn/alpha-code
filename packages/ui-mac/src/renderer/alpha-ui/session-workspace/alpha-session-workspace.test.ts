import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const tsx = readFileSync(join(import.meta.dir, "alpha-session-workspace.tsx"), "utf8")
const shell = readFileSync(join(import.meta.dir, "session-workspace-shell.tsx"), "utf8")
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
    forbidden.forEach((token) => expect(`${tsx}\n${shell}`).not.toContain(token))
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

  test("keeps the release seam and existing Alpha Recovery boundary", () => {
    expect(rendererIndex).toContain(`if (resolved?.session.mode !== "alpha") return undefined`)
    expect(rendererIndex).toContain(`return alphaSessionWorkspaceSurface()`)
    expect(rendererIndex).toContain(`const session = productionRoutes.session.mount(resolved)`)
    expect(upstreamApp).toContain(`function createTargetSessionRoute(`)
    expect(upstreamApp).toContain(`<TargetSessionRouteContent content={Content} />`)
    expect(upstreamApp).toContain(`<Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />`)
    expect(upstreamSession).toContain(`<TargetSessionPage content={props.content} />`)
    expect(tsx).toContain(`<SurfaceBoundary surface="session">`)
    expect(tsx).not.toMatch(/fallback|legacy/i)
  })
})
