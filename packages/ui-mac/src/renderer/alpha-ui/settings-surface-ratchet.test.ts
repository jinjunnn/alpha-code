import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { FRONTEND_SURFACE_MANIFEST } from "../../shared/frontend-surface-manifest"

const root = join(import.meta.dir, "../../../")
const rendererIndex = Bun.file(join(root, "src/renderer/index.tsx"))
const settingsSurface = Bun.file(join(root, "src/renderer/alpha-ui/settings.tsx"))
const mainIpc = Bun.file(join(root, "src/main/ipc.ts"))
const migration = Bun.file(join(root, "src/main/migrate.ts"))
const upstreamPatch = Bun.file(join(root, "scripts/patch-upstream.ts"))
const sidebarCss = Bun.file(join(root, "src/renderer/sidebar/sidebar.css"))
const appLayout = Bun.file(join(root, "../app/src/pages/layout.tsx"))
const appHome = Bun.file(join(root, "../app/src/pages/home.tsx"))
const appNewSession = Bun.file(join(root, "../app/src/pages/new-session.tsx"))
const appSession = Bun.file(join(root, "../app/src/pages/session.tsx"))
const appSettingsDialog = Bun.file(join(root, "../app/src/components/settings-dialog.tsx"))
const l2Harness = Bun.file(join(root, "../../docs/verification/2026-07-21-req090-settings-l2/harness.html"))
const l2Readme = Bun.file(join(root, "../../docs/verification/2026-07-21-req090-settings-l2/README.md"))

describe("Alpha Settings ownership ratchets", () => {
  test("manifest registers one Alpha-owned overlay mount", () => {
    const entries = FRONTEND_SURFACE_MANIFEST.filter((surface) => surface.id === "overlay.settings")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      owner: "alpha.settings",
      lineage: "alpha",
      mount: { kind: "overlay", host: "app-root" },
      source: "packages/ui-mac/src/renderer/alpha-ui/settings.tsx",
    })
  })

  test("deletes the observer/reskin path and mounts the Alpha surface exactly once", async () => {
    expect(await Bun.file(join(root, "src/renderer/alpha-ui/settings-back-button.ts")).exists()).toBeFalse()
    expect(await Bun.file(join(root, "src/renderer/alpha-ui/settings-reskin.css")).exists()).toBeFalse()
    const source = await rendererIndex.text()
    expect(source).not.toContain("setupSettingsBackButton")
    expect(source).not.toContain("settings-reskin.css")
    expect(source.match(/<AlphaSettings\b/g)).toHaveLength(1)
    expect(source).toContain("openSettings()")
    expect(await settingsSurface.text()).not.toContain("<Portal")
    expect(await upstreamPatch.text()).not.toContain("settings-v2")
    expect(await sidebarCss.text()).not.toContain("settings-v2")
    expect(source).toContain("settings: settingsAuthorityCoordinator")
    expect(source).not.toContain("settingsAuthorityStorage")
  })

  test("all ui-mac Settings entrypoints short-circuit to the Alpha owner", async () => {
    const guard = "if (platform.openSettings) return platform.openSettings()"
    const layout = await appLayout.text()
    expect(layout.indexOf(guard)).toBeGreaterThan(-1)
    expect(layout.indexOf(guard)).toBeLessThan(layout.indexOf("<x.DialogSettings />"))

    const settingsDialog = await appSettingsDialog.text()
    expect(settingsDialog.indexOf(guard)).toBeGreaterThan(-1)
    expect(settingsDialog.indexOf(guard)).toBeLessThan(settingsDialog.indexOf('import("@/components/settings-v2")'))

    for (const source of [await appHome.text(), await appNewSession.text(), await appSession.text()]) {
      expect(source).toContain(`import { useSettingsCommand } from "@/components/settings-dialog"`)
      expect(source).toContain("useSettingsCommand()")
    }
  })

  test("Settings surface never reaches the generic store bridge", async () => {
    const surface = await settingsSurface.text()
    expect(surface).not.toMatch(/storeGet|storeSet|storeDelete|storeClear/)
    expect(surface).not.toMatch(/default\.dat|settings\.v3/)

    const ipc = await mainIpc.text()
    expect(ipc).toContain('ipcMain.handle("store-get"')
    expect(ipc).toContain('ipcMain.handle("store-set"')
    expect(ipc.match(/assertGenericStoreAccess\(name, key\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(ipc).toContain("assertGenericStoreAccess(name)")
    for (const channel of ["store-get", "store-set", "store-delete", "store-clear"]) {
      const start = ipc.indexOf(`ipcMain.handle(\"${channel}\"`)
      const end = ipc.indexOf("ipcMain.handle(\"", start + 20)
      const handler = ipc.slice(start, end)
      expect(handler.indexOf("assertGenericStoreAccess")).toBeGreaterThan(-1)
      expect(handler.indexOf("getStore(name)")).toBeGreaterThan(handler.indexOf("assertGenericStoreAccess"))
    }
  })

  test("Tauri migration rejects the reserved Settings authority before generic writes", async () => {
    const source = await migration.text()
    const guard = source.indexOf("isRendererSettingsAuthorityTarget(filename, key)")
    const write = source.indexOf("target.set(key, value)")
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard)
    expect(source).toContain("tauri migration: skipped reserved default.dat/settings.v3")
  })

  test("L2 records four static states in both themes without forbidden report fields", async () => {
    const harness = await l2Harness.text()
    const readme = await l2Readme.text()
    for (const state of ["default", "save-failed", "gc-running", "gc-failed"]) {
      expect(harness).toContain(`data-l2-state="${state}"`)
      expect(readme).toContain(`theme=light&state=${state}`)
      expect(readme).toContain(`theme=dark&state=${state}`)
    }
    expect(harness).not.toMatch(/digest|finishedAt|warning detail|\/Users\/|\bMB\b/)
  })
})
