import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")

describe("REQ-090 Recovery wiring ratchet", () => {
  test("DbSafety Recovery is presented before the product window is created", () => {
    const index = read("index.ts")
    expect(index.indexOf("runDbPreflightBoot({")).toBeGreaterThan(-1)
    expect(index.indexOf("runDbPreflightBoot({")).toBeLessThan(index.indexOf("mainWindow = createMainWindow()"))
    expect(index).toContain("presentRecovery: recoveryIpc.presentBoot")
    expect(index).toContain("db-safety preflight crashed — fail-closed")
  })

  test("the boot host uses its own minimal preload and explicit Electron isolation", () => {
    const windows = read("windows.ts")
    const start = windows.indexOf("export function createRecoveryWindow(")
    const recovery = windows.slice(start, windows.indexOf("export function registerRendererProtocol", start))
    expect(recovery).toContain('preload: join(root, "../preload/recovery.js")')
    expect(recovery).toContain("contextIsolation: true")
    expect(recovery).toContain("nodeIntegration: false")
    expect(recovery).toContain("sandbox: true")
    expect(recovery).toContain("webviewTag: false")
    expect(recovery).toContain('loadWindow(win, "recovery.html")')
  })

  test("every fatal boot-host event emits only a fixed reason to the shared settlement path", () => {
    const windows = read("windows.ts")
    const index = read("index.ts")
    const start = windows.indexOf("export function createRecoveryWindow(")
    const recovery = windows.slice(start, windows.indexOf("export function registerRendererProtocol", start))
    expect(recovery).toContain('onFatal("renderer-load-failed")')
    expect(recovery).toContain('onFatal("preload-failed")')
    expect(recovery).toContain('onFatal("renderer-process-gone")')
    expect(recovery).not.toContain("writeLog(")
    expect(index).toContain("if (isRecoveryWebContents(webContents)) return")
  })

  test("the active boot and close settlement are installed before its renderer starts loading", () => {
    const ipc = read("recovery-ipc.ts")
    expect(ipc.indexOf("boot = { incident, senderID: win.webContents.id, finish }")).toBeLessThan(
      ipc.indexOf("loadRecoveryWindow(win)"),
    )
    expect(ipc.indexOf('win.once("closed", () => finish("exit-app"))')).toBeLessThan(
      ipc.indexOf("loadRecoveryWindow(win)"),
    )
  })

  test("startup DbSafety branches contain no native prompt and runtime Recovery has one mount", () => {
    const boot = read("db-safety-boot.ts").split("// ── 菜单动作")[0]!
    expect(boot).not.toContain("dialog.showMessageBox")
    expect(boot).not.toContain("dialog.showErrorBox")
    const renderer = read("../renderer/index.tsx")
    expect(renderer.match(/recovery: RuntimeRecoveryHost/g)).toHaveLength(1)
    expect(renderer.match(/<RecoverySurface \/>/g)).toHaveLength(1)
  })

  test("the static L2 harness covers four safe failure partitions in both themes", () => {
    const harness = read("../../../../docs/verification/2026-07-21-req090-recovery-l2/harness.html")
    expect(harness.match(/<article class="card">/g)).toHaveLength(8)
    expect(harness.match(/<section class="theme light"/g)).toHaveLength(1)
    expect(harness.match(/<section class="theme dark"/g)).toHaveLength(1)
    expect(harness).toContain("RECOVERY_DATABASE_CORRUPT")
    expect(harness).toContain("RECOVERY_ENGINE_STOPPED")
    expect(harness).toContain("SURFACE RECOVERY")
    expect(harness).toContain("SAVE RECOVERY")
    expect(harness).not.toMatch(/\/Users\/|[A-Za-z]:\\Users\\|sk-[A-Za-z0-9]/)
  })
})
