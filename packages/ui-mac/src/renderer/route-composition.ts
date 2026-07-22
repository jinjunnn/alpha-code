import { ROUTE_MANIFEST, type RouteId } from "../shared/route-manifest"

type ManifestRoute = (typeof ROUTE_MANIFEST.routes)[number]
export type RouteSurfaceId = Extract<ManifestRoute["composition"], { kind: "surface" }>["surface"]

type SurfaceForRoute<Id extends RouteId> = Extract<ManifestRoute, { id: Id }>["composition"] extends infer Composition
  ? Composition extends { kind: "surface"; surface: infer Surface extends RouteSurfaceId }
    ? Surface
    : Composition extends { kind: "redirect"; routeId: infer Target extends RouteId }
      ? SurfaceForRoute<Target>
      : never
  : never

export type ComposedRoutes<Surfaces extends Record<RouteSurfaceId, unknown>> = {
  readonly [Id in RouteId]: {
    readonly routeId: Id
    readonly surface: SurfaceForRoute<Id>
    readonly mount: Surfaces[SurfaceForRoute<Id>]
  }
}

/** Resolve every formal route, including redirect chains, to one production surface mount. */
export function composeRoutes<const Surfaces extends Record<RouteSurfaceId, unknown>>(surfaces: Surfaces) {
  return Object.fromEntries(
    ROUTE_MANIFEST.routes.map((route) => {
      const surface = resolveSurface(route.id, [])
      return [route.id, { routeId: route.id, surface, mount: surfaces[surface] }]
    }),
  ) as ComposedRoutes<Surfaces>
}

function resolveSurface(routeId: RouteId, lineage: readonly RouteId[]): RouteSurfaceId {
  if (lineage.includes(routeId)) throw new Error(`route composition cycle: ${[...lineage, routeId].join(" -> ")}`)
  const route = ROUTE_MANIFEST.routes.find((candidate) => candidate.id === routeId)
  if (!route) throw new Error(`route composition target is missing: ${routeId}`)
  if (route.composition.kind === "surface") return route.composition.surface
  return resolveSurface(route.composition.routeId, [...lineage, routeId])
}
