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
  if (
    /\bSURFACE_RELEASE_STATES\b|\bALPHA_SURFACE_(?:HOME|NEW_SESSION|SESSION)\b|\balpha-surfaces-resolve\b/.test(source)
  ) {
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
 * What layout.tsx hands the consumer, and what it then does with it. Everything BETWEEN those
 * bindings and the navigation is executed and asserted in route-deep-link-consumer.test.ts; the
 * call site itself is the only stretch a test cannot reach into, because a wrapper here
 * (`navigate: (href) => go(href + "/wrong")`), a remapped input (`buffer: () => rewritten`), a
 * later override (a spread or a repeated key) or a consumer that is built and then never wired
 * would retarget — or silently disable — the navigation without any executed code changing.
 *
 * So this reads the call as STRUCTURE rather than as text: the deps are parsed into top-level
 * entries, anything that is not a plain `key: value` (a spread, a computed key) is surfaced, and
 * the binding is followed to its `onMount` uses. Whitespace and property order are therefore free;
 * overriding and detaching are not. Deps assembled somewhere else and passed in as a variable are
 * refused outright — they would put the wiring back out of reach, which is the thing this exists
 * to prevent.
 *
 * "The binding" has to mean a LEXICAL binding, not a name, or the whole judgement is a spelling
 * check: take the factory under a second name, keep the honest call as decoration, and re-declare
 * the same identifier inside `onMount` around a rewritten consumer — every name-based assertion
 * above still passes while the mounted consumer is a different function. Hence two rules with no
 * exceptions: the factory is only ever CALLED, never aliased, and the identifier it is bound to is
 * declared exactly once in the file.
 */
const CONSUMER_DEPS = ["enabled", "buffer", "openProject", "navigate", "handoff"] as const

const CONSUMER_FACTORY = "createDeepLinkConsumer"

/**
 * Blank out import statements, keeping every offset. Imports are the one place the factory's name
 * legitimately appears without being called, so they are removed before that rule is applied —
 * and an import that renames it (`… as buildConsumer`) then leaves zero calls, which is refused
 * by the same count.
 */
function withoutImports(source: string) {
  return source.replace(/^[ \t]*import[\s{][\s\S]*?(?:from[ \t]*["'][^"']*["']|["'][^"']*["'])[ \t]*;?/gm, (text) =>
    text.replace(/[^\n]/g, " "),
  )
}

/**
 * How many times `name` is BOUND in this source: a declaration, a function or arrow parameter, or
 * a catch clause. More than one means the uses below cannot be attributed to the consumer, because
 * two different variables answer to the same identifier. The parameter pattern requires the
 * closing paren to be followed by `=>` or `{` so that passing the consumer as an argument
 * (`makeEventListener(window, event, consumeDeepLinks)`) is not mistaken for re-binding it.
 */
function bindingsOf(source: string, name: string) {
  const patterns = [
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`, "g"),
    new RegExp(`\\((?:[^()]*,)?\\s*${name}\\s*(?:,[^()]*)?\\)\\s*(?:=>|\\{)`, "g"),
    new RegExp(`\\bcatch\\s*\\(\\s*${name}\\b`, "g"),
  ]
  return patterns.reduce((total, pattern) => total + (source.match(pattern) ?? []).length, 0)
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * Walk `body` outside strings and outside any bracket pair, reporting each top-level position.
 * Property order and line breaks are invisible to this; nesting and quoting are not.
 */
function scanTopLevel(body: string, visit: (char: string, index: number) => void) {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if ("([{".includes(char)) depth += 1
    else if (")]}".includes(char)) depth -= 1
    else if (depth === 0) visit(char, index)
  }
}

/** Split on commas that are not inside brackets, parentheses, braces, or a string. */
function splitTopLevel(body: string): string[] {
  const cuts: number[] = []
  scanTopLevel(body, (char, index) => {
    if (char === ",") cuts.push(index)
  })
  const parts: string[] = []
  let from = 0
  for (const cut of [...cuts, body.length]) {
    parts.push(normalize(body.slice(from, cut)))
    from = cut + 1
  }
  return parts.filter((part) => part.length > 0)
}

/** The `key: value` separator, ignoring colons inside a type annotation, ternary, or string. */
function topLevelColon(entry: string): number {
  let at = -1
  scanTopLevel(entry, (char, index) => {
    if (char === ":" && at === -1) at = index
  })
  return at
}

interface ConsumerWiring {
  /** The const the consumer is bound to — what `onMount` must actually use. */
  binding: string
  /** Top-level `key: value` deps, whitespace-normalized, in source order. */
  entries: { key: string; value: string }[]
  /** Everything that is not a plain named dep: spreads, computed keys, anything exotic. */
  foreign: string[]
  /**
   * Where the binding is used: as the wake-up listener, and as the mount-time first drain — plus
   * whether those two uses can be attributed to it at all, which they cannot if the identifier is
   * bound more than once in the file.
   */
  usage: { listener: boolean; invoked: boolean; singleBinding: boolean }
}

function deepLinkWiringIn(source: string): ConsumerWiring {
  const clean = withoutImports(withoutComments(source))
  const marker = `${CONSUMER_FACTORY}(`
  const calls = clean.split(marker).length - 1
  // Any mention of the factory that is not a call is an alias, and an alias is a second factory
  // this judgement cannot see: `const build = createDeepLinkConsumer` puts the real construction
  // beyond every rule below, including the count on this line.
  const mentions = clean.split(new RegExp(`\\b${CONSUMER_FACTORY}\\b`)).length - 1
  if (mentions !== calls) throw new Error(`${CONSUMER_FACTORY} must not be aliased, only called`)
  if (calls !== 1) throw new Error(`expected exactly one ${CONSUMER_FACTORY} call, found ${calls}`)
  const callAt = clean.indexOf(marker)

  // A const, so the wiring `onMount` uses below cannot be reassigned out from under it.
  const binding = /const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(clean.slice(0, callAt).trimEnd())?.[1]
  if (!binding) throw new Error("the deep-link consumer must be bound to a const at its call site")

  const open = clean.indexOf("{", callAt + marker.length)
  const argumentEnd = open === -1 ? Math.min(clean.length, callAt + marker.length + 40) : open
  const argument = normalize(clean.slice(callAt + marker.length, argumentEnd))
  if (argument !== "") throw new Error(`the consumer deps must be an inline object literal, found "${argument}"`)

  let depth = 0
  let end = -1
  for (let index = open; index < clean.length; index += 1) {
    if (clean[index] === "{") depth += 1
    else if (clean[index] === "}") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) throw new Error("unterminated createDeepLinkConsumer call")

  const entries: ConsumerWiring["entries"] = []
  const foreign: string[] = []
  for (const part of splitTopLevel(clean.slice(open + 1, end))) {
    const colon = topLevelColon(part)
    const key = colon === -1 ? part : normalize(part.slice(0, colon))
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      foreign.push(part)
      continue
    }
    entries.push({ key, value: colon === -1 ? key : normalize(part.slice(colon + 1)) })
  }

  // Line breaks and a trailing comma are free here too; what is pinned is that the very consumer
  // built above is the one subscribed to the wake-up event AND drained once at mount.
  const used = clean.slice(end)
  return {
    binding,
    entries,
    foreign,
    usage: {
      listener: new RegExp(`makeEventListener\\(\\s*window\\s*,\\s*deepLinkEvent\\s*,\\s*${binding}\\s*,?\\s*\\)`).test(
        used,
      ),
      invoked: new RegExp(`(^|[^\\w$.])${binding}\\s*\\(\\s*\\)`).test(used),
      // …and that both of those uses can only mean the const above, because nothing else in the
      // file answers to that name.
      singleBinding: bindingsOf(clean, binding) === 1,
    },
  }
}

/** The deps as a lookup, with duplicate keys kept visible rather than collapsed. */
const depsOf = (wiring: ConsumerWiring) => wiring.entries.map((entry) => entry.key)
const depValue = (wiring: ConsumerWiring, key: string) =>
  wiring.entries.filter((entry) => entry.key === key).map((entry) => entry.value)

describe("Alpha route authority ratchet", () => {
  test.each(["main", "renderer"])("the detector bites on an out-of-manifest href and scheme parser in %s", (layer) => {
    const source = `
      const href = "/new-session?draftId=parallel"
      navigate(href)
      app.setAsDefaultProtocolClient("alpha-code")
      const parsed = new URL("opencode://new-session?directory=/tmp")
      if (parsed.hostname === "new-session") dispatch(parsed)
    `

    expect(violationsFor({ path: join(sourceRoot, layer, "fixture.ts"), source }).map((entry) => entry.rule)).toEqual([
      "href/to must use a manifest-derived href",
      "new-session path literals belong in the manifest",
      "deep-link scheme literal outside the manifest",
      "new URL plus hostname deep-link dispatch outside the manifest",
    ])
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

  const HONEST_DEPS = `
    enabled: () => server.isLocal(),
    buffer: () => window,
    openProject: (directory, navigate) => void openProject(directory, navigate),
    navigate: navigateWithSidebarReset,
    handoff: (directory, prompt) => setSessionHandoff(directory, { prompt }),
  `

  const MOUNTED = `
    onMount(() => {
      makeEventListener(window, deepLinkEvent, consumeDeepLinks)
      consumeDeepLinks()
    })
  `

  const wiringOf = (deps: string, mount = MOUNTED) =>
    deepLinkWiringIn(`const consumeDeepLinks = createDeepLinkConsumer({${deps}})\n${mount}`)

  test("layout.tsx hands the consumer its own primitives, unwrapped and unmapped", async () => {
    // Fallback to the executable judgement, not a substitute for it: see route-deep-link-consumer.
    const wiring = deepLinkWiringIn(await Bun.file(upstreamLayoutFile).text())

    expect(wiring.foreign).toEqual([])
    expect(depsOf(wiring).sort()).toEqual([...CONSUMER_DEPS].sort())
    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(depValue(wiring, "buffer")).toEqual(["() => window"])
  })

  test("the consumer layout.tsx builds is the one it mounts", async () => {
    // Otherwise the honest deps above can sit next to a consumer nothing ever calls.
    const wiring = deepLinkWiringIn(await Bun.file(upstreamLayoutFile).text())
    expect(wiring.usage).toEqual({ listener: true, invoked: true, singleBinding: true })
  })

  test("reformatting and reordering the same wiring is not a violation", () => {
    // The judgement is structural, so equivalent source must stay green — a gate that reddens on
    // a line break teaches people to route around it.
    const wiring = wiringOf(`
      navigate:
        navigateWithSidebarReset,
      handoff: (directory, prompt) =>
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(base64Encode(directory))), {
          prompt,
        }),
      buffer: () =>
        window,
      enabled: () => server.isLocal(),
      openProject: (directory, navigate) => void openProject(directory, navigate),
    `)

    expect(wiring.foreign).toEqual([])
    expect(depsOf(wiring).sort()).toEqual([...CONSUMER_DEPS].sort())
    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(depValue(wiring, "buffer")).toEqual(["() => window"])
    expect(wiring.usage).toEqual({ listener: true, invoked: true, singleBinding: true })
  })

  test("the wiring pin bites on a wrapped navigate and on a remapped buffer", () => {
    const wiring = wiringOf(`
      enabled: () => server.isLocal(),
      buffer: () => rewritten(window),
      openProject: (directory, navigate) => void openProject(directory, navigate),
      navigate: (href) => navigateWithSidebarReset(href + "/wrong"),
      handoff: (directory, prompt) => setSessionHandoff(directory, { prompt }),
    `)

    expect(depValue(wiring, "navigate")).not.toEqual(["navigateWithSidebarReset"])
    expect(depValue(wiring, "buffer")).not.toEqual(["() => window"])
  })

  test("the wiring pin bites on a spread that overrides the honest deps", () => {
    // The mutation a "does the source contain these two lines" pin waves through: both lines are
    // still there, verbatim, and a later spread replaces what they bound.
    const wiring = wiringOf(`${HONEST_DEPS},
      ...{
        buffer: () => rewritten(window),
        navigate: (href) => navigateWithSidebarReset(rewrite(href)),
      },
    `)

    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"]) // the text pin sees nothing
    expect(wiring.foreign).toEqual([
      "...{ buffer: () => rewritten(window), navigate: (href) => navigateWithSidebarReset(rewrite(href)), }",
    ])
  })

  test("the wiring pin bites on a duplicate key that overrides the honest one", () => {
    const wiring = wiringOf(`${HONEST_DEPS},
      navigate: (href) => navigateWithSidebarReset(rewrite(href)),
    `)

    expect(depValue(wiring, "navigate")).toHaveLength(2)
    expect(depsOf(wiring).sort()).not.toEqual([...CONSUMER_DEPS].sort())
  })

  test("the wiring pin bites on a correct consumer that is never mounted", () => {
    // The other R3 bypass: keep the honest call site, then hand `onMount` something else.
    const wiring = wiringOf(
      HONEST_DEPS,
      `
      const noop = () => {}
      onMount(() => {
        makeEventListener(window, deepLinkEvent, noop)
        noop()
      })
    `,
    )

    expect(wiring.foreign).toEqual([])
    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(wiring.usage).toEqual({ listener: false, invoked: false, singleBinding: true })
  })

  test("deps assembled somewhere else are refused, not waved through", () => {
    // Accepted trade-off: hoisting the deps out would put the wiring back beyond reach, so it is
    // a hard error rather than a silent pass. The refusal names the reason.
    expect(() => deepLinkWiringIn("const consumeDeepLinks = createDeepLinkConsumer(deps)")).toThrow(
      /inline object literal/,
    )
  })

  test("a consumer that is not bound to a const is refused outright", () => {
    expect(() => deepLinkWiringIn("register(createDeepLinkConsumer({ a: 1 }))")).toThrow(/bound to a const/)
  })

  test("a second consumer call site is refused outright", () => {
    const doubled = "createDeepLinkConsumer({ a: 1 })\ncreateDeepLinkConsumer({ b: 2 })"
    expect(() => deepLinkWiringIn(doubled)).toThrow(/exactly one/)
  })

  test("taking the factory under a second name is refused, so the count cannot be dodged", () => {
    // Half of the R4 bypass: the alias is invisible to a count of `createDeepLinkConsumer(`, so
    // the honest call above stays the only one this judgement can see while a second consumer is
    // built from the same factory.
    const aliased = `
      const buildConsumer = createDeepLinkConsumer
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        const rewired = buildConsumer({ buffer: () => rewritten(window) })
        makeEventListener(window, deepLinkEvent, rewired)
        rewired()
      })
    `
    expect(() => deepLinkWiringIn(aliased)).toThrow(/must not be aliased/)
  })

  test("importing the factory under a second name leaves nothing to judge, and says so", () => {
    const renamed = `
      import { createDeepLinkConsumer as buildConsumer } from "./layout/deep-links"
      const consumeDeepLinks = buildConsumer({${HONEST_DEPS}})
    `
    expect(() => deepLinkWiringIn(renamed)).toThrow(/exactly one/)
  })

  test("re-declaring the same name inside onMount is a different binding, and is seen as one", () => {
    // The other half: every name-based assertion still passes — the deps are honest, `foreign` is
    // empty, and the identifier `onMount` subscribes and calls is spelled exactly right. It is
    // simply a different variable, which is why the judgement counts bindings and not spellings.
    const shadowed = deepLinkWiringIn(`
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        const consumeDeepLinks = () => elsewhere()
        makeEventListener(window, deepLinkEvent, consumeDeepLinks)
        consumeDeepLinks()
      })
    `)

    expect(shadowed.foreign).toEqual([])
    expect(depValue(shadowed, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(shadowed.usage).toEqual({ listener: true, invoked: true, singleBinding: false })
  })

  test("a parameter that shadows the binding is a re-binding too", () => {
    const shadowed = deepLinkWiringIn(`
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        withRewrittenBuffer((consumeDeepLinks) => {
          makeEventListener(window, deepLinkEvent, consumeDeepLinks)
          consumeDeepLinks()
        })
      })
    `)

    expect(shadowed.usage).toEqual({ listener: true, invoked: true, singleBinding: false })
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
