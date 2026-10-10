import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import type {
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
import { dict as zh } from "../i18n/zh"

type TestRuntime = {
  createComponent: typeof createComponent
  render: typeof render
  createPermissionDecisionCommand: typeof createPermissionDecisionCommand
  PermissionDialog: typeof PermissionDialog
  PermissionWatcher: typeof PermissionWatcher
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

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  await flush()
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

function mount(
  onSubmit: (command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>,
  projectID: string | null = "prj_alpha",
  permissionRequest = request,
) {
  const composer = document.createElement("div")
  composer.dataset.alphaComposer = "session"
  const textarea = document.createElement("textarea")
  composer.append(textarea)
  document.body.append(composer)

  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.PermissionDialog, {
          request: permissionRequest,
          projectID: projectID ?? undefined,
          onSubmit,
        }),
      host,
    ),
  )
  return { textarea }
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
  test("renders the five public request facts without contract placeholders", async () => {
    mount(async (command) => receipt(command))
    await flush()

    expect(document.querySelector('[data-permission-fact="subject"]')?.textContent).toContain("build-reviewer")
    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toContain("bash")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("pwd")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("src/**")
    expect(document.querySelector('[data-permission-fact="scope"]')?.textContent).toContain("ses_ui_1")
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

  // #1478(REQ-230 AC4):呈现从强模态 Dialog 改为非模态全局面板 —— 仍唯一、仍关不掉、
  // 仍把焦点放在「允许一次」,但不再遮罩、不再冻结页面其余部分。
  test("non-modal panel: nothing else is inert or aria-hidden, no scrim, no focus trap", async () => {
    const { textarea } = mount(async (command) => receipt(command))
    const timeline = document.createElement("section")
    timeline.dataset.harnessTimeline = ""
    document.body.append(timeline)
    await flush()

    const panel = document.querySelector<HTMLElement>("[role='dialog']")!
    expect(panel).not.toBeNull()
    expect(panel.getAttribute("aria-modal")).toBe("false")
    expect(document.querySelector(".a-dialog-backdrop")).toBeNull()
    expect(document.querySelector("[data-dialog-focus-guard]")).toBeNull()
    expect(panel.querySelector(".a-dialog-close")).toBeNull()
    const layer = panel.closest("[data-alpha-permission-panel]")!
    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (layer.contains(element)) continue
      expect(element.hasAttribute("inert")).toBeFalse()
      expect(element.getAttribute("aria-hidden")).toBeNull()
    }
    // 页面其余部分照常可聚焦(焦点不被困住)。
    textarea.focus()
    expect(document.activeElement).toBe(textarea)
    expect(document.querySelector("[role='dialog']") === panel).toBeTrue()
  })

  test("initial focus lands on 允许一次 and Esc never closes the panel", async () => {
    mount(async (command) => receipt(command))
    await flush()

    const panel = document.querySelector<HTMLElement>("[role='dialog']")!
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")
    expect(decision("once").textContent).toContain(zh["alpha.permission.once"])

    let escapedToPage = false
    const pageListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapedToPage = true
    }
    document.addEventListener("keydown", pageListener)
    const escape = keydown(decision("once"), "Escape")
    await flush()
    document.removeEventListener("keydown", pageListener)
    expect(escape.defaultPrevented).toBeTrue()
    expect(escapedToPage).toBeFalse()
    expect(document.querySelector("[role='dialog']") === panel).toBeTrue()

    // 页面级 Esc(焦点不在面板里)同样关不掉它。
    keydown(document.body, "Escape")
    await flush()
    expect(document.querySelector("[role='dialog']") === panel).toBeTrue()
  })

  test("returns focus to the session composer once the decision resolves", async () => {
    const { textarea } = mount(async (command) => receipt(command))
    await flush()
    decision("once").click()
    await flush()
    // 本 mount 不由 watcher 驱动,决定落地后面板仍在;移除宿主模拟 watcher 收起面板。
    disposers.splice(0).forEach((dispose) => dispose())
    await flush()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

})

describe("Alpha Permission watcher reconciliation", () => {
  test("#1478: the watcher shows the panel on a page with no session composer (e.g. home)", async () => {
    mountWatcher({
      list: async () => [request],
      reply: async (_requestID, command) => receipt(command),
      subscribe: () => () => {},
    })
    await flush()

    expect(document.querySelector('[data-alpha-composer="session"]')).toBeNull()
    const panels = document.querySelectorAll<HTMLElement>("[role='dialog']")
    expect(panels).toHaveLength(1)
    expect(panels[0]!.getAttribute("aria-modal")).toBe("false")
    // 无输入框时贴着窗口底边(固定间距),不依赖任何会话页节点。
    expect(panels[0]!.style.bottom).toBe("12px")
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")
  })

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

    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toContain("edit")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("src/new.ts")
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("bash")
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
    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toContain("bash")
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
    expect(document.querySelector('[data-permission-fact="subject"]')?.textContent).toContain("build-reviewer")
    expect(document.querySelector('[data-permission-fact="scope"]')?.textContent).toContain("ses_ui_1")
    expect(decision("once").disabled).toBeFalse()

    decision("once").click()
    await flush()
    expect(replies).toEqual(["per_ui_observed:once"])
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
