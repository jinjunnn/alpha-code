import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

const packageRoot = join(import.meta.dir, "../..")
const sourceRoot = join(packageRoot, "src")
const workspaceRoot = join(packageRoot, "../..")
// The upstream renderer is held at arm's length, but its deep-link module is a surface Alpha owns
// end to end (the manifest decodes; that module only consumes — including the dispatch, which is
// why it lives there and not inline in layout.tsx). Being Alpha's own module, it takes the FULL
// rule set: a hand-assembled `/${…}/session` for a delivery is a violation there.
const upstreamDeepLinkModule = join(workspaceRoot, "packages/app/src/pages/layout/deep-links.ts")
// The rest of that directory is upstream's: its sidebar legitimately writes its own route
// literals, so it takes only the deep-link codec rules. That layer is contracted by path SHAPE in
// route-upstream-shape.test.ts instead.
const upstreamLayoutRoot = join(workspaceRoot, "packages/app/src/pages/layout")
// layout.tsx is upstream's too, but it is where the deep-link consumer used to live. It may call
// the module; it may not re-become the consumer, because then the hand-assembled href would be
// back in a file the full rule set cannot police.
const upstreamLayoutFile = join(workspaceRoot, "packages/app/src/pages/layout.tsx")
const ratchetPath = join(import.meta.dir, "route-authority-ratchet.test.ts")
const routeManifestPath = join(import.meta.dir, "route-manifest.ts")
const surfaceLedgerPath = join(import.meta.dir, "frontend-surface-manifest.ts")

interface SourceFile {
  path: string
  source: string
}

interface Violation {
  path: string
  rule: string
}

const ROUTE_LITERAL_RULES = [
  {
    rule: "navigation must use a manifest-derived href",
    pattern: /\b(?:navigate|redirect)\s*\(\s*["'`]\/[^"'`]*["'`]/g,
  },
  {
    rule: "href/to must use a manifest-derived href",
    pattern: /\b(?:href|to)\s*(?:=|:)\s*(?:\{\s*)?["'`]\/[^"'`]*["'`]/g,
  },
  {
    rule: "Route path must come from the manifest",
    pattern: /<Route\b[^>]*\bpath\s*=\s*(?:\{\s*)?["'`]\/[^"'`]*["'`]/g,
  },
  {
    rule: "pathname dispatch must use parseRoute",
    pattern:
      /\b(?:location\.)?pathname(?:\s*(?:===|!==|==|!=)\s*["'`]\/[^"'`]*["'`]|\.(?:startsWith|endsWith|includes)\(\s*["'`]\/[^"'`]*["'`]\s*\))/g,
  },
  {
    rule: "new-session path literals belong in the manifest",
    pattern: /["'`]\/new-session(?:\?[^"'`]*)?["'`]/g,
  },
  {
    rule: "parameterized session hrefs belong in the manifest",
    pattern: /`\/\$\{[^}]+\}\/session(?:\/\$\{[^}]+\})?`/g,
  },
] as const

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (comment) => comment.replace(/[^\n]/g, " "))
}

function violationsFor(file: SourceFile) {
  const source = withoutComments(file.source)
  const path = relative(packageRoot, file.path)
  const violations: Violation[] = []

  if (/\blegacy-route-abi\b|\bLegacyRouteAbiV1\b/.test(source)) {
    violations.push({ path, rule: "removed legacy route ABI reference" })
  }

  // Every route composes exactly one Alpha surface. The release-state machine that once let a
  // route fall back to an upstream leaf (env override / userData pin / crash fallback) is gone
  // and must not grow back.
  if (/\bSURFACE_RELEASE_STATES\b|\bALPHA_SURFACE_(?:HOME|NEW_SESSION|SESSION)\b|\balpha-surfaces-resolve\b/.test(source)) {
    violations.push({ path, rule: "removed legacy surface release flag" })
  }

  // The frontend surface manifest is a descriptive ownership ledger: it does not register,
  // parse, or navigate routes. Executable route strings have only one exemption: the manifest.
  if (![routeManifestPath, surfaceLedgerPath].includes(file.path) && !/\.test\.[cm]?[jt]sx?$/.test(file.path)) {
    ROUTE_LITERAL_RULES.forEach((entry) => {
      entry.pattern.lastIndex = 0
      if (entry.pattern.test(source)) violations.push({ path, rule: entry.rule })
    })
  }

  if (/\.test\.[cm]?[jt]sx?$/.test(file.path)) return violations

  if (
    file.path !== routeManifestPath &&
    (/["'`](?:opencode|alpha-code):\/\//.test(source) ||
      /["'`](?:opencode|alpha-code):["'`]/.test(source) ||
      /\bsetAsDefaultProtocolClient\s*\(\s*["'`](?:opencode|alpha-code)["'`]/.test(source))
  ) {
    violations.push({ path, rule: "deep-link scheme literal outside the manifest" })
  }

  const parsesUrl = /\bnew URL\s*\(/.test(source)
  const dispatchesHostname = /\.(?:hostname|host)\b/.test(source)
  const dispatchesDeepLinkRoute = /["'`](?:new-session|open-project)["'`]/.test(source)
  const isDeepLinkIngress =
    file.path.includes(`${join(sourceRoot, "main")}/`) || file.path.includes(`${join(sourceRoot, "renderer")}/`)
  if (isDeepLinkIngress && parsesUrl && dispatchesHostname && dispatchesDeepLinkRoute) {
    violations.push({ path, rule: "new URL plus hostname deep-link dispatch outside the manifest" })
  }

  return violations
}

async function sourcesUnder(root: string) {
  const paths = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root, absolute: true }))
  return Promise.all(
    paths
      .filter((path) => path !== ratchetPath)
      .sort()
      .map(async (path) => ({ path, source: await Bun.file(path).text() })),
  )
}

const DEEP_LINK_CODEC_RULES = [
  { rule: "deep-link scheme literal outside the manifest", pattern: /["'`](?:opencode|alpha-code):\/\// },
  { rule: "deep-link URL codec outside the manifest", pattern: /\bnew URL\s*\(|\.hostname\b|\bsearchParams\b/ },
] as const

function deepLinkViolationsFor(file: SourceFile): Violation[] {
  if (/\.test\.[cm]?[jt]sx?$/.test(file.path)) return []
  const source = withoutComments(file.source)
  const path = relative(workspaceRoot, file.path)
  return DEEP_LINK_CODEC_RULES.filter((entry) => entry.pattern.test(source)).map((entry) => ({
    path,
    rule: entry.rule,
  }))
}

// Selecting deliveries is the first move of a consumer. Keeping that out of layout.tsx keeps the
// consumer inside the module the full rule set polices: to hand-assemble a route from a delivery
// in layout.tsx you must first pick the deliveries apart, and that is what this bites.
const DEEP_LINK_CONSUMER_RULES = [
  {
    rule: "deep-link dispatch belongs in the ratcheted deep-links module",
    pattern: /\bcollect(?:OpenProject|NewSession)DeepLinks\b|\bdeepLinkId\b/,
  },
] as const

function consumerViolationsFor(file: SourceFile): Violation[] {
  const source = withoutComments(file.source)
  const path = relative(workspaceRoot, file.path)
  return DEEP_LINK_CONSUMER_RULES.filter((entry) => entry.pattern.test(source)).map((entry) => ({
    path,
    rule: entry.rule,
  }))
}

/**
 * The two bindings layout.tsx hands the consumer, brace-balanced out of the call. Everything
 * BETWEEN them and the navigation is executed and asserted in route-deep-link-consumer.test.ts;
 * these two lines are the only stretch a test cannot reach into, because a wrapper here
 * (`navigate: (href) => go(href + "/wrong")`) or a remapped input (`buffer: () => rewritten`)
 * would retarget the navigation without any executed code changing. So they are pinned verbatim.
 */
function deepLinkWiringIn(source: string): string {
  const clean = withoutComments(source)
  const marker = "createDeepLinkConsumer({"
  const calls = clean.split(marker).length - 1
  if (calls !== 1) throw new Error(`expected exactly one createDeepLinkConsumer call, found ${calls}`)
  let index = clean.indexOf(marker) + marker.length - 1
  let depth = 0
  const start = index
  while (index < clean.length) {
    if (clean[index] === "{") depth += 1
    else if (clean[index] === "}") {
      depth -= 1
      if (depth === 0) return clean.slice(start, index + 1)
    }
    index += 1
  }
  throw new Error("unterminated createDeepLinkConsumer call")
}

describe("Alpha route authority ratchet", () => {
  test.each(["main", "renderer"])("the detector bites on an out-of-manifest href and scheme parser in %s", (layer) => {
    const source = `
      const href = "/new-session?draftId=parallel"
      navigate(href)
      app.setAsDefaultProtocolClient("alpha-code")
      const parsed = new URL("opencode://new-session?directory=/tmp")
      if (parsed.hostname === "new-session") dispatch(parsed)
    `

    expect(violationsFor({ path: join(sourceRoot, layer, "fixture.ts"), source }).map((entry) => entry.rule)).toEqual(
      [
        "href/to must use a manifest-derived href",
        "new-session path literals belong in the manifest",
        "deep-link scheme literal outside the manifest",
        "new URL plus hostname deep-link dispatch outside the manifest",
      ],
    )
  })

  test("Alpha sources do not reintroduce a parallel route or deep-link codec", async () => {
    expect((await sourcesUnder(sourceRoot)).flatMap(violationsFor)).toEqual([])
  })

  test("the upstream layout directory stays free of a second deep-link codec", async () => {
    expect((await sourcesUnder(upstreamLayoutRoot)).flatMap(deepLinkViolationsFor)).toEqual([])
  })

  test("the deep-link detector bites on a revived upstream parser", () => {
    const source = `
      const url = new URL("opencode://new-session?directory=/tmp")
      if (url.hostname === "new-session") dispatch(url.searchParams.get("directory"))
    `
    expect(
      deepLinkViolationsFor({ path: join(upstreamLayoutRoot, "fixture.ts"), source }).map((entry) => entry.rule),
    ).toEqual(["deep-link scheme literal outside the manifest", "deep-link URL codec outside the manifest"])
  })

  test("the deep-link consumer module assembles no route of its own", async () => {
    const source = await Bun.file(upstreamDeepLinkModule).text()
    expect(violationsFor({ path: upstreamDeepLinkModule, source })).toEqual([])
  })

  test("the full rule set bites on a hand-assembled session href in the consumer module", () => {
    // The exact mutation the previous ratchet let through: rebuild the destination from the
    // delivery's directory instead of navigating to the href the manifest decoded.
    const source = "navigateWithSidebarReset(`/${base64Encode(link.directory)}/session`)"
    expect(violationsFor({ path: upstreamDeepLinkModule, source }).map((entry) => entry.rule)).toEqual([
      "parameterized session hrefs belong in the manifest",
    ])
  })

  test("layout.tsx calls the consumer instead of being one", async () => {
    const source = await Bun.file(upstreamLayoutFile).text()
    expect(consumerViolationsFor({ path: upstreamLayoutFile, source })).toEqual([])
  })

  test("layout.tsx hands the consumer its own primitives, unwrapped and unmapped", async () => {
    // Fallback to the executable judgement, not a substitute for it: see route-deep-link-consumer.
    const wiring = deepLinkWiringIn(await Bun.file(upstreamLayoutFile).text())
    expect(wiring).toContain("navigate: navigateWithSidebarReset,")
    expect(wiring).toContain("buffer: () => window,")
  })

  test("the wiring pin bites on a wrapped navigate and on a remapped buffer", () => {
    const tampered = `
      const consumeDeepLinks = createDeepLinkConsumer({
        enabled: () => server.isLocal(),
        buffer: () => rewritten(window),
        openProject: (directory, navigate) => void openProject(directory, navigate),
        navigate: (href) => navigateWithSidebarReset(href + "/wrong"),
        handoff: (directory, prompt) => setSessionHandoff(directory, { prompt }),
      })
    `
    const wiring = deepLinkWiringIn(tampered)
    expect(wiring).not.toContain("navigate: navigateWithSidebarReset,")
    expect(wiring).not.toContain("buffer: () => window,")
  })

  test("a second consumer call site is refused outright", () => {
    const doubled = "createDeepLinkConsumer({ a: 1 })\ncreateDeepLinkConsumer({ b: 2 })"
    expect(() => deepLinkWiringIn(doubled)).toThrow(/exactly one/)
  })

  test("the consumer detector bites when dispatch moves back into layout.tsx", () => {
    const source = `
      for (const link of collectNewSessionDeepLinks(links)) {
        navigateWithSidebarReset(\`/\${base64Encode(link.directory)}/session\`)
      }
    `
    expect(consumerViolationsFor({ path: upstreamLayoutFile, source }).map((entry) => entry.rule)).toEqual([
      "deep-link dispatch belongs in the ratcheted deep-links module",
    ])
  })
})
