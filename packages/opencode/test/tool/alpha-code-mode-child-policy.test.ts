// alpha-code#1129(REQ-131 CODE#2)—— E4 Code Mode child 的**运行期**判据(#724 §6 E4)。
//
// #725 只对 E4 做过源码级确认(探针把 experimentalCodeMode 钉成 false,运行期从没量到);
// 本文件把它变成运行期可判:真的 `CodeModeTool`(真 CodeMode 解释器 + 真 in-memory MCP
// server,server 侧对每次 `tools/call` 计数),断言:
//   · identity 闸(ctx.ask)在 `tool.execute.before` 插件钩子**之前**解析 —— 未放行前钩子
//     看不到这次调用,传输零字节(deny/ask-reject 两种收口都一样);
//   · 放行后次序 = ask → hook → transport(次序由三方各自把事件推进同一个数组);
//   · identity deny 的 child 不进 child catalog(code-mode.ts 的 visibleTools 过滤),
//     且只有它消失,同 server 兄弟工具照常可调。
// 事件序列的记录方是三个互相独立的探头(ask mock / plugin mock / 真 server handler),
// 不是被测代码自己报的顺序。
import { describe, expect, test } from "bun:test"
import { CodeModeTool } from "@/tool/code-mode"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Layer } from "effect"
import { Permission } from "@/permission"
import type { ToolPolicyRecord } from "@opencode-ai/schema/alpha-tool-policy"
import { inMemoryToolPolicyLayer } from "../fixture/alpha-tool-policy"

const SERVER = "fixtures"

// 手写的期望字面量 —— 不从 canonicalToolIdentity() 导出。
const ID_CHILD_GET_TEXT = "mcp:fixtures:get_text"
const ID_CHILD_ADD = "mcp:fixtures:add"

const ALLOW_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }

// 与 code-mode 集成测试同款的裸 JSON-RPC 客户端(避开被其它 MCP 测试全局 mock 的 SDK Client)。
class RawJsonRpcClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(private transport: InMemoryTransport) {}

  async connect() {
    this.transport.onmessage = (message) => {
      const msg = message as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id === undefined) return
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    }
    await this.transport.start()
    await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    })
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    void this.transport.send({ jsonrpc: "2.0", id, method, params } as never)
    return result
  }

  listTools() {
    return this.request("tools/list", {})
  }

  callTool(params: { name: string; arguments?: Record<string, unknown> }, _schema?: unknown, _options?: unknown) {
    return this.request("tools/call", params)
  }
}

const TOOL_DEFS: MCPToolDef[] = [
  {
    name: "get_text",
    description: "Greet someone and return the greeting as text",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
] as MCPToolDef[]

type Probe = {
  /** ask / hook / transport 三方各自往这里推事件;次序断言读它。 */
  events: string[]
  /** server 侧 tools/call 计数,按工具名分桶 —— 「拦住了」由远端计数回答。 */
  transport: Record<string, number>
}

async function buildTool(input: {
  probe: Probe
  ask: (permission: string) => Effect.Effect<void>
  ruleset?: PermissionV1.Rule[]
  /** 文档轴用户记录(可变引用 —— 重读判据靠调用后改它)。缺省为空 ⇒ 四类默认。 */
  records?: ToolPolicyRecord[]
}) {
  const server = new Server({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    input.probe.events.push(`transport:${req.params.name}`)
    input.probe.transport[req.params.name] = (input.probe.transport[req.params.name] ?? 0) + 1
    return { content: [{ type: "text", text: "SIDE-EFFECT-EXECUTED" }] }
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new RawJsonRpcClient(clientTransport)
  await client.connect()

  const listed = (await client.listTools()).tools as MCPToolDef[]
  const mcpTools: Record<string, MCP.McpTool> = {}
  for (const def of listed) {
    mcpTools[McpCatalog.toolName(SERVER, def.name)] = {
      def,
      client: client as unknown as Client,
      identity: { source: "mcp", origin: SERVER, name: def.name },
      authority: { kind: "not-asserted" },
    }
  }

  const ruleset = input.ruleset ?? [ALLOW_ALL]
  const records = input.records ?? []
  const layer = Layer.mergeAll(
    // #1129:E4 的 identity 闸经 gateToolExecution 走 **Permission.Service**(不再经 ctx.ask);
    // ask 探头随之移到这里 —— 事件名与断言不变。
    Layer.mock(Permission.Service, {
      ask: ((req: { permission: string }) =>
        Effect.suspend(() => {
          input.probe.events.push(`ask:${req.permission}`)
          return input.ask(req.permission)
        })) as Permission.Interface["ask"],
    }),
    inMemoryToolPolicyLayer(records),
    Layer.mock(Plugin.Service, {
      trigger: ((name: unknown, hookInput: unknown, output: unknown) => {
        const tool = (hookInput as { tool?: string })?.tool
        input.probe.events.push(`hook:${String(name)}:${tool ?? ""}`)
        return Effect.succeed(output)
      }) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: ruleset } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed(mcpTools),
      clients: () => Effect.succeed({ [SERVER]: {} as any }),
      bindingFacts: () => Effect.succeed(undefined),
    }),
  )

  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_alpha_1129_e4"),
    messageID: MessageID.make("msg_alpha_1129_e4"),
    agent: "build",
    abort: new AbortController().signal,
    callID: "call_alpha_1129_e4",
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.suspend(() => {
        input.probe.events.push(`ask:${req.permission}`)
        return input.ask(req.permission)
      }),
  }

  return { tool: await Effect.runPromise(CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer))), ctx }
}

const probe = (): Probe => ({ events: [], transport: {} })

const runFailed = async (
  built: Awaited<ReturnType<typeof buildTool>>,
  code: string,
): Promise<Error> => {
  const exit = await Effect.runPromise(built.tool.execute({ code }, built.ctx).pipe(Effect.exit))
  if (Exit.isSuccess(exit)) throw new Error("expected the code-mode program to fail")
  return Cause.squash(exit.cause) as Error
}

describe("#1129 E4:code-mode child 的 identity 闸在 hook 之前、传输之前(运行期)", () => {
  test("ask 未放行(deny/reject 收口)⇒ 插件钩子零触发、tools/call 零调用、程序响亮失败", async () => {
    const p = probe()
    const built = await buildTool({
      probe: p,
      ask: (permission) => Effect.die(new Error(`identity policy denied ${permission}`)) as Effect.Effect<void>,
    })
    const error = await runFailed(built, "return await tools.fixtures.get_text({ name: 'world' })")
    expect(error.message).toContain(ID_CHILD_GET_TEXT)
    // 闸响过 —— 且响在钩子与传输都还没发生的时候。
    expect(p.events).toContain(`ask:${ID_CHILD_GET_TEXT}`)
    expect(p.events.filter((event) => event.startsWith("hook:tool.execute.before"))).toEqual([])
    expect(p.transport["get_text"] ?? 0).toBe(0)
  })

  test("ask 放行 ⇒ 次序恰为 ask → tool.execute.before → transport,且传输恰好一次", async () => {
    const p = probe()
    const built = await buildTool({ probe: p, ask: () => Effect.void })
    await Effect.runPromise(built.tool.execute({ code: "return await tools.fixtures.get_text({ name: 'w' })" }, built.ctx))
    const relevant = p.events.filter(
      (event) =>
        event === `ask:${ID_CHILD_GET_TEXT}` ||
        event.startsWith("hook:tool.execute.before") ||
        event.startsWith("transport:"),
    )
    expect(relevant).toEqual([
      `ask:${ID_CHILD_GET_TEXT}`,
      `hook:tool.execute.before:${SERVER}_get_text`,
      "transport:get_text",
    ])
    expect(p.transport["get_text"]).toBe(1)
  })

  test("identity deny 的 child 不进 child catalog:只有它消失,同 server 兄弟照常可调", async () => {
    const p = probe()
    const built = await buildTool({
      probe: p,
      // deny 走目录闸,不该走到 ask;真走到就当场炸,让「目录漏了、闸兜住」冒不了充。
      ask: (permission) =>
        permission === ID_CHILD_GET_TEXT
          ? (Effect.die(new Error(`unexpected ask for catalog-denied ${permission}`)) as Effect.Effect<void>)
          : Effect.void,
      ruleset: [ALLOW_ALL, { permission: ID_CHILD_GET_TEXT, pattern: "*", action: "deny" }],
    })
    const error = await runFailed(built, "return await tools.fixtures.get_text({ name: 'world' })")
    // 解释器视角它压根不存在(不是「存在但被拒」)。
    expect(error.message).not.toContain("identity policy")
    expect(p.transport["get_text"] ?? 0).toBe(0)
    expect(p.events.filter((event) => event.startsWith("hook:tool.execute.before"))).toEqual([])

    // 兄弟工具仍在、仍可调 —— 证明移除是 exact identity 的,不是清空整个 server。
    const out = await Effect.runPromise(
      built.tool.execute({ code: "return await tools.fixtures.add({ a: 1, b: 2 })" }, built.ctx),
    )
    expect(out.output).toBe("SIDE-EFFECT-EXECUTED")
    expect(p.transport["add"]).toBe(1)
    expect(p.events).toContain(`ask:${ID_CHILD_ADD}`)
  })

  // ── #1129 reopen:策略**文档轴**抵达 E4(同一 resolver,不是 ruleset 轴的复读)────────
  test("文档轴 tool 层 disabled ⇒ child 不进 catalog、held 调用零 ask/零 hook/零传输", async () => {
    const p = probe()
    const built = await buildTool({
      probe: p,
      // 文档轴 deny 走目录闸 + gate 的具名拒绝,不该走到 Permission.ask;走到就当场炸。
      ask: (permission) =>
        permission === ID_CHILD_GET_TEXT
          ? (Effect.die(new Error(`unexpected ask for policy-disabled ${permission}`)) as Effect.Effect<void>)
          : Effect.void,
      records: [{ selector: { level: "tool", canonical: ID_CHILD_GET_TEXT }, state: "disabled" }],
    })
    const error = await runFailed(built, "return await tools.fixtures.get_text({ name: 'world' })")
    expect(error.message).not.toContain("identity policy")
    expect(p.transport["get_text"] ?? 0).toBe(0)
    expect(p.events.filter((event) => event.startsWith("hook:tool.execute.before"))).toEqual([])
    // 兄弟工具照常(文档轴默认 ask ⇒ mock 放行)。
    const out = await Effect.runPromise(
      built.tool.execute({ code: "return await tools.fixtures.add({ a: 1, b: 2 })" }, built.ctx),
    )
    expect(out.output).toBe("SIDE-EFFECT-EXECUTED")
    expect(p.transport["add"]).toBe(1)
  })

  test("executor 调用时重读:child catalog 发出后收紧文档轴 ⇒ 同一 held 闭包的下一次调用当场 deny", async () => {
    // code-mode 每次 execute 重建子目录 ⇒ 「held」必须钉在**同一次 execute 内**捕获的
    // callTool 闭包上:程序连调两次,mock 在放行第一问的同时把文档轴收紧成 disabled ——
    // 目录与闭包都是收紧**前**的,第二次调用只有「调用时重读」能拦住。
    const p = probe()
    const records: ToolPolicyRecord[] = []
    let armed = true
    const built = await buildTool({
      probe: p,
      ask: () => {
        if (armed) {
          armed = false
          records.push({ selector: { level: "tool", canonical: ID_CHILD_GET_TEXT }, state: "disabled" })
        }
        return Effect.void
      },
      records,
    })
    const error = await runFailed(
      built,
      "await tools.fixtures.get_text({ name: 'a' }); return await tools.fixtures.get_text({ name: 'b' })",
    )
    // 第一次:默认 ask ⇒ 放行 ⇒ 恰一次传输;第二次:重读到 disabled ⇒ 具名拒绝,传输不再增长。
    expect(String(error.message)).toContain(ID_CHILD_GET_TEXT)
    expect(p.transport["get_text"]).toBe(1)
    expect(p.events.filter((event) => event === `ask:${ID_CHILD_GET_TEXT}`)).toHaveLength(1)
    // 还原 ⇒ 恢复可调(证明上面不是把 rig 弄坏了)。
    records.pop()
    await Effect.runPromise(built.tool.execute({ code: "return await tools.fixtures.get_text({ name: 'w2' })" }, built.ctx))
    expect(p.transport["get_text"]).toBe(2)
  })
})
