import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { call, parseResponse, SearchArgs, WebSearchFailure } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, webSearchModelName, webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"
const SEARCH_ARGS = { query: "effect typescript", type: "auto", numResults: 8, livecrawl: "fallback" }

function clientReturning(response: Response) {
  return HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)))
}

/** Run a search against a stubbed transport and hand back the failure it produced. */
function searchFailure(http: HttpClient.HttpClient) {
  return Effect.runPromise(
    Effect.flip(call(http, "https://search.test/mcp", "web_search", SearchArgs, SEARCH_ARGS, "1 second")),
  )
}

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
  })

  test("is only enabled for opencode or explicit websearch provider flags", () => {
    expect(webSearchEnabled(ProviderV2.ID.opencode, { exa: false, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: false })).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: true, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  // #489:空/坏响应曾被调用方换成 "No search results found." 当成成功串返回 —— 伪成功已删。
  for (const [name, body] of [
    ["an empty body", ""],
    ["a result with no content", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })],
    [
      "a result whose only text is blank",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "  " }] } }),
    ],
  ] as const) {
    it.effect(`fails loudly for ${name} instead of faking a no-results success`, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(parseResponse(body))
        expect(failure).toBeInstanceOf(WebSearchFailure)
        expect(failure.kind).toBe("empty_result")
        expect(failure.message).not.toContain("No search results found")
      }),
    )
  }

  it.effect("keeps a provider-flagged error loud even on a 200", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        parseResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { isError: true, content: [{ type: "text", text: "quota rejected" }] },
          }),
        ),
      )
      expect(failure.kind).toBe("provider_error")
      expect(failure.message).toContain("quota rejected")
    }),
  )

  it.effect("reports an undecodable payload with the upstream body attached", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(parseResponse('{"jsonrpc":"2.0","id":1,"result":{"content":"nope"}}'))
      expect(failure.kind).toBe("invalid_response")
      expect(failure.message).toContain('"content":"nope"')
    }),
  )
})

// #489:平台 `POST /v1/tools/web_search` 的真实失败集(alpha-platform worker.ts) ——
// 401 / 403 action_forbidden / 400 / 402(preauth 拒绝 与 per-job 超预算)/ 502,其余非 2xx 一律 LOUD。
describe("websearch upstream failure mapping", () => {
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
