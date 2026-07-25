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
  observeSessionAgent,
  resetComposerModelProjection,
  resetPushedAgents,
  setComposerAgent,
  setComposerModel,
} = await import(
  "../src/renderer/alpha-ui/composer-state"
)
const { byokEngineId } = await import("../src/shared/alpha-model-types")

const catalog = {
  ...(await Bun.file(new URL("../src/main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
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
  setProviderLifecycleDeps()
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  if (savedAlphaGlobalDir === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = savedAlphaGlobalDir
  if (savedOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = savedOpencodeConfigDir
  document.body.replaceChildren()
  setComposerModel(null)
  setComposerAgent(null)
  resetPushedAgents()
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
})

describe("AlphaComposer v2 durable send + abort honesty (REQ-125 C7 audit round 2)", () => {
  const readyContract = (): ModelContract => ({
    list: async () => platformModels,
    current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
    switch: async () => {},
  })

  function fakeSessionSdk(overrides?: { abort?: () => Promise<unknown>; promptError?: () => boolean }) {
    const prompts: Array<Record<string, unknown>> = []
    const promptAsyncCalls: unknown[] = []
    const agentSwitches: Array<{ sessionID: string; agent: string }> = []
    const abortCalls: unknown[] = []
    // 引擎侧会话档回声:switchAgent 落档后,typed session info 会读到它(sessionAgent 基准)。
    let engineAgent: string | undefined
    const client = {
      command: { list: async () => ({ data: [] }) },
      session: {
        promptAsync: async (args: unknown) => {
          promptAsyncCalls.push(args)
          return {}
        },
        abort: async (args: unknown) => {
          abortCalls.push(args)
          return overrides?.abort ? overrides.abort() : {}
        },
      },
      v2: {
        session: {
          get: async (args: { sessionID: string }) => ({
            data: { data: { id: args.sessionID, agent: engineAgent } },
          }),
          prompt: async (args: Record<string, unknown>) => {
            prompts.push(args)
            if (overrides?.promptError?.()) return { error: { status: 500 } }
            return { data: { id: "msg_admitted", admittedSeq: prompts.length, delivery: args.delivery ?? "steer" } }
          },
          switchAgent: async (args: { sessionID: string; agent: string }) => {
            agentSwitches.push(args)
            engineAgent = args.agent
            return {}
          },
        },
      },
    }
    return { client, prompts, promptAsyncCalls, agentSwitches, abortCalls }
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

  test("会话发送走 v2 durable 队列:空闲省略 delivery,运行中 delivery=queue(Enter 同路径),promptAsync 退役", async () => {
    installApi()
    const sdk = fakeSessionSdk()
    const [running, setRunning] = createSignal(false)
    const mounted = sessionMount(sdk, running)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    const textarea = typeText(mounted.host, "跑一下测试")
    await waitFor(() =>
      expect(mounted.host.querySelector<HTMLButtonElement>(".a-comp-send")!.disabled).toBe(false),
    )
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    expect(sdk.prompts[0]).toMatchObject({ sessionID: "A", prompt: { text: "跑一下测试" } })
    expect("delivery" in sdk.prompts[0]!).toBe(false)

    // 运行中:发送键换停止形态,Enter 仍发送且必须走 delivery:"queue"(文案「发送后排队」的真实语义)。
    setRunning(true)
    await waitFor(() => expect(mounted.host.querySelector(".a-comp-stop")).not.toBeNull())
    pressEnter(typeText(mounted.host, "补一个用例"))
    await waitFor(() => expect(sdk.prompts).toHaveLength(2))
    expect(sdk.prompts[1]).toMatchObject({
      sessionID: "A",
      delivery: "queue",
      prompt: { text: "补一个用例" },
    })

    expect(sdk.promptAsyncCalls).toEqual([])
    expect(sdk.agentSwitches).toEqual([]) // 默认档(无 plan/readonly)不动会话 agent
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
})

describe("AlphaComposer 档位协议 (REQ-125 C7 audit round 3)", () => {
  const readyContract = (): ModelContract => ({
    list: async () => platformModels,
    current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
    switch: async () => {},
  })

  function fakeSessionSdk(overrides?: { promptError?: () => boolean }) {
    const prompts: Array<Record<string, unknown>> = []
    const agentSwitches: Array<{ sessionID: string; agent: string }> = []
    let engineAgent: string | undefined
    const client = {
      command: { list: async () => ({ data: [] }) },
      session: {
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
      v2: {
        session: {
          get: async (args: { sessionID: string }) => ({
            data: { data: { id: args.sessionID, agent: engineAgent } },
          }),
          prompt: async (args: Record<string, unknown>) => {
            prompts.push(args)
            if (overrides?.promptError?.()) return { error: { status: 500 } }
            return { data: { id: "msg_admitted", admittedSeq: prompts.length } }
          },
          switchAgent: async (args: { sessionID: string; agent: string }) => {
            agentSwitches.push(args)
            engineAgent = args.agent
            return {}
          },
        },
      },
    }
    return { client, prompts, agentSwitches, sessionAgent: () => engineAgent }
  }

  function agentMount(sdk: ReturnType<typeof fakeSessionSdk>, running: () => boolean) {
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

  test("prompt 提交失败:档位切换立即回滚,会话档不残留(症状①)", async () => {
    installApi()
    let failPrompt = true
    const sdk = fakeSessionSdk({ promptError: () => failPrompt })
    const mounted = agentMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    setComposerAgent("plan")

    const textarea = await waitReady(mounted.host, "按计划来")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    // 先切 plan,提交失败后立即滚回默认档 —— 会话档位与发送前一致。
    await waitFor(() => expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan", "build"]))
    expect(sdk.sessionAgent()).toBe("build")
    // 失败不吞输入:正文保留,可修正重发。
    expect((mounted.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("按计划来")

    // 修复后重发:重新落 plan 档并提交成功。
    failPrompt = false
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(2))
    await waitFor(() => expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan", "build", "plan"]))
    mounted.dispose()
  })

  test("运行中需要改档的发送如实拒绝:零切档零提交,当前 drain 档位不被污染(症状②)", async () => {
    installApi()
    const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
    const sdk = fakeSessionSdk()
    const mounted = agentMount(sdk, () => true)
    const toastHost = mount(() => createComponent(ToastViewport, {}))
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    setComposerAgent("plan")

    const textarea = typeText(mounted.host, "排队执行")
    pressEnter(textarea)
    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.composer.agentQueueBlocked"]))
    expect(sdk.agentSwitches).toEqual([])
    expect(sdk.prompts).toEqual([])

    // 无档位变化的排队发送不受影响:delivery=queue 且依旧零切档。
    setComposerAgent(null)
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    expect(sdk.prompts[0]).toMatchObject({ delivery: "queue" })
    expect(sdk.agentSwitches).toEqual([])
    mounted.dispose()
    toastHost.dispose()
  })

  test("退出 plan 后首次发送把会话档收回默认;账本只回滚自己推送的档(症状③)", async () => {
    installApi()
    const sdk = fakeSessionSdk()
    const mounted = agentMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    setComposerAgent("plan")
    let textarea = await waitReady(mounted.host, "先按计划来")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"])

    // 退出 plan:下一次普通发送先把会话档收回引擎默认,旧档不残留。
    setComposerAgent(null)
    textarea = await waitReady(mounted.host, "普通消息")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(2))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan", "build"])

    // 已在默认档:再次普通发送零切档(幂等,不打扰用户在别处设置的档)。
    textarea = await waitReady(mounted.host, "再来一条")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(3))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan", "build"])
    mounted.dispose()
  })
})

describe("AlphaComposer 档位决策权威读 (REQ-125 C7 audit round 5)", () => {
  const readyContract = (): ModelContract => ({
    list: async () => platformModels,
    current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
    switch: async () => {},
  })

  function fakeAgentSdk() {
    const prompts: Array<Record<string, unknown>> = []
    const agentSwitches: Array<{ sessionID: string; agent: string }> = []
    const pendingGates: Array<(value: unknown) => void> = []
    // engineAgent = 服务端权威档;syncAgent = serverSync 式滞后缓存(生产中不消费 v2 切档
    // 事件、可无限落后)——协议不得消费它,本 fake 供「滞后两拍」对照断言。
    let engineAgent: string | undefined
    let syncAgent: string | undefined
    let gateNext = false
    let failGets = false
    let hangGets = false
    let getCalls = 0
    const client = {
      command: { list: async () => ({ data: [] }) },
      session: { promptAsync: async () => ({}), abort: async () => ({}) },
      v2: {
        session: {
          get: (args: { sessionID: string }) => {
            getCalls++
            // 悬挂模式:永不 settle 且无视 signal —— 复现 SDK 关闭默认超时下的挂死传输。
            if (hangGets) return new Promise(() => {})
            if (failGets) return Promise.resolve({ error: { status: 503 } })
            return Promise.resolve({ data: { data: { id: args.sessionID, agent: engineAgent } } })
          },
          prompt: (args: Record<string, unknown>) => {
            prompts.push(args)
            if (gateNext) {
              gateNext = false
              return new Promise((resolve) => pendingGates.push(resolve))
            }
            return Promise.resolve({ data: { id: "msg_admitted", admittedSeq: prompts.length } })
          },
          switchAgent: async (args: { sessionID: string; agent: string }) => {
            agentSwitches.push(args)
            engineAgent = args.agent
            return {}
          },
        },
      },
    }
    return {
      client,
      prompts,
      agentSwitches,
      engineAgent: () => engineAgent,
      syncAgent: () => syncAgent,
      /** 服务端权威档直接变更(模拟用户在别处改档;滞后缓存刻意不动)。 */
      setEngineAgent: (agent: string | undefined) => {
        engineAgent = agent
      },
      /** 滞后缓存单独推进(永远可以落后服务端任意拍)。 */
      setSyncAgent: (agent: string | undefined) => {
        syncAgent = agent
      },
      setFailGets: (value: boolean) => {
        failGets = value
      },
      setHangGets: (value: boolean) => {
        hangGets = value
      },
      gateNextPrompt: () => {
        gateNext = true
      },
      resolveGatedPrompt: (value: unknown) => {
        pendingGates.shift()?.(value)
      },
      getCalls: () => getCalls,
    }
  }

  function agentMount(
    sdk: ReturnType<typeof fakeAgentSdk>,
    running: () => boolean,
    agentReadTimeoutMs?: number,
  ) {
    const sessionProjects = { ...projects, sdk: () => sdk.client as never } satisfies AlphaProjectsApi
    return mount(() =>
      createComponent(AlphaComposerRuntime, {
        mode: "session",
        projects: sessionProjects,
        directory: () => "/A",
        sessionID: () => "A",
        command,
        modelContract: readyContract(),
        agentReadTimeoutMs,
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

  test("权威读悬挂(永不 settle 且无视 signal):有界超时后如实发送失败,sending 复位可重试(审计 R5)", async () => {
    installApi()
    const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
    const sdk = fakeAgentSdk()
    sdk.setEngineAgent("build")
    const mounted = agentMount(sdk, () => false, 40)
    const toastHost = mount(() => createComponent(ToastViewport, {}))
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    sdk.setHangGets(true)
    const textarea = await waitReady(mounted.host, "发一条")
    pressEnter(textarea)
    // 悬挂 GET 在有界时间内按失败 settle:如实提示发送失败,零提交,正文保留。
    await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.composer.sendFailed"]))
    expect(sdk.prompts).toHaveLength(0)
    expect((mounted.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("发一条")
    // sending 复位:发送键回到可用态(不锁死,无需重建页面)。
    await waitFor(() => expect(mounted.host.querySelector<HTMLButtonElement>(".a-comp-send")!.disabled).toBe(false))

    // 传输恢复后同一输入可直接重试成功。
    sdk.setHangGets(false)
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    mounted.dispose()
    toastHost.dispose()
  })

  test("CAS 弃权:sync 缓存滞后两拍下,失败回滚决策仍以权威读为准(用户并发 review 不被覆盖)", async () => {
    installApi()
    const sdk = fakeAgentSdk()
    sdk.setEngineAgent("build")
    // 滞后缓存停在两拍前的状态,协议不得消费它。
    sdk.setSyncAgent(undefined)
    const mounted = agentMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    setComposerAgent("plan")

    const textarea = await waitReady(mounted.host, "按计划来")
    sdk.gateNextPrompt()
    pressEnter(textarea)
    await waitFor(() => expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"]))
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))

    // prompt 未决期间用户在别处把服务端档切到 review;滞后缓存依旧停在 undefined(落后两拍)。
    sdk.setEngineAgent("review")
    expect(sdk.syncAgent()).toBeUndefined()
    sdk.resolveGatedPrompt({ error: { status: 500 } })
    await flush()
    await flush()

    // CAS 权威读到第三值 review → 弃权不覆盖;零回滚写入。
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"])
    expect(sdk.engineAgent()).toBe("review")
    expect(sdk.getCalls()).toBeGreaterThanOrEqual(2) // 发送前读 + CAS 核验读,均权威

    // 弃权后随后的普通发送不会把 review 收回默认档。
    setComposerAgent(null)
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(2))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"])
    expect(sdk.engineAgent()).toBe("review")
    mounted.dispose()
  })

  test("CAS 回滚:权威读仍是 composer 刚设的 desired → 回滚生效(sync 缓存全程无关)", async () => {
    installApi()
    const sdk = fakeAgentSdk()
    sdk.setEngineAgent("build")
    const mounted = agentMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    setComposerAgent("plan")

    const textarea = await waitReady(mounted.host, "按计划来")
    sdk.gateNextPrompt()
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    sdk.resolveGatedPrompt({ error: { status: 500 } })
    await flush()
    await flush()

    await waitFor(() => expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan", "build"]))
    expect(sdk.engineAgent()).toBe("build")
    mounted.dispose()
  })

  test("CAS 权威读不可得:不盲写回滚(宁留 desired 也不冒覆盖并发用户改档的险)", async () => {
    installApi()
    const sdk = fakeAgentSdk()
    sdk.setEngineAgent("build")
    const mounted = agentMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    setComposerAgent("plan")

    const textarea = await waitReady(mounted.host, "按计划来")
    sdk.gateNextPrompt()
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    sdk.setFailGets(true) // 失败窗口内权威读也不可得
    sdk.resolveGatedPrompt({ error: { status: 500 } })
    await flush()
    await flush()

    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"]) // 零盲回滚
    sdk.setFailGets(false)
    mounted.dispose()
  })

  test("账本漂移弃权:服务端档被他处改写后,普通发送经权威读弃权、零重置(sync 缓存滞后无影响)", async () => {
    installApi()
    const sdk = fakeAgentSdk()
    sdk.setEngineAgent("build")
    const mounted = agentMount(sdk, () => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    setComposerAgent("plan")
    let textarea = await waitReady(mounted.host, "先按计划来")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(1))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"])

    // 用户在别处把服务端档改为 review;滞后缓存(两拍前)从未反映任何变化。
    sdk.setEngineAgent("review")
    expect(sdk.syncAgent()).toBeUndefined()

    // 退出 plan 的普通发送:权威读到 review ≠ 账本 plan → 弃权,不重置用户选择。
    setComposerAgent(null)
    textarea = await waitReady(mounted.host, "普通消息")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(2))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"])
    expect(sdk.engineAgent()).toBe("review")

    // 弃权后再次普通发送依旧零切档(不重新认领他人设置)。
    textarea = await waitReady(mounted.host, "再来一条")
    pressEnter(textarea)
    await waitFor(() => expect(sdk.prompts).toHaveLength(3))
    expect(sdk.agentSwitches.map((s) => s.agent)).toEqual(["plan"])
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
describe("REQ-125 C558 发送在途与草稿捕获互斥(v2 durable)", () => {
  const readyContract = (): ModelContract => ({
    list: async () => platformModels,
    current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
    switch: async () => {},
  })
  // 最小假 sdk:session.get 供 readSessionAgent(权威档读),session.prompt 可控(挂起/失败)。
  const fakeSdk = (prompt: (args: Record<string, unknown>) => Promise<unknown>) =>
    ({
      command: { list: async () => ({ data: [] }) },
      session: { promptAsync: async () => ({}), abort: async () => ({}) },
      v2: {
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { data: { id: sessionID, agent: undefined } },
          }),
          prompt,
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
    enter(el) // 发起 durable 发送 → sending=true,session.prompt 挂起
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
    enter(el) // durable prompt 返回 error → 失败,文本保留(既有失败路径)
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
    expect(send.disabled).toBe(false)
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
    expect(composerModelSuspended()).toBeNull()
    expect(composerModel()?.providerID).toBe(deepseekEngineId)
    expect(composerModel()?.id).toBe(deepseekModels[0])
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
})
