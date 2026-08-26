// #223 R5 Blocker —— 通用 Remote MCP 是第三条现存的 web search 出口。
//
// R4 把主权闸下沉到两条**传输**出口(`tool/mcp-websearch.ts` 的 `call()` 与
// `core/src/tool/websearch.ts` 的 `callMcp()`),并声称那是「共同执行边界」。R5 给出仓内**已支持**
// 的反例:配置里直接声明任意 Remote MCP,
//
//     { "mcp": { "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" } } }
//
// 引擎经 `src/mcp/index.ts` 建**通用** MCP 传输,产生 `exa_web_search_exa`。普通模式经
// `session/tools.ts` → `McpCatalog.convertTool()` → `client.callTool()`,code-mode 经
// `tool/code-mode.ts` 的 `invokeChildTool` 直接 `client.callTool()` —— 两条都不经过那两道传输闸。
//
// 唯一同时钳制这两条链的点是 `plugin.trigger("tool.execute.before", …)`,也就是 @alpha-code/ext
// 的钩子。本文件把那份 exa 配置当**真实配置**跑:真 streamable-HTTP MCP server、真 `mcp` 配置段、
// 真 `plugin` 装载(装的就是 `packages/ext/src/plugin.ts` 本体)、真 `Plugin.Service`、真
// `MCP.Service`,两条链各跑一次,断言**被拒 + 远端零 `tools/call`**。
//
// 正向对照同样真跑:主权信号不置位时,同一条链会真的打到远端。没有它,红旗可能只是构造错了。
//
// 上游文件零改动。测试文件对 north-star 守卫是 `A`(新增),不触发 `--diff-filter=DMR`。

import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { MCP } from "../../src/mcp/index"
import { McpCatalog } from "../../src/mcp/catalog"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session/session"
import { CodeModeTool } from "../../src/tool/code-mode"
import { Tool } from "../../src/tool/tool"
import * as Truncate from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

// ext 的主权信号名(alpha 自有包;这里只取常量,判决逻辑由被装载的插件本体执行)。
import {
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_ENV,
  LOCAL_WEBSEARCH_DENY_ENV,
} from "../../../ext/src/cloud-websearch-kill"

/** 真 MCP 服务 + 真 Plugin 服务(会真的按 config.plugin 装载外部插件)。 */
const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Plugin.node])))

const EXA_SERVER = "exa"
/** 真实的 exa MCP 工具名(`mcp.exa.ai` 的 `web_search_exa`);拼进 server 名后是 `exa_web_search_exa`。 */
const EXA_TOOL = "web_search_exa"
const TOOL_ID = McpCatalog.toolName(EXA_SERVER, EXA_TOOL)

/** ext 插件本体的绝对路径 —— 装的是生产代码,不是替身。 */
const EXT_PLUGIN = join(import.meta.dir, "..", "..", "..", "ext", "src", "plugin.ts")

type StandIn = { url: string; calls: string[]; close: () => Promise<void> }

async function startExa(): Promise<StandIn> {
  const protocol = new McpServer({ name: "exa-stand-in", version: "1.0.0" }, { capabilities: { tools: {} } })
  protocol.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        {
          name: EXA_TOOL,
          description: "Real-time web search",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    }),
  )
  const calls: string[] = []
  protocol.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push(request.params.name)
    return Promise.resolve({ content: [{ type: "text", text: "search results the model must not get" }] })
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })
  await protocol.connect(transport)
  const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
  return {
    url: http.url.toString(),
    calls,
    close: async () => {
      await protocol.close().catch(() => {})
      http.stop(true)
    },
  }
}

// 一个 transport 只服一次握手,所以每个用例各占一个替身。
let denied: StandIn
let deniedCodeMode: StandIn
let allowed: StandIn
let allowedCodeMode: StandIn
let alphaRoot = ""
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  denied = await startExa()
  deniedCodeMode = await startExa()
  allowed = await startExa()
  allowedCodeMode = await startExa()
  alphaRoot = realpathSync(mkdtempSync(join(tmpdir(), "alpha-mcp-gate-")))
  for (const key of ["ALPHA_GLOBAL_DIR", LOCAL_WEBSEARCH_DENY_ENV, CLOUD_MCP_SERVER_ENV, CLOUD_MCP_DEF_ENV])
    saved[key] = process.env[key]
  // AlphaExt 初始化前置(sidecar 侧由 main 落定的环境根)。
  process.env.ALPHA_GLOBAL_DIR = alphaRoot
})

afterAll(async () => {
  await Promise.all([denied?.close(), deniedCodeMode?.close(), allowed?.close(), allowedCodeMode?.close()])
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const withSovereignty = (on: boolean) => {
  if (on) {
    // main 的 applyWebSearchSovereignty():平台代付(或 kill-switch)时置位本地判决。
    process.env[LOCAL_WEBSEARCH_DENY_ENV] = "1"
    process.env[CLOUD_MCP_SERVER_ENV] = "cloud"
    return
  }
  delete process.env[LOCAL_WEBSEARCH_DENY_ENV]
  delete process.env[CLOUD_MCP_SERVER_ENV]
}

/**
 * 用户配置里那份 exa remote MCP + alpha 注入面合并进来的 ext 插件(生产两者同源:一份 config)。
 * 取的是 thunk 而不是值 —— 用例注册发生在 `beforeAll` 之前,替身那时还没起来。
 */
const configWith = (server: () => StandIn) => () => ({
  mcp: { [EXA_SERVER]: { type: "remote" as const, url: server().url, oauth: false as const } },
  plugin: [EXT_PLUGIN],
})

const truncateStub = Layer.mock(Truncate.Service, {
  output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
})
const agentStub = Layer.mock(Agent.Service, {
  get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} } as never),
})
const sessionStub = Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as never) })

const toolContext = (over?: Partial<Tool.Context>): Tool.Context => ({
  sessionID: "ses_mcp_gate" as never,
  messageID: "msg_mcp_gate" as never,
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_mcp_gate",
  messages: [],
  metadata: () => Effect.void,
  // 最有利于绕过的授权状态:什么都放行。闸必须排在它之前,所以它一次也不该起作用。
  ask: () => Effect.void,
  ...over,
})

describe("#223 R5:用户自带的 remote MCP web search 同受主权判决(真实配置)", () => {
  // ── 普通模式 ───────────────────────────────────────────────────────────────
  // `session/tools.ts:390-409` 的 MCP 循环:convertTool → trigger("tool.execute.before") → ask →
  // execute。这里用真 `MCP.Service`(真配置建的真客户端)、真 `McpCatalog.convertTool`、真
  // `Plugin.Service`(真装载的 @alpha-code/ext),次序事实由
  // `packages/ext/src/cloud-websearch-kill.test.ts` 的「上游次序前提」对源码钉住。
  it.instance(
    "普通模式:exa_web_search_exa 被拒,远端零 tools/call",
    () =>
      Effect.gen(function* () {
        withSovereignty(true)
        const mcp = yield* MCP.Service
        const plugin = yield* Plugin.Service

        // 真实配置 → 真实注册名(不是手写的字面量)。
        const tools = yield* mcp.tools()
        expect(Object.keys(tools)).toContain(TOOL_ID)
        // ext 真的装载了,且钩子在。
        expect((yield* plugin.list()).some((hook) => typeof hook["tool.execute.before"] === "function")).toBe(true)

        const entry = tools[TOOL_ID]!
        const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
        const exit = yield* Effect.gen(function* () {
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: TOOL_ID, sessionID: "ses_mcp_gate" as never, callID: "call_1" },
            { args: { query: "effect typescript" } },
          )
          return yield* Effect.promise(() =>
            (item.execute as (args: unknown, options: unknown) => Promise<unknown>)(
              { query: "effect typescript" },
              { toolCallId: "call_1", messages: [] },
            ),
          )
        }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as Error) : new Error("unreachable")
        expect(error.message).toContain(TOOL_ID)
        expect(error.message).toContain("do not retry")
        // 零 egress:拒绝发生在 callTool 之前。
        expect(denied.calls).toEqual([])
      }),
    { config: configWith(() => denied) },
    30_000,
  )

  it.instance(
    "普通模式 · 正向对照:主权信号不置位时,同一条链真的打到远端",
    () =>
      Effect.gen(function* () {
        withSovereignty(false)
        const mcp = yield* MCP.Service
        const plugin = yield* Plugin.Service
        const entry = (yield* mcp.tools())[TOOL_ID]!
        const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)

        yield* plugin.trigger(
          "tool.execute.before",
          { tool: TOOL_ID, sessionID: "ses_mcp_gate" as never, callID: "call_1" },
          { args: { query: "effect typescript" } },
        )
        yield* Effect.promise(() =>
          (item.execute as (args: unknown, options: unknown) => Promise<unknown>)(
            { query: "effect typescript" },
            { toolCallId: "call_1", messages: [] },
          ),
        )

        expect(allowed.calls).toEqual([EXA_TOOL])
      }),
    { config: configWith(() => allowed) },
    30_000,
  )

  // ── code-mode ─────────────────────────────────────────────────────────────
  // 这条跑的是**真的** `CodeModeTool`:`invokeChildTool` 里 trigger → ask → `client.callTool()`。
  it.instance(
    "code-mode:tools.exa.web_search_exa 被拒,远端零 tools/call",
    () =>
      Effect.gen(function* () {
        withSovereignty(true)
        const tool = yield* Tool.init(yield* CodeModeTool)
        const exit = yield* tool
          .execute({ code: `return await tools.${EXA_SERVER}.${EXA_TOOL}({ query: 'effect typescript' })` }, toolContext())
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as Error) : new Error("unreachable")
        expect(error.message).toContain("do not retry")
        expect(deniedCodeMode.calls).toEqual([])
      }).pipe(Effect.provide(Layer.mergeAll(truncateStub, agentStub, sessionStub))),
    { config: configWith(() => deniedCodeMode) },
    30_000,
  )

  it.instance(
    "code-mode · 正向对照:主权信号不置位时,同一段程序真的打到远端",
    () =>
      Effect.gen(function* () {
        withSovereignty(false)
        const tool = yield* Tool.init(yield* CodeModeTool)
        const result = yield* tool.execute(
          { code: `return await tools.${EXA_SERVER}.${EXA_TOOL}({ query: 'effect typescript' })` },
          toolContext(),
        )

        expect(result.output).toContain("search results")
        expect(allowedCodeMode.calls).toEqual([EXA_TOOL])
      }).pipe(Effect.provide(Layer.mergeAll(truncateStub, agentStub, sessionStub))),
    { config: configWith(() => allowedCodeMode) },
    30_000,
  )

  // 闸不是「关掉所有 MCP」:同一个 server 上的非 web-search 工具照常可用(AC4 不误杀)。
  it.instance(
    "AC4:同一 server 上的兄弟工具不受影响,只有 web search 那一个被拒",
    () =>
      Effect.gen(function* () {
        withSovereignty(true)
        const plugin = yield* Plugin.Service
        const fire = (tool: string) =>
          plugin
            .trigger("tool.execute.before", { tool, sessionID: "ses_mcp_gate" as never, callID: "call_1" }, { args: {} })
            .pipe(Effect.exit)

        for (const tool of ["exa_deep_researcher_start", "exa_crawling", "exa_company_research", "read", "bash"])
          expect([tool, Exit.isSuccess(yield* fire(tool))]).toEqual([tool, true])
        expect(Exit.isFailure(yield* fire(TOOL_ID))).toBe(true)
      }),
    { config: configWith(() => denied) },
    30_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// #223 R6 Blocker ② —— 治理豁免不能由 MCP 名字伪造。
//
// R5 的例外判据是 `tool.startsWith("${server}_")`。R6 实跑证明:用户声明一个叫 `cloud_attacker`
// 的 remote MCP,`cloud_attacker_web_search` 就被当成 alpha 治理的云工具、在平台代付态直接放行。
// 现在判据是 `config` 钩子核验过的**端点身份**(名字 = 注入面点名的那个 **且** 配置里那条定义的
// URL 与 `ALPHA_CLOUD_MCP_DEF` 里 alpha 自己写的逐字相同),归属歧义一律 fail-closed。
//
// 这条跑的是**真实链路**:真 `mcp` 配置段、真装载的 `packages/ext/src/plugin.ts`、真
// `Plugin.Service`(真派发 config 钩子 → 真 `computeMcpOwnership`,结果落在**该插件实例的闭包**上,
// 见 #223 R7)。两个 server 的 URL 都指向
// 127.0.0.1:1(不做 DNS、必然 ECONNREFUSED),因为本组只判钩子,不需要真的连上去。
// ─────────────────────────────────────────────────────────────────────────────
const ALPHA_CLOUD_URL = "http://127.0.0.1:1/alpha-cloud"
const ATTACKER_URL = "http://127.0.0.1:1/attacker"

describe("#223 R6:治理豁免绑定端点身份(真实配置 + 真实 ext 装载)", () => {
  const withGovernedCloud = () => {
    process.env[LOCAL_WEBSEARCH_DENY_ENV] = "1"
    process.env[CLOUD_MCP_SERVER_ENV] = "cloud"
    // 注入面在代付分支托管的那份定义(端点身份的真源)。
    process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify({ type: "remote", url: ALPHA_CLOUD_URL, enabled: true })
  }

  const fire = (plugin: Plugin.Service["Service"], tool: string) =>
    plugin
      .trigger("tool.execute.before", { tool, sessionID: "ses_r6" as never, callID: "call_r6" }, { args: {} })
      .pipe(Effect.exit)

  it.instance(
    "cloud_attacker_web_search 拿不到豁免(R5 下它被当成治理云工具放行),真治理云工具照常放行",
    () =>
      Effect.gen(function* () {
        withGovernedCloud()
        const plugin = yield* Plugin.Service
        expect((yield* plugin.list()).some((hook) => typeof hook["tool.execute.before"] === "function")).toBe(true)

        // 端点身份对上 ⇒ 代付态权威通道照常可用(AC4:不误杀)。
        expect(Exit.isSuccess(yield* fire(plugin, "cloud_web_search"))).toBe(true)

        // 名字前缀撞上治理 server,但它自己不是治理 server ⇒ 豁免不给,照常被拒。
        const denied = yield* fire(plugin, "cloud_attacker_web_search")
        expect(Exit.isFailure(denied)).toBe(true)
        // `#1134`:原写法是 `denied as Exit.Failure<never, unknown>`。`fire` 走的是 defect(不是
        // 类型化失败),所以它的错误通道是 `never` ⇒ 那个 cast 两个方向都不重叠,tsgo 报 TS2352。
        // 改成用真的类型守卫 `Exit.isFailure` 收窄,断言一条没动。
        if (!Exit.isFailure(denied)) throw new Error("unreachable:上一行的断言已保证它是 Failure")
        expect((Cause.squash(denied.cause) as Error).message).toContain("do not retry")
      }),
    {
      config: () => ({
        mcp: {
          cloud: { type: "remote" as const, url: ALPHA_CLOUD_URL, enabled: false as const },
          cloud_attacker: { type: "remote" as const, url: ATTACKER_URL, enabled: false as const },
        },
        plugin: [EXT_PLUGIN],
      }),
    },
    30_000,
  )

  it.instance(
    "同名但换了 URL(后置来源覆盖回去)⇒ 端点身份核不上,连 cloud_web_search 也被拒",
    () =>
      Effect.gen(function* () {
        withGovernedCloud()
        const plugin = yield* Plugin.Service
        expect(Exit.isFailure(yield* fire(plugin, "cloud_web_search"))).toBe(true)
      }),
    {
      config: () => ({
        mcp: { cloud: { type: "remote" as const, url: ATTACKER_URL, enabled: false as const } },
        plugin: [EXT_PLUGIN],
      }),
    },
    30_000,
  )
})
