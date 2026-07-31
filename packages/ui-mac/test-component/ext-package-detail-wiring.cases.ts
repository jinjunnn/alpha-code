// 独立进程运行：真实 Solid DOM 构建 + 生产 ExtensionHub/ExtensionDetail。
// 随包 catalog 当前没有 packages[]；下列五态均由 pin 的 producer corpus 显式构造，
// 只证明生产 renderer 路径可达，不声称线上已经有 package 流量。

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import bundledCatalog from "../src/renderer/extensions/alpha-catalog.json"
import type { CatalogPackageViewV1 } from "../src/shared/catalog-package-view"
import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
} from "../src/shared/host-extension-package-contract/decoder"
import { evaluatePackageForHost, runCatalogInstallWithPackagePreflight } from "../src/main/package-installability"
import {
  evaluateRemoteCatalogPackages,
  PACKAGE_DETAIL_IPC_CHANNEL,
  registerPackageCatalogReadIpcHandlers,
  type RemoteCatalogResult,
} from "../src/main/remote-catalog"
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)

Bun.plugin({
  name: "ext-package-detail-solid-components",
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
}

mock.module("../src/renderer/extensions/use-extensions", () => ({
  useExtensions: () => extensions,
  isAuthzRequired: () => false,
}))
mock.module("../src/renderer/auth-recovery", () => ({
  subscribeAuthState: (listener: (state: { status: "logged-out"; mode: "byok" }) => void) => {
    listener({ status: "logged-out", mode: "byok" })
    return () => {}
  },
}))
mock.module("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/" }),
}))
mock.module("../src/renderer/alpha-ui/Banner", () => ({
  Banner: () => null,
}))

const { createComponent } = solid
const { render } = solidWeb
const { ExtensionHub } = await import("../src/renderer/extensions/extension-hub")
const { setHubSection } = await import("../src/renderer/extensions/ext-hub-state")

const artifact = resolve(import.meta.dir, "../../alpha-contracts-consumer/vendor/alpha-web-extension-package")
const disposals: Array<() => void> = []

const canonicalBytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

const producerCorpus = async () => {
  const compiled = (await Bun.file(resolve(artifact, "expected.mcp-remote.compiled.json")).json()) as {
    envelope: AlphaPackageEnvelopeV1
    payload: PackageProfilePayloadV1
  }
  return {
    envelope: structuredClone(compiled.envelope),
    payload: structuredClone(compiled.payload),
  }
}

const bindPayload = (envelope: AlphaPackageEnvelopeV1, payload: PackageProfilePayloadV1) => {
  const bytes = canonicalBytes(payload)
  envelope.components[0].payloadRef.bytes = bytes.byteLength
  envelope.components[0].payloadRef.sha256 = createHash("sha256").update(bytes).digest("hex")
  return bytes
}

const packageFixture = async () => {
  const ready = await producerCorpus()
  ready.envelope.prelude.packageId = "package:renderer-ready"
  if (ready.payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
    throw new Error("producer corpus profile drifted")
  ready.payload.behavior.requiredSecrets = []
  ready.envelope.capabilities = []
  ready.envelope.components[0].capabilities = []

  const prerequisite = await producerCorpus()
  prerequisite.envelope.prelude.packageId = "package:renderer-prerequisite"
  if (prerequisite.payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
    throw new Error("producer corpus profile drifted")
  prerequisite.payload.behavior.requiredSecrets = ["A_KEY"]
  prerequisite.payload.behavior.headersTemplate = {
    Authorization: "Bearer {A_KEY}; target=REQ128_RENDERER_SECRET_CANARY",
  }

  const update = await producerCorpus()
  update.envelope.prelude.packageId = "package:renderer-update"
  ;(update.envelope.components[0] as { profileId: string }).profileId = "future-profile"

  const blocked = await producerCorpus()
  blocked.envelope.prelude.packageId = "package:renderer-blocked"
  blocked.envelope.components[0].required = false

  const payloadBlocked = await producerCorpus()
  payloadBlocked.envelope.prelude.packageId = "package:renderer-payload-blocked"

  const payloads = new Map<string, Uint8Array>([
    [ready.envelope.prelude.packageId, bindPayload(ready.envelope, ready.payload)],
    [
      prerequisite.envelope.prelude.packageId,
      bindPayload(prerequisite.envelope, prerequisite.payload),
    ],
    [payloadBlocked.envelope.prelude.packageId, new TextEncoder().encode("{}\n")],
  ])
  const envelopes = [
    ready.envelope,
    prerequisite.envelope,
    update.envelope,
    blocked.envelope,
    payloadBlocked.envelope,
  ]
  const raw: RemoteCatalogResult = {
    source: "remote",
    catalog: {
      version: "2026-07-31",
      entries: bundledCatalog.entries,
      packages: envelopes,
    },
    version: "2026-07-31",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    via: "channel-stable",
    channel: "stable",
  }
  // 显式状态,**不要**用调用计数表达「已解决」。R2 审计实测:原来的
  // `prerequisiteEvaluations === 1` 只有一次调用的裕度 —— 将来谁在详情打开前多加或少加
  // 一次 refresh,「已解决」就会静默翻面,而失败信息("Expected ready / Received
  // required-action")完全指不到真因。这正是三个月后没人解释得清的 flaky 的来源。
  let prerequisiteResolved = false
  const resolvePrerequisite = () => {
    prerequisiteResolved = true
  }
  const evaluator = (envelope: unknown) => {
    const packageId = (envelope as AlphaPackageEnvelopeV1).prelude.packageId
    if (packageId !== prerequisite.envelope.prelude.packageId)
      return evaluatePackageForHost(envelope, {
        fetchPayload: async () => payloads.get(packageId) ?? new Uint8Array(),
      })

    if (!prerequisiteResolved)
      return evaluatePackageForHost(envelope, {
        fetchPayload: async () => payloads.get(packageId) ?? new Uint8Array(),
      })

    const resolvedEnvelope = structuredClone(prerequisite.envelope)
    const resolvedPayload = structuredClone(prerequisite.payload)
    resolvedEnvelope.capabilities = []
    resolvedEnvelope.components[0].capabilities = []
    resolvedPayload.behavior.requiredSecrets = []
    resolvedPayload.behavior.headersTemplate = {}
    const resolvedBytes = bindPayload(resolvedEnvelope, resolvedPayload)
    return evaluatePackageForHost(resolvedEnvelope, {
      fetchPayload: async () => resolvedBytes,
    })
  }
  return { raw, evaluator, resolvePrerequisite }
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

async function mountHarness() {
  const fixture = await packageFixture()
  const handlers = new Map<string, Handler>()
  const refresh = () =>
    evaluateRemoteCatalogPackages(fixture.raw, {
      packageEvaluator: fixture.evaluator,
    })
  registerPackageCatalogReadIpcHandlers(
    (channel, handler) => handlers.set(channel, handler),
    refresh,
  )

  const browseResults: unknown[] = []
  const detailResults: unknown[] = []
  const installIntents: unknown[] = []
  let updateChecks = 0
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      updater: {
        check: async () => {
          updateChecks++
        },
      },
      auth: {
        start: async () => {},
      },
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
        installCatalog: async (intent: unknown) => {
          installIntents.push(intent)
          return runCatalogInstallWithPackagePreflight(intent, {
            loadVerifiedCatalog: async () => ({
              source: "remote",
              catalog: fixture.raw.source === "none" ? {} : fixture.raw.catalog,
            }),
            installLegacy: async () => {
              throw new Error("package renderer intent fell through to legacy planner")
            },
            evaluator: fixture.evaluator,
          })
        },
        inventoryView: async () => undefined,
        advisoryActive: async () => ({ ids: [], fresh: true }),
        migrateScan: async () => ({
          enabled: false,
          inventory: { skills: [], mcp: [], plugins: [] },
        }),
        onSessionGrantsEnded: () => () => {},
      },
    },
  })

  setHubSection("featured")
  const root = document.createElement("div")
  root.id = "root"
  root.className = "a-ui"
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(ExtensionHub, {
        server: () => undefined,
        open: () => true,
        onClose: () => {},
      }),
    root,
  )
  disposals.push(dispose)
  await waitFor(() =>
    expect(
      document.querySelectorAll("[data-package-card]").length,
    ).toBe(5),
  )
  return {
    browseResults,
    detailResults,
    installIntents,
    // 让用例显式表达「用户已经把前置条件解决了」,而不是靠数 evaluator 被调了几次。
    resolvePrerequisite: fixture.resolvePrerequisite,
    updateChecks: () => updateChecks,
  }
}

const flush = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0))

async function waitFor(assertion: () => void) {
  let failure: unknown
  for (let attempt = 0; attempt < 80; attempt++) {
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

function packageCard(catalogId: string) {
  const card = document.querySelector<HTMLElement>(`[data-package-card="${catalogId}"]`)
  expect(card).toBeInstanceOf(HTMLElement)
  return card!
}

function click(element: Element | null) {
  expect(element).toBeInstanceOf(HTMLElement)
  ;(element as HTMLElement).click()
}

function expectSafeView(value: unknown) {
  const view = value as CatalogPackageViewV1
  expect(Object.keys(view).sort()).toEqual([
    "action",
    "catalogId",
    "prerequisites",
    "presentation",
    "verdict",
  ])
  expect(Object.keys(view.action).sort()).toEqual(["enabled", "kind", "reasonCode"])
  expect(Object.keys(view.prerequisites).sort()).toEqual(["items", "status"])
  for (const item of view.prerequisites.items)
    expect(Object.keys(item).sort()).toEqual(["label", "prerequisiteId", "required"])
  expect(Object.keys(view.presentation).sort()).toEqual([
    "description",
    "displayName",
    "version",
  ])
}

afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

describe("package detail production renderer path", () => {
  test("registered catalog read handlers feed the real card and detail with safe-view values only", async () => {
    const harness = await mountHarness()
    const browse = harness.browseResults.at(-1) as {
      catalog: { packages: CatalogPackageViewV1[] }
    }
    expect(Object.keys(browse).sort()).toEqual([
      "catalog",
      "channel",
      "fetchedAt",
      "source",
      "version",
      "via",
    ])
    expect(Object.keys(browse.catalog).sort()).toEqual(["entries", "packages", "version"])
    browse.catalog.packages.forEach(expectSafeView)

    for (const expected of [
      {
        catalogId: "package:renderer-ready",
        verdict: "compatible",
        prerequisite: "ready",
        action: zh["alpha.ext.packageActionInstall"],
      },
      {
        catalogId: "package:renderer-prerequisite",
        verdict: "compatible",
        prerequisite: "required-action",
        action: zh["alpha.ext.packageActionResolvePrerequisite"],
      },
      {
        catalogId: "package:renderer-update",
        verdict: "update-required",
        prerequisite: "ready",
        action: zh["alpha.ext.packageActionUpdateAlpha"],
      },
      {
        catalogId: "package:renderer-blocked",
        verdict: "blocked",
        prerequisite: "ready",
        action: zh["alpha.ext.packageActionNone"],
      },
      {
        catalogId: "package:renderer-payload-blocked",
        verdict: "blocked",
        prerequisite: "ready",
        action: zh["alpha.ext.packageActionNone"],
      },
    ]) {
      const card = packageCard(expected.catalogId)
      expect({
        catalogId: card.getAttribute("data-package-card"),
        verdict: card.querySelector("[data-verdict]")?.getAttribute("data-verdict"),
        prerequisite: card.querySelector("[data-prerequisite]")?.getAttribute("data-prerequisite"),
        action: card.querySelector("button")?.textContent?.trim(),
      }).toEqual(expected)
    }

    const search = document.querySelector<HTMLInputElement>(".alpha-ext-search input")
    expect(search).toBeInstanceOf(HTMLInputElement)
    search!.value = "renderer-update"
    search!.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("[data-package-card]")).map(
          (card) => card.getAttribute("data-package-card"),
        ),
      ).toEqual(["package:renderer-update"]),
    )
    search!.value = ""
    search!.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() =>
      expect(document.querySelectorAll("[data-package-card]").length).toBe(5),
    )

    click(packageCard("package:renderer-ready"))
    await waitFor(() =>
      expect(
        document.querySelector("[data-package-detail='package:renderer-ready']"),
      ).toBeInstanceOf(HTMLElement),
    )
    await waitFor(() => expect(harness.detailResults.length).toBeGreaterThan(0))
    expectSafeView(harness.detailResults.at(-1))

    const safeWire = JSON.stringify({
      packages: browse.catalog.packages,
      detail: harness.detailResults.at(-1),
    })
    for (const forbidden of [
      "payloadRef",
      "headersTemplate",
      "requiredSecrets",
      "REQ128_RENDERER_SECRET_CANARY",
      "https://",
    ])
      expect(safeWire).not.toContain(forbidden)

    const detail = document.querySelector("[data-package-detail]")!
    expect(detail.querySelector("h2")?.textContent).toBe("Generic Remote MCP")
    expect(detail.querySelector(".alpha-ext-dabout")?.textContent).toBe(
      "Generic Phase 1 compiler corpus input.",
    )
    expect(detail.querySelector(".alpha-ext-dhead-t .alpha-ext-chip")?.textContent).toBe(
      zh["alpha.ext.packageSourceRemote"],
    )
    expect(detail.querySelector(".alpha-ext-dhead-meta span")?.textContent?.trim()).toBe(
      `${zh["alpha.ext.detailVersion"]} 1.0.0`,
    )
    expect(
      Array.from(detail.querySelectorAll(".alpha-ext-dsec-t")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      zh["alpha.ext.detailAbout"],
      zh["alpha.ext.packageInstallability"],
      zh["alpha.ext.packageComponentsTitle"],
      zh["alpha.ext.packageReasonTitle"],
      zh["alpha.ext.packageActions"],
    ])
    expect(
      Array.from(detail.querySelectorAll(".alpha-ext-dsec")).map(
        (section) => section.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Generic Phase 1 compiler corpus input."),
      expect.stringContaining(
        zh["alpha.ext.packageVerdictCompatible"],
      ),
      expect.stringContaining(
        zh["alpha.ext.packagePrerequisiteReady"],
      ),
      expect.stringContaining(
        zh["alpha.ext.packageReasonCompatible"],
      ),
      expect.stringContaining(
        zh["alpha.ext.packageActionInstall"],
      ),
    ])

    const installCount = harness.installIntents.length
    click(detail.querySelector(".alpha-ext-dsub button"))
    await waitFor(() =>
      expect(harness.installIntents.length).toBe(installCount + 1),
    )
  })

  test("compatible install and prerequisite actions send only intent keys and reach main preflight", async () => {
    const harness = await mountHarness()
    const readyAction = packageCard("package:renderer-ready").querySelector<HTMLButtonElement>("button")!
    expect(readyAction.disabled).toBe(false)
    click(readyAction)
    await waitFor(() => expect(harness.installIntents.length).toBe(1))

    // 先看**未解决**的样子:这一半让 data-* 属性不能被钉成常量 ——
    // 只断言一个值时,把属性写死成那个值照样通过。前后两个不同的值才杀得掉。
    click(packageCard("package:renderer-prerequisite"))
    const beforeDetail = document.querySelector(
      "[data-package-detail='package:renderer-prerequisite']",
    )
    expect(beforeDetail).toBeInstanceOf(HTMLElement)
    expect(beforeDetail?.querySelector(".alpha-ext-dtool code")?.textContent).toBe("A_KEY")
    expect(beforeDetail?.querySelector(".alpha-ext-dtool span")?.textContent).toBe(
      zh["alpha.ext.packageRequired"],
    )
    await waitFor(() =>
      expect({
        prerequisite: beforeDetail?.querySelector("[data-prerequisite]")?.getAttribute("data-prerequisite"),
        verdict: beforeDetail?.querySelector("[data-verdict]")?.getAttribute("data-verdict"),
      }).toEqual({ prerequisite: "required-action", verdict: "compatible" }),
    )
    click(beforeDetail?.querySelector(".alpha-ext-crumb-link") ?? null)
    await waitFor(() => expect(document.querySelector("[data-package-detail]")).toBeNull())

    // 用户在别处补齐了密钥;重新打开时 main 重判应当读到「已就绪」。
    harness.resolvePrerequisite()
    click(packageCard("package:renderer-prerequisite"))
    const prerequisiteDetail = document.querySelector(
      "[data-package-detail='package:renderer-prerequisite']",
    )
    expect(prerequisiteDetail).toBeInstanceOf(HTMLElement)
    await waitFor(() =>
      expect(
        prerequisiteDetail
          ?.querySelector("[data-prerequisite]")
          ?.getAttribute("data-prerequisite"),
      ).toBe("ready"),
    )

    click(prerequisiteDetail?.querySelector(".alpha-ext-dsub button") ?? null)
    await waitFor(() => expect(harness.installIntents.length).toBe(2))
    click(prerequisiteDetail?.querySelector(".alpha-ext-crumb-link") ?? null)
    await waitFor(() => expect(document.querySelector("[data-package-detail]")).toBeNull())
    await waitFor(() =>
      expect({
        prerequisite: packageCard("package:renderer-prerequisite")
          .querySelector("[data-prerequisite]")
          ?.getAttribute("data-prerequisite"),
        text: packageCard("package:renderer-prerequisite")
          .querySelector("[data-prerequisite]")
          ?.textContent,
      }).toEqual({
        prerequisite: "ready",
        text: zh["alpha.ext.packagePrerequisiteReady"],
      }),
    )

    expect(harness.installIntents).toEqual([
      {
        catalogId: "package:renderer-ready",
        scope: { scope: "global" },
      },
      {
        catalogId: "package:renderer-prerequisite",
        scope: { scope: "global" },
      },
    ])
    for (const intent of harness.installIntents) {
      expect(Object.keys(intent as Record<string, unknown>).sort()).toEqual([
        "catalogId",
        "scope",
      ])
      expect(JSON.stringify(intent)).not.toMatch(
        /verdict|action|reasonCode|payload|url|config|secret/i,
      )
    }
  })

  test("update-required checks for an app update and both blocked reasons stay off install IPC", async () => {
    const harness = await mountHarness()
    click(packageCard("package:renderer-update"))
    await waitFor(() =>
      expect(
        document.querySelector("[data-package-detail='package:renderer-update']"),
      ).toBeInstanceOf(HTMLElement),
    )
    // 第二个不同的 verdict 值:与用例 2 的 "compatible" 一起,让 data-verdict 钉不成常量。
    expect(
      document.querySelector("[data-package-detail] [data-verdict]")?.getAttribute("data-verdict"),
    ).toBe("update-required")
    click(document.querySelector("[data-package-detail] .alpha-ext-dsub button"))
    await waitFor(() => expect(harness.updateChecks()).toBe(1))
    expect(harness.installIntents).toEqual([])
    click(document.querySelector(".alpha-ext-crumb-link"))
    await waitFor(() => expect(document.querySelector("[data-package-detail]")).toBeNull())

    for (const catalogId of [
      "package:renderer-blocked",
      "package:renderer-payload-blocked",
    ]) {
      const button = packageCard(catalogId).querySelector<HTMLButtonElement>("button")!
      expect(button.disabled).toBe(true)
      click(button)
    }
    await flush()
    expect(harness.installIntents).toEqual([])
    expect(harness.updateChecks()).toBe(1)

    click(packageCard("package:renderer-blocked"))
    await waitFor(() =>
      expect(document.querySelector("[data-package-detail]")?.textContent).toContain(
        zh["alpha.ext.packageReasonInvalid"],
      ),
    )
    click(document.querySelector(".alpha-ext-crumb-link"))
    await waitFor(() => expect(document.querySelector("[data-package-detail]")).toBeNull())
    click(packageCard("package:renderer-payload-blocked"))
    await waitFor(() =>
      expect(document.querySelector("[data-package-detail]")?.textContent).toContain(
        zh["alpha.ext.packageReasonPayloadIntegrity"],
      ),
    )
  })
})
