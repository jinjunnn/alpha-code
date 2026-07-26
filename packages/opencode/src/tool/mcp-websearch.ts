import { Cause, Duration, Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"

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
    // #223 R2(Major 5):`code` 以前只在**有 HTTP status 时**才拼进 message,而工具边界只把
    // `message` 交给模型(`websearch.ts` 的 `ToolFailure({ message: failure.message })`)——
    // 于是 200 结构化错误(`provider_error`)的 `error.code` 只留在字段上,模型面永远看不到,
    // 「带 code 所以可辨」这句声明对模型不成立。status 与 code 现在各自独立出现。
    const marks: string[] = []
    if (this.status !== undefined) marks.push(`HTTP ${this.status}`)
    if (this.code) marks.push(this.code)
    const suffix = marks.length === 0 ? "" : ` (${marks.join(" ")})`
    return `Web search failed: ${FAILURE_LABEL[this.kind]}${suffix}. Cause: ${this.detail}`
  }
}

const MAX_DETAIL = 1_000

function detailOf(body: string) {
  const detail = body.trim().replaceAll(/\s+/g, " ")
  if (!detail) return "the upstream returned an empty body"
  return detail.slice(0, MAX_DETAIL)
}

/** `{ error: … }` 里的结构化错误。平台 gateway 与 Exa/Parallel 都用这个形状。 */
type StructuredError = { message: string; code?: string }

function structuredErrorOf(value: unknown): StructuredError | undefined {
  if (!value || typeof value !== "object") return undefined
  const error = (value as { error?: unknown }).error
  if (error === undefined || error === null) return undefined
  if (typeof error === "string") return error.trim() ? { message: error } : undefined
  if (typeof error !== "object") return { message: String(error) }
  const record = error as { message?: unknown; code?: unknown }
  const code = typeof record.code === "string" && record.code ? record.code : undefined
  const message = typeof record.message === "string" && record.message ? record.message : JSON.stringify(error)
  return { message, ...(code ? { code } : {}) }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function errorCodeOf(body: string) {
  return structuredErrorOf(parseJson(body))?.code
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

// #223 对抗审计(2026-07-25):`structuredContent` 以前**没进 schema**,于是「`content: []` +
// `structuredContent.results: []`」这种合法的 MCP 零命中成功被判成 `empty_result`(伪失败),
// 而 provider 未置 `isError` 时把 `{"error":…}` 整个当结果串回给模型(伪成功)。两侧都要收口。
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

/** MCP 成功负载里 `results` 明确是数组(含空数组)= provider 真的答了,零命中也是合法成功。 */
function explicitResults(structured: unknown) {
  if (!structured || typeof structured !== "object") return undefined
  const results = (structured as { results?: unknown }).results
  return Array.isArray(results) ? results : undefined
}

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
    const { content, isError, structuredContent } = data.result
    const text = content.find((item) => item.text.trim())?.text
    // MCP 层的 isError 是 provider 自报的失败,HTTP 可能仍是 200 —— 不许当成结果串返回。
    if (isError)
      return yield* new WebSearchFailure({
        kind: "provider_error",
        detail: text?.trim() ?? "the provider flagged the result as an error without details",
      })
    // 200 + 未置 isError,但负载(文本或 structuredContent)本身是结构化 error:同样是 provider
    // 失败,不许把整个 error JSON 当搜索结果回给模型。
    const structuredError =
      structuredErrorOf(structuredContent) ?? structuredErrorOf(text ? parseJson(text) : undefined)
    if (structuredError)
      return yield* new WebSearchFailure({
        kind: "provider_error",
        detail: structuredError.message,
        ...(structuredError.code ? { code: structuredError.code } : {}),
      })
    if (text) return text
    // `content` 为空但 `structuredContent.results` 明确是数组 ⇒ 合法成功(零命中也算)。把
    // structuredContent 原样交给模型 —— 与上游 `mcp/catalog.ts` 对空 content 的处理同款,
    // 不编造 "No search results found." 那种伪成功串。
    return explicitResults(structuredContent) === undefined ? undefined : JSON.stringify(structuredContent)
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
  // 「provider 真的零命中」与「响应坏了/被截断」被压成同一个串,模型无从分辨。真零命中走
  // 上面的成功路(`structuredContent.results: []`)。
  // #223:这条失败以前不带原 body,于是 200 的 HTML/非 JSON 错误页与「truncated JSON」都塌成
  // 同一句不可辨的话。原样附上上游 body(截到 MAX_DETAIL)。
  return yield* new WebSearchFailure({
    kind: "empty_result",
    detail: trimmed
      ? `the provider response carried no search result payload — body: ${detailOf(trimmed)}`
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

/** MCP 搜索结果的合理上限。超出即停读 —— 与 webfetch 的 5MB 上限同一纪律,只是这里更小。 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 有界读取响应体:边读边计数,越界立刻停止拉流,绝不为了截断而先把整份缓冲进内存。
 * 越界读到的部分照常返回(带截断标记),让状态码分支与 parseResponse 仍能给出可辨失败。
 *
 * #223 R2(Major 6):初版**先整块 `push` 再判越界** —— 上限只对「块小」的流成立。R2 动态
 * 复现:喂入单个 3 MiB chunk,`Buffer.concat` 实收 3,145,728 字节,而声明上限是 2,097,152。
 * 现在最后一块只保留**剩余可读字节**(`subarray`),`MAX_BODY_BYTES` 是硬限,与块大小无关。
 */
export const readBoundedBody = Effect.fn("McpWebSearch.readBoundedBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  yield* Stream.runForEachWhile(response.stream, (chunk: Uint8Array) =>
    Effect.sync(() => {
      const remaining = MAX_BODY_BYTES - size
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk)
        size += chunk.byteLength
        return true
      }
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining))
        size = MAX_BODY_BYTES
      }
      truncated = true
      return false
    }),
  )
  const body = Buffer.concat(chunks).toString("utf8")
  return truncated ? `${body}\n[truncated at ${MAX_BODY_BYTES} bytes]` : body
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
    // #223 对抗审计(2026-07-25):timeout 以前只包 `http.execute`(= headers 到手就算数),
    // body 的读取在期限之外 —— 服务在期限内回 200 headers 但 body 永不结束时,`response.text`
    // 无限等待,50ms timeout 的探针 250ms 后仍 pending,没有任何 loud failure。headers + body
    // 必须在**同一个** timeout 内,且 body 有界收集(否则超大响应先被完整缓冲,MAX_DETAIL 的
    // 1KB 截断发生得太晚,拦不住内存耗尽)。
    const { status, body } = yield* Effect.gen(function* () {
      const response = yield* http.execute(request)
      return { status: response.status, body: yield* readBoundedBody(response) }
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new WebSearchFailure({ kind: "timeout", detail: `${tool} did not answer within ${String(timeout)}` }),
          ),
      }),
    )
    if (status < 200 || status >= 300) {
      const code = errorCodeOf(body)
      return yield* new WebSearchFailure({
        kind: statusKind(status),
        status,
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
