import { SURFACE_RELEASE_STATES, type ResolvedSurfaces } from "../../shared/alpha-surfaces"
import {
  FRONTEND_SURFACE_MANIFEST,
  type FrontendSurfaceEntry,
  type FrontendSurfaceId,
  type FrontendSurfaceLineage,
} from "../../shared/frontend-surface-manifest"

export type SurfaceMapLineageFilter = "all" | FrontendSurfaceLineage
export type SurfaceMapMountFilter = "all" | FrontendSurfaceEntry["mount"]["kind"]

export function filterSurfaceMap(
  query: string,
  lineage: SurfaceMapLineageFilter,
  mount: SurfaceMapMountFilter,
): FrontendSurfaceEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  return FRONTEND_SURFACE_MANIFEST.filter((surface: FrontendSurfaceEntry) => {
    if (lineage !== "all" && surface.lineage !== lineage) return false
    if (mount !== "all" && surface.mount.kind !== mount) return false
    if (!needle) return true
    return [
      surface.id,
      surface.label,
      surface.description,
      surface.owner,
      surface.source,
      ...surface.entrypoints,
      ...surface.transitions.flatMap((transition) => [transition.label, transition.target]),
      ...(surface.mount.kind === "route" ? [surface.mount.path, surface.mount.host, surface.mount.role] : []),
      ...(surface.mount.kind === "overlay" ? [surface.mount.host] : []),
      ...(surface.mount.kind === "inline" ? [surface.mount.route, surface.mount.slot] : []),
      ...(surface.mount.kind === "boot" ? [surface.mount.host, surface.mount.phase] : []),
    ].some((value) => value.toLocaleLowerCase().includes(needle))
  })
}

export function surfaceRuntimeState(surface: FrontendSurfaceEntry, resolved?: ResolvedSurfaces | null) {
  if (!surface.releaseSurface)
    return {
      mode:
        surface.availability === "development"
          ? "仅开发"
          : surface.availability === "gated"
            ? "门控"
            : "静态挂载",
      detail: surface.availability,
      release: undefined,
    }
  if (!resolved)
    return {
      mode: "Legacy",
      detail: "resolver-error fallback",
      release: SURFACE_RELEASE_STATES[surface.releaseSurface],
    }
  return {
    mode: resolved[surface.releaseSurface].mode === "alpha" ? "Alpha" : "Legacy",
    detail: resolved[surface.releaseSurface].reason,
    release: SURFACE_RELEASE_STATES[surface.releaseSurface],
  }
}

export function activeSurfaceIds(
  route: FrontendSurfaceId | undefined,
  overlays: { extensions: boolean; automations: boolean; artifacts: boolean; inspector: boolean },
) {
  const ids = new Set<string>(["shell.sidebar", "inline.surface-recovery"])
  if (route) ids.add(route)
  if (route === "route.session") {
    ids.add("inline.composer")
    ids.add("inline.timeline")
    ids.add("inline.permission")
  }
  if (overlays.extensions) ids.add("overlay.extensions")
  if (overlays.automations) ids.add("overlay.automations")
  if (overlays.artifacts) ids.add("overlay.artifacts")
  if (overlays.inspector) ids.add("dev.surface-map")
  return ids
}
