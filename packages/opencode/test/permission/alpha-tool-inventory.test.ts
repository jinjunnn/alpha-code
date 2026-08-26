// alpha-code#1129(reopen)—— **dynamic tool policy inventory** 的常驻闸(#724 §5 末条 +
// 设计稿 `2026-08-25-req131-settings-tool-policy` §3 表)。
//
// inventory 是 #1130 Settings「工具」节的唯一数据源。这里钉四件事:
//   ① 从 live registry/materialization 派生:builtin / plugin / host / MCP 四来源都在,
//      internal sentinel(StructuredOutput / _noop)不在,identity + authority + 每层 digest
//      + effective(9 型 reason)+ 「新发现」+ 无法核验计数逐项在场;
//   ② **徽标说真话**:inventory 说 disabled 的工具,生产 executor(`SessionTools.resolve()
//      .execute()`)当场拒绝 —— 同一 resolver,两面必须一致;
//   ③ binding change:inventory 发放的 digest 正是让 enabled 生效的那一个;rebind 后
//      reason 翻成 binding-changed、digest 换新;
//   ④ config ruleset 的 identity deny 折进 cap(`permission-ruleset`)—— Settings 能解释
//      「为什么这行锁着」,而不是显示 enabled 却执行不了。
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Exit } from "effect"
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
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ── 手写的期望字面量 ─────────────────────────────────────────────────────────
const ID_MCP_PAID = "mcp:policy:paid_action"
const ID_PLUGIN_PROBE = "plugin:probe:default"
const ID_BUILTIN_WRITE = "builtin::write"
const ALIAS_MCP_PAID = "policy_paid_action"

function testServer() {
  const counts = { call: 0 }
  const handle = Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = [
        { name: "paid_action", description: "remote paid", inputSchema: { type: "object", properties: {} } },
      ]
      const protocol = new Server({ name: "alpha-1129-inventory", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: listed }))
      protocol.setRequestHandler(CallToolRequestSchema, () => {
        counts.call += 1
        return Promise.resolve({ content: [{ type: "text" as const, text: "SIDE-EFFECT-EXECUTED" }] })
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

// 分区隔离:tmpdir instance 的 project.id 在本文件多个用例间相同 ⇒ (anonymous, workspace)
// 策略文件会跨用例泄漏(前一条写的 disabled 咬到后一条)。用生产层自己的 account 注入口
// (#1128 的测试口)给每条用例独立分区;层其余部分全是生产的。
let policyAccount = "anonymous"
let configPermission: Record<string, unknown> = {}
const freshPolicyAccount = Effect.sync(() => {
  policyAccount = `t-${Math.random().toString(36).slice(2)}`
  configPermission = {}
})

const writeProbePlugin = Effect.fn("alpha1129inv.writeProbePlugin")(function* () {
  const test = yield* TestInstance
  const dir = path.join(test.directory, ".opencode", "tool")
  yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "probe.ts"),
      [
        "export default {",
        "  description: 'alpha 1129 inventory probe tool',",
        "  args: {},",
        "  execute: async () => 'ok',",
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

const resolveTools = Effect.fn("alpha1129inv.resolveTools")(function* () {
  const agents = yield* Agent.Service
  const session: Session.Info = {
    id: SESSION_ID,
    slug: "alpha-1129-inv",
    projectID: ProjectV2.ID.make("alpha-1129-inv"),
    directory: ".",
    title: "alpha-1129-inv",
    version: "0.0.0",
    time: { created: 0, updated: 0 },
    permission: [{ permission: "*", pattern: "*", action: "allow" } as PermissionV1.Rule],
  }
  return yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: testModel(),
    session,
    processor: testProcessor(),
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      AlphaToolInventory.node,
      AlphaToolPolicy.node,
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
          // I4:inventory 的 ruleset 轴读 `cfg.permission`(生产 `Permission.fromConfig` 原样吃它);
          // 「用户写得出这条 config」的可达性已由 725 探针的 R1(真 Config + 真 opencode.json)钉住。
          get: () => Effect.sync(() => ({ permission: configPermission }) as never),
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

const setup = Effect.fn("alpha1129inv.setup")(function* () {
  yield* freshPolicyAccount
  yield* writeProbePlugin()
  const server = testServer()
  const running = yield* server.handle
  const mcp = yield* MCP.Service
  yield* mcp.add("policy", remote(running.url))
  return { counts: server.counts, url: running.url }
})

describe("#1129 dynamic tool policy inventory(#724 §5)", () => {
  it.instance("I1 从 live registry 派生:四来源在场、sentinel 缺席、digest/新发现/无法核验计数逐项在场", () =>
    Effect.gen(function* () {
      yield* setup()
      const inventory = yield* AlphaToolInventory.Service
      const listed = yield* inventory.list()
      expect(listed.version).toBe(1)
      // 「仅当前账户与当前项目」:分区与引擎自己的一致。
      const policy = yield* AlphaToolPolicy.Service
      expect(listed.partition).toEqual((yield* policy.inspect()).partition)
      expect(listed.user.status).toBe("absent")
      expect(listed.managed.status).toBe("ok")

      const tools = listed.services.flatMap((service) => service.tools)
      const byCanonical = new Map(tools.map((tool) => [tool.canonical, tool]))
      // builtin:默认 enabled,binding = 应用常量。
      const write = byCanonical.get(ID_BUILTIN_WRITE)
      expect(write?.effective).toMatchObject({ state: "enabled", reason: { kind: "default", class: "builtin" } })
      expect(write?.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(write?.newlyDiscovered).toBe(false)
      // plugin:默认 ask,新发现,binding 是本装载代 digest。
      const probe = byCanonical.get(ID_PLUGIN_PROBE)
      expect(probe?.effective).toMatchObject({ state: "ask", reason: { kind: "default", class: "plugin" } })
      expect(probe?.newlyDiscovered).toBe(true)
      expect(probe?.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      // MCP:默认 ask,新发现,service 行携带写 enabled 用的当前 digest。
      const paid = byCanonical.get(ID_MCP_PAID)
      expect(paid?.effective).toMatchObject({ state: "ask", reason: { kind: "default", class: "third-party-mcp" } })
      expect(paid?.newlyDiscovered).toBe(true)
      expect(paid?.authority).toEqual({ kind: "not-asserted" })
      const mcpService = listed.services.find((service) => service.source === "mcp" && service.origin === "policy")
      expect(mcpService?.class).toBe("third-party-mcp")
      expect(mcpService?.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      // internal sentinel 不进 Settings(§6 窄例外)。
      expect(byCanonical.has("host::StructuredOutput")).toBe(false)
      expect(tools.some((tool) => tool.technicalId === "_noop")).toBe(false)
      // 无法核验计数:健康现场为 0(owner 裁决 Q1 的暴露口)。
      expect(listed.invalid).toEqual({ count: 0, entries: [] })
    }),
  )

  it.instance("I2 徽标说真话:inventory 说 disabled 的工具,生产 executor 当场拒绝(同一 resolver)", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      const inventory = yield* AlphaToolInventory.Service
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" })
      const listed = yield* inventory.list()
      const paid = listed.services.flatMap((s) => s.tools).find((tool) => tool.canonical === ID_MCP_PAID)
      expect(paid?.effective).toMatchObject({ state: "disabled", reason: { kind: "user", level: "tool" } })
      expect(paid?.record).toEqual({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" })
      expect(paid?.newlyDiscovered).toBe(false)
      // 同一主体、另一面:生产执行入口必须给出同一个结论。
      const tools = yield* resolveTools()
      const exit = yield* Effect.promise(() =>
        tools[ALIAS_MCP_PAID]!.execute!({}, { toolCallId: "i2", messages: [] } as never),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit) || counts.call === 0).toBe(true)
      expect(counts.call).toBe(0)
    }),
  )

  it.instance("I3 binding change:inventory 发放的 digest 正是让 enabled 生效的那一个;rebind 后回 ask + 新 digest", () =>
    Effect.gen(function* () {
      yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      const inventory = yield* AlphaToolInventory.Service
      const before = yield* inventory.list()
      const digest = before.services.find((s) => s.source === "mcp" && s.origin === "policy")?.bindingDigest
      expect(digest).toBeDefined()
      yield* policy.setRecord({
        selector: { level: "service", source: "mcp", origin: "policy" },
        state: "enabled",
        bindingDigest: digest!,
      })
      const enabled = yield* inventory.list()
      const paidEnabled = enabled.services.flatMap((s) => s.tools).find((tool) => tool.canonical === ID_MCP_PAID)
      expect(paidEnabled?.effective).toMatchObject({ state: "enabled", reason: { kind: "user", level: "service" } })
      // rebind:同一配置键换 URL ⇒ digest 换新、enabled 记录失效回 ask(§5)。
      const second = testServer()
      const running2 = yield* second.handle
      const mcp = yield* MCP.Service
      yield* mcp.add("policy", remote(running2.url))
      const after = yield* inventory.list()
      const newDigest = after.services.find((s) => s.source === "mcp" && s.origin === "policy")?.bindingDigest
      expect(newDigest).toBeDefined()
      expect(newDigest).not.toBe(digest)
      const paidAfter = after.services.flatMap((s) => s.tools).find((tool) => tool.canonical === ID_MCP_PAID)
      expect(paidAfter?.effective).toMatchObject({ state: "ask", reason: { kind: "binding-changed", level: "service" } })
    }),
  )

  it.instance("I4 config ruleset 的 identity deny 折进 cap:Settings 能解释「为什么锁着」", () =>
    Effect.gen(function* () {
      yield* setup()
      configPermission = { [ID_MCP_PAID]: "deny" }
      const inventory = yield* AlphaToolInventory.Service
      const listed = yield* inventory.list()
      const paid = listed.services.flatMap((s) => s.tools).find((tool) => tool.canonical === ID_MCP_PAID)
      expect(paid?.effective.state).toBe("disabled")
      expect(paid?.effective.reason).toEqual({ kind: "cap-hard-deny", sources: ["permission-ruleset"] })
    }),
  )

  it.instance("I5 quarantine 浮出水面:文档损坏 ⇒ user.status=quarantined,工具逐行 disabled(可解释)", () =>
    Effect.gen(function* () {
      yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      const inventory = yield* AlphaToolInventory.Service
      yield* policy.setRecord({ selector: { level: "class", class: "plugin" }, state: "enabled" })
      const { partition } = yield* policy.inspect()
      const file = policyFilePath(path.join(Global.Path.data, "alpha-tool-policy"), partition)
      yield* Effect.promise(() => fs.writeFile(file, "not a document"))
      const listed = yield* inventory.list()
      expect(listed.user.status).toBe("quarantined")
      const paid = listed.services.flatMap((s) => s.tools).find((tool) => tool.canonical === ID_MCP_PAID)
      expect(paid?.effective.state).toBe("disabled")
      expect(paid?.effective.reason.kind).toBe("quarantine")
    }),
  )
})
