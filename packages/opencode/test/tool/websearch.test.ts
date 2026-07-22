import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { call, Failure, NO_RESULTS, parseResponse, SearchArgs } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, webSearchModelName, webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"
const request = {
  query: "effect typescript",
  type: "auto",
  numResults: 8,
  livecrawl: "fallback",
}

function clientReturning(response: Response) {
  return HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)))
}

function search(http: HttpClient.HttpClient) {
  return call(http, "https://search.test/mcp", "web_search", SearchArgs, request, "1 second")
}

function failure(http: HttpClient.HttpClient) {
  return Effect.runPromise(Effect.flip(search(http)))
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

  it.effect("accepts only an explicit zero-results response as no results", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ query: "nothing", results: [] }) }],
          },
        }),
      )
      expect(result).toBe(NO_RESULTS)
    }),
  )

  for (const [name, text] of [
    ["empty response", ""],
    ["empty result content", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })],
    ["ambiguous no-results marker", payload.replace("search results", NO_RESULTS)],
  ] as const) {
    it.effect(`fails loudly for ${name}`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.flip(parseResponse(text))
        expect(result).toBeInstanceOf(Failure)
        expect(result.kind).toBe("invalid_response")
      }),
    )
  }

  it.effect("fails loudly when the provider marks a result as an error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        parseResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { isError: true, content: [{ type: "text", text: "quota rejected" }] },
          }),
        ),
      )
      expect(result.kind).toBe("provider_error")
      expect(result.message).toContain("quota rejected")
    }),
  )
})

describe("websearch upstream failure mapping", () => {
  const outcomes = [
    [401, { error: { message: "unauthorized" } }, "unauthorized"],
    [403, { error: { code: "scope_forbidden", message: "forbidden" } }, "scope_forbidden"],
    [400, { error: { message: "query is required" } }, "bad_request"],
    [502, { error: { message: "upstream unavailable" } }, "upstream"],
    [418, { error: { message: "unexpected teapot" } }, "unexpected_status"],
  ] as const

  for (const [status, body, kind] of outcomes) {
    test(`maps HTTP ${status} to a discernible loud failure`, async () => {
      const result = await failure(clientReturning(Response.json(body, { status })))

      expect(result).toBeInstanceOf(Failure)
      if (!(result instanceof Failure)) throw result
      expect(result.kind).toBe(kind)
      expect(result.status).toBe(status)
      expect(result.message).toContain(`HTTP ${status}`)
      expect(result.message).toContain(JSON.stringify(body))
    })
  }

  test("keeps every status category distinct", async () => {
    const results = await Promise.all(
      outcomes.map(([status, body]) => failure(clientReturning(Response.json(body, { status })))),
    )
    expect(new Set(results.map((result) => result.message)).size).toBe(outcomes.length)
  })

  test("maps a thrown transport error without leaving a defect", async () => {
    const result = await failure(HttpClient.make(() => Effect.die(new Error("socket reset by peer"))))

    expect(result).toBeInstanceOf(Failure)
    if (!(result instanceof Failure)) throw result
    expect(result.kind).toBe("transport")
    expect(result.message).toContain("socket reset by peer")
  })
})
