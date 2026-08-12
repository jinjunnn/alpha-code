import { describe, expect, test } from "bun:test"
import {
  ROUTE_MANIFEST,
  ROUTE_MANIFEST_VERSION,
  RouteManifestError,
  decodeDeepLink,
  deepLinkFor,
  decodeDirectory,
  encodeDirectory,
  hrefFor,
  isDirectorySlug,
  isDeepLink,
  matchAuthDeepLink,
  navFor,
  parseDeepLink,
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
    expect(ROUTE_MANIFEST.deepLinks.schemes).toEqual([
      { id: "application", value: "opencode" },
      { id: "auth", value: "alpha-code" },
    ])
    expect(
      ROUTE_MANIFEST.deepLinks.routes.map((route) => ({
        id: route.id,
        scheme: route.scheme,
        routeId: route.routeId,
        query: route.location.query.map((parameter) => parameter.name),
      })),
    ).toEqual([
      {
        id: "new-session",
        scheme: "application",
        routeId: "session-admission",
        query: ["directory", "prompt"],
      },
      { id: "open-project", scheme: "application", routeId: "directory", query: ["directory"] },
    ])
    expect(ROUTE_MANIFEST.routes.map((route) => route.id)).toEqual([
      "home",
      "directory",
      "session-admission",
      "new-session",
      "legacy-session",
      "session",
      "settings",
      "dialog",
      "recovery",
    ])
    expect(new Set(ROUTE_MANIFEST.routes.map((route) => route.id)).size).toBe(ROUTE_MANIFEST.routes.length)
    expect(Object.fromEntries(ROUTE_MANIFEST.routes.map((route) => [route.id, route.version]))).toEqual({
      home: 1,
      directory: 1,
      "session-admission": 1,
      "new-session": 1,
      "legacy-session": 1,
      session: 2,
      settings: 1,
      dialog: 1,
      recovery: 1,
    })
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

describe("manifest-derived deep links", () => {
  test("new-session parses through the shared location codec into the URL route", () => {
    const result = parseDeepLink(
      "opencode://new-session?directory=%2FUsers%2Fdev%2Fproj&prompt=continue%20here%20%26%20%E4%B8%AD%E6%96%87",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.identity).toEqual({
      manifestVersion: 1,
      deepLinkId: "new-session",
      deepLinkVersion: 1,
      routeId: "session-admission",
    })
    expect(result.route).toEqual(parseRoute(hrefFor.sessionAdmission("/Users/dev/proj", "continue here & 中文")))
    expect(result.routeHref).toBe(hrefFor.sessionAdmission("/Users/dev/proj", "continue here & 中文"))
    expect(result.href).toBe(deepLinkFor.newSession("/Users/dev/proj", "continue here & 中文"))
  })

  test("open-project parses through the same codec into the directory route", () => {
    const result = parseDeepLink("opencode://open-project?directory=C%3A%5CUsers%5Cdev%5Cproj")
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.identity).toEqual({
      manifestVersion: 1,
      deepLinkId: "open-project",
      deepLinkVersion: 1,
      routeId: "directory",
    })
    expect(result.route).toEqual(parseRoute(hrefFor.directory("C:\\Users\\dev\\proj")))
    expect(result.routeHref).toBe(hrefFor.directory("C:\\Users\\dev\\proj"))
    expect(result.href).toBe(deepLinkFor.openProject("C:\\Users\\dev\\proj"))
  })

  test("deep-link href and parse round-trip without a parallel parser", () => {
    const fixtures = [
      deepLinkFor.newSession("/家/项目", "build this + that"),
      deepLinkFor.newSession("/tmp/empty-prompt", ""),
      deepLinkFor.openProject("/w s/project"),
    ]

    expect(fixtures.every(isDeepLink)).toBe(true)
    fixtures.forEach((href) => {
      const parsed = parseDeepLink(href)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.href).toBe(href)
      expect(parseRoute(parsed.routeHref)).toEqual(parsed.route)
    })
    expect(isDeepLink("https://example.com/new-session")).toBe(false)
  })

  test("auth transport scheme and callback endpoint are manifest-derived", () => {
    expect(deepLinkFor.authCallback()).toBe("alpha-code://auth/callback")
    const callback = matchAuthDeepLink("alpha-code://auth/callback?code=one&state=two")
    expect(callback.kind).toBe("callback")
    if (callback.kind !== "callback") return
    expect(callback.url.searchParams.get("code")).toBe("one")
    expect(matchAuthDeepLink("alpha-code://other/path")).toEqual({ kind: "ignored", path: "other/path" })
    expect(matchAuthDeepLink(deepLinkFor.openProject("/tmp"))).toEqual({ kind: "outside" })
  })

  test("unknown, malformed, and schema-breaking links fail closed", () => {
    Array.of(
      "opencode://unknown?directory=%2Ftmp",
      "opencode://new-session",
      "opencode://new-session?directory=%2Ftmp&directory=%2Fother",
      "opencode://open-project?directory=%E0%A4%A",
      "opencode://open-project?directory=%2Ftmp&prompt=unexpected",
      "opencode://open-project?directory=%2Ftmp#fragment",
    ).forEach((link) => expect(parseDeepLink(link).ok).toBe(false))
  })
})

describe("decoded deep-link deliveries", () => {
  // What Alpha main forwards to the renderer. The href must be exactly what a consumer would
  // otherwise hand-build, because that hand-building is what this delivery replaces.
  test("both declared deep links decode into a delivery carrying a manifest-derived href", () => {
    expect(decodeDeepLink("opencode://open-project?directory=%2Ftmp%2Fdemo")).toEqual({
      deepLinkId: "open-project",
      routeId: "directory",
      directory: "/tmp/demo",
      href: hrefFor.directory("/tmp/demo"),
    })
    expect(decodeDeepLink("opencode://new-session?directory=%2Ftmp%2Fdemo")).toEqual({
      deepLinkId: "new-session",
      routeId: "session-admission",
      directory: "/tmp/demo",
      href: hrefFor.sessionAdmission("/tmp/demo"),
    })
    expect(decodeDeepLink("opencode://new-session?directory=%2Ftmp%2Fdemo&prompt=hello%20world")).toEqual({
      deepLinkId: "new-session",
      routeId: "session-admission",
      directory: "/tmp/demo",
      prompt: "hello world",
      href: hrefFor.sessionAdmission("/tmp/demo", "hello world"),
    })
  })

  test("anything the manifest does not recognise decodes to nothing at the boundary", () => {
    Array.of(
      "opencode://other?directory=%2Ftmp",
      "https://example.com",
      "opencode://open-project",
      "opencode://open-project?directory=",
      "opencode://open-project?directory=%2Ftmp&unknown=x",
      "opencode://open-project/%E0%A4%A%",
      "alpha-code://auth/callback",
      "not a url",
    ).forEach((link) => expect(decodeDeepLink(link)).toBeUndefined())
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
      // #933:legacy-session 的便捷产生器已撤;round-trip 仍要覆盖这条 parse 条目(存量 URL
      // 还会进来),用显式 reference 造 —— 造 legacy 形状从此只剩这条需要解释的路。
      navFor.route({
        manifestVersion: 1,
        routeVersion: 1,
        routeId: "legacy-session",
        params: { directory: "/家/项目/试验", sessionId: "ses_/?: 123" },
      }),
      navFor.session("sidecar", "ses_/?: 123"),
    ]

    navigations.forEach((result) => {
      const navigation = requireNavigation(result)
      expect(navigation.href).toBeDefined()
      expect(parseRoute(navigation.href!)).toEqual(navigation.route)
      expect(routeIdentity(navigation.route)).toEqual(navigation.identity)
    })
  })

  test("golden hrefs retain legacy compatibility and encode the canonical v2 target route", () => {
    expect(hrefFor.home()).toBe("/")
    expect(hrefFor.directory("/Users/dev/proj")).toBe("/L1VzZXJzL2Rldi9wcm9q")
    expect(hrefFor.sessionAdmission("/Users/dev/proj")).toBe("/L1VzZXJzL2Rldi9wcm9q/session")
    expect(hrefFor.sessionAdmission("/Users/dev/proj", "continue here")).toBe(
      "/L1VzZXJzL2Rldi9wcm9q/session?prompt=continue%20here",
    )
    // `#925`:`hrefFor` 里**故意没有** legacySession —— legacy 形状不带 server 段,是 `#894`/`#925`
    // 那个「落到没有该会话的机器」缺陷的产生器。这里正向钉住「它不在」,否则谁顺手加回来无人变红。
    expect("legacySession" in hrefFor).toBe(false)
    // `#933`:`navFor` 里同样没有 —— packages/app 的三个生产者已迁 canonical,便捷产生器全撤。
    expect("legacySession" in navFor).toBe(false)
    // 解析归解析:存量 legacy URL(升级前的 OS 通知等)仍要认得出来,只是造不出来。
    expect(parseRoute("/L1VzZXJzL2Rldi9wcm9q/session/ses_123")).toMatchObject({
      kind: "session",
      directory: "/Users/dev/proj",
      id: "ses_123",
    })
    expect(hrefFor.session("sidecar", "ses_123")).toBe("/server/c2lkZWNhcg/session/ses_123")
    expect(hrefFor.newSession("d 1", "a+b")).toBe("/new-session?draftId=d%201&prompt=a%2Bb")
    expect(hrefFor.newSession("d1")).toBe("/new-session?draftId=d1")
  })

  test("v2 target route parses the real serverKey/sessionID pair without inventing a directory", () => {
    expect(parseRoute("/server/c2lkZWNhcg/session/ses_123")).toEqual({
      kind: "session",
      identity: {
        manifestVersion: 1,
        routeId: "session",
        routeVersion: 2,
      },
      serverKey: "sidecar",
      id: "ses_123",
    })
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
      routeId: "legacy-session",
      param: "directory",
    })
  })

  test("invalid v2 server key fails closed", () => {
    expect(requireFailure(parseRoute("/server/!!!not-base64!!!/session/ses_1"))).toEqual({
      code: "corrupt-deep-link",
      routeId: "session",
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
      routeVersion: 2,
      routeId: "session",
      params: { serverKey: "sidecar" },
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

    const legacySessionIdentity = resolveNavigation({
      manifestVersion: 1,
      routeVersion: 1,
      routeId: "session",
      params: { serverKey: "sidecar", sessionId: "ses_1" },
    })
    expect(legacySessionIdentity.ok).toBe(false)
    if (legacySessionIdentity.ok) return
    expect(legacySessionIdentity.error).toEqual({
      code: "unsupported-route-version",
      routeId: "session",
      receivedVersion: 1,
    })
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
    expect(() => hrefFor.session("sidecar", "")).toThrow(RouteManifestError)
    expect(() => hrefFor.session("sidecar", "")).toThrow("route-manifest:missing-param:session:sessionId")
  })
})
