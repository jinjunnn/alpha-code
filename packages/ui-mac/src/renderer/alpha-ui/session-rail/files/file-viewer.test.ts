// REQ-108(#244)—— 文件查看器:组件用例驱动器 + 源级 ratchet。
// 组件行为判据在 test-component/file-viewer.cases.ts(真 Solid + happy-dom);
// 这里另钉三组源级不变量:IPC 纪律(只有 io 文件说 window.api,且只经守卫化通道)、
// 路由决策复用(AC2:registry 是唯一格式权威)、wiring 的下钻组合存在性。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const core = readFileSync(join(import.meta.dir, "file-viewer-core.ts"), "utf8")
const state = readFileSync(join(import.meta.dir, "file-viewer-state.ts"), "utf8")
const view = readFileSync(join(import.meta.dir, "file-viewer-view.tsx"), "utf8")
const io = readFileSync(join(import.meta.dir, "file-viewer-io.ts"), "utf8")
const wiring = readFileSync(join(import.meta.dir, "session-rail-files.tsx"), "utf8")
const shell = readFileSync(join(import.meta.dir, "../../session-workspace/session-workspace-shell.tsx"), "utf8")
const reviewView = readFileSync(join(import.meta.dir, "../review/review-panel-view.tsx"), "utf8")

describe("REQ-108 file viewer real Solid mount", () => {
  test("component cases run green in a real Solid+happy-dom mount", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(import.meta.dir, "../../../../../test-component/file-viewer.cases.ts")],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass > 0 }).toEqual({ fail: "0", ran: true })
  })
})

describe("REQ-108 IPC discipline (path security §③.3 的查看器面)", () => {
  test("state/view/core never talk to IPC or generic openers; only the io module does", () => {
    const forbidden = ["window.api", "ipcRenderer", "openPath", "node:fs", "node:path", "require(", "file.read"]
    for (const [name, source] of Object.entries({ core, state, view })) {
      const offenders = forbidden.filter((token) => source.includes(token))
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] })
    }
  })

  test("the io module uses exactly the guarded workspace channels — no generic opener, no artifact channels", () => {
    expect(io).toContain("window.api.workspaceFile.")
    expect(io).toContain("window.api.railPreview.")
    for (const token of ["window.api.openPath", "window.api.openLink", "runArtifacts", "htmlPreview.", "file://"]) {
      expect({ token, present: io.includes(token) }).toEqual({ token, present: false })
    }
    // renderer 永不拼接绝对路径:directory 只作为第一实参递给 main。
    expect(io).not.toContain("${directory}")
    expect(io).not.toContain("directory +")
  })
})

describe("REQ-108 AC2: renderer registry is the only format authority", () => {
  test("viewer core routes through routeArtifact and defines no second extension table", () => {
    expect(core).toContain("routeArtifact({ name })")
    expect(core).toContain(`from "../../artifact-workbench/renderers/registry"`)
    // 不自建格式判定:没有扩展名→MIME 的第二张表,也没有对文件名的正则格式猜测。
    expect(core).not.toContain("EXTENSION_MIME")
    expect(core).not.toMatch(/\.(endsWith|match)\(["'`]\.\w/)
  })

  test("text content reuses the workbench content bricks (同一份净化模型渲染)", () => {
    expect(view).toContain(`from "../../artifact-workbench/renderers/content-views"`)
    expect(view).toContain("parseMarkdownModel")
    // 铁律:文本内容只经 Solid 文本节点 —— 查看器不得引入 innerHTML/iframe。
    for (const token of ["innerHTML", "<iframe", "dangerously"]) {
      expect({ token, present: view.includes(token) }).toEqual({ token, present: false })
    }
  })
})

describe("REQ-108 drill-down composition & linkage ratchets", () => {
  test("wiring composes viewer over the resident tree and honors deactivation", () => {
    expect(wiring).toContain("createFileViewerState")
    expect(wiring).toContain("openViewer")
    expect(wiring).toContain("fileViewerTarget")
    expect(wiring).toContain("viewer.deactivate()")
    expect(wiring).toContain("treeLayer.inert")
    expect(wiring).toContain("viewer.dispose()")
  })

  test("shell mints identity-bound viewer targets and exposes the active panel", () => {
    expect(shell).toContain("SessionRailFileViewerTarget")
    expect(shell).toContain("openFileViewer")
    expect(shell).toContain("activePanel: panel")
    expect(shell).toContain("setFileViewerTarget(undefined)")
  })

  test("review card offers view-whole-file except for deletions", () => {
    expect(reviewView).toContain("onOpenFile")
    expect(reviewView).toContain(`props.change.kind !== "deleted"`)
  })
})
