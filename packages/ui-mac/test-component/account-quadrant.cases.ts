// REQ-146(ac#1194)—— 账户浮层「订阅×余额」四象限 + summary-error 的组件端闸门。
//
// 判据(对应票面 AC):
// - AC1 chip 三态:已订阅 → 计划名;未订阅+有余额 → 「按量付费」;未订阅+无余额 → 「免费版」。
//   错误实现(只看订阅)在「未订阅+有余额」格当场红。
// - AC2 未订阅时原「5 小时/7 日额度」两行显示 summary.usage 的真实用量(今日/7 日用量);
//   已订阅仍显示 plan.window5h/window7d。错误实现(两态都读 plan 窗口)在未订阅格红,
//   因为该字段结构上不存在。
// - AC3 未订阅且无余额:面板不新增提示行 —— 钉死行数恰为 5、行标签集合、CTA 恰为
//   升级会员|充值。
// 期望值全部是独立字面量,不 import 被测 i18n 字典(锚点不能来自被测对象自己)。
//
// 挂载走生产组合体(OverlayCloseHarness:真 AlphaSidebar + 真 @solidjs/router),打开浮层走
// 真实点击。替身面与 overlay-close.cases.ts 同因同法:上游 ui 装饰件 / SDK 传输层 / preload
// 桥,不含被测语义。子进程运行(src/renderer/sidebar/account-quadrant.test.ts spawn):
// mock.module 会污染同进程。
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"
import type { AlphaProject, AlphaProjectsApi } from "../src/renderer/sidebar/use-projects"
import type { AccountSummary } from "../src/preload/types"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "account-quadrant-component-test",
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

mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: () => null }))
mock.module("@opencode-ai/ui/v2/project-avatar-v2", () => ({ ProjectAvatar: () => null }))
mock.module("@opencode-ai/ui/theme/context", () => ({
  useTheme: () => ({ colorScheme: () => "dark", setColorScheme: () => {} }),
}))
mock.module("../src/renderer/alpha-ui/providers", () => ({
  useCommand: () => ({ options: [], register: () => {}, trigger: () => {}, show: () => {}, hide: () => {} }),
  ServerConnection: { key: () => "sidecar", Key: { make: (value: string) => value } },
  useTabs: () => ({
    ready: Object.assign(() => true, { promise: undefined }),
    newDraft: () => new Promise<void>(() => {}),
  }),
  useServer: () => ({ key: "sidecar", isLocal: () => true, projects: { list: () => [] } }),
  useContractHealth: () => () => null,
  ContractHealthProvider: (props: { children?: unknown }) => props.children,
}))
mock.module("@opencode-ai/sdk/v2/client", () => ({ createOpencodeClient: () => sdkStub() }))

function sdkStub(): unknown {
  const fail = async () => ({ data: undefined, error: { message: "offline in test" } })
  return new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" ? undefined : new Proxy(fail, { get: () => fail })) },
  )
}

// —— 四象限夹具 ————————————————————————————————————————————————
const win5h = { usedCredits: 1234, limitCredits: 9000, resetsInMin: 87 }
const win7d = { usedCredits: 45678, limitCredits: 120000, resetsInMin: 3210 }
const series14 = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-08-${String(17 + i).padStart(2, "0")}`,
  tokens: i % 3 === 0 ? 0 : 1000 * i,
}))
const activePlan = {
  id: "pro-monthly",
  name: "Pro 月卡",
  status: "active" as const,
  window5h: win5h,
  window7d: win7d,
  renewsAt: "2026-09-15",
  daysLeft: 15,
}
const nonePlan = { id: "none", name: "None", status: "none" as const }
// 用量给非零值,让「显示的确实是 usage 而不是别的 0」可分辨。
const usage = { todayTokens: 12345, weekTokens: 456789, tasksThisMonth: 14 }
const zeroUsage = { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 }

type Expected = {
  chip: string
  chipPro: boolean
  footerSub: string
  rows: Record<string, string> // 行标签 → 期望值(取 .alpha-acct-v 或 .alpha-acct-pending 的文本)
  ctas: string[]
}

const CASES: Array<{ name: string; summary: AccountSummary | { error: string }; expected: Expected }> = [
  {
    name: "已订阅+有余额:chip=计划名,两行=订阅额度窗口",
    summary: { balanceFen: 99865, walletUsedFen: 135, plan: activePlan, usage, usageSeries: series14 },
    expected: {
      chip: "PRO 月卡",
      chipPro: true,
      footerSub: "PRO 月卡",
      rows: {
        会员订阅: "Pro 月卡",
        可用余额: "¥998.65",
        "5 小时额度": "1,234 / 9,000",
        "7 日额度": "45,678 / 120,000",
      },
      ctas: ["充值", "管理订阅"],
    },
  },
  {
    name: "已订阅+无余额:与有余额格相同,仅余额行归零(订阅态不看余额)",
    summary: { balanceFen: 0, walletUsedFen: 135, plan: activePlan, usage, usageSeries: series14 },
    expected: {
      chip: "PRO 月卡",
      chipPro: true,
      footerSub: "PRO 月卡",
      rows: {
        会员订阅: "Pro 月卡",
        可用余额: "¥0.00",
        "5 小时额度": "1,234 / 9,000",
        "7 日额度": "45,678 / 120,000",
      },
      ctas: ["充值", "管理订阅"],
    },
  },
  {
    name: "未订阅+有余额:chip=按量付费(AC1),两行=真实用量(AC2)",
    summary: { balanceFen: 99865, walletUsedFen: 135, plan: nonePlan, usage, usageSeries: series14 },
    expected: {
      chip: "按量付费",
      chipPro: false,
      footerSub: "按量付费",
      rows: {
        会员订阅: "未订阅",
        可用余额: "¥998.65",
        今日用量: "12.3K",
        "7 日用量": "456.8K",
      },
      ctas: ["升级会员", "充值"],
    },
  },
  {
    name: "未订阅+无余额:chip=免费版,无新增提示行(AC3)",
    summary: { balanceFen: 0, walletUsedFen: 0, plan: nonePlan, usage: zeroUsage, usageSeries: [] },
    expected: {
      chip: "免费版",
      chipPro: false,
      footerSub: "免费版",
      rows: {
        会员订阅: "未订阅",
        可用余额: "¥0.00",
        今日用量: "0",
        "7 日用量": "0",
        "近 14 天": "暂无数据",
      },
      ctas: ["升级会员", "充值"],
    },
  },
  {
    name: "summary-error:五行占位「—」,chip 维持回落=免费版(不臆测余额)",
    summary: { error: "account fetch failed" },
    expected: {
      chip: "免费版",
      chipPro: false,
      footerSub: "免费版",
      rows: {
        会员订阅: "—",
        可用余额: "—",
        今日用量: "—",
        "7 日用量": "—",
        "近 14 天": "—",
      },
      ctas: ["升级会员", "充值"],
    },
  },
]

let currentSummary: AccountSummary | { error: string } | null = null

const EXPLICIT: Record<string, (...args: unknown[]) => unknown> = {
  appVersion: async () => "0.0.0-quadrant",
  "auth.getState": async () => ({
    status: "logged-in",
    mode: "cloud",
    email: "tester@example.com",
    account: { email: "tester@example.com", plan: "" }, // JWT plan claim 为空(未订阅账户的常态)
  }),
  "account.summary": async () => currentSummary,
  endpoints: async () => ({}),
}

function apiNode(path: string[]): unknown {
  const call = (...args: unknown[]) => {
    const key = path.join(".")
    if (key in EXPLICIT) return EXPLICIT[key]!(...args)
    const leaf = path[path.length - 1] ?? ""
    if (/^(on[A-Z]|subscribe)/.test(leaf)) return () => {}
    return Promise.resolve(undefined)
  }
  return new Proxy(call, {
    get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : apiNode([...path, prop])),
  })
}
;(globalThis as unknown as { window: { api: unknown } }).window.api = apiNode([])

const runtime = await import("../src/renderer/sidebar/overlay-close-test-runtime")
const { hrefFor } = await import("../src/shared/route-manifest")

const DIR = "/Users/tester/proj-a"

function makeProjects(): AlphaProjectsApi {
  const project: AlphaProject = {
    id: "prj-a",
    worktree: DIR,
    name: "proj-a",
    directories: [DIR],
    loaded: true,
    sessions: [{ id: "ses-current", title: "当前会话", directory: DIR, projectID: "prj-a", updated: 200 }],
  }
  return {
    store: { projects: [project], ready: true, error: false },
    reload: async () => {},
    createSession: async () => "ses-created",
    startChat: async () => "ses-created",
    sdk: () => undefined,
    renameSession: async () => true,
    shareSession: async () => undefined,
    deleteSession: async () => true,
    copySession: async () => undefined,
  } as unknown as AlphaProjectsApi
}

const disposers: Array<() => void> = []

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
})

afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

afterAll(() => GlobalRegistrator.unregister())

async function mount() {
  const history = runtime.createMemoryHistory()
  history.set({ value: hrefFor.home() })
  const host = document.getElementById("root")!
  disposers.push(solidWeb.render(() => runtime.OverlayCloseHarness({ history, projects: makeProjects() }), host))
  await flush()
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

function readRows(pop: Element): Record<string, string> {
  const rows: Record<string, string> = {}
  for (const row of pop.querySelectorAll(".alpha-acct-row")) {
    const k = row.querySelector(".alpha-acct-k")?.textContent?.trim() ?? "(无标签)"
    const v = row.querySelector(".alpha-acct-v")?.textContent?.trim()
    const pending = row.querySelector(".alpha-acct-pending")?.textContent?.trim()
    rows[k] = v ?? pending ?? (row.querySelector("svg") ? "<sparkline>" : "(空)")
  }
  return rows
}

for (const { name, summary, expected } of CASES) {
  test(name, async () => {
    currentSummary = summary
    await mount()
    const trigger = document.querySelector(".alpha-sidebar-account")
    expect(trigger).not.toBeNull()
    expect(document.querySelector(".alpha-sidebar-account-sub")?.textContent?.trim()).toBe(expected.footerSub)
    click(trigger!)
    await flush()
    const pop = document.querySelector(".alpha-acct-pop")
    expect(pop).not.toBeNull()

    const chip = pop!.querySelector(".alpha-acct-plan")
    expect(chip?.textContent?.trim()).toBe(expected.chip)
    expect(chip?.hasAttribute("data-pro")).toBe(expected.chipPro)

    const rows = readRows(pop!)
    // AC3 防回归:行数恰为 5(会员订阅/可用余额/两条额度或用量/近 14 天),不新增提示行。
    expect(Object.keys(rows).length).toBe(5)
    for (const [label, value] of Object.entries(expected.rows)) {
      expect(rows[label], `行「${label}」;实际行集合 ${JSON.stringify(rows)}`).toBe(value)
    }
    // AC2 反向钉死:未订阅格不得再出现「按量计费」占位或订阅额度标签。
    if (!("error" in summary) && summary.plan.status !== "active") {
      expect(rows["5 小时额度"]).toBeUndefined()
      expect(rows["7 日额度"]).toBeUndefined()
      expect(JSON.stringify(rows)).not.toContain("按量计费")
    }

    const ctas = [...pop!.querySelectorAll(".alpha-acct-btn")].map((b) => b.textContent?.trim())
    expect(ctas).toEqual(expected.ctas)
  })
}
