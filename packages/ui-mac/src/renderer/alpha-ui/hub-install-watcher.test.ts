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

// 审计 R1 Major 2:签名包(main 评估过的 CatalogPackageViewV1,随 remoteCatalog 进 renderer 的 catalog().packages)
const PACKAGE_VIEW = {
  catalogId: "package:alpha-first",
  verdict: "compatible",
  action: { kind: "install", enabled: true, reasonCode: "package-compatible" },
  components: [{ componentId: "skill:alpha-first", role: "root", required: true, included: true, skipReasonCode: null }],
  prerequisites: { status: "ready", items: [] },
  presentation: { displayName: "Code Puppy install check", description: "checks a package install", version: "1.0.0" },
}
const PACKAGE_PREVIEW = {
  attemptId: "admission-attempt-1",
  binding: { snapshotDigest: "s".repeat(64), envelopeDigest: "e".repeat(64), graphDigest: "g".repeat(64) },
  plan: {
    packageId: "package:alpha-first",
    version: "1.0.0",
    scope: { scope: "global" },
    items: [
      {
        included: true,
        componentId: "skill:alpha-first",
        role: "root",
        required: true,
        key: "skill:alpha-first",
        kind: "skill",
        name: "alpha-first",
        manifestDigest: "m",
        payloadDigest: "p",
        capabilities: ["fs:read"],
        prerequisites: [],
        operations: ["write-generation"],
      },
    ],
  },
  items: [{ key: "skill:alpha-first", previous: null, requested: ["fs:read"], added: ["fs:read"], removed: [], requiresConfirmation: true }],
  update: { operation: "install", components: [] },
}

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
    remoteCatalog: async () => ({ source: "remote", catalog: { version: "9.9.9", entries: ENTRIES, packages: [PACKAGE_VIEW] } }),
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

  // 审计 R1 Major 2:签名包也走定制中心**同一个**确认控制器(package 预览 + 授权 + 前置条件输入),出站是 installCatalogIntent
  // 那唯一一个出口;两次驱动都带 hubRequestId(首驱只取预览,main 不落定;确认后的那一趟由 main 记 committed)。
  test("包:agent 请求 package:alpha-first ⇒ 先取预览再弹包确认框 ⇒ 确认 ⇒ 带授权与 hubRequestId 的第二趟 ⇒ once", async () => {
    installScript = [{ ok: false, stage: "authorize", reason: "authorization required", packageAuthorization: PACKAGE_PREVIEW }, { ok: true, kind: "skill", name: "alpha-first" }]
    mount()
    await flush()
    runtime.ask(hubRequest("package:alpha-first", "req_hub_watcher_08"))
    await until(() => !!document.querySelector("[data-package-authorization='package:alpha-first']"), "the package confirm box")
    expect(document.querySelector("[data-plan-component='skill:alpha-first']")).not.toBeNull()
    expect(intents[0]).toMatchObject({ catalogId: "package:alpha-first", hubRequestId: "req_hub_watcher_08", scope: { scope: "global" } })
    expect(intents[0]!.authorization).toBeUndefined()
    expect(replies()).toEqual([])
    button(zh["alpha.ext.confirmInstall"])!.click()
    await until(() => replies().length > 0, "the reply")
    expect(intents[1]).toMatchObject({
      catalogId: "package:alpha-first",
      attemptId: "admission-attempt-1",
      hubRequestId: "req_hub_watcher_08",
      authorization: { confirmed: { "skill:alpha-first": ["fs:read"] }, binding: PACKAGE_PREVIEW.binding },
    })
    expect(timeline()).toEqual(["stage:confirming", "install", "stage:submitted", "install", "reply:once"])
    expect(stages.get("req_hub_watcher_08")).toMatchObject({ stage: "committed" })
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

// ── 状态表(审计 R2:阶段 × 事件,与 hub-install-watcher.tsx 头注那张表一格对一格)────────────────────────────────────
// 每一格:生产组件(PermissionWatcher → HubInstallWatcher → install-confirm → use-extensions)+ main 的生产阶段簿
// (createHubRequestStages);「重挂载」= 生产 feed 收到 connected 后重读快照(期间不就绪、审批面卸载,读回同一请求再挂载)。
// 表里写「—」的格到不了(该阶段没有那个事件),不在这里。

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** 重挂载:SSE 重连 ⇒ feed 不就绪(卸载)⇒ 读回同一个请求(再挂载)。 */
async function remount() {
  runtime.reconnect()
  await sleep(80)
  await flush(4)
}
async function openBox(catalogId: string, requestId: string) {
  mount()
  await flush()
  runtime.ask(hubRequest(catalogId, requestId))
  await until(() => !!button(zh["alpha.ext.confirmInstall"]) || !!document.querySelector("[data-package-authorization]"), "the confirm box")
}
const boxShown = () => !!document.querySelector("[data-hub-agent-request]")

type Cell = { phase: string; event: string; run: () => Promise<void> }
const CELLS: Cell[] = [
  {
    phase: "starting",
    event: "重挂载",
    run: async () => {
      mount()
      await flush()
      const release = hold("confirming")
      runtime.ask(hubRequest("skill:writer", "req_cell_starting_remount"))
      await flush(4)
      await remount()
      expect(boxShown()).toBe(false)
      release()
      await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box once confirming is recorded")
      await flush(8)
      expect(timeline()).toEqual(["stage:confirming"])
      expect(replies()).toEqual([])
    },
  },
  {
    phase: "starting",
    event: "安装落定(包的取预览首驱直接落定)",
    run: async () => {
      installScript = [{ ok: true, kind: "skill", name: "alpha-first" }]
      mount()
      await flush()
      runtime.ask(hubRequest("package:alpha-first", "req_cell_starting_settled"))
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "install", "reply:once"])
      expect(stages.get("req_cell_starting_settled")).toMatchObject({ stage: "committed" })
    },
  },
  {
    phase: "confirming",
    event: "重挂载",
    run: async () => {
      installScript = [{ ok: true, kind: "skill", name: "writer" }]
      await openBox("skill:writer", "req_cell_confirming_remount")
      runtime.reconnect()
      await until(() => !button(zh["alpha.ext.confirmInstall"]), "the surface to unmount while the feed reloads")
      await until(() => !!button(zh["alpha.ext.confirmInstall"]), "the confirm box after the remount")
      await flush(8)
      expect(replies()).toEqual([])
      expect(timeline()).toEqual(["stage:confirming"])
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "reply:once"])
    },
  },
  {
    phase: "confirming",
    event: "用户取消",
    run: async () => {
      await openBox("skill:writer", "req_cell_confirming_cancel")
      const release = hold("declined")
      button(zh["alpha.ext.cancel"])!.click()
      await flush(8)
      expect(replies()).toEqual([])
      release()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:declined", "reply:reject"])
      expect(intents).toHaveLength(0)
    },
  },
  {
    phase: "authorizing",
    event: "重挂载",
    run: async () => {
      installScript = [{ ok: false, stage: "authorize", authorization: [diff] }, { ok: true, kind: "mcp", name: "notes" }]
      await openBox("mcp:notes", "req_cell_authorizing_remount")
      const input = document.querySelector<HTMLInputElement>(".alpha-ext-key-input")!
      input.value = SECRET
      input.dispatchEvent(new Event("input", { bubbles: true }))
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage")
      runtime.reconnect()
      await until(() => !button(zh["alpha.ext.authz.confirmInstall"]), "the surface to unmount")
      await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage after the remount")
      expect(replies()).toEqual([])
      button(zh["alpha.ext.authz.confirmInstall"])!.click()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "install", "reply:once"])
      expect(intents[1]).toMatchObject({
        hubRequestId: "req_cell_authorizing_remount",
        grants: { secrets: { NOTES_TOKEN: SECRET } },
        authorization: { confirmed: { "mcp:notes": ["process:spawn"] } },
      })
    },
  },
  {
    phase: "authorizing",
    event: "用户取消",
    run: async () => {
      installScript = [{ ok: false, stage: "authorize", authorization: [diff] }]
      await openBox("skill:writer", "req_cell_authorizing_cancel")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage")
      const release = hold("failed")
      button(zh["alpha.ext.cancel"])!.click()
      await flush(8)
      expect(replies()).toEqual([])
      release()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "stage:failed(authorization canceled)", "reply:reject"])
    },
  },
  {
    phase: "executing",
    event: "重挂载",
    run: async () => {
      installScript = [{ ok: true, kind: "skill", name: "writer" }]
      await openBox("skill:writer", "req_cell_executing_remount")
      const release = hold("install")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await flush(4)
      await remount()
      expect(boxShown()).toBe(false)
      expect(replies()).toEqual([])
      release()
      await until(() => replies().length > 0, "the reply from the remounted surface")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "reply:once"])
      expect(stages.get("req_cell_executing_remount")).toMatchObject({ stage: "committed" })
    },
  },
  {
    phase: "executing",
    event: "用户取消(条目:确认后 submitted 还没记完就重连)",
    run: async () => {
      // 审计 R3:确认那一下就进 executing(先于 submitted IPC)⇒ 重挂载只等结局,恢复不出一个可操作的确认框;
      // 没有框就没有取消 —— 结局照常走完(这里 install 又要授权 ⇒ 授权框,用户这时才有得选)。
      installScript = [{ ok: false, stage: "authorize", authorization: [diff] }, { ok: true, kind: "skill", name: "writer" }]
      await openBox("skill:writer", "req_cell_executing_cancel_entry")
      const release = hold("submitted")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await flush(4)
      expect(button(zh["alpha.ext.cancel"])?.disabled).toBe(true)
      await remount()
      expect(boxShown()).toBe(false)
      expect(button(zh["alpha.ext.cancel"])).toBeUndefined()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flush(4)
      release()
      await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage once the install asks for it")
      expect(replies()).toEqual([])
      button(zh["alpha.ext.authz.confirmInstall"])!.click()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "install", "reply:once"])
      expect(intents).toHaveLength(2)
    },
  },
  {
    phase: "executing",
    event: "用户取消(包:确认后 submitted 还没记完就重连)",
    run: async () => {
      installScript = [
        { ok: false, stage: "authorize", reason: "authorization required", packageAuthorization: PACKAGE_PREVIEW },
        { ok: true, kind: "skill", name: "alpha-first" },
      ]
      await openBox("package:alpha-first", "req_cell_executing_cancel_package")
      const release = hold("submitted")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await flush(4)
      await remount()
      expect(boxShown()).toBe(false)
      expect(button(zh["alpha.ext.cancel"])).toBeUndefined()
      release()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "install", "stage:submitted", "install", "reply:once"])
      expect(intents).toHaveLength(2)
      expect(stages.get("req_cell_executing_cancel_package")).toMatchObject({ stage: "committed" })
    },
  },
  {
    phase: "executing",
    event: "安装落定 committed",
    run: async () => {
      installScript = [{ ok: true, kind: "skill", name: "writer" }]
      await openBox("skill:writer", "req_cell_executing_committed")
      const release = hold("install")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await flush(8)
      expect(replies()).toEqual([])
      release()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "reply:once"])
    },
  },
  {
    phase: "executing",
    event: "安装落定 failed",
    run: async () => {
      installScript = [{ ok: false, reason: "connect-failed" }]
      await openBox("skill:writer", "req_cell_executing_failed")
      const release = hold("failed")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await flush(8)
      expect(document.querySelector("[data-hub-agent-failure]")).toBeNull()
      release()
      await until(() => !!document.querySelector("[data-hub-agent-failure]"), "the failure shown in the box")
      // main 在 install IPC 里已记 failed(终态),守望者随后那一笔被拒 —— 无害,也证明它记在 IPC 返回之后
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "stage:failed(connect-failed)!refused"])
      expect(replies()).toEqual([])
    },
  },
  {
    phase: "executing",
    event: "安装落定 又要授权",
    run: async () => {
      installScript = [{ ok: false, stage: "authorize", authorization: [diff] }, { ok: true, kind: "skill", name: "writer" }]
      await openBox("skill:writer", "req_cell_executing_authorize")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage in the same box")
      expect(replies()).toEqual([])
      expect(stages.get("req_cell_executing_authorize")).toMatchObject({ stage: "submitted" })
      // 落定成「又要授权」= 进度真的转进 authorizing(不只是这一次挂载的框里换了视图):重挂载后授权框还在
      await remount()
      await until(() => !!button(zh["alpha.ext.authz.confirmInstall"]), "the authorization stage after a remount")
      button(zh["alpha.ext.authz.confirmInstall"])!.click()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "install", "reply:once"])
    },
  },
  {
    phase: "failed",
    event: "重挂载",
    run: async () => {
      installScript = [{ ok: false, reason: "connect-failed" }]
      await openBox("skill:writer", "req_cell_failed_remount")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => !!document.querySelector("[data-hub-agent-failure]"), "the failure shown in the box")
      runtime.reconnect()
      await until(() => !document.querySelector("[data-hub-agent-failure]"), "the surface to unmount")
      await until(() => !!document.querySelector("[data-hub-agent-failure]"), "the failure shown again after the remount")
      await flush(8)
      expect(timeline().filter((line) => line.startsWith("stage:failed"))).toHaveLength(1)
      expect(replies()).toEqual([])
      button(zh["alpha.ext.close"])!.click()
      await until(() => replies().length > 0, "the reply")
      expect(replies()).toEqual(["reject"])
    },
  },
  {
    phase: "failed",
    event: "用户关框",
    run: async () => {
      installScript = [{ ok: false, reason: "connect-failed" }]
      await openBox("skill:writer", "req_cell_failed_close")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => !!document.querySelector("[data-hub-agent-failure]"), "the failure shown in the box")
      await flush(8)
      expect(replies()).toEqual([])
      button(zh["alpha.ext.close"])!.click()
      await until(() => replies().length > 0, "the reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "stage:failed(connect-failed)!refused", "reply:reject"])
    },
  },
  {
    phase: "decided",
    event: "重挂载",
    run: async () => {
      // 审计 R2 #2:决定已做(取消)、declined 还没记完时重连 ⇒ 旧 feed 不就绪拒绝回复;重挂载必须经当前 feed 补回。
      await openBox("skill:writer", "req_cell_decided_remount")
      const releaseStage = hold("declined")
      button(zh["alpha.ext.cancel"])!.click()
      await flush(4)
      const releaseList = runtime.holdList()
      runtime.reconnect()
      await flush(4)
      releaseStage()
      await flush(8)
      expect(replies()).toEqual([])
      releaseList()
      await until(() => replies().length > 0, "the reply through the reloaded feed")
      expect(timeline()).toEqual(["stage:confirming", "stage:declined", "reply:reject"])
    },
  },
  {
    phase: "decided",
    event: "回复失败",
    run: async () => {
      await openBox("skill:writer", "req_cell_decided_reply_fails")
      runtime.setReplyFails(true)
      button(zh["alpha.ext.cancel"])!.click()
      await until(() => timeline().includes("reply-failed:reject"), "the refused reply")
      await flush(8)
      expect(boxShown()).toBe(false)
      expect(replies()).toEqual([])
      runtime.setReplyFails(false)
      await remount()
      await until(() => replies().length > 0, "the retried reply")
      expect(timeline()).toEqual(["stage:confirming", "stage:declined", "reply-failed:reject", "reply:reject"])
    },
  },
  {
    phase: "replied",
    event: "重挂载",
    run: async () => {
      installScript = [{ ok: true, kind: "skill", name: "writer" }]
      await openBox("skill:writer", "req_cell_replied_remount")
      button(zh["alpha.ext.confirmInstall"])!.click()
      await until(() => replies().length > 0, "the reply")
      // 另一个审批面(换了路由、新的 feed)又收到同一个请求的迟到事件 ⇒ 同一 requestId 已回过:不显示、不再回
      mount()
      await flush()
      runtime.ask(hubRequest("skill:writer", "req_cell_replied_remount"))
      await flush(8)
      await sleep(40)
      expect(boxShown()).toBe(false)
      expect(timeline()).toEqual(["stage:confirming", "stage:submitted", "install", "reply:once"])
    },
  },
]

describe("HubInstallWatcher 状态表(阶段 × 事件,审计 R2)", () => {
  for (const cell of CELLS) test(`${cell.phase} × ${cell.event}`, cell.run)
})

