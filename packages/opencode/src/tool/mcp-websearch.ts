import { Cause, Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

// #489(E7 失败诚实,ADR-035 L3 接管):本文件从「一切错误塌成 defect + 空结果伪装成成功串」
// 改为**可辨的 typed failure**。E7 不变量:禁伪成功、任何非 2xx 一律 LOUD、云/本地失败都不静默
// 降级(唯一允许的回退是模型自带 search,那不在本层)。失败集与 alpha-platform 的
// `POST /v1/tools/web_search` 契约对齐 —— 401 / 403(`action_forbidden`、`job_not_enforceable`)/
// 400 / 402(accountPreauth 拒绝、per-job 超预算)/ 502 / 其它一律 unexpected_status。
const FailureKind = Schema.Literals([
  "unauthorized",
  "forbidden",
  "bad_request",
  "payment_required",
  "upstream",
  "unexpected_status",
  "timeout",
  "transport",
  "provider_error",
  "empty_result",
  "invalid_response",
])

const FAILURE_LABEL: Record<Schema.Schema.Type<typeof FailureKind>, string> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  bad_request: "bad request",
  payment_required: "payment required (out of budget)",
  upstream: "upstream failure",
  unexpected_status: "unexpected HTTP status",
  timeout: "request timed out",
  transport: "transport failure",
  provider_error: "the provider reported an error",
  empty_result: "no usable result",
  invalid_response: "invalid response",
}

/**
 * The single discernible web search failure. `message` is what the model sees, so it always names
 * the category, the HTTP status/code when there is one, and the upstream body as the cause — never
 * a fabricated "no results" success string.
 */
export class WebSearchFailure extends Schema.TaggedErrorClass<WebSearchFailure>()("AlphaWebSearchFailure", {
  kind: FailureKind,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status}${this.code ? ` ${this.code}` : ""})`
    return `Web search failed: ${FAILURE_LABEL[this.kind]}${status}. Cause: ${this.detail}`
  }
}

const MAX_DETAIL = 1_000

function detailOf(body: string) {
  const detail = body.trim().replaceAll(/\s+/g, " ")
  if (!detail) return "the upstream returned an empty body"
  return detail.slice(0, MAX_DETAIL)
}

function errorCodeOf(body: string) {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
    return typeof code === "string" && code ? code : undefined
  } catch {
    return undefined
  }
}

function statusKind(status: number): Schema.Schema.Type<typeof FailureKind> {
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 400) return "bad_request"
  if (status === 402) return "payment_required"
  if (status === 502) return "upstream"
  return "unexpected_status"
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
  }),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const data = yield* decode(trimmed).pipe(
      Effect.mapError(
        (error) =>
          new WebSearchFailure({
            kind: "invalid_response",
            // 带上原始负载:只回 schema 报错等于把上游的真话丢了,调不动时无从判因。
            detail: `${detailOf(trimmed)} — ${String(error)}`,
            cause: error,
          }),
      ),
    )
    const text = data.result.content.find((item) => item.text.trim())?.text
    // MCP 层的 isError 是 provider 自报的失败,HTTP 可能仍是 200 —— 不许当成结果串返回。
    if (data.result.isError)
      return yield* new WebSearchFailure({
        kind: "provider_error",
        detail: text?.trim() ?? "the provider flagged the result as an error without details",
      })
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
  // 旧行为在这里返回 undefined,调用方再把它换成 "No search results found." —— 那是伪成功:
  // 「provider 真的零命中」与「响应坏了/被截断」被压成同一个串,模型无从分辨。零命中的 provider
  // 会回一个真实负载(空 results 数组),走的是上面的成功路。
  return yield* new WebSearchFailure({
    kind: "empty_result",
    detail: trimmed
      ? "the provider response carried no search result payload"
      : "the provider returned an empty response body",
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
    // filterStatusOk 走掉了:它把每个非 2xx 压成同一个 StatusError,状态与 body 都拿不回来。
    const response = yield* http.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new WebSearchFailure({ kind: "timeout", detail: `${tool} did not answer within ${String(timeout)}` }),
          ),
      }),
    )
    const body = yield* response.text
    if (response.status < 200 || response.status >= 300) {
      const code = errorCodeOf(body)
      return yield* new WebSearchFailure({
        kind: statusKind(response.status),
        status: response.status,
        detail: detailOf(body),
        ...(code ? { code } : {}),
      })
    }
    return yield* parseResponse(body)
  }).pipe(
    // 传输层错误/defect 也要落进同一个可辨类型 —— 否则「socket reset」仍是未处理 defect(工具崩溃)。
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      if (error instanceof WebSearchFailure) return Effect.fail(error)
      return Effect.fail(
        new WebSearchFailure({
          kind: "transport",
          detail: error instanceof Error ? (error.message ?? String(error)) : String(error),
          cause: error,
        }),
      )
    }),
  )
