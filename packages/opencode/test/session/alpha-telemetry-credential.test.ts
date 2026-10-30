// REQ-236 AC5(`#1562`)—— 开启 `experimental.openTelemetry` 时,导出的 span 属性不含认证头,也不含令牌子串。
//
// 为什么现在要管:平台凭据改为请求级 `authorization` 头发送(ext `chat.headers`),而 `ai` 把每个请求级头记成
// span 属性 `ai.request.headers.<name>`。`session/llm.ts` 的 tracer Proxy 同时包住 `startSpan` 与
// `startActiveSpan` 把它剔掉。这里走真 `LLM.stream`(真 provider、真 `ai` streamText、本进程假上游),tracer 是
// 真 OpenTelemetry SDK(`BasicTracerProvider` + 内存 exporter),断言的是**导出的** span 属性。
// 请求头这里经模型配置的 `headers` 注入 —— 它与 `chat.headers` 的产物在 `session/llm/request.ts` 合并成同一份
// 请求级头,走同一条遥测通道。
// 手段自证(对照臂):同一个 tracer、同一份头,直接调 `ai` 的 streamText(不经 llm.ts 的 Proxy)⇒ 导出属性里
// **出现** `ai.request.headers.authorization` 与令牌 —— 证明这个 exporter 抓得到它,上面的「没有」不是瞎了。

import { afterAll, beforeAll, beforeEach, expect } from "bun:test"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"
import { Effect, Stream } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLM } from "../../src/session/llm"
import { Provider } from "@/provider/provider"
import type { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

const SENTINEL = "SENTINEL-OTEL-TOKEN-9e4b21"
const PROVIDER = "otel-probe"
const MODEL = "probe-model"

const exporter = new InMemorySpanExporter()
const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer("alpha-test")
const upstreamAuthorizations: Array<string | null> = []
let server: ReturnType<typeof Bun.serve> | undefined

function chatStream() {
  const enc = new TextEncoder()
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(chunk({ role: "assistant", content: "ok" }, null)))
      controller.enqueue(enc.encode(chunk({}, "stop")))
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text()
      upstreamAuthorizations.push(request.headers.get("authorization"))
      return new Response(chatStream(), { headers: { "content-type": "text/event-stream" } })
    },
  })
})
afterAll(() => void server?.stop(true))
beforeEach(() => {
  exporter.reset()
  upstreamAuthorizations.length = 0
})

const exportedAttributes = () => exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes }))
const authorizationKeys = (spans: ReturnType<typeof exportedAttributes>) =>
  spans.flatMap((span) => Object.keys(span.attributes).filter((key) => key.toLowerCase() === "ai.request.headers.authorization"))

it.instance(
  "LLM.stream 导出的 span 不带 ai.request.headers.authorization,也不带令牌;上游请求照常带着它",
  () =>
    Effect.gen(function* () {
      const model = yield* Provider.use.getModel(ProviderV2.ID.make(PROVIDER), ModelV2.ID.make(MODEL))
      const sessionID = SessionID.make("session-otel")
      const agent = {
        name: "test",
        mode: "primary",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      } satisfies Agent.Info
      const user = {
        id: MessageID.make("msg_user-otel"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: ProviderV2.ID.make(PROVIDER), modelID: model.id },
      } satisfies SessionV1.User

      yield* LLM.Service.use((svc) =>
        svc
          .stream({
            user,
            sessionID,
            model,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })
          .pipe(Stream.runDrain),
      ).pipe(Effect.provideService(OtelTracer.OtelTracer, tracer))

      const spans = exportedAttributes()
      expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["ai.streamText", "ai.streamText.doStream"]))
      // 别的请求级头照常记录 —— 剔除只针对认证头,遥测本身没被关掉。
      expect(spans.some((span) => Object.keys(span.attributes).some((key) => key.startsWith("ai.request.headers.")))).toBe(true)
      expect(authorizationKeys(spans)).toEqual([])
      expect(JSON.stringify(spans)).not.toContain(SENTINEL)
      expect(upstreamAuthorizations).toEqual([`Bearer ${SENTINEL}`])
    }),
  {
    config: () => ({
      experimental: { openTelemetry: true },
      enabled_providers: [PROVIDER],
      provider: {
        [PROVIDER]: {
          name: "OTel probe",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "placeholder", baseURL: `${server!.url.origin}/v1` },
          models: {
            [MODEL]: {
              name: MODEL,
              tool_call: true,
              limit: { context: 100_000, output: 4_000 },
              headers: { authorization: `Bearer ${SENTINEL}` },
            },
          },
        },
      },
    }),
  },
)

it.live("对照臂:同一个 tracer 与请求头,不经 llm.ts 的 Proxy ⇒ 导出属性里出现认证头与令牌(exporter 抓得到它)", () =>
  Effect.promise(async () => {
    const provider = createOpenAICompatible({ name: PROVIDER, baseURL: `${server!.url.origin}/v1`, apiKey: "placeholder" })
    const result = streamText({
      model: provider(MODEL),
      prompt: "Hello",
      headers: { authorization: `Bearer ${SENTINEL}` },
      experimental_telemetry: { isEnabled: true, tracer },
    })
    await result.consumeStream()
    const spans = exportedAttributes()
    expect(authorizationKeys(spans).length).toBeGreaterThan(0)
    expect(JSON.stringify(spans)).toContain(SENTINEL)
  }),
)
