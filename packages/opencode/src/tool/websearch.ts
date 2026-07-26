import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolFailure } from "@opencode-ai/llm"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

/**
 * ADR-009 B1/B2 主权判决送进引擎进程的通道(#223 R2 Blocker 1)。
 *
 * main 的 `applyWebSearchSovereignty()`(`ui-mac/src/main/server.ts`)在**每次 fork 前**重算
 * kill-switch / 平台代付,置位或删除本变量;`ui-mac/src/main/sidecar-env.ts` 的白名单把它带进
 * sidecar。名字在两个包里各写一份(ui-mac 不依赖 opencode),漂移由
 * `ui-mac/src/main/cloud-web-search.test.ts` 的字面量锁钉住。
 */
export const LOCAL_WEBSEARCH_DENY_ENV = "ALPHA_LOCAL_WEBSEARCH_DENY"

/** fail-closed:除「缺省 / 空串 / `"0"`」外的任何取值都判为 deny。 */
export function localWebSearchDenied(env: Record<string, string | undefined> = process.env) {
  const value = env[LOCAL_WEBSEARCH_DENY_ENV]
  return value !== undefined && value !== "" && value !== "0"
}

/** 模型可见的拒绝理由。明说「别重试」,否则模型会把它当成瞬时故障反复调用。 */
export const LOCAL_WEBSEARCH_DENIED_MESSAGE =
  "Web search is unavailable: the local keyless websearch tool is denied by alpha sovereignty (ADR-009 B1/B2 — the platform pays for search, or the web search kill switch is set). This is not a transient failure; do not retry. Use cloud_web_search if it is present, otherwise answer without web search and say so."

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

export function selectWebSearchProvider(sessionID: string, flags = { exa: false, parallel: false }): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return override
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `opencode/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // #223 R2 Blocker 1:主权 deny 必须是**最终**规则。permission ruleset 里任何排在
          // 注入的全局 deny 之后的 allow 都能顶掉它,R2 的动态探针实测三条路径全部变 allow:
          //   ① agent 的 `"*": "allow"`(`agent/agent.ts` 把 agent 规则并在全局之后,
          //      `Permission.evaluate` 取 `findLast`);注入面只看得见 alpha 自己的 agent,
          //      别的 config 源后加载的 agent 压不平。
          //   ② `PromptInput.tools.websearch=true` 被**持久化**进 session permission
          //      (`session/prompt.ts` → `sessions.setPermission`),`session/tools.ts` 再把它
          //      并在 agent 规则之后,sidecar respawn 也带得回来。
          //   ③ `Permission.ask` 里的 `approved` 排在整个 ruleset 之后(`permission/index.ts`)。
          // 所以最终闸放在**工具自身**:它根本不查 ruleset,因而没有任何 permission 规则能覆盖。
          // 注入面的 permission deny 继续留着 —— 那层负责把工具从模型工具表里滤掉
          // (`tool/registry.ts` + `session/llm/request.ts` 的 `Permission.disabled`),
          // 是可用性(别让模型看见一个必失败的工具),不是主权保证。
          if (localWebSearchDenied())
            return yield* Effect.die(
              new ToolFailure({
                message: LOCAL_WEBSEARCH_DENIED_MESSAGE,
                metadata: { denied: "alpha-sovereignty", tool: "websearch" },
              }),
            )

          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
          })
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          // #489:失败一律 LOUD。旧写法是 `.pipe(Effect.orDie)` —— 一切错误塌成匿名 defect
          // (工具崩溃、无类别、无状态);这里把可辨的 WebSearchFailure 转成 canonical 的
          // ToolFailure 再 die,legacy 工具链跨 Promise 边界后两条消费路(AI SDK / native
          // adapter)都能把它当作模型可见的 tool error 结算,消息里带着类别 + 状态 + 上游 body。
          const result = yield* callProvider(http, provider, params, ctx).pipe(
            Effect.catch((failure) =>
              Effect.die(new ToolFailure({ message: failure.message, error: failure, metadata: { provider } })),
            ),
          )

          // 空结果不再伪装成成功串:callProvider 只在拿到真实结果时成功。
          return {
            output: result,
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }),
    }
  }),
)
