// `#793` 桌面半场:MCP 工具在**根上**用 `oneOf`/`anyOf` 表达分支时,模型拿到的广播 schema
// 必须自洽 —— 分支要求的字段不得被根上的约束禁掉。
//
// 大白话:上游 `mcp/catalog.ts` 的 `convertTool` 在合成给模型看的 schema 时,无条件写死
// `properties: <广播值 ?? {}>` + `additionalProperties: false`。而 JSON Schema 的
// `additionalProperties` **只看它所在那一层的 `properties`/`patternProperties`**,看不见
// `oneOf` 分支里的字段。于是一个根上只有分支、没有 properties 的工具(实测:alpha-platform
// 的 `cloud_dispatch` 广播 `{type:"object",$schema,oneOf:[2 分支]}`,分支各 9 properties /
// 5 required),经过 `convertTool` 之后变成「根上不许出现任何字段 + 每个分支都要求 5 个字段」——
// **没有任何对象能同时满足**。模型发 `{}` 是它对这份 schema 的合理服从。
//
// 这不是 `cloud_dispatch` 一个工具的事:**任何**广播根级 `oneOf`/`anyOf` 的第三方 MCP 工具
// 今天都被打成不可用。修复落在 alpha 已按 ADR-041 收编的 `src/session/tools.ts`
// (MCP 工具广播 schema 的唯一生产咽喉:它已经在那里重新推导并回写 `item.inputSchema`),
// 变换本体在 alpha 自有的 `src/mcp/alpha-branched-input-schema.ts`(ADR-043 谓词自动豁免)。
//
// ── 这个文件为什么这样测(而不是直接单测那个纯函数)────────────────────────────────
//   · 只测纯函数 ⇒ 把生产接线删掉仍然全绿(本仓已点名过这个形态)。所以这里起**一台真的
//     streamable-HTTP MCP server**、由它**自己在线上广播**那份 schema,走**真的**
//     `SessionTools.resolve`,再从返回的工具上读**模型真正会看到的那个对象**
//     (`asSchema(tool.inputSchema).jsonSchema` —— 与引擎交给 provider 的是同一条取法)。
//   · 判据不是「我改了一行」,而是根上的约束到底禁没禁掉分支字段:`rootForbiddenBranchFields()`
//     把缺陷形态逐字机械化。它自己也可能瞎,所以有一条**自检**用例:把修复前的那份广播
//     schema(实测记录下来的字面量)喂进去,必须点名全部 9 个字段。先证明这个手段能测出
//     已知的坏,再用它判未知的好。
//   · 对照臂(普通 object 形状的工具)断言广播 schema 与**修复前逐字相同** —— 期望值是
//     手写字面量,不从被测代码推导(自指等价链会跟着一起改错)。
//
// 姊妹闸:`alpha-session-tools-alias-lock.test.ts`(#972)用同一套 harness 守别名双射,
// 本文件不重复它。

import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema, type Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { asSchema } from "ai"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { AlphaToolPolicy } from "@/permission/alpha-tool-policy"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * 分支臂的广播 schema —— 形状逐字取自 alpha-platform `cloud_dispatch` 的实测广播
 * (`docs/verification/2026-09-02-req144-1216-published-build-and-reachability/README.md`:
 * `{type:"object",$schema,oneOf:[2 分支]}`,分支各 9 properties / 5 required)。
 */
const BRANCHED_INPUT_SCHEMA = {
  type: "object",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        schema_version: { type: "string" },
        idempotency_key: { type: "string" },
        autonomy: { const: "pipeline" },
        kind: { type: "string" },
        input: { type: "object" },
        objective: { type: "string" },
        capabilities: { type: "array" },
        budget: { type: "object" },
        metadata: { type: "object" },
      },
      required: ["schema_version", "idempotency_key", "autonomy", "kind", "input"],
    },
    {
      type: "object",
      properties: {
        schema_version: { type: "string" },
        idempotency_key: { type: "string" },
        autonomy: { const: "bounded-agent" },
        objective: { type: "string" },
        capabilities: { type: "array" },
        kind: { type: "string" },
        input: { type: "object" },
        budget: { type: "object" },
        metadata: { type: "object" },
      },
      required: ["schema_version", "idempotency_key", "autonomy", "objective", "capabilities"],
    },
  ],
} as const

/** 对照臂:根上就是普通 object 的工具(绝大多数 MCP 工具是这个形状)。 */
const PLAIN_INPUT_SCHEMA = {
  type: "object",
  properties: { job_id: { type: "string" } },
  required: ["job_id"],
  $schema: "http://json-schema.org/draft-07/schema#",
} as const

/**
 * 修复**前**,分支臂真正广播给模型的东西(2026-09-03 实测记录,不是推演)。
 * 只用于下面那条判据自检 —— 它证明 `rootForbiddenBranchFields()` 测得出这个已知的坏。
 */
const PRE_FIX_BRANCHED_BROADCAST = {
  ...BRANCHED_INPUT_SCHEMA,
  properties: {},
  additionalProperties: false,
}

/**
 * 修复**前**,对照臂真正广播给模型的东西(同一次实测记录)。修复后必须**逐字**还是它。
 * 手写字面量,刻意不从生产常量/被测函数推导。
 */
const PLAIN_BROADCAST = {
  type: "object",
  properties: { job_id: { type: "string" } },
  required: ["job_id"],
  $schema: "http://json-schema.org/draft-07/schema#",
  additionalProperties: false,
}

/**
 * bun 默认 5s 对本文件不够 —— 而慢的**不是**被测代码。实测(2026-09-03,本机):两条
 * `it.instance` 各自单独跑都是 ~1.0s,放进同一个文件时**第二条**恒 5003ms 超时,与哪一条
 * 排在第二无关(把两条对调,超时跟着位置走)。用例体本身只花 10ms(instrument 过:
 * 起 server → mcp.add → resolve 全程 10ms),5s 花在实例拆除上 —— 服务器已被 scope 释放,
 * 之后 MCP 客户端 dispose 要等自己的超时。修复前的那一跑也是同一个数(5003.50ms),
 * 所以它是 harness 的既有成本,不是本次改动引入的。
 * 姊妹闸 alpha-session-tools-alias-lock.test.ts 撞不到,是因为它三条里只有一条走完整装配。
 */
const INSTANCE_TIMEOUT_MS = 30_000

/** 分支臂的 9 个分支字段(两个分支的并集),按字典序 —— 判据自检的期望值。 */
const BRANCH_FIELDS = [
  "autonomy",
  "budget",
  "capabilities",
  "idempotency_key",
  "input",
  "kind",
  "metadata",
  "objective",
  "schema_version",
]

/**
 * 本票的缺陷形态,逐字机械化:根上有分支时,`additionalProperties:false` 只放行根自己
 * `properties` 里列出的键 —— 任何**只出现在分支里**的字段都被根禁掉,而分支正要求它们。
 * 返回被禁掉的字段名(空 = 自洽)。
 */
function rootForbiddenBranchFields(schema: Record<string, any>): string[] {
  const branches = [
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
  ]
  if (branches.length === 0) return []
  if (schema.additionalProperties !== false) return []
  const allowed = new Set(Object.keys(schema.properties ?? {}))
  const forbidden = new Set<string>()
  for (const branch of branches) {
    for (const field of Object.keys((branch as Record<string, any>)?.properties ?? {})) {
      if (!allowed.has(field)) forbidden.add(field)
    }
  }
  return [...forbidden].sort()
}

/**
 * 一台**真的** streamable-HTTP MCP server:`tools/list` 按给定的 (名字 → inputSchema) 广播。
 * 不手搓 `Record<string, McpTool>` 喂给内层函数 —— 那正是「删掉生产接线仍然全绿」的形态。
 */
function testServer(tools: Readonly<Record<string, unknown>>) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = Object.entries(tools).map(([name, inputSchema]) => ({
        name,
        description: `remote ${name}`,
        inputSchema: inputSchema as MCPToolDef["inputSchema"],
      }))
      const protocol = new Server({ name: "alpha-793", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: listed }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const remote = (url: string) => ({ type: "remote" as const, url, oauth: false as const })

/**
 * 模型不是被测对象:`ProviderTransform.schema` 只读 `api.npm` / `providerID` / `api.id`,
 * 这里手写一个刻意避开 `@ai-sdk/openai` / `moonshotai` / `kimi` / `google` 四条改写分支的字面量,
 * 免得量到的是 provider 的改写而不是本票的变换。
 */
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

function testSession(): Session.Info {
  return {
    id: SessionID.create(),
    slug: "alpha-793",
    projectID: ProjectV2.ID.make("alpha-793"),
    directory: ".",
    title: "alpha-793",
    version: "0.0.0",
    time: { created: 0, updated: 0 },
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

type Processor = Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay">

/** 装配期只读 `.message.id`、只调 `registerToolDisplay`。 */
function testProcessor() {
  return {
    message: { id: MessageID.ascending() },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
    registerToolDisplay: () => {},
  } as unknown as Processor
}

/** 走**真的** `SessionTools.resolve` —— 生产里 prompt 装配唯一的那个入口。 */
const resolveTools = Effect.fn("alpha793.resolveTools")(function* () {
  const agents = yield* Agent.Service
  return yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: testModel(),
    session: testSession(),
    processor: testProcessor(),
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
})

/** 模型真正会看到的那个对象 —— 与引擎交给 provider 的是同一条取法。 */
const broadcastOf = (tools: Record<string, any>, key: string): Record<string, any> => {
  const tool = tools[key]
  if (!tool) throw new Error(`工具 ${key} 不在装配结果里(现有:${Object.keys(tools).join(", ")})`)
  return asSchema(tool.inputSchema).jsonSchema as Record<string, any>
}

// 依赖必须**显式进 group**(理由同 alpha-session-tools-alias-lock.test.ts):`LayerNode.compile`
// 的依赖走 `Layer.provide`,而 `SessionTools.resolve` 要从上下文里逐个取。这里刻意不 mock
// 任何一个 —— mock 掉之后删生产接线仍然全绿。
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      MCP.node,
      Agent.node,
      Permission.node,
      AlphaToolPolicy.node,
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
      // 显式钉死:一旦翻成 true,生产在宿主资源工具之后就 `return tools`,MCP 那一整段
      // 不再执行,判据会静默变成空跑。
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: false })],
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("根级 oneOf 的 MCP 工具:广播给模型的 schema 必须自洽 (#793)", () => {
  it.instance("根上有分支时,分支原样到达模型,且根上的约束不禁掉分支要求的字段", () =>
    Effect.gen(function* () {
      const server = yield* testServer({ dispatch: BRANCHED_INPUT_SCHEMA })
      const mcp = yield* MCP.Service
      yield* mcp.add("cloud", remote(server.url))

      const broadcast = broadcastOf(yield* resolveTools(), "cloud_dispatch")

      // ① 分支本体原样透传(一个「把 oneOf 删掉」的假修复在这里红)
      expect(broadcast.oneOf).toEqual(BRANCHED_INPUT_SCHEMA.oneOf as unknown as any[])
      // ② 自洽:根上的约束没有禁掉任何分支字段(修复前这里是全部 9 个)
      expect(rootForbiddenBranchFields(broadcast)).toEqual([])
    }),
    INSTANCE_TIMEOUT_MS,
  )

  it.instance("对照臂:根上是普通 object 的工具,广播 schema 与修复前逐字相同", () =>
    Effect.gen(function* () {
      // server 名与分支臂那条**刻意不同**:`MCP.Service` 的客户端按 server 名缓存,两条用例
      // 复用同一个名字时,后跑的那条会连上前一条已经关掉的传输并挂到超时 —— 那种红与本票
      // 无关,却长得像本票的红(姊妹闸 alpha-session-tools-alias-lock.test.ts 的三条用例
      // 同样各用一个名字)。
      const server = yield* testServer({ status: PLAIN_INPUT_SCHEMA })
      const mcp = yield* MCP.Service
      yield* mcp.add("plain", remote(server.url))

      expect(broadcastOf(yield* resolveTools(), "plain_status")).toEqual(PLAIN_BROADCAST)
    }),
    INSTANCE_TIMEOUT_MS,
  )

  test("判据自检:把修复前那份广播 schema 喂给它,必须点名全部 9 个分支字段", () => {
    expect(rootForbiddenBranchFields(PRE_FIX_BRANCHED_BROADCAST)).toEqual(BRANCH_FIELDS)
    // 反向:对照臂那种「根上没有分支」的形状,`additionalProperties:false` 是本票要保住的
    // fail-closed 初衷,不该被判成缺陷。
    expect(rootForbiddenBranchFields(PLAIN_BROADCAST)).toEqual([])
  })
})
