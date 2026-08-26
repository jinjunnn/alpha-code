// alpha-code#1129(REQ-131 CODE#2)—— 执行咽喉 identity 三态的**闸门**(#724 §6 E1/E2/E3 + internal sentinel)。
//
// 与 `alpha-725-policy-chokepoints.cases.ts` 的分工:那份是 #725 的取证探针(`.cases.ts`,
// 不进 `bun test`,矩阵全量);本文件是登记进 `scripts/gate-files.tsv` 的常驻闸,凡 #1129 在
// `session/tools.ts` 公共 `register()` 上接的那条 identityGate 被摘掉/挪到 hook 之后/换回
// 各来源自问,这里当场红。判据纪律与探针相同:
//   ① 只驱动生产入口 `SessionTools.resolve()` 返回对象的 `.execute()`(不测内层纯函数);
//   ② 期望字面量手写(不从 `canonicalToolIdentity()` 导出);
//   ③ 副作用用真实计数:真 MCP server 的 `tools/call` / `resources/list`、插件真落盘的
//      marker、builtin write 真写出的文件 ——「抛没抛异常」不构成证据。
//
// sentinel 两条(#724 §6 internal sentinel):`host::StructuredOutput` 强制 enabled(目录闸
// 免疫,exact canonical 例外,不给「缺 identity 也能跑」开口);`_noop` 在目录过滤之后注入、
// execute 为空操作 —— deny-all 规则也移除不了它,它也做不了任何事。
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
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ── 手写的期望字面量(纪律②)────────────────────────────────────────────────────
const ID_MCP_PAID = "mcp:policy:paid_action"
const ID_PLUGIN_PROBE = "plugin:probe:default"
const ID_BUILTIN_WRITE = "builtin::write"
const ID_HOST_LIST_RESOURCES = "host::list_mcp_resources"
const ID_STRUCTURED_OUTPUT = "host::StructuredOutput"

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
        { name: "alpha-1129-policy", version: "1.0.0" },
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

/** 真的 `.opencode/tool/probe.ts`:execute 落盘 marker,「跑没跑」由文件系统回答。 */
const writeProbePlugin = Effect.fn("alpha1129.writeProbePlugin")(function* (marker: string) {
  const test = yield* TestInstance
  const dir = path.join(test.directory, ".opencode", "tool")
  yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "probe.ts"),
      [
        "import { writeFileSync } from 'node:fs'",
        "export default {",
        "  description: 'alpha 1129 probe tool',",
        "  args: {},",
        `  execute: async () => { writeFileSync(${JSON.stringify(marker)}, 'SIDE-EFFECT-EXECUTED'); return 'ok' },`,
        "}",
        "",
      ].join("\n"),
    ),
  )
})

function testModel(providerID = "test"): Provider.Model {
  return {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make(providerID),
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
    slug: "alpha-1129",
    projectID: ProjectV2.ID.make("alpha-1129"),
    directory: ".",
    title: "alpha-1129",
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

/** 咽喉入口:真的 `SessionTools.resolve`(纪律①)。 */
const resolveTools = Effect.fn("alpha1129.resolveTools")(function* (ruleset: PermissionV1.Ruleset) {
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

const ALLOW_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }
const rulesFor = (identity: string, action: "deny" | "ask"): PermissionV1.Rule[] => [
  ALLOW_ALL,
  { permission: identity, pattern: "*", action },
]

const setup = Effect.fn("alpha1129.setup")(function* () {
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

/** 发起一次 `.execute()` 但不等它 —— ask 的判据全在「它还挂着时,世界上发生了什么」。
 *  参数类型取 `(...args: never[]) => unknown`(参数逆变的底),任何 AI SDK Tool 都可直接传入,
 *  不复刻 #1134 那 13 条 TS2345。 */
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

const awaitPending = Effect.fn("alpha1129.awaitPending")(function* (rounds = 60) {
  const permission = yield* Permission.Service
  for (let i = 0; i < rounds; i += 1) {
    const pending = yield* permission.list()
    if (pending.length > 0) return pending
    yield* Effect.sleep("20 millis")
  }
  return yield* permission.list()
})

describe("#1129 执行闸(E1/E2/E3 经公共 register 咽喉)", () => {
  it.instance("负向对照:无 identity 规则时,builtin/plugin/host/MCP 四个来源都真的执行出副作用", () =>
    Effect.gen(function* () {
      const { marker, counts } = yield* setup()
      const test = yield* TestInstance
      const target = path.join(test.directory, "BUILTIN-CONTROL.txt")
      const tools = yield* resolveTools([ALLOW_ALL])
      yield* Effect.promise(() =>
        tools[ALIAS_BUILTIN_WRITE]!.execute!(
          { filePath: target, content: "SIDE-EFFECT-EXECUTED" },
          { toolCallId: "g0a", messages: [] } as never,
        ),
      )
      yield* Effect.promise(() => tools[ALIAS_PLUGIN_PROBE]!.execute!({}, { toolCallId: "g0b", messages: [] } as never))
      yield* Effect.promise(() =>
        tools[ALIAS_HOST_LIST_RESOURCES]!.execute!({}, { toolCallId: "g0c", messages: [] } as never),
      )
      yield* Effect.promise(() => tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "g0d", messages: [] } as never))
      expect(yield* markerExists(target)).toBe(true)
      expect(yield* markerExists(marker)).toBe(true)
      expect(counts.listResources).toBe(1)
      expect(counts.call).toBe(1)
    }),
  )

  it.instance("E1 builtin::write deny ⇒ execute 响亮拒绝,目标文件不落盘", () =>
    Effect.gen(function* () {
      yield* setup()
      const test = yield* TestInstance
      const target = path.join(test.directory, "BUILTIN-DENY.txt")
      const tools = yield* resolveTools(rulesFor(ID_BUILTIN_WRITE, "deny"))
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_BUILTIN_WRITE]!.execute!(
          { filePath: target, content: "SIDE-EFFECT-EXECUTED" },
          { toolCallId: "g1", messages: [] } as never,
        ),
      ).pipe(Effect.exit)
      expect(yield* markerExists(target)).toBe(false)
      const error = squashed(exit)
      expect(error).toBeDefined()
      expect(String((error as Error)?.message ?? error)).toContain(ID_BUILTIN_WRITE)
    }),
  )

  it.instance("E1 plugin:probe:default ask ⇒ 先挂起等批准,marker 在批准前不得出现;reject 后仍不出现", () =>
    Effect.gen(function* () {
      const { marker } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_PLUGIN_PROBE, "ask"))
      const run = launch(tools[ALIAS_PLUGIN_PROBE]!, "g2")
      const pending = yield* awaitPending()
      expect(yield* markerExists(marker)).toBe(false)
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_PLUGIN_PROBE)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      yield* Effect.promise(() => run.promise)
      expect(run.settled()?.ok).toBe(false)
      expect(yield* markerExists(marker)).toBe(false)
    }),
  )

  it.instance("E2 host::list_mcp_resources deny ⇒ execute 响亮拒绝,resources/list 计数 = 0", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const tools = yield* resolveTools(rulesFor(ID_HOST_LIST_RESOURCES, "deny"))
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_HOST_LIST_RESOURCES]!.execute!({}, { toolCallId: "g3", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(counts.listResources).toBe(0)
      expect(squashed(exit)).toBeDefined()
    }),
  )

  // E3 的去重判据:identity ask 只在 register 闸问**一次**。回到旧形态(闸问一遍、MCP 循环里
  // hook 之后再问一遍)时,`once` 放行第一问后第二问再挂起 —— 本用例会在 awaitPending 的第二轮
  // 抓到残留 pending,或 run.promise 永不 settle 直接超时。
  it.instance("E3 MCP identity ask 只问一次:once 一次批准走完一次调用,pending 清零、tools/call = 1", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(rulesFor(ID_MCP_PAID, "ask"))
      const run = launch(tools[ALIAS_MCP_PAID]!, "g4")
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_MCP_PAID)
      expect(counts.call).toBe(0)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
      yield* Effect.promise(() => run.promise)
      expect(run.settled()?.ok).toBe(true)
      expect(counts.call).toBe(1)
      expect((yield* permission.list()).length).toBe(0)
    }),
  )
})

describe("#1129 internal sentinel(#724 §6:窄例外,不扩张)", () => {
  it.instance("host::StructuredOutput 强制 enabled:identity deny 与 *: deny 都移除不了它;例外只认 exact canonical", () =>
    Effect.gen(function* () {
      const subjects = [
        {
          technicalId: "StructuredOutput",
          identity: { source: "host", origin: "", name: "StructuredOutput" } as const,
        },
        {
          technicalId: ALIAS_HOST_LIST_RESOURCES,
          identity: { source: "host", origin: "", name: ALIAS_HOST_LIST_RESOURCES } as const,
        },
      ]
      // ① exact identity deny:StructuredOutput 免疫。
      const denyExact = Permission.disabled(subjects, [
        ALLOW_ALL,
        { permission: ID_STRUCTURED_OUTPUT, pattern: "*", action: "deny" },
      ])
      expect(denyExact.has("StructuredOutput")).toBe(false)
      // ② deny-all(compaction/title 型 agent 的 `*: deny` 底):仍免疫;
      //    负向对照 —— 同为 host 的资源工具**没有**例外,一起被移除才说明例外是 exact 的。
      const denyAll = Permission.disabled(subjects, [{ permission: "*", pattern: "*", action: "deny" }])
      expect(denyAll.has("StructuredOutput")).toBe(false)
      expect(denyAll.has(ALIAS_HOST_LIST_RESOURCES)).toBe(true)
      // ③ 例外不接受「缺 identity」:裸 technicalId(没有身份)不享受豁免。
      const bare = Permission.disabled(["StructuredOutput"], [
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(bare.has("StructuredOutput")).toBe(true)
    }),
  )

  it.instance("_noop 只是 Copilot 回放兼容 sentinel:deny-all 规则移除不了它,它也做不出任何副作用", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const flags = yield* RuntimeFlags.Service
      const denyAll: PermissionV1.Rule[] = [{ permission: "*", pattern: "*", action: "deny" }]
      const prepared = yield* LLMRequestPrep.prepare({
        user: {
          id: "msg_alpha1129_noop",
          role: "user",
          sessionID: SESSION_ID,
          model: { providerID: "github-copilot", modelID: "test-model" },
          time: { created: 0 },
        } as never,
        sessionID: SESSION_ID,
        model: testModel("github-copilot"),
        agent: yield* agents.defaultInfo(),
        permission: denyAll,
        system: [],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "replay_1", toolName: "gone", input: {} }],
          },
        ],
        tools: {},
        provider: { id: "github-copilot", options: {} } as never,
        auth: undefined,
        plugin,
        flags,
        isWorkflow: false,
      })
      const noop = prepared.tools["_noop"]
      expect(noop).toBeDefined()
      const result = yield* Effect.promise(() =>
        Promise.resolve(noop!.execute!({ reason: "x" } as never, { toolCallId: "replay_2", messages: [] } as never)),
      )
      expect(result).toEqual({ output: "", title: "", metadata: {} })
    }),
  )
})
