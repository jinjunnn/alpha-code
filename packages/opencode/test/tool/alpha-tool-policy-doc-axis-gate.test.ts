// alpha-code#1129(reopen)—— 策略**文档轴**抵达目录与执行咽喉的常驻闸(#724 §2/§4/§5/§6)。
//
// 与 `alpha-tool-policy-execution-gate.test.ts` 的分工:那份量 **ruleset 轴**(config/session
// 的 identity 规则)在 identityGate 上的语义;本文件量 **文档轴** —— 四类默认、用户 selector
// (真 store,生产 `setRecord`/`removeRecord`/`reset` 写入)、binding guard、quarantine ——
// 以及 §6 那句最容易做假的话:「executor 必须在调用时重读」。
//
// 判据纪律(同 #725/#1135 口径):
//   ① 只驱动生产入口:`SessionTools.resolve()` 返回对象的 `.execute()` 与
//      `LLMRequestPrep.prepare()` 返回的 `tools`;
//   ② 期望字面量手写(canonical 串不从 canonicalToolIdentity() 导出);
//   ③ 副作用用真实计数:真 MCP server 的 `tools/call`、真插件 marker、真 builtin 落盘;
//   ④ 重读判据是**变异式**的:目录发出、工具对象已在手里之后才改策略 —— 一个「executor
//      用目录快照」的错误实现在 ①-③ 下全绿,只有 ④ 能翻它(断言的粒度不能比缺陷粗一格)。
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Exit, Cause } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { AlphaToolPolicy, policyFilePath } from "@/permission/alpha-tool-policy"
import { AlphaToolInventory } from "@/permission/alpha-tool-inventory"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ── 手写的期望字面量(纪律②)────────────────────────────────────────────────────
const ID_MCP_PAID = "mcp:policy:paid_action"
const ALIAS_MCP_PAID = "policy_paid_action"
const ALIAS_PLUGIN_PROBE = "probe"
const ALIAS_BUILTIN_WRITE = "write"
const ALIAS_HOST_LIST_RESOURCES = "list_mcp_resources"

function testServer() {
  const counts = { call: 0, listResources: 0 }
  const handle = Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = [
        { name: "paid_action", description: "remote paid", inputSchema: { type: "object", properties: {} } },
      ]
      const protocol = new Server(
        { name: "alpha-1129-doc-axis", version: "1.0.0" },
        { capabilities: { tools: {}, resources: {} } },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: listed }))
      protocol.setRequestHandler(CallToolRequestSchema, () => {
        counts.call += 1
        return Promise.resolve({ content: [{ type: "text" as const, text: "SIDE-EFFECT-EXECUTED" }] })
      })
      protocol.setRequestHandler(ListResourcesRequestSchema, () => {
        counts.listResources += 1
        return Promise.resolve({ resources: [{ uri: "mem://one", name: "one", mimeType: "text/plain" }] })
      })
      protocol.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
        Promise.resolve({ resourceTemplates: [] }),
      )
      protocol.setRequestHandler(ReadResourceRequestSchema, () =>
        Promise.resolve({ contents: [{ uri: "mem://one", mimeType: "text/plain", text: "resource-body" }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
      return {
        url: http.url.toString(),
        counts,
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
  return { handle, counts }
}

const remote = (url: string) => ({ type: "remote" as const, url, oauth: false as const })

const writeProbePlugin = Effect.fn("alpha1129doc.writeProbePlugin")(function* (marker: string) {
  const test = yield* TestInstance
  const dir = path.join(test.directory, ".opencode", "tool")
  yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "probe.ts"),
      [
        "import { writeFileSync } from 'node:fs'",
        "export default {",
        "  description: 'alpha 1129 doc-axis probe tool',",
        "  args: {},",
        `  execute: async () => { writeFileSync(${JSON.stringify(marker)}, 'SIDE-EFFECT-EXECUTED'); return 'ok' },`,
        "}",
        "",
      ].join("\n"),
    ),
  )
})

function testModel(): Provider.Model {
  return {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    name: "Test Model",
    api: { id: "test-model", url: "http://localhost:1/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100000, output: 10000 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "2025-01-01",
    variants: {},
  }
}

const SESSION_ID = SessionID.create()

function testSession(ruleset: PermissionV1.Ruleset): Session.Info {
  return {
    id: SESSION_ID,
    slug: "alpha-1129-doc",
    projectID: ProjectV2.ID.make("alpha-1129-doc"),
    directory: ".",
    title: "alpha-1129-doc",
    version: "0.0.0",
    time: { created: 0, updated: 0 },
    permission: ruleset as PermissionV1.Rule[],
  }
}

type Processor = Pick<
  SessionProcessor.Handle,
  "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay"
>

function testProcessor(): Processor {
  return {
    message: { id: MessageID.ascending() },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
    registerToolDisplay: (_technicalId: string, _display: ToolDisplaySnapshotV1) => {},
  } as unknown as Processor
}

const resolveTools = Effect.fn("alpha1129doc.resolveTools")(function* (ruleset: PermissionV1.Ruleset) {
  const agents = yield* Agent.Service
  return yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: testModel(),
    session: testSession(ruleset),
    processor: testProcessor(),
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
})

/** 咽喉 A:真的 `LLMRequestPrep.prepare` 返回的 tools 键集(目录)。 */
const prepareCatalogKeys = Effect.fn("alpha1129doc.prepareCatalogKeys")(function* (ruleset: PermissionV1.Ruleset) {
  const agents = yield* Agent.Service
  const plugin = yield* Plugin.Service
  const flags = yield* RuntimeFlags.Service
  const tools = yield* resolveTools(ruleset)
  const prepared = yield* LLMRequestPrep.prepare({
    user: {
      id: "msg_alpha1129doc",
      role: "user",
      sessionID: SESSION_ID,
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 0 },
    } as never,
    sessionID: SESSION_ID,
    model: testModel(),
    agent: yield* agents.defaultInfo(),
    permission: ruleset as PermissionV1.Rule[],
    system: [],
    messages: [],
    tools,
    provider: { id: "test", options: {} } as never,
    auth: undefined,
    plugin,
    toolPolicy: yield* AlphaToolPolicy.Service,
    flags,
    isWorkflow: false,
  })
  return Object.keys(prepared.tools)
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      MCP.node,
      Agent.node,
      Permission.node,
      AlphaToolPolicy.node,
      AlphaToolInventory.node,
      Plugin.node,
      Truncate.node,
      RuntimeFlags.node,
    ]),
    [
      [
        Config.node,
        TestConfig.layer({
          directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: false })],
      [AlphaToolPolicy.node, AlphaToolPolicy.layer({ account: Effect.sync(() => policyAccount) })],
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const ALLOW_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }

// 分区隔离:tmpdir instance 的 project.id 在本文件多个用例间相同 ⇒ (anonymous, workspace)
// 策略文件会跨用例泄漏(前一条写的 disabled 咬到后一条)。用生产层自己的 account 注入口
// (#1128 的测试口)给每条用例独立分区;层其余部分全是生产的。
let policyAccount = "anonymous"
const freshPolicyAccount = Effect.sync(() => {
  policyAccount = `t-${Math.random().toString(36).slice(2)}`
})

const setup = Effect.fn("alpha1129doc.setup")(function* () {
  yield* freshPolicyAccount
  const test = yield* TestInstance
  const marker = path.join(test.directory, "PLUGIN-SIDE-EFFECT.txt")
  yield* writeProbePlugin(marker)
  const server = testServer()
  const running = yield* server.handle
  const mcp = yield* MCP.Service
  yield* mcp.add("policy", remote(running.url))
  return { marker, counts: server.counts, url: running.url }
})

const markerExists = (marker: string) => Effect.promise(() => Bun.file(marker).exists())

function squashed(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit)) return undefined
  return Cause.squash(exit.cause)
}

function launch(tool: { execute?: (...args: never[]) => unknown }, callID: string, args: unknown = {}) {
  let outcome: { ok: true } | { ok: false; error: unknown } | undefined
  const promise = Promise.resolve(tool.execute!(args as never, { toolCallId: callID, messages: [] } as never)).then(
    () => {
      outcome = { ok: true }
    },
    (error) => {
      outcome = { ok: false, error }
    },
  )
  return { promise, settled: () => outcome }
}

const awaitPending = Effect.fn("alpha1129doc.awaitPending")(function* (rounds = 60) {
  const permission = yield* Permission.Service
  for (let i = 0; i < rounds; i += 1) {
    const pending = yield* permission.list()
    if (pending.length > 0) return pending
    yield* Effect.sleep("20 millis")
  }
  return yield* permission.list()
})

describe("#1129 文档轴闸(四类默认 / 用户 selector / 重读 / binding guard / quarantine)", () => {
  it.instance("D1 四类默认抵达 executor:MCP 默认 ask —— 目录照旧广告,执行挂起等批准,批准前零 tools/call", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      // 目录:默认 ask 不改变广告(§6:「ask 仍广告;disabled 才移除」)。
      expect(yield* prepareCatalogKeys([ALLOW_ALL])).toContain(ALIAS_MCP_PAID)
      const tools = yield* resolveTools([ALLOW_ALL])
      const run = launch(tools[ALIAS_MCP_PAID]!, "d1")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_MCP_PAID)
      expect(counts.call).toBe(0)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
      expect(run.settled()?.ok).toBe(false)
      expect(counts.call).toBe(0)
    }),
  )

  it.instance("D2 本地类默认 enabled:builtin 与 host 工具零打扰执行(文档轴不加 identity prompt)", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const test = yield* TestInstance
      const target = path.join(test.directory, "BUILTIN-D2.txt")
      const tools = yield* resolveTools([ALLOW_ALL])
      yield* Effect.promise(() =>
        tools[ALIAS_BUILTIN_WRITE]!.execute!(
          { filePath: target, content: "SIDE-EFFECT-EXECUTED" },
          { toolCallId: "d2a", messages: [] } as never,
        ),
      )
      yield* Effect.promise(() =>
        tools[ALIAS_HOST_LIST_RESOURCES]!.execute!({}, { toolCallId: "d2b", messages: [] } as never),
      )
      expect(yield* markerExists(target)).toBe(true)
      expect(counts.listResources).toBe(1)
      expect((yield* permission.list()).length).toBe(0)
    }),
  )

  it.instance("D3 用户 tool 层 disabled(生产 setRecord)⇒ 目录只删它,执行具名拒绝、零传输、零待批", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const policy = yield* AlphaToolPolicy.Service
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" })
      const keys = yield* prepareCatalogKeys([ALLOW_ALL])
      expect(keys).not.toContain(ALIAS_MCP_PAID)
      expect(keys).toContain(ALIAS_PLUGIN_PROBE)
      expect(keys).toContain(ALIAS_BUILTIN_WRITE)
      // stale/direct call:目录不广告之外,执行闸还要自己响亮拒绝(双闸,§6)。
      const tools = yield* resolveTools([ALLOW_ALL])
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d3", messages: [] } as never),
      ).pipe(Effect.exit)
      const error = squashed(exit)
      expect(String((error as Error)?.message ?? error)).toContain(ID_MCP_PAID)
      expect(String((error as Error)?.message ?? error)).toContain("alpha-tool-policy")
      expect(counts.call).toBe(0)
      expect((yield* permission.list()).length).toBe(0)
    }),
  )

  it.instance("D4 executor 调用时重读:目录发出、对象在手,再收紧 ⇒ 同一对象当场 deny;还原 ⇒ 恢复", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      yield* policy.setRecord({ selector: { level: "class", class: "third-party-mcp" }, state: "enabled" })
      // 目录发出 + 工具对象已在手里(这就是「模型拿到旧 catalog」的那个时刻)。
      expect(yield* prepareCatalogKeys([ALLOW_ALL])).toContain(ALIAS_MCP_PAID)
      const tools = yield* resolveTools([ALLOW_ALL])
      yield* Effect.promise(() => tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d4a", messages: [] } as never))
      expect(counts.call).toBe(1)
      // Settings 收紧 —— 不重新 resolve,不重发目录。
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" })
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d4b", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(squashed(exit)).toBeDefined()
      expect(counts.call).toBe(1) // 一个字节都没多发
      // 还原 ⇒ 同一个 held 对象恢复可用(证明重读的是当前文档,不是对象坏了)。
      yield* policy.removeRecord({ level: "tool", canonical: ID_MCP_PAID })
      yield* Effect.promise(() => tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d4c", messages: [] } as never))
      expect(counts.call).toBe(2)
    }),
  )

  it.instance("D5 binding guard:service 层 enabled 绑定 inventory 给的 digest;rebind 后同一对象回到 ask", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const policy = yield* AlphaToolPolicy.Service
      const inventory = yield* AlphaToolInventory.Service
      // enabled 写入必须携带 inventory 发放的当前 digest(设计稿 §4;schema 强制)。
      const listed = yield* inventory.list()
      const service = listed.services.find((item) => item.source === "mcp" && item.origin === "policy")
      expect(service?.bindingDigest).toBeDefined()
      yield* policy.setRecord({
        selector: { level: "service", source: "mcp", origin: "policy" },
        state: "enabled",
        bindingDigest: service!.bindingDigest!,
      })
      const tools = yield* resolveTools([ALLOW_ALL])
      yield* Effect.promise(() => tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d5a", messages: [] } as never))
      expect(counts.call).toBe(1)
      expect((yield* permission.list()).length).toBe(0)
      // rebind:同一配置键换 URL(§5 的原型场景)。held 对象的传输还指着旧 server ——
      // 只有调用时重新派生当前 binding 才拦得住。
      const second = testServer()
      const running2 = yield* second.handle
      const mcp = yield* MCP.Service
      yield* mcp.add("policy", remote(running2.url))
      const run = launch(tools[ALIAS_MCP_PAID]!, "d5b")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_MCP_PAID)
      expect(counts.call).toBe(1) // 旧 server 零新调用
      expect(second.counts.call).toBe(0) // 新 server 也一个都没吃到
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
    }),
  )

  it.instance("D6 quarantine:策略文件损坏 ⇒ 用户可配置工具全体 disabled;生产 reset 恢复默认", () =>
    Effect.gen(function* () {
      const { counts, marker } = yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      // 先经生产写入口落一份合法文档,再把它写坏 —— 「损坏」发生在真实文件上。
      yield* policy.setRecord({ selector: { level: "class", class: "third-party-mcp" }, state: "enabled" })
      const { partition } = yield* policy.inspect()
      const file = policyFilePath(path.join(Global.Path.data, "alpha-tool-policy"), partition)
      yield* Effect.promise(() => fs.writeFile(file, "{ this is not a policy document"))
      const tools = yield* resolveTools([ALLOW_ALL])
      // MCP:quarantine ⇒ disabled(不是 ask)。
      const exitMcp = yield* Effect.promise(() =>
        tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d6a", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(String((squashed(exitMcp) as Error)?.message)).toContain("quarantine")
      expect(counts.call).toBe(0)
      // plugin 同样(所有用户可配置工具;§5:不得静默忽略一条可能原本是 deny 的坏记录)。
      const exitPlugin = yield* Effect.promise(() =>
        tools[ALIAS_PLUGIN_PROBE]!.execute!({}, { toolCallId: "d6b", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(squashed(exitPlugin)).toBeDefined()
      expect(yield* markerExists(marker)).toBe(false)
      // 生产恢复入口:reset 挪走坏文件(留备份)⇒ 回到批准默认(MCP 默认 ask,而不是照跑)。
      const { backup } = yield* policy.reset()
      expect(backup).toBeDefined()
      const permission = yield* Permission.Service
      const run = launch(tools[ALIAS_MCP_PAID]!, "d6c")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
      expect(counts.call).toBe(0)
    }),
  )

  it.instance("D7 用户 disabled 不可被 session grant 撬开:先 always 放行,再 class 层禁用 ⇒ 同一对象被拒", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const policy = yield* AlphaToolPolicy.Service
      const tools = yield* resolveTools([ALLOW_ALL])
      // ① 默认 ask ⇒ 用户点「总是允许」(grant 落在本 session + canonical 上)。
      const first = launch(tools[ALIAS_MCP_PAID]!, "d7a")
      const pending = yield* awaitPending()
      yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
      yield* Effect.promise(() => first.promise)
      expect(counts.call).toBe(1)
      // ② Settings 把整类禁用。grant 只能 discharge ask,压不过任何 deny(§4.4)。
      yield* policy.setRecord({ selector: { level: "class", class: "third-party-mcp" }, state: "disabled" })
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "d7b", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(squashed(exit)).toBeDefined()
      expect(counts.call).toBe(1)
      expect((yield* permission.list()).length).toBe(0) // deny 不是 ask,没有第二次弹窗
    }),
  )
})
