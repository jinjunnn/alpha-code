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

  test("permission surface reuses the existing SSE reconnect signal", () => {
    expect(appTsx).toContain('sdk().event.on("server.connected", listeners.connected)')
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
    // exports map 的 surface 子路径恰好两条(逐案评审的窄导出),指向源文件;不得扩成
    // ./surface/* 通配,也不得新增 pages/context 子路径(ADR-027 修订 2026-07-13/2026-07-24,
    // ADR-029 L3 逐案纪律)。
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../../app/package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["./surface/session"]).toBe("./src/pages/session.tsx")
    const surfaceSubpaths = Object.keys(pkg.exports).filter((key) => key.startsWith("./surface/"))
    expect(surfaceSubpaths).toEqual(["./surface/session", "./surface/terminal"])
    expect(Object.keys(pkg.exports).some((key) => key.includes("pages") || key.includes("context"))).toBe(false)
    // 该模块仅有 default 一个导出(session Page 组件)—— 窄面的可机械验证形态。
    const sessionLeaf = readFileSync(join(APP_SRC, "pages/session.tsx"), "utf8")
    expect(sessionLeaf).toContain("export default function Page()")
  })

  test("session-surface titlebar ownership stays fail-closed (REQ-125 #574, 单一顶栏)", () => {
    // 标记形态:surface 组件上的静态可选字段;判定严格 === true,缺席 = 上游 Titlebar 原样
    // (上游面零回归的机械保证)。
    expect(appTsx).toContain("ownsTitlebar?: boolean")
    expect(appTsx).toContain("const sessionOwnsTitlebar = props.surfaces?.session?.ownsTitlebar === true")
    expect(appTsx).toContain("sessionOwnsTitlebar={sessionOwnsTitlebar}")
    // NewLayout 只在「标记 ∧ session 路由」同时成立时跳过上游 Titlebar;home/draft 等
    // 其余路由照常渲染(Show 直接包住 Titlebar,别无第二渲染点)。
    const layoutNew = readFileSync(join(APP_SRC, "pages/layout-new.tsx"), "utf8")
    expect(layoutNew).toContain('props.sessionOwnsTitlebar === true && layout.route().type === "session"')
    expect(layoutNew).toMatch(/<Show when=\{!titlebarHidden\(\)\}>\s*<Titlebar/)
    expect(layoutNew.match(/<Titlebar/g)).toHaveLength(1)
  })

  test("narrow terminal-engine channel stays a minimal pure re-export (REQ-125 #554/#576, ADR-027 修订 2026-07-24)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../../app/package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["./surface/terminal"]).toBe("./src/surface/terminal.ts")

    // 窄面的可机械验证形态:re-export 模块恰好四个符号,逐行钉死,禁止悄悄扩面。第四条
    // (TerminalColors)是 #576 深底 seam:Terminal 的 `theme` palette 覆盖类型(ADR-027 修订)。
    const surfaceModule = readFileSync(join(APP_SRC, "surface/terminal.ts"), "utf8")
    const exportLines = surfaceModule.split("\n").filter((line) => line.startsWith("export"))
    expect(exportLines).toEqual([
      'export { useTerminal } from "@/context/terminal"',
      'export type { LocalPTY } from "@/context/terminal"',
      'export { Terminal } from "@/components/terminal"',
      'export type { TerminalColors } from "@/components/terminal"',
    ])

    // 指向的引擎源仍导出这些符号(锚点:上游改名/搬文件时此处先于运行时红)。
    const terminalContext = readFileSync(join(APP_SRC, "context/terminal.tsx"), "utf8")
    expect(terminalContext).toContain("export const { use: useTerminal, provider: TerminalProvider }")
    expect(terminalContext).toContain("export type LocalPTY")
    const terminalComponent = readFileSync(join(APP_SRC, "components/terminal.tsx"), "utf8")
    expect(terminalComponent).toContain("export const Terminal = (props: TerminalProps)")
    // #576 深底 seam:palette 覆盖类型 + Terminal 接受可选 `theme` 覆盖 prop(缺省=零行为变)。
    expect(terminalComponent).toContain("export type TerminalColors")
    expect(terminalComponent).toContain("theme?: Partial<TerminalColors>")
  })
})
