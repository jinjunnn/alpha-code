export * as WebSearchTool from "./websearch"

import { ToolFailure } from "@opencode-ai/llm"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { truthy } from "../flag/flag"
import { InstallationVersion } from "../installation/version"
import { PositiveInt } from "../schema"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { collectBoundedResponseBody } from "./http-body"
import { checksum } from "../util/encode"
import { ToolRegistry } from "./registry"

export const name = "websearch"

/**
 * ADR-009 B1/B2 主权判决送进引擎进程的通道(#223 R3 Blocker 1 → R4 下沉到传输层)。
 *
 * 这是**第二份**同名 `websearch` 注册:打包 sidecar 的 HttpApi 同时挂载 V2 Session 路由与
 * Location 服务(`packages/opencode/src/server/routes/instance/httpapi/server.ts`),
 * `location-services.ts` 装载 `BuiltInTools`,本文件的注册因此是**已挂载的活路径**。
 * legacy 那份(`packages/opencode/src/tool/websearch.ts`)的最终闸对它不成立 —— R3 判 Blocker 1
 * 未闭合正是因为主权信号只覆盖了一份副本。
 *
 * R4 再判未闭合:闸放在每个叶子的 `execute` 首行 + 源码普查兜底,挡不住「算出注册名 + 复用
 * 既有传输」。于是本文件的闸也下沉一层 —— 下面导出的 `callMcp` 是 V2 Core 这一侧**唯一**的
 * keyless web search 出网出口,它的第一句读同一个信号。叶子首行那道保留为纵深。
 *
 * 名字在四个包里各写一份(core / opencode / ui-mac / ext 之间没有可共用的 alpha 依赖边),
 * 漂移与「新的出网出口」由 `packages/ui-mac/src/main/websearch-copies.test.ts` 的普查闸钉住
 * (R4 起该普查网是纵深,不再是主判据)。
 */
export const LOCAL_WEBSEARCH_DENY_ENV = "ALPHA_LOCAL_WEBSEARCH_DENY"

/** fail-closed:除「缺省 / 空串 / `"0"`」外的任何取值都判为 deny。与 legacy 副本逐字同义。 */
export function localWebSearchDenied(env: Record<string, string | undefined> = process.env) {
  const value = env[LOCAL_WEBSEARCH_DENY_ENV]
  return value !== undefined && value !== "" && value !== "0"
}

/**
 * 模型可见的拒绝理由。明说「别重试」,否则模型会把它当成瞬时故障反复调用。
 *
 * `#1411`(REQ-1414 CODE-1):这句话此前无条件点名云 web search 工具、让模型改用它。
 * 那是 ADR-009 B1 时代的实话 —— 本地腿在**登录代付**态被有意关掉,云腿正是替代品。B1 已被推翻
 * (owner 2026-09-23:账户信号只决定云腿在不在),本地腿从此只有 kill-switch 能关;而 kill-switch
 * **同时**关掉云腿。于是那句指路在唯一可达它的状态下必然是错的 —— 它把模型引向一个同一时刻也不在
 * 工具表里的工具。基线 S5:任何「此路不通」的文案只能指向一条**此刻确实在表里**的替代,指不出就
 * 明说没有。判据:`packages/ui-mac/src/main/cloud-web-search.test.ts` 的文案断言。
 */
export const LOCAL_WEBSEARCH_DENIED_MESSAGE =
  "Web search is unavailable: the alpha web search kill switch (ADR-009 B2) is set, and it turns off every web search tool — the local keyless one and the platform-hosted one alike. This is not a transient failure and no permission grant can lift it; do not retry, and do not look for another web search tool. Answer without web search and say so."

/**
 * 传输层闸的失败值。刻意用 canonical 的 `ToolFailure` 而不是自定义 Error:
 * `ToolRegistry.settle` 只把 `LLM.ToolFailure` 结算成**模型可见的 tool error**
 * (`registry.ts` 的 `Effect.catchTag("LLM.ToolFailure", …)`),别的错误一律是 defect。
 * 于是任何复用本传输的副本 —— 哪怕它自己一句错误映射都没写 —— 拿到的都是那句「别重试」,
 * 而不是一次工具崩溃。
 */
export const localWebSearchDeniedFailure = () =>
  new ToolFailure({ message: LOCAL_WEBSEARCH_DENIED_MESSAGE, metadata: { denied: "alpha-sovereignty" } })

export const NO_RESULTS = "No search results found. Please try a different query."
export const EXA_URL = "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"
export const MAX_NUM_RESULTS = 20
export const MAX_CONTEXT_CHARACTERS = 50_000
export const MAX_RESPONSE_BYTES = 256 * 1024

/**
 * Provider-independent local web search retained in V2 core for launch parity.
 * This invokes the legacy Exa/Parallel product backends itself. It is distinct
 * from provider-hosted web search tools, which remain route-owned and execute
 * at the model provider. Ownership of this compromise can be revisited later.
 */
export const description = `Search the web using the session's local web search provider. Use this for current information beyond knowledge cutoff.

This is a provider-independent local tool backed by Exa or Parallel. Provider-hosted web search tools are separate and execute at the model provider.

Optional controls support result count, live crawling ('fallback' or 'preferred'), search type ('auto', 'fast', or 'deep'), and maximum context characters.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))).annotate({
    description: `Number of search results to return (default: 8, maximum: ${MAX_NUM_RESULTS})`,
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_CONTEXT_CHARACTERS))).annotate(
    {
      description: `Maximum characters for context string optimized for models (default: 10000, maximum: ${MAX_CONTEXT_CHARACTERS})`,
    },
  ),
})

export const Provider = Schema.Literals(["exa", "parallel"])
export type Provider = typeof Provider.Type

export interface Config {
  readonly provider?: Provider
  readonly enableExa: boolean
  readonly enableParallel: boolean
  readonly exaApiKey?: string
  readonly parallelApiKey?: string
}

export class ConfigService extends Context.Service<ConfigService, Config>()("@opencode/v2/WebSearchConfig") {}

/** Isolates the retained product environment contract from the generic tool implementation. */
export const defaultConfigLayer = Layer.sync(ConfigService, () =>
  ConfigService.of({
    provider:
      process.env.OPENCODE_WEBSEARCH_PROVIDER === "exa" || process.env.OPENCODE_WEBSEARCH_PROVIDER === "parallel"
        ? process.env.OPENCODE_WEBSEARCH_PROVIDER
        : undefined,
    enableExa: truthy("OPENCODE_EXPERIMENTAL") || truthy("OPENCODE_ENABLE_EXA") || truthy("OPENCODE_EXPERIMENTAL_EXA"),
    enableParallel: truthy("OPENCODE_ENABLE_PARALLEL") || truthy("OPENCODE_EXPERIMENTAL_PARALLEL"),
    exaApiKey: process.env.EXA_API_KEY,
    parallelApiKey: process.env.PARALLEL_API_KEY,
  }),
)

export const configNode = makeLocationNode({ service: ConfigService, layer: defaultConfigLayer, deps: [] })

export function selectProvider(
  sessionID: string,
  flags: Pick<Config, "enableExa" | "enableParallel"> = { enableExa: false, enableParallel: false },
  override?: Provider,
): Provider {
  if (override) return override
  if (flags.enableParallel) return "parallel"
  if (flags.enableExa) return "exa"
  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

// ─────────────────────────────────────────────────────────────────────────────
// `#1449`:这份副本以前**认不出失败**。`McpResult` 不含 `isError`,带 `isError:true` 的响应正常解码、
// `content[0].text`(Exa 的 401 原文)被当成搜索结果交给模型;出网走 `HttpClient.filterStatusOk`,
// 非 2xx 全塌成一个不可辨的错误。legacy 那份(`packages/opencode/src/tool/mcp-websearch.ts`)
// 在 `#489`/`#223` 已经收口,其注释自己写着「两侧都要收口」—— 只收了一侧。下面的失败模型与判定
// 逐字照那份的形状做(名字在两个包各写一份:core 与 opencode 之间没有可共用的 alpha 依赖边)。
//
// 边界(`#1449` 票面):真的零结果**仍走** `NO_RESULTS`(`parseResponse` 回 `undefined`,叶子换成那句),
// 「没有结果」与「搜索失败」在模型面必须可区分。`#1445` 那种 2xx + `result` + 非 `isError` 的纯文本
// 提示没有可消费的结构化信号(勘破见 `docs/architecture/2026-09-24-exa-mcp-failure-signal-recon.md`),
// 不在这里判 —— 按关键字猜是「手写别人文法的替身」。
// ─────────────────────────────────────────────────────────────────────────────
const FailureKind = Schema.Literals([
  "unauthorized",
  "forbidden",
  "bad_request",
  "payment_required",
  "upstream",
  "unexpected_status",
  "provider_error",
  "invalid_response",
])

const FAILURE_LABEL: Record<Schema.Schema.Type<typeof FailureKind>, string> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  bad_request: "bad request",
  payment_required: "payment required (out of budget)",
  upstream: "upstream failure",
  unexpected_status: "unexpected HTTP status",
  provider_error: "the provider reported an error",
  invalid_response: "invalid response",
}

/**
 * 可辨的 web search 失败。`message` 就是模型看到的那句:永远点名类别、有 HTTP 状态/错误码时带上、
 * 并把上游 body 作为 cause 附上 —— 绝不是一句编造的「没有结果」。
 * 叶子把它映射成 canonical 的 `ToolFailure`(`ToolRegistry.settle` 只把那个结算成模型可见 error)。
 */
export class WebSearchFailure extends Schema.TaggedErrorClass<WebSearchFailure>()("AlphaWebSearchFailure", {
  kind: FailureKind,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
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

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
    // MCP 层的 provider 自报失败。HTTP 可能仍是 200(Exa 的 401 / 未知工具 / 参数不合法都这样回,
    // 2026-09-24 实读 4/4 臂)—— 不进 schema 就等于永远看不见它。
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
  }),
})
const decodeMcpResult = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const data = yield* decodeMcpResult(trimmed).pipe(
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
    // provider 自报的失败:不许当成结果串返回,也不许塌成 NO_RESULTS。
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
    // 没有失败信号、也没有文本 ⇒ `undefined`,叶子把它换成 NO_RESULTS。这是 AC3 的「真的零结果」臂。
    return text
  })

export const parseResponse = Effect.fn("WebSearchTool.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  const direct = trimmed ? yield* parsePayload(trimmed) : undefined
  if (direct) return direct
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (data) return data
  }
  return undefined
})

const ExaArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})
const ParallelArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.String,
})
const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({ name: Schema.String, arguments: args }),
  })

const exaUrl = (apiKey: string | undefined) => {
  if (!apiKey) return EXA_URL
  const url = new URL(EXA_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.toString()
}

/**
 * V2 Core 这一侧**唯一**的 keyless web search 出网出口(#223 R4 Blocker 1)。
 *
 * 导出而不是私有:它是这一层的**共同执行边界**。将来 core 里再出现一份 websearch 副本时,
 * 正确写法是复用本函数 —— 复用即带闸,注册名怎么算出来都无所谓。第一句就是主权闸,拒绝
 * 发生在构造请求之前(零出网)。
 */
export const callMcp = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    if (localWebSearchDenied()) return yield* Effect.fail(localWebSearchDeniedFailure())
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    return yield* Effect.gen(function* () {
      // `#1449`:`filterStatusOk` 走掉了 —— 它把每个非 2xx 压成同一个 StatusError,状态与 body 都拿不
      // 回来(Exa 免费额度用尽是 429 + JSON-RPC `error -32000`,2026-09-24 实读 43/43)。非 2xx 的 body
      // 照样有界读取,再按状态映射成具名失败,与 mcp-websearch.ts 的 `call()` 同一条纪律。
      const response = yield* http.execute(request)
      const body = (yield* collectBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new Error(`${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes`),
      )).toString("utf8")
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
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => Effect.fail(new Error(`${tool} request timed out`)),
      }),
    )
  })

const Output = Schema.Struct({
  provider: Provider,
  text: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const http = yield* HttpClient.HttpClient
    const config = yield* ConfigService
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) => {
            // #223 R3 Blocker 1:主权 deny 必须是**最终**规则,且必须覆盖**每一份**已挂载的
            // websearch 执行副本。这一份走的是 V2 `PermissionV2` ruleset(下方 `permission.assert`)——
            // 与 legacy 那份同病:任何排在注入的 deny 之后的 allow(agent 规则 / 持久化 session
            // permission / ask 的 approved)都能顶掉它。所以闸放在**工具自身**的首行:它根本不查
            // ruleset,因而没有任何 permission 规则能覆盖,也早于 permission.assert 的弹窗。
            // `ToolFailure` 会被 `ToolRegistry.settle` 结算成模型可见的 tool error(registry.ts)。
            if (localWebSearchDenied())
              return Effect.fail(new ToolFailure({ message: LOCAL_WEBSEARCH_DENIED_MESSAGE }))

            const provider = selectProvider(context.sessionID, config, config.provider)
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.query],
                save: ["*"],
                metadata: { ...input, provider },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const text =
                provider === "exa"
                  ? yield* callMcp(http, exaUrl(config.exaApiKey), "web_search_exa", ExaArgs, {
                      query: input.query,
                      type: input.type || "auto",
                      numResults: input.numResults || 8,
                      livecrawl: input.livecrawl || "fallback",
                      contextMaxCharacters: input.contextMaxCharacters,
                    })
                  : yield* callMcp(
                      http,
                      PARALLEL_URL,
                      "web_search",
                      ParallelArgs,
                      {
                        objective: input.query,
                        search_queries: [input.query],
                        session_id: context.sessionID,
                        // V2 invocation context does not safely expose the model yet.
                      },
                      {
                        "User-Agent": `opencode/${InstallationVersion}`,
                        ...(config.parallelApiKey ? { Authorization: `Bearer ${config.parallelApiKey}` } : {}),
                      },
                    )
              return {
                provider,
                text: text ?? NO_RESULTS,
              }
            }).pipe(
              Effect.mapError((error) =>
                // 传输层的主权拒绝必须原话到模型面 —— 塌成 "Unable to search…" 会让模型当成
                // 瞬时故障反复重试。`#1449`:可辨的 WebSearchFailure 同样原话到模型面(类别 + HTTP
                // 状态/错误码 + 上游 body);这条通用消息只剩给超限/超时那类没有上游话可带的失败。
                error instanceof ToolFailure
                  ? error
                  : error instanceof WebSearchFailure
                    ? new ToolFailure({ message: error.message, error, metadata: { provider, kind: error.kind } })
                    : new ToolFailure({ message: `Unable to search the web for ${input.query}` }),
              ),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/websearch",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, LayerNodePlatform.httpClient, configNode],
})
