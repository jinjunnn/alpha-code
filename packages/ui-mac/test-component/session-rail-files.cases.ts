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
// files-state.ts uses createStore: without this mock bun resolves the store's server build,
// whose stores are non-reactive — the view would freeze on its first render.
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "session-rail-files-component-test",
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

type Deferred = {
  promise: Promise<readonly unknown[]>
  resolve: (value: readonly unknown[]) => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: Deferred["resolve"]
  let reject!: Deferred["reject"]
  const promise = new Promise<readonly unknown[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const file = (path: string) => ({ name: path.split("/").pop(), path, type: "file", ignored: false })
// Real server shape: directory nodes carry a trailing separator (e.g. "src/").
const dir = (path: string) => ({ name: path.split("/").pop(), path: `${path}/`, type: "directory", ignored: false })

describe("REQ-125 C3 files panel real Solid mount", () => {
  test("tree renders the root, lazy-loads directories, and opening a file adds a session tab", async () => {
    const harness = runtime.createFilesHarness({
      listDir: (path) => {
        if (path === "") return Promise.resolve([dir("alpha-ui"), file("README.md")])
        // Windows server shape: backslash separators; must canonicalize, not vanish.
        if (path === "alpha-ui")
          return Promise.resolve([{ name: "button.css", path: "alpha-ui\\button.css", type: "file", ignored: false }])
        return Promise.resolve([])
      },
    })
    const host = mount(harness.View)
    await flushTimers()

    expect(harness.calls.listDir).toEqual([""])
    expect(host.querySelector("[data-alpha-srf-dir='alpha-ui']")).not.toBeNull()
    expect(host.querySelector("[data-alpha-srf-file='README.md']")).not.toBeNull()
    expect(host.querySelector("[data-alpha-srf-file='alpha-ui/button.css']")).toBeNull()

    const dirRow = host.querySelector<HTMLButtonElement>("[data-alpha-srf-dir='alpha-ui']")!
    dirRow.click()
    await flushTimers()
    expect(harness.calls.listDir).toEqual(["", "alpha-ui"])
    expect(dirRow.getAttribute("aria-expanded")).toBe("true")
    expect(dirRow.classList.contains("a-srf-row--open")).toBe(true)
    const child = host.querySelector("[data-alpha-srf-file='alpha-ui/button.css']")
    expect(child).not.toBeNull()
    expect(child!.closest(".a-srf-indent")).not.toBeNull()

    const readme = host.querySelector<HTMLButtonElement>("[data-alpha-srf-file='README.md']")!
    readme.click()
    await flush()
    expect(harness.calls.open).toEqual(["file://README.md"])
    expect(readme.classList.contains("a-srf-row--selected")).toBe(true)
    expect(readme.getAttribute("aria-current")).toBe("true")
    const opentab = host.querySelector("[data-alpha-srf-opentab='README.md']")
    expect(opentab).not.toBeNull()
    expect(opentab!.classList.contains("a-srf-opentab--on")).toBe(true)

    dirRow.click()
    await flush()
    expect(host.querySelector("[data-alpha-srf-file='alpha-ui/button.css']")).toBeNull()
  })

  test("opened group renders shared tabs, keeps the active pill, closes per tab, drops hostile tabs", async () => {
    const harness = runtime.createFilesHarness()
    harness.setTabsAll(["file://a.ts", "file://b.ts", "file:///etc/passwd"])
    harness.setTabActive("file://a.ts")
    const host = mount(harness.View)
    await flushTimers()

    const rows = host.querySelectorAll("[data-alpha-srf-opentab]")
    expect(rows).toHaveLength(2)
    expect(host.querySelector("[data-alpha-srf-opentab='a.ts']")!.classList.contains("a-srf-opentab--on")).toBe(true)

    host.querySelector<HTMLButtonElement>("[data-alpha-srf-opentab='b.ts'] .a-srf-opentab-main")!.click()
    await flush()
    expect(harness.calls.setActive).toEqual(["file://b.ts"])
    expect(host.querySelector("[data-alpha-srf-opentab='b.ts']")!.classList.contains("a-srf-opentab--on")).toBe(true)

    host.querySelector<HTMLButtonElement>("[data-alpha-srf-opentab='a.ts'] .a-srf-opentab-close")!.click()
    await flush()
    expect(harness.calls.close).toEqual(["file://a.ts"])
    expect(host.querySelector("[data-alpha-srf-opentab='a.ts']")).toBeNull()
  })

  test("session-changed files carry the review badge and jump to review instead of opening", async () => {
    const harness = runtime.createFilesHarness({
      listDir: () => Promise.resolve([file("button.css"), file("input.css")]),
    })
    harness.setChangeKinds(new Map([["button.css", "modified"]]))
    const host = mount(harness.View)
    await flushTimers()

    const changed = host.querySelector<HTMLButtonElement>("[data-alpha-srf-file='button.css']")!
    const badge = changed.querySelector(".a-srf-badge")!
    expect(badge.getAttribute("data-kind")).toBe("modified")
    expect(badge.textContent).toBe("修改")
    expect(host.querySelector("[data-alpha-srf-file='input.css'] .a-srf-badge")).toBeNull()

    changed.click()
    await flush()
    expect(harness.calls.jumpToReview).toEqual(["button.css"])
    expect(harness.calls.open).toEqual([])

    host.querySelector<HTMLButtonElement>("[data-alpha-srf-file='input.css']")!.click()
    await flush()
    expect(harness.calls.jumpToReview).toEqual(["button.css"])
    expect(harness.calls.open).toEqual(["file://input.css"])
  })

  test("filter searches via the typed channel, drops stale/hostile results, shows the empty state", async () => {
    const pending = new Map<string, Deferred>()
    const signals = new Map<string, AbortSignal>()
    const harness = runtime.createFilesHarness({
      findFiles: (query, signal) => {
        const entry = deferred()
        pending.set(query, entry)
        signals.set(query, signal)
        return entry.promise
      },
    })
    const host = mount(harness.View)
    await flush()

    const input = host.querySelector<HTMLInputElement>(".a-srf-search input")!
    input.value = "but"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await flushTimers()
    expect(harness.calls.findFiles).toEqual(["but"])

    pending.get("but")!.resolve(["button.css", "/etc/passwd", "/tmp/workspace/alpha-ui/button.css"])
    await flushTimers()
    expect(host.querySelector("[data-alpha-srf-results]")).not.toBeNull()
    expect(host.querySelector("[data-alpha-srf-file='button.css']")).not.toBeNull()
    expect(host.querySelector("[data-alpha-srf-file='alpha-ui/button.css']")).not.toBeNull()
    expect(host.querySelectorAll("[data-alpha-srf-results] [data-alpha-srf-file]")).toHaveLength(2)

    // A newer query aborts the previous one; a late stale resolution must not repaint.
    input.value = "x"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await flushTimers()
    input.value = "xy"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await flushTimers()
    expect(signals.get("x")!.aborted).toBe(true)
    pending.get("x")!.resolve(["stale.ts"])
    await flushTimers()
    expect(host.querySelector("[data-alpha-srf-file='stale.ts']")).toBeNull()

    pending.get("xy")!.resolve([])
    await flushTimers()
    expect(host.textContent).toContain("没有匹配的文件")

    input.value = ""
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await flushTimers()
    expect(host.querySelector("[data-alpha-srf-results]")).toBeNull()
    expect(host.querySelector("[data-alpha-srf-tree]")).not.toBeNull()
  })

  test("async results are dropped once the session identity moved on (I8)", async () => {
    const root = deferred()
    const harness = runtime.createFilesHarness({ listDir: () => root.promise })
    const host = mount(harness.View)
    await flush()

    harness.setStillCurrent(false)
    root.resolve([file("late.ts")])
    await flushTimers()
    expect(host.querySelector("[data-alpha-srf-file='late.ts']")).toBeNull()
    expect(host.querySelector(".a-srf-loading")).not.toBeNull()
  })

  test("tree levels are capped (per-level and total) with a visible truncation hint (I7)", async () => {
    const harness = runtime.createFilesHarness({
      treeDirCap: 3,
      treeTotalCap: 5,
      listDir: (path) => {
        if (path === "")
          return Promise.resolve([dir("big"), file("r1.ts"), file("r2.ts"), file("r3.ts"), file("r4.ts")])
        if (path === "big")
          return Promise.resolve([file("big/c1.ts"), file("big/c2.ts"), file("big/c3.ts"), file("big/c4.ts")])
        return Promise.resolve([])
      },
    })
    const host = mount(harness.View)
    await flushTimers()

    // Root: 5 entries, per-level cap 3 → 3 rows + hint "3 / 5".
    expect(host.querySelectorAll(".a-srf-tree > .a-srf-row")).toHaveLength(3)
    const rootHint = host.querySelector("[data-alpha-srf-truncated='']")
    expect(rootHint).not.toBeNull()
    expect(rootHint!.textContent).toContain("3 / 5")
    expect(rootHint!.textContent).toContain("过滤")

    // Child level: total cap 5 leaves a budget of 2 → 2 rows + hint "2 / 4".
    host.querySelector<HTMLButtonElement>("[data-alpha-srf-dir='big']")!.click()
    await flushTimers()
    const childRows = host.querySelectorAll(".a-srf-indent [data-alpha-srf-file]")
    expect(childRows).toHaveLength(2)
    const childHint = host.querySelector("[data-alpha-srf-truncated='big']")
    expect(childHint).not.toBeNull()
    expect(childHint!.textContent).toContain("2 / 4")
  })

  test("C21 AC2: rows claim list semantics only and stay operable by Tab + Enter alone", async () => {
    const harness = runtime.createFilesHarness({
      listDir: (path) => (path === "" ? Promise.resolve([dir("alpha-ui"), file("README.md")]) : Promise.resolve([])),
    })
    const host = mount(harness.View)
    await flushTimers()

    // 降级后不再对 AT 许诺 tree 的键盘契约(方向键漫游 / Left 收起 / 层级跳转)。
    expect(host.querySelectorAll("[role='tree'], [role='treeitem']")).toHaveLength(0)
    expect(host.querySelector(".a-srf-tree")?.getAttribute("role")).toBe("list")

    // 兑现的是原生 button:每行都在 Tab 序列里(无 roving 的 -1),回车即打开。
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".a-srf-row")]
    expect(rows.length).toBeGreaterThan(1)
    rows.forEach((row) => {
      expect(row.tagName).toBe("BUTTON")
      expect(row.getAttribute("role")).toBe("listitem")
      expect(row.tabIndex).toBe(0)
    })

    const readme = host.querySelector<HTMLButtonElement>("[data-alpha-srf-file='README.md']")!
    readme.focus()
    expect(document.activeElement).toBe(readme)
    readme.click() // 原生 button:Enter/Space 由浏览器转成 click,行为与此一致。
    await flush()
    expect(harness.calls.open).toEqual(["file://README.md"])
    expect(readme.getAttribute("aria-current")).toBe("true")

    // 展开态仍向 AT 暴露(目录行的 aria-expanded 不因降级消失)。
    const dirRow = host.querySelector<HTMLButtonElement>("[data-alpha-srf-dir='alpha-ui']")!
    expect(dirRow.getAttribute("aria-expanded")).toBe("false")
    dirRow.click()
    await flushTimers()
    expect(dirRow.getAttribute("aria-expanded")).toBe("true")
  })

  test("shell rail strip: files tab mounts the panel, jump-to-review switches tabs and keeps files alive", async () => {
    const shell = runtime.createShellCaseHarness()
    const host = mount(shell.Shell)
    await flush()

    const tab = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-alpha-session-rail-tab='${kind}']`)!
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)
    expect(tab("files")).not.toBeNull()
    expect(tab("terminal")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-rail-panel-host='review']")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-rail-panel-host='files']")).toBeNull()

    tab("files").click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-panel='files']")).not.toBeNull()
    const filesHost = host.querySelector("[data-alpha-session-rail-panel-host='files']")!
    expect(filesHost.querySelector("[data-fake-files-panel]")).not.toBeNull()
    expect(filesHost.classList.contains("a-swk-rail-panel--hidden")).toBe(false)
    expect(
      host
        .querySelector("[data-alpha-session-rail-panel-host='review']")!
        .classList.contains("a-swk-rail-panel--hidden"),
    ).toBe(true)

    shell.rail()!.jumpToReview("button.css")
    await flush()
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)
    expect(host.querySelector("[data-fake-review-panel]")!.textContent).toBe("button.css")
    // files stays mounted (state preserved), merely hidden
    expect(
      host
        .querySelector("[data-alpha-session-rail-panel-host='files']")!
        .classList.contains("a-swk-rail-panel--hidden"),
    ).toBe(true)

    host.querySelector<HTMLButtonElement>(".a-swk-rail-close")!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-host]")).toBeNull()

    // Reopen via the topbar rail toggle: visited panels were reset, review (last panel) is active.
    const topbarButtons = host.querySelectorAll<HTMLButtonElement>(".a-swk-panel-button")
    topbarButtons[1]!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-panel='review']")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-rail-panel-host='files']")).toBeNull()
  })

  test("review target is identity-bound and cleared on session switch (I8)", async () => {
    const shell = runtime.createShellCaseHarness()
    const host = mount(shell.Shell)
    await flush()

    // Session A mints a target — it carries A's identity triple.
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='files']")!.click()
    await flush()
    shell.rail()!.jumpToReview("a.ts")
    await flush()
    expect(host.querySelector("[data-fake-review-panel]")!.textContent).toBe("a.ts")
    const target = shell.rail()!.reviewTarget()
    expect(target?.file).toBe("a.ts")
    expect(target?.identity).toEqual(shell.identity)

    // Switch to session B: the pending target must neither survive nor be consumable.
    shell.setSnapshot({
      identity: { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_other" },
      project: "workspace",
      title: "另一个会话",
      activity: "idle",
    })
    await flush()
    expect(shell.rail()!.reviewTarget()).toBeUndefined()
    expect(host.querySelector("[data-fake-review-panel]")!.textContent).toBe("")
  })
})
