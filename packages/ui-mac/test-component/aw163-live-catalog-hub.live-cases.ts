// aw#163 / REQ-128 —— 真 Solid DOM + 生产 ExtensionHub / ExtensionDetail,喂**公网 stable 的真载荷**。
//
// 为什么要有这一份:`test-component/ext-package-detail-wiring.cases.ts` 第 1-3 行自己写着
// 「随包 catalog 当前没有 packages[];下列五态均由 pin 的 producer corpus 显式构造,
//  **不声称线上已经有 package 流量**」。aw#163 要证的恰恰是那句被排除的话。
// 所以这份 harness 只改一件事:catalog 不是夹具,是 `refreshRemoteCatalog(userData,"stable")`
// 从 https://codepuppy.cn/catalog/v1 拉下来、经全链验签与 main 评估的**那一份**。
// 其余(happy-dom / solid dom 构建 / 生产组件 / IPC 注册面)与那份用例逐条同形。
//
// ⚠️ 打真网络 ⇒ **不进任何闸门**,也不放在 packages/ui-mac/src 下(`bun test src` 的采集面)。
// 文件名后缀 `.live-cases.ts`(不是 `.cases.ts`)是刻意的:仓里每一个 `.cases.ts` 都由一个
// `src/**/*.test.ts` 起子进程跑,是闸门的一部分;**这一份没有、也不该有那个 spawner**。
// 跑法(cwd 必须是 packages/ui-mac,才吃得到它 bunfig 的 zh locale preload):
//   bun test test-component/aw163-live-catalog-hub.live-cases.ts
// 证据落点:docs/verification/2026-08-26-req128-163-desktop-live-package/

import { expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  PACKAGE_DETAIL_IPC_CHANNEL,
  refreshRemoteCatalog,
  registerPackageCatalogReadIpcHandlers,
} from "../src/main/remote-catalog"
import { dict as zh } from "../src/renderer/i18n/zh"

// ── 独立字面量(2026-08-26 curl 直取,逐字抄写)────────────────────────────────────────────
const CATALOG_ID = "package:alpha-first"
const DISPLAY_NAME = "Alpha install check"
const DESCRIPTION =
  "A single first-party skill that checks an Alpha extension package finished installing and reports what landed on disk. Local state only: no network, no credentials, no writes."
const VERSION = "1.0.0"

// ── 真 IPC 注册面(main 侧)——`ext-ipc.ts:356-358` 逐字同形,零 deps 注入 ⇒ 真网络 ───────────
const tmp = mkdtempSync(join(tmpdir(), "aw163-hub-"))
const userData = join(tmp, "user-data")
type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
registerPackageCatalogReadIpcHandlers(
  (channel, handler) => handlers.set(channel, handler),
  () => refreshRemoteCatalog(userData, "stable"),
)

// ── renderer 侧:DOM + Solid 的 dom 构建 + 生产组件 ────────────────────────────────────────
//
// ⚠️ `GlobalRegistrator.register()` 会把 `globalThis.fetch` 换成 happy-dom 那个**带同源策略**的
// 实现,于是 main 侧的 catalog 客户端会拿到 `Cross-Origin Request Blocked` 而整条链 fail-closed
// ——那是 harness 自己造的假红:生产的 main 进程跑在 Node 里,用的是 Node 的 fetch。
// 所以这里把 Node 的 fetch 存下来,注册之后**还原全局** ——不是往生产代码里注入 dep,
// 而是把 harness 自己加的那层 DOM 垫片撤掉。renderer 侧不直接 fetch(它只走 window.api)。
const nodeFetch = globalThis.fetch
GlobalRegistrator.register()
globalThis.fetch = nodeFetch
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
// `solid-js/store` 少这一行**不报错**,是静默失去反应性(store 变了 memo 永不重跑)。
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "aw163-live-hub-solid",
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

const extensions = {
  store: {
    mcp: {},
    receipts: [],
    projectReceipts: [],
    agents: [],
    sessionGrants: [],
    sessionLink: {},
    ready: true,
    error: false,
  },
  factorySkills: () => [],
  isInstalled: () => false,
  refresh: async () => {},
  refreshEngine: async () => true,
  listInstalledPackages: async () => ({ ok: true as const, packages: [] }),
  uninstallPackage: async () => ({ ok: false as const, reason: "not exercised here" }),
  installCatalogIntent: async () => ({ ok: false as const, reason: "not exercised here" }),
}
const realUseExtensionsModule = await import("../src/renderer/extensions/use-extensions")
mock.module("../src/renderer/extensions/use-extensions", () => ({
  ...realUseExtensionsModule,
  useExtensions: () => extensions,
  isAuthzRequired: () => false,
  isLocalPluginRoute: () => false,
}))
mock.module("../src/renderer/auth-recovery", () => ({
  subscribeAuthState: (listener: (state: { status: "logged-out"; mode: "byok" }) => void) => {
    listener({ status: "logged-out", mode: "byok" })
    return () => {}
  },
}))
mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "/" }) }))
mock.module("../src/renderer/alpha-ui/Banner", () => ({ Banner: () => null }))

const browseResults: unknown[] = []
const detailResults: unknown[] = []
Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    updater: { check: async () => {} },
    auth: { start: async () => {} },
    ext: {
      remoteCatalog: async () => {
        const result = await handlers.get("ext-remote-catalog")!(undefined)
        browseResults.push(result)
        return result
      },
      packageDetail: async (catalogId: string) => {
        const result = await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(undefined, catalogId)
        detailResults.push(result)
        return result
      },
      installCatalog: async () => ({ ok: false as const, reason: "install not exercised in this harness" }),
      packageInstalled: async () => ({ installed: false as const }),
      uninstallPackage: async () => ({ ok: false as const, reason: "not exercised here" }),
      inventoryView: async () => undefined,
      advisoryActive: async () => ({ ids: [], fresh: true }),
      migrateScan: async () => ({ enabled: false, inventory: { skills: [], mcp: [], plugins: [] } }),
      onSessionGrantsEnded: () => () => {},
    },
  },
})

const { createComponent } = solid
const { render } = solidWeb
// **动态** import:静态 import 会在 registrator 之前牵出 solid-js,整个文件拿到 server 构建。
const { ExtensionHub } = await import("../src/renderer/extensions/extension-hub")
const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
const { setHubSection } = await import("../src/renderer/extensions/ext-hub-state")

const flush = () => new Promise((r) => setTimeout(r, 0))
async function waitFor(assertion: () => void) {
  let failure: unknown
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
      await flush()
    }
  }
  throw failure
}
const click = (element: Element | null) => {
  expect(element).toBeInstanceOf(HTMLElement)
  ;(element as HTMLElement).click()
}

test("live stable catalog 的 package:alpha-first 走到生产 ExtensionHub 卡片与 ExtensionDetail 详情页", async () => {
  setHubSection("featured")
  const root = document.createElement("div")
  root.id = "root"
  root.className = "a-ui"
  document.body.append(root)
  render(() => createComponent(ToastViewport, {}), document.body.appendChild(document.createElement("div")))
  render(
    () => createComponent(ExtensionHub, { server: () => undefined, open: () => true, onClose: () => {} }),
    root,
  )

  // ── AC1:卡片真的出现在 Hub 的 DOM 里 ─────────────────────────────────────────────────
  await waitFor(() =>
    expect(document.querySelector(`[data-package-card="${CATALOG_ID}"]`)).toBeInstanceOf(HTMLElement),
  )
  const cards = Array.from(document.querySelectorAll("[data-package-card]"), (c) =>
    c.getAttribute("data-package-card"),
  )
  console.log(`[AC1] data-package-card = ${JSON.stringify(cards)}`)
  expect(cards).toEqual([CATALOG_ID])

  // catalog 真的是从公网取的(不是缓存/内置):这一趟 IPC 的返回值自证
  const browse = browseResults.at(-1) as { source: string; via: string; channel: string; version: string }
  console.log(`[AC1] ext-remote-catalog → source=${browse.source} via=${browse.via} channel=${browse.channel} version=${browse.version}`)
  expect({ source: browse.source, via: browse.via, channel: browse.channel }).toEqual({
    source: "remote",
    via: "channel-stable",
    channel: "stable",
  })

  const card = document.querySelector<HTMLElement>(`[data-package-card="${CATALOG_ID}"]`)!
  const cardFacts = {
    catalogId: card.getAttribute("data-package-card"),
    verdict: card.querySelector("[data-verdict]")?.getAttribute("data-verdict"),
    prerequisite: card.querySelector("[data-prerequisite]")?.getAttribute("data-prerequisite"),
    action: card.querySelector("button")?.textContent?.trim(),
    text: card.textContent,
  }
  console.log(`[AC1] card = ${JSON.stringify({ ...cardFacts, text: undefined })}`)
  expect({
    catalogId: cardFacts.catalogId,
    verdict: cardFacts.verdict,
    prerequisite: cardFacts.prerequisite,
    action: cardFacts.action,
  }).toEqual({
    catalogId: CATALOG_ID,
    verdict: "compatible",
    prerequisite: "ready",
    action: zh["alpha.ext.packageActionInstall"],
  })
  expect(cardFacts.text).toContain(DISPLAY_NAME)
  expect(cardFacts.text).toContain(DESCRIPTION)

  // 搜索框:用户打「alpha-first」筛得到它(浏览面真的接在同一份 live 数据上)
  const search = document.querySelector<HTMLInputElement>(".alpha-ext-search input")
  expect(search).toBeInstanceOf(HTMLInputElement)
  search!.value = "alpha install check"
  search!.dispatchEvent(new Event("input", { bubbles: true }))
  await waitFor(() =>
    expect(
      Array.from(document.querySelectorAll("[data-package-card]"), (c) => c.getAttribute("data-package-card")),
    ).toEqual([CATALOG_ID]),
  )
  search!.value = "zzz-no-such-package"
  search!.dispatchEvent(new Event("input", { bubbles: true }))
  await waitFor(() => expect(document.querySelectorAll("[data-package-card]").length).toBe(0))
  search!.value = ""
  search!.dispatchEvent(new Event("input", { bubbles: true }))
  await waitFor(() =>
    expect(document.querySelector(`[data-package-card="${CATALOG_ID}"]`)).toBeInstanceOf(HTMLElement),
  )

  // ── AC2:点开卡片,详情页 DOM 逐节正确 ────────────────────────────────────────────────
  click(document.querySelector(`[data-package-card="${CATALOG_ID}"]`))
  await waitFor(() =>
    expect(document.querySelector(`[data-package-detail='${CATALOG_ID}']`)).toBeInstanceOf(HTMLElement),
  )
  await waitFor(() => expect(detailResults.length).toBeGreaterThan(0))
  console.log(`[AC2] ext-package-detail → ${JSON.stringify(detailResults.at(-1))}`)

  const detail = document.querySelector<HTMLElement>("[data-package-detail]")!
  const headings = Array.from(detail.querySelectorAll(".alpha-ext-dsec-t"), (h) => h.textContent)
  console.log(`[AC2] detail h2 = ${JSON.stringify(detail.querySelector("h2")?.textContent)}`)
  console.log(`[AC2] detail about = ${JSON.stringify(detail.querySelector(".alpha-ext-dabout")?.textContent)}`)
  console.log(`[AC2] detail version = ${JSON.stringify(detail.querySelector(".alpha-ext-dhead-meta span")?.textContent?.trim())}`)
  console.log(`[AC2] detail sections = ${JSON.stringify(headings)}`)

  expect(detail.querySelector("h2")?.textContent).toBe(DISPLAY_NAME)
  expect(detail.querySelector(".alpha-ext-dabout")?.textContent).toBe(DESCRIPTION)
  expect(detail.querySelector(".alpha-ext-dhead-meta span")?.textContent?.trim()).toBe(
    `${zh["alpha.ext.detailVersion"]} ${VERSION}`,
  )
  expect(headings).toEqual([
    zh["alpha.ext.detailAbout"],
    zh["alpha.ext.packageInstallability"],
    zh["alpha.ext.packageComponentsTitle"],
    zh["alpha.ext.packageReasonTitle"],
    zh["alpha.ext.packageActions"],
  ])
  const sections = Array.from(detail.querySelectorAll(".alpha-ext-dsec"), (s) => s.textContent ?? "")
  expect(sections[0]).toContain(DESCRIPTION)
  expect(sections[1]).toContain(zh["alpha.ext.packageVerdictCompatible"])
  expect(sections[2]).toContain("skill:alpha-first")
  expect(sections[3]).toContain(zh["alpha.ext.packageReasonCompatible"])
  expect(sections[4]).toContain(zh["alpha.ext.packageActionInstall"])

  // 安全投影:**package 面**过线的是 view,不含 raw envelope 的任何传输事实。
  // 扫描对象只取 `catalog.packages` 与详情返回值 —— legacy `entries[]` 本来就合法地带着
  // 资产 URL(remoteIndexUrl 等),把它一起扫进来是断言写宽了,不是缺陷(实测踩过一次)。
  const browsedCatalog = (browseResults.at(-1) as { catalog: { packages?: unknown[] } }).catalog
  const wire = JSON.stringify({ packages: browsedCatalog.packages, detail: detailResults.at(-1) })
  console.log(`[AC1/AC2] package 面过线字节 = ${wire}`)
  for (const forbidden of ["payloadRef", "catalog/assets", "sigUrl", "495b415b", "https://"])
    expect(wire).not.toContain(forbidden)

  rmSync(tmp, { recursive: true, force: true })
}, 120_000)
