import { describe, expect, test } from "bun:test"
import { FRONTEND_SURFACE_MANIFEST, frontendSurfaceById, type FrontendSurfaceId } from "../../shared/frontend-surface-manifest"
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
        "dev.surface-map",
      ]),
    )
    expect(FRONTEND_SURFACE_MANIFEST.length).toBeGreaterThan(10)
  })

  // REQ-126 AC3(#654):产物工作台下线时 `overlay.artifacts` 同时从 manifest 和这里消失。
  // 两处任一漏改,inspector 就会把一个不存在的 surface 标成 active,而那种不一致此前没有
  // 任何断言能看见 —— 故按「每一种覆盖层组合」枚举实际返回值,再逐个回查 canonical manifest。
  //
  // 真实回归形状 = 有人把 artifacts 开关**和**条件分支一起加回来。只枚举现签名的三个开关
  // 挡不住它(那种输入根本不带 artifacts,分支永远不进),所以必须额外喂一次 legacy 形状的
  // 输入。该文件被 packages/ui-mac/tsconfig.json 的 exclude 排除在 typecheck 外,故这里
  // 直接构造多余字段、用 as 送进生产函数。
  test("never reports a surface the canonical manifest does not define", () => {
    const routes: Array<FrontendSurfaceId | undefined> = [
      undefined,
      ...FRONTEND_SURFACE_MANIFEST.filter((surface) => surface.mount.kind === "route").map(
        (surface) => surface.id as FrontendSurfaceId,
      ),
    ]
    const flags = [false, true]
    const seen = new Set<string>()
    for (const route of routes)
      for (const extensions of flags)
        for (const automations of flags)
          for (const inspector of flags) {
            const overlays = { extensions, automations, inspector }
            for (const id of activeSurfaceIds(route, overlays)) seen.add(id)
            // legacy 形状:退役前的调用点长这样。分支若被恢复,这一路会把它点亮。
            const legacy = { ...overlays, artifacts: true } as unknown as Parameters<typeof activeSurfaceIds>[1]
            for (const id of activeSurfaceIds(route, legacy)) seen.add(id)
          }

    expect([...seen].filter((id) => !frontendSurfaceById(id))).toEqual([])
    // 反向:下线后没有任何输入组合(含 legacy 形状)能让 inspector 再点亮全页产物工作台。
    expect(seen.has("overlay.artifacts")).toBeFalse()
    // canonical manifest 侧的同一件事:该 surface 已不再被定义。
    expect(frontendSurfaceById("overlay.artifacts")).toBeUndefined()
  })
})
