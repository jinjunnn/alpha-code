// alpha-owned(ADR-035 §1):E7「web search 失败诚实」的闸门测试。
//
// 为什么单独成文件而不是塞进上游的 `websearch.test.ts`(#223 对抗审计 Minor 7):把整个上游
// 测试文件加进 north-star 守卫的 `:(exclude)` 清单,会连带把它里面**未被接管**的断言
// (`registry.ts` 的 `webSearchEnabled` 闸)一起移出守卫 —— 以后改动/删除那组断言守卫仍绿,
// 而 alpha CI 又不跑 opencode 测试,构成治理盲区。新增文件对守卫是 `A`(`--diff-filter=DMR`
// 不看新增),故**不需要**任何 exclude 条目,上游测试文件继续受守。
//
// 三条纪律:①只走真实调用路径(真 `call()` 传输链、真 `McpCatalog.convertTool` 云链),不手工
// 预置中间状态;②每条断言对应一个动态复现过的缺陷;③禁伪成功。

import { describe, expect, test } from "bun:test"
import { ConfigProvider, type Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { call, parseResponse, SearchArgs, WebSearchFailure } from "../../src/tool/mcp-websearch"
import { McpCatalog } from "../../src/mcp/catalog"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"

const SEARCH_ARGS = { query: "effect typescript", type: "auto", numResults: 8, livecrawl: "fallback" }

function clientReturning(response: Response) {
  return HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)))
}

function search(http: HttpClient.HttpClient, timeout: Duration.Input = "1 second") {
  return call(http, "https://search.test/mcp", "web_search", SearchArgs, SEARCH_ARGS, timeout)
}

/** Run a search against a stubbed transport and hand back the failure it produced. */
function searchFailure(http: HttpClient.HttpClient, timeout?: Duration.Input) {
  return Effect.runPromise(Effect.flip(search(http, timeout)))
}

function mcpPayload(result: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result })
}

describe("websearch MCP response parser (#489 失败诚实)", () => {
  const payload = mcpPayload({ content: [{ type: "text", text: "search results" }] })

  test("parses plain JSON-RPC responses", async () => {
    expect(await Effect.runPromise(parseResponse(payload))).toBe("search results")
  })

  // #489:空/坏响应曾被调用方换成 "No search results found." 当成功串返回 —— 伪成功已删。
  for (const [name, body] of [
    ["an empty body", ""],
    ["a result with no content at all", mcpPayload({ content: [] })],
    ["a result whose only text is blank", mcpPayload({ content: [{ type: "text", text: "  " }] })],
  ] as const) {
    test(`fails loudly for ${name} instead of faking a no-results success`, async () => {
      const failure = await Effect.runPromise(Effect.flip(parseResponse(body)))
      expect(failure).toBeInstanceOf(WebSearchFailure)
      expect(failure.kind).toBe("empty_result")
      expect(failure.message).not.toContain("No search results found")
    })
  }

  test("keeps a provider-flagged error loud even on a 200", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(parseResponse(mcpPayload({ isError: true, content: [{ type: "text", text: "quota rejected" }] }))),
    )
    expect(failure.kind).toBe("provider_error")
    expect(failure.message).toContain("quota rejected")
  })

  test("reports an undecodable payload with the upstream body attached", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(parseResponse('{"jsonrpc":"2.0","id":1,"result":{"content":"nope"}}')),
    )
    expect(failure.kind).toBe("invalid_response")
    expect(failure.message).toContain('"content":"nope"')
  })
})

// #223 对抗审计(2026-07-25)Major 5:三种「零命中 / 错误」判定都被动态复现过。
describe("websearch zero-hit vs provider error (#223 Major 5)", () => {
  test("an explicit empty results array is a legitimate success, not an empty_result failure", async () => {
    const output = await Effect.runPromise(
      parseResponse(mcpPayload({ content: [], structuredContent: { results: [] } })),
    )
    expect(output).toContain('"results":[]')
    expect(output).not.toContain("No search results found")
  })

  test("structuredContent hits survive an empty content array", async () => {
    const output = await Effect.runPromise(
      parseResponse(mcpPayload({ content: [], structuredContent: { results: [{ url: "https://a.test" }] } })),
    )
    expect(output).toContain("https://a.test")
  })

  test("a 200 error payload without isError is a loud provider error, not a search result", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        parseResponse(
          mcpPayload({ content: [{ type: "text", text: JSON.stringify({ error: { message: "quota rejected" } }) }] }),
        ),
      ),
    )
    expect(failure).toBeInstanceOf(WebSearchFailure)
    expect(failure.kind).toBe("provider_error")
    expect(failure.message).toContain("quota rejected")
  })

  test("a structured error carries its code so the category stays discernible", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(parseResponse(mcpPayload({ content: [], structuredContent: { error: { message: "no budget", code: "insufficient_funds" } } }))),
    )
    expect(failure.kind).toBe("provider_error")
    expect(failure.code).toBe("insufficient_funds")
  })

  test("a 200 HTML error page stays distinguishable by carrying the upstream body", async () => {
    const failure = await searchFailure(
      clientReturning(
        new Response("<html><body>502 Bad Gateway from the CDN</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    )
    expect(failure.kind).toBe("empty_result")
    expect(failure.message).toContain("502 Bad Gateway from the CDN")
  })
})

// #223 对抗审计 Major 6:timeout 以前只包住 headers;body 无上限。
describe("websearch transport bounds (#223 Major 6)", () => {
  test("a response whose body never ends still times out loudly", async () => {
    // headers 立刻到手,body 永不结束 —— 修复前 `response.text` 会无限等待,50ms 的 timeout
    // 早已退出,探针 250ms 后仍 pending 且没有任何失败。
    const stalled = new ReadableStream<Uint8Array>({ start() {} })
    const started = Date.now()
    const failure = await searchFailure(clientReturning(new Response(stalled, { status: 200 })), "100 millis")

    expect(failure.kind).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("an unbounded body stops being read instead of buffering without limit", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(120) // 512KiB of "x"
    let pulls = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
      },
    })

    // 无界读取 = 这条流永不结束 ⇒ 只会拿到 timeout;有界读取会在 2MiB 处停手,把已读到的
    // body 交给失败映射(HTML/非 JSON ⇒ empty_result,带原 body)。
    const failure = await searchFailure(clientReturning(new Response(endless, { status: 200 })), "20 seconds")

    expect(failure.kind).toBe("empty_result")
    expect(pulls).toBeLessThanOrEqual(8) // 2MiB / 512KiB = 4,给流实现的预读留余量
  })
})

// #489:平台 `POST /v1/tools/web_search` 的真实失败集(alpha-platform `packages/gateway/src/worker.ts`)
// —— 401 / 403 action_forbidden / 400 / 402(preauth 拒绝 与 per-job 超预算)/ 502,其余非 2xx 一律 LOUD。
// 注意:本组走的是**本地 Exa/Parallel 直连**这条链(`websearch` 工具);登录态的 `cloud_web_search`
// 走另一条链,其真实形态见下面 "cloud MCP path" 一组。
describe("websearch upstream failure mapping (direct HTTP path)", () => {
  const outcomes = [
    [401, { error: { message: "unauthorized" } }, "unauthorized"],
    [403, { error: { message: "forbidden: token is not authorized for model.invoke", code: "action_forbidden" } }, "forbidden"],
    [400, { error: { message: "query required" } }, "bad_request"],
    [402, { error: { message: "预授权拒绝: no budget" } }, "payment_required"],
    [402, { error: { message: "per-job budget exceeded", job_id: "job_1" } }, "payment_required"],
    [502, { error: { message: "no search backend configured" } }, "upstream"],
    [503, { error: { message: "BILLING_UNREADY" } }, "unexpected_status"],
  ] as const

  for (const [status, body, kind] of outcomes) {
    test(`maps HTTP ${status} ${JSON.stringify(body.error.message)} to a discernible loud failure`, async () => {
      const failure = await searchFailure(clientReturning(Response.json(body, { status })))

      expect(failure).toBeInstanceOf(WebSearchFailure)
      expect(failure.kind).toBe(kind)
      expect(failure.status).toBe(status)
      expect(failure.message).toContain(`HTTP ${status}`)
      expect(failure.message).toContain(body.error.message)
    })
  }

  test("carries the platform error code so 403s stay distinguishable", async () => {
    const forbidden = await searchFailure(
      clientReturning(Response.json({ error: { message: "no", code: "action_forbidden" } }, { status: 403 })),
    )
    const unenforceable = await searchFailure(
      clientReturning(Response.json({ error: { message: "no", code: "job_not_enforceable" } }, { status: 403 })),
    )

    expect(forbidden.code).toBe("action_forbidden")
    expect(unenforceable.code).toBe("job_not_enforceable")
    expect(forbidden.message).not.toBe(unenforceable.message)
  })

  test("keeps every mapped status category distinct", async () => {
    const messages = await Promise.all(
      outcomes.map(([status, body]) => searchFailure(clientReturning(Response.json(body, { status })))),
    )
    expect(new Set(messages.map((failure) => failure.message)).size).toBe(outcomes.length)
  })

  test("maps a transport defect into the same discernible failure instead of crashing the tool", async () => {
    const failure = await searchFailure(HttpClient.make(() => Effect.die(new Error("socket reset by peer"))))

    expect(failure).toBeInstanceOf(WebSearchFailure)
    expect(failure.kind).toBe("transport")
    expect(failure.message).toContain("socket reset by peer")
  })

  test("never silently degrades a cloud failure into an empty success", async () => {
    const failure = await searchFailure(clientReturning(Response.json({ error: { message: "nope" } }, { status: 402 })))

    expect(failure.message).toContain("Web search failed")
    expect(failure.message).not.toContain("No search results found")
  })
})

// #223 对抗审计 Blocker:主权闸的引擎侧半场。alpha 只能在 `OPENCODE_CONFIG_CONTENT` 里写
// permission —— 这两条断言证明「写 deny」确实关得掉工具,以及为什么注入必须连 agent 级规则一起压平。
describe("engine-side effect of the alpha web search deny (#223 Blocker)", () => {
  const flagsFrom = (env: Record<string, string>) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* RuntimeFlags.Service
        }),
        RuntimeFlags.Service.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))), Layer.orDie),
      ),
    )

  test("the umbrella really does defeat the four keyless env flags — env alone cannot close the tool", async () => {
    const flags = await flagsFrom({
      OPENCODE_EXPERIMENTAL: "1",
      OPENCODE_ENABLE_EXA: "0",
      OPENCODE_EXPERIMENTAL_EXA: "0",
      OPENCODE_ENABLE_PARALLEL: "0",
      OPENCODE_EXPERIMENTAL_PARALLEL: "0",
    })
    // 这正是 Blocker 的前提:主权闸把四个专用 flag 写成 "0" 之后 enableExa 仍为真。
    expect(flags.enableExa).toBe(true)
  })

  test("a global websearch deny closes the tool at the engine's permission layer", () => {
    const ruleset = Permission.fromConfig({ websearch: "deny" })
    expect(Permission.evaluate("websearch", "effect typescript", ruleset).action).toBe("deny")
  })

  test("an agent rule appended after the global deny wins — why the injection flattens the alpha agents", () => {
    const merged = Permission.merge(
      Permission.fromConfig({ websearch: "deny" }), // 全局(alpha 注入的 config.permission)
      Permission.fromConfig({ websearch: "allow" }), // agent 级(agent/agent.ts 把它并在全局之后)
    )
    expect(Permission.evaluate("websearch", "effect typescript", merged).action).toBe("allow")
  })
})

// #223 对抗审计 Major 2:登录态的 `cloud_web_search` **不走** `mcp-websearch.ts`。它走
// `McpCatalog.convertTool`(`session/tools.ts:391`)→ MCP SDK client。平台薄壳
// (alpha-platform `packages/gateway/src/cloud-mcp.ts` 的 `text(body, !r.ok)`)把 gateway 的
// JSON body 塞进 MCP text content 并置 `isError`,**HTTP 状态在这一层就被丢掉了**。
// 本组锁死这条链**今天真实的**行为(loud + 原 body 完整),同时把「没有状态、没有分类」这一
// 事实钉成回归基线 —— 平台侧透传状态/码归 alpha-platform#105,那之前不许在文档里声称已消费。
describe("cloud_web_search failure surface (real MCP catalog path, #223 Major 2)", () => {
  const CLOUD_TOOL = {
    name: "cloud_web_search",
    description: "Web search via the platform host-tool endpoint",
    inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
  }

  function cloudToolReturning(result: unknown) {
    const client = { callTool: async () => result } as unknown as Client
    const tool = McpCatalog.convertTool(CLOUD_TOOL, client)
    return (tool.execute as (args: unknown, options: unknown) => Promise<unknown>)(
      { query: "effect typescript" },
      { toolCallId: "call_1", messages: [] },
    )
  }

  // 平台薄壳对 gateway 402 的**真实**产物(cloud-mcp.ts:163-169 → text(body, !r.ok))。
  const platform402 = {
    content: [{ type: "text", text: JSON.stringify({ error: { message: "预授权拒绝: no budget" } }) }],
    isError: true,
  }

  test("a platform 402 surfaces loudly with the gateway body intact", async () => {
    const error: Error = await cloudToolReturning(platform402).then(
      (value) => new Error(`expected a loud failure, got a result: ${JSON.stringify(value)}`),
      (error: unknown) => error as Error,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("预授权拒绝: no budget")
    expect(error.message).not.toContain("No search results found")
  })

  test("but the HTTP status never reaches the client — the shell drops it (alpha-platform#105)", async () => {
    const error: Error = await cloudToolReturning(platform402).then(
      () => new Error("expected a loud failure"),
      (error: unknown) => error as Error,
    )

    // 事实基线,不是愿望:body 里没有状态,错误对象上也没有。任何声称「云 402 被映射成
    // payment_required」的文档/代码都与这条断言冲突,应当先改文档或先等平台透传。
    expect(error).not.toBeInstanceOf(WebSearchFailure)
    expect(error.message).not.toContain("402")
    expect((error as { status?: unknown }).status).toBeUndefined()
  })

  test("a cloud zero-hit stays a success and is never turned into a failure", async () => {
    const result = await cloudToolReturning({
      content: [],
      structuredContent: { query: "effect typescript", results: [] },
      isError: false,
    })

    expect(JSON.stringify(result)).toContain('"results":[]')
  })
})
