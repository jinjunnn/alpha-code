// `#1594`(REQ-236 T18/T19):定制中心收成连接器 / 技能 / 助手三页 —— 每条 AC 一个具名判据。
//
// 独立进程运行:真实 Solid DOM 构建 + **真实** `useExtensions` + **真实** `ExtensionHub`(批准稿
// `docs/design/2026-10-30-req236-ux-config-pages/frame.html#hub`)。替身只有两处边界:SDK client
// (对面是引擎的 HTTP 服务)与 `window.api.ext`(对面是 main 进程);两者之内每一跳都是生产代码。
// 夹具形状取自生产类型:账本收据 = `preload/types.ts` `InstallReceipt`;三档状态 = `main/alpha-sidecar-messages.ts`
// `HubViewRow`;治理视图 = `main/ext-inventory.ts` `InventoryRow`;扩展包安全视图按 `main/package-installability.ts`
// `compatibleView` 的形状、以随包目录里 `package:github-official` 的真实呈现段与前置项 id 规则
// (`shared/package-secret-prerequisite.ts`:`<组件 id>#<变量名>`,label = 变量名)拼出。
//
// 「删掉该行为必须变红」的反向对照写在每条用例里:断言落在用户看得到 / 点得到的 DOM 上,
// 而不是「hub 调过某个函数」这类内部事实。

import { afterAll, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import bundledCatalog from "../src/renderer/extensions/alpha-catalog.json"
import { DEFAULT_BUILTIN_POLICY } from "../src/main/alpha-builtin-policy"
import { packageActionForReason } from "../src/main/package-installability"
import type { CatalogPackageViewV1 } from "../src/shared/catalog-package-view"
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
// `solid-js/store` 少这一行**不报错**,而是静默失去反应性(判据在 CLAUDE.md《本机验证陷阱》)。
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "hub-three-pages-solid-components",
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

// ── 边界替身(用例可驱动)───────────────────────────────────────────────────────────────────
type Receipt = { id: string; name: string; type: string; scope: "global"; installedAt: string; origin: string; version?: string }
let receipts: Receipt[] = []
let inventoryRows: unknown[] = []
let hubRows: unknown[] = []
let factorySkillIds: string[] = []
let remoteCatalog: unknown = { source: "none" }
const calls = {
  importSkillFolder: 0,
  filePicker: [] as Array<{ title?: string }>,
  installCatalog: [] as Array<Record<string, unknown>>,
  setInstallState: [] as Array<Record<string, unknown>>,
  uninstall: [] as Array<Record<string, unknown>>,
  builtinApply: [] as unknown[],
}

const emptyStream = { [Symbol.asyncIterator]: async function* () {} }
const fakeClient = {
  mcp: {
    status: async () => ({ data: {}, error: undefined }),
    connect: async () => ({ data: {}, error: undefined }),
    disconnect: async () => ({ data: {}, error: undefined }),
    add: async () => ({ data: {}, error: undefined }),
    auth: { authenticate: async () => ({ data: { status: "connected" }, error: undefined }) },
  },
  app: {
    agents: async () => ({
      data: [
        { name: "build", mode: "primary", native: true },
        { name: "docs-writer", mode: "subagent", native: false, description: "写文档:报告、规范、设计说明。" },
      ],
      error: undefined,
    }),
  },
  global: {
    event: async () => ({ stream: emptyStream }),
    dispose: async () => ({ data: {}, error: undefined }),
  },
}
mock.module("@opencode-ai/sdk/v2/client", () => ({ createOpencodeClient: () => fakeClient }))
mock.module("../src/renderer/auth-recovery", () => ({
  subscribeAuthState: (listener: (state: { status: string; mode: string; platformStatus: string }) => void) => {
    listener({ status: "logged-out", mode: "byok", platformStatus: "ready" })
    return () => {}
  },
}))
mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "/" }) }))
mock.module("../src/renderer/alpha-ui/Banner", () => ({ Banner: () => null }))

Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    openFilePicker: async (options: { title?: string }) => {
      calls.filePicker.push(options)
      return null
    },
    updater: { check: async () => {} },
    auth: { start: async () => {}, setMode: async () => {} },
    ext: {
      listInstalls: async () => ({ global: receipts, project: [], warnings: [] }),
      sessionGrants: async () => ({ grants: [] }),
      factorySkillIds: async () => factorySkillIds,
      onSessionGrantsEnded: () => () => {},
      inventoryView: async () => ({ catalogVersion: null, catalogChannel: null, rows: inventoryRows, warnings: [] }),
      installedPackages: async () => ({ ok: true as const, packages: [] }),
      advisoryActive: async () => ({ ids: [], fresh: true }),
      migrateScan: async () => ({ enabled: false, inventory: { skills: [], mcp: [], plugins: [] } }),
      remoteCatalog: async () => remoteCatalog,
      checkRuntime: async () => ({ ok: true as const }),
      installCatalog: async (intent: Record<string, unknown>) => {
        calls.installCatalog.push(intent)
        return { ok: false as const, reason: "fixture: install not exercised here" }
      },
      setInstallState: async (intent: Record<string, unknown>) => {
        calls.setInstallState.push(intent)
        return { ok: true as const }
      },
      uninstallV2: async (intent: Record<string, unknown>) => {
        calls.uninstall.push(intent)
        return { ok: true as const }
      },
      importSkillFolder: async () => {
        calls.importSkillFolder++
        return { ok: false as const, canceled: true, reason: "canceled" }
      },
      hubView: async () => ({ directory: "/", rows: hubRows, warnings: [] }),
      reloadRequest: async () => ({ ok: true as const, generation: 1 }),
      onHubViewChanged: () => () => {},
      builtinRead: async () => ({
        gov: structuredClone(DEFAULT_BUILTIN_POLICY),
        protection: { hard: [], alphaInjected: [], confirm: [] },
      }),
      builtinApply: async (next: unknown) => {
        calls.builtinApply.push(next)
        return { ok: true as const }
      },
      curationBlob: async () => undefined,
      migrateVerify: async () => ({ ok: true as const }),
    },
  },
})

const { createComponent } = solid
const { render } = solidWeb
// 必须**动态** import:静态 import 会在 registrator 之前牵出 solid-js。
const { ExtensionHub } = await import("../src/renderer/extensions/extension-hub")
const { setHubSection } = await import("../src/renderer/extensions/ext-hub-state")

const disposals: Array<() => void> = []
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function waitFor(assertion: () => void) {
  let failure: unknown
  for (let attempt = 0; attempt < 120; attempt++) {
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
const q = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)
const qa = (selector: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>(selector))
function click(element: Element | null) {
  expect(element).toBeInstanceOf(HTMLElement)
  ;(element as HTMLElement).click()
}
/** 一个界面元素**整段**就是这句话(短标签用它判,不用子串 —— 「来源」「官方」也会出现在目录描述的正文里)。 */
const leavesSaying = (text: string, root: ParentNode = document) =>
  qa("*", root)
    .filter((node) => node.children.length === 0 && (node.textContent ?? "").trim() === text)
    .map((node) => node.outerHTML)
/** 断言「不在」时只把一小段 HTML 交给 expect —— 失败时 bun 会完整打印收到的值,而一个 DOM 节点的对象图大到能把进程拖死。 */
const html = (node: Element | null) => node?.outerHTML.slice(0, 300) ?? null
async function openMenu(trigger: Element | null) {
  click(trigger)
  await waitFor(() => expect(q("[data-menu]")).toBeInstanceOf(HTMLElement))
  return qa("[data-menu] [data-menu-item]").map((item) => item.getAttribute("data-menu-item"))
}

function mount(section: "connectors" | "skills" | "agents" = "connectors") {
  setHubSection(section)
  const root = document.createElement("div")
  root.id = "root"
  root.className = "a-ui"
  document.body.append(root)
  disposals.push(
    render(
      () => createComponent(ExtensionHub, { server: () => ({ baseUrl: "http://127.0.0.1:65535" }) as never, open: () => true, onClose: () => {} }),
      root,
    ),
  )
}
function reset() {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
  receipts = []
  inventoryRows = []
  hubRows = []
  factorySkillIds = []
  calls.importSkillFolder = 0
  for (const list of [calls.filePicker, calls.installCatalog, calls.setInstallState, calls.uninstall, calls.builtinApply]) list.length = 0
}
afterAll(async () => {
  reset()
  await GlobalRegistrator.unregister()
})

const receipt = (id: string, name: string, type: string): Receipt => ({
  id,
  name,
  type,
  scope: "global",
  installedAt: "2026-10-30T00:00:00.000Z",
  origin: "catalog",
  version: (bundledCatalog as { version: string }).version,
})
const inventoryRow = (id: string, name: string, kind: string, activation: "enabled" | "disabled") => ({
  id,
  name,
  kind,
  scope: "global",
  activation,
  health: { state: "healthy", issues: [] },
})
const hubRow = (id: string, name: string, kind: string, state: string, code?: string) => ({
  id,
  scope: "global",
  name,
  kind,
  displayName: name,
  description: "",
  installed: true,
  enabled: true,
  state,
  ...(code ? { stateReason: { code } } : {}),
  authorization: "none",
})

// ═══════════════════════════════════════════════════════════════════════════════════════

test("AC1 定制中心顶层只有「连接器」「技能」「助手」三个页签,点哪页显示哪页", async () => {
  reset()
  mount()
  await waitFor(() => expect(qa(".alpha-ext-tab").length).toBe(3))
  expect(qa(".alpha-ext-tab").map((tab) => tab.textContent)).toEqual([
    zh["alpha.ext.tabConnectors"],
    zh["alpha.ext.tabSkills"],
    zh["alpha.ext.tabAgents"],
  ])
  // 原推荐 / 插件 / 套件 / 已安装 / 导入 / 云能力不再是页签。
  for (const gone of ["alpha.ext.tabFeatured", "alpha.ext.tabPlugins", "alpha.ext.tabBundles", "alpha.ext.tabInstalled", "alpha.ext.tabCreate", "alpha.ext.tabCloud"] as const)
    expect(qa(".alpha-ext-tab").map((tab) => tab.textContent)).not.toContain(zh[gone])
  for (const [key, title] of [
    ["skills", zh["alpha.ext.tabSkills"]],
    ["agents", zh["alpha.ext.tabAgents"]],
    ["connectors", zh["alpha.ext.tabConnectors"]],
  ] as const) {
    click(q(`[data-tab="${key}"]`))
    await waitFor(() => expect(q(".alpha-ext-pagehd h1")?.textContent).toBe(title))
    expect(q(`[data-tab="${key}"]`)?.hasAttribute("data-active")).toBe(true)
  }
  // 原页签的去处(批准稿「页签方案」表):套件与云能力是连接器页的两组。
  await waitFor(() => expect(q("[data-group='bundles']")).toBeInstanceOf(HTMLElement))
  expect(q("[data-group='cloud']")).toBeInstanceOf(HTMLElement)
})

test("AC2 每页只有标题、一行副标题、搜索框和「添加 ▾」;来源 / 许可证筛选、说明框、页脚说明与「尚未完成审核分级」整段都不再渲染", async () => {
  reset()
  mount()
  for (const [key, sub, placeholder] of [
    ["connectors", "alpha.ext.connectorsSub", "alpha.ext.searchConnectors"],
    ["skills", "alpha.ext.skillsSub", "alpha.ext.searchSkills"],
    ["agents", "alpha.ext.agentsSub", "alpha.ext.searchAgents"],
  ] as const) {
    click(q(`[data-tab="${key}"]`))
    await waitFor(() => expect(q(".alpha-ext-pagehd .alpha-ext-sub")?.textContent).toBe(zh[sub]))
    const head = q(".alpha-ext-pagehd")!
    expect(q<HTMLInputElement>("input[type='search']", head)?.placeholder).toBe(zh[placeholder])
    expect(q("[data-more='add']", head)?.textContent).toBe(`${zh["alpha.ext.add"]} ▾`)
    // 页上不再有筛选条、说明框;技能页「推荐 / 系统」两个分段都看一遍。
    for (const segment of key === "connectors" ? [null] : ["recommended", "system"]) {
      if (segment) click(q(`[data-segment="${segment}"]`))
      await flush()
      expect(html(q(".alpha-ext-filters, .alpha-ext-fchip, .alpha-ext-callout, .alpha-ext-group-note, .alpha-ext-hero"))).toBeNull()
      // 筛选条与「未分级」组头是短标签:判「没有哪个元素整段就是它」。
      for (const gone of ["alpha.ext.filterSource", "alpha.ext.filterLicense", "alpha.ext.filterAll", "alpha.ext.ungradedGroup"] as const)
        expect(leavesSaying(zh[gone]), `${key}/${segment ?? "-"} 还在渲染 ${gone}`).toEqual([])
      // 说明框与页脚说明是整段话:判子串。
      const text = document.body.textContent ?? ""
      for (const gone of ["alpha.ext.ungradedNote", "alpha.ext.compatNote", "alpha.builtin.note", "alpha.ext.agentsNote", "alpha.ext.heroSub", "alpha.ext.pluginNote", "alpha.ext.createViaChatBody"] as const)
        expect(text, `${key}/${segment ?? "-"} 还在渲染 ${gone}`).not.toContain(zh[gone])
    }
  }
})

test("AC3 列表行 = 图标 + 名称 + 一行描述 + 一个动作,双列排布;行上不再挂来源、版本、兼容、就绪、运行位置标签", async () => {
  reset()
  mount()
  await waitFor(() => expect(qa("[data-group] > .alpha-ext-kit").length).toBeGreaterThan(10))
  for (const key of ["connectors", "skills", "agents"] as const) {
    click(q(`[data-tab="${key}"]`))
    await waitFor(() => expect(qa(".alpha-ext-grid > .alpha-ext-kit").length).toBeGreaterThan(0))
    for (const row of qa(".alpha-ext-grid > .alpha-ext-kit")) {
      // 每一行都住在双列网格里(`.alpha-ext-grid` = 两列,窄于 620px 时一列)。
      expect(row.parentElement?.classList.contains("alpha-ext-grid")).toBe(true)
      expect(q(":scope > .alpha-ext-kit-ic", row)).toBeInstanceOf(HTMLElement)
      expect(q(":scope > .alpha-ext-kit-body > .alpha-ext-kit-ttl > b", row)?.textContent?.length).toBeGreaterThan(0)
      expect(q(":scope > .alpha-ext-kit-body > .alpha-ext-kit-desc", row)).toBeInstanceOf(HTMLElement)
      // 恰好一个动作:一颗按钮,或一个「…」。
      expect(qa(":scope > button, :scope > .alpha-ext-more", row).length, row.textContent ?? "").toBe(1)
      expect(html(q(".alpha-ext-chip, .alpha-ext-meta, .alpha-ext-type-pill, .alpha-ext-ver, .alpha-ext-package-state, .alpha-ext-verify-chip", row))).toBeNull()
    }
    for (const gone of ["alpha.ext.sourceOfficial", "alpha.ext.sourceCommunity", "alpha.ext.sourceAlpha", "alpha.ext.packageVerdictCompatible", "alpha.ext.packagePrerequisiteReady", "alpha.ext.metaCloudExec", "alpha.ext.packageSourceRemote", "alpha.ext.packageSourceBuiltin", "alpha.ext.metaRestart", "alpha.ext.factoryBuiltin"] as const)
      for (const row of qa(".alpha-ext-grid > .alpha-ext-kit:not([data-factory-skill])"))
        expect(leavesSaying(zh[gone], row), `${key} 行上还有 ${gone}`).toEqual([])
  }
})

test("AC4 「添加 ▾」里是从文件夹导入 / 从 Git 地址导入 / 自定义连接器 / 导入助手,各自打开原来那个导入窗口", async () => {
  reset()
  mount("skills")
  const items = await openMenu(q("[data-more='add']"))
  expect(items).toEqual(["folder", "git", "custom-connector", "agent"])
  expect(qa("[data-menu] [data-menu-item]").map((item) => item.textContent)).toEqual([
    zh["alpha.ext.importFolder"],
    zh["alpha.ext.importGit"],
    zh["alpha.ext.customMcp"],
    zh["alpha.ext.importAgent"],
  ])
  // 文件夹 → main 的目录选择 + 导入(与原「导入」页的文件夹卡同一个入口)。
  click(q("[data-menu-item='folder']"))
  await waitFor(() => expect(calls.importSkillFolder).toBe(1))
  expect(html(q("[data-menu]"))).toBeNull()
  // Git → 原来那个 Git 地址窗口。
  await openMenu(q("[data-more='add']"))
  click(q("[data-menu-item='git']"))
  await waitFor(() => expect(q("[role='dialog']")?.textContent).toContain(zh["alpha.ext.importGitTitle"]))
  click(qa("[role='dialog'] .a-dialog-footer .a-btn")[0]!)
  await waitFor(() => expect(html(q("[role='dialog']"))).toBeNull())
  // 自定义连接器 → 原来那个填写窗口。
  await openMenu(q("[data-more='add']"))
  click(q("[data-menu-item='custom-connector']"))
  await waitFor(() => expect(q("[role='dialog']")?.textContent).toContain(zh["alpha.ext.customMcpTitle"]))
  click(qa("[role='dialog'] .a-dialog-footer .a-btn")[0]!)
  await waitFor(() => expect(html(q("[role='dialog']"))).toBeNull())
  // 导入助手 → 选 .md 文件(随后是原来那个映射预览窗口)。
  await openMenu(q("[data-more='add']"))
  click(q("[data-menu-item='agent']"))
  await waitFor(() => expect(calls.filePicker).toEqual([{ title: zh["alpha.ext.importAgentPick"], extensions: ["md"] } as never]))
})

test("AC5 每页顶部「已安装」一组,已装行的「…」含停用 / 移除 / 设置;应用自带的技能与助手在「系统」分段,隐藏 / 停用 / 自定义仍可用", async () => {
  reset()
  receipts = [receipt("skill:safe-refactor", "safe-refactor", "skill")]
  inventoryRows = [inventoryRow("skill:safe-refactor", "safe-refactor", "skill", "enabled")]
  factorySkillIds = ["skill-creator"]
  mount("skills")
  await waitFor(() => expect(q("[data-group='installed'] [data-installed-row='skill:safe-refactor']")).toBeInstanceOf(HTMLElement))
  // 「已安装」是这一页的第一组。
  expect(q(".alpha-ext-pagehd ~ .alpha-ext-secrow .alpha-ext-overline")?.textContent).toBe(zh["alpha.ext.tabInstalled"])
  const row = q("[data-installed-row='skill:safe-refactor']")!
  expect(await openMenu(q("[data-more]", row))).toEqual(["disable", "remove", "settings"])
  expect(qa("[data-menu] [data-menu-item]").map((item) => item.textContent)).toEqual([
    zh["alpha.ext.turnOff"],
    zh["alpha.ext.remove"],
    zh["alpha.ext.rowSetup"],
  ])
  click(q("[data-menu-item='disable']"))
  await waitFor(() => expect(calls.setInstallState).toEqual([expect.objectContaining({ name: "safe-refactor", state: "disabled" })]))
  await openMenu(q("[data-more]", row))
  click(q("[data-menu-item='remove']"))
  await waitFor(() => expect(calls.uninstall).toEqual([expect.objectContaining({ type: "skill", name: "safe-refactor" })]))
  // 已装的不再在「推荐」里重复出现;出厂内置技能不在「推荐」里。
  expect(html(q("[data-entry='skill:safe-refactor']"))).toBeNull()
  expect(html(q("[data-entry='skill:skill-creator']"))).toBeNull()

  // 技能页「系统」:出厂内置技能 + 内置命令,命令的「…」是「自定义」。
  click(q("[data-segment='system']"))
  await waitFor(() => expect(q("[data-factory-skill='skill-creator']")).toBeInstanceOf(HTMLElement))
  await waitFor(() => expect(qa("[data-builtin-command]").map((n) => n.getAttribute("data-builtin-command"))).toEqual(["init", "review"]))
  expect(await openMenu(q("[data-builtin-command='init'] [data-more]"))).toEqual(["override"])
  click(q("[data-menu-item='override']"))
  await waitFor(() => expect(q(".alpha-gov-editor")).toBeInstanceOf(HTMLElement))

  // 助手页「系统」:应用自带的助手,「…」= 隐藏 / 停用 / 自定义,点下去真的写治理。
  click(q("[data-tab='agents']"))
  click(q("[data-segment='system']"))
  await waitFor(() => expect(q("[data-builtin-agent='build']")).toBeInstanceOf(HTMLElement))
  expect(await openMenu(q("[data-builtin-agent='build'] [data-more]"))).toEqual(["hide", "disable", "override"])
  click(q("[data-menu-item='hide']"))
  await waitFor(() => expect(calls.builtinApply.length).toBe(1))
  expect((calls.builtinApply[0] as { agents: { hide: string[] } }).agents.hide).toEqual(["build"])
  // 自己在对话里建的助手在助手页「已安装」组。
  click(q("[data-segment='recommended']"))
  expect(q("[data-group='installed'] [data-own-agent='docs-writer']")).toBeInstanceOf(HTMLElement)
})

test("AC6 需要令牌的扩展包:行上写缺什么(「需要 GitHub 令牌」),动作是「设置」并走原来那个填写窗口;不再出现「需要先处理」「处理前置条件」", async () => {
  reset()
  const sample = (bundledCatalog as { packages: Array<{ prelude: { packageId: string; version: string }; presentation: { displayName: string; description: string } }> }).packages.find(
    (pack) => pack.prelude.packageId === "package:github-official",
  )!
  const github: CatalogPackageViewV1 = {
    catalogId: sample.prelude.packageId,
    verdict: "compatible",
    action: packageActionForReason("package-prerequisite-required"),
    components: [{ componentId: "mcp:github-official", role: "root", required: true, included: true, skipReasonCode: null }],
    prerequisites: {
      status: "required-action",
      items: [{ prerequisiteId: "mcp:github-official#GITHUB_PERSONAL_ACCESS_TOKEN", label: "GITHUB_PERSONAL_ACCESS_TOKEN", required: true }],
    },
    presentation: { ...sample.presentation, version: sample.prelude.version },
  }
  remoteCatalog = {
    source: "remote",
    catalog: { version: (bundledCatalog as { version: string }).version, entries: (bundledCatalog as { entries: unknown[] }).entries, packages: [github] },
  }
  mount("connectors")
  await waitFor(() => expect(q("[data-package-card='package:github-official']")).toBeInstanceOf(HTMLElement))
  const row = q("[data-package-card='package:github-official']")!
  expect(q("[data-package-need]", row)?.textContent).toBe(zh["alpha.ext.needGithubToken"])
  expect(qa("button", row).map((button) => button.textContent?.trim())).toEqual([zh["alpha.ext.rowSetup"]])
  expect(row.textContent).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN")
  expect(document.body.textContent).not.toContain("需要先处理")
  expect(document.body.textContent).not.toContain("处理前置条件")
  // 「设置」= 原来的「处理前置条件」那一趟:同一条安装意图出站(随后由 main 的 authorize 臂打开填令牌的确认屏)。
  click(q("button", row))
  await waitFor(() => expect(calls.installCatalog).toEqual([expect.objectContaining({ catalogId: "package:github-official" })]))
})

test("AC7 未完成审核的扩展装上默认关闭:行上「未开启」+「开启」;待生效的行「待生效 · …」+「立即生效」", async () => {
  reset()
  receipts = [receipt("mcp:fetch", "fetch", "mcp"), receipt("skill:mcp-builder", "mcp-builder", "skill"), receipt("skill:brand-guidelines", "brand-guidelines", "skill")]
  inventoryRows = [
    inventoryRow("mcp:fetch", "fetch", "mcp", "disabled"),
    inventoryRow("skill:mcp-builder", "mcp-builder", "skill", "enabled"),
    inventoryRow("skill:brand-guidelines", "brand-guidelines", "skill", "enabled"),
  ]
  hubRows = [hubRow("skill:mcp-builder", "mcp-builder", "skill", "reload-pending", "reload-waiting"), hubRow("skill:brand-guidelines", "brand-guidelines", "skill", "available")]
  mount("connectors")
  // 默认关闭的连接器:状态一句「未开启」,动作是「开启」,点下去走原来的启用通道。
  await waitFor(() => expect(q("[data-installed-row='mcp:fetch'] .alpha-ext-kit-desc")?.textContent).toBe(zh["alpha.ext.notOn"]))
  const enable = q("[data-installed-row='mcp:fetch'] [data-enable-row]")
  expect(enable?.textContent).toBe(zh["alpha.ext.turnOn"])
  click(enable)
  await waitFor(() => expect(calls.setInstallState).toEqual([expect.objectContaining({ name: "fetch", state: "enabled" })]))
  // 待生效:说「待生效 · 对话空闲后自动生效」,动作是「立即生效」;已生效的行照常描述 +「…」。
  click(q("[data-tab='skills']"))
  await waitFor(() => expect(q("[data-installed-row='skill:mcp-builder'] [data-hub-state='reload-pending']")).toBeInstanceOf(HTMLElement))
  expect(q("[data-installed-row='skill:mcp-builder'] .alpha-ext-kit-desc")?.textContent).toBe(
    `${zh["alpha.ext.hubStatePending"]} · ${zh["alpha.ext.hubReasonWaiting"]}`,
  )
  expect(q("[data-installed-row='skill:mcp-builder'] [data-hub-reload-now]")?.textContent).toBe(zh["alpha.ext.hubReloadNow"])
  expect(html(q("[data-installed-row='skill:brand-guidelines'] [data-hub-reload-now]"))).toBeNull()
  expect(q("[data-installed-row='skill:brand-guidelines'] [data-more]")).toBeInstanceOf(HTMLElement)
})
