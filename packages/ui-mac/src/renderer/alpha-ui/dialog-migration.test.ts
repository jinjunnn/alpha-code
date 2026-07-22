import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../../../../")
const read = (file: string) => readFileSync(join(root, file), "utf8")

describe("REQ-090 upstream Dialog migration ratchet", () => {
  test("global legacy reskin is deleted and renderer no longer imports it", () => {
    expect(existsSync(join(import.meta.dir, "dialog-reskin.css"))).toBe(false)
    expect(read("ui-mac/src/renderer/index.tsx")).not.toContain("dialog-reskin.css")
  })

  test("active generic entrypoints explicitly select the Alpha host", () => {
    const expectations: Record<string, { anchors: string[]; hosts: number }> = {
      "app/src/context/highlights.tsx": { anchors: ["<DialogReleaseNotes"], hosts: 1 },
      "app/src/pages/home.tsx": { anchors: ["<x.DialogEditProject", "<DialogSelectServer"], hosts: 2 },
      "app/src/pages/layout.tsx": {
        anchors: ["<x.DialogSelectServer", "<DialogResetWorkspace", "<DialogDeleteWorkspace"],
        hosts: 4,
      },
      "app/src/components/status-popover-body.tsx": { anchors: ["<x.DialogSelectServer"], hosts: 2 },
      "app/src/components/directory-picker.tsx": {
        anchors: ["<DialogSelectDirectoryV2", "<DialogSelectDirectory"],
        hosts: 2,
      },
      "app/src/pages/session/use-session-commands.tsx": {
        anchors: ["<x.DialogSelectFile", "<x.DialogSelectMcp", "<x.DialogFork"],
        hosts: 3,
      },
      "app/src/pages/session/session-side-panel.tsx": { anchors: ["<x.DialogSelectFile"], hosts: 1 },
      "app/src/pages/session/timeline/message-timeline.tsx": { anchors: ["<DialogDeleteSession"], hosts: 2 },
      "app/src/pages/session/usage-exceeded-dialogs.tsx": { anchors: ["<DialogUsageExceeded"], hosts: 2 },
      "app/src/components/prompt-input.tsx": { anchors: ["<ImagePreview"], hosts: 1 },
    }
    Object.entries(expectations).forEach(([file, expectation]) => {
      const source = read(file)
      expectation.anchors.forEach((anchor) => expect(source, `${file}: ${anchor}`).toContain(anchor))
      expect(source.match(/host:\s*true/g), `${file}: host count`).toHaveLength(expectation.hosts)
    })

    const promptV2 = read("app/src/components/prompt-input-v2.tsx")
    const patch = read("ui-mac/scripts/patch-upstream.ts")
    const source = `dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />),`
    const hosted =
      `dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />, ` +
      `undefined, { host: true }),`
    expect(promptV2).toContain(source)
    expect(patch).toContain(`"app/src/components/prompt-input-v2.tsx"`)
    expect(patch).toContain(source)
    expect(patch).toContain(hosted)
  })

  test("Settings, Model, Provider, and Permission consumers remain outside this migration", () => {
    const excluded = [
      "app/src/components/settings-general.tsx",
      "app/src/components/settings-providers.tsx",
      "app/src/components/settings-v2/general.tsx",
      "app/src/components/settings-v2/providers.tsx",
      "app/src/components/dialog-select-model.tsx",
      "app/src/components/dialog-connect-provider.tsx",
    ]
    excluded.forEach((file) => expect(read(file), file).not.toContain("{ host: true }"))
  })

  test("the renderer provides one Alpha host and one runtime Recovery mount", () => {
    const renderer = read("ui-mac/src/renderer/index.tsx")
    expect(renderer.match(/dialogHost=\{productionRoutes\.dialog\.mount\}/g)).toHaveLength(1)
    expect(renderer.match(/recovery: RuntimeRecoveryHost/g)).toHaveLength(1)
    expect(renderer.match(/<RecoverySurface \/>/g)).toHaveLength(1)
  })
})
