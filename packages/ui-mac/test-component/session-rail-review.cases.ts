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
const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetReviewHarness()
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
    expect(clean.textContent).toContain("没有未提交的变更")
    expect(clean.textContent).toContain("本回合还没有改动文件")
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
})
