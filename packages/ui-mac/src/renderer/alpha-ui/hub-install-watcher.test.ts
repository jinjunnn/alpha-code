// REQ-234 `#1531`(基线 §2.3,I2 / I3 / I9 的 renderer 一半):agent 的定制中心安装请求在审批面上的完整行为。
//
// 挂的是生产 PermissionWatcher(→ HubInstallWatcher → install-confirm 控制器 → use-extensions 出站),只替换三样宿主:
// @solidjs/router(读路由)、@opencode-ai/sdk(引擎 client 答「读不到」)、window.api(preload IPC,本测试的录音面)。
// 每条用例都把「记阶段」「出站安装」「回审批」排进同一条时间线,断言的是**顺序**:
//   确认 ⇒ confirming → submitted → install(带 hubRequestId;框里填的密钥只在 grants)→ install(授权重驱)→ once
//   取消 ⇒ confirming → declined → reject;授权第二阶段才取消 ⇒ … → failed(authorization canceled)→ reject
//   失败 ⇒ install 返回 !ok 之后才记 failed;框里显示原因;关框才 reject
//   记不上 confirming / 目录里找不到 ⇒ 不弹框(或不出确认按钮)、reject
// 通用五栏审批框在这些用例里一次都不出现(同一请求只有一个框)。
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import type { PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { dict as zh } from "../i18n/zh"
import { createHubRequestStages, type HubRequestStages } from "../../main/hub-view"
import type * as RuntimeModule from "./hub-install-watcher-test-runtime"

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-hub-install-watcher-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  resolve: {
    alias: [
      { find: "@solidjs/router", replacement: join(import.meta.dir, "hub-install-watcher-stub.ts") },
      { find: /^@opencode-ai\/sdk(?:\/.*)?$/, replacement: join(import.meta.dir, "hub-install-watcher-stub.ts") },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: { entry: join(import.meta.dir, "hub-install-watcher-test-runtime.tsx"), formats: ["es"], fileName: () => "runtime.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(runtimeDirectory, "runtime.js")).href)) as typeof RuntimeModule

const SECRET = "REQ234_BOX_SECRET_51e2"
const ENTRIES = [
  {
    id: "mcp:notes",
    type: "mcp",
    name: "notes",
    displayName: "Notes",
    description: "notes connector",
    source: "official",
    category: "dev",
    installSpec: { kind: "mcp", mcpType: "local", command: ["npx", "notes"], requiredEnvVars: ["NOTES_TOKEN"] },
  },
  {
    id: "skill:writer",
    type: "skill",
    name: "writer",
    displayName: "Writer",
    description: "writes",
    source: "official",
    category: "writing",
    installSpec: { kind: "skill", source: "builtin", builtinAssetKey: "writer", targetDir: "alpha-skills" },
  },
]

type InstallScript = Array<Record<string, unknown>>
/** 阶段完成与真实回复的同一条时间线(runtime.timeline:回复由 surface client 写,阶段由下面的 IPC 桩在**完成时**写)。 */
const timeline = () => runtime.timeline
/** 悬置某个阶段的 IPC(审计 R1 Minor 5):在 release 之前,它既不完成、也不该有任何回复。 */
const held = new Map<string, { promise: Promise<void>; release: () => void }>()
function hold(stage: string) {
  let release = () => {}
  const promise = new Promise<void>((resolve) => (release = resolve))
  held.set(stage, { promise, release })
  return () => {
    held.delete(stage)
    release()
  }
}
let intents: Array<Record<string, unknown>> = []
/** main 的**生产**阶段簿(只前进、终态后一律拒)—— 桩只替换 IPC 运输,不替身阶段规则。 */
let stages: HubRequestStages
let stageOk = true
let installScript: InstallScript = []
const disposers: Array<() => void> = []
const neverSettle = () => new Promise<never>(() => {})

beforeEach(() => {
  held.clear()
  stages = createHubRequestStages({ log: () => {} })
  intents = []
  stageOk = true
  installScript = []
  runtime.resetHarness()
  document.body.replaceChildren()
  const ext: Record<string, unknown> = {
    hubRequestStage: async (input: { stage: string; reason?: string }) => {
      await held.get(input.stage)?.promise
      const recorded = stageOk ? stages.record(input) : { ok: false as const, reason: "refused by the test" }
      runtime.timeline.push(`stage:${input.stage}${input.reason ? `(${input.reason})` : ""}${recorded.ok ? "" : "!refused"}`)
      return recorded
    },
    remoteCatalog: async () => ({ source: "remote", catalog: { version: "9.9.9", entries: ENTRIES } }),
    advisoryActive: async () => ({ ids: [], fresh: true }),
    checkRuntime: async () => ({ ok: true }),
    installCatalog: async (intent: Record<string, unknown>) => {
      intents.push(intent)
      await held.get("install")?.promise
      runtime.timeline.push("install")
      const result = (installScript.shift() ?? { ok: false, reason: "unscripted" }) as { ok?: boolean; stage?: string; reason?: string }
      // 与 main 的 ext-install-catalog 外层同形:带 hubRequestId 的一次安装落定 ⇒ main 自己记 committed / failed(授权暂停不算落定)
      const id = intent.hubRequestId
      if (typeof id === "string" && result.ok) stages.settleInstall(id, { ok: true, catalogId: String(intent.catalogId), scope: "global" })
      else if (typeof id === "string" && result.stage !== "authorize") stages.settleInstall(id, { ok: false, reason: result.reason ?? "install failed" })
      return result
    },
    listInstalls: async () => ({ global: [], project: [] }),
    hubView: async () => ({ directory: "/", rows: [], warnings: [] }),
    sessionGrants: async () => ({ grants: [] }),
    factorySkillIds: async () => [],
    inventoryView: async () => ({ rows: [] }),
  }
  const fallback = (name: string) => (name.startsWith("on") ? () => () => {} : () => neverSettle())
  Object.defineProperty(window, "api", {
    configurable: true,
    writable: true,
    value: new Proxy(
      { ext: new Proxy(ext, { get: (target, name: string) => target[name] ?? fallback(name) }) },
      {
        get: (target, name: string) =>
          name in target ? (target as Record<string, unknown>)[name] : new Proxy({}, { get: (_t, n: string) => fallback(n) }),
      },
    ),
  })
})
afterEach(async () => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  await flush()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}; timeline=${JSON.stringify(timeline())}`)
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.Harness(), host))
}

function hubRequest(catalogId: string, requestId = "req_hub_watcher_01"): PermissionV2Request {
  return {
    id: `per_${requestId}`,
    sessionID: "ses_hub_1",
    fingerprint: "b".repeat(64),
    subject: { kind: "agent", id: "build" },
    action: "hub_install",
    resources: [catalogId],
    scope: { kind: "session", sessionID: "ses_hub_1" },
    expiresAt: null,
    metadata: { alphaHub: { catalogId, requestId } },
  } as PermissionV2Request
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)
const replies = () => runtime.replyCalls.map((call) => call.command.decision)
const diff = { key: "mcp:notes", previous: null, requested: ["process:spawn"], added: ["process:spawn"], removed: [], requiresConfirmation: true }

describe("HubInstallWatcher:定制中心自己的确认框,先记阶段再回审批", () => {
  test("确认(含授权第二阶段):confirming → submitted → 两次出站都带 hubRequestId、密钥只在 grants → once;通用框不出现", async () => {
    installScript = [{ ok: false, stage: "authorize", authorization: [diff] }, { ok: true, kind: "mcp", name: "notes" }]
    mount()
    await flush()
    runtime.ask(hubRequest("mcp:notes"))
    await until(() => !!document.querySelector(".alpha-ext-key-input"), "the confirm box with the masked key input")
    expect(document.querySelector("[data-hub-agent-request='req_hub_watcher_01']")?.textContent).toBe(zh["alpha.ext.hubAgentRequested"])
    expect(document.querySelectorAll("[data-permission-fact]")).toHaveLength(0)
    const input = document.querySelector<HTMLInputElement>(".alpha-ext-key-input")!
    expect(input.type).toBe("password")
    input.value = SECRET
    input.dispatchEvent(new Event("input", { bubbles: true }))
    button(zh["alpha.ext.confirmInstall"])!.click()
    await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage in the same box")
    // main 在第二次 install IPC 里记 committed —— 它没回来之前不得回审批
    const release = hold("install")
    button(zh["alpha.ext.authz.confirmInstall"])!.click()
    await flush(8)
    expect(replies()).toEqual([])
    release()
    await until(() => replies().length > 0, "the reply")
    expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "install", "reply:once"])
    expect(intents.map((intent) => intent.hubRequestId)).toEqual(["req_hub_watcher_01", "req_hub_watcher_01"])
    expect(intents.map((intent) => (intent.grants as { secrets?: Record<string, string> })?.secrets?.NOTES_TOKEN)).toEqual([SECRET, SECRET])
    expect(intents[1]!.authorization).toEqual({ confirmed: { "mcp:notes": ["process:spawn"] } })
    // 应答命令没有自由载荷:密钥结构上回不到工具
    expect(JSON.stringify(runtime.replyCalls)).not.toContain(SECRET)
  })

  test("取消:还在确认阶段 ⇒ declined → reject;零出站", async () => {
    mount()
    await flush()
    runtime.ask(hubRequest("skill:writer", "req_hub_watcher_02"))
    await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box")
    const release = hold("declined")
    button(zh["alpha.ext.cancel"])!.click()
    await flush(8)
    expect(replies()).toEqual([])
    release()
    await until(() => replies().length > 0, "the reply")
    expect(timeline()).toEqual(["stage:confirming", "stage:declined", "reply:reject"])
    expect(intents).toHaveLength(0)
  })

  test("授权第二阶段才取消(已 submitted)⇒ 记 failed(authorization canceled)→ reject,不是 declined", async () => {
    installScript = [{ ok: false, stage: "authorize", authorization: [diff] }]
    mount()
    await flush()
    runtime.ask(hubRequest("skill:writer", "req_hub_watcher_03"))
    await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box")
    button(zh["alpha.ext.confirmInstall"])!.click()
    await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage")
    const release = hold("failed")
    button(zh["alpha.ext.cancel"])!.click()
    await flush(8)
    expect(replies()).toEqual([])
    release()
    await until(() => replies().length > 0, "the reply")
    expect(timeline()).toEqual([
      "stage:confirming",
      "stage:submitted",
      "install",
      "stage:failed(authorization canceled)",
      "reply:reject",
    ])
  })

  test("提交失败:install 返回 !ok 之后才记 failed;框里显示原因;用户关框才 reject", async () => {
    installScript = [{ ok: false, reason: "connect-failed" }]
    mount()
    await flush()
    runtime.ask(hubRequest("skill:writer", "req_hub_watcher_04"))
    await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box")
    const release = hold("failed")
    button(zh["alpha.ext.confirmInstall"])!.click()
    await flush(8)
    expect(document.querySelector("[data-hub-agent-failure]")).toBeNull()
    release()
    await until(() => !!document.querySelector("[data-hub-agent-failure]"), "the failure shown in the box")
    // main 在 install IPC 里已记 failed(终态),守望者随后那一笔被拒 —— 无害,也证明它记在 IPC 返回之后
    expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "stage:failed(connect-failed)!refused"])
    expect(replies()).toEqual([])
    button(zh["alpha.ext.close"])!.click()
    await until(() => replies().length > 0, "the reply")
    expect(replies()).toEqual(["reject"])
  })

  test("记不上 confirming ⇒ 不弹框、reject;目录里没有这一条 ⇒ 记 failed、不出确认按钮、reject", async () => {
    stageOk = false
    mount()
    await flush()
    runtime.ask(hubRequest("skill:writer", "req_hub_watcher_05"))
    await until(() => replies().length > 0, "the reply")
    expect(replies()).toEqual(["reject"])
    expect(button(zh["alpha.ext.confirmInstall"])).toBeUndefined()
    expect(intents).toHaveLength(0)

    stageOk = true
    runtime.resetHarness()
    disposers.splice(0).reverse().forEach((dispose) => dispose())
    mount()
    await flush()
    runtime.ask(hubRequest("skill:not-in-catalog", "req_hub_watcher_06"))
    await until(() => replies().length > 0, "the reply")
    expect(timeline()).toEqual(["stage:confirming", "stage:failed(not in this app's verified catalog)", "reply:reject"])
    expect(stages.get("req_hub_watcher_06")).toMatchObject({ stage: "failed" })
    expect(replies()).toEqual(["reject"])
    expect(button(zh["alpha.ext.confirmInstall"])).toBeUndefined()
  })

  // 审计 R1 Major 3:确认框开着时 SSE 重连 ⇒ feed 不就绪(审批面卸载)⇒ 读回同一个请求再挂载。不得因为 main 拒绝
  // confirming → confirming 就替用户回 reject;同一个 requestId 接着上一次的阶段走,框还在,确认之后照常装、照常回 once。
  test("确认框开着时 SSE 重连(卸载再挂载):零 reject、confirming 只记一次、框还在;之后确认照常装完回 once", async () => {
    installScript = [{ ok: true, kind: "skill", name: "writer" }]
    mount()
    await flush()
    runtime.ask(hubRequest("skill:writer", "req_hub_watcher_07"))
    await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box")
    runtime.reconnect()
    await until(() => !button(zh["alpha.ext.confirmInstall"]), "the surface to unmount while the feed reloads")
    await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box after the remount")
    await flush(8)
    expect(replies()).toEqual([])
    expect(timeline()).toEqual(["stage:confirming"])
    button(zh["alpha.ext.confirmInstall"])!.click()
    await until(() => replies().length > 0, "the reply")
    expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "reply:once"])
    expect(stages.get("req_hub_watcher_07")).toMatchObject({ stage: "committed" })
  })

  test("对照:不带 alphaHub 的请求照旧是通用五栏审批框,不进守望者", async () => {
    mount()
    await flush()
    runtime.ask({ ...hubRequest("skill:writer"), id: "per_plain", action: "bash", resources: ["ls"], metadata: {} } as PermissionV2Request)
    await until(() => document.querySelectorAll("[data-permission-fact]").length === 5, "the generic dialog")
    expect(document.querySelector("[data-hub-agent-request]")).toBeNull()
    expect(timeline()).toEqual([])
  })
})
