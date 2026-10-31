import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import type {
  PermissionRequest as PermissionV1Request,
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { createPermissionDecisionCommand, PermissionDialog } from "./PermissionDialog"
import type { PermissionWatcher } from "./permission-watcher"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { adaptPermissionV1Request } from "../../../../app/src/context/permission-v1-adapter"

type TestRuntime = {
  createComponent: typeof createComponent
  render: typeof render
  createPermissionDecisionCommand: typeof createPermissionDecisionCommand
  PermissionDialog: typeof PermissionDialog
  PermissionWatcher: typeof PermissionWatcher
  resetAuthRecoveryForTests: () => void
}

type PermissionClient = Parameters<typeof PermissionWatcher>[0]["client"]
type PermissionListeners = Parameters<PermissionClient["subscribe"]>[0]

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-permission-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "permission-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "permission-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(runtimeDirectory, "permission-test-runtime.js")).href)) as TestRuntime

// 生产 PermissionWatcher 经 subscribeAuthState 读登录态(范围行写「当前账户 / 未登录」),这里只在 preload 边界放桩;
// 经 defineProperty(configurable) 注入,与 permission-single-surface.test.ts 同法(裸赋值遇只读 window.api 会抛)。
let authState: Promise<{ status: "logged-in" | "logged-out"; mode: "byok" | "platform" }> = new Promise(() => {})
beforeEach(() => {
  document.body.replaceChildren()
  runtime.resetAuthRecoveryForTests()
  authState = new Promise(() => {})
  Object.defineProperty(window, "api", {
    configurable: true,
    writable: true,
    value: { auth: { getState: () => authState, subscribe: () => () => {} } },
  })
})

afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  await flush()
  Reflect.deleteProperty(window, "api")
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

const request: PermissionV2Request = {
  id: "per_ui_1",
  sessionID: "ses_ui_1",
  fingerprint: "a".repeat(64),
  subject: { kind: "agent", id: "build-reviewer" },
  action: "bash",
  resources: ["pwd", "src/**"],
  scope: { kind: "session", sessionID: "ses_ui_1" },
  expiresAt: 1_893_456_000_000,
  save: ["src/**"],
}

function withoutFact(fact: "subject" | "action" | "resources" | "scope" | "expiresAt") {
  const incomplete = { ...request }
  Reflect.deleteProperty(incomplete, fact)
  return incomplete
}

function receipt(
  command: PermissionV2DecisionCommand,
  permissionRequest: PermissionV2Request = request,
): PermissionV2DecisionReceipt {
  return {
    requestID: permissionRequest.id,
    sessionID: permissionRequest.sessionID,
    requestFingerprint: command.requestFingerprint,
    decisionID: command.decisionID,
    decision: command.decision,
    ...(command.decision === "always"
      ? { grantScope: command.grantScope, grantExpiresAt: command.grantExpiresAt }
      : {}),
    committedAt: 1_893_456_000_001,
    resolvedRequestIDs: [permissionRequest.id],
  }
}

type SaveToolPolicy = Parameters<typeof PermissionDialog>[0]["saveToolPolicy"]

function mount(
  onSubmit: (command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>,
  projectID: string | null = "prj_alpha",
  permissionRequest = request,
  options: { composer?: boolean; saveToolPolicy?: SaveToolPolicy; signedIn?: boolean } = {},
) {
  const textarea = document.createElement("textarea")
  if (options.composer !== false) {
    const composer = document.createElement("div")
    composer.dataset.alphaComposer = "session"
    composer.append(textarea)
    document.body.append(composer)
  }

  const host = document.createElement("div")
  document.body.append(host)
  const dispose = runtime.render(
    () =>
      runtime.createComponent(runtime.PermissionDialog, {
        request: permissionRequest,
        projectID: projectID ?? undefined,
        onSubmit,
        saveToolPolicy: options.saveToolPolicy ?? (async () => ({ ok: true as const })),
        signedIn: () => options.signedIn ?? true,
      }),
    host,
  )
  disposers.push(dispose)
  return { textarea, dispose }
}

function mountWatcher(client: PermissionClient) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.PermissionWatcher, {
          sessionID: request.sessionID,
          projectID: "prj_alpha",
          client,
        }),
      host,
    ),
  )
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function decision(value: "once" | "always" | "reject") {
  return document.querySelector<HTMLButtonElement>(`[data-permission-decision="${value}"]`)!
}

function keydown(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

describe("Alpha Permission real Solid render", () => {
  test("renders the public request facts in plain words without contract placeholders", async () => {
    mount(async (command) => receipt(command))
    await flush()

    // #1617:主体助手不上卡;动作写人话,资源原样列出;范围 / 期限写人话,不带会话 ID 等原始值。
    expect(document.querySelector('[data-permission-fact="subject"]')).toBeNull()
    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toBe("运行命令")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("pwd")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("src/**")
    expect(document.querySelector('[data-permission-fact="scope"]')?.textContent).toBe("适用范围本次会话")
    expect(document.querySelector('[data-permission-fact="expiry"]')?.textContent).toContain("2030-01-01 00:00:00 UTC")
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("待契约")
    expect(document.querySelector(".a-permission-grant-note")?.textContent).toContain(zh["alpha.permission.alwaysNote"])
  })

  test("submits once, always, and reject as #433 DecisionCommand values", async () => {
    const commands: PermissionV2DecisionCommand[] = []
    mount(async (command) => {
      commands.push(command)
      return receipt(command)
    })
    await flush()

    decision("once").click()
    await flush()
    decision("always").click()
    await flush()
    decision("reject").click()
    await flush()

    expect(commands.map((command) => command.decision)).toEqual(["once", "always", "reject"])
    commands.forEach((command) => {
      expect(command.requestFingerprint).toBe(request.fingerprint)
      expect(command.decisionID.startsWith("pdec_")).toBeTrue()
    })
    expect(commands[0]).not.toHaveProperty("grantScope")
    expect(commands[1]).toMatchObject({
      decision: "always",
      grantScope: { kind: "project", projectID: "prj_alpha" },
      grantExpiresAt: null,
    })
    expect(commands[2]).not.toHaveProperty("grantExpiresAt")
  })

  test("fails closed when the request has no savable resources for always", async () => {
    mount(async (command) => receipt(command), "prj_alpha", { ...request, save: undefined })
    await flush()

    expect(decision("always").disabled).toBeTrue()
    expect(decision("always").title).toContain(zh["alpha.permission.noSavedResources"])
    expect(decision("once").disabled).toBeFalse()
    expect(decision("reject").disabled).toBeFalse()
  })

  test("fails closed when the active project ID is unavailable for always", async () => {
    mount(async (command) => receipt(command), null)
    await flush()

    expect(decision("always").disabled).toBeTrue()
    expect(decision("always").title).toContain(zh["alpha.permission.projectUnverified"])
    expect(decision("once").disabled).toBeFalse()
    expect(decision("reject").disabled).toBeFalse()
  })

  test.each([
    ["subject", withoutFact("subject")],
    ["action", withoutFact("action")],
    ["resources", withoutFact("resources")],
    ["scope", withoutFact("scope")],
    ["expiresAt", withoutFact("expiresAt")],
  ] as const)("fails closed without the %s fact while reject remains safe", async (fact, incompleteRequest) => {
    const commands: PermissionV2DecisionCommand[] = []
    mount(
      async (command) => {
        commands.push(command)
        return receipt(command)
      },
      "prj_alpha",
      incompleteRequest,
    )
    await flush()

    // #1617:「谁在请求」不再上卡 —— 主体缺失照样核不实、自动拒绝,只是卡上没有那一格。
    if (fact === "subject") expect(document.querySelector('[data-permission-fact="subject"]')).toBeNull()
    else
      expect(
        document.querySelector(`[data-permission-fact="${fact === "expiresAt" ? "expiry" : fact}"]`)?.textContent,
      ).toContain(zh["alpha.permission.cannotVerify"])
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("undefined")
    expect(decision("once").disabled).toBeTrue()
    expect(decision("always").disabled).toBeTrue()
    expect(decision("reject").disabled).toBeFalse()

    decision("once").click()
    decision("always").click()
    await flush()
    expect(commands.map((command) => command.decision)).toEqual(["reject"])
  })

  test.each([
    ["subject", { ...request, subject: { kind: "agent", id: "build-reviewer", unexpected: true } }],
    ["action", { ...request, action: 42 }],
    ["resources", { ...request, resources: ["pwd", 42] }],
    ["scope", { ...request, scope: { kind: "session", sessionID: "not-a-session" } }],
    ["expiresAt", { ...request, expiresAt: -1 }],
  ] as const)("decide() denies a malformed %s fact and never allows it", async (_fact, malformedRequest) => {
    const commands: PermissionV2DecisionCommand[] = []
    mount(
      async (command) => {
        commands.push(command)
        return receipt(command)
      },
      "prj_alpha",
      malformedRequest as unknown as PermissionV2Request,
    )
    await flush()

    expect(commands.map((command) => command.decision)).toEqual(["reject"])
    expect(commands.some((command) => command.decision !== "reject")).toBeFalse()
    decision("once").click()
    decision("always").click()
    await flush()
    expect(commands.map((command) => command.decision)).toEqual(["reject"])
  })

  test("keeps the exact failed command for retry and focuses the honest failure summary", async () => {
    const commands: PermissionV2DecisionCommand[] = []
    mount(async (command) => {
      commands.push(command)
      throw { kind: "failed", message: "network unavailable" }
    })
    await flush()

    decision("once").click()
    await flush()
    const alert = document.querySelector<HTMLElement>('[role="alert"][data-kind="failed"]')!
    expect(alert.textContent).toContain(zh["alpha.permission.failedDetail"])
    expect(alert.textContent).toContain("network unavailable")
    expect(document.activeElement?.getAttribute("role")).toBe("alert")
    expect(decision("once").textContent).toContain(
      zh["alpha.permission.retryDecision"].replace("{{label}}", zh["alpha.permission.once"]),
    )

    decision("once").click()
    await flush()
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    expect(commands[1].decisionID).toBe(commands[0].decisionID)
  })

  test("renders a distinct conflict state and never claims the new choice won", async () => {
    mount(async () => {
      throw { _tag: "ConflictError", message: "decisionID already belongs to different facts" }
    })
    await flush()

    decision("reject").click()
    await flush()
    const alert = document.querySelector<HTMLElement>('[role="alert"][data-kind="conflict"]')!
    expect(alert.textContent).toContain(zh["alpha.permission.conflictTitle"])
    expect(alert.textContent).toContain(zh["alpha.permission.conflictDetail"])
    expect(alert.textContent).toContain("different facts")
  })

  // #1478(REQ-230 AC4,owner 2026-10-10):批准面板不再是强模态 —— 无遮罩、不冻结页面,
  // 但仍关不掉、出现时焦点落在「允许一次」、结束后还给会话输入框。
  test("#1478 非模态:无遮罩,页面其余部分零 inert / aria-hidden,时间线照常可聚焦", async () => {
    const page = document.createElement("main")
    page.dataset.testPage = ""
    const timelineItem = document.createElement("button")
    timelineItem.textContent = "timeline"
    page.append(timelineItem)
    document.body.append(page)
    mount(async (command) => receipt(command))
    await flush()

    const panel = document.querySelector<HTMLElement>("[data-alpha-permission-panel]")!
    expect(panel).not.toBeNull()
    expect(panel.getAttribute("role")).toBe("dialog")
    expect(panel.hasAttribute("aria-modal")).toBeFalse()
    expect(document.querySelector(".a-dialog-backdrop, .a-dialog-root")).toBeNull()
    expect(panel.querySelector(".a-dialog-close, [aria-label='Close']")).toBeNull()
    for (const element of Array.from(document.querySelectorAll("*"))) {
      expect(element.hasAttribute("inert")).toBeFalse()
      expect(element.hasAttribute("aria-hidden") && !panel.contains(element)).toBeFalse()
    }

    // 没有焦点陷阱:用户可以把焦点移到时间线上,面板不把它拽回来。
    timelineItem.focus()
    await flush()
    expect(document.activeElement).toBe(timelineItem)
    expect(document.querySelector("[data-alpha-permission-panel]")).toBe(panel)
  })

  test("#1478 出现时焦点落在「允许一次」;Esc 关不掉、也不漏给页面", async () => {
    let pageSawEscape = false
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") pageSawEscape = true
    })
    mount(async (command) => receipt(command))
    await flush()

    const panel = document.querySelector<HTMLElement>("[data-alpha-permission-panel]")!
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")

    const escape = keydown(decision("once"), "Escape")
    await flush()
    expect(escape.defaultPrevented).toBeTrue()
    expect(pageSawEscape).toBeFalse()
    expect(document.querySelector("[data-alpha-permission-panel]")).toBe(panel)
    for (const fact of ["action", "resources", "scope", "expiry"]) {
      expect(panel.querySelector(`[data-permission-fact="${fact}"]`)).not.toBeNull()
    }
  })

  test("#1478 没有会话页也呈现(首页):锚在窗口底部居中", async () => {
    mount(async (command) => receipt(command), "prj_alpha", request, { composer: false })
    await flush()

    const panel = document.querySelector<HTMLElement>("[data-alpha-permission-panel]")!
    expect(panel).not.toBeNull()
    expect(panel.closest<HTMLElement>(".a-permission-panel-root")!.dataset.anchored).toBe("window")
    expect(document.querySelectorAll("[data-permission-decision]")).toHaveLength(3)
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")
  })

  test("#1478 面板消失后焦点还给会话输入框", async () => {
    const { textarea, dispose } = mount(async (command) => receipt(command))
    await flush()
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")

    dispose()
    disposers.splice(disposers.indexOf(dispose), 1)
    await flush()
    expect(document.querySelector("[data-alpha-permission-panel]")).toBeNull()
    expect(document.activeElement).toBe(textarea)
  })
})

describe("Alpha Permission watcher reconciliation", () => {
  test("does not resurrect an auto-denied malformed request from stale snapshots or asked events", async () => {
    const malformed = { ...request, id: "per_ui_malformed", expiresAt: -1 } as unknown as PermissionV2Request
    const commands: PermissionV2DecisionCommand[] = []
    let listeners: PermissionListeners | undefined
    mountWatcher({
      list: async () => [malformed],
      reply: async (_requestID, command) => {
        commands.push(command)
        return receipt(command, malformed)
      },
      subscribe: (value) => {
        listeners = value
        return () => {}
      },
    })
    await flush()

    expect(commands.map((command) => command.decision)).toEqual(["reject"])
    expect(document.querySelector("[role='dialog']")).toBeNull()

    listeners!.asked(malformed)
    listeners!.connected()
    await flush()

    expect(commands.map((command) => command.decision)).toEqual(["reject"])
    expect(document.querySelector("[role='dialog']")).toBeNull()
  })

  test("merges asked and replied events that arrive while the initial list is deferred", async () => {
    const fresh = { ...request, id: "per_ui_2", action: "edit", resources: ["src/new.ts"] }
    let settleList: ((requests: PermissionV2Request[]) => void) | undefined
    const initialList = new Promise<PermissionV2Request[]>((resolve) => {
      settleList = resolve
    })
    let listeners: PermissionListeners | undefined
    mountWatcher({
      list: () => initialList,
      reply: async (_requestID, command) => receipt(command),
      subscribe: (value) => {
        listeners = value
        return () => {}
      },
    })

    listeners!.asked(fresh)
    listeners!.replied({
      requestID: request.id,
      sessionID: request.sessionID,
      requestFingerprint: request.fingerprint,
      decisionID: "pdec_initial_replied",
      decision: "reject",
      committedAt: 1_893_456_000_001,
      resolvedRequestIDs: [request.id],
    })
    settleList!([request])
    await flush()

    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toBe("改文件")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("src/new.ts")
    // 已被回复的那条(运行命令 pwd)没有复活。
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("运行命令")
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("pwd")
  })

  test("fail-closed fallback: list failure presents nothing and grants nothing, SSE asked stays unpresented", async () => {
    // Codex 审计 Blocker-2 复现:独立兜底面在 list 失败期间不得保留旧请求呈现、
    // 不得把 SSE 增量单独合并成可放行的 UI;快照恢复后才恢复呈现。
    let listCalls = 0
    const replies: string[] = []
    let listeners: PermissionListeners | undefined
    mountWatcher({
      list: async () => {
        listCalls += 1
        if (listCalls === 1) throw new Error("channel down")
        return [request]
      },
      reply: async (requestID, command) => {
        replies.push(requestID)
        return receipt(command)
      },
      subscribe: (value) => {
        listeners = value
        return () => {}
      },
    })
    await flush()

    expect(document.querySelector("[role='dialog']")).toBeNull()

    listeners!.asked({ ...request, id: "per_ui_live" })
    await flush()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(replies).toEqual([])

    listeners!.connected()
    await flush()
    expect(listCalls).toBe(2)
    expect(document.querySelector("[role='dialog']")).not.toBeNull()
    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toBe("运行命令")
  })

  test("presents a valid request without auto-denial (unwrap regression, sole-surface path)", async () => {
    // 审批呈现唯一路径 = watcher 的 PermissionDialog(owner 裁决 2026-07-25,dock 让位
    // 机制已删):合法请求必须呈现,且 store 代理不得把它误判为核不实而触发自动拒绝。
    const replies: string[] = []
    mountWatcher({
      list: async () => [request],
      reply: async (requestID, command) => {
        replies.push(`${requestID}:${command.decision}`)
        return receipt(command)
      },
      subscribe: () => () => {},
    })
    await flush()
    expect(replies).toEqual([])
    expect(document.querySelector("[role='dialog']")).not.toBeNull()
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1)
  })

  test("#561 被 store 观察过的合法请求照常呈现,点「允许一次」真的发出 once", async () => {
    // #561:solid store 的 $PROXY 是**非枚举符号键**,却被 exactFactRecord 的 Reflect.ownKeys
    // 计入 ⇒ 键数 3 ≠ 2 ⇒ 合法请求被判「核不实」⇒ onMount 自动 reject。用户可观察的后果是
    // 该弹的授权框没弹、动作被拒、且没有任何提示 —— 所以断言必须落在「框在不在、发出去的
    // 决定是什么」,不能断言 permissionRequestFacts 这类内层纯函数。
    //
    // 夹具必须是自己的深拷贝:污染 configurable:false 不可撤销,碰了模块级 request 会永久
    // 污染同文件后续用例。JSON 往返同时把「数据域恒是 JSON wire」这条前提摆在明面上。
    const observed = runtime.observeThroughStore(
      JSON.parse(JSON.stringify({ ...request, id: "per_ui_observed" })) as PermissionV2Request,
    )
    // 先证明夹具真的造出了已知的坏 —— 否则 store 若没注入成功,这条用例会因为「什么都没
    // 发生」而假绿(观测手段自己有盲区)。
    expect(Object.getOwnPropertySymbols(observed.subject).length).toBeGreaterThan(0)
    expect(Object.getOwnPropertySymbols(observed.scope).length).toBeGreaterThan(0)
    // 而 wire 上真实存在的字段一个不多一个不少 —— 严格核验本来就该放行它。
    expect(Object.keys(observed.subject)).toEqual(["kind", "id"])
    expect(Object.keys(observed.scope)).toEqual(["kind", "sessionID"])

    const replies: string[] = []
    mountWatcher({
      list: async () => [observed],
      reply: async (requestID, command) => {
        replies.push(`${requestID}:${command.decision}`)
        return receipt(command, observed)
      },
      subscribe: () => () => {},
    })
    await flush()

    expect(replies).toEqual([])
    expect(document.querySelector("[role='dialog']")).not.toBeNull()
    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toBe("运行命令")
    expect(document.querySelector('[data-permission-fact="scope"]')?.textContent).toContain("本次会话")
    expect(decision("once").disabled).toBeFalse()

    decision("once").click()
    await flush()
    expect(replies).toEqual(["per_ui_observed:once"])
  })

  test("r1-1 生产 watcher 按登录态写范围行:读到 logged-in 才写当前账户,读不到或登出写未登录", async () => {
    const identity = v1Identity("policy")
    const client = (): PermissionClient => ({
      list: async () => [identity],
      reply: async (_requestID, command) => receipt(command, identity),
      subscribe: () => () => {},
    })
    mountWatcher(client())
    await flush()
    expect(rememberBox()?.querySelector("small")?.textContent).toBe("当前项目 · 未登录")
    disposers.splice(0).forEach((dispose) => dispose())
    await flush()

    runtime.resetAuthRecoveryForTests()
    authState = Promise.resolve({ status: "logged-in", mode: "platform" })
    mountWatcher(client())
    await flush()
    await flush()
    expect(rememberBox()?.querySelector("small")?.textContent).toBe("当前项目 · 当前账户 · 可在设置里撤回")
  })

  test("reconciles missed asked and replied events after server reconnects", async () => {
    const stale = { ...request, id: "per_ui_stale", action: "bash", resources: ["old/**"] }
    const fresh = { ...request, id: "per_ui_fresh", action: "edit", resources: ["new/**"] }
    const snapshots = [[stale], [fresh]]
    let listeners: PermissionListeners | undefined
    let listCalls = 0
    mountWatcher({
      list: async () => {
        listCalls += 1
        return snapshots.shift() ?? []
      },
      reply: async (_requestID, command) => receipt(command),
      subscribe: (value) => {
        listeners = value
        return () => {}
      },
    })
    await flush()
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("old/**")

    listeners!.connected()
    await flush()

    expect(listCalls).toBe(2)
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("new/**")
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("old/**")
  })
})

// dock 审批卡与 claim 抢占机制已随 owner 裁决(2026-07-25)删除:仓内唯一审批呈现面 =
// PermissionWatcher 的 PermissionDialog;反向闸门见 takeover-adapter-coexistence.test.ts。

// ═══ REQ-236 `#1575`:中间按钮按请求种类,卡上写清记住什么 ═══════════════════════════════
//
// 夹具一律经**生产适配器** `adaptPermissionV1Request` 投影 —— 审批卡在生产里看到的 v1 请求就是这样来的,
// 不手写投影后的形状。原始 v1 请求的形状取自引擎的真实 ask 点(每条注明出处)。
const BINDING = `sha256:${"b".repeat(64)}`

function v1(raw: Omit<PermissionV1Request, "sessionID" | "tool">, agent = "alpha-ask") {
  return adaptPermissionV1Request(
    { ...raw, sessionID: "ses_ui_1", tool: { messageID: "msg_ui_1", callID: "call_ui_1" } },
    agent,
  )
}

// packages/opencode/src/tool/shell.ts:284-290(patterns = 命令原文,always = BashArity 前缀 + " *")
const v1Bash = v1({
  id: "per_v1_bash",
  permission: "bash",
  patterns: ["bun test src/session", "git status"],
  always: ["bun test *", "git status *"],
  metadata: { command: "bun test src/session && git status" },
})
// packages/opencode/src/tool/shell.ts:262-279(外部目录:patterns = always = 目录 + "/*")
const v1Folders = v1({
  id: "per_v1_dirs",
  permission: "external_directory",
  patterns: ["/Users/zian/codepuppy-test/*", "/var/folders/bn/T/opencode/*"],
  always: ["/Users/zian/codepuppy-test/*", "/var/folders/bn/T/opencode/*"],
  metadata: { command: "ls /Users/zian/codepuppy-test /var/folders/bn/T/opencode" },
})
// packages/opencode/src/tool/edit.ts:102-110
const v1Edit = v1({
  id: "per_v1_edit",
  permission: "edit",
  patterns: ["src/app.ts"],
  always: ["*"],
  metadata: { filepath: "/w/src/app.ts", diff: "" },
})
// packages/opencode/src/tool/task.ts:120-128
const v1Task = v1({
  id: "per_v1_task",
  permission: "task",
  patterns: ["general"],
  always: ["*"],
  metadata: { description: "调研三家竞品的公开定价", subagent_type: "general" },
})
// packages/opencode/src/session/prompt.ts:272-285(命令换了助手:逐次询问,不产生会话放行)
const v1TaskOnce = v1({
  id: "per_v1_task_once",
  permission: "task",
  patterns: ["reviewer"],
  always: [],
  metadata: {},
})
// packages/opencode/src/permission/alpha-tool-policy-gate.ts confirm 写的 metadata:identity / authority /
// transport / location(#1617,= mcpLocation,引擎测试 alpha-approval-binding.test.ts「#1617 AC3」钉住)/ policy;policy 形状同引擎测试 test/permission/alpha-approval-binding.test.ts:405-410 断言的那一份,
// identity 是 ToolIdentity(source / origin / name,canonical = `mcp:<origin>:<name>`),第三方 MCP 的 authority 恒 not-asserted。
function v1Identity(
  askedBy: "policy" | "ruleset",
  policy: Record<string, unknown> = {},
  agent = "alpha-ask",
  tool: { canonical: string; identity: unknown; authority: unknown } = {
    canonical: "mcp:notion:search_pages",
    identity: { source: "mcp", origin: "notion", name: "search_pages" },
    authority: { kind: "not-asserted" },
  },
  location: { kind: "local" } | { kind: "remote"; host: string } | null = { kind: "remote", host: "mcp.notion.com" },
) {
  const patterns = askedBy === "policy" ? [`${BINDING}@sha256:${"c".repeat(64)}`] : ["call:call_ui_1"]
  return v1(
    {
      id: `per_v1_identity_${askedBy}`,
      permission: tool.canonical,
      patterns,
      always: askedBy === "policy" ? patterns : [],
      metadata: {
        identity: tool.identity,
        authority: tool.authority,
        transport: { kind: "mcp-remote", url: "https://mcp.notion.com/mcp" },
        ...(location ? { location } : {}),
        policy: { directory: "/Users/zian/project", canonical: tool.canonical, bindingDigest: BINDING, askedBy, ...policy },
      },
    },
    agent,
  )
}

// Code Puppy 云工具:authority = alpha-cloud(引擎 authorityForMcp 铸的证据),identity.name 是远端原名 cloud_dispatch。
const CLOUD_DISPATCH = {
  canonical: "mcp:alpha:cloud_dispatch",
  identity: { source: "mcp", origin: "alpha", name: "cloud_dispatch" },
  authority: { kind: "codepuppy-cloud", bindingId: "mcp:alpha", evidenceDigest: `sha256:${"d".repeat(64)}` },
}

const card = () => document.querySelector<HTMLElement>("[role='dialog']")!
const rememberBox = () => document.querySelector<HTMLElement>("[data-permission-remember]")

describe("REQ-236 #1575 中间按钮按请求种类", () => {
  test("AC1 适配器把能力轴的 always 投影成 save,身份轴不投影", () => {
    expect(v1Edit.save).toEqual(["*"])
    expect(v1Bash.save).toEqual(["bun test *", "git status *"])
    expect(v1Folders.save).toEqual(["/Users/zian/codepuppy-test/*", "/var/folders/bn/T/opencode/*"])
    expect(v1TaskOnce.save).toEqual([])
    expect(v1Identity("policy").save).toBeUndefined()
    expect(v1Identity("ruleset").save).toBeUndefined()
  })

  test.each([
    ["bash 前缀", v1Bash, "以 bun test、git status 开头的命令"],
    ["外部目录", v1Folders, "/Users/zian/codepuppy-test、/var/folders/bn/T/opencode 及其子文件夹"],
    ["改文件 *", v1Edit, "本会话内的所有文件修改"],
    ["委派 *", v1Task, "本会话派出的所有子任务"],
  ] as const)("AC1 能力轴(%s):「本次会话内允许」,将记住与 always 逐项对应,期限写重启后失效", async (_name, permissionRequest, what) => {
    const commands: PermissionV2DecisionCommand[] = []
    mount(async (command) => {
      commands.push(command)
      return receipt(command, permissionRequest)
    }, "prj_alpha", permissionRequest)
    await flush()

    expect(decision("always").textContent).toBe(zh["alpha.permission.allowSession"])
    expect(decision("always").disabled).toBeFalse()
    const box = rememberBox()!
    expect(box.dataset.permissionRemember).toBe("session")
    expect(box.textContent).toContain(zh["alpha.permission.allowSession"])
    expect(box.querySelector("b")?.textContent).toBe(`将记住:${what}`)
    expect(box.querySelector("small")?.textContent).toBe("本次会话 · 重启后失效")
    // 原始规则不上卡:记住框里没有通配,整张卡没有「不过期」与「永久授权」。
    expect(box.textContent).not.toContain("*")
    expect(card().textContent).not.toContain("不过期")
    expect(card().textContent).not.toContain("永久授权")
    expect(card().querySelector('[data-permission-fact="scope"]')).toBeNull()
    expect(card().querySelector('[data-permission-fact="expiry"]')).toBeNull()

    decision("always").click()
    await flush()
    expect(commands.map((command) => command.decision)).toEqual(["always"])
    expect(commands[0]!.requestFingerprint).toBe(`engine-v1:${permissionRequest.id}`)
  })

  test("AC1 能力轴请求不带可记住的范围:不出现中间按钮,也没有记住框", async () => {
    mount(async (command) => receipt(command, v1TaskOnce), "prj_alpha", v1TaskOnce)
    await flush()

    expect(document.querySelector('[data-permission-decision="always"]')).toBeNull()
    expect(document.querySelectorAll("[data-permission-decision]")).toHaveLength(2)
    expect(rememberBox()).toBeNull()
  })

  test("AC5 委派卡带「子任务里不再逐项询问」;能记住与只能一次两种都带,别的请求不带", async () => {
    for (const permissionRequest of [v1Task, v1TaskOnce]) {
      const { dispose } = mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest)
      await flush()
      expect(document.querySelector('[data-permission-note="delegation"]')?.textContent).toBe("子任务里不再逐项询问")
      dispose()
      disposers.splice(disposers.indexOf(dispose), 1)
      await flush()
    }
    mount(async (command) => receipt(command, v1Bash), "prj_alpha", v1Bash)
    await flush()
    expect(document.querySelector('[data-permission-note="delegation"]')).toBeNull()
  })

  test("AC2 身份轴 askedBy=policy:先写工具级「启用」(带当前 binding),写成才放行这一次", async () => {
    const order: string[] = []
    const writes: Parameters<SaveToolPolicy>[0][] = []
    const commands: PermissionV2DecisionCommand[] = []
    const permissionRequest = v1Identity("policy")
    mount(
      async (command) => {
        order.push(`reply:${command.decision}`)
        commands.push(command)
        return receipt(command, permissionRequest)
      },
      "prj_alpha",
      permissionRequest,
      {
        saveToolPolicy: async (input) => {
          order.push("setRecord")
          writes.push(input)
          return { ok: true }
        },
      },
    )
    await flush()

    expect(decision("always").textContent).toBe("在此项目中始终允许")
    expect(rememberBox()?.dataset.permissionRemember).toBe("project")
    expect(rememberBox()?.querySelector("b")?.textContent).toBe("将记住:在此项目使用这个工具")
    expect(rememberBox()?.querySelector("small")?.textContent).toBe("当前项目 · 当前账户 · 可在设置里撤回")
    // 身份轴的 patterns 是放行键,不当资源显示。
    expect(card().querySelector('[data-permission-fact="resources"]')).toBeNull()
    expect(card().textContent).not.toContain(BINDING)
    expect(card().textContent).not.toContain("call:")

    decision("always").click()
    await flush()
    expect(order).toEqual(["setRecord", "reply:once"])
    expect(writes).toEqual([
      {
        directory: "/Users/zian/project",
        record: {
          selector: { level: "tool", canonical: "mcp:notion:search_pages" },
          state: "enabled",
          bindingDigest: BINDING,
        },
      },
    ])
    expect(commands[0]).not.toHaveProperty("grantScope")
  })

  test.each([
    ["写入被拒", async () => ({ ok: false as const, code: "write-failed" as const })],
    ["写入抛错", async () => Promise.reject(new Error("ipc gone"))],
  ] as const)("AC2 身份轴写入失败(%s):卡片挂着、显示失败、不放行;重试沿用现有写法", async (_name, failing) => {
    const commands: PermissionV2DecisionCommand[] = []
    const permissionRequest = v1Identity("policy")
    mount(async (command) => {
      commands.push(command)
      return receipt(command, permissionRequest)
    }, "prj_alpha", permissionRequest, { saveToolPolicy: failing })
    await flush()

    decision("always").click()
    await flush()
    await flush()
    expect(commands).toEqual([])
    expect(card()).not.toBeNull()
    expect(document.querySelector('[data-permission-note="save-failed"]')?.textContent).toBe("没能保存,这次未放行")
    expect(document.querySelector('[data-permission-note="save-failed"]')?.getAttribute("role")).toBe("alert")
    expect(decision("always").textContent).toBe("重试「在此项目中始终允许」")
    expect(decision("always").disabled).toBeFalse()
    expect(decision("once").disabled).toBeFalse()
  })

  test("AC2 身份轴找不到当前项目:按钮置灰并说明,点了也不写不放行", async () => {
    let writes = 0
    const commands: PermissionV2DecisionCommand[] = []
    const permissionRequest = v1Identity("policy", { directory: undefined })
    mount(async (command) => {
      commands.push(command)
      return receipt(command, permissionRequest)
    }, "prj_alpha", permissionRequest, {
      saveToolPolicy: async () => {
        writes += 1
        return { ok: true }
      },
    })
    await flush()

    expect(decision("always").disabled).toBeTrue()
    expect(document.querySelector('[data-permission-note="project-missing"]')?.textContent).toBe("找不到当前项目,不能始终允许")
    expect(rememberBox()).toBeNull()
    decision("always").click()
    await flush()
    expect(writes).toBe(0)
    expect(commands).toEqual([])
  })

  test("AC3 身份轴 askedBy=ruleset:只有「允许一次」与「拒绝」,写明这个工具每次都要确认;不凭执行助手名断言只读档", async () => {
    // 执行助手名取自工具消息、缺时退取最后一条助手消息(permission-v1-adapter.ts resolvePermissionV1Agent),
    // 它等于 alpha-readonly 也确证不了「当前档位是只读」—— 所以卡上不写「只读模式」。
    const commands: PermissionV2DecisionCommand[] = []
    const permissionRequest = v1Identity("ruleset", {}, "alpha-readonly")
    mount(async (command) => {
      commands.push(command)
      return receipt(command, permissionRequest)
    }, "prj_alpha", permissionRequest)
    await flush()

    expect(document.querySelector('[data-permission-decision="always"]')).toBeNull()
    expect([...document.querySelectorAll<HTMLElement>("[data-permission-decision]")].map((button) => button.dataset.permissionDecision)).toEqual([
      "reject",
      "once",
    ])
    expect(document.querySelector('[data-permission-note="every-time"]')?.textContent).toBe("这个工具每次都要确认")
    expect(card().textContent).not.toContain("只读模式")
    expect(rememberBox()).toBeNull()
    expect(card().querySelector('[data-permission-fact="resources"]')).toBeNull()

    decision("once").click()
    await flush()
    expect(commands.map((command) => command.decision)).toEqual(["once"])
  })

  test("AC3 askedBy 不是 policy(缺失或未知)时同样只能允许一次 —— 拿不准就不给持久放行", async () => {
    const permissionRequest = v1Identity("policy", { askedBy: "something-else" })
    mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest)
    await flush()

    expect(document.querySelector('[data-permission-decision="always"]')).toBeNull()
    expect(document.querySelector('[data-permission-note="every-time"]')).not.toBeNull()
  })

  test("AC5 i18n:审批卡新增的每一句中英文词典都有", () => {
    const keys = Object.keys(zh).filter((key) =>
      /^alpha\.permission\.(allow(Session|Project)|remember|listSeparator|sessionScope|projectScope|everyTime|projectMissing|delegationNote|saveFailed)/.test(key),
    )
    expect(keys.length).toBe(19)
    for (const key of keys) expect(typeof (en as Record<string, string>)[key]).toBe("string")
  })

  test("r1-3 身份轴 askedBy=policy 但没有 binding digest:写入必被 schema 拒,只给允许一次", async () => {
    // MCP 没有生效条目、插件 origin 未知时引擎写不出 bindingDigest(alpha-tool-policy.ts subjectBindingDigest);
    // 工具级 enabled 必须带它(schema/src/alpha-tool-policy.ts ToolPolicyRecord),给按钮 = 一个永远「没能保存」的按钮。
    const permissionRequest = v1Identity("policy", { bindingDigest: undefined })
    mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest)
    await flush()

    expect(document.querySelector('[data-permission-decision="always"]')).toBeNull()
    expect(document.querySelector('[data-permission-note="every-time"]')?.textContent).toBe("这个工具每次都要确认")
    expect(rememberBox()).toBeNull()
  })

  test("r1-2 能力轴找不到当前项目:按钮置灰并说明原因,不画记住框;只能一次的卡不说这句", async () => {
    const commands: PermissionV2DecisionCommand[] = []
    const { dispose } = mount(async (command) => {
      commands.push(command)
      return receipt(command, v1Bash)
    }, null, v1Bash)
    await flush()

    expect(decision("always").disabled).toBeTrue()
    expect(document.querySelector('[data-permission-note="project-missing"]')?.textContent).toBe("找不到当前项目,不能始终允许")
    expect(rememberBox()).toBeNull()
    decision("always").click()
    await flush()
    expect(commands).toEqual([])
    dispose()
    disposers.splice(disposers.indexOf(dispose), 1)
    await flush()

    // 档位要求每次确认的卡没有中间按钮,也就没有「不能始终允许」可说。
    const ruleset = v1Identity("ruleset")
    mount(async (command) => receipt(command, ruleset), null, ruleset)
    await flush()
    expect(document.querySelector('[data-permission-note="project-missing"]')).toBeNull()
  })

  test("r1-1 身份轴「在此项目中始终允许」的范围行:登录写当前账户,未登录写未登录", async () => {
    const permissionRequest = v1Identity("policy")
    const { dispose } = mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest, {
      signedIn: false,
    })
    await flush()
    expect(rememberBox()?.querySelector("small")?.textContent).toBe("当前项目 · 未登录")
    dispose()
    disposers.splice(disposers.indexOf(dispose), 1)
    await flush()

    mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest, { signedIn: true })
    await flush()
    expect(rememberBox()?.querySelector("small")?.textContent).toBe("当前项目 · 当前账户 · 可在设置里撤回")
  })

  test.each([
    ["第三方 MCP(带引擎写的远端位置)", v1Identity("ruleset"), "search_pages", "第三方 · mcp.notion.com"],
    [
      "第三方 MCP(本机程序,不写主机)",
      v1Identity("ruleset", {}, "alpha-ask", undefined, { kind: "local" }),
      "search_pages",
      "第三方",
    ],
    // 请求没带 location 时不从 transport 的 URL 自己解析主机(AC3:渲染层只读引擎写的字段)。
    ["第三方 MCP(请求没带位置)", v1Identity("ruleset", {}, "alpha-ask", undefined, null), "search_pages", "第三方"],
    ["Code Puppy 云", v1Identity("policy", {}, "alpha-ask", CLOUD_DISPATCH), "下发云端任务", "Code Puppy 云"],
    [
      "同名云工具但没有云证据",
      v1Identity("policy", {}, "alpha-ask", { ...CLOUD_DISPATCH, authority: { kind: "not-asserted" } }),
      "cloud_dispatch",
      "第三方 · mcp.notion.com",
    ],
  ] as const)("r1-5 身份轴「要做什么」写可读名与来源(与时间线同一套判定),不写 canonical:%s", async (_name, permissionRequest, title, source) => {
    mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest)
    await flush()

    const action = card().querySelector<HTMLElement>('[data-permission-fact="action"]')!
    expect(action.querySelector(".a-permission-verb")?.textContent).toBe("使用工具")
    expect(action.querySelector(".a-permission-tool b")?.textContent).toBe(title)
    expect(action.querySelector(".a-permission-tool small")?.textContent).toBe(source)
    expect(card().textContent).not.toContain(permissionRequest.action)
  })

  test("AC6 新式请求(带 save):中间按钮仍是「始终允许」,照旧创建项目授权,事实(去掉主体)与页脚说明都在", async () => {
    const commands: PermissionV2DecisionCommand[] = []
    mount(async (command) => {
      commands.push(command)
      return receipt(command)
    })
    await flush()

    expect(decision("always").textContent).toBe(zh["alpha.permission.always"])
    expect(rememberBox()).toBeNull()
    for (const fact of ["action", "resources", "scope", "expiry"])
      expect(card().querySelector(`[data-permission-fact="${fact}"]`)).not.toBeNull()
    expect(card().querySelector('[data-permission-fact="subject"]')).toBeNull()
    // #1617 r1:页脚写人话(永久授权、不会自动过期),不露 grantExpiresAt = null 这类原始字段。
    expect(document.querySelector(".a-permission-grant-note")?.textContent).toBe("「始终允许」会为当前项目创建永久授权,不会自动过期。")
    expect(card().textContent).not.toContain("grantExpiresAt")
    decision("always").click()
    await flush()
    expect(commands[0]).toMatchObject({ decision: "always", grantScope: { kind: "project", projectID: "prj_alpha" } })
  })
})

// ═══ REQ-236 `#1617`:确认卡只写人话 —— 不露英文工程标签、原始动作名与主体助手,第三方来源带主机 ═══════════════
// 判据取自批准稿 docs/design/2026-10-30-req236-permission-cards/frame.html 帧 A–D 与 notes.md 第 3、9 条。
// packages/opencode/src/tool/webfetch.ts:40(稿里没有的动作:同一风格的短动词)
const v1Webfetch = v1({
  id: "per_v1_webfetch",
  permission: "webfetch",
  patterns: ["https://example.com/pricing"],
  always: ["*"],
  metadata: { url: "https://example.com/pricing" },
})
// 表里没有的动作名:一律「使用工具」,原文不上卡。
const v1Unknown = v1({ id: "per_v1_unknown", permission: "frobnicate_widget", patterns: ["x"], always: [], metadata: {} })

/** 英文工程标签与开发者用语(AC1 票面逐字列出的那几个,外加同组的 Expiry)。 */
const ENGINEERING_LABELS = ["Action / Capability", "Action", "Resources", "Scope", "Expiry", "主体 / 执行 Agent", "执行 Agent", "subject.kind"]

describe("REQ-236 #1617 确认卡只写人话", () => {
  test.each([
    ["运行命令", v1Bash, "bash", "运行命令", undefined, ["bun test src/session", "git status"]],
    ["改文件", v1Edit, "edit", "改文件", undefined, ["src/app.ts"]],
    ["外部文件夹", v1Folders, "external_directory", "访问项目以外的文件夹", undefined, ["/Users/zian/codepuppy-test", "/var/folders/bn/T/opencode"]],
    ["委派", v1Task, "task", "派出子任务", ["交给助手 general", "调研三家竞品的公开定价"], undefined],
    ["委派(只能一次)", v1TaskOnce, "task", "派出子任务", ["交给助手 reviewer", undefined], undefined],
    ["身份轴 · 第三方", v1Identity("ruleset"), "mcp:notion:search_pages", "使用工具", ["search_pages", "第三方 · mcp.notion.com"], undefined],
    ["身份轴 · 云", v1Identity("policy", {}, "alpha-ask", CLOUD_DISPATCH), "mcp:alpha:cloud_dispatch", "使用工具", ["下发云端任务", "Code Puppy 云"], undefined],
    ["稿外动作(打开网页)", v1Webfetch, "webfetch", "打开网页", undefined, ["https://example.com/pricing"]],
    ["认不出的动作", v1Unknown, "frobnicate_widget", "使用工具", undefined, ["x"]],
    ["新式请求", request, "bash", "运行命令", undefined, ["pwd", "src/**"]],
  ] as const)("AC1 %s:「要做什么」写人话,卡上没有英文工程标签与原始动作名", async (_name, permissionRequest, raw, verb, line, resources) => {
    mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest)
    await flush()

    const text = card().textContent ?? ""
    for (const label of ENGINEERING_LABELS) expect(text).not.toContain(label)
    expect(text).not.toContain(raw)
    const action = card().querySelector<HTMLElement>('[data-permission-fact="action"]')!
    expect(action.querySelector(".a-permission-verb")?.textContent).toBe(verb)
    if (line) {
      expect(action.querySelector(".a-permission-tool b")?.textContent).toBe(line[0])
      expect(action.querySelector(".a-permission-tool small")?.textContent).toBe(line[1])
    } else expect(action.querySelector(".a-permission-tool")).toBeNull()
    const codes = [...card().querySelectorAll('[data-permission-fact="resources"] code')].map((node) => node.textContent)
    expect(codes).toEqual(resources ? [...resources] : [])
  })

  test.each([
    ["能力轴", v1Bash],
    ["委派", v1Task],
    ["身份轴", v1Identity("policy")],
    ["新式请求", request],
  ] as const)("AC2 %s:没有说明句,也没有「谁在请求」那一行(主体助手名不上卡)", async (_name, permissionRequest) => {
    mount(async (command) => receipt(command, permissionRequest), "prj_alpha", permissionRequest)
    await flush()

    const text = card().textContent ?? ""
    expect(text).not.toContain("请核对下面的真实请求事实")
    expect(text).not.toContain("谁在请求")
    expect(card().querySelector(".a-permission-panel-description")).toBeNull()
    expect(card().querySelector('[data-permission-fact="subject"]')).toBeNull()
    expect(text).not.toContain(permissionRequest.subject.id)
    expect(card().getAttribute("aria-describedby")).toBeNull()
  })

  test("AC2 i18n:说明句与「主体 / Action / Resources」标签已从中英文词典删除", () => {
    for (const key of [
      "alpha.permission.description",
      "alpha.permission.subject",
      "alpha.permission.action",
      "alpha.permission.resources",
    ]) {
      expect(zh).not.toHaveProperty(key)
      expect(en).not.toHaveProperty(key)
    }
    for (const key of Object.keys(zh).filter((key) => /^alpha\.permission\.(verb|delegateTo)/.test(key)))
      expect(typeof (en as Record<string, string>)[key]).toBe("string")
  })
})
