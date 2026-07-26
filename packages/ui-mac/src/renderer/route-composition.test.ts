import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ROUTE_MANIFEST, type RouteId } from "../shared/route-manifest"
import { composeRoutes, type RouteSurfaceId } from "./route-composition"

const mounts = {
  home: { owner: "alpha.home" },
  newSession: { owner: "alpha.new-session" },
  session: { owner: "alpha.session" },
  settings: { owner: "alpha.settings" },
  dialog: { owner: "alpha.dialog" },
  recovery: { owner: "alpha.recovery" },
} as const

const expectedSurfaces = {
  home: "home",
  directory: "newSession",
  "session-admission": "newSession",
  "new-session": "newSession",
  "legacy-session": "session",
  session: "session",
  settings: "settings",
  dialog: "dialog",
  recovery: "recovery",
} as const satisfies Record<RouteId, RouteSurfaceId>

describe("manifest-derived production route composition", () => {
  test("every manifest route resolves to exactly one matching surface mount", () => {
    const routes = composeRoutes(mounts)

    expect(Object.keys(routes)).toEqual(ROUTE_MANIFEST.routes.map((route) => route.id))
    ROUTE_MANIFEST.routes.forEach((route) => {
      const composition = routes[route.id]
      expect(composition.surface).toBe(expectedSurfaces[route.id])
      expect(composition.mount).toBe(mounts[composition.surface])
      expect(Object.keys(composition).sort()).toEqual(["mount", "routeId", "surface"])
    })
  })

  test("Home to Draft to Session and system history keep identity across back, forward, and reload", () => {
    const routes = composeRoutes(mounts)
    const history: RouteId[] = ["home", "new-session", "session", "settings", "dialog", "recovery"]
    const expected = ["home", "newSession", "session", "settings", "dialog", "recovery"]

    expect(history.map((routeId) => routes[routeId].surface)).toEqual(expected)
    expect(history.toReversed().map((routeId) => routes[routeId].surface)).toEqual(expected.toReversed())
    expect(history.map((routeId) => routes[routeId].mount)).toEqual(expected.map((surface) => mounts[surface]))

    const reloaded = composeRoutes(mounts)
    history.forEach((routeId) => {
      expect(reloaded[routeId].surface).toBe(routes[routeId].surface)
      expect(reloaded[routeId].mount).toBe(routes[routeId].mount)
    })
  })

  test("the real renderer entry uses one composition and keeps the upstream router at arm's length", async () => {
    const entry = await Bun.file(join(import.meta.dir, "index.tsx")).text()

    expect(entry.match(/const productionRoutes = composeRoutes\(/g)).toHaveLength(1)
    expect(entry.match(/router=\{MemoryRouter\}/g)).toHaveLength(1)
    expect(entry.match(/surfaces=\{surfaceComponents\(\)\}/g)).toHaveLength(1)
    // Each leaf is mounted unconditionally from the composition — no release gate can reappear
    // between the manifest and the seam.
    expect(entry).toContain("[productionRoutes.home.surface]: productionRoutes.home.mount(alphaProjects)")
    expect(entry).toContain(
      '[productionRoutes["new-session"].surface]: productionRoutes["new-session"].mount(alphaProjects)',
    )
    expect(entry).toContain("[productionRoutes.session.surface]: productionRoutes.session.mount(alphaProjects)")
    expect(entry).toContain("<SettingsSurface />")
    expect(entry).toContain("dialogHost={productionRoutes.dialog.mount}")
    expect(entry).toContain("<RecoverySurface />")
    expect(entry).not.toMatch(/surfaces\.(?:home|newSession|session)\s*=/)
  })
})
