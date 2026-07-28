// alpha-code#652 ① — 「拿不到凭证」不得降级为「发一个无鉴权请求」。
//
// 这道闸判的是**可观测结果**,不是源码文本、也不是「某个函数被调用了」:
//   · 未声明 auth 的 route ⇒ HTTP 传输层收到的请求数 **0**(socket 都没开),失败是**具名**的
//     (LLMError / AuthenticationReason kind:"missing"),不是远端回来的 401。
//   · 显式声明 `Auth.none` 的 route ⇒ 请求照发(1 次)且不带 Authorization ——
//     证明这道闸不是「一律拒」,本地无鉴权 provider 仍可用,只是必须写下来。
//   · 声明了凭证但凭证解析不出来(空/缺)⇒ 同样 0 次请求。
//
// 变异验证(已实测):把 route/client.ts 的 `?? Auth.unset` 改回 `?? Auth.none` ⇒ **第一条**转红
// (请求真的发出去了,拿到 200 与一份 LLMResponse);第二、三条保持绿 —— 那正是要的:
// 这道闸只钉「未声明」这一类,不是把所有失败都算成它。
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMError } from "../src"
import type { Model } from "../src/schema"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { it } from "./lib/effect"
import { deltaChunk, finishChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const BASE_URL = "https://api.openai.test/v1"

/** 计数用的传输层:每一次真正到达 HTTP 客户端的请求都记一笔(含它的 headers)。 */
const countingTransport = (sink: { calls: Array<Record<string, string>> }) => {
  const clientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        sink.calls.push({ ...(request.headers as unknown as Record<string, string>) })
        return HttpClientResponse.fromWeb(
          request,
          new Response(sseEvents(deltaChunk({ role: "assistant", content: "hi" }), finishChunk("stop")), {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      }),
    ),
  )
  const requestExecutorLayer = RequestExecutor.layer.pipe(Layer.provide(clientLayer))
  const deps = Layer.mergeAll(requestExecutorLayer, WebSocketExecutor.layer)
  return Layer.mergeAll(deps, LLMClient.layer.pipe(Layer.provide(deps)))
}

const generate = (model: Model, sink: { calls: Array<Record<string, string>> }) =>
  LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
    Effect.provide(countingTransport(sink)),
    Effect.flip,
  )

describe("Auth fail-closed default (alpha-code#652)", () => {
  it.effect("a route that never declared auth refuses before the socket opens", () =>
    Effect.gen(function* () {
      const sink = { calls: [] as Array<Record<string, string>> }
      const model = OpenAIChat.route.with({ endpoint: { baseURL: BASE_URL } }).model({ id: "gpt-4o-mini" })

      const error = yield* generate(model, sink)

      // ① 请求没有离开进程 —— 失败点在本地,不是远端 401。
      expect(sink.calls).toEqual([])
      // ② 失败是具名的:Auth 模块 + Authentication/missing,不是 {"type":"unknown"}。
      expect(error).toBeInstanceOf(LLMError)
      expect((error as LLMError).reason).toMatchObject({ _tag: "Authentication", kind: "missing" })
      expect(String((error as LLMError).reason.message)).toContain("no auth declared")
    }),
  )

  it.effect("an explicitly declared Auth.none still sends — the gate is a declaration, not a ban", () =>
    Effect.gen(function* () {
      const sink = { calls: [] as Array<Record<string, string>> }
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: BASE_URL }, auth: Auth.none })
        .model({ id: "gpt-4o-mini" })

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(countingTransport(sink)),
      )

      expect(sink.calls).toHaveLength(1)
      expect(sink.calls[0]!["authorization"]).toBeUndefined()
    }),
  )

  it.effect("a declared credential that resolves to nothing also refuses before the socket opens", () =>
    Effect.gen(function* () {
      const sink = { calls: [] as Array<Record<string, string>> }
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: BASE_URL }, auth: Auth.optional(undefined, "apiKey").bearer() })
        .model({ id: "gpt-4o-mini" })

      const error = yield* generate(model, sink)

      expect(sink.calls).toEqual([])
      expect(error).toBeInstanceOf(LLMError)
      expect((error as LLMError).reason).toMatchObject({ _tag: "Authentication", kind: "missing" })
    }),
  )
})
