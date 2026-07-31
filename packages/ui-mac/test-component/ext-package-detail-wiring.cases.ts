// 独立进程运行：真实 Solid DOM 构建 + 生产 ExtensionHub/ExtensionDetail。
// 随包 catalog 当前没有 packages[]；下列五态均由 pin 的 producer corpus 显式构造，
// 只证明生产 renderer 路径可达，不声称线上已经有 package 流量。

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import bundledCatalog from "../src/renderer/extensions/alpha-catalog.json"
import type { CatalogPackageViewV1 } from "../src/shared/catalog-package-view"
import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
} from "../src/shared/host-extension-package-contract/decoder"
import { evaluatePackageForHost, runCatalogInstallWithPackagePreflight } from "../src/main/package-installability"
import { createPackageAdmissionCoordinator } from "../src/main/package-admission"
import { writeCapabilityGrantSync } from "../src/main/ext-capability-grants"
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
const secretCanary = "REQ128_RENDERER_SECRET_CANARY_64f91d"

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
  // 与 requiredSecrets 一起清:宿主规则双向,留着 {NAME} 占位而不声明它 = 自相矛盾的夹具。
  ready.payload.behavior.headersTemplate = {}
  ready.envelope.capabilities = []
  ready.envelope.components[0].capabilities = []

  const prerequisite = await producerCorpus()
  prerequisite.envelope.prelude.packageId = "package:renderer-prerequisite"
  if (prerequisite.payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
    throw new Error("producer corpus profile drifted")
  prerequisite.payload.behavior.requiredSecrets = ["A_KEY"]
  prerequisite.payload.behavior.headersTemplate = {
    Authorization: "Bearer {A_KEY}; target=REQ128_RENDERER_PAYLOAD_CANARY",
  }

  const update = await producerCorpus()
  update.envelope.prelude.packageId = "package:renderer-update"
  ;(update.envelope.components[0] as { profileId: string }).profileId = "future-profile"
  // 与 corpus 不同的 presentation:五个夹具都克隆自同一份 producer corpus,只改了 packageId,
  // 于是 displayName 全是 "Generic Remote MCP" —— 那样断言杀不掉「回落成 packageId」「写死常量」
  // 「取错包」任何一种。update-required 是本票新产生的那一支,给它一份独有的值。
  update.envelope.presentation = {
    displayName: "Renderer Update Package",
    description: "Only this fixture carries this description.",
  }

  const blocked = await producerCorpus()
  blocked.envelope.prelude.packageId = "package:renderer-blocked"
  blocked.envelope.components[0].required = false

  const payloadBlocked = await producerCorpus()
  payloadBlocked.envelope.prelude.packageId = "package:renderer-payload-blocked"

  const readyBytes = bindPayload(ready.envelope, ready.payload)
  const prerequisiteBytes = bindPayload(prerequisite.envelope, prerequisite.payload)
  const payloads = new Map<string, Uint8Array>([
    [ready.envelope.prelude.packageId, readyBytes],
    [prerequisite.envelope.prelude.packageId, prerequisiteBytes],
    [payloadBlocked.envelope.prelude.packageId, new TextEncoder().encode("{}\n")],
  ])
  const payloadsByDigest = new Map([
    [ready.envelope.components[0].payloadRef.sha256, readyBytes],
    [prerequisite.envelope.components[0].payloadRef.sha256, prerequisiteBytes],
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
  let readyInstalled = false
  const complete = (catalogId: string) => {
    if (catalogId === prerequisite.envelope.prelude.packageId) prerequisiteResolved = true
    if (catalogId === ready.envelope.prelude.packageId) readyInstalled = true
  }
  const evaluator = async (envelope: unknown) => {
    const packageId = (envelope as AlphaPackageEnvelopeV1).prelude.packageId
    if (packageId !== prerequisite.envelope.prelude.packageId) {
      const view = await evaluatePackageForHost(envelope, {
        fetchPayload: async () => payloads.get(packageId) ?? new Uint8Array(),
      })
      if (!readyInstalled || packageId !== ready.envelope.prelude.packageId) return view
      return {
        ...view,
        action: { kind: "none" as const, enabled: false, reasonCode: "package-compatible" as const },
        presentation: { ...view.presentation, version: `${view.presentation.version}-installed` },
      }
    }

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
  return {
    raw,
    evaluator,
    complete,
    fetchPayload: async (ref: { sha256: string }) => payloadsByDigest.get(ref.sha256) ?? new Uint8Array(),
  }
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

async function mountHarness(options?: {
  preauthorized?: boolean
  failConfirmationOnce?: boolean
  failPreviewOnce?: boolean
  rejectPreviewOnce?: boolean
}) {
  const fixture = await packageFixture()
  const tmp = mkdtempSync(join(tmpdir(), "package-renderer-wiring-"))
  const globalRoot = join(tmp, "root")
  const userData = join(tmp, "user-data")
  mkdirSync(globalRoot, { recursive: true })
  const previousRoot = process.env.ALPHA_GLOBAL_DIR
  process.env.ALPHA_GLOBAL_DIR = globalRoot
  if (options?.preauthorized)
    writeCapabilityGrantSync(globalRoot, {
      v: 1,
      key: "mcp--generic-remote",
      capabilities: ["alpha.secret-prerequisite.v1"],
      txId: "preauthorized",
      grantedAt: "2026-07-31T00:00:00.000Z",
    })
  const admitPackage = createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: fixture.raw.source === "none" ? {} : fixture.raw.catalog,
      snapshotDigest: "a".repeat(64),
    }),
    root: () => globalRoot,
    userDataPath: userData,
    environment: () => "dev",
    installability: { fetchPayload: fixture.fetchPayload },
    secretVersionId: () => "v-0badcafe",
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  })
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
  const installResults: unknown[] = []
  let failConfirmation = options?.failConfirmationOnce ?? false
  let failPreview = options?.failPreviewOnce ?? false
  let rejectPreview = options?.rejectPreviewOnce ?? false
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
          if (
            rejectPreview &&
            typeof intent === "object" &&
            intent !== null &&
            !("authorization" in intent)
          ) {
            rejectPreview = false
            throw new Error("package renderer transport failed")
          }
          if (
            failPreview &&
            typeof intent === "object" &&
            intent !== null &&
            !("authorization" in intent)
          ) {
            failPreview = false
            const result = { ok: false as const, reason: "package renderer preview unavailable" }
            installResults.push(result)
            return result
          }
          const result = await runCatalogInstallWithPackagePreflight(intent, {
            loadVerifiedCatalog: async () => ({
              source: "remote",
              catalog: fixture.raw.source === "none" ? {} : fixture.raw.catalog,
            }),
            installLegacy: async () => {
              throw new Error("package renderer intent fell through to legacy planner")
            },
            installPackage: async (packageIntent) => {
              if (
                failConfirmation &&
                typeof packageIntent === "object" &&
                packageIntent !== null &&
                "authorization" in packageIntent
              ) {
                failConfirmation = false
                const broken = structuredClone(packageIntent) as {
                  authorization: { binding: unknown }
                }
                return admitPackage({
                  ...broken,
                  authorization: { binding: broken.authorization.binding, confirmed: {} },
                })
              }
              return admitPackage(packageIntent)
            },
            evaluator: fixture.evaluator,
          })
          installResults.push(result)
          if (
            typeof result === "object" &&
            result !== null &&
            "ok" in result &&
            result.ok === true &&
            typeof intent === "object" &&
            intent !== null &&
            "catalogId" in intent &&
            typeof intent.catalogId === "string"
          )
            fixture.complete(intent.catalogId)
          return result
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
  disposals.push(() => {
    if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = previousRoot
    rmSync(tmp, { recursive: true, force: true })
  })
  await waitFor(() =>
    expect(
      document.querySelectorAll("[data-package-card]").length,
    ).toBe(5),
  )
  return {
    browseResults,
    detailResults,
    installIntents,
    installResults,
    globalRoot,
    userData,
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

function packageAuthorizationDialog() {
  const body = document.querySelector<HTMLElement>("[data-package-authorization]")
  expect(body).toBeInstanceOf(HTMLElement)
  const dialog = body!.closest<HTMLElement>("[role='dialog']")
  expect(dialog).toBeInstanceOf(HTMLElement)
  return dialog!
}

function expectDialogContract(
  dialog: HTMLElement,
  expected: { capabilities: string[]; prerequisite?: string },
) {
  expect(
    Array.from(dialog.querySelectorAll(".alpha-ext-authz-id"), (item) => item.textContent),
  ).toEqual(expected.capabilities)
  expect(
    Array.from(dialog.querySelectorAll("[data-kind='new']"), (item) => item.textContent),
  ).toEqual(expected.capabilities.map(() => zh["alpha.ext.authz.chipNew"]))
  const input = dialog.querySelector<HTMLInputElement>(".alpha-ext-key-input")
  const button = dialog.querySelector<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child")
  expect(button).toBeInstanceOf(HTMLButtonElement)
  if (!expected.prerequisite) {
    expect(input).toBeNull()
    expect(button!.disabled).toBe(false)
    return
  }
  expect(dialog.querySelector(".alpha-ext-key-name")?.textContent).toBe(expected.prerequisite)
  expect(input).toBeInstanceOf(HTMLInputElement)
  expect(input!.type).toBe("password")
  expect(button!.disabled).toBe(true)
  input!.value = "dialog-contract-secret"
  input!.dispatchEvent(new Event("input", { bubbles: true }))
  expect(button!.disabled).toBe(false)
}

const waitForPackageAuthorization = (catalogId: string) =>
  waitFor(() =>
    expect(document.querySelector(`[data-package-authorization='${catalogId}']`)).toBeInstanceOf(
      HTMLElement,
    ),
  )

/** 用户把 canary 打进去的那**一个**输入框。canary 扫描只准对这个元素致盲,见 expectNoCanaryAnywhere。 */
let filledSecretInput: HTMLInputElement | null = null

function fillPackageSecret(value: string) {
  const input = packageAuthorizationDialog().querySelector<HTMLInputElement>(".alpha-ext-key-input")
  expect(input).toBeInstanceOf(HTMLInputElement)
  input!.value = value
  input!.dispatchEvent(new Event("input", { bubbles: true }))
  filledSecretInput = input!
}

function confirmPackageAuthorization() {
  const dialog = packageAuthorizationDialog()
  const button = dialog.querySelector<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child")
  expect(button).toBeInstanceOf(HTMLButtonElement)
  expect(button!.disabled).toBe(false)
  click(button)
  expect(dialog.getAttribute("aria-busy")).toBe("true")
  expect(button!.disabled).toBe(true)
  expect(dialog.querySelector(".a-dialog-close")).toBeNull()
}

function cancelPackageAuthorization() {
  click(packageAuthorizationDialog().querySelector(".a-dialog-footer .a-btn:first-child"))
}

const consoleMethods = ["log", "warn", "error", "info", "debug"] as const

function captureConsole() {
  const output: unknown[] = []
  const originals = consoleMethods.map((method) => console[method])
  consoleMethods.forEach((method) => {
    console[method] = (...values: unknown[]) => {
      output.push(...values)
    }
  })
  return {
    output,
    restore: () =>
      consoleMethods.forEach((method, index) => {
        console[method] = originals[index]!
      }),
  }
}

/**
 * 展开成可扫描的字符串。带深度预算继续下潜 —— 只看一层的话,
 * `console.debug("intent", { catalogId, grants: { secrets } })` 这种最像真实回归的形状会整个溜掉。
 * `Error` 取 message:`console.error(new Error(secret))` 同理不能漏。
 */
function ownScalarValues(value: unknown, depth = 4): string[] {
  if (value === null || value === undefined) return []
  if (typeof value !== "object") return typeof value === "function" ? [] : [String(value)]
  if (depth <= 0) return []
  if (value instanceof Error) return [value.message, ...ownScalarValues({ ...value }, depth - 1)]
  if (value instanceof Map)
    return Array.from(value.entries()).flatMap(([k, v]) => [
      ...ownScalarValues(k, depth - 1),
      ...ownScalarValues(v, depth - 1),
    ])
  if (value instanceof Set) return Array.from(value).flatMap((v) => ownScalarValues(v, depth - 1))
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return []
  return Reflect.ownKeys(value).flatMap((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) return [String(key)]
    return [String(key), ...ownScalarValues(descriptor.value, depth - 1)]
  })
}

function expectNoCanaryAnywhere(canary: string, consoleOutput: unknown[]) {
  // 遮蔽是必要的:用户刚打进去的 canary 就在那个框里,不遮蔽会自己撞自己。
  // 但只准遮蔽**用户真正写入的那一个元素**,不能按 `.alpha-ext-key-input[type=password]`
  // 选择器一刀切 —— 那恰好是唯一合法装密钥的 class,生产若把明文渲进第二个同 class 的框,
  // 扫描器会先把它一并清空,泄漏就此隐形(「破坏它 = 破坏观测它」)。
  // 按身份遮蔽之后,任何**别的**元素带着 canary 都会被下面的属性/value 扫描抓到。
  const masked = filledSecretInput?.isConnected ? filledSecretInput : null
  const maskedValue = masked?.value
  if (masked) masked.value = ""
  try {
    document.querySelectorAll("*").forEach((element) => {
      Array.from(element.attributes).forEach((attribute) =>
        expect(attribute.value).not.toContain(canary),
      )
      const value = Reflect.get(element, "value")
      if (typeof value === "string") expect(value).not.toContain(canary)
    })
    expect(document.body.innerHTML).not.toContain(canary)
    consoleOutput.forEach((value) =>
      expect(ownScalarValues(value).join("\n")).not.toContain(canary),
    )
    Reflect.ownKeys(globalThis).forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
      expect(
        descriptor && "value" in descriptor
          ? [String(key), ...ownScalarValues(descriptor.value)].join("\n")
          : String(key),
      ).not.toContain(canary)
    })
  } finally {
    if (masked && maskedValue !== undefined) masked.value = maskedValue
  }
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
      "REQ128_RENDERER_PAYLOAD_CANARY",
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

  })

  test("detail install button drives preview and confirmation through real package admission, then adopts the new view", async () => {
    const harness = await mountHarness()
    click(packageCard("package:renderer-ready"))
    await waitFor(() =>
      expect(document.querySelector("[data-package-detail='package:renderer-ready']")).toBeInstanceOf(HTMLElement),
    )
    const detail = document.querySelector<HTMLElement>("[data-package-detail='package:renderer-ready']")!
    expect(detail.querySelector(".alpha-ext-dhead-meta span")?.textContent).toContain("1.0.0")

    click(detail.querySelector(".alpha-ext-dsub button"))
    await waitForPackageAuthorization("package:renderer-ready")
    expect(packageAuthorizationDialog().querySelector(".alpha-ext-install-nm")?.textContent).toBe("generic-remote")
    expect(packageAuthorizationDialog().querySelector(".alpha-ext-install-k")?.textContent).toBeTruthy()
    expectDialogContract(packageAuthorizationDialog(), { capabilities: [] })
    confirmPackageAuthorization()

    await waitFor(() => expect(harness.installResults).toHaveLength(2))
    expect(harness.installResults.at(-1)).toMatchObject({ ok: true })
    await waitFor(() =>
      expect(detail.querySelector(".alpha-ext-dhead-meta span")?.textContent).toContain("1.0.0-installed"),
    )
    expect(harness.installIntents).toHaveLength(2)
    const first = harness.installIntents[0] as Record<string, unknown>
    const second = harness.installIntents[1] as Record<string, unknown>
    expect(Object.keys(first).sort()).toEqual(["attemptId", "catalogId", "scope"])
    expect(first).not.toHaveProperty("grants")
    expect(first).not.toHaveProperty("authorization")
    expect(second.attemptId).toBe(first.attemptId)
    expect(Object.keys(second).sort()).toEqual(["attemptId", "authorization", "catalogId", "scope"])
    expect(JSON.stringify(harness.installResults)).not.toContain(secretCanary)
  })

  test("card resolve-prerequisite button collects prerequisiteId secret, writes it 0600, and refreshes the card", async () => {
    const consoleCapture = captureConsole()
    try {
      const harness = await mountHarness()
      const card = packageCard("package:renderer-prerequisite")
      expect(card.querySelector("[data-prerequisite]")?.getAttribute("data-prerequisite")).toBe("required-action")
      click(card.querySelector("button"))
      await waitForPackageAuthorization("package:renderer-prerequisite")
      expectDialogContract(packageAuthorizationDialog(), {
        capabilities: ["alpha.secret-prerequisite.v1"],
        prerequisite: "A_KEY",
      })
      fillPackageSecret(secretCanary)
      expectNoCanaryAnywhere(secretCanary, consoleCapture.output)
      confirmPackageAuthorization()

      await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true }))
      const secretFile = join(harness.userData, "alpha-mcp-secrets", "generic-remote", "v-0badcafe", "A_KEY")
      expect(readFileSync(secretFile, "utf8")).toBe(secretCanary)
      expect(statSync(secretFile).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(harness.userData, "alpha-mcp-secrets", "generic-remote"))).toEqual(["v-0badcafe"])
      expect(readFileSync(join(harness.globalRoot, "alpha.jsonc"), "utf8")).not.toContain(secretCanary)
      expect(JSON.stringify(harness.installResults)).not.toContain(secretCanary)
      expectNoCanaryAnywhere(secretCanary, consoleCapture.output)
      await waitFor(() =>
        expect((harness.detailResults.at(-1) as CatalogPackageViewV1).prerequisites.status).toBe("ready"),
      )
      await waitFor(() =>
        expect({
          prerequisite: packageCard("package:renderer-prerequisite").querySelector("[data-prerequisite]")?.getAttribute("data-prerequisite"),
          text: packageCard("package:renderer-prerequisite").querySelector("[data-prerequisite]")?.textContent,
        }).toEqual({ prerequisite: "ready", text: zh["alpha.ext.packagePrerequisiteReady"] }),
      )

      const first = harness.installIntents[0] as Record<string, unknown>
      const second = harness.installIntents[1] as {
        attemptId: unknown
        grants: { secrets: Record<string, string> }
        authorization: { confirmed: Record<string, string[]> }
      }
      expect(Object.keys(first).sort()).toEqual(["attemptId", "catalogId", "scope"])
      expect(first).not.toHaveProperty("grants")
      expect(second.attemptId).toBe(first.attemptId)
      expect(Object.keys(second.grants.secrets)).toEqual(["mcp:generic-remote#A_KEY"])
      expect(Object.keys(second.authorization.confirmed)).toEqual(["mcp--generic-remote"])
    } finally {
      consoleCapture.restore()
    }
  })

  test("preauthorized capability still submits every preview diff key", async () => {
    const harness = await mountHarness({ preauthorized: true })
    click(packageCard("package:renderer-prerequisite").querySelector("button"))
    await waitFor(() => expect(harness.installResults).toHaveLength(1))
    expect(harness.installResults[0]).toMatchObject({
      ok: false,
      stage: "authorize",
      authorization: [{ key: "mcp--generic-remote", requiresConfirmation: false }],
    })
    fillPackageSecret(secretCanary)
    confirmPackageAuthorization()
    await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true }))
    const submitted = harness.installIntents[1] as {
      authorization: { confirmed: Record<string, string[]> }
    }
    expect(submitted.authorization.confirmed).toEqual({
      "mcp--generic-remote": ["alpha.secret-prerequisite.v1"],
    })
  })

  test("cancel clears transient secrets and retry issues a different attemptId without writing", async () => {
    const harness = await mountHarness()
    click(packageCard("package:renderer-prerequisite").querySelector("button"))
    await waitForPackageAuthorization("package:renderer-prerequisite")
    fillPackageSecret(secretCanary)
    cancelPackageAuthorization()
    await waitFor(() => expect(document.querySelector("[data-package-authorization]")).toBeNull())
    expect(existsSync(join(harness.userData, "alpha-mcp-secrets"))).toBe(false)
    expect(existsSync(join(harness.globalRoot, "alpha.jsonc"))).toBe(false)
    expect(document.body.textContent).not.toContain(secretCanary)

    click(packageCard("package:renderer-prerequisite").querySelector("button"))
    await waitForPackageAuthorization("package:renderer-prerequisite")
    expect(harness.installIntents).toHaveLength(2)
    expect((harness.installIntents[1] as { attemptId: string }).attemptId).not.toBe(
      (harness.installIntents[0] as { attemptId: string }).attemptId,
    )
    expect(packageAuthorizationDialog().querySelector<HTMLInputElement>(".alpha-ext-key-input")?.value).toBe("")
    cancelPackageAuthorization()
  })

  test("consumed failed attempt shows inline error and successful retry uses a new attemptId", async () => {
    const harness = await mountHarness({ failConfirmationOnce: true })
    const card = packageCard("package:renderer-prerequisite")
    click(card.querySelector("button"))
    await waitForPackageAuthorization("package:renderer-prerequisite")
    fillPackageSecret(secretCanary)
    confirmPackageAuthorization()
    await waitFor(() => expect(harness.installResults).toHaveLength(2))
    expect(harness.installResults.at(-1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("confirmed capability set"),
    })
    await waitFor(() =>
      expect(
        document.querySelector("[data-package-card='package:renderer-prerequisite'] [role='alert']")
          ?.textContent,
      ).toContain("confirmed capability set"),
    )
    expect(existsSync(join(harness.userData, "alpha-mcp-secrets"))).toBe(false)
    const failedAttempt = (harness.installIntents[0] as { attemptId: string }).attemptId

    await waitFor(() =>
      expect(
        packageCard("package:renderer-prerequisite").querySelector<HTMLButtonElement>("button")
          ?.disabled,
      ).toBe(false),
    )
    click(packageCard("package:renderer-prerequisite").querySelector("button"))
    await waitForPackageAuthorization("package:renderer-prerequisite")
    expect(harness.installIntents).toHaveLength(3)
    const retryAttempt = (harness.installIntents[2] as { attemptId: string }).attemptId
    expect(retryAttempt).not.toBe(failedAttempt)
    fillPackageSecret(secretCanary)
    confirmPackageAuthorization()
    await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true }))
    expect((harness.installIntents[3] as { attemptId: string }).attemptId).toBe(retryAttempt)
    expect(packageCard("package:renderer-prerequisite").querySelector("[role='alert']")).toBeNull()
  })

  test("preview throw and failure render inline on detail and card without an unhandled rejection", async () => {
    const harness = await mountHarness({ failPreviewOnce: true, rejectPreviewOnce: true })
    click(packageCard("package:renderer-ready"))
    await waitFor(() =>
      expect(document.querySelector("[data-package-detail='package:renderer-ready']")).toBeInstanceOf(HTMLElement),
    )
    click(document.querySelector("[data-package-detail] .alpha-ext-dsub button"))
    await waitFor(() =>
      expect(document.querySelector("[data-package-detail] [role='alert']")?.textContent).toContain("transport failed"),
    )
    expect(document.querySelector("[data-package-authorization]")).toBeNull()
    click(document.querySelector(".alpha-ext-crumb-link"))
    await waitFor(() => expect(document.querySelector("[data-package-detail]")).toBeNull())
    click(packageCard("package:renderer-prerequisite").querySelector("button"))
    await waitFor(() =>
      expect(packageCard("package:renderer-prerequisite").querySelector("[role='alert']")?.textContent)
        .toContain("preview unavailable"),
    )
    expect(document.querySelector("[data-package-authorization]")).toBeNull()
    expect(harness.installIntents).toHaveLength(2)
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
    // 本票要修的就是这两行看得见的东西:update-required 以前把裸 package id 当标题、简介为空。
    // 夹具的 presentation 与 corpus 不同 ⇒ 这两条同时杀掉「回落」「写死常量」「取错包」三种形状。
    {
      const detail = document.querySelector("[data-package-detail]")!
      expect(detail.querySelector("h2")?.textContent).toBe("Renderer Update Package")
      expect(detail.querySelector(".alpha-ext-dabout")?.textContent).toBe(
        "Only this fixture carries this description.",
      )
    }
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
