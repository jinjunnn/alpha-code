// REQ-236 C1(`alpha-code#1573`)—— 「只读」「请求审批」两档下,四条委派入口都先按你选的档位问或拒
// (alpha 自有测试;north-star:alpha-owned)。方案 docs/design/req236-permissions-and-provenance.md §1.3 / §2.3。
//
// 规则表全绿也可能被入口绕过,所以本文件只驱动**真实入口**,判据是可观察结果:
//   E1 模型派子任务   —— 真 loop + 测试 LLM 发出 `task` 调用 → 真 TaskTool 的 `ctx.ask`;
//   E2 用户点名助手   —— 真 `SessionPrompt.prompt` 带 agent part(`@general`)→ 真 loop 置 `bypassAgentCheck`
//                       → 真 TaskTool;
//   E3 直接子任务     —— 真 `SessionPrompt.command` 走 `subtask:true` 命令 → 真 loop → handleSubtask;
//   E4 命令换助手     —— 真 `SessionPrompt.command` 走自带其它助手的非子任务命令。
// 档位规则表取自**生产注入**:真 `injectAlphaConfig`(ui-mac 主进程写给引擎的那份)产出的 `agent` 段原样写进
// 测试实例配置(只取 agent 段:注入面的 provider / enabled_providers 会把测试 LLM 挤掉)。
//
// 每格三样判据(AC1 / AC2 / AC5):
//   · 委派实现调用次数:E1–E3 = 真子会话数(TaskTool 在询问之后才建子会话);E4 = 以命令助手跑起来的
//     assistant 消息数;
//   · `permission.asked` 事件计数(事件总线上数,不看 pending 列表 —— 列表会被回复清空);
//   · 拒绝是具名的(`PermissionV1.DeniedError` / 工具错误里点名 `task`)。
// 「请求审批」档拒绝与超时都要让实现调用次数为 0(超时取 ALPHA_PERMISSION_ASK_TIMEOUT_MS 压短的期限)。
//
// 变异实测(交付时实跑):删掉 alpha-config-injection.ts 里 alpha-readonly / alpha-ask 的 `task` 规则 ⇒ E1 两臂红;
// 把 prompt.ts E2 的求值改回「有 agent part 就跳过」⇒ E2 两臂红;删掉 handleSubtask 的 askDelegation ⇒ E3 两臂红;
// 删掉 command 里的 askDelegation ⇒ E4 两臂红。
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { AlphaToolPolicy } from "../../src/permission/alpha-tool-policy"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import type { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// 期限压短:被测的是「会不会挂起等人批、到点是否 fail-closed」,不是「5 分钟有多长」。
// 在 beforeAll 里设、afterAll 还原:同进程跑多个文件时,模块顶层赋值会串到别的文件。
const ASK_TIMEOUT_MS = "1000"
const TEST_TIMEOUT_MS = 30_000

// ── 生产注入的 agent 段(真 injectAlphaConfig,临时盘;同 alpha-composer-tiers.test.ts 的非字面量动态 import)──
const INJECTION_MODULE = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "ui-mac",
  "src",
  "main",
  "alpha-config-injection.ts",
)
const { injectAlphaConfig } = (await import(INJECTION_MODULE)) as {
  injectAlphaConfig: (userDataPath: string) => { ok: boolean }
}
const MANAGED = [
  "ALPHA_GLOBAL_DIR",
  "XDG_CONFIG_HOME",
  "ALPHA_OPENCODE_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG_CONTENT",
] as const
const savedAskTimeout = process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"]
let injectedAgents: ConfigV1.Info["agent"] = {}
let tmp = ""
beforeAll(() => {
  process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = ASK_TIMEOUT_MS
  const saved: Record<string, string | undefined> = {}
  for (const k of MANAGED) saved[k] = process.env[k]
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1573-delegation-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  delete process.env.OPENCODE_CONFIG_CONTENT
  const userData = path.join(tmp, "userdata")
  for (const d of [
    process.env.ALPHA_GLOBAL_DIR,
    process.env.XDG_CONFIG_HOME,
    process.env.ALPHA_OPENCODE_HOME,
    process.env.XDG_DATA_HOME,
    userData,
  ])
    fs.mkdirSync(d, { recursive: true })
  const res = injectAlphaConfig(userData)
  if (!res.ok) throw new Error(`injectAlphaConfig failed: ${JSON.stringify(res)}`)
  injectedAgents = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!).agent
  // 只借 agent 段:还原 env,注入面其余部分不进入本测试实例的配置。
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
afterAll(() => {
  if (savedAskTimeout === undefined) delete process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"]
  else process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = savedAskTimeout
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── 引擎装配(与 test/session/alpha-subtask-attachment-policy.test.ts 同一组节点,外加测试 LLM)──────────
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
const mcp = Layer.succeed(
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
    startAuth: () => Effect.die("unexpected MCP auth in alpha-1573 tests"),
    authenticate: () => Effect.die("unexpected MCP auth in alpha-1573 tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in alpha-1573 tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)
const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  AlphaToolPolicy.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
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
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const it = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

// ── 测试实例配置:测试 LLM + 生产注入的 agent 段 + 两条委派命令 ───────────────────────────────────────
const COMMAND_SUBTASK = "delegate-sub" // E3:subtask:true,派给 general
const COMMAND_OTHER_AGENT = "delegate-main" // E4:非子任务,命令自带 build
const providerCfg = (url: string) =>
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
    agent: injectedAgents,
    command: {
      [COMMAND_SUBTASK]: {
        template: "inspect the cache key path",
        agent: "general",
        subtask: true,
        description: "inspect bug",
      },
      [COMMAND_OTHER_AGENT]: { template: "change the README title", agent: "build", description: "edit readme" },
    },
  }) satisfies Partial<ConfigV1.Info> as Partial<ConfigV1.Info>

const setup = Effect.fn("alpha1573.setup")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fsu = yield* FSUtil.Service
  yield* fsu.writeWithDirs(
    path.join(directory, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url) }),
  )
  yield* (yield* Config.Service).get()
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "REQ-236 delegation" })
  return { llm, sessions, chat, prompt: yield* SessionPrompt.Service, permission: yield* Permission.Service }
})

/** 三档 → composer 提交时带的 agent(「全部批准」不带,与 composer-state 的 PERM_AGENT 同值)。 */
const TIER = { allow: undefined, ask: "alpha-ask", readonly: "alpha-readonly" } as const
type Tier = keyof typeof TIER
const agentField = (tier: Tier) => (TIER[tier] ? { agent: TIER[tier] } : {})

type Outcome = {
  exit: Exit.Exit<unknown, unknown>
  asked: PermissionV1.Request[]
  children: number
}

/**
 * 跑一条入口,数 `permission.asked`,按 `answer` 处置那一问,收尾数子会话。
 * `reject` = 用户点拒绝;`timeout` = 不答,等期限到点;`none` = 不该有任何一问(有就让它自己超时、计数会红)。
 */
const drive = (
  sessionID: SessionID,
  entry: Effect.Effect<unknown, unknown, any>,
  answer: "reject" | "timeout" | "none",
) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const asked: PermissionV1.Request[] = []
    const unsub = yield* events.listen((event) => {
      if (event.type === Permission.Event.Asked.type) asked.push(event.data as PermissionV1.Request)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    const fiber = yield* entry.pipe(Effect.exit, Effect.forkChild)
    if (answer === "reject") {
      const pending = yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.length > 0 ? list : undefined
        }),
        "这条委派入口没有进入待批队列 —— 它没有在问",
        "10 seconds",
      )
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
    }
    const exit = yield* Fiber.join(fiber)
    const children = (yield* sessions.children(sessionID)).length
    console.log(
      `DELEGATION asked=${asked.map((a) => `${a.permission}:${a.patterns.join(",")}`).join("|") || "-"} children=${children} exit=${Exit.isSuccess(exit) ? "success" : (Cause.squash(exit.cause) as Error)?.constructor?.name}`,
    )
    return { exit, asked, children } satisfies Outcome
  })

const failureOf = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

/** E1/E2 的 task 工具调用落在哪个状态(拒绝时工具错误里必须点名 task)。 */
const taskPart = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const history = yield* MessageV2.filterCompactedEffect(sessionID)
    return history
      .flatMap((entry) => entry.parts)
      .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task")
  })

/** E4 的实现调用 = 以命令自带助手(build)跑起来的 assistant 消息。 */
const assistantsAs = (sessionID: SessionID, agent: string) =>
  Effect.gen(function* () {
    const history = yield* MessageV2.filterCompactedEffect(sessionID)
    return history.filter((entry) => entry.info.role === "assistant" && entry.info.agent === agent).length
  })

const TASK_CALL = { description: "edit a file", prompt: "change the README title", subagent_type: "general" }

// ── E1 模型派子任务 ─────────────────────────────────────────────────────────────────────────────────
it.instance(
  "E1 只读:模型派 task(general)⇒ 具名拒绝,零子会话,不问",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, chat } = yield* setup()
      yield* llm.tool("task", TASK_CALL)
      const out = yield* drive(
        chat.id,
        prompt.prompt({ sessionID: chat.id, ...agentField("readonly"), parts: [{ type: "text", text: "改个文件" }] }),
        "none",
      )
      expect(out.children).toBe(0)
      expect(out.asked).toEqual([])
      const part = yield* taskPart(chat.id)
      expect(part?.state.status).toBe("error")
      if (part?.state.status === "error") expect(part.state.error).toContain('"permission":"task"')
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E1 请求审批:模型派 task(general)⇒ 恰好一问 task;拒绝 ⇒ 零子会话",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, chat } = yield* setup()
      yield* llm.tool("task", TASK_CALL)
      const out = yield* drive(
        chat.id,
        prompt.prompt({ sessionID: chat.id, ...agentField("ask"), parts: [{ type: "text", text: "改个文件" }] }),
        "reject",
      )
      expect(out.asked.map((a) => [a.permission, a.patterns])).toEqual([["task", ["general"]]])
      expect(out.children).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E1 全部批准:模型派 task(general)⇒ 不问,子任务照常执行(行为不变)",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, chat } = yield* setup()
      yield* llm.tool("task", TASK_CALL)
      const out = yield* drive(
        chat.id,
        prompt.prompt({ sessionID: chat.id, ...agentField("allow"), parts: [{ type: "text", text: "改个文件" }] }),
        "none",
      )
      expect(out.asked).toEqual([])
      expect(out.children).toBe(1)
      expect(Exit.isSuccess(out.exit)).toBe(true)
    }),
  TEST_TIMEOUT_MS,
)

// ── E2 用户点名助手(@general)──────────────────────────────────────────────────────────────────────────
const mention = (sessionID: SessionID, tier: Tier) =>
  ({
    sessionID,
    ...agentField(tier),
    parts: [
      { type: "text" as const, text: "@general 改个文件" },
      { type: "agent" as const, name: "general" },
    ],
  }) as SessionPrompt.PromptInput

it.instance(
  "E2 只读:@general ⇒ 不再跳过 task 的判定,具名拒绝,零子会话",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, chat } = yield* setup()
      yield* llm.tool("task", TASK_CALL)
      const out = yield* drive(chat.id, prompt.prompt(mention(chat.id, "readonly")), "none")
      expect(out.children).toBe(0)
      expect(out.asked).toEqual([])
      const part = yield* taskPart(chat.id)
      expect(part?.state.status).toBe("error")
      if (part?.state.status === "error") expect(part.state.error).toContain('"permission":"task"')
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E2 请求审批:@general ⇒ 恰好一问 task;拒绝 ⇒ 零子会话",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, chat } = yield* setup()
      yield* llm.tool("task", TASK_CALL)
      const out = yield* drive(chat.id, prompt.prompt(mention(chat.id, "ask")), "reject")
      expect(out.asked.map((a) => [a.permission, a.patterns])).toEqual([["task", ["general"]]])
      expect(out.children).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E2 全部批准:@general ⇒ 仍跳过询问,子任务照常执行(行为不变)",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, chat } = yield* setup()
      yield* llm.tool("task", TASK_CALL)
      const out = yield* drive(chat.id, prompt.prompt(mention(chat.id, "allow")), "none")
      expect(out.asked).toEqual([])
      expect(out.children).toBe(1)
    }),
  TEST_TIMEOUT_MS,
)

// ── E3 直接子任务(subtask:true 命令)──────────────────────────────────────────────────────────────────
/** composer 发斜杠命令的同一个引擎入口:`session.command`,档位随 `agent` 字段(「全部批准」不带)。 */
const runCommand = (sessionID: SessionID, tier: Tier, command = COMMAND_SUBTASK) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    return yield* prompt.command({ sessionID, command, arguments: "", ...agentField(tier) })
  })

it.instance(
  "E3 只读:subtask 命令派给 general ⇒ 具名拒绝(DeniedError),零子会话,不问",
  () =>
    Effect.gen(function* () {
      const { chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "readonly"), "none")
      expect(failureOf(out.exit)).toBeInstanceOf(PermissionV1.DeniedError)
      expect(out.asked).toEqual([])
      expect(out.children).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E3 请求审批:subtask 命令派给 general ⇒ 恰好一问 task;拒绝 ⇒ 零子会话",
  () =>
    Effect.gen(function* () {
      const { chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "ask"), "reject")
      expect(out.asked.map((a) => [a.permission, a.patterns])).toEqual([["task", ["general"]]])
      expect(failureOf(out.exit)).toBeInstanceOf(PermissionV1.RejectedError)
      expect(out.children).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E3 请求审批:没人答 ⇒ 到点 fail-closed,零子会话",
  () =>
    Effect.gen(function* () {
      const { chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "ask"), "timeout")
      expect(out.asked.map((a) => [a.permission, a.patterns])).toEqual([["task", ["general"]]])
      expect(failureOf(out.exit)).toBeInstanceOf(Permission.UnansweredError)
      expect(out.children).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E3 全部批准:subtask 命令派给 general ⇒ 不问,子任务照常执行(行为不变)",
  () =>
    Effect.gen(function* () {
      const { chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "allow"), "none")
      expect(out.asked).toEqual([])
      expect(out.children).toBe(1)
      expect(Exit.isSuccess(out.exit)).toBe(true)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E3 同档自身:只读 / 请求审批档运行 /review(目标即本档)⇒ 不问、照常执行",
  () =>
    Effect.gen(function* () {
      const { chat, sessions } = yield* setup()
      const readonly = yield* drive(chat.id, runCommand(chat.id, "readonly", "review"), "none")
      expect(readonly.asked).toEqual([])
      expect(readonly.children).toBe(1)
      expect(Exit.isSuccess(readonly.exit)).toBe(true)
      expect((yield* sessions.children(chat.id))[0]!.agent).toBe("alpha-readonly")

      const other = yield* sessions.create({ title: "REQ-236 /review ask" })
      const ask = yield* drive(other.id, runCommand(other.id, "ask", "review"), "none")
      expect(ask.asked).toEqual([])
      expect(ask.children).toBe(1)
      expect(Exit.isSuccess(ask.exit)).toBe(true)
    }),
  TEST_TIMEOUT_MS,
)

// ── E4 命令换助手(非子任务,命令自带 build)────────────────────────────────────────────────────────────
it.instance(
  "E4 只读:命令自带 build ⇒ 具名拒绝(DeniedError),命令不执行,不问",
  () =>
    Effect.gen(function* () {
      const { llm, chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "readonly", COMMAND_OTHER_AGENT), "none")
      expect(failureOf(out.exit)).toBeInstanceOf(PermissionV1.DeniedError)
      expect(out.asked).toEqual([])
      expect(yield* assistantsAs(chat.id, "build")).toBe(0)
      expect(yield* llm.calls).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E4 请求审批:命令自带 build ⇒ 恰好一问 task;拒绝 ⇒ 命令不执行",
  () =>
    Effect.gen(function* () {
      const { llm, chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "ask", COMMAND_OTHER_AGENT), "reject")
      expect(out.asked.map((a) => [a.permission, a.patterns])).toEqual([["task", ["build"]]])
      expect(failureOf(out.exit)).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* assistantsAs(chat.id, "build")).toBe(0)
      expect(yield* llm.calls).toBe(0)
    }),
  TEST_TIMEOUT_MS,
)

it.instance(
  "E4 全部批准:命令自带 build ⇒ 不问,照常以 build 执行(行为不变)",
  () =>
    Effect.gen(function* () {
      const { chat } = yield* setup()
      const out = yield* drive(chat.id, runCommand(chat.id, "allow", COMMAND_OTHER_AGENT), "none")
      expect(out.asked).toEqual([])
      expect(Exit.isSuccess(out.exit)).toBe(true)
      expect(yield* assistantsAs(chat.id, "build")).toBe(1)
    }),
  TEST_TIMEOUT_MS,
)
