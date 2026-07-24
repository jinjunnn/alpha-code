import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)

Bun.plugin({
  name: "session-workspace-component-test",
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

const runtime = await import("../src/renderer/alpha-ui/session-workspace/session-workspace-test-runtime")
const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetSessionWorkspaceSnapshot()
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
  await Promise.resolve()
  await Promise.resolve()
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => runtime.SessionWorkspaceHarness(), host))
  return host
}

describe("REQ-125 session workspace real Solid mount", () => {
  test("mounts one topbar with timeline, composer dock, and right-rail hosts", async () => {
    const host = mount()
    await flush()

    expect(host.querySelectorAll("[data-alpha-session-workspace]")).toHaveLength(1)
    expect(host.querySelectorAll("[data-alpha-session-workspace-topbar]")).toHaveLength(1)
    expect(host.querySelector("[data-alpha-session-timeline-host]")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-composer-dock]")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-composer-host]")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-rail-host]")?.getAttribute("data-alpha-session-rail-panel")).toBe(
      "review",
    )
    expect(host.querySelector("[data-component]")).toBeNull()
  })

  test("terminal and rail controls only switch the placeholder host", async () => {
    const host = mount()
    await flush()
    const buttons = host.querySelectorAll<HTMLButtonElement>(".a-swk-panel-button")

    buttons[0]!.click()
    await flush()
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector("[data-alpha-session-rail-panel='terminal']")).not.toBeNull()

    buttons[1]!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-host]")).toBeNull()
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("false")

    buttons[1]!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-panel='terminal']")).not.toBeNull()
  })

  test("topbar status renders the approved idle and generating states", async () => {
    const host = mount()
    await flush()
    const status = () => host.querySelector<HTMLElement>("[data-alpha-session-status]")!

    expect(status().dataset.alphaSessionStatus).toBe("idle")
    expect(status().textContent).toContain("空闲")

    runtime.setSessionWorkspaceSnapshot({
      identity: {
        serverKey: "sidecar",
        directory: "/tmp/workspace",
        sessionID: "ses_running",
      },
      project: "workspace",
      title: "整理架构说明",
      activity: "running",
    })
    await flush()

    expect(status().dataset.alphaSessionStatus).toBe("running")
    expect(status().textContent).toContain("正在生成")
  })
})
