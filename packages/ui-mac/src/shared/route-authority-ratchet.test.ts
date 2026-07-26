import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

const packageRoot = join(import.meta.dir, "../..")
const sourceRoot = join(packageRoot, "src")
const workspaceRoot = join(packageRoot, "../..")
// The upstream renderer is held at arm's length, but its deep-link module is a surface Alpha
// owns end to end (the manifest decodes; that module only consumes). Scan it for the deep-link
// codec class specifically — the general href rules do not apply there, because upstream's own
// sidebar legitimately writes its own route literals; that layer is contracted by path SHAPE in
// route-upstream-shape.test.ts instead.
const upstreamDeepLinkRoot = join(workspaceRoot, "packages/app/src/pages/layout")
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

  test("the upstream deep-link module stays a passthrough, not a second codec", async () => {
    expect((await sourcesUnder(upstreamDeepLinkRoot)).flatMap(deepLinkViolationsFor)).toEqual([])
  })

  test("the deep-link detector bites on a revived upstream parser", () => {
    const source = `
      const url = new URL("opencode://new-session?directory=/tmp")
      if (url.hostname === "new-session") dispatch(url.searchParams.get("directory"))
    `
    expect(
      deepLinkViolationsFor({ path: join(upstreamDeepLinkRoot, "fixture.ts"), source }).map((entry) => entry.rule),
    ).toEqual(["deep-link scheme literal outside the manifest", "deep-link URL codec outside the manifest"])
  })
})
