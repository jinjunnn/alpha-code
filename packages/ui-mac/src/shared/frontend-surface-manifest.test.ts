import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseRoute } from "./legacy-route-abi"
import {
  FRONTEND_SURFACE_MANIFEST,
  FRONTEND_SURFACE_MANIFEST_VERSION,
  frontendSurfaceIdForRoute,
  frontendSurfacesPendingReplacement,
} from "./frontend-surface-manifest"

describe("frontend surface manifest", () => {
  test("has one canonical entry per id and valid internal transition targets", () => {
    expect(FRONTEND_SURFACE_MANIFEST_VERSION).toBe(1)
    expect(new Set(FRONTEND_SURFACE_MANIFEST.map((surface) => surface.id)).size).toBe(
      FRONTEND_SURFACE_MANIFEST.length,
    )

    const ids = new Set<string>(FRONTEND_SURFACE_MANIFEST.map((surface) => surface.id))
    const external = new Set(["current-route", "application-exit"])
    expect(
      FRONTEND_SURFACE_MANIFEST.flatMap((surface) => surface.transitions)
        .map((transition) => transition.target)
        .filter((target) => !ids.has(target) && !external.has(target)),
    ).toEqual([])
  })

  test("keeps every source path anchored to a real implementation file", async () => {
    const root = resolve(import.meta.dir, "../../../..")
    expect(
      await Promise.all(
        FRONTEND_SURFACE_MANIFEST.map((surface) => Bun.file(resolve(root, surface.source)).exists()),
      ),
    ).toEqual(FRONTEND_SURFACE_MANIFEST.map(() => true))
  })

  test("maps the frozen route ABI into inspector surface ids", () => {
    expect(frontendSurfaceIdForRoute(parseRoute("/"))).toBe("route.home")
    expect(frontendSurfaceIdForRoute(parseRoute("/L3RtcC9hbHBoYQ"))).toBe("route.directory")
    expect(frontendSurfaceIdForRoute(parseRoute("/L3RtcC9hbHBoYQ/session"))).toBe("route.session-admission")
    expect(frontendSurfaceIdForRoute(parseRoute("/new-session?draftId=draft-1"))).toBe("route.new-session")
    expect(frontendSurfaceIdForRoute(parseRoute("/L3RtcC9hbHBoYQ/session/ses-1"))).toBe("route.session")
    expect(frontendSurfaceIdForRoute(parseRoute("/not/a/known/route"))).toBeUndefined()
  })

  test("covers all four composition mount kinds", () => {
    expect(new Set(FRONTEND_SURFACE_MANIFEST.map((surface) => surface.mount.kind))).toEqual(
      new Set(["route", "overlay", "inline", "boot"]),
    )
  })

  test("every surface declares a valid intended target lineage", () => {
    const valid = new Set(["alpha", "opencode", "hybrid"])
    expect(FRONTEND_SURFACE_MANIFEST.filter((surface) => !valid.has(surface.target))).toEqual([])
  })

  test("replacement backlog = surfaces whose target differs from current lineage", () => {
    // owner-ratified 2026-07-21: the four remaining hybrids are targeted for full alpha ownership.
    expect(new Set(frontendSurfacesPendingReplacement().map((surface) => surface.id))).toEqual(
      new Set(["route.session", "inline.composer", "inline.timeline", "overlay.dialog"]),
    )
  })
})
