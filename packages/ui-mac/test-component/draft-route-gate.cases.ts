// alpha-code #903 —— `/new-session?draftId=…` 两个非 happy-path 的**真组件**闸门。
//
// 独立进程运行:`mock.module("solid-js", …)` 会污染同进程其它测试文件(与
// new-session-workspace.cases.ts 同因)。宿主见 `src/renderer/alpha-ui/draft-route-gate.component.test.ts`。
//
// 判据全部是**可观察结果**:真挂载 `packages/app/src/pages/draft-route-gate.tsx`(生产模块
// 本体,不是这里重写一份等价物),对真 DOM 断言、对真回调断言。**不断言源码文本** ——
// 源码文本断言对「守卫还在但渲染出空节点」照样通过(ADR-037 决策 4)。
//
// 反向验证(#903 退出条件,已实跑):
//   · 把 `<Show when={props.ready}>` 的 fallback 摘掉 ⇒ "hydrating" 组转红(渲染空节点);
//   · 把内层 `fallback={<DraftRouteMissing …/>}` 换回 `<Navigate href="/" />` 或摘掉
//     ⇒ "missing draft" 组转红(拿不到具名错误态与恢复动作)。
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { mock } from "bun:test"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const { createSignal } = solid
const { render } = solidWeb

// 生产模块住在 packages/app,故 filter 覆盖 app 的 tsx(ui-mac 的 harness 只覆盖自己的)。
Bun.plugin({
  name: "draft-route-gate-component-tests",
  setup(builder) {
    builder.onLoad({ filter: /packages\/(app|ui-mac)\/src\/.*\.tsx$/ }, async (args) => {
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

const { DraftRouteGate } = await import("../../app/src/pages/draft-route-gate")

type Draft = { draftID: string; directory: string }

/** 假 translator:记录被问过的键,并把译文打上标记 —— 组件里写死的字面量拿不到这个标记。 */
function recordingTranslator() {
  const asked: string[] = []
  return {
    asked,
    t: (key: string) => {
      asked.push(key)
      return `i18n:${key}`
    },
  }
}

let host: HTMLDivElement
let dispose: (() => void) | undefined

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
})

afterAll(() => {
  document.body.innerHTML = ""
})

function mount(props: {
  ready: () => boolean
  draft: () => Draft | undefined
  t: (key: string) => string
  onRecover: () => void
}) {
  dispose = render(
    () =>
      DraftRouteGate({
        get ready() {
          return props.ready()
        },
        get draft() {
          return props.draft()
        },
        t: props.t as never,
        onRecover: props.onRecover,
        children: (draft: Draft) => {
          const node = document.createElement("div")
          node.setAttribute("data-component", "draft-leaf")
          node.textContent = draft.draftID
          return node
        },
      }) as never,
    host,
  )
}

const DRAFT: Draft = { draftID: "draft-1", directory: "/tmp/project" }

describe("#903 draft route gate — hydrating", () => {
  test("renders a skeleton, not an empty node, while the tab store is still hydrating", () => {
    const { t, asked } = recordingTranslator()
    mount({ ready: () => false, draft: () => undefined, t, onRecover: () => {} })

    const pending = host.querySelector('[data-component="draft-route-pending"]')
    expect(pending).not.toBeNull()
    // 「不是空白」要正面断言,且不能靠 textContent —— 骨架本来就没有文字。上游那版是
    // `<Show when={ready()}>` 无 fallback,渲染结果连一个元素都没有,所以判据取「有元素」
    // 与「骨架条真的画出来了」两条。
    expect(host.firstElementChild).not.toBeNull()
    expect(pending?.children.length ?? 0).toBeGreaterThan(0)
    expect(host.querySelector('[data-component="draft-leaf"]')).toBeNull()
    expect(host.querySelector('[data-component="draft-route-missing"]')).toBeNull()
    // 加载语义必须是无障碍可读的,不能只是三条灰条。
    expect(pending?.getAttribute("role")).toBe("status")
    expect(pending?.getAttribute("aria-busy")).toBe("true")
    expect(pending?.getAttribute("aria-label")).toBe("i18n:session.draft.pending")
    expect(asked).toContain("session.draft.pending")
  })

  test("hydration completing swaps the skeleton for the real leaf", () => {
    const [ready, setReady] = createSignal(false)
    const { t } = recordingTranslator()
    mount({ ready, draft: () => DRAFT, t, onRecover: () => {} })
    expect(host.querySelector('[data-component="draft-route-pending"]')).not.toBeNull()

    setReady(true)
    expect(host.querySelector('[data-component="draft-route-pending"]')).toBeNull()
    expect(host.querySelector('[data-component="draft-leaf"]')?.textContent).toBe("draft-1")
  })
})

describe("#903 draft route gate — missing / illegal draft", () => {
  test("renders a named error with a recovery action instead of bouncing to home", () => {
    const { t, asked } = recordingTranslator()
    const recovered: number[] = []
    mount({ ready: () => true, draft: () => undefined, t, onRecover: () => recovered.push(1) })

    const missing = host.querySelector('[data-component="draft-route-missing"]')
    expect(missing).not.toBeNull()
    expect(missing?.getAttribute("role")).toBe("alert")
    expect(host.querySelector('[data-component="draft-leaf"]')).toBeNull()

    // 文案必须来自 translator(带 `i18n:` 标记)—— 组件里写死的字面量过不了这条。
    expect(missing?.textContent).toContain("i18n:session.draft.missing.title")
    expect(missing?.textContent).toContain("i18n:session.draft.missing.description")
    expect(asked).toEqual([
      "session.draft.missing.title",
      "session.draft.missing.description",
      "session.draft.missing.action",
    ])

    // 关键的反向断言:守卫**自己不导航**。上游那版一进这条分支就 `<Navigate href="/" />`,
    // 用户什么也没看见就被弹走 —— 这里要求恢复动作由用户点。
    expect(recovered).toEqual([])

    const action = host.querySelector('[data-component="draft-route-missing-action"]') as HTMLButtonElement | null
    expect(action).not.toBeNull()
    expect(action?.textContent).toBe("i18n:session.draft.missing.action")
    action?.click()
    expect(recovered).toEqual([1])
  })

  test("a draft that disappears after hydration falls into the same named error state", () => {
    const [draft, setDraft] = createSignal<Draft | undefined>(DRAFT)
    const { t } = recordingTranslator()
    mount({ ready: () => true, draft, t, onRecover: () => {} })
    expect(host.querySelector('[data-component="draft-leaf"]')).not.toBeNull()

    setDraft(undefined)
    expect(host.querySelector('[data-component="draft-leaf"]')).toBeNull()
    expect(host.querySelector('[data-component="draft-route-missing"]')).not.toBeNull()
  })
})

describe("#903 draft route gate — happy path unchanged", () => {
  test("a resolved draft renders the leaf and neither fallback", () => {
    const { t, asked } = recordingTranslator()
    mount({ ready: () => true, draft: () => DRAFT, t, onRecover: () => {} })

    expect(host.querySelector('[data-component="draft-leaf"]')?.textContent).toBe("draft-1")
    expect(host.querySelector('[data-component="draft-route-pending"]')).toBeNull()
    expect(host.querySelector('[data-component="draft-route-missing"]')).toBeNull()
    // happy path 不该去翻任何 fallback 文案。
    expect(asked).toEqual([])
  })
})
