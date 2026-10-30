// `#1572` AC4 —— 引擎在两处结算点、错误被压成顶层消息之前取层(session/processor.ts,ADR-041 已接管):
//   · 工具:failToolCall 在 errorMessage() 只留 `Transport error (GET …)` 之前分类原错误,写进 ToolPart 已有的 metadata;
//   · 回合:parse 在 MessageV2.fromError 结算出 APIError 时把 alphaNetLayer / alphaNetCode 写进它已有的 metadata;
//     AI SDK 的调用错误一个 HTTP 应答都没拿到、层又认不出(实测「Cannot connect to API: Request was cancelled.」)⇒
//     只记 alphaNetCode: "unattributed"。
// 运行时形状(Electron 内嵌 node + 真出网代理 + 真 webfetch)由 packages/ui-mac/src/main/net-failure-real-stack.test.ts 钉住;
// 本文件用生产 SessionProcessor + 真 Session 落库,LLM 流换成发出这些事件的替身,钉住结算点本身。
// 删掉 failToolCall 里的取层 ⇒ 工具那条红;删掉 parse 里的取层 ⇒ 回合两条红。
//
// 错误形状来源:`Proxy response (503) !== 200 when HTTP Tunneling` 外两层包法取自打包版实测
// docs/verification/2026-09-10-req159-1334-packaged-network-fence/results/choke.json:1013;Effect HTTP 包法用装着的 effect 真构造;
// APICallError 用装着的 `ai` 真构造(@ai-sdk/provider-utils handleFetchError 的形状:无 statusCode、cause 为底层错误)。
//
// 本文件 alpha 自有(`alpha-*`,ADR-043)。

import path from "node:path"
import { expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { APICallError } from "ai"
import { Effect, Layer, Stream } from "effect"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import type { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
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
}

function proxyTunnelFailure(status: number) {
  const inner = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { name: "AbortError", code: "UND_ERR_ABORTED" })
  return new TypeError("fetch failed", { cause: new Error("Request was cancelled.", { cause: inner }) })
}

const SECRET = "SECRET-NEEDLE-1572"
const URL_WITH_SECRET = `https://docs.example.test/page?token=${SECRET}`

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({ summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]) }),
)
const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const

function withLLM(stream: () => Stream.Stream<LLMEvent, unknown>) {
  return testEffect(LayerNode.compile(root, [...replacements, [LLM.node, Layer.succeed(LLM.Service, LLM.Service.of({ stream }))]]))
}

/** 工具那一格:webfetch 调用,随后一次带原错误的 tool-error。 */
function toolFailure(error: unknown) {
  return () =>
    Stream.make(
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolInputStart({ id: "call-1", name: "webfetch" }),
      LLMEvent.toolInputEnd({ id: "call-1", name: "webfetch" }),
      LLMEvent.toolCall({ id: "call-1", name: "webfetch", input: { url: URL_WITH_SECRET }, providerExecuted: true }),
      LLMEvent.toolError({ id: "call-1", name: "webfetch", message: "Transport error", error }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    )
}

const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] }

/** 跑一轮生产 processor,返回落库后的助手消息与 parts。 */
const runTurn = (dir: string) =>
  Effect.gen(function* () {
    const processors = yield* SessionProcessor.Service
    const session = yield* Session.Service
    const provider = yield* Provider.Service
    const chat = yield* session.create({})
    const parent = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: parent.id, sessionID: chat.id, type: "text", text: "go" })
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID: chat.id as SessionID,
      mode: "build",
      agent: "build",
      path: { cwd: path.resolve(dir), root: path.resolve(dir) },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: parent.id,
      time: { created: Date.now() },
      finish: "end_turn",
    }
    yield* session.updateMessage(msg)
    const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
    const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
    yield* handle.process({
      user: { id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: "build", model: ref } satisfies SessionV1.User,
      sessionID: chat.id,
      model: mdl,
      agent,
      system: [],
      messages: [{ role: "user", content: "go" }],
      tools: {},
    })
    return { message: handle.message, parts: yield* MessageV2.parts(msg.id) }
  })

const toolOf = (parts: readonly SessionV1.Part[]) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

const effectTransport = (cause: unknown) =>
  new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: HttpClientRequest.get(URL_WITH_SECRET), cause }) })

withLLM(toolFailure(effectTransport(proxyTunnelFailure(503)))).live(
  "AC4 tool: a webfetch transport failure keeps metadata.alphaNetFailure on the persisted ToolPart",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { parts } = yield* runTurn(dir)
          const call = toolOf(parts)
          expect(call?.state.status).toBe("error")
          if (call?.state.status !== "error") return
          // 顶层 message 已经认不出层(这正是要在它之前取层的理由)。
          expect(call.state.error).toContain("Transport error")
          expect(call.state.metadata?.alphaNetFailure).toEqual({ layer: "dns", code: "503" })
          expect(JSON.stringify(call.state.metadata)).not.toContain(SECRET)
        }),
      { config: cfg },
    ),
)

withLLM(toolFailure(new Error("Response too large (exceeds 5MB limit)"))).live(
  "AC4 tool: a failure that is not a network failure leaves the metadata without a layer",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const call = toolOf((yield* runTurn(dir)).parts)
          expect(call?.state.status).toBe("error")
          if (call?.state.status === "error") expect(call.state.metadata?.alphaNetFailure).toBeUndefined()
        }),
      { config: cfg },
    ),
)

const apiCallError = (cause: unknown) =>
  new APICallError({
    message: `Cannot connect to API: ${(cause as Error).message}`,
    url: "https://api.example.test/v1/chat/completions",
    requestBodyValues: {},
    isRetryable: false,
    cause,
  })

withLLM(() => Stream.fail(apiCallError(proxyTunnelFailure(503).cause))).live(
  "AC4 turn: a model request that settles as APIError carries alphaNetLayer / alphaNetCode",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { message } = yield* runTurn(dir)
          expect(message.error?.name).toBe("APIError")
          const metadata = (message.error as { data: { metadata?: Record<string, string> } }).data.metadata
          expect(metadata?.alphaNetLayer).toBe("dns")
          expect(metadata?.alphaNetCode).toBe("503")
        }),
      { config: cfg },
    ),
)

withLLM(() => Stream.fail(apiCallError(new Error("Request was cancelled.")))).live(
  "AC4 turn: an AI SDK call error with no HTTP answer and no recognisable layer is marked unattributed",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { message } = yield* runTurn(dir)
          expect(message.error?.name).toBe("APIError")
          const metadata = (message.error as { data: { metadata?: Record<string, string> } }).data.metadata
          expect(metadata?.alphaNetLayer).toBeUndefined()
          expect(metadata?.alphaNetCode).toBe("unattributed")
        }),
      { config: cfg },
    ),
)
