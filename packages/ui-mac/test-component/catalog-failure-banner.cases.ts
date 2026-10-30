// #1557(方案 req236 §2.5「模型目录刷新失败提示的位置与语义」· 批准稿 2026-10-30-req236-model-status §二/§四)——
// 全局层**不再**承载模型目录的刷新失败。#1084 起它是 index.tsx 里一条 fixed 横幅(`CatalogFailureBanner`),
// 窄窗口下压住导航与设置入口,而且设置 / 定制中心 / 自动化 / 产物页这些根本不消费模型目录的页面也看得到它。
// 现在提示跟着使用点走(输入框提示槽、选择器分组头 / 弹层底部),判据在 alpha-composer-model.cases.ts 的
// 「#1557 模型状态行与清单失败提示」组;本文件只钉全局层这一半:
//
//   · 全局层剩下的唯一一条契约横幅(`ContractFailureBanner`)对 `surface === "model-catalog"` 不渲染 ——
//     那种情况 main 同时记成目录 health 的 `contract-incompatible`,走上面同一位置(原因「需要更新 Code Puppy」);
//   · 其他契约面的全局横幅照旧(不在本票范围,作控制组);
//   · Banner 模块不再导出全局目录横幅,页面上不存在 `.a-catalog-failure`。
//
// 反向验证:把 Banner.tsx 的 `failure()?.surface !== "model-catalog" &&` 去掉 ⇒ 第一条转红;
// 恢复 `CatalogFailureBanner` 导出 ⇒ 第三条转红。
//
// 独立进程运行:`mock.module("solid-js", …)` 会污染同进程其它测试文件。宿主见
// src/renderer/alpha-ui/catalog-failure-banner.component.test.ts。
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import type { CatalogRefreshHealth } from "../src/shared/alpha-model-types"
import type { ContractFailure } from "../src/preload/types"

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
const [contractFailure, setContractFailure] = createSignal<ContractFailure | null>(null)
mock.module("../src/renderer/alpha-ui/providers", () => ({ useContractHealth: () => contractFailure }))

const BannerModule = await import("../src/renderer/alpha-ui/Banner")
const { ContractFailureBanner } = BannerModule

/** preload 桥替身:目录刷新结局一直是失败 —— 旧的全局横幅在这时一定会出现。`#1556` 起两份目录各一格。 */
function bridge(initial: CatalogRefreshHealth) {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    models: { refreshHealth: async () => initial, subscribeRefreshHealth: () => () => {}, refresh: async () => {} },
  }
}

let host: HTMLDivElement
let dispose: (() => void) | undefined
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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

describe("#1557 模型目录刷新失败不在全局层", () => {
  test("AC5 模型目录契约不兼容:全局契约横幅不渲染(走输入框 / 选择器同一位置)", async () => {
    bridge({ platform: { code: "contract-incompatible", at: "2026-10-30T00:00:00.000Z" }, byok: null })
    setContractFailure({
      code: "contract-incompatible",
      surface: "model-catalog",
      expected_version: 3,
      received_version: 2,
      reason: "schema-validation",
    })
    dispose = render(() => ContractFailureBanner(), host)
    await flush()
    expect(host.querySelector("[data-alpha-contract-failure]")).toBeNull()
    expect(host.textContent).toBe("")
  })

  test("其他契约面的全局横幅照旧(控制组)", async () => {
    setContractFailure({
      code: "contract-incompatible",
      surface: "account",
      expected_version: 1,
      received_version: 2,
      reason: "schema-validation",
    })
    dispose = render(() => ContractFailureBanner(), host)
    await flush()
    expect(host.querySelector("[data-alpha-contract-failure]")?.getAttribute("data-alpha-contract-failure")).toBe("account")
    expect(host.querySelector(".a-contract-failure .a-banner-title")?.textContent).toBe(
      "Code Puppy platform contract is incompatible",
    )
  })

  test("AC5 设置 / 定制中心 / 自动化 / 产物页不显示:全局层没有目录横幅,页面上不存在 .a-catalog-failure", async () => {
    bridge({
      platform: { code: "network", at: "2026-10-30T00:00:00.000Z" },
      byok: { code: "http-503", at: "2026-10-30T00:00:00.000Z" },
    })
    expect(Object.keys(BannerModule).sort()).toEqual(["Banner", "ContractFailureBanner"])
    dispose = render(() => ContractFailureBanner(), host)
    await flush()
    expect(document.querySelector(".a-catalog-failure, [data-alpha-catalog-failure]")).toBeNull()
  })
})
