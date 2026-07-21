import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { frontendSurfaceById } from "../../shared/frontend-surface-manifest"

const root = resolve(import.meta.dir, "../../../../..")
const legacyDock = resolve(root, "packages/app/src/pages/session/composer/session-permission-dock.tsx")
const composerRegion = await Bun.file(
  resolve(root, "packages/app/src/pages/session/composer/session-composer-region.tsx"),
).text()
const composerState = await Bun.file(
  resolve(root, "packages/app/src/pages/session/composer/session-composer-state.ts"),
).text()
const composerReskin = await Bun.file(
  resolve(root, "packages/ui-mac/src/renderer/alpha-ui/composer-reskin.css"),
).text()
const renderer = await Bun.file(resolve(root, "packages/ui-mac/src/renderer/index.tsx")).text()
const app = await Bun.file(resolve(root, "packages/app/src/app.tsx")).text()
const watcher = await Bun.file(
  resolve(root, "packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx"),
).text()
const permissionDialog = await Bun.file(
  resolve(root, "packages/ui-mac/src/renderer/alpha-ui/PermissionDialog.tsx"),
).text()
const l2Harness = await Bun.file(
  resolve(root, "docs/verification/2026-07-21-req090-permission-l2/harness.html"),
).text()
const l2Readme = await Bun.file(
  resolve(root, "docs/verification/2026-07-21-req090-permission-l2/README.md"),
).text()

describe("Alpha Permission unique-mount ratchet", () => {
  test("deletes the upstream dock, legacy submission path, and dedicated reskin", async () => {
    expect(await Bun.file(legacyDock).exists()).toBeFalse()
    expect(composerRegion).not.toContain("SessionPermissionDock")
    expect(composerState).not.toContain("client.permission.respond")
    expect(composerReskin).not.toContain('data-kind="permission"')
    expect(composerReskin).not.toContain("permission-patterns")
  })

  test("mounts exactly once through the current Session SDK seam and records Alpha ownership", () => {
    expect(renderer.match(/<PermissionWatcher\b/g)).toHaveLength(1)
    expect(renderer).toContain("permission: (props) =>")
    expect(app).toContain("props.surfaces?.permission")
    expect(app.match(/component=\{PermissionSurface\}/g)).toHaveLength(1)
    expect(watcher).not.toContain("createOpencodeClient")
    expect(watcher).not.toContain("global.event")
    expect(frontendSurfaceById("inline.permission")).toMatchObject({
      owner: "alpha.permission",
      lineage: "alpha",
      mount: { kind: "overlay", host: "alpha-permission-dialog" },
      source: "packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx",
    })
  })

  test("uses the Session Permission contract without sharing REQ-212 domain enums", () => {
    expect(permissionDialog).toContain("PermissionV2DecisionCommand")
    expect(permissionDialog).not.toContain("ext-capability-authorization")
    expect(permissionDialog).not.toContain("ExtensionCapability")
  })

  test("keeps the frame 03 L2 matrix on real Alpha CSS with no contract placeholders", () => {
    const facts = ["subject", "action", "resources", "scope", "expiry"]
    const decisions = ["once", "always", "reject"]
    expect(l2Harness).toContain("permission-dialog.css")
    facts.forEach((fact) => {
      expect(l2Harness).toContain(`data-permission-fact="${fact}"`)
    })
    decisions.forEach((decision) => {
      expect(l2Harness).toContain(`data-permission-decision="${decision}"`)
    })
    expect(l2Harness).toContain('data-kind="failed"')
    expect(l2Harness).not.toContain("待契约")
    expect(l2Readme).toContain("完整事实 / 三态 / 提交失败 × 双主题")
  })
})
