import { Cause, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export const NO_RESULTS = "No search results found. Please try a different query."

const FailureKind = Schema.Literals([
  "unauthorized",
  "scope_forbidden",
  "bad_request",
  "upstream",
  "unexpected_status",
  "transport",
  "timeout",
  "invalid_response",
  "provider_error",
])

export class Failure extends Schema.TaggedErrorClass<Failure>()("WebSearchUpstreamFailure", {
  kind: FailureKind,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const label =
      this.kind === "unauthorized"
        ? "unauthorized"
        : this.kind === "scope_forbidden"
          ? "scope forbidden"
          : this.kind === "bad_request"
            ? "bad request"
            : this.kind === "upstream"
              ? "upstream failure"
              : this.kind === "unexpected_status"
                ? "unexpected HTTP status"
                : this.kind === "transport"
                  ? "transport failure"
                  : this.kind === "timeout"
                    ? "request timed out"
                    : this.kind === "provider_error"
                      ? "provider reported an error"
                      : "invalid response"
    return `Web search failed: ${label}${this.status === undefined ? "" : ` (HTTP ${this.status})`}. Cause: ${this.detail}`
  }
}

export const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.String,
      }),
    ),
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
  }),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const data = yield* decode(trimmed).pipe(
      Effect.mapError(
        (error) =>
          new Failure({
            kind: "invalid_response",
            detail: String(error),
            cause: error,
          }),
      ),
    )
    const text = data.result.content.find((item) => item.text.trim())?.text.trim()
    if (data.result.isError) {
      return yield* new Failure({
        kind: "provider_error",
        detail: text ?? "the provider returned an error without details",
      })
    }
    if (explicitZeroResults(data.result.structuredContent) || (text && explicitZeroResults(text))) return NO_RESULTS
    if (!text || text === NO_RESULTS || text === "NO_RESULTS" || /^no (search )?results( found)?\.?$/i.test(text)) {
      return yield* new Failure({
        kind: "invalid_response",
        detail: text ? `ambiguous no-results marker: ${text}` : "the provider returned no result payload",
      })
    }
    return text
  })

export const parseResponse = Effect.fn("McpWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  const direct = trimmed ? yield* parsePayload(trimmed) : undefined
  if (direct) return direct

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (data) return data
  }
  return yield* new Failure({
    kind: "invalid_response",
    detail: trimmed ? "the provider response contained no usable search result" : "the provider response was empty",
  })
})

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const ParallelSearchArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.optional(Schema.String),
  model_name: Schema.optional(Schema.String),
})

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers ?? {}),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    const response = yield* http.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          new Failure({
            kind: "timeout",
            detail: `${tool} exceeded ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
          }),
      }),
    )
    const body = yield* response.text
    if (response.status < 200 || response.status >= 300) {
      return yield* new Failure({
        kind:
          response.status === 401
            ? "unauthorized"
            : response.status === 403
              ? "scope_forbidden"
              : response.status === 400
                ? "bad_request"
                : response.status === 502
                  ? "upstream"
                  : "unexpected_status",
        status: response.status,
        detail: failureDetail(body),
      })
    }
    return yield* parseResponse(body)
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      if (error instanceof Failure) return Effect.fail(error)
      return Effect.fail(
        new Failure({
          kind: "transport",
          detail: error instanceof Error ? error.message : String(error),
          cause: error,
        }),
      )
    }),
  )

function explicitZeroResults(value: unknown) {
  const decoded = typeof value === "string" ? decodeJson(value) : Option.some(value)
  if (Option.isNone(decoded) || !decoded.value || typeof decoded.value !== "object") return false
  if ("error" in decoded.value && decoded.value.error !== undefined && decoded.value.error !== null) return false
  if (!("results" in decoded.value) || !Array.isArray(decoded.value.results)) return false
  return decoded.value.results.length === 0
}

function failureDetail(body: string) {
  const detail = body.trim().replaceAll(/\s+/g, " ")
  if (!detail) return "the upstream returned an empty error response"
  return detail.slice(0, 1_000)
}
