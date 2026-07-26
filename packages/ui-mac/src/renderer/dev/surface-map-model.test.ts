import { describe, expect, test } from "bun:test"
import { FRONTEND_SURFACE_MANIFEST, frontendSurfaceById } from "../../shared/frontend-surface-manifest"
import { activeSurfaceIds, filterSurfaceMap, surfaceRuntimeState } from "./surface-map-model"

describe("surface map model", () => {
  test("filters the canonical manifest by lineage, mount, and searchable route facts", () => {
    expect(filterSurfaceMap("", "alpha", "all").every((surface) => surface.lineage === "alpha")).toBeTrue()
    expect(filterSurfaceMap("", "all", "boot").map((surface) => surface.id)).toEqual(["boot.recovery"])
    expect(filterSurfaceMap("draftId", "all", "all").map((surface) => surface.id)).toContain("route.new-session")
    expect(filterSurfaceMap("alpha-permission-dialog", "all", "all").map((surface) => surface.id)).toContain(
      "inline.permission",
    )
  })

  test("route leaves report their single Alpha composition; other mounts report availability", () => {
    const home = frontendSurfaceById("route.home")
    const session = frontendSurfaceById("route.session")
    const inspector = frontendSurfaceById("dev.surface-map")
    if (!home || !session || !inspector) throw new Error("surface fixture missing from canonical manifest")

    expect(surfaceRuntimeState(home)).toEqual({ mode: "Alpha", detail: "home" })
    expect(surfaceRuntimeState(session)).toEqual({ mode: "Alpha", detail: "session" })
    expect(surfaceRuntimeState(inspector)).toEqual({ mode: "仅开发", detail: "development" })
  })

  test("marks the route, session inline mounts, and open overlays as active", () => {
    expect(
      activeSurfaceIds("route.session", {
        extensions: true,
        automations: false,
        artifacts: true,
        inspector: true,
      }),
    ).toEqual(
      new Set([
        "shell.sidebar",
        "inline.surface-recovery",
        "route.session",
        "inline.composer",
        "inline.timeline",
        "inline.permission",
        "overlay.extensions",
        "overlay.artifacts",
        "dev.surface-map",
      ]),
    )
    expect(FRONTEND_SURFACE_MANIFEST.length).toBeGreaterThan(10)
  })
})
