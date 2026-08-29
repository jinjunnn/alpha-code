// REQ-108(#244)—— 文件查看器组件用例(真 Solid + happy-dom 挂载,fake IO)。
// 驱动器:src/renderer/alpha-ui/session-rail/files/file-viewer.test.ts(子进程绿判据)。

import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "file-viewer-component-test",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const runtime = await import("../src/renderer/alpha-ui/session-rail/files/files-test-runtime")
const { FILE_VIEWER_EXCERPT_BYTES, FILE_VIEWER_TEXT_MAX_BYTES } = await import("../src/shared/file-viewer")
const disposers: Array<() => void> = []

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
})

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function flushTimers() {
  await new Promise((resolve) => setTimeout(resolve, 1))
  await flush()
}

function mount(component: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(component as never, host))
  return host
}

describe("REQ-108 file viewer real Solid mount", () => {
  test("markdown opens as preview, back button takes focus, mode switch re-renders without re-reading (AC2)", async () => {
    const harness = runtime.createViewerHarness({
      files: { "docs/arch.md": { content: "# Hello\n\nWorld paragraph." } },
    })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("docs/arch.md")
    await flushTimers()

    const rootEl = host.querySelector("[data-alpha-file-viewer='docs/arch.md']")
    expect(rootEl).not.toBeNull()
    expect(host.querySelector("[data-alpha-fv-back]")).toBe(document.activeElement)
    // 内容:净化模型渲染出真实标题,不是源码文本。
    const md = host.querySelector("[data-alpha-fv-markdown]")!
    expect(md.querySelector("h1")!.textContent).toBe("Hello")
    expect(host.textContent).toContain("World paragraph.")
    // 头部合同:文件名 + 上级目录暗示。
    expect(host.querySelector(".a-fv-name")!.textContent).toBe("arch.md")
    expect(host.querySelector(".a-fv-dir")!.textContent).toBe("docs/")

    const readsBefore = harness.calls.readChunk.length
    const src = [...host.querySelectorAll("[data-alpha-fv-modes] button")].find((b) => b.textContent === "源码")!
    ;(src as HTMLButtonElement).click()
    await flush()
    expect(host.querySelector("[data-alpha-fv-markdown]")).toBeNull()
    expect(host.querySelector(".a-wb-code")!.textContent).toContain("# Hello")
    // 交互契约:切换模式不重新读取。
    expect(harness.calls.readChunk.length).toBe(readsBefore)
    expect(harness.calls.openRead).toEqual(["docs/arch.md"])
  })

  test("loading shows byte progress with cancel; cancel stops the read, returns to tree, and late chunks never paint (AC5)", async () => {
    const harness = runtime.createViewerHarness({
      files: { "big.md": { content: "x".repeat(4096) } },
      gated: true,
    })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("big.md")
    await flushTimers()

    expect(host.querySelector("[data-alpha-fv-loading]")).not.toBeNull()
    expect(harness.pendingChunks()).toBe(1)

    const cancel = host.querySelector<HTMLButtonElement>("[data-alpha-fv-cancel]")!
    cancel.click()
    await flush()
    // 回到树(查看器卸载),读取会话归还。
    expect(host.querySelector("[data-alpha-file-viewer]")).toBeNull()
    expect(harness.calls.closeRead).toEqual(["read_1"])

    // 迟到的 chunk 被 epoch 闸丢弃 —— 不闪现内容、不复活查看器。
    harness.releaseChunk()
    await flushTimers()
    expect(host.querySelector("[data-alpha-file-viewer]")).toBeNull()
    expect(host.textContent).not.toContain("xxxx")
  })

  test("switching file mid-read closes the first session and renders only the second (AC5)", async () => {
    const harness = runtime.createViewerHarness({
      files: { "a.txt": { content: "AAAA" }, "b.txt": { content: "BBBB" } },
      gated: true,
    })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("a.txt")
    await flushTimers()
    harness.viewer().open("b.txt")
    await flushTimers()
    expect(harness.calls.closeRead).toContain("read_1")
    // 放行两个挂起 chunk(a 的迟到结果 + b 的真结果)。
    harness.releaseChunk()
    harness.releaseChunk()
    await flushTimers()
    expect(host.textContent).toContain("BBBB")
    expect(host.textContent).not.toContain("AAAA")
    expect(host.querySelector("[data-alpha-file-viewer='b.txt']")).not.toBeNull()
  })

  test("symlink refusal renders the unsafe state with zero actions and no kebab (AC4/AC6)", async () => {
    const harness = runtime.createViewerHarness({
      files: { "link.md": { refusal: "symlink" } },
    })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("link.md")
    await flushTimers()

    expect(host.textContent).toContain("已停止打开这个文件")
    expect(host.querySelector("[data-alpha-fv-kebab]")).toBeNull()
    // 除返回箭头外没有任何动作按钮 —— 可疑文件不转交任何应用。
    const buttons = [...host.querySelectorAll("[data-alpha-file-viewer] button")]
    expect(buttons.map((b) => b.getAttribute("data-alpha-fv-back") !== null)).toEqual([true])
  })

  test("read failure renders the fail state and retry recovers (AC6)", async () => {
    const files: Record<string, runtime.ViewerFakeFile> = { "flaky.txt": { refusal: "read-failed" } }
    const harness = runtime.createViewerHarness({ files })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("flaky.txt")
    await flushTimers()
    expect(host.textContent).toContain("读取失败")

    delete files["flaky.txt"]!.refusal
    files["flaky.txt"]!.content = "recovered"
    host.querySelector<HTMLButtonElement>("[data-alpha-fv-retry]")!.click()
    await flushTimers()
    expect(host.textContent).toContain("recovered")
  })

  test("oversize text offers a bounded excerpt; the excerpt read never exceeds the excerpt budget (AC5/AC6)", async () => {
    const harness = runtime.createViewerHarness({
      files: {
        "data.csv": { content: "col\nrow", totalBytes: FILE_VIEWER_TEXT_MAX_BYTES + 1 },
      },
    })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("data.csv")
    await flushTimers()
    expect(host.textContent).toContain("这个文件太大")
    // 过大态本身零 chunk 读取。
    expect(harness.calls.readChunk).toHaveLength(0)

    host.querySelector<HTMLButtonElement>("[data-alpha-fv-excerpt]")!.click()
    await flushTimers()
    const requested = harness.calls.readChunk.reduce((sum, call) => sum + call.length, 0)
    expect(requested).toBeGreaterThan(0)
    expect(requested).toBeLessThanOrEqual(FILE_VIEWER_EXCERPT_BYTES)
    expect(host.textContent).toContain("节选")
    expect(host.textContent).toContain("row")
  })

  test("a text-claiming file whose bytes are binary is not faked as text (AC6)", async () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02])
    const harness = runtime.createViewerHarness({ files: { "weird.txt": { content: bytes } } })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("weird.txt")
    await flushTimers()
    expect(host.textContent).toContain("二进制")
    expect(host.querySelector(".a-wb-code")).toBeNull()
  })

  test("unsupported format renders the honest card whose actions go through the guarded channels (AC6)", async () => {
    const harness = runtime.createViewerHarness({ files: { "model.bin": { content: "IGNORED", totalBytes: 7 } } })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("model.bin")
    await flushTimers()
    expect(host.textContent).toContain("暂不支持内联预览")
    // 事实行,不读内容。
    expect(harness.calls.readChunk).toHaveLength(0)
    const actions = [...host.querySelectorAll<HTMLButtonElement>("[data-alpha-fv-card] .a-fv-btn")]
    expect(actions.map((b) => b.textContent)).toEqual(["在系统中打开", "打开所在目录"])
    actions[0]!.click()
    actions[1]!.click()
    expect(harness.calls.openExternal).toEqual(["model.bin"])
    expect(harness.calls.reveal).toEqual(["model.bin"])
  })

  test("pdf routes to the overlay carrier: region container, main-side open with kind=pdf, destroy on exit (AC1/AC3)", async () => {
    const harness = runtime.createViewerHarness({ files: {} })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("report.pdf")
    await flushTimers()

    // 主文档 DOM 只有容器 —— 内容画在 main 的 WebContentsView(证据形态,设计 §4)。
    expect(host.querySelector("[data-alpha-fv-overlay='pdf']")).not.toBeNull()
    expect(host.querySelector("[data-alpha-fv-overlay-region]")).not.toBeNull()
    expect(harness.calls.overlayOpen).toHaveLength(1)
    expect(harness.calls.overlayOpen[0]!.kind).toBe("pdf")
    // pdf 载体不画 html 的隔离状态行。
    expect(host.querySelector(".a-fv-isobar")).toBeNull()

    host.querySelector<HTMLButtonElement>("[data-alpha-fv-back]")!.click()
    await flushTimers()
    expect(harness.calls.overlayClose).toEqual(["rp_1"])
    expect(host.querySelector("[data-alpha-fv-overlay-region]")).toBeNull()
  })

  test("html overlay shows the isolation bar and panel deactivation destroys the view (AC3/AC5)", async () => {
    const harness = runtime.createViewerHarness({ files: {} })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("page.html")
    await flushTimers()
    expect(host.querySelector("[data-alpha-fv-overlay='html']")).not.toBeNull()
    expect(host.querySelector(".a-fv-isobar")!.textContent).toContain("隔离预览")
    expect(harness.calls.overlayOpen[0]!.kind).toBe("html")

    // 面板被切走 → 叠放销毁(destroy 不是 hide);切回 → 重新打开。
    harness.setActive(false)
    await flushTimers()
    expect(harness.calls.overlayClose).toEqual(["rp_1"])
    harness.setActive(true)
    await flushTimers()
    expect(harness.calls.overlayOpen).toHaveLength(2)
  })

  test("overlay refusal from main lands in the honest oversize/fail states, never a blank region (AC6)", async () => {
    const harness = runtime.createViewerHarness({
      files: {},
      overlayOpenResult: { ok: false, code: "too-large" },
    })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("huge.pdf")
    await flushTimers()
    expect(host.textContent).toContain("这个文件太大")
    // pdf 无节选通道 —— 只给系统打开。
    expect(host.querySelector("[data-alpha-fv-excerpt]")).toBeNull()
  })

  test("Escape exits the viewer (drill-down contract)", async () => {
    const harness = runtime.createViewerHarness({ files: { "a.md": { content: "hi" } } })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("a.md")
    await flushTimers()
    const rootEl = host.querySelector<HTMLElement>("[data-alpha-file-viewer]")!
    rootEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flush()
    expect(host.querySelector("[data-alpha-file-viewer]")).toBeNull()
    expect(harness.exits).toHaveLength(1)
  })

  test("kebab menu carries exactly the three honest actions and drives the guarded channels (AC6)", async () => {
    const harness = runtime.createViewerHarness({ files: { "a.md": { content: "hi" } } })
    const host = mount(harness.View)
    await flush()
    harness.viewer().open("a.md")
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-fv-kebab]")!.click()
    await flush()
    const items = [...host.querySelectorAll<HTMLButtonElement>("[data-alpha-fv-menu] [role='menuitem']")]
    expect(items.map((b) => b.textContent)).toEqual(["在系统中打开", "打开所在目录", "另存副本"])
    items[2]!.click()
    expect(harness.calls.saveCopy).toEqual(["a.md"])
  })
})

describe("REQ-108 files panel → viewer linkage", () => {
  test("clicking a plain file row hands the path to the viewer (the dangling-tab root cause is closed)", async () => {
    const harness = runtime.createFilesHarness({
      listDir: () => Promise.resolve([{ name: "README.md", path: "README.md", type: "file", ignored: false }]),
    })
    const host = mount(harness.View)
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-srf-file='README.md']")!.click()
    await flush()
    // 打开列表仍登记(「已打开」组数据源)+ 查看器成为真实承接方。
    expect(harness.calls.open).toEqual(["file://README.md"])
    expect(harness.calls.openViewer).toEqual(["README.md"])
  })

  test("a badged row still routes to review, not the viewer (approved split: 改动优先看 diff)", async () => {
    const harness = runtime.createFilesHarness({
      listDir: () => Promise.resolve([{ name: "a.css", path: "a.css", type: "file", ignored: false }]),
    })
    harness.setChangeKinds(new Map([["a.css", "modified"]]))
    const host = mount(harness.View)
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-srf-file='a.css']")!.click()
    await flush()
    expect(harness.calls.jumpToReview).toEqual(["a.css"])
    expect(harness.calls.openViewer).toEqual([])
  })

  test("selecting an opened tab re-opens the viewer for that path", async () => {
    const harness = runtime.createFilesHarness()
    harness.setTabsAll(["file://notes.md"])
    const host = mount(harness.View)
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-srf-opentab='notes.md'] .a-srf-opentab-main")!.click()
    await flush()
    expect(harness.calls.openViewer).toEqual(["notes.md"])
  })
})

describe("REQ-108 shell linkage (openFileViewer / activePanel)", () => {
  test("openFileViewer switches to the files panel and mints an identity-bound, seq-fresh target", async () => {
    const shell = runtime.createShellCaseHarness()
    const host = mount(shell.Shell)
    await flush()
    // rail api 在 files 面板首次渲染时被捕获(与既有 shell 用例同法)。
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='files']")!.click()
    await flush()
    shell.rail()!.openFileViewer("docs/a.md")
    await flush()
    expect(
      host.querySelector("[data-alpha-session-rail-tab='files']")!.classList.contains("a-swk-rail-tab--on"),
    ).toBe(true)
    const first = shell.rail()!.fileViewerTarget()
    expect(first?.file).toBe("docs/a.md")
    expect(first?.identity).toEqual(shell.identity)
    expect(shell.rail()!.activePanel()).toBe("files")

    // 同文件再次请求 → 新 seq(消费端能识别为新请求)。
    shell.rail()!.openFileViewer("docs/a.md")
    await flush()
    expect(shell.rail()!.fileViewerTarget()?.seq).not.toBe(first?.seq)

    // I8:切会话即失效。
    shell.setSnapshot({
      identity: { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_other" },
      project: "workspace",
      title: "另一个会话",
      activity: "idle",
    })
    await flush()
    expect(shell.rail()!.fileViewerTarget()).toBeUndefined()
  })
})
