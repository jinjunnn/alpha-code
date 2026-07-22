import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

const packageRoot = join(import.meta.dir, "../..")
const sourceRoot = join(packageRoot, "src")
const ratchetPath = join(import.meta.dir, "route-authority-ratchet.test.ts")
const routeManifestPath = join(import.meta.dir, "route-manifest.ts")
const surfaceLedgerPath = join(import.meta.dir, "frontend-surface-manifest.ts")
const mainIndexPath = join(sourceRoot, "main/index.ts")
const alphaAuthPath = join(sourceRoot, "main/alpha-auth.ts")

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

  // The frontend surface manifest is a descriptive ownership ledger: it does not register,
  // parse, or navigate routes. Executable route strings have only one exemption: the manifest.
  if (![routeManifestPath, surfaceLedgerPath].includes(file.path) && !/\.test\.[cm]?[jt]sx?$/.test(file.path)) {
    ROUTE_LITERAL_RULES.forEach((entry) => {
      entry.pattern.lastIndex = 0
      if (entry.pattern.test(source)) violations.push({ path, rule: entry.rule })
    })
  }

  if (/\.test\.[cm]?[jt]sx?$/.test(file.path)) return violations

  const transportRemoved =
    file.path === mainIndexPath
      ? source
          .replace(/arg\.startsWith\(\s*"opencode:\/\/"\s*\)/, "")
          .replace(/arg\.startsWith\(\s*"alpha-code:\/\/"\s*\)/, "")
      : file.path === alphaAuthPath
        ? source
            .replace(/const REDIRECT_URI = "alpha-code:\/\/auth\/callback"/, "")
            .replace(/parsed\.protocol !== "alpha-code:"/, "")
        : source

  if (/["'`](?:opencode|alpha-code):\/\//.test(transportRemoved)) {
    violations.push({ path, rule: "deep-link scheme literal outside the manifest or fixed transport boundary" })
  }
  if (/["'](?:opencode|alpha-code):["']/.test(transportRemoved)) {
    violations.push({ path, rule: "deep-link protocol literal outside the manifest or fixed auth boundary" })
  }

  const parsesUrl = /\bnew URL\s*\(/.test(source)
  const dispatchesHostname = /\.hostname\b/.test(source)
  const isDeepLinkIngress = file.path === mainIndexPath || file.path.includes(`${join(sourceRoot, "renderer")}/`)
  if (isDeepLinkIngress && parsesUrl && dispatchesHostname) {
    violations.push({ path, rule: "new URL plus hostname deep-link dispatch outside the manifest" })
  }

  return violations
}

async function alphaSources() {
  const paths = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: sourceRoot, absolute: true }))
  return Promise.all(
    paths
      .filter((path) => path !== ratchetPath)
      .sort()
      .map(async (path) => ({ path, source: await Bun.file(path).text() })),
  )
}

describe("Alpha route authority ratchet", () => {
  test("the detector bites on an out-of-manifest href and scheme parser", () => {
    const source = `
      const href = "/new-session?draftId=parallel"
      navigate(href)
      const parsed = new URL("opencode://new-session?directory=/tmp")
      if (parsed.hostname === "new-session") dispatch(parsed)
    `

    expect(violationsFor({ path: join(sourceRoot, "renderer/fixture.ts"), source }).map((entry) => entry.rule)).toEqual(
      [
        "href/to must use a manifest-derived href",
        "new-session path literals belong in the manifest",
        "deep-link scheme literal outside the manifest or fixed transport boundary",
        "new URL plus hostname deep-link dispatch outside the manifest",
      ],
    )
  })

  test("Alpha sources do not reintroduce a parallel route or deep-link codec", async () => {
    expect((await alphaSources()).flatMap(violationsFor)).toEqual([])
  })
})
