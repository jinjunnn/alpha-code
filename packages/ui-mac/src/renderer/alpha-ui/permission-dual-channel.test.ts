// #668 半场 A —— 审批面同时消费 v1 与 v2 两条通道的**端到端行为闸门**。
//
// 这道闸保证的事:**v1 引擎发出的审批请求真的会在界面上出现,并且真的能批准 / 能拒绝**;
// 同时 v2 读写两侧一字未损。
//
// 判据形状按 ADR-037 决策 4(#652 事故立的规矩,那次六种假闸门全亮过绿灯):
//   · 跑生产代码 —— 挂 `createPermissionSurfaceMount(PermissionWatcher)`,即 app.tsx 真调的
//     那个工厂 + 生产 PermissionWatcher + 生产 PermissionDialog。替身只有宿主上下文
//     (useParams/useSDK/useSync)与传输录音;
//   · 走用户入口 —— 点渲染出来的那三个决定按钮,不直接调内部函数;
//   · 断言可观测结果 —— 渲染出的 DOM(对话框在不在、五条事实是什么)+ **真的发出去的那个
//     请求**(落在哪条通道、requestID/reply 是什么);
//   · 反向验证 —— 撤掉 v1 订阅/适配,这些用例必须转红(结论写进 PR)。
//
// 明确**不**作为判据:源码文本、typecheck、整包绿、schema 有字段、HTTP 200。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type * as RuntimeModule from "./permission-dual-channel-test-runtime"

const appSrc = resolve(import.meta.dir, "../../../../app/src")
const stub = join(import.meta.dir, "permission-dual-channel-stub.ts")
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-permission-dual-channel-"))

await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  resolve: {
    alias: [
      // 宿主上下文替身 —— 被测的接线点本体不动。
      { find: /^@\/context\/sdk$/, replacement: stub },
      { find: /^@\/context\/sync$/, replacement: stub },
      { find: /^@\/context\/server-sync$/, replacement: stub },
      { find: /^@solidjs\/router$/, replacement: stub },
      // 适配器与 i18n 用真身(`@/` 在本次 build 里没有默认 alias,显式指过去)。
      { find: /^@\/context\/permission-v1-adapter$/, replacement: join(appSrc, "context/permission-v1-adapter.ts") },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "permission-dual-channel-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "permission-dual-channel-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()

const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "permission-dual-channel-test-runtime.js")).href
)) as typeof RuntimeModule

/** v1 引擎真实发出的那种请求:external_directory 是 #668 点名的高频挂起面
 *  (build agent 默认 ruleset 里唯一还活着的高频 ask 门 —— 任何 worktree 外的文件访问)。 */
const v1Request = {
  id: "per_v1_dual_1",
  sessionID: runtime.HARNESS.sessionID,
  permission: "external_directory",
  patterns: ["/Users/someone/Downloads/*"],
  metadata: { filepath: "/Users/someone/Downloads/report.csv" },
  always: ["/Users/someone/Downloads/*"],
  tool: { messageID: runtime.HARNESS.messageID, callID: "call_v1_1" },
}

const v2Request = {
  id: "per_v2_dual_1",
  sessionID: runtime.HARNESS.sessionID,
  fingerprint: "b".repeat(64),
  subject: { kind: "agent", id: "build-reviewer" },
  action: "bash",
  resources: ["pwd"],
  scope: { kind: "session", sessionID: runtime.HARNESS.sessionID },
  expiresAt: null,
  save: ["pwd"],
}

beforeEach(() => {
  runtime.resetDualChannelHarness()
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

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.DualChannelHarness(), host))
}

const dialog = () => document.querySelector("[role='dialog']")
const fact = (name: string) => document.querySelector(`[data-permission-fact="${name}"]`)?.textContent ?? ""
const button = (decision: string) =>
  document.querySelector<HTMLButtonElement>(`[data-permission-decision="${decision}"]`)

async function mounted() {
  mount()
  await flush()
  await flush()
}

describe("#668 审批面双通道:v1 请求真的出现、真的能批准/能拒绝", () => {
  test("v1 permission.asked → 审批对话框出现,五条事实来自 v1 请求本身", async () => {
    await mounted()
    expect(dialog()).toBeNull()

    runtime.emit("permission.asked", v1Request)
    await flush()

    // ① 真的出现了。这一条就是 #668 的缺陷本身:修复前这里恒为 null,回合无声挂起。
    expect(dialog()).not.toBeNull()
    // ② 事实来自 v1 请求,不是占位:action = 被请求的能力,resources = 具体 glob,
    //    subject = 发起这次工具调用的档位(由 tool.messageID 还原)。
    expect(fact("action")).toContain("external_directory")
    expect(fact("resources")).toContain("/Users/someone/Downloads/*")
    expect(fact("subject")).toContain(runtime.HARNESS.agent)
    expect(fact("scope")).toContain(runtime.HARNESS.sessionID)
    // ③ 事实核实通过 ⇒ 没有被自动拒绝(自动拒绝会立刻提交一个 reject 并关掉对话框)。
    expect(runtime.permissionTraffic()).not.toContain("permission.reply")
  })

  test("v1 请求点「允许一次」→ 决定真的发到 v1 通道,对话框关闭", async () => {
    await mounted()
    runtime.emit("permission.asked", v1Request)
    await flush()

    button("once")!.click()
    await flush()

    const reply = runtime.sdkCalls.find((call) => call.path === "permission.reply")
    expect(reply).toBeDefined()
    expect(reply!.args[0]).toMatchObject({ requestID: v1Request.id, reply: "once" })
    // 没有走错通道:v1 请求的决定绝不能发去 v2 端点(那边根本不认识这个 id)。
    expect(runtime.permissionTraffic()).not.toContain("v2.session.permission.reply")

    expect(dialog()).toBeNull()
  })

  test("v1 请求点「拒绝」→ reply=reject 发到 v1 通道", async () => {
    await mounted()
    runtime.emit("permission.asked", v1Request)
    await flush()

    button("reject")!.click()
    await flush()

    const reply = runtime.sdkCalls.find((call) => call.path === "permission.reply")
    expect(reply!.args[0]).toMatchObject({ requestID: v1Request.id, reply: "reject" })
    expect(dialog()).toBeNull()
  })

  test("v1 快照(不经事件)同样呈现 —— 重连/首次打开会话时挂着的请求不会丢", async () => {
    runtime.seedPendingV1([v1Request])
    await mounted()

    expect(dialog()).not.toBeNull()
    expect(fact("action")).toContain("external_directory")
  })

  test("v1 的「始终允许」保持禁用 —— 不对授权持久性说谎", async () => {
    await mounted()
    runtime.emit("permission.asked", v1Request)
    await flush()

    // v1 的 always 只写进引擎进程内存(重启即失),而按钮文案承诺的是"为当前项目创建永久授权"。
    // 适配器刻意不投影 save ⇒ 这个按钮禁用;「允许一次」「拒绝」照常可用。
    expect(button("always")!.disabled).toBe(true)
    expect(button("once")!.disabled).toBe(false)
    expect(button("reject")!.disabled).toBe(false)
  })

  test("v1 提交失败 = 不假定放行:对话框留在原地并显示失败", async () => {
    await mounted()
    runtime.emit("permission.asked", v1Request)
    await flush()

    runtime.failV1Reply()
    button("once")!.click()
    await flush()

    expect(dialog()).not.toBeNull()
    expect(document.querySelector("[data-kind='failed']")).not.toBeNull()
  })

  test("引擎广播的 v1 permission.replied 会收回卡片(超时具名失败也走这条路)", async () => {
    await mounted()
    runtime.emit("permission.asked", v1Request)
    await flush()
    expect(dialog()).not.toBeNull()

    // #668 半场 E:期限到达时引擎广播的就是这条 reject 回执。
    runtime.emit("permission.replied", {
      sessionID: runtime.HARNESS.sessionID,
      requestID: v1Request.id,
      reply: "reject",
    })
    await flush()

    expect(dialog()).toBeNull()
  })

  test("agent 还原不出来时 fail-closed 拒绝 —— 但绝不静默丢弃请求", async () => {
    runtime.dropMessages()
    await mounted()
    runtime.emit("permission.asked", { ...v1Request, tool: undefined })
    await flush()

    // 事实核不实 ⇒ PermissionDialog 自动提交 reject(既有安全语义,v1 一视同仁)。
    // 关键是它**进了呈现面**并产生了一个决定,而不是像修复前那样谁都不知道它存在。
    const reply = runtime.sdkCalls.find((call) => call.path === "permission.reply")
    expect(reply!.args[0]).toMatchObject({ requestID: v1Request.id, reply: "reject" })
  })
})

describe("#668 回归:v2 读写两侧不得被破坏", () => {
  test("v2 permission.v2.asked 照常呈现,决定照常发到 v2 通道", async () => {
    await mounted()
    runtime.emit("permission.v2.asked", v2Request)
    await flush()

    expect(dialog()).not.toBeNull()
    expect(fact("action")).toContain("bash")
    expect(fact("subject")).toContain("build-reviewer")

    button("once")!.click()
    await flush()

    const reply = runtime.sdkCalls.find((call) => call.path === "v2.session.permission.reply")
    expect(reply).toBeDefined()
    expect(reply!.args[0]).toMatchObject({ requestID: v2Request.id })
    // v2 的决定绝不能被路由去 v1。
    expect(runtime.permissionTraffic()).not.toContain("permission.reply")
    expect(dialog()).toBeNull()
  })

  test("#561 被 store 观察过的 v2 请求:仍然呈现,决定仍是 once 而不是静默拒绝", async () => {
    // 这条挂的是生产接线点 createPermissionSurfaceMount(PermissionWatcher)。#561 的缺陷在于
    // 严格键集核验用 Reflect.ownKeys,会把 solid store 盖在原始对象上的非枚举符号键当成
    // 「wire 上多出来的字段」⇒ 核不实 ⇒ 自动拒绝。断言落在真的发出去的那个决定上。
    const observed = runtime.observeThroughStore(JSON.parse(JSON.stringify(v2Request)) as typeof v2Request)
    expect(Object.getOwnPropertySymbols(observed.subject).length).toBeGreaterThan(0)
    expect(Object.keys(observed.subject)).toEqual(["kind", "id"])

    await mounted()
    runtime.emit("permission.v2.asked", observed)
    await flush()

    expect(dialog()).not.toBeNull()
    expect(fact("subject")).toContain("build-reviewer")
    // 自动拒绝会立刻提交一个 reject 并关掉对话框 —— 这里必须一条审批流量都还没发生。
    expect(runtime.permissionTraffic()).not.toContain("v2.session.permission.reply")

    button("once")!.click()
    await flush()

    const reply = runtime.sdkCalls.find((call) => call.path === "v2.session.permission.reply")
    expect(reply).toBeDefined()
    expect(reply!.args[0]).toMatchObject({
      requestID: v2Request.id,
      permissionV2DecisionCommand: { decision: "once" },
    })
    expect(dialog()).toBeNull()
  })

  test("v2 快照与 v1 快照合并呈现,两条通道各自的 id 都在", async () => {
    runtime.seedPendingV1([v1Request])
    runtime.seedPendingV2([v2Request])
    await mounted()

    // 头条呈现 v2(list 合并顺序 v2→v1);决定掉一条,下一条紧接着呈现 —— 两条都没丢。
    expect(fact("action")).toContain("bash")
    button("once")!.click()
    await flush()
    expect(fact("action")).toContain("external_directory")
  })

  test("fail-closed:任一通道快照读不到 ⇒ 零呈现、零放行", async () => {
    runtime.seedPendingV2([v2Request])
    runtime.failV1List()
    await mounted()

    expect(dialog()).toBeNull()
    expect(runtime.permissionTraffic()).not.toContain("v2.session.permission.reply")
    expect(runtime.permissionTraffic()).not.toContain("permission.reply")
  })
})
