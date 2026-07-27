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
import { Cause, ConfigProvider, type Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  call,
  EXA_URL,
  MAX_BODY_BYTES,
  parseResponse,
  readBoundedBody,
  SearchArgs,
  WebSearchFailure,
} from "../../src/tool/mcp-websearch"
import { LOCAL_WEBSEARCH_DENIED_MESSAGE, LOCAL_WEBSEARCH_DENY_ENV, WebSearchTool } from "../../src/tool/websearch"
import { McpCatalog } from "../../src/mcp/catalog"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Tool } from "../../src/tool/tool"
import * as Truncate from "../../src/tool/truncate"
import { ToolFailure } from "@opencode-ai/llm"

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
      Effect.flip(
        parseResponse(
          mcpPayload({
            content: [],
            structuredContent: { error: { message: "no budget", code: "insufficient_funds" } },
          }),
        ),
      ),
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

  // R2(2026-07-25)动态复现:实现先整块 `push(chunk)` 再判越界,喂入**单个** 3 MiB chunk 时
  // `Buffer.concat` 实收 3,145,728 字节,而声明上限是 2,097,152 —— 声明的「2 MiB 处停手」对
  // 大块流根本不成立。这条按字节精确断言硬限,块大小无关。
  test("a single oversized chunk is cut at the cap instead of being buffered whole", async () => {
    const oversized = new Uint8Array(3 * 1024 * 1024).fill(120) // 单块 3 MiB 的 "x"
    const body = await Effect.runPromise(
      Effect.gen(function* () {
        const http = clientReturning(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversized)
                controller.close()
              },
            }),
            { status: 200 },
          ),
        )
        return yield* readBoundedBody(yield* http.execute(HttpClientRequest.get("https://search.test/mcp")))
      }),
    )

    const marker = `\n[truncated at ${MAX_BODY_BYTES} bytes]`
    expect(body.endsWith(marker)).toBe(true)
    expect(Buffer.byteLength(body.slice(0, body.length - marker.length), "utf8")).toBe(MAX_BODY_BYTES)
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

// ─────────────────────────────────────────────────────────────────────────────
// #647(2026-07-27):`readBoundedBody` 只读**第一个 chunk** 就停 —— 已发版的静默截断回归。
//
// 病因:`Stream.runForEachWhile` 在谓词恒为 `true` 时仍在第一个 chunk 之后停止消费。同一个请求
// 的脱机实测:runForEachWhile 1 chunk / 4,090 字节;runForEach 3 chunks / 18,063 字节;
// `response.text` 18,034 字符。于是 `call()` 拿到截断的 JSON,登出态真调报
// 「invalid response … Unterminated string in JSON」,而上游返回的其实是**成功**结果。
//
// 这是 #489(有界读取)引入的回归:#639 之前那里是 `const body = yield* response.text`。
// 也是本仓**第二次**踩同一个 API —— `tool/read.ts:143` 早就把警告写进注释,但注释拦不住另一个
// 文件。类级防复发闸见 `packages/ui-mac/src/main/stream-read-hygiene.test.ts`。
//
// 下面两条互为对抗:①证明读全了(否则退回截断);②证明「读全」不是靠把上限读没了 ——
// 触限那一刻上游必须被**拉断**,不能读完整条流再截。任一条单独通过都不足以判修复成立。
// ─────────────────────────────────────────────────────────────────────────────
describe("readBoundedBody reads to the end of the stream (#647)", () => {
  /** 把一份 body 切成多个 chunk 后逐块入队 —— 真实传输就是这样交付的。 */
  function chunked(body: string, chunkSize: number) {
    const bytes = new TextEncoder().encode(body)
    const parts: Uint8Array[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize)
      parts.push(bytes.slice(offset, offset + chunkSize))
    return {
      parts,
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const part of parts) controller.enqueue(part)
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }
  }

  // 现场的 chunk 尺寸(4,090 = 实测里 runForEachWhile 唯一读到的那一块),body 明显跨多块。
  const CHUNK = 4090
  const payload = mcpPayload({ content: [{ type: "text", text: `RESULT_HEAD ${"x".repeat(14_000)} RESULT_TAIL` }] })

  test("a multi-chunk body arrives whole — not just the first chunk", async () => {
    const source = chunked(payload, CHUNK)
    // 前提自检:这条 body 确实跨多块,否则本用例是空的(单块流对本缺陷不敏感)。
    expect(source.parts.length).toBeGreaterThan(1)

    const body = await Effect.runPromise(
      Effect.gen(function* () {
        const http = clientReturning(source.response())
        return yield* readBoundedBody(yield* http.execute(HttpClientRequest.get("https://search.test/mcp")))
      }),
    )

    // 回归形态:修复前这里恰好是第一块的 4,090 字节,且尾部缺失。
    expect(Buffer.byteLength(body, "utf8")).toBe(Buffer.byteLength(payload, "utf8"))
    expect(body).toBe(payload)
    expect(body).toContain("RESULT_TAIL")
    expect(body).not.toContain("[truncated at") // 远小于上限,不该带截断标记
  })

  test("the truncated multi-chunk JSON no longer breaks a real search call", async () => {
    // 用户可见症状的直接断言:走真 `call()`,截断时是 invalid_response(Unterminated string in JSON)。
    const source = chunked(payload, CHUNK)
    const output = await Effect.runPromise(search(clientReturning(source.response())))

    expect(output).toContain("RESULT_HEAD")
    expect(output).toContain("RESULT_TAIL")
  })

  test("reading to the end did NOT relax the cap — the upstream is torn down at the limit", async () => {
    // 8 × 3 MiB = 24 MiB 的有限流。第一块就已越过 2 MiB 上限:
    //   修复正确 ⇒ 触限即中止,后面 7 块一个都不该被拉,且底层 source 收到 cancel。
    //   若改成「读完再截」⇒ pulls 跑满 8、cancel 不触发(而且真把 24 MiB 拉进了进程)。
    // 用**有限**流而不是无限流,是为了让退化形态确定性地转红而不是挂死。
    const TOTAL_CHUNKS = 8
    let pulls = 0
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(3 * 1024 * 1024).fill(120)) // 单块 3 MiB > 2 MiB 上限
        if (pulls >= TOTAL_CHUNKS) controller.close()
      },
      cancel() {
        cancelled = true
      },
    })

    const body = await Effect.runPromise(
      Effect.gen(function* () {
        const http = clientReturning(new Response(oversized, { status: 200 }))
        return yield* readBoundedBody(yield* http.execute(HttpClientRequest.get("https://search.test/mcp")))
      }),
    )

    const marker = `\n[truncated at ${MAX_BODY_BYTES} bytes]`
    expect(body.endsWith(marker)).toBe(true)
    expect(Buffer.byteLength(body.slice(0, body.length - marker.length), "utf8")).toBe(MAX_BODY_BYTES)
    // 「提前中止」的两个可观测结果,不是源码断言。
    expect(pulls).toBeLessThan(TOTAL_CHUNKS)
    expect(cancelled).toBe(true)
  })
})

// #489:平台 `POST /v1/tools/web_search` 的真实失败集(alpha-platform `packages/gateway/src/worker.ts`)
// —— 401 / 403 action_forbidden / 400 / 402(preauth 拒绝 与 per-job 超预算)/ 502,其余非 2xx 一律 LOUD。
// 注意:本组走的是**本地 Exa/Parallel 直连**这条链(`websearch` 工具);登录态的 `cloud_web_search`
// 走另一条链,其真实形态见下面 "cloud MCP path" 一组。
describe("websearch upstream failure mapping (direct HTTP path)", () => {
  const outcomes = [
    [401, { error: { message: "unauthorized" } }, "unauthorized"],
    [
      403,
      { error: { message: "forbidden: token is not authorized for model.invoke", code: "action_forbidden" } },
      "forbidden",
    ],
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
        RuntimeFlags.Service.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Layer.orDie,
        ),
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

  // #223 R4 云 kill-switch 绕过链第 2 环:`OPENCODE_PURE` 真的被解析成 pure(第 1 环是
  // ui-mac 的 `createSidecarEnv` 放行 `OPENCODE_` 前缀,第 3 环是 plugin/index.ts 跳过外部插件;
  // 那两环分别由 ui-mac 与 ext 的测试钉住)。这里用**真 RuntimeFlags** 断言,不镜像解析规则。
  test("OPENCODE_PURE=true really parses as pure — the engine then loads no external plugin", async () => {
    expect((await flagsFrom({ OPENCODE_PURE: "true" })).pure).toBe(true)
    expect((await flagsFrom({})).pure).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────────
// #223 R2 Blocker 1:主权 deny 必须是**最终**规则。
//
// R2 的动态探针实测:`configOnly=deny`,但加入 session allow 或 approved 后**均变 allow**。
// 注入面的 permission deny 因此只是可用性(把工具从模型工具表里滤掉),不是主权保证。最终闸落在
// 工具自身(`websearch.ts` 读 ALPHA_LOCAL_WEBSEARCH_DENY),它不查 ruleset。
//
// 下面三条是**反向测试**:每条先证明该绕过在 permission 层**真的成立**(evaluate → allow),
// 再走真实工具执行路径(`Tool.init` → `def.execute`,与 session/tools.ts 同一入口)断言仍被拒。
// ─────────────────────────────────────────────────────────────────────────────

const truncateStub = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: (text: string) => Effect.succeed(text),
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
  }),
)

const stubAgent: Agent.Info = { name: "build", mode: "all", permission: [], options: {} }
const agentStub = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed(stubAgent),
    list: () => Effect.succeed([stubAgent]),
    defaultInfo: () => Effect.succeed(stubAgent),
    defaultAgent: () => Effect.succeed(stubAgent.name),
    generate: () => Effect.die(new Error("Agent.generate is not part of the web search path")),
  }),
)

/** 真实工具执行:`Tool.init` 拿到 def 后调 `execute`,与 `session/tools.ts` 的入口同一个。 */
async function runWebSearchTool(input: {
  http: HttpClient.HttpClient
  /** `session/tools.ts:87` 的 `merge(agent.permission, session.permission)` 结果。 */
  ruleset?: PermissionV1.Ruleset
  /** `permission/index.ts:73` 里排在整个 ruleset **之后**的 approved。 */
  approved?: PermissionV1.Ruleset
  denied?: boolean
}) {
  const ruleset = input.ruleset ?? []
  const approved = input.approved ?? []
  const asked: string[] = []

  const program = Effect.gen(function* () {
    const def = yield* Tool.init(yield* WebSearchTool)
    return yield* def.execute(
      { query: "effect typescript" },
      {
        sessionID: "ses_websearch_test" as never,
        messageID: "msg_websearch_test" as never,
        agent: stubAgent.name,
        abort: new AbortController().signal,
        callID: "call_1",
        extra: {},
        messages: [],
        metadata: () => Effect.void,
        // `Permission.ask` 的判定核心(permission/index.ts:73):ruleset 之后再看 approved。
        ask: (request) =>
          Effect.gen(function* () {
            asked.push(request.permission)
            for (const pattern of request.patterns) {
              const rule = Permission.evaluate(request.permission, pattern, ruleset, approved)
              if (rule.action === "deny")
                return yield* Effect.die(new Error(`permission denied: ${request.permission}`))
            }
          }),
      },
    )
  }).pipe(
    Effect.map((value) => ({ ok: true as const, value, asked })),
    Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: Cause.squash(cause), asked })),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, input.http),
        RuntimeFlags.Service.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_ENABLE_EXA: "1" }))),
          Layer.orDie,
        ),
        truncateStub,
        agentStub,
      ),
    ),
  )

  const previous = process.env[LOCAL_WEBSEARCH_DENY_ENV]
  if (input.denied) process.env[LOCAL_WEBSEARCH_DENY_ENV] = "1"
  else delete process.env[LOCAL_WEBSEARCH_DENY_ENV]
  try {
    return await Effect.runPromise(program)
  } finally {
    if (previous === undefined) delete process.env[LOCAL_WEBSEARCH_DENY_ENV]
    else process.env[LOCAL_WEBSEARCH_DENY_ENV] = previous
  }
}

describe("sovereignty deny is the final rule (#223 R2 Blocker 1)", () => {
  const globalDeny = Permission.fromConfig({ websearch: "deny" }) // alpha 注入的 config.permission
  const allowWebSearch: PermissionV1.Ruleset = [{ permission: "websearch", action: "allow", pattern: "*" }]

  /** 一个「本该成功」的搜索响应 + 命中计数:漏关的话测试会看到成功而不是别的失败。 */
  function transportThatWouldSucceed() {
    let calls = 0
    const http = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(mcpPayload({ content: [{ type: "text", text: "search results" }] }), { status: 200 }),
        ),
      )
    })
    return { http, calls: () => calls }
  }

  const bypasses = [
    [
      // agent/agent.ts:293 —— 后加载的 agent 走 `merge(item.permission, fromConfig(value.permission))`,
      // 它的 `"*": "allow"` 排在全局 deny 之后;注入面只看得见 alpha 自己的 agent,压不平这一条。
      'an agent wildcard "*": "allow" loaded after the global deny',
      { ruleset: Permission.merge(globalDeny, Permission.fromConfig({ "*": "allow" })) },
    ],
    [
      // session/prompt.ts:1060 —— `PromptInput.tools.websearch=true` 被 `setPermission` **持久化**
      // 进 session,sidecar respawn 后仍在;session/tools.ts:87 再把它并在 agent 规则之后。
      "a persisted session permission from PromptInput.tools.websearch=true",
      { ruleset: Permission.merge(globalDeny, allowWebSearch) },
    ],
    [
      // permission/index.ts:73 —— `evaluate(permission, pattern, ruleset, approved)`,approved 最后。
      'an approved rule recorded by an earlier "always allow"',
      { ruleset: globalDeny, approved: allowWebSearch },
    ],
  ] as const

  for (const [name, bypass] of bypasses) {
    test(`${name} beats the permission layer — and is still refused by the tool`, async () => {
      const approved = "approved" in bypass ? bypass.approved : []
      // ① 绕过是真的:permission 层在这套规则下判 allow(否则这条反向测试是空的)。
      expect(Permission.evaluate("websearch", "effect typescript", bypass.ruleset, approved).action).toBe("allow")

      // ② 走真实工具路径,主权闸置位 ⇒ 仍然拒绝,且传输层一次都没被碰。
      const transport = transportThatWouldSucceed()
      const run = await runWebSearchTool({ http: transport.http, ...bypass, approved, denied: true })

      expect(run.ok).toBe(false)
      const failure = (run as { error: unknown }).error
      expect(failure).toBeInstanceOf(ToolFailure)
      expect((failure as ToolFailure).message).toBe(LOCAL_WEBSEARCH_DENIED_MESSAGE)
      expect(transport.calls()).toBe(0)
      expect(run.asked).toEqual([]) // 最终闸排在 ctx.ask 之前:根本不给 ruleset 说话的机会
    })
  }

  // 正向对照:同一套「绕过」规则、同一个 harness,闸不置位时工具**确实会跑通** —— 证明上面三条
  // 的红/绿来自主权闸本身,而不是 harness 恰好跑不起来。
  test("without the sovereignty flag the very same bypass ruleset lets the tool run", async () => {
    const transport = transportThatWouldSucceed()
    const run = await runWebSearchTool({
      http: transport.http,
      ruleset: Permission.merge(globalDeny, allowWebSearch),
      denied: false,
    })

    expect(run.ok).toBe(true)
    expect(transport.calls()).toBe(1)
    expect(run.asked).toEqual(["websearch"])
  })

  // 反向对照:没有任何绕过时,harness 的 permission 层是活的(deny 真的拦得住)。
  test("the harness permission layer really denies when nothing overrides the global deny", async () => {
    const transport = transportThatWouldSucceed()
    const run = await runWebSearchTool({ http: transport.http, ruleset: globalDeny, denied: false })

    expect(run.ok).toBe(false)
    expect(String((run as { error: unknown }).error)).toContain("permission denied: websearch")
    expect(transport.calls()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #223 R4 Blocker 1 —— **变异种**:R4 报告里那段可执行构造,原样跑一遍。
//
//     const id = ["web", "search"].join("")
//     Tool.define(id, /* 调用既有 McpWebSearch.call */)
//
// 它是「第三份副本」的最省事写法:注册名算出来(源码普查网看不见)、传输复用已白名单的
// `mcp-websearch.ts`(不引入新 URL,第二张网也看不见)、自己**不读**任何主权信号、**不 ask**。
// R3 那版闸(每个叶子的 execute 首行)对它完全不成立。
//
// R4 的收口把闸下沉到 `call()` —— 本引擎唯一的出网出口。所以这条变异现在是被**执行时的闸**
// 拒掉的,不是被谁看见的。断言两件事:①拒;②零出网(HTTP 客户端一次都没被碰)。
// ─────────────────────────────────────────────────────────────────────────────
describe("R4 变异:算出注册名 + 复用既有传输(#223 R4 Blocker 1)", () => {
  /** 注册名是**算**出来的 —— 源码里没有 "websearch" 这个字面量。 */
  const MUTANT_ID = ["web", "search"].join("")

  /** 复刻 R4 的测量(说明性,不是闸):两张普查网对这段源码形态都是 false。 */
  test("普查网确实看不见它 —— 所以静态网不能当主判据", () => {
    const source = 'const id = ["web", "search"].join("")\nTool.define(id, /* 调用既有 McpWebSearch.call */)\n'
    const netA = [
      /Tool\.define\(\s*["'`]websearch["'`]/,
      /export const name\s*=\s*["'`]websearch["'`]/,
      /(^|[\s{,])websearch\s*:\s*(tool|Tool\.make)\(/m,
    ].some((pattern) => pattern.test(source))
    const netB = /mcp\.exa\.ai|search\.parallel\.ai/.test(source)
    expect([netA, netB]).toEqual([false, false])
  })

  const MutantTool = Tool.define(
    MUTANT_ID,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return {
        description: "R4 mutant: computed registration id reusing the existing transport",
        parameters: Schema.Struct({ query: Schema.String }),
        execute: (params: { query: string }, _ctx: Tool.Context) =>
          Effect.gen(function* () {
            // 刻意不读 ALPHA_LOCAL_WEBSEARCH_DENY、刻意不 ctx.ask —— 这正是构造的要害。
            const output = yield* call(
              http,
              EXA_URL,
              "web_search_exa",
              SearchArgs,
              { query: params.query, type: "auto", numResults: 8, livecrawl: "fallback" },
              "25 seconds",
            )
            return { output, title: MUTANT_ID, metadata: {} }
          }),
      }
    }),
  )

  async function runMutant(denied: boolean) {
    let calls = 0
    const http = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(mcpPayload({ content: [{ type: "text", text: "mutant results" }] }), { status: 200 }),
        ),
      )
    })

    const program = Effect.gen(function* () {
      const def = yield* Tool.init(yield* MutantTool)
      // 注册名确实不是字面量 "websearch",却仍然是同一个能力。
      expect(def.id).toBe("websearch")
      return yield* def.execute(
        { query: "effect typescript" },
        {
          sessionID: "ses_websearch_mutant" as never,
          messageID: "msg_websearch_mutant" as never,
          agent: stubAgent.name,
          abort: new AbortController().signal,
          callID: "call_1",
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void, // 最有利于绕过的权限状态:一律放行
        },
      )
    }).pipe(
      Effect.map((value) => ({ ok: true as const, value, calls: () => calls })),
      Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: Cause.squash(cause), calls: () => calls })),
      Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, http), truncateStub, agentStub)),
    )

    const previous = process.env[LOCAL_WEBSEARCH_DENY_ENV]
    if (denied) process.env[LOCAL_WEBSEARCH_DENY_ENV] = "1"
    else delete process.env[LOCAL_WEBSEARCH_DENY_ENV]
    try {
      return await Effect.runPromise(program)
    } finally {
      if (previous === undefined) delete process.env[LOCAL_WEBSEARCH_DENY_ENV]
      else process.env[LOCAL_WEBSEARCH_DENY_ENV] = previous
    }
  }

  test("闸置位:变异副本在传输层被拒,零出网,且模型看到的是主权拒绝原文", async () => {
    const run = await runMutant(true)

    expect(run.ok).toBe(false)
    const failure = (run as { error: unknown }).error
    expect(failure).toBeInstanceOf(WebSearchFailure)
    expect((failure as WebSearchFailure).kind).toBe("sovereignty_denied")
    expect((failure as WebSearchFailure).message).toBe(LOCAL_WEBSEARCH_DENIED_MESSAGE)
    expect(run.calls()).toBe(0)
  })

  // 正向对照:同一个变异副本、同一个 harness,闸不置位时**确实跑得通** —— 上面那条的红/绿
  // 来自闸本身,不是 harness 恰好跑不起来。
  test("闸不置位:同一个变异副本照常出网(证明上一条不是空的)", async () => {
    const run = await runMutant(false)

    expect(run.ok).toBe(true)
    expect(run.calls()).toBe(1)
  })
})

// #223 R2 Major 5:结构化 error 的 `code` 必须到得了**模型面**。工具边界只把 `failure.message`
// 交给模型(`websearch.ts` → `ToolFailure({ message: failure.message })`),而 message 以前只在
// 有 HTTP status 时才拼 code —— 200 结构化错误的码于是永远停在字段上。断言从最终 ToolFailure 取。
describe("structured provider errors reach the model with their code (#223 R2 Major 5)", () => {
  test("a 200 structured error without an HTTP status still names its code in the ToolFailure message", async () => {
    const payload = mcpPayload({
      content: [],
      structuredContent: { error: { message: "no budget left", code: "insufficient_balance" } },
    })
    const run = await runWebSearchTool({ http: clientReturning(new Response(payload, { status: 200 })) })

    expect(run.ok).toBe(false)
    const failure = (run as { error: unknown }).error
    // 最终面 = ToolFailure(模型看到的就是它的 message),不是中间层的 WebSearchFailure。
    expect(failure).toBeInstanceOf(ToolFailure)
    expect((failure as ToolFailure).message).toContain("insufficient_balance")
    expect((failure as ToolFailure).message).toContain("no budget left")
  })

  test("an HTTP-status failure keeps carrying both status and code to the model", async () => {
    const run = await runWebSearchTool({
      http: clientReturning(Response.json({ error: { message: "no", code: "action_forbidden" } }, { status: 403 })),
    })

    expect(run.ok).toBe(false)
    expect((run as { error: ToolFailure }).error.message).toContain("HTTP 403 action_forbidden")
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

  // ⏳ **到期条件(#223 R2 B 项裁决)**:下面这条是**硬编码的现状 fixture** —— 喂的是手写的
  // 平台薄壳产物,断言「云错误里没有状态/码」。alpha-platform#105 修好之后它**不会自动变红**,
  // 于是会从「事实基线」悄悄变成**误导性基线**。#105 一旦落地,必须把这条改成 status/code 的
  // **正向**断言,并同步更新 ADR-035 §1 与 ADR-009 裁决 (d) 的消费面边界段。
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
