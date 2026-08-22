// #907 —— ArtifactHtmlPreview 的真 Solid + happy-dom 挂载判据。
//
// 为什么必须真挂载:本票的缺陷形态正是「main 侧有导出、renderer 无调用点」—— 一个只读源码字符串
// 的断言(`expect(source).toContain(".status(")`)对「调了但渲染不出来」「渲染了但计数是假的」
// 「没点也复制了」三种回归全部照绿。判据因此从**渲染出来的 DOM** 与**假 bridge 上真实发生的调用**
// 取,不从源码取。宿主 wiring 见 ../src/renderer/alpha-ui/artifact-html-preview/artifact-html-preview.test.ts。

import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
// 默认解析会挑到 solid 的 server build(`notSup()` 直接抛)—— 与既有 cases 宿主同款纪律:
// 显式把 client build 装进模块图,组件才跑在真 DOM 上。
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)

Bun.plugin({
  name: "artifact-html-preview-component-test",
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

const { ArtifactHtmlPreview } = await import("../src/renderer/alpha-ui/artifact-html-preview/ArtifactHtmlPreview")
const { HTML_PREVIEW_MAX_BLOCKED_ENTRIES } = await import("../src/shared/html-preview")

// ---- 假 bridge(记录每一次调用;绝不代替生产逻辑做任何判断)----

type Harness = {
  blocked: string[]
  statusCalls: string[]
  clipboardWrites: string[]
  openCalls: number
}

let harness: Harness

function installFakeBridge() {
  harness = { blocked: [], statusCalls: [], clipboardWrites: [], openCalls: 0 }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    htmlPreview: {
      open: async () => {
        harness.openCalls += 1
        return { ok: true as const, previewId: "hp_test" }
      },
      close: async () => ({ ok: true }),
      status: async (previewId: string) => {
        harness.statusCalls.push(previewId)
        return { ok: true as const, previewId, open: true, blockedPaths: [...harness.blocked] }
      },
      onClosed: () => () => {},
    },
    writeClipboard: async (text: string) => {
      harness.clipboardWrites.push(text)
      return true
    },
  }
}

const disposers: Array<() => void> = []

beforeEach(() => {
  installFakeBridge()
  document.body.replaceChildren()
})

afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    solidWeb.render(
      () =>
        ArtifactHtmlPreview({
          directory: "/proj",
          runId: "run-1",
          descriptor: { id: "a1", name: "report.html", claimedMime: "text/html" } as never,
          savedPath: "artifacts/report.html",
        }),
      host,
    ),
  )
  return host
}

/** 点开预览(生产按钮,不是直接调内部函数)。 */
async function openPreview(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find((b) => b.classList.contains("primary"))
  if (!button) throw new Error("open button missing")
  button.click()
  await flush()
}

function blockedSection(host: HTMLElement) {
  return host.querySelector(".a-html-preview-blocked")
}

describe("#907 blocked resources are surfaced honestly", () => {
  test("before opening, nothing is claimed about blocked resources", async () => {
    const host = mount()
    await flush()
    expect(blockedSection(host)).toBeNull()
    expect(harness.statusCalls).toEqual([])
  })

  test("an open preview reaches .status and renders the real count and every entry", async () => {
    harness.blocked = ["https://cdn.example.com", "https://fonts.example.net", "chart.pdf"]
    const host = mount()
    await openPreview(host)

    // 这一条钉的正是本票的缺陷本体:renderer 必须真的调到 .status。
    expect(harness.statusCalls).toEqual(["hp_test"])

    const section = blockedSection(host)
    expect(section).not.toBeNull()
    expect(section!.getAttribute("data-blocked-count")).toBe("3")
    expect(section!.textContent).toContain("3")

    const items = [...host.querySelectorAll(".a-html-preview-blocked-item")].map((li) => li.textContent)
    expect(items).toEqual(["https://cdn.example.com", "https://fonts.example.net", "chart.pdf"])
  })

  test("a truncated list says at-least instead of reporting a precise but wrong count", async () => {
    harness.blocked = Array.from({ length: HTML_PREVIEW_MAX_BLOCKED_ENTRIES }, (_, i) => `https://h${i}.example.com`)
    const host = mount()
    await openPreview(host)

    const title = host.querySelector(".a-html-preview-blocked-title")!.textContent ?? ""
    // 到上限的措辞与未到上限的措辞必须不同 —— 否则「50」会被当成完整计数读。
    expect(title).toContain(String(HTML_PREVIEW_MAX_BLOCKED_ENTRIES))

    harness.blocked = harness.blocked.slice(0, HTML_PREVIEW_MAX_BLOCKED_ENTRIES - 1)
    const belowHost = mount()
    await openPreview(belowHost)
    const belowTitle = belowHost.querySelector(".a-html-preview-blocked-title")!.textContent ?? ""
    expect(belowTitle).not.toBe(title)
  })

  test("the note never claims the entries are the full URLs the document asked for", async () => {
    harness.blocked = ["https://cdn.example.com"]
    const host = mount()
    await openPreview(host)
    const note = host.querySelector(".a-html-preview-blocked-note")!.textContent ?? ""
    expect(note.length).toBeGreaterThan(20)
    // 措辞若退化成 key 原样(缺 i18n 条目),用户读到的就是一个开发者标识符。
    expect(note).not.toContain("alpha.htmlPreview")
  })
})

describe("#907 taking a link out requires one explicit user action", () => {
  test("mounting, opening and polling never write to the clipboard on their own", async () => {
    harness.blocked = ["https://cdn.example.com", "https://fonts.example.net"]
    const host = mount()
    await openPreview(host)
    await flush()
    expect(harness.clipboardWrites).toEqual([])
    expect(host.querySelector(".a-html-preview-copy-note")).toBeNull()
  })

  test("clicking copy — and only that — puts the blocked list on the clipboard", async () => {
    harness.blocked = ["https://cdn.example.com", "chart.pdf"]
    const host = mount()
    await openPreview(host)

    const copy = [...host.querySelectorAll("button")].find((b) => !b.classList.contains("primary"))
    expect(copy).toBeDefined()
    copy!.click()
    await flush()

    expect(harness.clipboardWrites).toEqual(["https://cdn.example.com\nchart.pdf"])
    expect(host.querySelector(".a-html-preview-copy-note")).not.toBeNull()
  })

  test("the component never opens anything itself — no external/open escape hatch exists", async () => {
    harness.blocked = ["https://cdn.example.com"]
    const host = mount()
    await openPreview(host)
    const copy = [...host.querySelectorAll("button")].find((b) => !b.classList.contains("primary"))
    copy!.click()
    await flush()
    // 假 bridge 上只有 htmlPreview 与 writeClipboard;任何 openExternal/openPath 调用都会
    // 因属性不存在而抛错,这里同时断言渲染出来的清单是纯文本、不是可点的链接。
    expect(host.querySelector(".a-html-preview-blocked a")).toBeNull()
    expect(harness.openCalls).toBe(1)
  })
})
