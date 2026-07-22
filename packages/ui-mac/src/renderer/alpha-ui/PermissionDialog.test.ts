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
import type { setLocale } from "../i18n"

type TestRuntime = {
  createComponent: typeof createComponent
  render: typeof render
  createPermissionDecisionCommand: typeof createPermissionDecisionCommand
  PermissionDialog: typeof PermissionDialog
  PermissionWatcher: typeof PermissionWatcher
  setLocale: typeof setLocale
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
// Assertions below are the zh product copy; pin the bundled i18n instance to zh so the real
// render matches (else detectLocale() → "en" in happy-dom and every literal assertion drifts).
runtime.setLocale("zh")

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
    expect(document.querySelector(".a-permission-grant-note")?.textContent).toContain("当前项目创建永久授权")
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
    expect(decision("always").title).toContain("未提供可保存资源")
    expect(decision("once").disabled).toBeFalse()
    expect(decision("reject").disabled).toBeFalse()
  })

  test("fails closed when the active project ID is unavailable for always", async () => {
    mount(async (command) => receipt(command), null)
    await flush()

    expect(decision("always").disabled).toBeTrue()
    expect(decision("always").title).toContain("无法核实当前项目")
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
    ).toContain("无法核实")
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
    expect(alert.textContent).toContain("没有收到授权收据")
    expect(alert.textContent).toContain("network unavailable")
    expect(document.activeElement?.getAttribute("role")).toBe("alert")
    expect(decision("once").textContent).toContain("重试")

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
    expect(alert.textContent).toContain("与已提交决定冲突")
    expect(alert.textContent).toContain("没有覆盖")
    expect(alert.textContent).toContain("different facts")
  })

  test("reuses Dialog safe focus, keyboard trap, and non-dismissible close contract", async () => {
    mount(async (command) => receipt(command))
    await flush()

    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(dialog.querySelector(".a-dialog-close")).toBeNull()
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")

    const escape = keydown(decision("once"), "Escape")
    await flush()
    expect(escape.defaultPrevented).toBeTrue()
    expect(document.querySelector("[role='dialog']") === dialog).toBeTrue()

    keydown(dialog, "Tab")
    dialog.querySelector<HTMLElement>('[data-dialog-focus-guard="end"]')!.focus()
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("reject")
    keydown(dialog, "Tab", { shiftKey: true })
    dialog.querySelector<HTMLElement>('[data-dialog-focus-guard="start"]')!.focus()
    expect((document.activeElement as HTMLElement | null)?.dataset.permissionDecision).toBe("once")
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

    expect(document.querySelector('[data-permission-fact="action"]')?.textContent).toContain("edit")
    expect(document.querySelector('[data-permission-fact="resources"]')?.textContent).toContain("src/new.ts")
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("bash")
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
