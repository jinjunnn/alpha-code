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

type RouteTag = { kind: "open" | "self"; path?: string } | { kind: "close" }

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

function scanRouteTags(source: string): RouteTag[] {
  const tags: RouteTag[] = []
  let cursor = 0
  while (cursor < source.length) {
    const open = source.indexOf("<Route", cursor)
    const close = source.indexOf("</Route>", cursor)
    if (open === -1 && close === -1) break
    if (close !== -1 && (open === -1 || close < open)) {
      tags.push({ kind: "close" })
      cursor = close + "</Route>".length
      continue
    }
    const nameEnd = open + "<Route".length
    // `<Routes …>` is the component that holds the tree, not a route.
    if (/[A-Za-z0-9_]/.test(source[nameEnd] ?? "")) {
      cursor = nameEnd
      continue
    }
    const end = tagEnd(source, nameEnd)
    if (end === -1) break
    const tag = source.slice(nameEnd, end)
    const path = /\bpath\s*=\s*"([^"]*)"/.exec(tag)?.[1]
    const selfClosing = /\/\s*$/.test(tag)
    tags.push({ kind: selfClosing ? "self" : "open", ...(path === undefined ? {} : { path }) })
    cursor = end + 1
  }
  return tags
}

function joinPath(prefix: string, path: string): string {
  const base = prefix === "/" ? "" : prefix
  if (path === "/") return base === "" ? "/" : base
  return `${base}${path}`
}

/** Leaf templates only: a `<Route>` with children matches through them, never on its own. */
export function upstreamRoutePathTemplates(source: string): string[] {
  const frames: { prefix: string; children: number }[] = []
  const templates: string[] = []
  for (const tag of scanRouteTags(source)) {
    if (tag.kind === "close") {
      const frame = frames.pop()
      if (frame && frame.children === 0) templates.push(frame.prefix)
      continue
    }
    const parent = frames[frames.length - 1]
    const prefix = parent?.prefix ?? ""
    if (parent) parent.children += 1
    const resolved = tag.path === undefined ? prefix : joinPath(prefix, tag.path)
    if (tag.kind === "open") frames.push({ prefix: resolved, children: 0 })
    else if (tag.path !== undefined) templates.push(resolved)
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

const manifestShapes = new Set(
  ROUTE_MANIFEST.routes.flatMap((entry) => {
    const template = manifestPathTemplate(entry)
    return template === undefined ? [] : shapesOf(template)
  }),
)

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
    expect(upstreamRoutePathTemplates(fixture).sort()).toEqual([
      "/",
      "/:dir",
      "/:dir/session/:id?",
      "/new-session",
    ])
    expect(shapesOf("/:dir/session/:id?")).toEqual(["/:param/session", "/:param/session/:param"])
  })

  test("upstream path shapes equal the manifest's declared path shapes", () => {
    const upstream = new Set(upstreamRoutePathTemplates(appTsx).flatMap(shapesOf))
    expect([...upstream].sort()).toEqual([...manifestShapes].sort())
  })

  test("the ratchet bites when upstream grows a path the manifest never declared", () => {
    const drifted = new Set(
      upstreamRoutePathTemplates(`${appTsx}\n<Route path="/experiment/:slug" component={X} />`).flatMap(shapesOf),
    )
    expect([...drifted].sort()).not.toEqual([...manifestShapes].sort())
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
