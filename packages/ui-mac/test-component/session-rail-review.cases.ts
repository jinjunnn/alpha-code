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
  name: "session-rail-review-component-test",
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

const runtime = await import("../src/renderer/alpha-ui/session-rail/review/review-test-runtime")

// Major-2: run the real data container against a controllable fake of the
// typed useServerSync channel (behavior assertions, not source strings).
const fakeSync = await import("../src/renderer/alpha-ui/session-rail/review/review-fake-sync")
mock.module("@opencode-ai/app", () => ({ useServerSync: fakeSync.useServerSync }))
const containerRuntime = await import("../src/renderer/alpha-ui/session-rail/review/review-container-test-runtime")

const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetReviewHarness()
  fakeSync.resetFakeSync()
  containerRuntime.resetContainerHarness()
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
  disposers.push(solidWeb.render(() => runtime.ReviewPanelHarness(), host))
  return host
}

function mountContainer() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => containerRuntime.ReviewContainerHarness(), host))
  return host
}

function headOf(host: HTMLElement, file: string) {
  return host.querySelector<HTMLButtonElement>(`[data-review-file="${file}"] .a-rvw-fhead`)!
}

describe("REQ-125 C2 review panel real Solid mount", () => {
  test("change list renders totals, kind badges, weakened dirs, and starts collapsed", async () => {
    const host = mount()
    await flush()

    const root = host.querySelector<HTMLElement>("[data-alpha-session-review]")!
    expect(root.getAttribute("data-review-phase")).toBe("changes")

    const summary = root.querySelector(".a-rvw-sum")!
    expect(summary.textContent).toContain("本回合变更")
    expect(summary.querySelector(".a-rvw-stat-add")!.textContent).toBe("+104")
    expect(summary.querySelector(".a-rvw-stat-del")!.textContent).toBe("−21")

    const cards = root.querySelectorAll("[data-review-file]")
    expect(cards).toHaveLength(3)
    expect(cards[0]!.querySelector(".a-rvw-dir")!.textContent).toBe("alpha-ui/")
    expect(cards[0]!.querySelector(".a-rvw-kind--modified")!.textContent).toBe("修改")
    expect(cards[1]!.querySelector(".a-rvw-kind--added")!.textContent).toBe("新增")
    expect(cards[1]!.querySelector(".a-rvw-dir")).toBeNull()
    expect(cards[2]!.querySelector(".a-rvw-kind--deleted")!.textContent).toBe("删除")

    // I7: collapsed by default — no diff DOM until a card is opened.
    expect(root.querySelectorAll(".a-rvw-fbody")).toHaveLength(0)
    cards.forEach((card) => expect(card.querySelector(".a-rvw-fhead")!.getAttribute("aria-expanded")).toBe("false"))
  })

  test("expanding a card shows folds, gutters, signs, block nav, and comment entry", async () => {
    const host = mount()
    await flush()

    headOf(host, "alpha-ui/button.css").click()
    await flush()

    const card = host.querySelector('[data-review-file="alpha-ui/button.css"]')!
    expect(card.querySelector(".a-rvw-fhead")!.getAttribute("aria-expanded")).toBe("true")

    const folds = card.querySelectorAll<HTMLButtonElement>("[data-review-fold]")
    expect(folds).toHaveLength(3)
    expect(folds[0]!.textContent).toContain("展开未更改的 3 行")

    const del = card.querySelector(".a-rvw-dl--del")!
    expect(del.querySelector(".a-rvw-gut")!.textContent).toBe("4")
    expect(del.querySelector(".a-rvw-sign")!.textContent).toBe("−")
    const add = card.querySelector(".a-rvw-dl--add")!
    expect(add.querySelector(".a-rvw-gut")!.textContent).toBe("4")
    expect(add.querySelector(".a-rvw-sign")!.textContent).toBe("+")
    expect(add.querySelector<HTMLButtonElement>(".a-rvw-cmt")!.getAttribute("aria-label")).toBe("添加评论")

    const nav = card.querySelector(".a-rvw-hunknav")!
    expect(nav.textContent).toContain("改动块")
    expect(nav.querySelector(".a-rvw-hunknum")!.textContent).toBe("1 / 2")
    nav.querySelectorAll("button")[1]!.click()
    await flush()
    expect(nav.querySelector(".a-rvw-hunknum")!.textContent).toBe("2 / 2")
  })

  test("clicking a fold reveals its unchanged lines in place", async () => {
    const host = mount()
    await flush()

    headOf(host, "alpha-ui/button.css").click()
    await flush()
    const card = host.querySelector('[data-review-file="alpha-ui/button.css"]')!
    const before = card.querySelectorAll(".a-rvw-dl").length

    card.querySelector<HTMLButtonElement>("[data-review-fold]")!.click()
    await flush()

    expect(card.querySelectorAll(".a-rvw-dl").length).toBe(before + 3)
    expect(card.querySelectorAll("[data-review-fold]")).toHaveLength(2)
    expect(card.textContent).toContain("ctx1")
  })

  test("large folds reveal in bounded chunks (I7)", async () => {
    const host = mount()
    await flush()
    runtime.setReviewChanges([runtime.bigFoldReviewChange()])
    await flush()

    headOf(host, "big.txt").click()
    await flush()
    const card = host.querySelector('[data-review-file="big.txt"]')!
    const fold = () => card.querySelector<HTMLButtonElement>("[data-review-fold]")

    expect(fold()!.textContent).toContain("展开未更改的 450 行")
    fold()!.click()
    await flush()
    expect(card.querySelectorAll(".a-rvw-dl:not(.a-rvw-dl--add):not(.a-rvw-dl--del)")).toHaveLength(400)
    expect(fold()!.textContent).toContain("展开未更改的 50 行")

    fold()!.click()
    await flush()
    expect(fold()).toBeNull()
    expect(card.querySelectorAll(".a-rvw-dl:not(.a-rvw-dl--add):not(.a-rvw-dl--del)")).toHaveLength(450)
  })

  test("unified and split views toggle; split pairs deletions left, additions right", async () => {
    const host = mount()
    await flush()

    headOf(host, "alpha-ui/button.css").click()
    await flush()
    const root = host.querySelector<HTMLElement>("[data-alpha-session-review]")!
    const seg = root.querySelectorAll<HTMLButtonElement>(".a-rvw-seg button")
    expect(seg[0]!.getAttribute("aria-pressed")).toBe("true")
    expect(root.querySelector(".a-rvw-split")).toBeNull()

    seg[1]!.click()
    await flush()
    expect(seg[1]!.getAttribute("aria-pressed")).toBe("true")
    const split = root.querySelector('[data-review-file="alpha-ui/button.css"] .a-rvw-split')!
    const cols = split.querySelectorAll(".a-rvw-col")
    expect(cols).toHaveLength(2)
    expect(cols[0]!.querySelectorAll(".a-rvw-sl--del")).toHaveLength(1)
    expect(cols[0]!.querySelectorAll(".a-rvw-sl--blank")).toHaveLength(1)
    expect(cols[1]!.querySelectorAll(".a-rvw-sl--add")).toHaveLength(2)

    seg[0]!.click()
    await flush()
    expect(root.querySelector(".a-rvw-split")).toBeNull()
  })

  test("the two empty states use distinct copy and icons", async () => {
    const host = mount()
    await flush()

    runtime.setReviewPhase("no-vcs")
    await flush()
    const noVcs = host.querySelector('[data-review-empty="no-vcs"]')!
    expect(noVcs.textContent).toContain("这个项目还没有版本管理")
    expect(noVcs.textContent).toContain("把项目放进版本管理后")
    expect(host.querySelector(".a-rvw-sum")).toBeNull()

    runtime.setReviewPhase("clean")
    await flush()
    expect(host.querySelector('[data-review-empty="no-vcs"]')).toBeNull()
    const clean = host.querySelector('[data-review-empty="clean"]')!
    // REQ-142 AC4: the clean copy states the turn-level semantics honestly.
    expect(clean.textContent).toContain("本回合没有文件变更")
    expect(clean.textContent).toContain("助手在回合中修改文件后")
    expect(clean.querySelector("svg path")!.getAttribute("d")).not.toBe(
      noVcs.querySelector("svg path")!.getAttribute("d"),
    )
  })

  test("expand-all opens every card and flips to collapse-all", async () => {
    const host = mount()
    await flush()

    const expand = host.querySelector<HTMLButtonElement>(".a-rvw-expand")!
    expect(expand.textContent).toContain("全部展开")
    expand.click()
    await flush()

    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(3)
    expect(expand.textContent).toContain("全部收起")

    expand.click()
    await flush()
    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(0)
  })

  test("an identity switch resets panel-local view state (I8)", async () => {
    const host = mount()
    await flush()

    headOf(host, "alpha-ui/button.css").click()
    await flush()
    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(1)

    runtime.setReviewResetKey("identity-b")
    await flush()
    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(0)
    expect(headOf(host, "alpha-ui/button.css").getAttribute("aria-expanded")).toBe("false")
  })

  test("the inline comment entry reports the file and line", async () => {
    const host = mount()
    await flush()

    headOf(host, "alpha-ui/button.css").click()
    await flush()
    const add = host.querySelector(".a-rvw-dl--add")!
    add.querySelector<HTMLButtonElement>(".a-rvw-cmt")!.click()
    await flush()

    const log = runtime.reviewCommentLog()
    expect(log).toHaveLength(1)
    expect(log[0]!.file).toBe("alpha-ui/button.css")
    expect(log[0]!.line).toMatchObject({ kind: "add", newLine: 4 })
  })

  test("oversized patches never parse and show the bounded placeholder with stats", async () => {
    const host = mount()
    await flush()
    runtime.setReviewChanges([runtime.oversizedReviewChange()])
    await flush()

    headOf(host, "huge.bin.txt").click()
    await flush()

    const placeholder = host.querySelector("[data-review-oversized]")!
    expect(placeholder.textContent).toContain("变更过大,已折叠")
    expect(placeholder.querySelector(".a-rvw-stat-add")!.textContent).toBe("+9000")
    expect(placeholder.querySelector(".a-rvw-stat-del")!.textContent).toBe("−4000")
    expect(host.querySelectorAll(".a-rvw-dl")).toHaveLength(0)
    expect(host.querySelectorAll("[data-review-fold]")).toHaveLength(0)
  })

  test("prototype-colliding file names keep strict boolean open state", async () => {
    const host = mount()
    await flush()
    runtime.setReviewChanges(runtime.prototypeNamedReviewChanges())
    await flush()

    // With a plain-object map, reading "__proto__"/"constructor" walks the
    // prototype chain and the cards would render pre-opened.
    const heads = host.querySelectorAll<HTMLButtonElement>(".a-rvw-fhead")
    expect(heads).toHaveLength(2)
    heads.forEach((head) => expect(head.getAttribute("aria-expanded")).toBe("false"))
    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(0)

    heads[0]!.click()
    await flush()
    expect(heads[0]!.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(1)

    heads[0]!.click()
    await flush()
    expect(host.querySelectorAll(".a-rvw-fbody")).toHaveLength(0)
  })

  test("a files-panel focus target opens the file card and moves focus onto it", async () => {
    const host = mount()
    await flush()

    const card = (file: string) => host.querySelector(`[data-review-file='${file}']`)!
    expect(card("架构说明.md").classList.contains("a-rvw-file--open")).toBe(false)

    runtime.setReviewFocusTarget("架构说明.md")
    await flush()
    expect(card("架构说明.md").classList.contains("a-rvw-file--open")).toBe(true)
    expect(document.activeElement).toBe(card("架构说明.md").querySelector(".a-rvw-fhead"))

    // A fresh jump to another badged file re-targets; unknown files are a no-op.
    runtime.setReviewFocusTarget("alpha-ui/button.css")
    await flush()
    expect(card("alpha-ui/button.css").classList.contains("a-rvw-file--open")).toBe(true)
    expect(document.activeElement).toBe(card("alpha-ui/button.css").querySelector(".a-rvw-fhead"))
    runtime.setReviewFocusTarget("not-in-change-set.ts")
    await flush()
    expect(card("alpha-ui/button.css").classList.contains("a-rvw-file--open")).toBe(true)
  })
})

describe("REQ-125 C2 / REQ-142 data container against the typed channel", () => {
  test("syncs the session's messages once and renders the latest turn's diffs as they arrive", async () => {
    const host = mountContainer()
    await flush()

    expect(fakeSync.fakeSyncSyncCalls()).toEqual(["ses_a"])
    const root = host.querySelector<HTMLElement>("[data-alpha-session-review]")!
    expect(root.getAttribute("data-review-phase")).toBe("loading")
    expect(host.querySelectorAll("[data-review-file]")).toHaveLength(0)

    // REQ-142 supply shape: the turn's user message carries summary.diffs.
    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u1", [containerRuntime.containerDiffFixture()]),
    ])
    await flush()

    expect(root.getAttribute("data-review-phase")).toBe("changes")
    expect(host.querySelectorAll("[data-review-file]")).toHaveLength(1)
    // Data arrival must not re-trigger the loader (idempotent load).
    expect(fakeSync.fakeSyncSyncCalls()).toEqual(["ses_a"])
  })

  test("a new turn without file changes clears the previous turn's cards (REQ-142 AC4)", async () => {
    const host = mountContainer()
    await flush()
    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u1", [containerRuntime.containerDiffFixture()]),
    ])
    await flush()
    const root = host.querySelector<HTMLElement>("[data-alpha-session-review]")!
    expect(root.getAttribute("data-review-phase")).toBe("changes")

    // Next turn begins: a fresh user message lands; it changed nothing.
    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u1", [containerRuntime.containerDiffFixture()]),
      fakeSync.fakeSyncUserMessage("msg_u2"),
    ])
    await flush()
    expect(root.getAttribute("data-review-phase")).toBe("clean")
    expect(host.querySelector('[data-review-empty="clean"]')).not.toBeNull()
    // No residue from turn 1 (never aggregate across turns).
    expect(host.querySelectorAll("[data-review-file]")).toHaveLength(0)

    // The empty turn's summarize then lands an explicit empty diff set — still clean.
    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u1", [containerRuntime.containerDiffFixture()]),
      fakeSync.fakeSyncUserMessage("msg_u2", []),
    ])
    await flush()
    expect(root.getAttribute("data-review-phase")).toBe("clean")
  })

  test("malformed store payloads degrade to the clean empty state without crashing", async () => {
    const host = mountContainer()
    await flush()

    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u1", [null, 42, {}, { file: "" }, { file: 7 }, { file: "ok.ts", patch: 9 }]),
    ])
    await flush()
    const root = host.querySelector<HTMLElement>("[data-alpha-session-review]")!
    expect(root.getAttribute("data-review-phase")).toBe("clean")
    expect(host.querySelector('[data-review-empty="clean"]')).not.toBeNull()
    expect(host.querySelectorAll("[data-review-file]")).toHaveLength(0)

    // Hostile store content around the projection must not throw either:
    // non-object messages, a non-array diffs value, a summary that is not an object.
    fakeSync.fakeSyncSetMessages("ses_a", [
      null,
      42,
      { role: "user", id: "msg_u2", summary: { diffs: { corrupt: true } } },
    ])
    await flush()
    expect(root.getAttribute("data-review-phase")).toBe("clean")
    expect(host.querySelectorAll("[data-review-file]")).toHaveLength(0)
  })

  test("the comment intent flows out through the container wiring", async () => {
    const host = mountContainer()
    await flush()
    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u1", [containerRuntime.containerDiffFixture()]),
    ])
    await flush()

    host.querySelector<HTMLButtonElement>(".a-rvw-fhead")!.click()
    await flush()
    host.querySelector(".a-rvw-dl--add")!.querySelector<HTMLButtonElement>(".a-rvw-cmt")!.click()
    await flush()

    const intents = containerRuntime.containerIntents()
    expect(intents).toHaveLength(1)
    expect(intents[0]!.file).toBe("alpha-ui/button.css")
    expect(intents[0]!.line).toMatchObject({ kind: "add", newLine: 1 })
  })

  test("a stale result for the previous session is never rendered after switching (I8)", async () => {
    const host = mountContainer()
    await flush()
    expect(fakeSync.fakeSyncSyncCalls()).toEqual(["ses_a"])

    // Switch to session B while A's load is still outstanding.
    containerRuntime.setContainerSession("ses_b")
    await flush()
    expect(fakeSync.fakeSyncSyncCalls()).toEqual(["ses_a", "ses_b"])

    fakeSync.fakeSyncSetMessages("ses_b", [
      fakeSync.fakeSyncUserMessage("msg_u1", [{ file: "b-file.ts", additions: 1, deletions: 0, status: "added" }]),
    ])
    await flush()

    // A's stale result arrives late — it lands keyed under A and must not surface.
    fakeSync.fakeSyncSetMessages("ses_a", [
      fakeSync.fakeSyncUserMessage("msg_u2", [
        { file: "a-file.ts", additions: 3, deletions: 3, status: "modified" },
        { file: "a2.ts", additions: 1, deletions: 1, status: "modified" },
      ]),
    ])
    await flush()

    const files = [...host.querySelectorAll("[data-review-file]")].map((el) => el.getAttribute("data-review-file"))
    expect(files).toEqual(["b-file.ts"])
    // Switching back reads A from the keyed store without a duplicate load.
    containerRuntime.setContainerSession("ses_a")
    await flush()
    expect(fakeSync.fakeSyncSyncCalls()).toEqual(["ses_a", "ses_b"])
    expect(host.querySelectorAll("[data-review-file]")).toHaveLength(2)
  })
})
