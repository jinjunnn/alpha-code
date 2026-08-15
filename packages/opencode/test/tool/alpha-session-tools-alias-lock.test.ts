// #972 —— session 侧**第三本**别名账本(跨来源)的装配级反向判据。
//
// 大白话:工具给模型看的名字(technical id)背后是一个身份(哪个插件 / 哪台 MCP server /
// 哪个内置工具 / 宿主自己)。名字与身份必须一一对应,否则模型以为在调 A、实际调的是 B。
// 仓里有三本这样的账本,`packages/opencode/src/session/tools.ts` 里的那本是唯一守**跨来源**
// 碰撞的:tool registry 那本只看 plugin↔builtin,MCP 那本只看 MCP 别名之间,两者都看不见
// 「一个 `.opencode/tool` 自定义工具」与「一台 MCP server 发布的工具」拼出同一个名字。
//
// 缺的不是生产代码 —— ADR-041 / #878 已经让它 fail-closed。缺的是**判据**:
//   · `session/tools.ts` 里 `aliases.add(technicalId, display.identity)` 的返回值本来就被丢弃,
//     整行删掉编译器不会吭声(`packages/opencode` 不在任何 alpha typecheck 面内);
//   · `SessionTools.resolve` 全仓零测试调用点,唯一生产调用点在 session 的 prompt 装配里。
// 也就是说:那道闸门今天是假的 —— 删掉它,全仓不红。
//
// 本文件把判据放到**生产咽喉**:真的写一个 `.opencode/tool/*.ts` 自定义工具、起一台真的
// streamable-HTTP MCP server、走真的 `SessionTools.resolve`,断言碰撞在**装配时**响亮失败。
// 咽喉是 `register()`(五个注册点的唯一必经处),不是按来源枚举三个循环各补一条 ——
// 咽喉对新来源默认拒绝,枚举对新来源默认放行。
//
// 保证本身(删掉本文件会失去什么):
//   · 删掉 `session/tools.ts` 的 `aliases.add(technicalId, display.identity)` ⇒ 不再有任何
//     东西变红:MCP 那份会**静默顶掉**同名的 plugin 工具,模型拿到的是另一个身份;
//   · 把它换成「碰撞时静默丢弃其中一个」⇒ 同样不再有东西变红(用户少一个工具);
//   · 把检查从 `register()` 下放到 registry / MCP 两个循环里各一份 ⇒ 宿主的 MCP 资源工具
//     (`list_mcp_resources` 那一族,`source: "host"`)两边都盖不住,而它与 plugin 工具撞得上;
//   · 断言只写「抛了没抛」或「工具数变了没变」⇒ 粒度比缺陷粗一格,上面两种错误实现都能过。
//
// 三条写法上的纪律:
//   · 期望值一律**手写字面量**(`"mcp:weather:current"`),不从 `canonicalToolIdentity` /
//     `McpCatalog.toolName` 等生产常量导出 —— 后者是自指等价链,改错生产的编码规则仍然全绿;
//   · 负向对照(「几乎撞但不撞」)必须在:没有它,一个「无条件抛」的实现能让全部正向用例
//     变绿,而所有用户的 MCP 工具全挂;
//   · `experimentalCodeMode` 显式钉成 `false`。它今天默认就是 false,但那是环境的偶然:
//     一旦翻成 true,生产在注册完宿主资源工具之后就 `return tools`,MCP 那一整段**不再执行**,
//     正向用例会从「拦住了」静默变成「压根没跑到」。负向对照里必须出现一个 MCP 来源的键,
//     就是为了让这种早退当场红而不是假绿。
//
// 本文件是 alpha 自有新增文件,对 north-star 守卫是 `A`(新增),不触发 `--diff-filter=DMR`;
// 零改动任何上游生产文件。它登记在 `scripts/gate-files.tsv`(未登记 = 在 alpha 门里一条都
// 不跑 = 又一个假绿),文件名带 `lock` 因而同时落进 `gate-file-registry` 的「命名命中闸门词
// 必须已分类」那条:登记行被删掉时也会当场红。
//
// 姊妹闸:MCP↔MCP 那一域由 alpha-mcp-alias-collision-lock.test.ts(#726)守,本文件不重复它。
// 基线:docs/design/2026-07-31-tool-identity-baseline.md 的 I1 行。

import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit } from "effect"
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
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * 一台**真的** streamable-HTTP MCP server,`tools/list` 回给定的工具名。
 *
 * 为什么不手搓一个 `Record<string, McpTool>` 喂给内层函数:那正是本票所修复的形态 ——
 * 自己拼一条等价链,删掉生产接线仍然全绿。工具名必须由服务器**自己在线上发布**。
 *
 * `resources` 参数决定是否声明 resources capability。声明之后 `hasMcpResourceServer` 为真,
 * 生产才会注册宿主那三个 `source: "host"` 的资源工具 —— 用例 2 的碰撞域就在那里。
 *
 * `inputSchema` 是 MCP SDK `ToolSchema` 的必填字段:少写它客户端解析当场抛,而错误会被
 * 吞成空的工具表,红的样子会被读成「账本没被调用」。
 */
function testServer(names: readonly string[], options: { resources?: boolean } = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = names.map((name) => ({
        name,
        description: `remote ${name}`,
        inputSchema: { type: "object", properties: {} },
      }))
      const protocol = new Server(
        { name: "alpha-session-alias", version: "1.0.0" },
        { capabilities: options.resources ? { tools: {}, resources: {} } : { tools: {} } },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: listed }))
      if (options.resources) {
        protocol.setRequestHandler(ListResourcesRequestSchema, () => Promise.resolve({ resources: [] }))
      }
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
 * 往当前 instance 的 `.opencode/tool/<file>.ts` 写一个真的自定义工具文件。
 * 生产的 registry 会用 `{tool,tools}/*.{js,ts}` glob 扫到它、动态 import、按
 * `<文件名>_<导出名>`(`default` 导出退化成文件名本身)派生 technical id。
 */
const writeCustomTool = Effect.fn("alpha972.writeCustomTool")(function* (file: string, exportName: string) {
  const test = yield* TestInstance
  const dir = path.join(test.directory, ".opencode", "tool")
  yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
  const decl = exportName === "default" ? "export default" : `export const ${exportName} =`
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, `${file}.ts`),
      [
        `${decl} {`,
        `  description: 'alpha 972 custom tool ${file}/${exportName}',`,
        "  args: {},",
        "  execute: async () => 'ok',",
        "}",
        "",
      ].join("\n"),
    ),
  )
})

/**
 * 断言:这次装配**响亮失败**,失败的是别名双射校验,而且错误里两个 canonical identity
 * 都点了名。返回 message 供调用方再断具体字面量。
 */
function collisionMessage(exit: Exit.Exit<unknown, unknown>): string {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected a failed Exit")
  const squashed = Cause.squash(exit.cause)
  expect(squashed).toBeInstanceOf(Error)
  const error = squashed as Error
  expect(error.name).toBe("ToolAliasCollisionError")
  return error.message
}

/**
 * 模型不是被测对象:`ProviderTransform.schema` 只读 `api.npm` / `providerID` / `api.id`
 * 三个字段(其余分支都是别的 provider 家族的),所以这里手写一个字面量,不去起 Provider 层。
 * 刻意避开 `@ai-sdk/openai` / `moonshotai` / `kimi` 三条会改写 schema 的分支。
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
    slug: "alpha-972",
    projectID: ProjectV2.ID.make("alpha-972"),
    directory: ".",
    title: "alpha-972",
    version: "0.0.0",
    time: { created: 0, updated: 0 },
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

type Processor = Pick<
  SessionProcessor.Handle,
  "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay"
>

/**
 * `processor` 在装配期只被读 `.message.id`,以及被调用 `registerToolDisplay`。
 * 收集下来的 snapshot 供负向对照断言「两个工具各自带住自己的身份」。
 */
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

/**
 * 走**真的** `SessionTools.resolve`(生产里唯一被 prompt 装配调用的那个入口)。
 * `promptOps` 只在 task 工具执行时才会被读,装配期从不被调用。
 */
const resolveTools = Effect.fn("alpha972.resolveTools")(function* (processor: Processor) {
  const agents = yield* Agent.Service
  return yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: testModel(),
    session: testSession(),
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
})

// `MCP.node` / `ToolRegistry.node` / `Agent.node` / `Permission.node` / `Plugin.node` /
// `Truncate.node` / `RuntimeFlags.node` 必须**显式进 group**:`LayerNode.compile` 的依赖走
// `Layer.provide`,不把依赖暴露到成功类型里,而 `SessionTools.resolve` 要从上下文里逐个取。
// compile 内部的共享 cache 保证被 group 暴露的这份与 ToolRegistry 自己消费的是**同一个**实例。
// 这里刻意**不** mock 任何一个:mock 掉之后删生产接线仍然全绿,那就又是一道假闸门。
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
      // 显式钉死:默认值哪天翻成 true,生产就在宿主资源工具之后 `return tools`,
      // MCP 那一整段不再执行,而判据会静默变成空跑。
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: false })],
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("跨来源别名碰撞在 session 装配时 fail-closed (#972)", () => {
  it.instance("plugin 自定义工具与 MCP 别名撞成同一个 technicalId ⇒ SessionTools.resolve 当场失败", () =>
    Effect.gen(function* () {
      // .opencode/tool/weather.ts 的 `current` 导出 ⇒ plugin:weather:current / 别名 weather_current
      yield* writeCustomTool("weather", "current")
      // 一台叫 weather 的 MCP server 发布 current ⇒ mcp:weather:current / 别名 weather_current
      const server = yield* testServer(["current"])
      const mcp = yield* MCP.Service
      yield* mcp.add("weather", remote(server.url))

      const message = collisionMessage(yield* resolveTools(testProcessor().handle).pipe(Effect.exit))
      expect(message).toContain('"weather_current"')
      expect(message).toContain("plugin:weather:current")
      expect(message).toContain("mcp:weather:current")
    }),
  )

  it.instance("plugin 自定义工具撞上宿主的 MCP 资源工具 ⇒ SessionTools.resolve 当场失败", () =>
    Effect.gen(function* () {
      // .opencode/tool/list_mcp_resources.ts 的 default 导出 ⇒ plugin:list_mcp_resources:default
      // / 别名 list_mcp_resources
      yield* writeCustomTool("list_mcp_resources", "default")
      // 声明 resources capability 的 server 让生产注册 host::list_mcp_resources —— 那一族
      // 既不在 registry 的账本里、也不在 MCP 的账本里,只有 session 这本盖得住。
      const server = yield* testServer(["unrelated"], { resources: true })
      const mcp = yield* MCP.Service
      yield* mcp.add("docs", remote(server.url))

      const message = collisionMessage(yield* resolveTools(testProcessor().handle).pipe(Effect.exit))
      expect(message).toContain('"list_mcp_resources"')
      expect(message).toContain("plugin:list_mcp_resources:default")
      expect(message).toContain("host::list_mcp_resources")
    }),
  )

  it.instance("近似但不碰撞的一对必须双双存活,且各自带住自己的身份", () =>
    Effect.gen(function* () {
      yield* writeCustomTool("weather", "current")
      const server = yield* testServer(["current"])
      const mcp = yield* MCP.Service
      // server 名换成 weather2 ⇒ 别名 weather2_current,与 weather_current 不撞
      yield* mcp.add("weather2", remote(server.url))

      const processor = testProcessor()
      const tools = yield* resolveTools(processor.handle)

      const keys = Object.keys(tools)
      expect(keys).toContain("weather_current")
      expect(keys).toContain("weather2_current")
      expect(processor.snapshots.get("weather_current")?.identity).toEqual({
        source: "plugin",
        origin: "weather",
        name: "current",
      })
      expect(processor.snapshots.get("weather2_current")?.identity).toEqual({
        source: "mcp",
        origin: "weather2",
        name: "current",
      })
    }),
  )
})
