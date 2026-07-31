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

/** 模型可见的拒绝理由。明说「别重试」,否则模型会把它当成瞬时故障反复调用。 */
export const LOCAL_WEBSEARCH_DENIED_MESSAGE =
  "Web search is unavailable: the local keyless websearch tool is denied by alpha sovereignty (ADR-009 B1/B2 — the platform pays for search, or the web search kill switch is set). This is not a transient failure; do not retry. Use cloud_cloud_web_search if it is present, otherwise answer without web search and say so."

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

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  }),
})
const decodeMcpResult = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    return (yield* decodeMcpResult(trimmed)).result.content.find((item) => item.text)?.text
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
      const response = yield* HttpClient.filterStatusOk(http).execute(request)
      const body = yield* collectBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new Error(`${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes`),
      )
      return yield* parseResponse(body.toString("utf8"))
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
                // 瞬时故障反复重试(这条通用消息本身保留给真正的搜索失败)。
                error instanceof ToolFailure
                  ? error
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
