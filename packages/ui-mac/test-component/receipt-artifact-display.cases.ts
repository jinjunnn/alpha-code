// REQ-105(#319)—— 详情页头部真的把 receipt 上的两个事实说出口。
//
// 为什么必须在真 DOM 上判、而不是只判纯函数:本仓教训「断言内层纯函数 ⇒ 落在分流层的绕过照样
// 绿」。`receiptArtifactFacts` 全绿而 `extension-detail.tsx` 压根没渲染那一段,用户面上什么都
// 看不到 —— 那正是 AC「receipt 落盘**并显示**」里「显示」两个字的全部内容。
//
// ⚠️ 一切会牵出 solid 的模块一律**动态** import,且排在 GlobalRegistrator.register() 与
//    mock.module 之后(静态 import 会让整个文件拿到 server 构建,全文件一起挂在
//    `getNextContextId cannot be used under non-hydrating context`)。`solid-js/store` 同样要钉到
//    dom 构建 —— 少这一行不报错,而是静默失去反应性。

import { afterAll, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "receipt-artifact-display-solid-components",
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

const { createComponent } = solid
const { render } = solidWeb
const { ExtensionDetail } = await import("../src/renderer/extensions/extension-detail")
const { setLocale } = await import("../src/renderer/i18n")
const { dict: en } = await import("../src/renderer/i18n/en")

setLocale("en")

const DIGEST = `sha256:${"ab12".repeat(16)}`
const SHORT = "sha256:ab12ab12ab12…"

/** 真实随包 Excel 卡片的形状(id/name/version/命令都照 `alpha-catalog.json` 里那条)。 */
const excelEntry = {
  id: "mcp:alpha-excel",
  type: "mcp",
  name: "alpha-excel",
  displayName: "Excel 表格读写",
  description: "读写 .xlsx",
  source: "alpha",
  category: "office",
  license: "MIT",
  version: "1.0.0",
  installSpec: {
    kind: "mcp",
    mcpType: "local",
    command: ["uv", "run", "--no-project", "--with", "openpyxl==3.1.5", "{alphaResources}/office-mcp/server.py", "excel", "{workspace}"],
  },
} as never

const disposals: Array<() => void> = []
afterAll(() => {
  for (const dispose of disposals.splice(0)) dispose()
})

/** 挂真 `ExtensionDetail`(生产组件,零替身),receipts 用给定的那一份。 */
function mountDetail(receipts: Array<Record<string, unknown>>, installed: boolean): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  const ext = {
    store: { mcp: {}, receipts, projectReceipts: [], agents: [], sessionGrants: [], sessionLink: {}, ready: true, error: false },
    factorySkills: () => [],
    isInstalled: () => installed,
    refresh: async () => {},
  } as never
  const dispose = render(
    () =>
      createComponent(ExtensionDetail, {
        target: { kind: "entry", entry: excelEntry },
        ext,
        catalogVersion: "2026-08-17.3",
        byId: () => undefined,
        busy: () => null,
        crumb: "Office",
        onBack: () => {},
        onInstall: () => {},
        onPackageAction: async () => undefined,
        onUninstall: () => {},
        onOpenEntry: () => {},
        curationStatus: () => ({ status: "uncurated" }) as never,
        nowIso: () => "2026-08-25T00:00:00Z",
        onToggleState: async () => {},
        sessionViewFor: () => ({ on: false, available: false }) as never,
        sessionAvailable: () => false,
        sessionBusyFor: () => false,
        onSessionToggle: async () => {},
      } as never),
    host,
  )
  disposals.push(dispose)
  disposals.push(() => host.remove())
  return host
}

const digestNode = (host: HTMLElement): HTMLElement | null => host.querySelector("[data-artifact-digest]")

describe("REQ-105 #319 — the detail header states what the install actually executes", () => {
  test("an installed Excel receipt shows its recorded version and artifact digest", () => {
    const host = mountDetail(
      [{ id: "mcp:alpha-excel", name: "alpha-excel", type: "mcp", scope: "global", version: "1.0.0", installedAt: "2026-08-25T00:00:00Z", origin: "catalog", payloadDigest: DIGEST }],
      true,
    )
    const text = host.textContent ?? ""
    // 版本仍然在(审计原文里的 1.0.0)……
    expect(text).toContain(`${en["alpha.ext.detailVersion"]} 1.0.0`)
    // ……但现在它旁边有一个能指认执行物的东西,而且是用户**看得到**的文本,不只是一个属性。
    expect(text).toContain(en["alpha.ext.detailArtifactDigest"])
    expect(text).toContain(SHORT)
    expect(text).not.toContain(en["alpha.ext.detailArtifactDigestUnrecorded"])
    // 完整值可复制/核对(title + data 属性),短形态只是显示。
    const node = digestNode(host)
    expect(node?.getAttribute("data-artifact-digest")).toBe(DIGEST)
    expect(node?.querySelector("code")?.getAttribute("title")).toBe(DIGEST)
  })

  test("an installed receipt without a recorded digest says 'not recorded' — never blank, never the card version", () => {
    const host = mountDetail(
      [{ id: "mcp:alpha-excel", name: "alpha-excel", type: "mcp", scope: "global", version: "1.0.0", installedAt: "2026-08-25T00:00:00Z", origin: "catalog" }],
      true,
    )
    const text = host.textContent ?? ""
    expect(text).toContain(en["alpha.ext.detailArtifactDigest"])
    expect(text).toContain(en["alpha.ext.detailArtifactDigestUnrecorded"])
    expect(text).not.toContain("sha256:")
    expect(digestNode(host)?.getAttribute("data-artifact-digest")).toBe("")
  })

  test("a malformed recorded digest is not presented as an identity", () => {
    const host = mountDetail(
      [{ id: "mcp:alpha-excel", name: "alpha-excel", type: "mcp", scope: "global", version: "1.0.0", installedAt: "2026-08-25T00:00:00Z", origin: "catalog", payloadDigest: "sha256:deadbeef" }],
      true,
    )
    const text = host.textContent ?? ""
    expect(text).toContain(en["alpha.ext.detailArtifactDigestUnrecorded"])
    expect(text).not.toContain("deadbeef")
  })

  test("a not-installed entry shows no artifact-digest row at all", () => {
    const host = mountDetail([], false)
    expect(digestNode(host)).toBeNull()
    expect(host.textContent ?? "").not.toContain(en["alpha.ext.detailArtifactDigest"])
  })
})
