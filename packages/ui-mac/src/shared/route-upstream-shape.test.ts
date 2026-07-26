// Upstream path-shape ratchet (REQ-089 基线 §2 的红旗对策)。
//
// 上游 `packages/app/src/app.tsx` 仍然拥有那棵 `<Route>` 树。把整棵树(含 provider / layout 嵌套)
// 镜像进 manifest 是每次上游 bump 都要重新对表的 re-sync 无底洞,基线明确否决。本文件只钉**一层
// seam**:上游暴露的 **path 形状集合** == manifest 声明的 path 形状集合。上游改了路由形状 → 这里
// 响亮地红;上游改了 provider / layout / 组件 → 这里一声不吭。
//
// 只比形状,不比参数名:上游写 `:dir` / `:id`,manifest 写 `:directory` / `:sessionId`,两边都是
// 自己那侧的命名权;可选段 `:id?` 展开成「有 / 无」两条,因为它同时覆盖两个 manifest 路由。
// 形态沿用仓内已有的源码锚点范式(renderer/alpha-ui/surface-seam-contract.test.ts)。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEEP_LINK_EVENT, ROUTE_MANIFEST, manifestPathTemplate } from "./route-manifest"

const APP_SRC = join(import.meta.dir, "../../../app/src")
const appTsx = readFileSync(join(APP_SRC, "app.tsx"), "utf8")
const deepLinksTs = readFileSync(join(APP_SRC, "pages/layout/deep-links.ts"), "utf8")

type RouteTag =
  | { kind: "open" | "self"; path?: string }
  | { kind: "close" }
  | { kind: "show-open" | "show-self"; guard: string }
  | { kind: "show-close" }

/** Find the `>` that closes an opening tag, skipping strings and `{…}` expression children. */
function tagEnd(source: string, from: number): number {
  let depth = 0
  let index = from
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      index += 1
      while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1
      index += 1
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") depth -= 1
    else if (char === ">" && depth === 0) return index
    index += 1
  }
  return -1
}

/** The next `<Route`/`</Route>`/`<Show`/`</Show>` at or after `from`, whichever comes first. */
function nextMarker(source: string, from: number) {
  const candidates = (["<Route", "</Route>", "<Show", "</Show>"] as const)
    .map((token) => ({ token, at: source.indexOf(token, from) }))
    .filter((entry) => entry.at !== -1)
    .sort((a, b) => a.at - b.at)
  return candidates[0]
}

function scanRouteTags(source: string): RouteTag[] {
  const tags: RouteTag[] = []
  let cursor = 0
  while (cursor < source.length) {
    const marker = nextMarker(source, cursor)
    if (!marker) break
    if (marker.token === "</Route>" || marker.token === "</Show>") {
      tags.push({ kind: marker.token === "</Route>" ? "close" : "show-close" })
      cursor = marker.at + marker.token.length
      continue
    }
    const nameEnd = marker.at + marker.token.length
    // `<Routes …>` is the component that holds the tree, not a route; same for `<ShowSomething>`.
    if (/[A-Za-z0-9_]/.test(source[nameEnd] ?? "")) {
      cursor = nameEnd
      continue
    }
    const end = tagEnd(source, nameEnd)
    if (end === -1) break
    const tag = source.slice(nameEnd, end)
    const selfClosing = /\/\s*$/.test(tag)
    if (marker.token === "<Show") {
      tags.push({ kind: selfClosing ? "show-self" : "show-open", guard: whenExpression(tag) })
    } else {
      const path = /\bpath\s*=\s*"([^"]*)"/.exec(tag)?.[1]
      tags.push({ kind: selfClosing ? "self" : "open", ...(path === undefined ? {} : { path }) })
    }
    cursor = end + 1
  }
  return tags
}

/** The `when={…}` expression text of a `<Show>` opening tag, brace-balanced. */
function whenExpression(tag: string): string {
  const at = /\bwhen\s*=\s*\{/.exec(tag)
  if (!at) return ""
  let index = at.index + at[0].length
  let depth = 1
  const start = index
  while (index < tag.length && depth > 0) {
    if (tag[index] === "{") depth += 1
    else if (tag[index] === "}") depth -= 1
    index += 1
  }
  return tag.slice(start, index - 1).trim()
}

function joinPath(prefix: string, path: string): string {
  const base = prefix === "/" ? "" : prefix
  if (path === "/") return base === "" ? "/" : base
  return `${base}${path}`
}

/**
 * Feature flags a `<Show>` in the Route tree may branch on. Mutually exclusive branches are the
 * reason a single global set of paths is not a contract: `newLayoutDesigns` publishes one `/` and
 * the legacy branch publishes another, so losing one of them leaves the union untouched. Each
 * branch is therefore extracted and compared on its own.
 */
export type RouteFeatureFlags = { newLayoutDesigns: boolean }

/**
 * The complete set of guard expressions that may gate a Route, written out exactly as upstream
 * writes them. This is a whitelist, not a pattern: matching a SUFFIX would read
 * `someNewExperiment() && newLayoutDesigns()` as a plain `newLayoutDesigns()` guard and publish a
 * branch that upstream does not, which is the failure mode this table exists to prevent.
 */
const DECLARED_GUARDS: Readonly<Record<string, keyof RouteFeatureFlags>> = {
  "settings.general.newLayoutDesigns()": "newLayoutDesigns",
}

/**
 * Evaluate a `<Show when={…}>` guard under one flag assignment. Only an exactly declared guard —
 * optionally with a single leading `!` — resolves; every other expression, INCLUDING any `&&` /
 * `||` / ternary combination that happens to mention a declared flag, throws. A new feature branch
 * must be declared above before it may gate a route.
 */
function guardHolds(guard: string, flags: RouteFeatureFlags): boolean {
  const trimmed = guard.trim()
  const negated = trimmed.startsWith("!")
  // Whitespace inside the call (`newLayoutDesigns ()`) is upstream's formatting, not a different
  // guard; anything else must match the declared text character for character.
  const expression = (negated ? trimmed.slice(1) : trimmed).replace(/\s+/g, "")
  const flag = DECLARED_GUARDS[expression]
  if (flag === undefined) throw new Error(`unrecognised <Show> guard gating a Route: ${guard}`)
  return negated ? !flags[flag] : flags[flag]
}

/**
 * Leaf templates only: a `<Route>` with children matches through them, never on its own.
 * Routes gated by a `<Show>` whose guard is false under `flags` are not published at all.
 */
export function upstreamRoutePathTemplates(source: string, flags: RouteFeatureFlags): string[] {
  const frames: { prefix: string; children: number; visible: boolean }[] = []
  const guards: string[] = []
  const templates: string[] = []
  // A `<Show>` whose guard is false hides the routes inside it, but the JSX still has to be
  // walked so the Route frames stay balanced — hence "hidden" rather than "skipped".
  const visible = () => guards.every((guard) => guardHolds(guard, flags))
  for (const tag of scanRouteTags(source)) {
    if (tag.kind === "show-open") {
      guards.push(tag.guard)
      continue
    }
    if (tag.kind === "show-close") {
      guards.pop()
      continue
    }
    if (tag.kind === "show-self") continue
    if (tag.kind === "close") {
      const frame = frames.pop()
      if (frame && frame.children === 0 && frame.visible) templates.push(frame.prefix)
      continue
    }
    const parent = frames[frames.length - 1]
    const prefix = parent?.prefix ?? ""
    if (parent) parent.children += 1
    const resolved = tag.path === undefined ? prefix : joinPath(prefix, tag.path)
    const shown = visible()
    if (tag.kind === "open") frames.push({ prefix: resolved, children: 0, visible: shown })
    else if (tag.path !== undefined && shown) templates.push(resolved)
  }
  return templates
}

function expandOptional(segments: string[]): string[][] {
  const index = segments.findIndex((segment) => segment.startsWith(":") && segment.endsWith("?"))
  if (index === -1) return [segments]
  const without = [...segments.slice(0, index), ...segments.slice(index + 1)]
  const required = segments.map((segment, at) => (at === index ? segment.slice(0, -1) : segment))
  return [...expandOptional(without), ...expandOptional(required)]
}

/** Parameter names belong to each side; only the segment layout is contracted. */
function shapesOf(template: string): string[] {
  const segments = template === "/" ? [] : template.replace(/^\//, "").split("/")
  return expandOptional(segments).map(
    (variant) => `/${variant.map((segment) => (segment.startsWith(":") ? ":param" : segment)).join("/")}`,
  )
}

const manifestShapes = [
  ...new Set(
    ROUTE_MANIFEST.routes.flatMap((entry) => {
      const template = manifestPathTemplate(entry)
      return template === undefined ? [] : shapesOf(template)
    }),
  ),
].sort()

/** Every mutually exclusive feature branch the Route tree can be in. */
const FEATURE_BRANCHES: { name: string; flags: RouteFeatureFlags }[] = [
  { name: "legacy layout", flags: { newLayoutDesigns: false } },
  { name: "new layout designs", flags: { newLayoutDesigns: true } },
]

const shapesFor = (source: string, flags: RouteFeatureFlags) =>
  [...new Set(upstreamRoutePathTemplates(source, flags).flatMap(shapesOf))].sort()

describe("upstream Route tree keeps the manifest's path shapes", () => {
  test("the extractor flattens nesting, optional params, and self-closing tags", () => {
    const fixture = `
      <Routes>
        <Route component={(props) => <Shell>{props.children}</Shell>}>
          <Route path="/" component={Home} />
          <Route path="/:dir" component={Layout}>
            <Route path="/" component={() => <Navigate href="session" />} />
            <Route path="/session/:id?" component={Session} />
          </Route>
        </Route>
        <Route path="/new-session" component={Draft} />
      </Routes>
    `
    expect(upstreamRoutePathTemplates(fixture, { newLayoutDesigns: false }).sort()).toEqual([
      "/",
      "/:dir",
      "/:dir/session/:id?",
      "/new-session",
    ])
    expect(shapesOf("/:dir/session/:id?")).toEqual(["/:param/session", "/:param/session/:param"])
  })

  test("the extractor publishes only the routes of the active feature branch", () => {
    const fixture = `
      <Show when={!settings.general.newLayoutDesigns()}>
        <Route path="/" component={LegacyHome} />
      </Show>
      <Show when={settings.general.newLayoutDesigns()}>
        <Route path="/" component={Home} />
        <Route path="/lab" component={Lab} />
      </Show>
    `
    expect(upstreamRoutePathTemplates(fixture, { newLayoutDesigns: false })).toEqual(["/"])
    expect(upstreamRoutePathTemplates(fixture, { newLayoutDesigns: true })).toEqual(["/", "/lab"])
  })

  test("a <Show> guard nobody declared cannot silently gate a route", () => {
    const fixture = `
      <Show when={settings.general.someNewExperiment()}>
        <Route path="/" component={Home} />
      </Show>
    `
    expect(() => upstreamRoutePathTemplates(fixture, { newLayoutDesigns: true })).toThrow(/unrecognised/)
  })

  test.each([
    "settings.general.someNewExperiment() && settings.general.newLayoutDesigns()",
    "settings.general.newLayoutDesigns() && settings.general.someNewExperiment()",
    "settings.general.newLayoutDesigns() || settings.general.someNewExperiment()",
    "!settings.general.someNewExperiment() && settings.general.newLayoutDesigns()",
    "settings.general.someNewExperiment() ? settings.general.newLayoutDesigns() : false",
    "props.ready && settings.general.newLayoutDesigns()",
    "settings.general.newLayoutDesigns() && !settings.general.newLayoutDesigns()",
  ])("a guard combination is never read as the declared flag alone: %s", (guard) => {
    // The mutation the previous suffix regex let through: a second, undeclared condition tacked
    // onto a declared flag published a branch upstream may not publish, and the shape comparison
    // stayed green. Undecidable ⇒ throw, never "close enough".
    const fixture = `
      <Show when={${guard}}>
        <Route path="/experiment" component={X} />
      </Show>
    `
    for (const branch of FEATURE_BRANCHES)
      expect(() => upstreamRoutePathTemplates(fixture, branch.flags)).toThrow(/unrecognised/)
  })

  test("the declared guard still resolves in both polarities, whitespace and all", () => {
    const fixture = `
      <Show when={!settings.general.newLayoutDesigns()}>
        <Route path="/legacy" component={LegacyHome} />
      </Show>
      <Show when={ settings.general.newLayoutDesigns() }>
        <Route path="/next" component={Home} />
      </Show>
    `
    expect(upstreamRoutePathTemplates(fixture, { newLayoutDesigns: false })).toEqual(["/legacy"])
    expect(upstreamRoutePathTemplates(fixture, { newLayoutDesigns: true })).toEqual(["/next"])
  })

  test.each(FEATURE_BRANCHES)("$name publishes exactly the manifest's declared path shapes", ({ flags }) => {
    // Per branch, not per union: a route that only one branch publishes must be present in that
    // branch. Comparing the union would let a route move from one branch to the other unseen.
    expect(shapesFor(appTsx, flags)).toEqual(manifestShapes)
  })

  test("the ratchet bites when upstream grows a path the manifest never declared", () => {
    const drifted = `${appTsx}\n<Route path="/experiment/:slug" component={X} />`
    for (const branch of FEATURE_BRANCHES) expect(shapesFor(drifted, branch.flags)).not.toEqual(manifestShapes)
  })

  test("the ratchet bites when a route moves between mutually exclusive branches", () => {
    // The exact mutation a global path set could not see: the new-layout home route becomes
    // /new-session, which the legacy branch and the draft route both still publish.
    const moved = appTsx.replace(
      '<Route path="/" component={HomeLeaf} />\n        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />',
      '<Route path="/new-session" component={HomeLeaf} />\n        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />',
    )
    expect(moved).not.toEqual(appTsx) // the mutation actually applied
    expect(shapesFor(moved, { newLayoutDesigns: false })).toEqual(manifestShapes)
    expect(shapesFor(moved, { newLayoutDesigns: true })).not.toEqual(manifestShapes)
  })
})

describe("deep-link transport contract stays anchored across the package boundary", () => {
  // packages/app cannot import Alpha's manifest, so it carries the event name as a literal.
  // Anchoring it here is what keeps the two copies from drifting silently.
  test("the upstream listener uses the manifest's event name", () => {
    expect(deepLinksTs).toContain(`"${DEEP_LINK_EVENT}"`)
  })

  test("the upstream module consumes decoded deliveries instead of parsing URLs", () => {
    expect(deepLinksTs).not.toContain("new URL")
    expect(deepLinksTs).not.toContain("://")
    expect(deepLinksTs).not.toContain(".hostname")
    expect(deepLinksTs).not.toContain("searchParams")
  })
})
