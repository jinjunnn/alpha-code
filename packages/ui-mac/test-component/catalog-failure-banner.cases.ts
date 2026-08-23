// #1084(#987 CHOICE=A,DECIDE #1078)—— 平台目录刷新失败在 renderer 的**可观察出口**。
//
// main 侧那半场的闸在 src/main/models-catalog-v2.wiring.cases.ts(分类码经生产 IPC 到达
// alpha-catalog-health / alpha-catalog-failure)。本文件接着往下走一跳:renderer 拿到那两个
// 口子之后,**真的把它渲染成一条用户看得见的横幅**。
//
// 判据全部是可观察结果:真挂载生产组件 `CatalogFailureBanner`(不是这里重写一份等价物),
// 喂一个只实现那两个方法的 preload 桥替身,对**真 DOM** 断言。不断言源码文本 —— 源码文本
// 断言对「组件还在但渲染出空节点」照样通过(ADR-037 决策 4)。
//
// 反向验证(#1084 退出条件,已实跑):
//   · 把 Banner.tsx 里 `void window.api.models.refreshHealth().then(setFailure)` 删掉
//     ⇒ 「启动那次失败」组转红(启动刷新早于 renderer 挂载,只有推送时它到不了用户);
//   · 把 `onCleanup(window.api.models.subscribeRefreshHealth(setFailure))` 删掉
//     ⇒ 「运行期新失败」组转红;
//   · 把 `<Show when={!contract() && failure()}>` 的 `!contract() &&` 去掉
//     ⇒ 「契约横幅在场时自抑制」转红(两条横幅同一个 fixed 位,会精确重叠)。
//
// 独立进程运行:`mock.module("solid-js", …)` 会污染同进程其它测试文件。宿主见
// src/renderer/alpha-ui/catalog-failure-banner.component.test.ts。
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import type { CatalogRefreshFailure } from "../src/shared/alpha-model-types"
import type { ContractFailure } from "../src/preload/types"
// dict 是纯对象,静态 import 无害(index 会在求值期 import "solid-js",那条路要走动态)。
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const { createSignal } = solid
const { render } = solidWeb

Bun.plugin({
  name: "catalog-failure-banner-component-tests",
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

// providers 转口 `@opencode-ai/app`(整棵冻结前端);本闸只用到 useContractHealth,替身即可。
// 契约横幅的在场与否是本组件的**输入**,所以它必须能被用例摆布。
const [contractFailure, setContractFailure] = createSignal<ContractFailure | null>(null)
mock.module("../src/renderer/alpha-ui/providers", () => ({ useContractHealth: () => contractFailure }))

const { CatalogFailureBanner } = await import("../src/renderer/alpha-ui/Banner")

/** preload 桥替身:renderer 侧拿刷新结局只有这两条路,生产组件走的就是它们。 */
function bridge(initial: CatalogRefreshFailure | null) {
  const listeners = new Set<(failure: CatalogRefreshFailure | null) => void>()
  const api = {
    models: {
      refreshHealth: async () => initial,
      subscribeRefreshHealth: (cb: (failure: CatalogRefreshFailure | null) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = api
  return { push: (failure: CatalogRefreshFailure | null) => listeners.forEach((cb) => cb(failure)) }
}

let host: HTMLDivElement
let dispose: (() => void) | undefined
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const banner = () => host.querySelector<HTMLElement>("[data-alpha-catalog-failure]")

beforeEach(() => {
  setContractFailure(null)
  host = document.createElement("div")
  document.body.appendChild(host)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
})

describe("#1084 目录刷新失败到得了用户", () => {
  test("启动那次刷新已经失败 ⇒ 挂载即显示分类码(挂载前的失败不会丢)", async () => {
    bridge({ code: "rate_limited", at: "2026-08-23T00:00:00.000Z" })
    dispose = render(() => CatalogFailureBanner({}), host)
    await flush()

    const node = banner()
    expect(node?.dataset.alphaCatalogFailure).toBe("rate_limited")
    // 文案走 i18n(不是组件里写死的字面量),且分类码真的贴在用户读得到的那行上。
    expect(node?.textContent).toContain(zh["alpha.model.refreshFailedTitle"])
    expect(node?.textContent).toContain("rate_limited")
    // 降级不是阻断:BYOK 与上次缓存照常可用,所以是 warning 而不是 error/alert。
    expect(node?.querySelector(".a-banner")?.className).toContain("warning")
    expect(node?.querySelector(".a-banner")?.getAttribute("role")).toBe("status")
  })

  test("运行期新失败经推送到达;下一次成功刷新把横幅收掉", async () => {
    const { push } = bridge(null)
    dispose = render(() => CatalogFailureBanner({}), host)
    await flush()
    expect(banner()).toBeNull()

    push({ code: "http-503", at: "2026-08-23T00:00:01.000Z" })
    expect(banner()?.dataset.alphaCatalogFailure).toBe("http-503")

    push(null)
    expect(banner()).toBeNull()
  })

  test("契约横幅在场时自抑制(同一个 fixed 位,不抑制就精确重叠)", async () => {
    setContractFailure({
      code: "contract-incompatible",
      surface: "model-catalog",
      expected_version: 2,
      received_version: 1,
      reason: "schema-validation",
    })
    bridge({ code: "contract-incompatible", at: "2026-08-23T00:00:02.000Z" })
    dispose = render(() => CatalogFailureBanner({}), host)
    await flush()
    expect(banner()).toBeNull()

    // 契约横幅撤下之后,同一份刷新结局仍然到得了用户 —— 抑制的是重叠,不是这条信息本身。
    setContractFailure(null)
    expect(banner()?.dataset.alphaCatalogFailure).toBe("contract-incompatible")
  })
})
