import { describe, expect, test } from "bun:test"
import {
  ROUTE_MANIFEST,
  ROUTE_MANIFEST_VERSION,
  RouteManifestError,
  decodeDirectory,
  encodeDirectory,
  hrefFor,
  isDirectorySlug,
  navFor,
  parseRoute,
  resolveNavigation,
  routeIdentity,
  type Route,
  type RouteError,
  type RouteNavigation,
} from "./route-manifest"

const GOLDEN_DIRECTORIES = [
  { directory: "/Users/dev/proj", slug: "L1VzZXJzL2Rldi9wcm9q" },
  { directory: "C:\\Users\\dev\\proj", slug: "QzpcVXNlcnNcZGV2XHByb2o" },
  { directory: "/家/项目/试验", slug: "L-Wuti_pobnnm64v6K-V6aqM" },
  { directory: "/w s/~~~?>", slug: "L3cgcy9-fn4_Pg" },
  { directory: "/", slug: "Lw" },
] as const

function requireNavigation(result: RouteNavigation) {
  if (!result.ok) throw new Error(`expected route navigation, received ${result.error.code}`)
  return result
}

function requireFailure(route: Route): RouteError {
  if (route.kind !== "recovery" || !("error" in route)) throw new Error("expected fail-closed recovery route")
  expect(route.identity).toEqual({ manifestVersion: 1, routeId: "recovery", routeVersion: 1 })
  return route.error
}

describe("canonical route manifest", () => {
  test("has a versioned, unique identity and parameter schema for every formal route", () => {
    expect(ROUTE_MANIFEST_VERSION).toBe(1)
    expect(ROUTE_MANIFEST.version).toBe(ROUTE_MANIFEST_VERSION)
    expect(ROUTE_MANIFEST.routes.map((route) => route.id)).toEqual([
      "home",
      "directory",
      "session-admission",
      "new-session",
      "session",
      "settings",
      "dialog",
      "recovery",
    ])
    expect(new Set(ROUTE_MANIFEST.routes.map((route) => route.id)).size).toBe(ROUTE_MANIFEST.routes.length)
    expect(ROUTE_MANIFEST.routes.every((route) => route.version === 1)).toBe(true)
    expect(
      ROUTE_MANIFEST.routes.every((route) =>
        route.location.kind === "path"
          ? Array.isArray(route.location.path) && Array.isArray(route.location.query)
          : Array.isArray(route.location.params),
      ),
    ).toBe(true)

    const ids = new Set<string>(ROUTE_MANIFEST.routes.map((route) => route.id))
    expect(
      ROUTE_MANIFEST.routes.every(
        (route) => route.composition.kind !== "redirect" || ids.has(route.composition.routeId),
      ),
    ).toBe(true)
  })

  test("system pages have identities and a single non-URL leaf seam", () => {
    const fixtures = [
      { result: navFor.settings(), routeId: "settings" },
      { result: navFor.dialog(), routeId: "dialog" },
      { result: navFor.recovery(), routeId: "recovery" },
    ] as const
    fixtures.forEach((fixture) => {
      const navigation = requireNavigation(fixture.result)
      expect(navigation.href).toBeUndefined()
      expect(navigation.route.identity.routeId).toBe(fixture.routeId)
    })
  })
})

describe("directory codec golden values", () => {
  test.each([...GOLDEN_DIRECTORIES])("$directory encodes as $slug and round-trips", ({ directory, slug }) => {
    expect(encodeDirectory(directory)).toBe(slug)
    expect(decodeDirectory(slug)).toBe(directory)
  })

  test("rejects malformed, non-canonical, and invalid UTF-8 slugs", () => {
    Array.of("!!!not-base64!!!", "A", "Lw==", "Zh", "_w", "").forEach((slug) => {
      expect(decodeDirectory(slug)).toBeUndefined()
    })
  })

  test("shape validation recognizes only the codec alphabet", () => {
    expect(GOLDEN_DIRECTORIES.every((fixture) => isDirectorySlug(fixture.slug))).toBe(true)
    expect(isDirectorySlug("Lw==")).toBe(false)
    expect(isDirectorySlug("")).toBe(false)
  })
})

describe("manifest-derived parse, href, and navigation", () => {
  test("every URL route has a deterministic encode/decode identity round-trip", () => {
    const navigations = [
      navFor.home(),
      navFor.directory("/Users/dev/proj"),
      navFor.sessionAdmission("C:\\Users\\dev\\proj", "continue here & 中文"),
      navFor.sessionAdmission("/empty-prompt", ""),
      navFor.newSession("draft /? 1", "hello world & 中文?"),
      navFor.session("/家/项目/试验", "ses_/?: 123"),
    ]

    navigations.forEach((result) => {
      const navigation = requireNavigation(result)
      expect(navigation.href).toBeDefined()
      expect(parseRoute(navigation.href!)).toEqual(navigation.route)
      expect(routeIdentity(navigation.route)).toEqual(navigation.identity)
    })
  })

  test("golden hrefs retain the incumbent path shapes", () => {
    expect(hrefFor.home()).toBe("/")
    expect(hrefFor.directory("/Users/dev/proj")).toBe("/L1VzZXJzL2Rldi9wcm9q")
    expect(hrefFor.sessionAdmission("/Users/dev/proj")).toBe("/L1VzZXJzL2Rldi9wcm9q/session")
    expect(hrefFor.sessionAdmission("/Users/dev/proj", "continue here")).toBe(
      "/L1VzZXJzL2Rldi9wcm9q/session?prompt=continue%20here",
    )
    expect(hrefFor.session("/Users/dev/proj", "ses_123")).toBe("/L1VzZXJzL2Rldi9wcm9q/session/ses_123")
    expect(hrefFor.newSession("d 1", "a+b")).toBe("/new-session?draftId=d%201&prompt=a%2Bb")
    expect(hrefFor.newSession("d1")).toBe("/new-session?draftId=d1")
  })

  test("explicit search takes precedence over an embedded query", () => {
    expect(parseRoute("/new-session?draftId=ignored", "draftId=chosen")).toMatchObject({
      kind: "newSession",
      draftId: "chosen",
    })
  })
})

describe("fail-closed route recovery", () => {
  test("invalid directory", () => {
    expect(requireFailure(parseRoute("/!!!not-base64!!!/session/ses_1"))).toEqual({
      code: "invalid-directory",
      routeId: "session",
      param: "directory",
    })
  })

  test("missing required path or query parameter", () => {
    expect(requireFailure(parseRoute("/new-session"))).toEqual({
      code: "missing-param",
      routeId: "new-session",
      param: "draftId",
    })
    const result = resolveNavigation({
      manifestVersion: 1,
      routeVersion: 1,
      routeId: "session",
      params: { directory: "/tmp/project" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ code: "missing-param", routeId: "session", param: "sessionId" })
  })

  test("unknown route path or route identity", () => {
    const slug = encodeDirectory("/tmp/project")
    expect(requireFailure(parseRoute(`/${slug}/not-session`))).toEqual({ code: "unknown-route" })
    const result = resolveNavigation({ manifestVersion: 1, routeVersion: 1, routeId: "plugin-page" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ code: "unknown-route", routeId: "plugin-page" })
  })

  test("unknown future manifest and route versions are rejected", () => {
    const futureManifest = resolveNavigation({ manifestVersion: 2, routeVersion: 1, routeId: "home" })
    expect(futureManifest.ok).toBe(false)
    if (futureManifest.ok) return
    expect(futureManifest.error).toEqual({ code: "unsupported-manifest-version", receivedVersion: 2 })

    const futureRoute = resolveNavigation({ manifestVersion: 1, routeVersion: 2, routeId: "home" })
    expect(futureRoute.ok).toBe(false)
    if (futureRoute.ok) return
    expect(futureRoute.error).toEqual({ code: "unsupported-route-version", routeId: "home", receivedVersion: 2 })
  })

  test("corrupt deep links recover deterministically", () => {
    const slug = encodeDirectory("/tmp/project")
    Array.of(
      `/${slug}/session/%E0%A4%A`,
      "/new-session?draftId=%E0%A4%A",
      "/new-session?draftId=d&draftId=e",
      "/new-session?draftId=d&unknown=x",
      "/new-session?draftId=d#fragment",
      "new-session?draftId=d",
    ).forEach((link) => expect(requireFailure(parseRoute(link)).code).toBe("corrupt-deep-link"))
  })

  test("typed href helpers reject invalid runtime input rather than guessing", () => {
    expect(() => hrefFor.session("/tmp/project", "")).toThrow(RouteManifestError)
    expect(() => hrefFor.session("/tmp/project", "")).toThrow("route-manifest:missing-param:session:sessionId")
  })
})
