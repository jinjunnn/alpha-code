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
const { ModelPickPop } = await import("../src/renderer/alpha-ui/alpha-composer-model")
const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
const {
  composerModel,
  composerModelProjection,
  composerModelSuspended,
  resetComposerModelProjection,
  setComposerModel,
} = await import(
  "../src/renderer/alpha-ui/composer-state"
)

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
