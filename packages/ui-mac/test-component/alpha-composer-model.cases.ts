// 独立进程运行：隔离仓内其他测试预先缓存的 Solid server 条件导出。
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { AccountSummary, AuthState } from "../src/preload/types"
import type { EffectiveCatalog, ProviderInput, ProviderKeyStatus } from "../src/shared/alpha-model-types"
import type { AlphaProjectsApi } from "../src/renderer/sidebar/use-projects"
import type { AlphaComposerRuntimeProps } from "../src/renderer/alpha-ui/alpha-composer"
import type { ComposerModel } from "../src/renderer/alpha-ui/composer-state"
import type { ModelContract } from "../src/renderer/alpha-ui/model-contract"
import { buildAlphaModelConfig } from "../src/main/alpha-models"
import { readConfiguredProviderKeys } from "../src/main/ext-config"
import { alphaJsoncPath } from "../src/main/engine-config-truth"
import { persistProviderAndRefresh, setProviderLifecycleDeps } from "../src/main/provider-lifecycle"
import { dict as zh } from "../src/renderer/i18n/zh"
import { dict as enDict } from "../src/renderer/i18n/en"
// ⚠️ `../src/renderer/i18n`(index)**不能**静态 import:它在模块求值期就 import 了 "solid-js",
// 而 ESM 静态 import 早于下面的 `mock.module("solid-js", …)` —— 于是整个文件拿到 Solid 的
// **server** 构建,45 条用例一起挂在 `getNextContextId cannot be used under non-hydrating context`。
// 两份 dict 是纯对象,静态 import 无害;setLocale 走下面的动态 import。

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const { batch, createComponent, createSignal } = solid
const { render } = solidWeb
// zh 产品文案的 locale pin 由 bunfig.toml 的 test preload(scripts/test-preload.ts 设
// ALPHA_UI_LOCALE=zh)统一提供 —— 本文件被 alpha-composer-model.component.test.ts 以子进程
// spawn,继承父进程 env,i18n 的 detectLocale() 直接读到 zh,无需再逐文件 setLocale。
const savedAlphaGlobalDir = process.env.ALPHA_GLOBAL_DIR
const savedOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
const tempDirs: string[] = []
const activeDisposals: Array<() => void> = []

Bun.plugin({
  name: "solid-component-tests",
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

const command = { options: [], trigger: () => {} } as unknown as AlphaComposerRuntimeProps["command"]
mock.module("../src/renderer/alpha-ui/providers", () => ({ useCommand: () => command }))
const { AlphaComposerRuntime } = await import("../src/renderer/alpha-ui/alpha-composer")
const { SessionComposerMount } = await import("../src/renderer/alpha-ui/session-workspace/session-composer-mount")
const { createComposerDraftStash } = await import("../src/renderer/alpha-ui/session-workspace/session-dock-core")
const { identityKey } = await import("../src/renderer/alpha-ui/session-workspace/session-workspace-core")
const { ModelPickPop } = await import("../src/renderer/alpha-ui/alpha-composer-model")
const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
const {
  composerModel,
  composerModelProjection,
  composerModelSuspended,
  resetComposerModelProjection,
  setComposerAgent,
  setComposerModel,
  setComposerPerm,
} = await import(
  "../src/renderer/alpha-ui/composer-state"
)
const { byokEngineId } = await import("../src/shared/alpha-model-types")
const { resetAuthRecoveryForTests } = await import("../src/renderer/auth-recovery")
const { setLocale } = await import("../src/renderer/i18n")

const catalog = {
  ...(await Bun.file(new URL("../src/main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
  // #681:平台段没有有效 V2/LKG 时 basis 为 null(该 stub 不带远端目录)。
  pricingBasisModelId: null,
} as EffectiveCatalog

const info = (providerID: string, id: string, name = id): ModelV2Info => ({
  id,
  providerID,
  name,
  api: { id: providerID, type: "aisdk", package: "@ai-sdk/openai-compatible" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 128_000, output: 8_192 },
})

const platformModels = catalog.platformModels.map((model) => info(catalog.platformProvider.id, model.id, model.name))
const keys = Object.fromEntries(
  catalog.byokProviders.map((provider) => [
    provider.id,
    { configured: provider.id === "deepseek", source: provider.id === "deepseek" ? "keychain" : "none" },
  ]),
) as ProviderKeyStatus
const loggedIn: AuthState = { status: "logged-in", mode: "platform" }
const loggedOut: AuthState = { status: "logged-out", mode: "byok" }
const summary: AccountSummary = {
  balanceFen: 0,
  walletUsedFen: 0,
  plan: {
    id: "pro",
    name: "Pro",
    status: "active",
    window5h: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
    window7d: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
    renewsAt: "",
    daysLeft: 10,
  },
  usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
  usageSeries: [],
}

const projects = {
  store: { projects: [], ready: true, error: false },
  reload: async () => {},
  createSession: async () => undefined,
  startChat: async () => undefined,
  sdk: () => undefined,
  renameSession: async () => false,
  shareSession: async () => undefined,
  deleteSession: async () => false,
  copySession: async () => undefined,
} satisfies AlphaProjectsApi

type ApiFixture = {
  auth?: () => Promise<AuthState>
  account?: () => Promise<AccountSummary | { error: string }>
  keyStatus?: () => Promise<ProviderKeyStatus>
  catalog?: () => Promise<EffectiveCatalog>
  add?: (input: unknown) => Promise<{ ok: true } | { ok: false; reason: string }>
  onLogin?: () => void
}

function installApi(fixture: ApiFixture = {}) {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      endpoints: async () => null,
      openLink: () => {},
      models: { catalog: fixture.catalog ?? (async () => catalog) },
      auth: {
        getState: fixture.auth ?? (async () => loggedIn),
        subscribe: () => () => {},
        start: async () => fixture.onLogin?.(),
      },
      account: { summary: fixture.account ?? (async () => summary) },
      providers: {
        keyStatus: fixture.keyStatus ?? (async () => keys),
        add: fixture.add ?? (async () => ({ ok: true as const })),
        test: async () => ({ ok: true as const, ms: 1 }),
        setKey: async () => ({ ok: true as const }),
        remove: async () => ({ ok: true as const }),
        removeKey: async () => ({ ok: true as const }),
      },
    },
  })
}

function mount(view: () => HTMLElement) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(view, host)
  let active = true
  const cleanup = () => {
    if (!active) return
    active = false
    dispose()
  }
  activeDisposals.push(cleanup)
  return { host, dispose: cleanup }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(assertion: () => void) {
  let failure: unknown
  for (let attempt = 0; attempt < 40; attempt++) {
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function click(button: Element | null) {
  expect(button).toBeInstanceOf(HTMLButtonElement)
  ;(button as HTMLButtonElement).click()
}

function input(element: HTMLInputElement, value: string) {
  element.value = value
  element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }))
}

afterEach(() => {
  activeDisposals.splice(0).forEach((dispose) => dispose())
  resetAuthRecoveryForTests()
  setProviderLifecycleDeps()
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  if (savedAlphaGlobalDir === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = savedAlphaGlobalDir
  if (savedOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = savedOpencodeConfigDir
  document.body.replaceChildren()
  setComposerModel(null)
  setComposerAgent(null)
  resetComposerModelProjection()
})
afterAll(() => GlobalRegistrator.unregister())

describe("AlphaComposer production model seam", () => {
  test("A 的外层 list 迟到时先过 epoch，不挂起 B 投影也不向 A 提交默认切换", async () => {
    installApi()
    const [sessionID, setSessionID] = createSignal("A")
    const [directory, setDirectory] = createSignal("/A")
    const pendingA = deferred<ModelV2Info[]>()
    const switches: Array<{ sessionID: string; model: ModelRef }> = []
    const contract: ModelContract = {
      list: async (dir) => (dir === "/A" ? pendingA.promise : platformModels),
      current: async (id) => ({
        providerID: catalog.platformProvider.id,
        id: id === "A" ? catalog.platformModels[0]!.id : catalog.platformModels[1]!.id,
      }),
      switch: async (id, model) => {
        switches.push({ sessionID: id, model })
      },
    }
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory,
        sessionID,
        command,
        modelContract: contract,
      }),
    )

    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    batch(() => {
      setDirectory("/B")
      setSessionID("B")
    })
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[1]!.id))
    pendingA.resolve([platformModels[0]!])
    await flush()
    await flush()

    expect(composerModel()?.id).toBe(catalog.platformModels[1]!.id)
    expect(composerModelSuspended()).toBeNull()
    expect(switches).toEqual([])
    mounted.dispose()
  })

  test("picker 打开时切 directory 会清空旧 epoch 行；旧 DOM 行紧邻提交校验拒绝", async () => {
    const customA = info("custom-a", "a-only", "A Only")
    installApi({ keyStatus: async () => ({ ...keys, "custom-a": { configured: true, source: "config" } }) })
    const [sessionID, setSessionID] = createSignal("A")
    const [directory, setDirectory] = createSignal("/A")
    const pendingB = deferred<ModelV2Info[]>()
    const switches: Array<{ sessionID: string; model: ModelRef }> = []
    const contract: ModelContract = {
      list: async (dir) => (dir === "/A" ? [...platformModels, customA] : pendingB.promise),
      current: async (id) => ({
        providerID: catalog.platformProvider.id,
        id: id === "A" ? catalog.platformModels[0]!.id : catalog.platformModels[1]!.id,
      }),
      switch: async (id, model) => {
        switches.push({ sessionID: id, model })
      },
    }
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory,
        sessionID,
        command,
        modelContract: contract,
      }),
    )

    await waitFor(() => {
      expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id)
      expect(mounted.host.querySelector<HTMLButtonElement>('[data-kind="model"] > button')?.disabled).toBe(false)
    })
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(document.body.textContent).toContain("A Only"))
    const staleRow = [...document.body.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].find((row) =>
      row.textContent?.includes("a-only"),
    )!

    batch(() => {
      setDirectory("/B")
      setSessionID("B")
    })
    await waitFor(() => {
      expect(composerModelProjection()).toEqual({ status: "ready", sessionID: "B" })
      expect([...document.body.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].every((row) => row.disabled)).toBe(true)
    })
    staleRow.click()
    expect(switches).toEqual([])

    pendingB.resolve(platformModels)
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("A Only")
      expect(
        [...document.body.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].some((row) => !row.disabled),
      ).toBe(true)
    })
    expect(switches).toEqual([])
    mounted.dispose()
  })

  test("A→B 的 current deferred/rejected 会立即失效旧 Ref，控件不能用 A 改写 B，且可重试", async () => {
    installApi()
    const [sessionID, setSessionID] = createSignal("A")
    const pendingB = deferred<ModelRef | undefined>()
    const switches: Array<{ sessionID: string; model: ModelRef }> = []
    let bReads = 0
    const contract: ModelContract = {
      list: async () => platformModels,
      current: async (id) => {
        if (id === "A") return { providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }
        bReads++
        if (bReads === 1) return pendingB.promise
        return { providerID: catalog.platformProvider.id, id: catalog.platformModels[1]!.id }
      },
      switch: async (id, model) => {
        switches.push({ sessionID: id, model })
      },
    }
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory: () => "/workspace",
        sessionID,
        command,
        modelContract: contract,
      }),
    )

    await waitFor(() => expect(mounted.host.textContent).toContain(catalog.platformModels[0]!.name))
    setSessionID("B")
    await waitFor(() => {
      expect(composerModel()).toBeNull()
      expect(composerModelProjection()).toEqual({ status: "loading", sessionID: "B" })
      expect(mounted.host.textContent).toContain(zh["alpha.composer.modelReading"])
    })

    const effort = mounted.host.querySelector<HTMLButtonElement>('button[title*="当前会话模型加载中"]')
    expect(effort?.disabled).toBe(true)
    effort?.click()
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await flush()
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>(".a-mpp-row")]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.disabled)).toBe(true)
    rows[0]?.click()
    expect(switches).toEqual([])

    pendingB.reject(new Error("get failed"))
    await waitFor(() => {
      expect(composerModel()).toBeNull()
      expect(composerModelProjection()).toEqual({ status: "error", sessionID: "B" })
      expect(document.body.textContent).toContain(zh["alpha.model.currentFailed"])
    })
    const retryAlert = [...document.body.querySelectorAll(".a-mpp-alert")].find((node) =>
      node.textContent?.includes("当前会话模型读取失败"),
    )
    click(retryAlert?.querySelector("button") ?? null)
    await waitFor(() => {
      expect(composerModelProjection()).toEqual({ status: "ready", sessionID: "B" })
      expect(composerModel()?.id).toBe(catalog.platformModels[1]!.id)
    })
    expect(switches).toEqual([])
    mounted.dispose()
  })

  test("switchModel 失败保留已确认选择并在真实 picker 呈现错误", async () => {
    installApi()
    const first = catalog.platformModels[0]!
    const second = catalog.platformModels[1]!
    const switches: Array<{ sessionID: string; model: ModelRef }> = []
    const contract: ModelContract = {
      list: async () => platformModels,
      current: async () => ({ providerID: catalog.platformProvider.id, id: first.id }),
      switch: async (sessionID, model) => {
        switches.push({ sessionID, model })
        throw new Error("switch failed")
      },
    }
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory: () => "/workspace",
        sessionID: () => "A",
        command,
        modelContract: contract,
      }),
    )

    await waitFor(() => expect(composerModel()?.id).toBe(first.id))
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(document.body.textContent).toContain(second.name))
    click(
      [...document.body.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].find((row) =>
        row.getAttribute("aria-label")?.startsWith(`${second.name},`),
      ) ?? null,
    )
    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.model.switchFailed"]))
    expect(switches).toEqual([{ sessionID: "A", model: { providerID: catalog.platformProvider.id, id: second.id } }])
    expect(composerModel()?.id).toBe(first.id)
    expect(mounted.host.textContent).toContain(first.name)
    mounted.dispose()
  })

  test("auth/list 窗口期的 Effort 入口 fail-closed，不能取消外层链并留下 loading 死点", async () => {
    const pendingAuth = deferred<AuthState>()
    let authReads = 0
    installApi({
      auth: async () => {
        authReads++
        if (authReads === 1) return loggedIn
        return pendingAuth.promise
      },
    })
    const [directory, setDirectory] = createSignal("/A")
    const switches: Array<{ sessionID: string; model: ModelRef }> = []
    const contract: ModelContract = {
      list: async () => platformModels,
      current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
      switch: async (sessionID, model) => {
        switches.push({ sessionID, model })
      },
    }
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory,
        sessionID: () => "A",
        command,
        modelContract: contract,
        initialText: "hello",
      }),
    )

    const effort = mounted.host.querySelector<HTMLButtonElement>('[data-kind="effort"] > button')!
    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => {
      expect(effort.disabled).toBe(false)
      expect(send.disabled).toBe(false)
    })
    click(effort)
    const variant = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>(".a-pop-item")].find(
        (button) => button.textContent?.trim() === Object.keys(catalog.platformModels[0]!.variants ?? {})[0],
      )!
    expect(variant()).toBeInstanceOf(HTMLButtonElement)

    setDirectory("/B")
    await waitFor(() => {
      expect(composerModelProjection()).toEqual({ status: "ready", sessionID: "A" })
      expect(effort.disabled).toBe(true)
      expect(variant().disabled).toBe(true)
      expect(send.disabled).toBe(true)
    })
    // 绕过原生 disabled 抑制，直接证伪 common admission 在 readiness 检查前递增 chainSeq 的旧实现。
    variant().dispatchEvent(new MouseEvent("click", { bubbles: true }))
    pendingAuth.resolve(loggedIn)

    await waitFor(() => {
      expect(effort.disabled).toBe(false)
      expect(send.disabled).toBe(false)
      expect(mounted.host.querySelector('[role="alert"]')).toBeNull()
    })
    expect(switches).toEqual([])
    mounted.dispose()
  })

  test("真实 composer 打开 picker 时恰好挂载一个 canonical owner 实例", async () => {
    installApi()
    const contract: ModelContract = {
      list: async () => platformModels,
      current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
      switch: async () => {},
    }
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory: () => "/workspace",
        sessionID: () => "A",
        command,
        modelContract: contract,
      }),
    )

    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    expect(document.body.querySelectorAll('[data-alpha-picker-owner="alpha.composer-model"]')).toHaveLength(0)
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() =>
      expect(document.body.querySelectorAll('[data-alpha-picker-owner="alpha.composer-model"]')).toHaveLength(1),
    )
    mounted.dispose()
  })

  test("home 的 model.list 与账户目录并行，账户迟到不阻塞本地目录", async () => {
    const account = deferred<AccountSummary>()
    const models = deferred<ModelV2Info[]>()
    let listReads = 0
    let accountReads = 0
    installApi({
      account: () => {
        accountReads++
        return account.promise
      },
    })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => {
            listReads++
            return models.promise
          },
          current: async () => undefined,
          switch: async () => {},
        },
      }),
    )

    await waitFor(() => {
      expect(listReads).toBe(1)
      expect(accountReads).toBe(1)
    })
    expect(composerModel()).toBeNull()
    models.resolve([...platformModels, info("deepseek-byok", "deepseek-v4-flash")])
    await waitFor(() => expect(composerModel()?.providerID).toBe("deepseek-byok"))
    account.resolve(summary)
    await flush()
    expect(composerModel()?.providerID).toBe("deepseek-byok")
    mounted.dispose()
  })

  test("account 瞬态失败保持恢复中，SSE 恢复会取消退避并立即重试", async () => {
    let failing = true
    let submissions = 0
    installApi({
      account: async () => {
        if (failing) throw new Error("account failed")
        return summary
      },
    })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => {
            submissions++
            return "session-new"
          },
        },
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => platformModels,
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(send.disabled).toBe(true))
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.model.syncing"]))
    expect(document.body.textContent).not.toContain(zh["alpha.model.accountFailed"])
    expect(document.body.textContent).not.toContain("余额不足")
    send.click()
    expect(submissions).toBe(0)

    failing = false
    window.dispatchEvent(new Event("alpha:sse-reconnected"))
    await waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await waitFor(() => expect(submissions).toBe(1))
    mounted.dispose()
  })

  test("#604 auth ready 事件丢失时平台能力自证恢复,不再永久 recovering", async () => {
    // 生产 composition:真 AlphaComposerRuntime + 真 subscribeAuthState 接线。
    // main 的 token 过期 → platformStatus recovering → 发送 fail-closed;main 刷新成功后
    // **那一次 `auth-state ready` 永不到达**(publish() 的身份签名去重让它也不会重发)。
    // 修复前:消费侧再无下一次 auth.getState(),发送按钮永久关闭。
    // 相位 A:链与 owner 的两次读取都先读到 recovering,之后 main 恢复但事件不来。
    // 本例取最强形态:整个生命周期里桥一个事件都不送,可用性只能由自探自己挣回来。
    let authNow: AuthState = { status: "logged-in", mode: "platform", platformStatus: "recovering" }
    let submissions = 0
    installApi({
      auth: async () => authNow,
      // 桥全程不送任何 auth-state 事件(连首值回放都没有)—— 恢复只能靠自探。
      keyStatus: async () =>
        Object.fromEntries(
          catalog.byokProviders.map((provider) => [provider.id, { configured: false, source: "none" }]),
        ) as ProviderKeyStatus,
    })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => {
            submissions++
            return "session-new"
          },
        },
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => platformModels,
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(send.disabled).toBe(true))
    send.click()
    expect(submissions).toBe(0)

    // main 刷新成功了;没有任何事件会通知 renderer —— 只能靠自探。
    authNow = { status: "logged-in", mode: "platform", platformStatus: "ready" }
    await new Promise((resolve) => setTimeout(resolve, 1600))

    await waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await waitFor(() => expect(submissions).toBe(1))
    mounted.dispose()
  })

  test("#604 相位 B:链读到 recovering 而 owner 首读已是 ready 时,平台能力仍必须放行", async () => {
    // Codex R1 Blocker:main 在「链读取」与「owner 首读」之间完成续期。链拿到的是 recovering,
    // owner 拿到的是 ready,而丢失的 auth-state ready 不会补发。若 owner 只更新自己的视图而不
    // 广播、或链坚持用自己那份旧快照,发送按钮就永久关闭。桥全程零事件。
    let reads = 0
    let submissions = 0
    installApi({
      auth: async () => {
        reads++
        // 第一次读取(链自己那次)看到过期态;此后 main 已就绪。
        return reads === 1
          ? { status: "logged-in", mode: "platform", platformStatus: "recovering" }
          : { status: "logged-in", mode: "platform", platformStatus: "ready" }
      },
      keyStatus: async () =>
        Object.fromEntries(
          catalog.byokProviders.map((provider) => [provider.id, { configured: false, source: "none" }]),
        ) as ProviderKeyStatus,
    })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => {
            submissions++
            return "session-new"
          },
        },
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => platformModels,
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await waitFor(() => expect(submissions).toBe(1))
    mounted.dispose()
  })

  test("换血打断在途发送时保留草稿并显示明确中断状态", async () => {
    const started = deferred<string>()
    let submitted = 0
    installApi({ auth: async () => loggedOut })
    const toasts = mount(() => createComponent(ToastViewport, {}))
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => started.promise,
        },
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => [info("deepseek-byok", "deepseek-v4-flash")],
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "保留这段草稿",
        onSubmitted: () => {
          submitted++
        },
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "recovering", generation: 7, reason: "token-only" },
      }),
    )
    started.resolve("session-new")

    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.composer.generationInterrupted"]))
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留这段草稿")
    expect(submitted).toBe(0)
    mounted.dispose()
    toasts.dispose()
  })

  test("idle token-only 换血只关闭执行门且不闪动;换代失败则如实回到 Syncing", async () => {
    let submissions = 0
    installApi({ auth: async () => loggedOut })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => {
            submissions++
            return "session-new"
          },
        },
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => [info("deepseek-byok", "deepseek-v4-flash")],
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "保留稳定布局",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(send.disabled).toBe(false))

    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "recovering", generation: 8, reason: "token-only" },
      }),
    )
    await waitFor(() => expect(send.disabled).toBe(true))
    expect(mounted.host.textContent).not.toContain(zh["alpha.model.syncing"])
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留稳定布局")

    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "ready", generation: 8, reason: "token-only" },
      }),
    )
    await waitFor(() => expect(send.disabled).toBe(false))
    expect(submissions).toBe(0)

    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "recovering", generation: 9, reason: "token-only" },
      }),
    )
    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "failed", generation: 9, reason: "token-only" },
      }),
    )
    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.syncing"]))
    expect(send.disabled).toBe(true)
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留稳定布局")
    mounted.dispose()
  })

  test("KEY 读取失败由外层失败态呈现并阻止提交；picker 重试会重跑整条链", async () => {
    let failing = true
    let submissions = 0
    installApi({
      keyStatus: async () => {
        if (failing) throw new Error("key failed")
        return keys
      },
    })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => {
            submissions++
            return "session-new"
          },
        },
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => platformModels,
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.composer.modelChainFailed"]))
    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    expect(send.disabled).toBe(true)
    send.click()
    expect(submissions).toBe(0)

    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.model.keyReadFailed"]))
    failing = false
    const retry = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.closest('[role="alert"]')?.textContent?.includes("KEY 状态读取失败"),
    )
    click(retry ?? null)

    await waitFor(() => {
      expect(mounted.host.textContent).not.toContain("账户、KEY 或模型目录读取失败")
      expect(send.disabled).toBe(false)
    })
    send.click()
    await waitFor(() => expect(submissions).toBe(1))
    mounted.dispose()
  })
})

describe("ModelPickPop production component", () => {
  test("list/auth 瞬态失败显示恢复中，KEY 硬失败显示重试，不伪装成业务否定态", async () => {
    resetComposerModelProjection()
    installApi({
      auth: async () => {
        throw new Error("auth failed")
      },
      keyStatus: async () => {
        throw new Error("key failed")
      },
    })
    const selected: ComposerModel = { providerID: "custom", id: "kept", name: "Kept", variants: [] }
    let selectedCalls = 0
    const contract: ModelContract = {
      list: async () => {
        throw new Error("list failed")
      },
      current: async () => undefined,
      switch: async () => {},
    }
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract,
        directory: () => "/workspace",
        selected: () => selected,
        onSelect: async () => {
          selectedCalls++
        },
        onPicked: () => {},
      }),
    )

    await waitFor(() => {
      expect(mounted.host.textContent).toContain(zh["alpha.model.syncing"])
      expect(mounted.host.textContent).toContain(zh["alpha.model.keyReadFailed"])
      expect(mounted.host.textContent).toContain(zh["alpha.model.engineConnecting"])
    })
    expect(mounted.host.textContent).not.toContain(zh["alpha.model.accountFailed"])
    expect(mounted.host.textContent).not.toContain("未配置 KEY")
    expect(mounted.host.textContent).not.toContain("需登录")
    expect(mounted.host.textContent).not.toContain("余额不足")
    const keyAlert = [...mounted.host.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent?.includes(zh["alpha.model.keyReadFailed"]),
    )
    expect(keyAlert?.querySelector("button")?.textContent).toContain(zh["alpha.common.retry"])
    const engineStatus = [...mounted.host.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent?.includes(zh["alpha.model.engineConnecting"]),
    )
    expect(engineStatus?.querySelector("button")?.textContent).toContain(zh["alpha.model.retryNow"])
    const rows = [...mounted.host.querySelectorAll<HTMLButtonElement>(".a-mpp-row")]
    expect(rows.every((row) => row.disabled)).toBe(true)
    rows[0]?.click()
    expect(selectedCalls).toBe(0)
    expect(selected.id).toBe("kept")
    mounted.dispose()
  })

  test("account 瞬态失败保持 recovering，不降格为余额不足或当前不可用", async () => {
    resetComposerModelProjection()
    installApi({
      account: async () => {
        throw new Error("account failed")
      },
    })
    let selectedCalls = 0
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async () => {
          selectedCalls++
        },
        onPicked: () => {},
      }),
    )

    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.syncing"]))
    expect(mounted.host.textContent).not.toContain(zh["alpha.model.accountFailed"])
    expect(mounted.host.textContent).not.toContain("余额不足")
    const platformRows = platformModels.map((model) =>
      mounted.host.querySelector<HTMLButtonElement>(`.a-mpp-row[aria-label^="${model.name},"]`),
    )
    expect(platformRows.every((row) => !row?.textContent?.includes("当前不可用"))).toBe(true)
    const platform = platformRows[0]
    expect(platform?.disabled).toBe(true)
    platform?.click()
    expect(selectedCalls).toBe(0)
    mounted.dispose()
  })

  test("未登录只呈现统一登录入口，不渲染平台代理模型锁墙", async () => {
    resetComposerModelProjection()
    let logins = 0
    installApi({ auth: async () => loggedOut, onLogin: () => logins++ })
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async () => {},
        onPicked: () => {},
      }),
    )

    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.loginUnlock"]))
    expect(mounted.host.textContent).not.toContain("代理节点 · 经 ALPHA 代理")
    expect(
      [...mounted.host.querySelectorAll(".a-mpp-row")].filter((row) =>
        row.getAttribute("aria-label")?.includes(`,${catalog.platformProvider.name}`),
      ),
    ).toEqual([])
    const loginButtons = [...mounted.host.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "登录")
    expect(loginButtons).toHaveLength(1)
    click(loginButtons[0] ?? null)
    await flush()
    expect(logins).toBe(1)
    mounted.dispose()
  })

  test("保存 Custom Provider 走真实持久化→next-fork allowlist→list 刷新并呈现可选行", async () => {
    resetComposerModelProjection()
    const root = mkdtempSync(join(tmpdir(), "alpha-provider-component-"))
    tempDirs.push(root)
    process.env.ALPHA_GLOBAL_DIR = join(root, "environment")
    process.env.OPENCODE_CONFIG_DIR = join(root, "xdg")
    const userData = join(root, "user-data")
    let runtimeModels = [...platformModels]
    let refreshes = 0
    setProviderLifecycleDeps({
      refreshRuntime: async () => {
        refreshes++
        const nextFork = buildAlphaModelConfig(userData)!
        expect(nextFork.enabled_providers).toContain("custom-node")
        const persisted = parse(readFileSync(alphaJsoncPath(), "utf8")) as {
          provider?: Record<string, { models?: Record<string, { name?: string }> }>
        }
        runtimeModels = [
          ...platformModels,
          ...Object.entries(persisted.provider?.["custom-node"]?.models ?? {}).map(([id, model]) =>
            info("custom-node", id, model.name ?? id),
          ),
        ]
        return true
      },
    })
    installApi({
      keyStatus: async () => ({
        ...keys,
        ...Object.fromEntries(
          [...readConfiguredProviderKeys()].map(([id]) => [id, { configured: true, source: "config" as const }]),
        ),
      }),
      add: (value) => persistProviderAndRefresh(value as ProviderInput),
    })
    const contract: ModelContract = {
      list: async () => runtimeModels,
      current: async () => undefined,
      switch: async () => {},
    }
    let selected: ComposerModel | null = null
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract,
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async (model) => {
          selected = model
        },
        onPicked: () => {},
      }),
    )

    await waitFor(() => {
      const add = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("添加自定义节点 / 供应商"),
      )
      expect(add?.disabled).toBe(false)
    })
    click(
      [...mounted.host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("添加自定义节点 / 供应商"),
      ) ?? null,
    )
    click(
      [...mounted.host.querySelectorAll("button")].find((button) => button.textContent?.includes("其他 / 自定义端点")) ??
        null,
    )
    input(mounted.host.querySelector<HTMLInputElement>('input[placeholder="如 DeepSeek"]')!, "Custom Node")
    input(
      mounted.host.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!,
      "https://custom.invalid/v1",
    )
    input(mounted.host.querySelector<HTMLInputElement>('input[placeholder="sk-..."]')!, "sk-test")
    const modelInput = mounted.host.querySelector<HTMLInputElement>('input[placeholder*="回车添加"]')!
    input(modelInput, "real-custom-model")
    modelInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))
    click([...mounted.host.querySelectorAll("button")].find((button) => button.textContent?.includes("保存并启用")) ?? null)

    await waitFor(() =>
      expect(
        [...mounted.host.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].some((button) =>
          button.textContent?.includes("real-custom-model"),
        ),
      ).toBe(true),
    )
    expect(refreshes).toBe(1)
    const row = [...mounted.host.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].find((button) =>
      button.textContent?.includes("real-custom-model"),
    )
    expect(row?.disabled).toBe(false)
    expect(row?.dataset.group).toBe("byok")
    click(row ?? null)
    await waitFor(() => expect(selected?.id).toBe("real-custom-model"))
    mounted.dispose()
  })

  // #613 反向闸门(退出条件 2/3,renderer 半场):「引擎未就绪」(failed)与「引擎就绪但注入失败」
  // (injection-failed)必须呈现为两个不同的事实。把 injection-failed 并进 failed 的沉默分支
  // (或删掉横幅),第二段断言当场转红;第一段锁住反向误判 —— 引擎未就绪不得谎报成配置问题。
  test("#613 引擎未就绪与注入失败在 picker 中可区分:failed 无配置横幅,injection-failed 呈现配置横幅", async () => {
    resetComposerModelProjection()
    installApi()
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async () => {},
        onPicked: () => {},
      }),
    )
    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.platformGroup"]))

    // 引擎未就绪终态:不得出现「模型配置未生效」——那是另一个事实的横幅
    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", { detail: { status: "failed", generation: 3, reason: "boot" } }),
    )
    await flush()
    expect(mounted.host.textContent).not.toContain(zh["alpha.model.engineConfigFailed"])

    // 引擎就绪但注入失败:横幅必须出现
    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "injection-failed", generation: 4, reason: "boot" },
      }),
    )
    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.engineConfigFailed"]))

    // 新一代 recovering 到来即撤下横幅(事实已翻篇,不粘滞)
    window.dispatchEvent(
      new CustomEvent("alpha:runtime-recovery", {
        detail: { status: "recovering", generation: 5, reason: "structural" },
      }),
    )
    await waitFor(() => expect(mounted.host.textContent).not.toContain(zh["alpha.model.engineConfigFailed"]))
    mounted.dispose()
  })
})

describe("#652 会话发送走 v1 promptAsync(与首页同一条)+ 停止键诚实", () => {
  const readyContract = (): ModelContract => ({
    list: async () => platformModels,
    current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
    switch: async () => {},
  })

  /** 两条发送端点都在的假 sidecar:v1 记账并可控失败,v2 记账只为断言「一次都没被走过」。 */
  function fakeSessionSdk(overrides?: { abort?: () => Promise<unknown>; promptError?: () => boolean }) {
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const v2Prompts: Array<Record<string, unknown>> = []
    const agentSwitches: Array<{ sessionID: string; agent: string }> = []
    const v2Gets: string[] = []
    const abortCalls: unknown[] = []
    const client = {
      command: { list: async () => ({ data: [] }) },
      session: {
        promptAsync: async (args: Record<string, unknown>) => {
          promptAsyncCalls.push(args)
          return overrides?.promptError?.() ? { error: { status: 500 } } : {}
        },
        abort: async (args: unknown) => {
          abortCalls.push(args)
          return overrides?.abort ? overrides.abort() : {}
        },
      },
      v2: {
        session: {
          get: async (args: { sessionID: string }) => {
            v2Gets.push(args.sessionID)
            return { data: { data: { id: args.sessionID, agent: undefined } } }
          },
          prompt: async (args: Record<string, unknown>) => {
            v2Prompts.push(args)
            return { data: { id: "msg_admitted", admittedSeq: v2Prompts.length } }
          },
          switchAgent: async (args: { sessionID: string; agent: string }) => {
            agentSwitches.push(args)
            return {}
          },
        },
      },
    }
    return { client, promptAsyncCalls, v2Prompts, agentSwitches, v2Gets, abortCalls }
  }

  function sessionMount(sdk: ReturnType<typeof fakeSessionSdk>, running: () => boolean) {
    const sessionProjects = { ...projects, sdk: () => sdk.client as never } satisfies AlphaProjectsApi
    return mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects: sessionProjects,
        directory: () => "/A",
        sessionID: () => "A",
        command,
        modelContract: readyContract(),
        sessionDock: {
          running,
          contextUsage: () => null,
          approvalPending: () => false,
        },
      }),
    )
  }

  function typeText(host: HTMLElement, value: string) {
    const textarea = host.querySelector("textarea")!
    textarea.value = value
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }))
    return textarea
  }

  function pressEnter(textarea: HTMLTextAreaElement) {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  }

  async function waitReady(host: HTMLElement, text: string) {
    const textarea = typeText(host, text)
    await waitFor(() => expect(host.querySelector<HTMLButtonElement>(".a-comp-send")!.disabled).toBe(false))
    return textarea
  }

  test("空闲与运行中都走 session.promptAsync;v2 durable 端点一次都不碰", async () => {
    installApi()
    const sdk = fakeSessionSdk()
    const [running, setRunning] = createSignal(false)
    const mounted = sessionMount(sdk, running)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    const textarea = await waitReady(mounted.host, "跑一下测试")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(1))
    expect(sdk.promptAsyncCalls[0]).toMatchObject({
      sessionID: "A",
      directory: "/A",
      parts: [{ type: "text", text: "跑一下测试" }],
    })

    // 运行中:发送键换停止形态,Enter 仍是同一条 v1 路径(引擎侧 ensureRunning 把这条消息
    // 并进正在跑的 loop —— 占位文案「发送后排队」在 v1 上同样成立,不需要 delivery 档位)。
    setRunning(true)
    await waitFor(() => expect(mounted.host.querySelector(".a-comp-stop")).not.toBeNull())
    pressEnter(typeText(mounted.host, "补一个用例"))
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(2))
    expect(sdk.promptAsyncCalls[1]).toMatchObject({ sessionID: "A", parts: [{ type: "text", text: "补一个用例" }] })
    expect("delivery" in sdk.promptAsyncCalls[1]!).toBe(false)

    // #652 的核心:新引擎那条链一次都不被碰 —— 它没有 MCP、没有 alpha 插件钩子、且拿不到凭证。
    expect(sdk.v2Prompts).toEqual([])
    // 发送前不再有任何「先读会话档 / 先切会话档」的往返 —— 那两步曾各自是一个新的发送拦截点。
    expect(sdk.v2Gets).toEqual([])
    expect(sdk.agentSwitches).toEqual([])
    mounted.dispose()
  })

  test("引擎把这条发送装进 { error } 信封时如实失败:正文保留,可原地重发", async () => {
    installApi()
    let failing = true
    const sdk = fakeSessionSdk({ promptError: () => failing })
    const mounted = sessionMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    const textarea = await waitReady(mounted.host, "会失败的一条")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(1))
    await waitFor(() => expect((mounted.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("会失败的一条"))

    failing = false
    pressEnter(mounted.host.querySelector("textarea") as HTMLTextAreaElement)
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(2))
    await waitFor(() => expect((mounted.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(""))
    mounted.dispose()
  })

  test("停止键:SDK { error } 信封按失败处理,如实提示中止失败", async () => {
    installApi()
    const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
    const sdk = fakeSessionSdk({ abort: async () => ({ error: { status: 409 } }) })
    const mounted = sessionMount(sdk, () => true)
    const toastHost = mount(() => createComponent(ToastViewport, {}))
    await waitFor(() => expect(mounted.host.querySelector(".a-comp-stop")).not.toBeNull())

    click(mounted.host.querySelector(".a-comp-stop"))
    await waitFor(() => expect(sdk.abortCalls).toHaveLength(1))
    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.composer.abortFailed"]))

    mounted.dispose()
    toastHost.dispose()
  })

  test("档位随每条消息走:plan / 只读 / 默认档各自落在 promptAsync 的 agent 字段上,零切档", async () => {
    installApi()
    const sdk = fakeSessionSdk()
    const mounted = sessionMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    setComposerAgent("plan")
    pressEnter(await waitReady(mounted.host, "先按计划来"))
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(1))
    expect(sdk.promptAsyncCalls[0]).toMatchObject({ agent: "plan" })

    // 退出 plan:下一条就是默认档 —— 不带 agent 字段(v1 引擎自己回落到默认 agent),
    // 也不需要「把会话档收回默认」的补偿写入,因为 v1 根本没有会话级档位这个中间状态。
    setComposerAgent(null)
    pressEnter(await waitReady(mounted.host, "普通消息"))
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(2))
    expect("agent" in sdk.promptAsyncCalls[1]!).toBe(false)

    // 只读档:真载体是 alpha-readonly agent(静态权限档),同样按条走。
    setComposerPerm("readonly")
    pressEnter(await waitReady(mounted.host, "只看不改"))
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(3))
    expect(sdk.promptAsyncCalls[2]).toMatchObject({ agent: "alpha-readonly" })
    setComposerPerm("ask")

    expect(sdk.agentSwitches).toEqual([])
    expect(sdk.v2Gets).toEqual([])
    expect(sdk.v2Prompts).toEqual([])
    mounted.dispose()
  })

  test("运行中切 plan 档照常发送:v1 的 agent 是消息级的,不影响正在跑的那一回合", async () => {
    installApi()
    const sdk = fakeSessionSdk()
    const mounted = sessionMount(sdk, () => true)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    setComposerAgent("plan")

    pressEnter(typeText(mounted.host, "排队执行"))
    await waitFor(() => expect(sdk.promptAsyncCalls).toHaveLength(1))
    expect(sdk.promptAsyncCalls[0]).toMatchObject({ agent: "plan" })
    expect(sdk.agentSwitches).toEqual([])
    setComposerAgent(null)
    mounted.dispose()
  })
})

// REQ-125 C558:seam dock 的 child-session 门翻转会卸载 composer(保持子会话零可发送路径);
// per-identity 草稿暂存依赖 AlphaComposer 的两点契约 —— ①卸载时经 onDraftCapture 交回当前草稿,
// ②initialText 注入即为 textarea 起始值(门翻回时还原)。这里对真实组件验这两点。
describe("REQ-125 C558 composer draft capture/restore contract", () => {
  const contract: ModelContract = {
    list: async () => [],
    current: async () => undefined,
    switch: async () => {},
  }

  test("卸载时经 onDraftCapture 交回当前输入草稿(门翻转→child 不丢草稿)", async () => {
    installApi()
    const captured: string[] = []
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory: () => "/A",
        sessionID: () => "A",
        command,
        modelContract: contract,
        onDraftCapture: (text) => captured.push(text),
      }),
    )
    await flush()
    const ta = mounted.host.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")
    expect(ta).not.toBeNull()
    ta!.value = "half-written draft"
    ta!.dispatchEvent(new Event("input", { bubbles: true }))
    await flush()
    mounted.dispose() // 门翻转 → child:composer 卸载
    expect(captured).toEqual(["half-written draft"])
  })

  test("initialText 注入 → textarea 起始即为还原的草稿(门翻回)", async () => {
    installApi()
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory: () => "/A",
        sessionID: () => "A",
        command,
        modelContract: contract,
        initialText: "restored draft",
      }),
    )
    await flush()
    const ta = mounted.host.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")
    expect(ta?.value).toBe("restored draft")
    mounted.dispose()
  })
})

// REQ-125 C558 复审第4轮 Major(根修):composer 实例按身份 keyed —— 身份切换=旧实例卸载(用自身
// keyed 键捕获)+ 新实例挂载(restore 新身份)。键与实例生命周期一致,消除「键定格 A、目录响应式
// 切 B」的分裂。对真实 SessionComposerMount(内挂真实 AlphaComposer)验复审点名的三个序。
describe("REQ-125 C558 SessionComposerMount 按身份 keyed:切会话草稿正确归属", () => {
  const identityFor = (sessionID: string) => ({ serverKey: "sidecar", directory: "/ws", sessionID })
  const dockApi = {
    running: () => false,
    contextUsage: () => null,
    approvalPending: () => false,
    onSlashCommand: () => {},
  }
  // SessionComposerMount 内部经 createModelContract(props.projects.sdk) 自建模型档,故需可用 sdk
  // (否则 list 抛 ModelContractError,composer 不渲染)。这里只求 composer 挂起、textarea 可见。
  const keyedProjects = {
    ...projects,
    sdk: () =>
      ({
        v2: {
          model: { list: async () => ({ data: { data: platformModels } }) },
          session: {
            get: async ({ sessionID }: { sessionID: string }) => ({
              data: { data: { id: sessionID, model: undefined, agent: undefined } },
            }),
            switchModel: async () => ({}),
          },
        },
      }) as never,
  } satisfies AlphaProjectsApi
  const ta = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")
  const type = (el: HTMLTextAreaElement, value: string) => {
    el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }

  test("① A 输入→切 B→继续在 B 编辑→卸载:B 草稿入 B 键、A 键仍是 A 的", async () => {
    installApi()
    const drafts = createComposerDraftStash()
    const [identity, setIdentity] = createSignal(identityFor("A"))
    const mounted = mount(() => createComponent(SessionComposerMount, { identity, projects: keyedProjects, dock: dockApi, drafts }))
    await flush()
    const taA = ta(mounted.host)!
    expect(taA).not.toBeNull()
    type(taA, "A-draft")
    await flush()
    setIdentity(identityFor("B")) // keyed 重挂:旧 A 实例卸载(捕获 A-draft@keyA)+ 新 B 实例挂载
    await flush()
    const taB = ta(mounted.host)!
    expect(taB).not.toBe(taA) // 已是新实例的 textarea
    expect(taB.value).toBe("") // B 首挂:无暂存
    type(taB, "B-draft") // 继续在 B 编辑(根修前会误入 A 键)
    await flush()
    mounted.dispose() // 卸载 B 实例 → 捕获 B-draft@keyB
    expect(drafts.restore(identityKey(identityFor("B")))).toBe("B-draft")
    expect(drafts.restore(identityKey(identityFor("A")))).toBe("A-draft")
  })

  test("② undefined→B:B 键正常捕获(身份未定不挂 composer,无空键丢弃)", async () => {
    installApi()
    const drafts = createComposerDraftStash()
    const [identity, setIdentity] = createSignal<ReturnType<typeof identityFor> | undefined>(undefined)
    const mounted = mount(() => createComponent(SessionComposerMount, { identity, projects: keyedProjects, dock: dockApi, drafts }))
    await flush()
    expect(ta(mounted.host)).toBeNull() // 身份 undefined → 不挂 composer
    expect(mounted.host.querySelector(".a-swk-composer-pending")).not.toBeNull() // 轻占位
    setIdentity(identityFor("B")) // 身份到达 → 挂 B composer
    await flush()
    const taB = ta(mounted.host)!
    expect(taB).not.toBeNull()
    type(taB, "B-draft")
    await flush()
    mounted.dispose() // 捕获 B-draft@keyB(非空键)
    expect(drafts.restore(identityKey(identityFor("B")))).toBe("B-draft")
  })

  test("③ A→B→回 A:重挂经 stash 往返恢复 A 草稿", async () => {
    installApi()
    const drafts = createComposerDraftStash()
    const [identity, setIdentity] = createSignal(identityFor("A"))
    const mounted = mount(() => createComponent(SessionComposerMount, { identity, projects: keyedProjects, dock: dockApi, drafts }))
    await flush()
    type(ta(mounted.host)!, "A-draft")
    await flush()
    setIdentity(identityFor("B")) // 旧 A 卸载 → A-draft@keyA
    await flush()
    setIdentity(identityFor("A")) // 回 A → 新实例 restore(keyA)=A-draft
    await flush()
    expect(ta(mounted.host)?.value).toBe("A-draft")
    mounted.dispose()
  })
})

// REQ-125 C558 复审第5-6轮 Major:v2 durable 发送(session.prompt)在途期间切会话,composer 卸载不能把
// **正在发送的文本**当草稿捕获(否则翻回「复活」→ 重复发送);在途被改成新草稿则照常捕获(不丢)。修:
// onCleanup 仅当 sending() 且 text()===submittedText(在途未编辑)才跳过。这里驱动真实 durable 发送验。
describe("REQ-125 C558 发送在途与草稿捕获互斥(#652 起 = v1 promptAsync)", () => {
  const readyContract = (): ModelContract => ({
    list: async () => platformModels,
    current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
    switch: async () => {},
  })
  // 最小假 sdk:唯一的发送端点 session.promptAsync 可控(挂起/失败)。
  const fakeSdk = (prompt: (args: Record<string, unknown>) => Promise<unknown>) =>
    ({
      command: { list: async () => ({ data: [] }) },
      session: { promptAsync: prompt, abort: async () => ({}) },
      v2: {
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { data: { id: sessionID, agent: undefined } },
          }),
          prompt: async () => ({ data: {} }),
          switchAgent: async () => ({}),
        },
      },
    }) as never
  const draftMount = (sdk: unknown, onDraftCapture: (text: string) => void) =>
    mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects: { ...projects, sdk: () => sdk as never } satisfies AlphaProjectsApi,
        directory: () => "/A",
        sessionID: () => "A",
        command,
        modelContract: readyContract(),
        onDraftCapture,
      }),
    )
  const typeInto = (host: HTMLElement, value: string) => {
    const el = host.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")!
    el.value = value
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }))
    return el
  }
  const enter = (el: HTMLTextAreaElement) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  const sendDisabled = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".a-comp-send")!.disabled

  test("输入→发送挂起(in-flight)→卸载:跳过在途文本(不入 stash,不复活/不重发)", async () => {
    installApi()
    let release: (v: unknown) => void = () => {}
    const captured: string[] = []
    const mounted = draftMount(fakeSdk(() => new Promise((res) => (release = res))), (text) => captured.push(text))
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    const el = typeInto(mounted.host, "in-flight message")
    await waitFor(() => expect(sendDisabled(mounted.host)).toBe(false))
    enter(el) // 发起发送 → sending=true,session.promptAsync 挂起
    await waitFor(() => expect(sendDisabled(mounted.host)).toBe(true))
    mounted.dispose() // 在途中卸载(切走会话)
    expect(captured).toEqual([]) // 在途文本未被当草稿捕获 → 翻回不复活、不重发
    release({ data: { id: "msg" } })
  })

  test("发 A 在途→改成新草稿 B→卸载:B 照常捕获(在途编辑不丢)", async () => {
    installApi()
    let release: (v: unknown) => void = () => {}
    const captured: string[] = []
    const mounted = draftMount(fakeSdk(() => new Promise((res) => (release = res))), (text) => captured.push(text))
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    const el = typeInto(mounted.host, "message A")
    await waitFor(() => expect(sendDisabled(mounted.host)).toBe(false))
    enter(el) // 发 A → sending=true,submittedText="message A"
    await waitFor(() => expect(sendDisabled(mounted.host)).toBe(true))
    typeInto(mounted.host, "draft B") // 在途改成新草稿(textarea 仍可编辑)
    await flush()
    mounted.dispose() // text()="draft B" ≠ submittedText → 照常捕获
    expect(captured).toEqual(["draft B"]) // 在途编辑的新草稿不丢
    release({ data: { id: "msg" } })
  })

  test("发送失败→卸载:文本仍可恢复(sending 落回 false,capture 拿到失败保留文本)", async () => {
    installApi()
    const captured: string[] = []
    const mounted = draftMount(fakeSdk(async () => ({ error: { status: 500 } })), (text) => captured.push(text))
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    const el = typeInto(mounted.host, "will fail")
    await waitFor(() => expect(sendDisabled(mounted.host)).toBe(false))
    enter(el) // promptAsync 返回 { error } → 失败,文本保留(既有失败路径)
    await waitFor(() => expect(el.value).toBe("will fail"))
    await waitFor(() => expect(sendDisabled(mounted.host)).toBe(false)) // sending 落回 false
    mounted.dispose() // 失败后卸载 → capture 拿到保留文本
    expect(captured).toEqual(["will fail"])
  })
})

/* ── REQ-109 #595:BYOK 可选择性与登录/平台/引擎清单解耦(真 DOM 闸门)────────────────────────
   两个独立谓词(契约 docs/contracts/byok-availability.md):
     「BYOK 本地可选择」= 本地目录存在模型 + 本地 KEY 已配置;
     「当前可执行」     = 引擎已恢复。
   下面四条断言的是**行为**(真实按钮的 disabled / 真实点击的后果 / 真实发送门),不是镜像逻辑。 */
describe("REQ-109 #595 BYOK 可选择性(真 DOM)", () => {
  const deepseekEngineId = byokEngineId("deepseek")
  const deepseekModels = catalog.byokProviders.find((provider) => provider.id === "deepseek")!.models
  const byokRows = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLButtonElement>(".a-mpp-row")].filter(
      (row) => row.dataset.group === "byok" && row.textContent?.includes(deepseekModels[0]),
    )
  const openPicker = () =>
    [...document.body.querySelectorAll<HTMLElement>('[data-alpha-picker-owner="alpha.composer-model"]')][0]

  test("退出条件 1/3:未登录 + 引擎清单缺 `<id>-byok` → BYOK 行可见可选,且不显示「正在同步」", async () => {
    resetComposerModelProjection()
    installApi({ auth: async () => loggedOut })
    const picked: ComposerModel[] = []
    let pickedClosed = 0
    // 引擎清单只有平台模型 —— 一个 `deepseek-byok` 条目都没有。
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async (model) => {
          picked.push(model)
        },
        onPicked: () => {
          pickedClosed++
        },
      }),
    )

    await waitFor(() => expect(byokRows(mounted.host)).toHaveLength(1))
    const row = byokRows(mounted.host)[0]
    expect(row.disabled).toBe(false)
    expect(row.classList.contains("locked")).toBe(false)
    expect(row.textContent).not.toContain(zh["alpha.model.syncing"])
    expect(row.textContent).not.toContain(zh["alpha.model.unavailable"])
    click(row)
    await waitFor(() => expect(picked).toHaveLength(1))
    expect(picked[0]).toMatchObject({ providerID: deepseekEngineId, id: deepseekModels[0] })
    expect(pickedClosed).toBe(1)
    mounted.dispose()
  })

  test("退出条件 2:引擎恢复中 + modelChainReady=false,home 的 BYOK 行仍可点且行内是「引擎重启中」", async () => {
    resetComposerModelProjection()
    installApi()
    const picked: ComposerModel[] = []
    let pickedClosed = 0
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract: {
          list: async () => {
            throw new Error("engine restarting")
          },
          current: async () => undefined,
          switch: async () => {},
        },
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async (model) => {
          picked.push(model)
        },
        onPicked: () => {
          pickedClosed++
        },
        modelChainReady: () => false,
      }),
    )

    await waitFor(() => {
      expect(mounted.host.textContent).toContain(zh["alpha.model.engineConnecting"])
      expect(byokRows(mounted.host)).toHaveLength(1)
    })
    const row = byokRows(mounted.host)[0]
    expect(row.textContent).toContain(zh["alpha.model.byokEngineRestarting"])
    expect(row.textContent).not.toContain(zh["alpha.model.syncing"])
    expect(row.disabled).toBe(false)
    click(row)
    await waitFor(() => expect(picked).toHaveLength(1))
    expect(picked[0]).toMatchObject({ providerID: deepseekEngineId, id: deepseekModels[0] })
    expect(pickedClosed).toBe(1)
    // 恢复中 readyListEpoch 为 null —— 不得因此卡在切换动画里(旧 epoch 判据会漏掉复位)。
    expect(byokRows(mounted.host)[0].classList.contains("is-switching")).toBe(false)
    mounted.dispose()
  })

  test("退出条件 6:session 模式恢复中点 BYOK 行 —— 展示但不可点,零 switchModel,不呈现为已切换", async () => {
    installApi()
    const switches: Array<{ sessionID: string; model: ModelRef }> = []
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects,
        directory: () => "/workspace",
        sessionID: () => "S1",
        command,
        modelContract: {
          list: async () => {
            throw new Error("engine restarting")
          },
          current: async () => undefined,
          switch: async (sessionID, model) => {
            switches.push({ sessionID, model })
          },
        },
      }),
    )

    await waitFor(() => expect(composerModelProjection()).toEqual({ status: "ready", sessionID: "S1" }))
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(byokRows(openPicker())).toHaveLength(1))
    const row = byokRows(openPicker())[0]
    // 展示:本地 BYOK 行照常在;可点:不行 —— 会话换模型必须落到服务端 switchModel。
    expect(row.disabled).toBe(true)
    // #595 Minor:文案与视觉都不得自相矛盾 —— session 不说「可先选择」,且不可点即置灰。
    expect(row.textContent).toContain(zh["alpha.model.byokEngineRestartingSession"])
    expect(row.textContent).not.toContain(zh["alpha.model.byokEngineRestarting"])
    expect(row.classList.contains("locked")).toBe(true)
    // 绕过原生 disabled 抑制,直接证伪「点了就当已切换」。
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await flush()
    expect(switches).toEqual([])
    expect(composerModel()).toBeNull()
    expect(row.getAttribute("aria-current")).toBeNull()
    expect(row.classList.contains("selected")).toBe(false)
    mounted.dispose()
  })

  test("home 恢复中选中本地 BYOK 只是内存写:发送门仍关闭(canSend 不做 BYOK 豁免)", async () => {
    installApi()
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command,
        modelContract: {
          list: async () => {
            throw new Error("engine restarting")
          },
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.syncing"]))
    expect(send.disabled).toBe(true)
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(byokRows(openPicker())).toHaveLength(1))
    const row = byokRows(openPicker())[0]
    expect(row.disabled).toBe(false)
    click(row)

    // 选择成功落进内存(chip 标签随之更新),但发送仍等引擎 —— 视觉不造假。
    await waitFor(() => expect(composerModel()?.providerID).toBe(deepseekEngineId))
    expect(composerModel()?.id).toBe(deepseekModels[0])
    expect(mounted.host.querySelector('[data-kind="model"] .a-chip-label')?.textContent).toContain(
      composerModel()!.name,
    )
    expect(send.disabled).toBe(true)
    mounted.dispose()
  })

  test("home 恢复中的 BYOK 选择不 supersede 在跑的模型链:引擎回来后自动 ready,选择保留", async () => {
    installApi()
    const byokModel = info(deepseekEngineId, deepseekModels[0])
    let listCalls = 0
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command,
        modelContract: {
          // 前两次失败(引擎重启),之后成功 —— 自动恢复只能靠还活着的重试循环。
          list: async () => {
            if (++listCalls <= 2) throw new Error("engine restarting")
            return [...platformModels, byokModel]
          },
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.syncing"]))
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(byokRows(openPicker())).toHaveLength(1))
    click(byokRows(openPicker())[0])
    await waitFor(() => expect(composerModel()?.providerID).toBe(deepseekEngineId))
    expect(send.disabled).toBe(true)

    // 选择只是内存写,不得把还在退避重试的链判 stale —— 否则自动恢复永久闩死(#594 同类)。
    await new Promise((resolve) => setTimeout(resolve, 3500))
    // 对照:引擎恢复后的清单**含**该节点 ⇒ 发送门照常打开,谓词 2 不得过度收紧。
    expect(send.disabled).toBe(false)
    expect(mounted.host.textContent).not.toContain(zh["alpha.composer.modelNotLoadedDetail"])
    expect(composerModel()?.providerID).toBe(deepseekEngineId)
    expect(composerModelSuspended()).toBeNull()
    mounted.dispose()
  })

  test("引擎恢复后清单缺 `<id>-byok`:已选的本地 BYOK 不得被父层 reconciliation 撤销", async () => {
    installApi()
    let listCalls = 0
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command,
        modelContract: {
          // 先失败(recovering),之后返回**非空**清单但**缺** deepseek-byok ——
          // 旧行为在此判 provider-gone 并 suspend,等于让 model.list 当最终裁判。
          list: async () => {
            if (++listCalls <= 1) throw new Error("engine restarting")
            return platformModels
          },
          current: async () => undefined,
          switch: async () => {},
        },
        initialText: "hello",
      }),
    )

    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.model.syncing"]))
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(byokRows(openPicker())).toHaveLength(1))
    click(byokRows(openPicker())[0])
    await waitFor(() => expect(composerModel()?.providerID).toBe(deepseekEngineId))

    // 退避 1s 后第二次 list 成功 → 链 ready → 两轮 resolveSelection reconciliation。
    await new Promise((resolve) => setTimeout(resolve, 1600))
    expect(listCalls).toBeGreaterThan(1)
    // ① 谓词 1:选择保留,不被引擎清单撤销。
    expect(composerModelSuspended()).toBeNull()
    expect(composerModel()?.providerID).toBe(deepseekEngineId)
    expect(composerModel()?.id).toBe(deepseekModels[0])
    // ② 谓词 2:引擎里没有这个节点 ⇒ 发送门必须关闭(否则会提交一个引擎不存在的 Model Ref)。
    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    expect(send.disabled).toBe(true)
    // ③ 如实告知:按钮已禁用,toast 点不出来,必须有常驻说明 + 重试入口。
    expect(mounted.host.textContent).toContain(zh["alpha.composer.modelNotLoadedDetail"])
    expect(mounted.host.textContent).toContain(composerModel()!.name)
    mounted.dispose()
  })

  test("链已 ready 而账户仍在重试时选 BYOK:不得杀掉账户恢复 owner", async () => {
    const start = Date.now()
    let accountReads = 0
    installApi({
      account: async () => {
        accountReads++
        return Date.now() - start < 1500 ? { error: "network" } : summary
      },
    })
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command,
        // 引擎清单只有平台模型 ⇒ hasConfiguredByok 为 false ⇒ 无选择时发送门要求 platformPermission
        // 已 ready。这就是 platformPermission 的可观测探针。
        modelContract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    // 前置事实:模型链已 ready(BYOK 行可点),而账户链仍在恢复(发送门仍关)。
    await waitFor(() => expect(byokRows(openPicker())[0]?.disabled).toBe(false))
    expect(send.disabled).toBe(true)
    expect(composerModel()).toBeNull()
    click(byokRows(openPicker())[0])
    await waitFor(() => expect(composerModel()?.providerID).toBe(deepseekEngineId))
    // pick 成功即关弹层 ⇒ 此后只有 composer 的账户链会继续读 summary。
    const readsAfterPick = accountReads

    await new Promise((resolve) => setTimeout(resolve, 4000))
    // ① 账户链没被这次选择判 stale:仍在继续读。
    expect(accountReads).toBeGreaterThan(readsAfterPick)
    // ② platformPermission 真的回到 ready —— 否则父层会拒绝平台提交,选择不会改变。
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    const platformRow = () =>
      [...openPicker().querySelectorAll<HTMLButtonElement>('.a-mpp-row[data-group="platform"]')][0]
    await waitFor(() => expect(platformRow()?.disabled).toBe(false))
    click(platformRow())
    await waitFor(() => expect(composerModel()?.providerID).toBe(catalog.platformProvider.id))
    expect(mounted.host.textContent).not.toContain(zh["alpha.model.switchFailed"])
    mounted.dispose()
  })

  test("引擎成功返回空清单且链仍进 ready:发送门必须照样关闭(不靠「空=未就绪」放行)", async () => {
    installApi()
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command,
        // model.list 成功返回 [] —— 链照样进 ready。「空清单 ⇒ 未就绪」是状态机从未承诺的不变量。
        modelContract: { list: async () => [], current: async () => undefined, switch: async () => {} },
        initialText: "hello",
      }),
    )

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(byokRows(openPicker())[0]?.disabled).toBe(false))
    click(byokRows(openPicker())[0])
    await waitFor(() => expect(composerModel()?.providerID).toBe(deepseekEngineId))

    // 谓词 1:选择照旧保留。谓词 2:引擎什么都没注册 ⇒ 发送门关闭 + 如实告知。
    expect(composerModelSuspended()).toBeNull()
    await waitFor(() => expect(mounted.host.textContent).toContain(zh["alpha.composer.modelNotLoadedDetail"]))
    expect(send.disabled).toBe(true)
    mounted.dispose()
  })

  test("按 Enter 绕不过发送门:零 startChat,并如实告知", async () => {
    installApi()
    let chats = 0
    const toasts = mount(() => createComponent(ToastViewport, {}))
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects: {
          ...projects,
          startChat: async () => {
            chats++
            return undefined
          },
        },
        directory: () => "/workspace",
        command,
        // 非空清单但缺 deepseek-byok —— 主路径。
        modelContract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
        initialText: "hello",
      }),
    )

    click(mounted.host.querySelector('[data-kind="model"] > button'))
    await waitFor(() => expect(byokRows(openPicker())[0]?.disabled).toBe(false))
    click(byokRows(openPicker())[0])
    await waitFor(() => expect(composerModel()?.providerID).toBe(deepseekEngineId))

    const send = mounted.host.querySelector<HTMLButtonElement>('button[title="发送"]')!
    expect(send.disabled).toBe(true)
    // Enter 直调 submit,是唯一能绕过 disabled 按钮的真实入口 —— 它必须过同一条判据。
    const textarea = mounted.host.querySelector<HTMLTextAreaElement>("textarea")!
    expect(textarea.value).toBe("hello")
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))
    await flush()
    await flush()

    expect(chats).toBe(0)
    expect(document.body.textContent).toContain(zh["alpha.composer.modelNotLoadedDetail"])
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("hello")
    mounted.dispose()
    toasts.dispose()
  })
})

// C21 R3 F9:roving-focus.test.ts 的 `CROSS_FILE_COMBOBOX_EXCEPTIONS` 由这一条兑现。
// 例外放行 composer-autocomplete.tsx 的 listbox,理由是它走 combobox 的 aria-activedescendant,
// 而属性挂在 alpha-composer.tsx 那一侧 —— 关联跨文件,静态文本无从自证。
// 兑现证据必须落在**出货代码**上:本例挂载的是生产 `AlphaComposerRuntime`(与 app 同一条组件树),
// 读的是生产 textarea `.a-comp-input` 上的属性。删掉生产的 `aria-activedescendant` 绑定 → 本例立刻红。
// 用测试自建的 textarea 复刻一份绑定不算证据:那种 harness 在生产绑定被删后照样绿。
describe("AlphaComposer 生产 combobox 无障碍绑定", () => {
  const slashCommand = {
    options: [
      { id: "alpha.test.one", title: "One", slash: "one" },
      { id: "alpha.test.two", title: "Two", slash: "two" },
    ],
    trigger: () => {},
  } as unknown as AlphaComposerRuntimeProps["command"]

  /** 活动 id 必须**非空**,且在全 DOM 里**唯一** —— IDREF 有歧义就无法证明它指认了哪一个 option。 */
  function resolveActive(textarea: HTMLTextAreaElement) {
    const id = textarea.getAttribute("aria-activedescendant")
    expect(typeof id === "string" && id.length > 0).toBe(true)
    const matches = [...document.querySelectorAll<HTMLElement>("[id]")].filter((element) => element.id === id)
    expect(matches).toHaveLength(1)
    return { id: id!, element: matches[0]! }
  }

  function typeInto(textarea: HTMLTextAreaElement, value: string) {
    textarea.value = value
    textarea.setSelectionRange(value.length, value.length)
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }

  test("生产 textarea 的 aria-activedescendant 无歧义指向 Menu 内的活动 option,并随 ↑↓ 移动", async () => {
    installApi()
    const mounted = mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "home",
        projects,
        directory: () => "/workspace",
        command: slashCommand,
        modelContract: { list: async () => platformModels, current: async () => undefined, switch: async () => {} },
      }),
    )
    const textarea = mounted.host.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")!
    expect(textarea.getAttribute("role")).toBe("combobox")
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list")

    typeInto(textarea, "/")
    await waitFor(() => expect(textarea.getAttribute("aria-expanded")).toBe("true"))

    const listbox = document.getElementById(textarea.getAttribute("aria-controls")!)!
    expect(listbox.getAttribute("role")).toBe("listbox")
    const initial = resolveActive(textarea)
    expect({
      role: initial.element.getAttribute("role"),
      selected: initial.element.getAttribute("aria-selected"),
      insideListbox: listbox.contains(initial.element),
    }).toEqual({ role: "option", selected: "true", insideListbox: true })

    const two = [...listbox.querySelectorAll<HTMLElement>("[role='option']")].find((option) =>
      option.textContent?.includes("/two"),
    )!
    const twoId = two.id

    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }))
    await flush()
    const down = resolveActive(textarea)
    expect(down.id).not.toBe(initial.id)
    expect({
      role: down.element.getAttribute("role"),
      selected: down.element.getAttribute("aria-selected"),
      insideListbox: listbox.contains(down.element),
    }).toEqual({ role: "option", selected: "true", insideListbox: true })

    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }))
    await flush()
    expect(resolveActive(textarea).id).toBe(initial.id)

    typeInto(textarea, "/two")
    await waitFor(() => expect(textarea.getAttribute("aria-activedescendant")).toBe(twoId))
    expect(document.getElementById(twoId)?.textContent).toContain("/two")

    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }))
    await flush()
    expect(textarea.getAttribute("aria-expanded")).toBe("false")
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false)
    mounted.dispose()
  })
})
// ── REQ-127 #679:选择器上那两个数字是平台的真值,不是本地编的 ────────────────────────────
// 用户能看到的变化只在这一票:claude-fable-5 从「标准 ×1」变成「输入 71.4× · 输出 178.6×」。
//
// 判据一律是**白名单**,不是「不含 × / 不含档位词」那种黑名单。R1 审计用一个 `1x`
// (拉丁字母 x,不是 `×`)当探针证明过:黑名单对新成员默认放行 —— 一个伪造倍率可以同时出现在
// 可见文本与读屏标签里,而全部门保持绿。所以下面锁的是**完整值**:行尾状态元素的有序完整列表、
// 整行可见文本的完整拼接、`aria-label` 的完整值。多一个元素、多一个字符都不等。
describe("#679 生产 picker 呈现平台双倍数 / 不可用两态", () => {
  const BASIS = "deepseek-v4-flash"
  /** 平台真实倍数(与 producer fixture 一致):最长串出现在 claude-fable-5 上。 */
  const REMOTE_PRICING: Record<string, { input: number; output: number }> = {
    "deepseek-v4-flash": { input: 1, output: 1 },
    "deepseek-v4-pro": { input: 3.1, output: 3.1 },
    "glm-5.2": { input: 5.4, output: 8.5 },
    "glm-5-turbo": { input: 8.6, output: 14.3 },
    "qwen3.7-max": { input: 10.5, output: 15.8 },
    "qwen3.7-plus": { input: 2.3, output: 4.6 },
    "gpt-5.4-mini": { input: 5.4, output: 16.1 },
    "gpt-5.4-nano": { input: 1.4, output: 4.5 },
    "claude-haiku-4.5": { input: 7.1, output: 17.9 },
    "claude-sonnet-5": { input: 21.4, output: 53.6 },
    "claude-fable-5": { input: 71.4, output: 178.6 },
    "claude-opus-4.8": { input: 35.7, output: 89.3 },
  }
  /** 有效 V2/LKG 的目录视图(= getEffectiveCatalog 在 live 时返回的形状)。 */
  const pricedCatalog = {
    ...catalog,
    pricingBasisModelId: BASIS,
    platformModels: catalog.platformModels.map((model) => ({
      ...model,
      ...(REMOTE_PRICING[model.id] ? { pricing: REMOTE_PRICING[model.id] } : {}),
    })),
  } as EffectiveCatalog
  /** 基准名从目录里取 —— 平台换基准,UI 跟着变才是诚实的,所以断言也不许硬编码。 */
  const basisName = pricedCatalog.platformModels.find((model) => model.id === BASIS)!.name
  /** 已配 KEY 的 BYOK 供应商(fixture 里只有 deepseek)与它的模型 —— BYOK 行的期望值从目录推。 */
  const keyedByok = catalog.byokProviders.find((provider) => provider.id === "deepseek")!
  const unkeyedByok = catalog.byokProviders.filter((provider) => provider.id !== "deepseek")
  const CUSTOM = { providerID: "my-endpoint", id: "real-custom-model", name: "Real Custom Model" }

  const pair = (id: string, dict: Record<string, string>) => {
    const p = REMOTE_PRICING[id]!
    return dict["alpha.model.pricingPair"]!
      .replace("{{input}}", p.input.toFixed(1))
      .replace("{{output}}", p.output.toFixed(1))
  }

  const rows = (group?: "platform" | "byok") =>
    [...document.body.querySelectorAll<HTMLButtonElement>(group ? `.a-mpp-row[data-group="${group}"]` : ".a-mpp-row")]
  const rowFor = (id: string, group: "platform" | "byok" = "platform") =>
    rows(group).find((row) => row.querySelector(".a-mpp-name small")?.textContent?.startsWith(id))!

  /** 行尾状态元素的**有序完整列表**。生产里它们由同一个 statusParts() 渲染成 .a-pop-desc。 */
  const descTexts = (row: HTMLButtonElement) =>
    [...row.querySelectorAll<HTMLElement>(".a-pop-desc")].map((el) => el.textContent ?? "")

  const ariaFor = (dict: Record<string, string>, model: string, provider: string, parts: string[]) =>
    parts.length
      ? dict["alpha.model.rowLabel"]!
          .replace("{{model}}", model)
          .replace("{{provider}}", provider)
          .replace("{{status}}", parts.join(" · "))
      : dict["alpha.model.rowLabelNoStatus"]!.replace("{{model}}", model).replace("{{provider}}", provider)

  /**
   * 一行的三处**同时**锁死为完整值:
   *   ① 行尾状态元素的有序完整列表(多一个 span 就不等);
   *   ② 整行可见文本的完整拼接(状态被塞进别的元素、或塞进名字里,同样不等);
   *   ③ aria-label 的完整值(看得见的和听得见的必须逐字符同源)。
   * 这就是"咽喉":对没见过的新成员默认拒绝,而不是等我们想起来往正则里加一条。
   */
  const expectRowExactly = (
    row: HTMLButtonElement,
    dict: Record<string, string>,
    spec: { letter: string; name: string; id: string; providerName: string; group: "platform" | "byok"; parts: string[] },
  ) => {
    const where = `${spec.group}/${spec.id}`
    expect(descTexts(row), `${where} 行尾状态元素列表`).toEqual(spec.parts)
    const suffix = spec.group === "byok" ? ` · ${spec.providerName}` : ""
    expect(row.textContent, `${where} 整行可见文本`).toBe(
      `${spec.letter}${spec.name}${spec.id}${suffix}${spec.parts.join("")}`,
    )
    expect(row.getAttribute("aria-label"), `${where} aria-label`).toBe(
      ariaFor(dict, spec.name, spec.providerName, spec.parts),
    )
  }

  /** 平台行的完整期望 —— parts 由调用方给定(available / unavailable / 带 reason 三种形态)。 */
  const expectPlatformRows = (dict: Record<string, string>, partsOf: (id: string) => string[]) => {
    const platform = rows("platform")
    expect(platform.length, "平台行数").toBe(pricedCatalog.platformModels.length)
    for (const model of pricedCatalog.platformModels) {
      expectRowExactly(rowFor(model.id), dict, {
        letter: "α",
        name: model.name,
        id: model.id,
        providerName: pricedCatalog.platformProvider.name,
        group: "platform",
        parts: partsOf(model.id),
      })
    }
  }

  /** BYOK 与自定义节点:代理计价与它们无关 —— 行尾要么空,要么只有那条运行态,**没有第三种可能**。 */
  const expectNonPlatformRowsCarryNoPricing = (dict: Record<string, string>) => {
    for (const id of keyedByok.models) {
      const display = catalog.platformModels.find((model) => model.id === id)
      expectRowExactly(rowFor(id, "byok"), dict, {
        letter: keyedByok.pico.letter,
        name: display?.name ?? id,
        id,
        providerName: keyedByok.name,
        group: "byok",
        parts: [],
      })
    }
    for (const provider of unkeyedByok) {
      // 未配 KEY 的供应商只有一行占位,展示名是**供应商名**(model-picker-core 的 needs-key 分支),
      // 不是模型名 —— 期望值照生产写,不照直觉写。
      expectRowExactly(rowFor(provider.models[0]!, "byok"), dict, {
        letter: provider.pico.letter,
        name: provider.name,
        id: provider.models[0]!,
        providerName: provider.name,
        group: "byok",
        parts: [dict["alpha.model.keyMissing"]!],
      })
    }
    expectRowExactly(rowFor(CUSTOM.id, "byok"), dict, {
      letter: CUSTOM.providerID.slice(0, 1).toUpperCase(),
      name: CUSTOM.name,
      id: CUSTOM.id,
      providerName: CUSTOM.providerID,
      group: "byok",
      parts: [],
    })
  }

  const engineModels = () => [
    ...platformModels,
    ...keyedByok.models.map((id) => info(byokEngineId(keyedByok.id), id)),
    info(CUSTOM.providerID, CUSTOM.id, CUSTOM.name),
  ]

  const openPicker = async (fixture: ApiFixture = {}) => {
    resetComposerModelProjection()
    installApi({
      catalog: async () => pricedCatalog,
      keyStatus: async () => ({ ...keys, [CUSTOM.providerID]: { configured: true, source: "config" } }),
      ...fixture,
    })
    const mounted = mount(() =>
      createComponent(ModelPickPop, {
        contract: { list: async () => engineModels(), current: async () => undefined, switch: async () => {} },
        directory: () => "/workspace",
        selected: () => null,
        onSelect: async () => {},
        onPicked: () => {},
      }),
    )
    // 等待判据必须与 locale 无关 —— 用文案等会在英文用例里永远等不到,而那是**测试的**缺陷。
    await waitFor(() => {
      expect(rows("platform").length).toBe(pricedCatalog.platformModels.length)
      expect(rowFor(CUSTOM.id, "byok")).toBeInstanceOf(HTMLButtonElement)
    })
    return mounted
  }

  test("有可信 pair:每个平台行的可见文本与 aria-label 都恰好是那一对倍数,一个字符不多", async () => {
    const mounted = await openPicker()
    expectPlatformRows(zh, (id) => [pair(id, zh)])
    // 最长串单独点名一次,免得整表断言绿了却没人看见它长什么样。
    expect(descTexts(rowFor("claude-fable-5"))).toEqual(["输入 71.4× · 输出 178.6×"])
    // 基准说明:完整值,基准名取自目录。
    const basis = document.body.querySelector(".a-mpp-basis")!
    expect(basis.textContent).toBe(zh["alpha.model.pricingBasisNote"].replace("{{model}}", basisName))
    // BYOK / 自定义节点:行尾没有第二个状态元素的位置。
    expectNonPlatformRowsCarryNoPricing(zh)
    mounted.dispose()
  })

  test("没有有效 V2/LKG:每个平台行恰好只有「计价信息暂不可用」,基准说明整条不渲染", async () => {
    // 静态目录(内置 snapshot):basis 为 null、逐行无 pricing —— 冷启动常态。
    const mounted = await openPicker({ catalog: async () => catalog })
    expectPlatformRows(zh, () => [zh["alpha.model.pricingUnavailable"]])
    expect(document.body.querySelector(".a-mpp-basis")).toBeNull()
    expectNonPlatformRowsCarryNoPricing(zh)
    mounted.dispose()
  })

  test("平台行同时有运行态时,行尾恰好是 [运行态, 计价二态] 两段,有序且不多不少", async () => {
    // 余额为零 ⇒ 每个平台行都有 reason。旧实现是 `reason ?? 档位`,于是价格整个消失。
    const mounted = await openPicker({
      account: async () => ({ ...summary, balanceFen: 0, plan: { ...summary.plan!, status: "expired" } }),
    })
    await waitFor(() => expect(rowFor("claude-fable-5").textContent).toContain(zh["alpha.model.needsCredit"]))
    expectPlatformRows(zh, (id) => [zh["alpha.model.needsCredit"], pair(id, zh)])
    expectNonPlatformRowsCarryNoPricing(zh)
    mounted.dispose()
  })

  test("英文 locale 下三处完整值全部跟着换,数字一位不差", async () => {
    setLocale("en")
    try {
      const mounted = await openPicker()
      expectPlatformRows(enDict, (id) => [pair(id, enDict)])
      expect(descTexts(rowFor("claude-fable-5"))).toEqual(["In 71.4× · Out 178.6×"])
      expect(document.body.querySelector(".a-mpp-basis")!.textContent).toBe(
        enDict["alpha.model.pricingBasisNote"].replace("{{model}}", basisName),
      )
      expectNonPlatformRowsCarryNoPricing(enDict)
      mounted.dispose()
    } finally {
      setLocale("zh")
    }
  })

  // ── 默认解析:必须在**真实 AlphaComposer 链路**上证明,不能只测 helper ────────────────────
  // R1 审计的第二个可达绕过:把 alpha-composer.tsx 的 ctx 改成只把带 pricing 的模型交给 resolver。
  // 那个文件不在源码棘轮的扫描清单里,helper 层单测也看不到 —— 而**真实的静态目录本来就没有
  // pricing**(首次同步前 / LKG 失效后的常态),于是价格数据缺失时平台默认会静默消失。
  // 下表第 1、2 行就是那个状态;第 3 行是控制组(证明这套 barrier 真能观察到解析结果),
  // 有它在,第 5 行的 null 才不是空绿。
  describe("#679 defaultPlatformModel 经真实 AlphaComposer wiring 生效", () => {
    const reversed = (source: EffectiveCatalog) =>
      ({ ...source, platformModels: [...source.platformModels].reverse() }) as EffectiveCatalog

    const settle = async (fixture: EffectiveCatalog) => {
      setComposerModel(null)
      resetComposerModelProjection()
      let listReads = 0
      installApi({ catalog: async () => fixture })
      const mounted = mount(() =>
        createComponent(AlphaComposerRuntime, {
          mode: "home",
          projects,
          directory: () => "/workspace",
          command,
          modelContract: {
            list: async () => {
              listReads++
              return platformModels
            },
            current: async () => undefined,
            switch: async () => {},
          },
        }),
      )
      await waitFor(() => expect(listReads).toBeGreaterThan(0))
      for (let attempt = 0; attempt < 20; attempt++) await flush()
      return mounted
    }

    test.each([
      ["静态目录:逐行都没有 pricing(首次同步前 / LKG 失效后的常态)", () => catalog, "deepseek-v4-flash"],
      ["静态目录 + 目录顺序反过来", () => reversed(catalog), "deepseek-v4-flash"],
      ["控制组:有 pricing 的目录,顺序原样", () => pricedCatalog, "deepseek-v4-flash"],
      [
        "声明的默认就是全场最贵那个(价格不参与挑选,贵的照样能当默认)",
        () => ({ ...pricedCatalog, defaultPlatformModel: "claude-fable-5" }) as EffectiveCatalog,
        "claude-fable-5",
      ],
      [
        "声明的 id 不在生效目录中(被 edition 白名单筛掉)→ 不回落到任何平台模型",
        () => ({ ...pricedCatalog, defaultPlatformModel: "model-that-edition-filtered-out" }) as EffectiveCatalog,
        null,
      ],
    ] as Array<[string, () => EffectiveCatalog, string | null]>)("%s", async (_name, fixture, expected) => {
      const mounted = await settle(fixture())
      if (expected === null) expect(composerModel()).toBeNull()
      else {
        expect(composerModel()?.id).toBe(expected)
        expect(composerModel()?.providerID).toBe(catalog.platformProvider.id)
      }
      mounted.dispose()
    })
  })
})
