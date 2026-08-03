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
import { readPackageGraphs, readPackageLedgerStateV1 } from "../src/main/ext-receipt-v2"
import { uninstallPackageV1 } from "../src/main/ext-package-uninstall"
import {
  evaluateRemoteCatalogPackages,
  PACKAGE_DETAIL_IPC_CHANNEL,
  registerPackageCatalogReadIpcHandlers,
  type RemoteCatalogResult,
} from "../src/main/remote-catalog"
import { dict as zh } from "../src/renderer/i18n/zh"
import {
  EXPECTED_SKIP_REASON,
  LEAF_MCP_ID,
  LEAF_SKILL_ID,
  LEAF_UNSUPPORTED_ID,
  MIXED_BUNDLE_PACKAGE_ID,
  mixedBundleFixture,
  ROOT_AGENT_ID,
} from "./package-mixed-bundle.fixture"

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

/** `#784` G20:详情页的「移除此扩展包」**必须经过数据层**(`ext.uninstallPackage`),
 *  因为引擎重载接在那一层。它若绕回 `extIpc.uninstallPackage` 直连,包照样被删掉、
 *  下面所有既有断言照样绿 —— 只有这个计数器会停在 0。 */
const dataLayerPackageUninstalls: string[] = []
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
  uninstallPackage: async (packageId: string) => {
    dataLayerPackageUninstalls.push(packageId)
    // **照生产那条链走**:`use-extensions.uninstallPackage` 调的是 `extIpc`(`#765` 的呈现咽喉),
    // 不是 `window.api.ext`。这里若图省事直连桥,「整包卸载的 warning 到得了用户面」那条闸
    // 会因为**替身**绕过咽喉而变红 —— 那是夹具在替被测代码改文法,不是缺陷。
    return extIpcRef!.uninstallPackage(packageId)
  },
}
/** `extIpc` 会牵出 `Toast` → solid,只能在 registrator 之后动态 import;上面的替身按调用时求值。 */
let extIpcRef: { uninstallPackage: (packageId: string) => Promise<never> } | undefined

mock.module("../src/renderer/extensions/use-extensions", () => ({
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
mock.module("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/" }),
}))
mock.module("../src/renderer/alpha-ui/Banner", () => ({
  Banner: () => null,
}))

const { createComponent } = solid
const { render } = solidWeb
const { ExtensionHub } = await import("../src/renderer/extensions/extension-hub")
// 必须**动态** import:静态 import 会在 registrator 之前牵出 solid-js,整个文件拿到 server 构建
// (指纹 = 报错与改动无关且全文件一起挂)。这条纪律写在 CLAUDE.md 的《本机验证陷阱》里。
const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
extIpcRef = (await import("../src/renderer/extensions/ext-ipc")).extIpc as unknown as typeof extIpcRef
const { setHubSection } = await import("../src/renderer/extensions/ext-hub-state")

const artifact = resolve(import.meta.dir, "../../alpha-contracts-consumer/vendor/alpha-web-extension-package")
const disposals: Array<() => void> = []
const secretCanary = "REQ128_RENDERER_SECRET_CANARY_64f91d"

const canonicalBytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

/**
 * 宿主自持的 v2 信封,沿用 producer 语料的身份与呈现。vendored producer 产物本身没有 `root`,
 * 在 v2 合同下应当被拒 —— 那道过渡闸在 package-installability{,.wiring}.test.ts,不在这里重述。
 */
const producerCorpus = async () => ({
  envelope: {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: "package:generic-remote-mcp", version: "1.0.0" },
    presentation: {
      displayName: "Generic Remote MCP",
      description: "Generic Phase 1 compiler corpus input.",
    },
    root: "mcp:generic-remote",
    components: [
      {
        id: "mcp:generic-remote",
        required: true,
        dependencies: [],
        profileId: "mcp-remote",
        profileVersion: 1,
        capabilities: ["alpha.secret-prerequisite.v1"],
        payloadRef: {
          sha256: "0".repeat(64),
          bytes: 1,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.generic-remote/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: ["alpha.secret-prerequisite.v1"],
  } as unknown as AlphaPackageEnvelopeV1,
  payload: {
    schema: "alpha.host-extension-package.payload.mcp-remote.v1",
    behavior: {
      url: "https://mcp.example.com/",
      headersTemplate: { Authorization: "Bearer {A_KEY}", "X-Remote-Token": "{B_TOKEN}" },
      requiredSecrets: ["A_KEY", "B_TOKEN"],
      auth: "none",
    },
  } as unknown as PackageProfilePayloadV1,
})

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

  // `#697` 第 5 跳:canonical mixed Bundle 走**同一条**生产 renderer 路径。它带一个已策展但
  // 宿主不支持的 optional leaf,所以详情页必须逐组件出行,并对那一条给出具名原因。
  const bundle = mixedBundleFixture()

  const readyBytes = bindPayload(ready.envelope, ready.payload)
  const prerequisiteBytes = bindPayload(prerequisite.envelope, prerequisite.payload)
  const payloads = new Map<string, Uint8Array>([
    [ready.envelope.prelude.packageId, readyBytes],
    [prerequisite.envelope.prelude.packageId, prerequisiteBytes],
    [payloadBlocked.envelope.prelude.packageId, new TextEncoder().encode("{}\n")],
  ])
  const payloadsByDigest = new Map<string, Uint8Array>([
    [ready.envelope.components[0].payloadRef.sha256, readyBytes],
    [prerequisite.envelope.components[0].payloadRef.sha256, prerequisiteBytes],
  ])
  for (const [digest, bytes] of bundle.payloadByDigest) payloadsByDigest.set(digest, bytes)
  const envelopes = [
    ready.envelope,
    prerequisite.envelope,
    update.envelope,
    blocked.envelope,
    payloadBlocked.envelope,
    // 违规/异常项放**最后**:只看第一个元素的实现要能被抓住。
    bundle.envelope,
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
    if (packageId === MIXED_BUNDLE_PACKAGE_ID)
      return evaluatePackageForHost(envelope, {
        fetchPayload: async (ref) => bundle.payloadByDigest.get(ref.sha256) ?? new Uint8Array(),
      })
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
    fetchAsset: async (ref: { sha256: string }) => bundle.assetByDigest.get(ref.sha256) ?? new Uint8Array(),
  }
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

let injectInstallWarning: string | null = null
let injectUninstallWarning: string | null = null

async function mountHarness(options?: {
  /** `#698` R3:给真实 admission 成功响应挂一条具名 warning,验证它到达用户面。 */
  injectInstallWarning?: string
  /** `#765`:同样的把戏挂在**另一条** IPC 上(整包卸载)。这条路径在生产代码里
   *  **没有任何一行 warning 呈现** —— 它绿,只可能是因为咽喉在 IPC 包装层干了活。 */
  injectUninstallWarning?: string
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
    fetchAsset: fixture.fetchAsset,
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

  injectInstallWarning = options?.injectInstallWarning ?? null
  injectUninstallWarning = options?.injectUninstallWarning ?? null
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
          // `#698` R3:把一条具名 warning 挂在**真实** admission 成功响应上,验证它一路到达用户面。
          // 后端此刻已经诚实(离场组件停用了、残留没删掉会带 warning),但 hub 曾把它整个丢掉 ——
          // 「诚实只诚实到 IPC 边界」对用户不成立。
          const withWarning =
            injectInstallWarning && typeof result === "object" && result !== null && "ok" in result && result.ok === true
              ? { ...result, warning: injectInstallWarning }
              : result
          installResults.push(withWarning)
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
          return withWarning
        },
        // `#698`:详情页的「移除此扩展包」由这两条读/写决定是否出现、按下去做什么。两条都接
        // **生产实现**(不是常量桩):否则「装完之后按钮会出现」就成了一句没人验证的话。
        packageInstalled: async (catalogId: string) => {
          const state = readPackageLedgerStateV1(globalRoot)
          if (!state.ok) return { ok: false as const, reason: state.reason }
          const graph = state.packageGraphs.find((candidate) => candidate.packageId === catalogId)
          if (!graph) return { installed: false as const }
          return {
            installed: true as const,
            packageId: graph.packageId,
            installedGraphDigest: graph.installedGraphDigest,
            components: [graph.root, ...graph.children].map((node) => ({
              componentId: node.componentId,
              kind: node.kind as string,
              name: node.name,
              required: node.required,
            })),
          }
        },
        uninstallPackage: async (packageId: string) => {
          const result = await uninstallPackageV1(packageId, {
            globalRoot: () => globalRoot,
            installers: {
              removeFsInstall: () => ({ ok: true as const, files: [] }),
              removeMcpConfig: () => ({ ok: true as const }),
              removeMcpSecretsStrict: () => ({ ok: true as const }),
              releaseAlphaConnectionBindings: () => ({ ok: true as const }),
              removeInstallGrants: () => ({ ok: true as const, removed: [] }),
              removePluginPath: () => ({ ok: true as const }),
            },
          })
          // `#765`:真实成功响应 + 一条具名 warning(生产里就是「连接绑定没释放干净」那种)。
          return injectUninstallWarning && result.ok
            ? { ...result, warning: injectUninstallWarning }
            : result
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
  // 真实的 toast 视口 —— `flash()` 走 pushToast,不挂视口就什么都渲染不出来。
  // 断言必须落在**用户真能看到的 DOM** 上,而不是「hub 调过 flash」这种内部事实。
  disposals.push(render(() => createComponent(ToastViewport, {}), document.body.appendChild(document.createElement("div"))))
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
    ).toBe(6),
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

/** 用户真读得到的 toast 里,提到这条 canary 的有几条。判「恰好一条」用它,不判「有没有」。 */
function toastsContaining(canary: string): number {
  return Array.from(document.querySelectorAll(".a-toast"), (node) => node.textContent ?? "").filter((text) =>
    text.includes(canary),
  ).length
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
  expect(input!.placeholder).toBe(zh["alpha.ext.packageKeyPlaceholder"])
  expect(dialog.querySelector(".alpha-ext-confirm-keys .alpha-ext-confirm-line")?.textContent).toBe(
    zh["alpha.ext.packageConfirmEnv"],
  )
  expect(dialog.querySelector(".alpha-ext-confirm-keys [role='status']")?.textContent).toBe(
    zh["alpha.ext.packageKeysRequired"],
  )
  expect(button!.disabled).toBe(true)
  input!.value = "   "
  input!.dispatchEvent(new Event("input", { bubbles: true }))
  expect(dialog.querySelector(".alpha-ext-confirm-keys [role='status']")?.textContent).toBe(
    zh["alpha.ext.packageKeysRequired"],
  )
  expect(button!.disabled).toBe(true)
  input!.value = " dialog-contract-secret "
  input!.dispatchEvent(new Event("input", { bubbles: true }))
  expect(dialog.querySelector(".alpha-ext-confirm-keys [role='status']")).toBeNull()
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
    "components",
    "prerequisites",
    "presentation",
    "verdict",
  ])
  for (const component of view.components)
    expect(Object.keys(component).sort()).toEqual([
      "componentId",
      "included",
      "required",
      "role",
      "skipReasonCode",
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
      {
        catalogId: MIXED_BUNDLE_PACKAGE_ID,
        verdict: "compatible",
        prerequisite: "required-action",
        action: zh["alpha.ext.packageActionResolvePrerequisite"],
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
      expect(document.querySelectorAll("[data-package-card]").length).toBe(6),
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

  /**
   * `#697` 第 5 跳 + 第二个 preview 面。`#749` 让安全视图带上了逐组件的 `components[]`
   * (含 `skipReasonCode`),但在此之前 renderer **一处都没渲染**:`rg skipReasonCode
   * packages/ui-mac/src/renderer` 零命中,三个 skip token 在 en/zh 里没有任何文案。于是
   * 「让用户在每一步被告知同一件事」在任何一步都没兑现。
   *
   * 这条用例走的是生产 ExtensionHub → ExtensionDetail → 授权确认屏,断言的是**用户看得到的
   * 那句话**:不会安装的组件出现在详情页与确认屏,并带着同一个具名原因。
   */
  test("the detail page and the confirm screen both list every component and name why one is skipped", async () => {
    const harness = await mountHarness()
    click(packageCard(MIXED_BUNDLE_PACKAGE_ID))
    await waitFor(() =>
      expect(document.querySelector(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeInstanceOf(HTMLElement),
    )
    const detail = document.querySelector<HTMLElement>(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)!

    // ① 逐组件一行,root 与三个 leaf 全在,顺序即签名顺序。
    const rows = Array.from(detail.querySelectorAll<HTMLElement>("[data-package-component]"))
    expect(rows.map((row) => row.getAttribute("data-package-component"))).toEqual([
      ROOT_AGENT_ID,
      LEAF_SKILL_ID,
      LEAF_MCP_ID,
      LEAF_UNSUPPORTED_ID,
    ])
    expect(rows.map((row) => row.getAttribute("data-included"))).toEqual(["true", "true", "true", "false"])

    // ② 「会装 / 不会装」是**用户能读到的中文**,不是一个 data 属性(属性可以在没有任何文案的
    //    情况下写对 —— 那正是 `#749` 之后的现状)。
    const stateText = (row: HTMLElement) =>
      row.querySelector(".alpha-ext-package-component-state")?.textContent
    expect(rows.map(stateText)).toEqual([
      zh["alpha.ext.packageComponentIncluded"],
      zh["alpha.ext.packageComponentIncluded"],
      zh["alpha.ext.packageComponentIncluded"],
      zh["alpha.ext.packageComponentSkipped"],
    ])
    expect(rows.map((row) => row.querySelector(".alpha-ext-package-component-req")?.textContent)).toEqual([
      zh["alpha.ext.packageRequired"],
      zh["alpha.ext.packageRequired"],
      zh["alpha.ext.packageOptional"],
      zh["alpha.ext.packageOptional"],
    ])

    // ③ 被跳过的那一行有**具名原因**,且原因文案非空、来自 decoder 的 token。
    const why = rows[3]!.querySelector<HTMLElement>(".alpha-ext-package-component-why")
    expect(why).toBeInstanceOf(HTMLElement)
    expect(why!.getAttribute("data-skip-reason")).toBe(EXPECTED_SKIP_REASON)
    expect(why!.textContent).toBe(zh["alpha.ext.packageSkipCapabilityUnsupported"])
    expect(why!.textContent!.trim()).not.toBe("")
    // 会安装的三行不得出现任何原因段(「所有行都显示原因」是另一种假绿)。
    expect(rows.slice(0, 3).map((row) => row.querySelector(".alpha-ext-package-component-why"))).toEqual([
      null,
      null,
      null,
    ])

    // ④ 授权确认屏是第二个 preview 面:会装的三条 + 不会装的一条(带同一句原因)。
    click(detail.querySelector(".alpha-ext-dsub button"))
    await waitForPackageAuthorization(MIXED_BUNDLE_PACKAGE_ID)
    const dialog = packageAuthorizationDialog()
    const included = Array.from(dialog.querySelectorAll<HTMLElement>("[data-plan-component][data-included='true']"))
    expect(included.map((row) => row.getAttribute("data-plan-component"))).toEqual([
      ROOT_AGENT_ID,
      LEAF_MCP_ID,
      LEAF_SKILL_ID,
    ])
    const skippedRows = Array.from(dialog.querySelectorAll<HTMLElement>("[data-plan-component][data-included='false']"))
    expect(skippedRows.map((row) => row.getAttribute("data-plan-component"))).toEqual([LEAF_UNSUPPORTED_ID])
    expect(skippedRows[0]!.getAttribute("data-skip-reason")).toBe(EXPECTED_SKIP_REASON)
    expect(skippedRows[0]!.querySelector(".alpha-ext-install-k")?.textContent).toBe(
      zh["alpha.ext.packageSkipCapabilityUnsupported"],
    )
    // 详情页与确认屏对同一个组件给出的是**同一句话**。
    expect(skippedRows[0]!.querySelector(".alpha-ext-install-k")?.textContent).toBe(why!.textContent)

    cancelPackageAuthorization()
    expect(JSON.stringify(harness.installResults)).not.toContain(secretCanary)
  })

  /**
   * `#698` 的**用户可达路径闭合**。`#706` 之后,属于 Bundle 的单个部件被单独移除会被响亮拒绝
   * (「它还属于这个包」)—— 而在这颗按钮之前,那句拒绝指向的地方并不存在:用户装完一个扩展包
   * 就再也删不掉它。这条从「装上」一路走到「移除」,每一跳都是生产件:真 ExtensionHub 卡片 →
   * 真 ExtensionDetail → 真 admission → 真事务 → 真 V3 账本 → 真 `uninstallPackageV1`。
   */
  /**
   * `#698` R3 Major:后端诚实到 IPC 边界还不够 —— 用户得**真的看见**。
   *
   * 这条走真实 ExtensionHub + 真实 ToastViewport:admission 的成功响应带一条具名 warning
   * (update 后「离场组件已停用、但残留文件没删掉」正是这条),断言它出现在用户能读到的 DOM 里。
   * 把 hub 里那行呈现删掉,本条立刻变红 —— 这就是它与「hub 调过 flash」之类内部断言的区别。
   */
  test("a named warning on a successful install reaches the user surface, not just the IPC boundary", async () => {
    const canary = "R3_NAMED_WARNING_ba17c2"
    const harness = await mountHarness({ injectInstallWarning: canary })
    click(packageCard(MIXED_BUNDLE_PACKAGE_ID))
    await waitFor(() =>
      expect(document.querySelector(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeInstanceOf(HTMLElement),
    )
    const detail = document.querySelector<HTMLElement>(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)!
    click(detail.querySelector(".alpha-ext-dsub button"))
    await waitForPackageAuthorization(MIXED_BUNDLE_PACKAGE_ID)
    fillPackageSecret(secretCanary)
    confirmPackageAuthorization()
    await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true, warning: canary }))

    // 用户面:toast 视口里真的出现了那条具名 warning。
    await waitFor(() => expect(toastsContaining(canary)).toBe(1))
    // `#765`:**恰好一条**。呈现搬进 IPC 包装层之后,调用点再自己 flash 一次就会出现两条
    // 一模一样的提示 —— 那是本次重构最容易留下的尾巴,所以这里判等而不是判「有」。
    await flush()
    expect(toastsContaining(canary), "the same warning was presented more than once").toBe(1)
  })

  /**
   * `#765`:同一条保证,换一条**没有任何呈现代码**的路径。
   *
   * 整包卸载走 extension-detail 的 `removePackage` → `uninstallPackage` IPC。生产代码在这条路径上
   * 一行 warning 呈现都没有(`#698` 当时写的那行已经删掉)。它仍然到得了 `.a-toast`,只可能是
   * 因为咽喉在 IPC 包装层做了事 —— 这正是「新调用点默认被覆盖」的可执行证据,而不是一句声明。
   */
  test("a named warning on package uninstall reaches the user surface with no presentation code on that path", async () => {
    const canary = "CHOKEPOINT_UNINSTALL_WARNING_7f31ac"
    const harness = await mountHarness({ injectUninstallWarning: canary })
    click(packageCard(MIXED_BUNDLE_PACKAGE_ID))
    await waitFor(() =>
      expect(document.querySelector(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeInstanceOf(HTMLElement),
    )
    const detail = () => document.querySelector<HTMLElement>(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)!
    click(detail().querySelector(".alpha-ext-dsub button"))
    await waitForPackageAuthorization(MIXED_BUNDLE_PACKAGE_ID)
    fillPackageSecret(secretCanary)
    confirmPackageAuthorization()
    await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true }))
    await waitFor(() =>
      expect(detail().querySelector(`[data-package-uninstall='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeInstanceOf(HTMLElement),
    )
    // 装的时候没有注入 warning —— 卸载前的 toast 里不该已经有这条 canary(否则下面判的是别人)。
    expect(toastsContaining(canary)).toBe(0)

    click(detail().querySelector(`[data-package-uninstall='${MIXED_BUNDLE_PACKAGE_ID}']`))
    await waitFor(() => expect(readPackageGraphs(harness.globalRoot)).toEqual([]))
    await waitFor(() => expect(toastsContaining(canary)).toBe(1))
    await flush()
    expect(toastsContaining(canary), "the same warning was presented more than once").toBe(1)
  })

  test("installing a Bundle reveals the remove-package action, and pressing it removes it through production main", async () => {
    const harness = await mountHarness()
    click(packageCard(MIXED_BUNDLE_PACKAGE_ID))
    await waitFor(() =>
      expect(document.querySelector(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeInstanceOf(HTMLElement),
    )
    const detail = () => document.querySelector<HTMLElement>(`[data-package-detail='${MIXED_BUNDLE_PACKAGE_ID}']`)!
    // 装之前:没有「移除此扩展包」这颗按钮(它不是常显的)。
    expect(detail().querySelector(`[data-package-uninstall='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeNull()

    click(detail().querySelector(".alpha-ext-dsub button"))
    await waitForPackageAuthorization(MIXED_BUNDLE_PACKAGE_ID)
    fillPackageSecret(secretCanary)
    confirmPackageAuthorization()
    await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true }))
    // 账本里真的有这张图 —— 按钮出现的依据是 main 的账本,不是 renderer 记得自己点过安装。
    await waitFor(() =>
      expect(readPackageLedgerStateV1(harness.globalRoot)).toMatchObject({ ok: true, packageGraphs: [{ packageId: MIXED_BUNDLE_PACKAGE_ID }] }),
    )

    // 留在同一张详情页上:装完之后按钮必须**当场**出现,不需要退出再进来。
    await waitFor(() =>
      expect(detail().querySelector(`[data-package-uninstall='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeInstanceOf(HTMLElement),
    )
    const remove = detail().querySelector<HTMLElement>(`[data-package-uninstall='${MIXED_BUNDLE_PACKAGE_ID}']`)!
    expect(remove.textContent?.trim()).toBe(zh["alpha.ext.packageActionUninstall"])

    const uninstallsBefore = dataLayerPackageUninstalls.length
    click(remove)
    // 移除之后:图没了(main 说的),按钮跟着消失(renderer 重新问了 main,而不是自己乐观翻转)。
    await waitFor(() => expect(readPackageGraphs(harness.globalRoot)).toEqual([]))
    await waitFor(() =>
      expect(detail().querySelector(`[data-package-uninstall='${MIXED_BUNDLE_PACKAGE_ID}']`)).toBeNull(),
    )
    // 没有任何 child 被保留(这个包没和别人共享),所以不显示保留清单。
    expect(detail().querySelector(".alpha-ext-package-retained")).toBeNull()

    // `#784` G20:这一次移除**经过了数据层**,而不是从详情页直连 IPC。
    // 这条断言是必须的,因为上面每一条都能在「直连 IPC」的实现下照样绿 ——
    // 包确实被删了,只是引擎从此不再被要求重扫,技能一直能用到下次重启。
    expect(dataLayerPackageUninstalls.slice(uninstallsBefore)).toEqual([MIXED_BUNDLE_PACKAGE_ID])
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
      const submittedSecret = ` ${secretCanary} `
      fillPackageSecret(submittedSecret)
      expectNoCanaryAnywhere(secretCanary, consoleCapture.output)
      confirmPackageAuthorization()

      await waitFor(() => expect(harness.installResults.at(-1)).toMatchObject({ ok: true }))
      const secretFile = join(harness.userData, "alpha-mcp-secrets", "generic-remote", "v-0badcafe", "A_KEY")
      expect(readFileSync(secretFile, "utf8")).toBe(submittedSecret)
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
      expect(second.grants.secrets["mcp:generic-remote#A_KEY"]).toBe(submittedSecret)
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

  test("legacy MCP keeps optional-key copy and allows confirmation with an empty value", async () => {
    await mountHarness()
    setHubSection("connectors")
    await waitFor(() =>
      expect(document.querySelector(".alpha-ext-card-name b[title='github']")).toBeInstanceOf(
        HTMLElement,
      ),
    )
    const card = document.querySelector(".alpha-ext-card-name b[title='github']")!.closest(".alpha-ext-card")!
    click(card.querySelector(".alpha-ext-add"))
    const keys = document.querySelector<HTMLElement>(".alpha-ext-confirm-keys")
    expect(keys).toBeInstanceOf(HTMLElement)
    const dialog = keys!.closest<HTMLElement>("[role='dialog']")
    expect(dialog).toBeInstanceOf(HTMLElement)
    expect(dialog!.querySelector("[data-package-authorization]")).toBeNull()
    expect(zh["alpha.ext.confirmEnv"]).toBe("需要密钥(留空则装好后再配)")
    expect(zh["alpha.ext.keyPlaceholder"]).toBe("粘贴密钥…(可留空)")
    expect(keys!.querySelector(".alpha-ext-confirm-line")?.textContent).toBe(zh["alpha.ext.confirmEnv"])
    const input = keys!.querySelector<HTMLInputElement>(".alpha-ext-key-input")
    expect(input).toBeInstanceOf(HTMLInputElement)
    expect(input!.placeholder).toBe(zh["alpha.ext.keyPlaceholder"])
    expect(input!.value).toBe("")
    expect(dialog!.querySelector<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child")?.disabled).toBe(false)
  })
})
