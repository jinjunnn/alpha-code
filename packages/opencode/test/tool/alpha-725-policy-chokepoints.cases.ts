// alpha-code#725 (REQ-131 VERIFY) —— 「工具策略同时约束模型目录与执行咽喉」的双咽喉取证探针。
//
// 被测的两处**生产咽喉**(定义取 #724 已批基线 §6):
//   · 咽喉 A(模型目录)= `LLMRequestPrep.prepare()` 返回的 `tools` —— 生产里唯一交给 provider
//     的那张表(`session/llm.ts:242,327` 把它直接喂给 AI SDK)。
//   · 咽喉 B(执行)  = `SessionTools.resolve()` 返回的工具对象上的 `.execute()` —— 生产里
//     AI SDK 与 DWS `toolExecutor`(`session/llm.ts:140-148`)真正调的那个函数。
//
// 三条纪律(缺一条这份读数就不可信):
//  ① **不测内层纯函数。** 不调 `resolveTools` / `Permission.disabled`,只调上面两个生产入口 ——
//     否则「落在分流层的绕过照样绿」。
//  ② **期望值一律手写字面量**(`"mcp:policy:paid_action"`),不从 `canonicalToolIdentity()` 导出 ——
//     后者是自指等价链,把生产的编码规则改错仍然全绿。
//  ③ **副作用用真实计数**:MCP `tools/call` / `resources/list` 由**真服务器**计数,插件工具的
//     副作用是**真落盘的 marker 文件**,builtin `write` 的副作用是**真写出来的文件**。
//     「抛没抛异常」不够 —— 一个先跑副作用再抛的实现能满足它。
//
// 负向对照(A5/B0)必须在:没有它,一个「无条件清空目录」或「无条件拒绝执行」的实现
// 能让全部正向用例变绿,而所有用户的工具全挂。
//
// `experimentalCodeMode` 显式钉成 false:翻成 true 时 `session/tools.ts:418` 在注册完宿主资源
// 工具之后就 `return tools`,MCP 那一整段不再执行,MCP 相关用例会从「拦住了」静默变成「压根没跑到」。
//
// **为什么探针住在 `packages/opencode/test/` 而不是 `docs/verification/.../probes/`**:
// 它必须与生产共享**同一个** `effect` 模块实例 —— Context tag 是按模块实例做的身份,
// 从 `docs/` 走相对路径 import `effect` / `@opencode-ai/core` 会拿到另一份解析结果,
// 于是 `yield* Permission.Service` 这类取服务会在运行期失败,或者更糟 —— 静默拿到另一棵层图。
// 实测:放在 docs/ 下时 `@modelcontextprotocol/sdk`、`effect` 都解析不到(bun 从文件位置往上找
// `node_modules`,docs/ 上面没有)。证据文档与结果仍在 `docs/verification/`,那里指向本文件。
//
// 本文件是探针,不是闸门:扩展名 `.cases.ts` ⇒ **不进 `bun test`**,因此不登记 gate-files.tsv;
// `packages/opencode` 也不在任何 alpha typecheck 面内。零改动任何生产文件。
//
// ⚠️ **本文件今天是部分红的,而且那是结论,不是缺陷。** base `alpha@c3d0d0569` 上
// `bun test --timeout 60000 ./test/tool/alpha-725-policy-chokepoints.cases.ts`
// ⇒ `Ran 23 tests across 1 file.` / **15 pass / 8 fail**(B2 B3 B4 B6 B9 B10 B11 B13)。
// 这 8 条红的是 REQ-131 尚未实现的执行咽喉语义,已开 alpha-code#1121 / #1122。
// **不要为了让它变绿去放宽断言** —— 判据放宽了,#1121/#1122 修完也没人知道。
// 跑法、口径、摘线实验与逐条判定见
// `docs/verification/2026-08-25-req131-725-tool-policy-chokepoints/README.md`。
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
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
import { workflowPreapprovedToolNames } from "@/session/llm"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ── 手写的期望字面量。刻意不从生产导出。────────────────────────────────────────
const ID_MCP_PAID = "mcp:policy:paid_action"
const ID_MCP_FREE = "mcp:policy:free_action"
const ID_PLUGIN_PROBE = "plugin:probe:default"
const ID_BUILTIN_WRITE = "builtin::write"
const ID_HOST_LIST_RESOURCES = "host::list_mcp_resources"

const ALIAS_MCP_PAID = "policy_paid_action"
const ALIAS_MCP_FREE = "policy_free_action"
const ALIAS_PLUGIN_PROBE = "probe"
const ALIAS_BUILTIN_WRITE = "write"
const ALIAS_HOST_LIST_RESOURCES = "list_mcp_resources"

/** 每次装配都必须存在的四个键;A5 负向对照用它证明「无条件清空」不能冒充闸门。*/
const ALL_ALIASES = [
  ALIAS_MCP_PAID,
  ALIAS_MCP_FREE,
  ALIAS_PLUGIN_PROBE,
  ALIAS_BUILTIN_WRITE,
  ALIAS_HOST_LIST_RESOURCES,
] as const

/** 一台**真的** streamable-HTTP MCP server,自己发布工具名并对每次 `tools/call` 计数。*/
function testServer() {
  const counts = { call: 0, listResources: 0, readResource: 0, listTemplates: 0 }
  const handle = Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = [
        { name: "paid_action", description: "remote paid", inputSchema: { type: "object", properties: {} } },
        { name: "free_action", description: "remote free", inputSchema: { type: "object", properties: {} } },
      ]
      const protocol = new Server(
        { name: "alpha-725-policy", version: "1.0.0" },
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
      protocol.setRequestHandler(ListResourceTemplatesRequestSchema, () => {
        counts.listTemplates += 1
        return Promise.resolve({ resourceTemplates: [] })
      })
      protocol.setRequestHandler(ReadResourceRequestSchema, () => {
        counts.readResource += 1
        return Promise.resolve({ contents: [{ uri: "mem://one", mimeType: "text/plain", text: "resource-body" }] })
      })
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

/**
 * 真的 `.opencode/tool/probe.ts`。它的 `execute` **落盘一个 marker**:
 * 「有没有真的执行」由文件系统回答,不由异常类型回答。
 */
const writeProbePlugin = Effect.fn("alpha725.writeProbePlugin")(function* (marker: string) {
  const test = yield* TestInstance
  const dir = path.join(test.directory, ".opencode", "tool")
  yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "probe.ts"),
      [
        "import { writeFileSync } from 'node:fs'",
        "export default {",
        "  description: 'alpha 725 probe tool',",
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

function testSession(ruleset: PermissionV1.Ruleset, sessionID: SessionID = SESSION_ID): Session.Info {
  return {
    id: sessionID,
    slug: "alpha-725",
    projectID: ProjectV2.ID.make("alpha-725"),
    directory: ".",
    title: "alpha-725",
    version: "0.0.0",
    time: { created: 0, updated: 0 },
    permission: ruleset as PermissionV1.Rule[],
  }
}

type Processor = Pick<
  SessionProcessor.Handle,
  "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay"
>

function testProcessor() {
  const snapshots = new Map<string, ToolDisplaySnapshotV1>()
  const handle = {
    message: { id: MessageID.ascending() },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
    registerToolDisplay: (technicalId: string, display: ToolDisplaySnapshotV1) => {
      snapshots.set(technicalId, display)
    },
  } as unknown as Processor
  return { handle, snapshots }
}

/** 咽喉 B 的入口:真的 `SessionTools.resolve`。*/
const resolveTools = Effect.fn("alpha725.resolveTools")(function* (
  ruleset: PermissionV1.Ruleset,
  sessionID: SessionID = SESSION_ID,
) {
  const agents = yield* Agent.Service
  return yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: testModel(),
    session: testSession(ruleset, sessionID),
    processor: testProcessor().handle,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
})

/**
 * 咽喉 A 的入口:真的 `LLMRequestPrep.prepare`。
 * `provider` / `auth` / `user` 只被读几个与工具无关的字段(provider.id、provider.options、
 * user.system、user.model.variant),这里给字面量;**工具那一路完全是生产的**。
 */
const prepareCatalog = Effect.fn("alpha725.prepareCatalog")(function* (ruleset: PermissionV1.Ruleset) {
  const agents = yield* Agent.Service
  const plugin = yield* Plugin.Service
  const flags = yield* RuntimeFlags.Service
  const tools = yield* resolveTools(ruleset)
  const prepared = yield* LLMRequestPrep.prepare({
    user: {
      id: "msg_alpha725",
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
    flags,
    isWorkflow: false,
  })
  return prepared.tools
})

const prepareCatalogKeys = Effect.fn("alpha725.prepareCatalogKeys")(function* (ruleset: PermissionV1.Ruleset) {
  return Object.keys(yield* prepareCatalog(ruleset))
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      MCP.node,
      Agent.node,
      Permission.node,
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
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

/** 「全允许」的底。所有 ability 闸(edit/read/bash/…)都放行 ⇒ 剩下的唯一变量是 identity 策略。*/
const ALLOW_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }
const rulesFor = (identity: string, action: "deny" | "ask"): PermissionV1.Rule[] => [
  ALLOW_ALL,
  { permission: identity, pattern: "*", action },
]

/** 装好一套完整现场:真 MCP server + 真插件工具。返回 marker 路径与服务器计数器。*/
const setup = Effect.fn("alpha725.setup")(function* () {
  const test = yield* TestInstance
  const marker = path.join(test.directory, "PLUGIN-SIDE-EFFECT.txt")
  yield* writeProbePlugin(marker)
  const server = testServer()
  const running = yield* server.handle
  const mcp = yield* MCP.Service
  yield* mcp.add("policy", remote(running.url))
  return { marker, counts: server.counts }
})

const markerExists = (marker: string) => Effect.promise(() => Bun.file(marker).exists())

function squashed(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit)) return undefined
  return Cause.squash(exit.cause)
}

describe("咽喉 A —— 模型目录 (LLMRequestPrep.prepare)", () => {
  it.instance("A5 负向对照:无 identity 规则时,五个来源的键全部在目录里", () =>
    Effect.gen(function* () {
      yield* setup()
      const keys = yield* prepareCatalogKeys([ALLOW_ALL])
      for (const alias of ALL_ALIASES) expect(keys).toContain(alias)
    }),
  )

  it.instance("A1 builtin::write deny ⇒ write 不在目录", () =>
    Effect.gen(function* () {
      yield* setup()
      const keys = yield* prepareCatalogKeys(rulesFor(ID_BUILTIN_WRITE, "deny"))
      expect(keys).not.toContain(ALIAS_BUILTIN_WRITE)
      expect(keys).toContain(ALIAS_MCP_PAID)
    }),
  )

  it.instance("A2 plugin:probe:default deny ⇒ probe 不在目录", () =>
    Effect.gen(function* () {
      yield* setup()
      const keys = yield* prepareCatalogKeys(rulesFor(ID_PLUGIN_PROBE, "deny"))
      expect(keys).not.toContain(ALIAS_PLUGIN_PROBE)
      expect(keys).toContain(ALIAS_MCP_PAID)
    }),
  )

  it.instance("A3 host::list_mcp_resources deny ⇒ 宿主资源工具不在目录", () =>
    Effect.gen(function* () {
      yield* setup()
      const keys = yield* prepareCatalogKeys(rulesFor(ID_HOST_LIST_RESOURCES, "deny"))
      expect(keys).not.toContain(ALIAS_HOST_LIST_RESOURCES)
      expect(keys).toContain(ALIAS_MCP_PAID)
    }),
  )

  it.instance("A4 mcp:policy:paid_action deny ⇒ 只有它消失,同 server 的 free_action 仍在", () =>
    Effect.gen(function* () {
      yield* setup()
      const keys = yield* prepareCatalogKeys(rulesFor(ID_MCP_PAID, "deny"))
      expect(keys).not.toContain(ALIAS_MCP_PAID)
      expect(keys).toContain(ALIAS_MCP_FREE)
    }),
  )

  // #724 §6:`ask` 是「待用户裁决的暂挂态」,不是严格度等级 ⇒ **目录照旧广告**,
  // 由执行咽喉负责问。少了这一条,一个「ask 也一并从目录里删掉」的实现能让 A1–A4 全绿,
  // 而用户会发现「设成询问」等于「禁用」。
  it.instance("A6 ask 不得改变目录:四个来源设成 ask 之后仍然全部在目录里", () =>
    Effect.gen(function* () {
      yield* setup()
      for (const identity of [ID_BUILTIN_WRITE, ID_PLUGIN_PROBE, ID_HOST_LIST_RESOURCES, ID_MCP_PAID]) {
        const keys = yield* prepareCatalogKeys(rulesFor(identity, "ask"))
        for (const alias of ALL_ALIASES) expect(keys).toContain(alias)
      }
    }),
  )
})

describe("咽喉 B —— 执行 (SessionTools.resolve 返回对象的 execute)", () => {
  it.instance("B0 负向对照:无 identity 规则时,四个可执行来源都真的跑出副作用", () =>
    Effect.gen(function* () {
      const { marker, counts } = yield* setup()
      const tools = yield* resolveTools([ALLOW_ALL])
      yield* Effect.promise(() => tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "c0", messages: [] } as never))
      yield* Effect.promise(() => tools[ALIAS_PLUGIN_PROBE]!.execute!({}, { toolCallId: "c1", messages: [] } as never))
      yield* Effect.promise(() =>
        tools[ALIAS_HOST_LIST_RESOURCES]!.execute!({}, { toolCallId: "c2", messages: [] } as never),
      )
      expect(counts.call).toBe(1)
      expect(counts.listResources).toBe(1)
      expect(yield* markerExists(marker)).toBe(true)
    }),
  )

  it.instance("B1 mcp:policy:paid_action deny ⇒ execute 响亮拒绝,且 tools/call 计数 = 0", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const tools = yield* resolveTools(rulesFor(ID_MCP_PAID, "deny"))
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "c1", messages: [] } as never),
      ).pipe(Effect.exit)
      const error = squashed(exit)
      expect(error).toBeDefined()
      expect(String((error as Error)?.message ?? error)).toContain(ID_MCP_PAID)
      expect(counts.call).toBe(0)
    }),
  )

  it.instance("B2 plugin:probe:default deny ⇒ execute 必须响亮拒绝,且 marker 文件不存在", () =>
    Effect.gen(function* () {
      const { marker } = yield* setup()
      const tools = yield* resolveTools(rulesFor(ID_PLUGIN_PROBE, "deny"))
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_PLUGIN_PROBE]!.execute!({}, { toolCallId: "c2", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(yield* markerExists(marker)).toBe(false)
      expect(squashed(exit)).toBeDefined()
    }),
  )

  it.instance("B3 builtin::write deny ⇒ execute 必须响亮拒绝,且目标文件没被写出来", () =>
    Effect.gen(function* () {
      yield* setup()
      const test = yield* TestInstance
      const target = path.join(test.directory, "BUILTIN-SIDE-EFFECT.txt")
      const tools = yield* resolveTools(rulesFor(ID_BUILTIN_WRITE, "deny"))
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_BUILTIN_WRITE]!.execute!(
          { filePath: target, content: "SIDE-EFFECT-EXECUTED" },
          { toolCallId: "c3", messages: [] } as never,
        ),
      ).pipe(Effect.exit)
      expect(yield* markerExists(target)).toBe(false)
      expect(squashed(exit)).toBeDefined()
    }),
  )

  it.instance("B4 host::list_mcp_resources deny ⇒ execute 必须响亮拒绝,且 resources/list 计数 = 0", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const tools = yield* resolveTools(rulesFor(ID_HOST_LIST_RESOURCES, "deny"))
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_HOST_LIST_RESOURCES]!.execute!({}, { toolCallId: "c4", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(counts.listResources).toBe(0)
      expect(squashed(exit)).toBeDefined()
    }),
  )
})

/**
 * 起一次真的 `.execute()` 但**不等它** —— 三态 ask 的整个判据都落在「它还挂着的时候,
 * 世界上已经发生了什么」。用裸 Promise 而不是 fiber:`Effect.promise` 把 reject 当 defect,
 * 包一层就读不出「拒绝」和「崩了」的差别。
 */
// 参数类型取 `(...args: never[]) => unknown`(参数逆变的底):任何 AI SDK Tool 都可直接传入。
// 此前的 `(args: unknown, opts: unknown) => unknown` 让 13 处 `launch(tools[...]!)` 调用点
// 各红一条 TS2345(#1134;packages/opencode 不在任何 typecheck 门内所以一直没人看见)。
// 本次只改类型标注与体内两处 cast,零断言变动。
function launch(tool: { execute?: (...args: never[]) => unknown }, callID: string, args: unknown = {}) {
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined
  const promise = Promise.resolve(tool.execute!(args as never, { toolCallId: callID, messages: [] } as never)).then(
    (value) => {
      outcome = { ok: true, value }
    },
    (error) => {
      outcome = { ok: false, error }
    },
  )
  return { promise, settled: () => outcome }
}

/** 轮询真 `Permission.list()`(生产的审批面读的就是它),直到出现待批请求或超时。*/
const awaitPending = Effect.fn("alpha725.awaitPending")(function* (rounds = 60) {
  const permission = yield* Permission.Service
  for (let i = 0; i < rounds; i += 1) {
    const pending = yield* permission.list()
    if (pending.length > 0) return pending
    yield* Effect.sleep("20 millis")
  }
  return yield* permission.list()
})

describe("三态 ask —— 批准前零副作用", () => {
  it.instance("B5 mcp:policy:paid_action ask ⇒ 挂起等批准且 tools/call 计数 = 0;reject 之后仍为 0", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"))
      const run = launch(tools[ALIAS_MCP_PAID]!, "c5")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_MCP_PAID)
      expect(counts.call).toBe(0)
      expect(run.settled()).toBeUndefined()
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
      expect(run.settled()?.ok).toBe(false)
      expect(counts.call).toBe(0)
    }),
  )

  it.instance("B7 mcp ask ⇒ once 只放行这一次:同 session 第二次调用必须再问一遍", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"))
      const first = launch(tools[ALIAS_MCP_PAID]!, "c7a")
      const p1 = yield* awaitPending()
      expect(p1.length).toBe(1)
      yield* permission.reply({ requestID: p1[0]!.id, reply: "once" })
      yield* Effect.promise(() => first.promise)
      expect(first.settled()?.ok).toBe(true)
      expect(counts.call).toBe(1)

      const second = launch(tools[ALIAS_MCP_PAID]!, "c7b")
      const p2 = yield* awaitPending()
      expect(p2.length).toBe(1)
      expect(counts.call).toBe(1)
      yield* permission.reply({ requestID: p2[0]!.id, reply: "reject" })
      yield* Effect.promise(() => second.promise)
      expect(counts.call).toBe(1)
    }),
  )

  it.instance("B8 mcp ask ⇒ always 之后同 session 同 identity 不再追问(#724 §4.5)", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"))
      const first = launch(tools[ALIAS_MCP_PAID]!, "c8a")
      const p1 = yield* awaitPending()
      expect(p1.length).toBe(1)
      yield* permission.reply({ requestID: p1[0]!.id, reply: "always" })
      yield* Effect.promise(() => first.promise)
      expect(counts.call).toBe(1)

      const second = launch(tools[ALIAS_MCP_PAID]!, "c8b")
      yield* Effect.promise(() => second.promise)
      // 判据是「第二次直接跑完,且从没进过待批队列」——「没弹窗」本身不够,
      // 一个把 ask 整段删掉的实现同样没弹窗,所以 counts 必须涨到 2。
      expect(second.settled()?.ok).toBe(true)
      expect(counts.call).toBe(2)
      expect((yield* permission.list()).length).toBe(0)
    }),
  )

  // #724 §4.4:`always` 只能 discharge 一个 ask,**不能覆盖任何 cap / user deny**。
  // 本用例造的是「用户先点了总是允许,之后把这个工具改成禁用」——
  // 判据不是「有没有弹窗」(把 ask 整段删掉也不弹窗),而是**服务器侧的 tools/call 计数不再增长**。
  // 现场机制:`Permission.ask` 的 `approved` 是 instance 级状态、`evaluate` 用
  // `[...ruleset, ...approved].findLast(...)` ⇒ approved 排在 ruleset **之后**。
  it.instance("B9 先 always、后把同一 identity 收紧成 deny ⇒ 第二次必须被拒,tools/call 不得增长", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service

      // ① 用户在「询问」态点了「总是允许」。
      const lenient = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"))
      const first = launch(lenient[ALIAS_MCP_PAID]!, "c9a")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
      yield* Effect.promise(() => first.promise)
      expect(counts.call).toBe(1)

      // ② 用户随后把它收紧成「禁用」(等价于桌面 kill-switch 注入 deny)。整棵工具表重新装配。
      const strict = yield* resolveTools(rulesFor(ID_MCP_PAID, "deny"))
      const second = launch(strict[ALIAS_MCP_PAID]!, "c9b")
      yield* Effect.promise(() => second.promise)
      expect(counts.call).toBe(1)
      expect(second.settled()?.ok).toBe(false)
    }),
  )

  // #724 §4.4:`always` 只在**当前 session** 内保存 allow。今天 `approved` 是 instance 级
  // (`permission/index.ts` 的 `approved.push({permission, pattern, action})`,**不带 sessionID**),
  // 所以本用例问的是「在另一条会话里,它还认不认这张旧批条」。
  it.instance("B13 会话 A 点了 always ⇒ 会话 B 必须重新询问(作用域不得串扰)", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const sessionA = SessionID.create()
      const sessionB = SessionID.create()
      expect(sessionA).not.toBe(sessionB)

      const toolsA = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"), sessionA)
      const first = launch(toolsA[ALIAS_MCP_PAID]!, "c13a")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      expect(pending[0]!.sessionID).toBe(sessionA)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
      yield* Effect.promise(() => first.promise)
      expect(counts.call).toBe(1)

      const toolsB = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"), sessionB)
      const second = launch(toolsB[ALIAS_MCP_PAID]!, "c13b")
      const pendingB = yield* awaitPending(15)
      // 判据不是「弹没弹窗」,而是**服务器侧计数在批准前必须还是 1**。
      expect(counts.call).toBe(1)
      expect(pendingB.map((item) => item.sessionID)).toContain(sessionB)
      for (const item of pendingB) yield* permission.reply({ requestID: item.id, reply: "reject" })
      yield* Effect.promise(() => second.promise)
    }),
  )

  it.instance("B6 plugin:probe:default ask ⇒ 必须先请求批准;marker 在批准前不得出现", () =>
    Effect.gen(function* () {
      const { marker } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_PLUGIN_PROBE, "ask"))
      const run = launch(tools[ALIAS_PLUGIN_PROBE]!, "c6")
      const pending = yield* awaitPending(15)
      const markerBefore = yield* markerExists(marker)
      expect(markerBefore).toBe(false)
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_PLUGIN_PROBE)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
    }),
  )

  it.instance("B11 host::list_mcp_resources ask ⇒ 必须先请求批准;resources/list 在批准前计数 = 0", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_HOST_LIST_RESOURCES, "ask"))
      const run = launch(tools[ALIAS_HOST_LIST_RESOURCES]!, "c11")
      const pending = yield* awaitPending(15)
      expect(counts.listResources).toBe(0)
      expect(pending.map((item) => item.permission)).toContain(ID_HOST_LIST_RESOURCES)
      for (const item of pending) yield* permission.reply({ requestID: item.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
    }),
  )

  // 正向对照 —— **必须在**。没有它,B3/B6/B10 会被读成「write 工具压根没有审批闸」,
  // 而真相是闸在、只是**只认 ability 键**:identity 轴今天在 E1 上完全不接线。
  // 同时它也是 AC12 点名的那个折叠的现场:`edit` 这一个键同时管住 edit / write / apply_patch。
  it.instance("B12 对照:ability 键 edit=ask ⇒ builtin write 真的会先问、且批准前不落盘", () =>
    Effect.gen(function* () {
      yield* setup()
      const test = yield* TestInstance
      const permission = yield* Permission.Service
      const target = path.join(test.directory, "ABILITY-ASK.txt")
      const tools = yield* resolveTools([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "ask" },
      ])
      const run = launch(tools[ALIAS_BUILTIN_WRITE]!, "c12", { filePath: target, content: "x" })
      const pending = yield* awaitPending()
      expect(pending.map((item) => item.permission)).toContain("edit")
      expect(yield* markerExists(target)).toBe(false)
      for (const item of pending) yield* permission.reply({ requestID: item.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
      expect(yield* markerExists(target)).toBe(false)
    }),
  )

  it.instance("B10 builtin::write ask ⇒ 必须先请求批准;目标文件在批准前不得出现", () =>
    Effect.gen(function* () {
      yield* setup()
      const test = yield* TestInstance
      const permission = yield* Permission.Service
      const target = path.join(test.directory, "BUILTIN-ASK-SIDE-EFFECT.txt")
      const tools = yield* resolveTools(rulesFor(ID_BUILTIN_WRITE, "ask"))
      const run = launch(tools[ALIAS_BUILTIN_WRITE]!, "c10", {
        filePath: target,
        content: "SIDE-EFFECT-EXECUTED",
      })
      const pending = yield* awaitPending(15)
      const wroteBefore = yield* markerExists(target)
      expect(wroteBefore).toBe(false)
      expect(pending.map((item) => item.permission)).toContain(ID_BUILTIN_WRITE)
      for (const item of pending) yield* permission.reply({ requestID: item.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
    }),
  )
})

// ── E5(DWS workflow):**单元级**,不冒充链路证据 ────────────────────────────────
// `workflowPreapprovedToolNames` 是 `session/llm.ts:162` 在 GitLab workflow 模型上调用的
// 那个导出函数;本机没有 DWS 服务端,整条链路跑不起来 ⇒ 这里只喂**真的** prepared 工具表
// (真 identity、真 ruleset),断言它的返回。它证明不了「DWS 真的会问」,只证明
// 「预批清单里没有它」。#724 §9 明确允许这一格留在 #725,但要求不当成 packaged 证据。
describe("E5 DWS 预批清单(单元级)", () => {
  it.instance("E5a identity=ask 的 MCP 工具不得进入 sessionPreapprovedTools", () =>
    Effect.gen(function* () {
      yield* setup()
      const prepared = yield* prepareCatalog(rulesFor(ID_MCP_PAID, "ask"))
      const names = workflowPreapprovedToolNames(prepared, rulesFor(ID_MCP_PAID, "ask"))
      expect(Object.keys(prepared)).toContain(ALIAS_MCP_PAID)
      expect(names).not.toContain(ALIAS_MCP_PAID)
      expect(names).toContain(ALIAS_MCP_FREE)
    }),
  )

  it.instance("E5b identity=ask 的 builtin 工具不得进入 sessionPreapprovedTools", () =>
    Effect.gen(function* () {
      yield* setup()
      const prepared = yield* prepareCatalog(rulesFor(ID_BUILTIN_WRITE, "ask"))
      const names = workflowPreapprovedToolNames(prepared, rulesFor(ID_BUILTIN_WRITE, "ask"))
      expect(Object.keys(prepared)).toContain(ALIAS_BUILTIN_WRITE)
      expect(names).not.toContain(ALIAS_BUILTIN_WRITE)
    }),
  )
})

// ── R1 可达性(第零问):这些规则,走我们自己的 runbook 到得了吗?────────────────
// 上面所有 A/B 判据都用 `session.permission` 注入 ruleset。这一格换成**真的
// `opencode.json` 文件 + 真的 `Config` 节点 + 真的 `Agent.Service`**(不 stub Config),
// 证明「用户手写一条 identity 键」确实会变成同一张 ruleset 里的规则。
// 没有这一格,上面每一条 FAIL 都可以被一句「合成夹具里能复现 ≠ 这个系统到得了」驳回。
//
// 机制:`v1/config/permission.ts` 的 `InputObject` 是 `StructWithRest(..., [Record(String, Rule)])`
// ⇒ 接受任意键;`agent/agent.ts` 把 `Permission.fromConfig(cfg.permission)` 合并在**最后**,
// 因此它压得过内置的 `"*": "allow"`。桌面侧已有活的同类写入方
// (`packages/ui-mac/src/main/cloud-web-search.ts` 的 `applyWebSearchDenies` / `pinDeny`)。
const itRealConfig = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Permission.node])))

describe("R1 可达性 —— 真 opencode.json → 真 Agent.permission", () => {
  itRealConfig.instance(
    "R1 用户在 opencode.json 里写 identity 键 ⇒ 三态原样出现在 agent 的 ruleset 上",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const info = yield* agents.defaultInfo()
        expect(Permission.evaluate(ID_PLUGIN_PROBE, "*", info.permission).action).toBe("ask")
        expect(Permission.evaluate(ID_BUILTIN_WRITE, "*", info.permission).action).toBe("ask")
        expect(Permission.evaluate(ID_HOST_LIST_RESOURCES, "*", info.permission).action).toBe("ask")
        expect(Permission.evaluate(ID_MCP_PAID, "*", info.permission).action).toBe("deny")
        // 负向对照:没写进 config 的 identity 不得凭空变成 ask/deny。
        expect(Permission.evaluate(ID_MCP_FREE, "*", info.permission).action).toBe("allow")
      }),
    {
      config: {
        permission: {
          [ID_PLUGIN_PROBE]: "ask",
          [ID_BUILTIN_WRITE]: "ask",
          [ID_HOST_LIST_RESOURCES]: "ask",
          [ID_MCP_PAID]: "deny",
        },
      } as never,
    },
  )
})
