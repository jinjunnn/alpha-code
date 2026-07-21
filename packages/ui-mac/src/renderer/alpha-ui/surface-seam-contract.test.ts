// ADR-027/REQ-084 seam 存活契约(REQ-012 锚点测试同款形态)。
// 冻结的 packages/app 无法在 bun test 直接 import(vite `?worker&url` 依赖),故以源码锚点
// 钉死 typed surface seam 的不可回退结构:任何一次 re-freeze / restore 若丢失 seam,本文件
// 在权威门(alpha-check / alpha-ci 的 ui-mac 测试)先于运行时红掉。锚点变更 = seam 契约变更,
// 必须随 ADR-027 修订同步,不得静默改。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const APP_SRC = join(import.meta.dir, "../../../../app/src")
const appTsx = readFileSync(join(APP_SRC, "app.tsx"), "utf8")
const indexTs = readFileSync(join(APP_SRC, "index.ts"), "utf8")

describe("ADR-027 typed surface seam anchors (frozen packages/app)", () => {
  test("seam types exist", () => {
    expect(appTsx).toContain("export interface AppSurfaces")
    expect(appTsx).toContain("export type MaybePreloadableComponent")
    expect(appTsx).toContain("export interface DraftSurfaceProps")
    expect(appTsx).toContain("export type DraftSurfaceComponent")
    expect(appTsx).toContain("export interface PermissionSurfaceProps")
    expect(appTsx).toContain("export interface PermissionSurfaceClient")
  })

  test("AppInterface accepts surfaces and resolves leaves once before route mount", () => {
    expect(appTsx).toContain("surfaces?: AppSurfaces")
    expect(appTsx).toContain("props.surfaces?.home ?? HomeRoute")
    expect(appTsx).toContain("createSessionRoute(props.surfaces?.session ?? Session, props.surfaces?.permission)")
    expect(appTsx).toContain("createDraftRoute(props.surfaces?.newSession ??")
  })

  test("preload forwards only to the effective leaf", () => {
    expect(appTsx).toContain("preload: () => Leaf.preload?.()")
  })

  test("draft leaf gets the narrow lifecycle contract, wrappers keep tab semantics", () => {
    expect(appTsx).toContain("<Leaf draftId={props.draftID} promoteDraft={promoteDraft} />")
    expect(appTsx).toContain("tabs.promoteDraft(props.draftID, {")
  })

  test("provider wrappers keep default lifecycles around the injected leaves", () => {
    // session leaf 仍包在 SessionProviders;draft 叶仍包在 SDKProvider/DirectoryDataProvider/DraftProviders。
    expect(appTsx).toMatch(/<SessionProviders>\s*<Leaf \/>[\s\S]*PermissionSurface[\s\S]*<\/SessionProviders>/)
    expect(appTsx).toMatch(/<DraftProviders>\s*<Leaf draftId=/)
  })

  test("package public surface stays narrow (types only, no context/* bulk export)", () => {
    expect(indexTs).toContain("type AppSurfaces")
    expect(indexTs).toContain("type DraftSurfaceProps")
    expect(indexTs).not.toMatch(/export \* from ["']\.\/context/)
  })

  test("narrow session-leaf channel survives (REQ-088 C1, frontend-freeze-base-3)", () => {
    // exports map 恰好一条 surface 子路径,指向 session 叶源文件;不得扩成 ./surface/* 通配,
    // 也不得新增 pages/context 子路径(ADR-027 修订 2026-07-13,ADR-029 L3 逐案纪律)。
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../../app/package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["./surface/session"]).toBe("./src/pages/session.tsx")
    const surfaceSubpaths = Object.keys(pkg.exports).filter((key) => key.startsWith("./surface/"))
    expect(surfaceSubpaths).toEqual(["./surface/session"])
    expect(Object.keys(pkg.exports).some((key) => key.includes("pages") || key.includes("context"))).toBe(false)
    // 该模块仅有 default 一个导出(session Page 组件)—— 窄面的可机械验证形态。
    const sessionLeaf = readFileSync(join(APP_SRC, "pages/session.tsx"), "utf8")
    expect(sessionLeaf).toContain("export default function Page()")
  })
})
