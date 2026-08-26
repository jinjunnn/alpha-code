// alpha-code#1129(REQ-131 CODE#2)—— E6 direct subtask 与 E7 attachment ingestion 的
// **运行期**判据(#724 §6 E6/E7)。#725 只有源码级确认(E6 要起整回合、E7 的显式排除
// 没有锁死断言);本文件把两者变成运行期可判,登记进 scripts/gate-files.tsv。
//
// E6:direct subtask 绕过 SessionTools ——
//   · identity deny(`builtin::task`)⇒ loop 以 DeniedError 收口,零子会话、零 assistant
//     tool part 持久化(prompt.ts 的 disabled 检查);
//   · identity ask ⇒ **先**进真 Permission 待批队列,批准前零子会话、零消息持久化;
//     reject ⇒ fail-closed,依旧零副作用(#1129 新接的 ask 闸;deny-only 时代这里直接放行)。
//
// E7:attachment ingestion(prompt.ts 的 execRead,`ask: () => Effect.void`)是**显式排除**:
//   宿主替用户读其已选择的附件,不是模型 tool call。负向锁 = 把 `builtin::read` identity 与
//   `read` ability 全设成 deny,ingestion 照样完成、全程零待批请求 —— 谁把 tool policy 接进
//   这条路径,这条当场红。
import path from "path"
import { afterEach, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// 手写的期望字面量。
const ID_BUILTIN_TASK = "builtin::task"
const ID_BUILTIN_READ = "builtin::read"

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
    startAuth: () => Effect.die("unexpected MCP auth in alpha-1129 tests"),
    authenticate: () => Effect.die("unexpected MCP auth in alpha-1129 tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in alpha-1129 tests"),
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

const it = testEffect(
  LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// 注册 test provider,让 loop 里的模型解析成功(deny/ask-reject 收口都到不了真请求)。
const cfg = {
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
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
} satisfies Partial<ConfigV1.Info> as never

const user = Effect.fn("alpha1129.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const addSubtask = (sessionID: SessionID, messageID: MessageID) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "inspect the cache key path",
      description: "inspect bug",
      agent: "general",
      model: ref,
    })
  })

const assistantToolParts = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const history = yield* MessageV2.filterCompactedEffect(sessionID)
    return history.filter(
      (entry) => entry.info.role === "assistant" && entry.parts.some((part) => part.type === "tool"),
    )
  })

it.instance(
  "E6 deny:builtin::task deny ⇒ loop 以 DeniedError 收口,零子会话、零 assistant tool part",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "identity denied",
        permission: [{ permission: ID_BUILTIN_TASK, pattern: "*", action: "deny" }],
      })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* sessions.children(chat.id)).toEqual([])
      expect(yield* assistantToolParts(chat.id)).toEqual([])
    }),
  { config: cfg },
)

it.instance(
  "E6 ask:builtin::task ask ⇒ 先进真待批队列,批准前零子会话零持久化;reject ⇒ fail-closed",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({
        title: "identity asked",
        permission: [{ permission: ID_BUILTIN_TASK, pattern: "*", action: "ask" }],
      })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const pending = yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.length > 0 ? list : undefined
        }),
        "identity ask for builtin::task never became pending",
        "10 seconds",
      )
      expect(pending.length).toBe(1)
      expect(pending[0]!.permission).toBe(ID_BUILTIN_TASK)
      expect(pending[0]!.sessionID).toBe(chat.id)
      // 挂起期间:子会话、assistant tool part 一个都不许出现(副作用在批准之后)。
      expect(yield* sessions.children(chat.id)).toEqual([])
      expect(yield* assistantToolParts(chat.id)).toEqual([])

      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* sessions.children(chat.id)).toEqual([])
      expect(yield* assistantToolParts(chat.id)).toEqual([])
    }),
  { config: cfg },
)

// ── #1129 reopen:策略**文档轴**抵达 E6(真 store 写入,同一 resolver)────────────────
it.instance(
  "E6 文档轴:Settings 写 builtin::task=disabled(真 setRecord)⇒ loop 具名拒绝,零子会话零持久化",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const policy = yield* AlphaToolPolicy.Service
      // 生产写入口(#1130 Settings 将走的同一条):tool 层 disabled,收紧不需要 digest。
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_BUILTIN_TASK }, state: "disabled" })
      const chat = yield* sessions.create({ title: "policy disabled" })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const squashed = Cause.squash(exit.cause)
        expect(squashed).toBeInstanceOf(PermissionV1.DeniedError)
        // 具名:拒绝信息点名 canonical 与文档轴来源(不是一句裸 deny)。
        expect(String((squashed as Error).message)).toContain(ID_BUILTIN_TASK)
      }
      expect(yield* sessions.children(chat.id)).toEqual([])
      expect(yield* assistantToolParts(chat.id)).toEqual([])
      // 全程零待批 —— 文档轴 disabled 不是 ask,session grant 结构性接触不到它。
      expect(yield* permission.list()).toEqual([])
      // 「还原后恢复」不在这里补跑第二条 loop:假 provider 会让它进入分钟级重试(实测 180s
      // 超时);removeRecord 的恢复语义已由 doc-axis 闸 D4 与 E4 重读用例(真实计数)钉住。
      yield* policy.removeRecord({ level: "tool", canonical: ID_BUILTIN_TASK })
    }),
  { config: cfg },
)

it.instance(
  "E7 排除锁:builtin::read 与 read ability 全 deny,附件 ingestion 照样完成且全程零待批",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const fs = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({
        title: "ingestion excluded",
        permission: [
          { permission: ID_BUILTIN_READ, pattern: "*", action: "deny" },
          { permission: "read", pattern: "*", action: "deny" },
        ],
      })
      const attachment = path.join(dir, "attachment.txt")
      yield* fs.writeWithDirs(attachment, "ALPHA-1129-ATTACHMENT-BODY")

      const message = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "read this" },
          { type: "file", url: `file://${attachment}`, filename: "attachment.txt", mime: "text/plain" },
        ],
      })

      // ingestion 真的跑了:宿主读出的文件正文进了消息 parts(不是空壳)。
      const texts = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      expect(texts.join("\n")).toContain("ALPHA-1129-ATTACHMENT-BODY")
      // 且全程没有任何待批请求 —— tool policy 没接进 ingestion(#724 §6 E7 的显式排除)。
      expect(yield* permission.list()).toEqual([])
      const parts: SessionV1.Part[] = message.parts
      expect(parts.length).toBeGreaterThan(0)
    }),
  { config: cfg },
)
