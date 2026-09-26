// alpha-owned(`#1449`;alpha 自有由文件名的 `alpha-` 前缀声明):V2 Core 那份 `websearch` 副本的
// 「失败诚实」闸门 —— 与 legacy 那份的 `packages/opencode/test/tool/alpha-websearch-failure.test.ts` 同名同形。
//
// 缺陷:`packages/core/src/tool/websearch.ts` 认不出失败。`isError:true` 的 MCP 响应正常解码、Exa 的
// 401 原文被当搜索结果交给模型;非 2xx 被 `filterStatusOk` 压成一句通用文案;读不出内容一律换成
// 编造的 NO_RESULTS。两份实现里只有 opencode 那份收口了(`#489`/`#223`)。
//
// 负载不是手写的。AC1/AC2 直接读
// `docs/verification/2026-09-24-1445-exa-mcp-response-shapes/results/arms.json`
//(2026-09-24 打 `https://mcp.exa.ai/mcp` 本体量到的判据字段),按探针记录的 envelope 字段重建最小 envelope:
//   · B 臂(in-band 错误 ×3):HTTP 200 `text/event-stream`、JSON-RPC `result`、`isError:true`、
//     `content[0]` 只有 type/text;
//   · C 臂(免费额度用尽):HTTP 429 `application/json`、JSON-RPC `error` `-32000`。
// `textHead` 是探针截到 260 字的文本头,重建时原样用它(不补全、不改写)。夹具自检钉住臂的数量与
// 判据字段 —— 读空了、读歪了都要红,否则下面每条断言都是空对空。
//
// 「已知的坏 → 必须变红」:本文件在改动前的 websearch.ts 上跑,AC1/AC2 与 AC3 的失败臂全部红,
// AC3 的零结果臂改前改后都绿 —— 这条闸的分辨力在失败臂,不在成功臂(实测记录在 PR)。
//
// 不在本文件判的:`#1445` 那种 2xx + `result` + 非 `isError` 的纯文本额度提示
//(`results/ticket-payload.json`)—— 没有可消费的结构化信号,票面 out-of-scope,按关键字猜是
// 「手写别人文法的替身」。

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool } from "./lib/tool"

// ── 夹具:2026-09-24 实读 Exa MCP 本体的判据字段 ─────────────────────────────────
type Arm = {
  arm: string
  status: number
  contentType?: string | null
  jsonrpc: string
  jsonrpcErrorCode: number | null
  isError: boolean | null
  contentBlocks: { type: string; keys: string[] }[]
  textHead: string
}
const SHAPES = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "verification",
  "2026-09-24-1445-exa-mcp-response-shapes",
  "results",
)
const arms = (JSON.parse(readFileSync(join(SHAPES, "arms.json"), "utf8")) as { rows: Arm[] }).rows
const inband = arms.filter((row) => row.isError === true)
const rateLimited = arms.find((row) => row.arm === "nokey-search")

/** JSON-RPC `result` envelope(与两份生产传输发出的请求同一 id)。 */
const rpc = (result: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: 1, result })
/** B 臂重建:探针记录 `jsonrpc=result`、`isError=true`、`content[0].keys=[type,text]`。 */
const inbandBody = (row: Arm) => rpc({ content: [{ type: "text", text: row.textHead }], isError: true })
/** C 臂重建:探针记录 `jsonrpc=error`、`jsonrpcErrorCode=-32000`、`textHead` 取自 `error.message`。 */
const rateLimitBody = (row: Arm) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: row.jsonrpcErrorCode, message: row.textHead } })
/** Exa 成功与 in-band 错误都以 `text/event-stream` 交付(A 臂 27/27、B 臂 4/4)。 */
const sse = (frame: string) => `event: message\ndata: ${frame}\n\n`
const firstLine = (text: string) => text.split("\n")[0]!

const failureOf = (body: string) => Effect.runPromise(Effect.flip(WebSearchTool.parseResponse(body)))

describe("#1449 夹具自检:arms.json 读到的就是 2026-09-24 实读的那几种形状", () => {
  test("B 臂:三条 in-band 错误,全部 200 / result / isError:true / content[0] 只有 type,text", () => {
    expect(inband.map((row) => row.arm)).toEqual(["inband-invalid-key", "inband-unknown-tool", "inband-invalid-args"])
    for (const row of inband) {
      expect(row.status).toBe(200)
      expect(row.jsonrpc).toBe("result")
      expect(row.contentBlocks[0]?.keys).toEqual(["type", "text"])
      expect(row.textHead.trim()).not.toBe("")
    }
  })

  test("C 臂:免费额度用尽 = 429 + JSON-RPC error -32000,文案是那句「去申请自己的 key」", () => {
    expect(rateLimited).toBeDefined()
    expect(rateLimited!.status).toBe(429)
    expect(rateLimited!.jsonrpc).toBe("error")
    expect(rateLimited!.jsonrpcErrorCode).toBe(-32000)
    expect(rateLimited!.textHead).toStartWith("You've hit Exa's free MCP rate limit")
  })
})

// ── AC1(parser 半场):isError:true 是具名失败,不是搜索结果 ─────────────────────
describe("#1449 AC1 parser:Exa in-band 错误(isError:true)⇒ provider_error,原文进 cause", () => {
  for (const row of inband) {
    test(`${row.arm}:SSE 帧 ⇒ WebSearchFailure(provider_error),不是结果串、不是 NO_RESULTS`, async () => {
      const failure = await failureOf(sse(inbandBody(row)))
      expect(failure).toBeInstanceOf(WebSearchTool.WebSearchFailure)
      expect(failure.kind).toBe("provider_error")
      expect(failure.message).toContain("the provider reported an error")
      expect(failure.message).toContain(firstLine(row.textHead))
      expect(failure.message).not.toContain(WebSearchTool.NO_RESULTS)
    })
  }

  test("直接 JSON(非 SSE 帧)同判", async () => {
    const failure = await failureOf(inbandBody(inband[0]!))
    expect(failure.kind).toBe("provider_error")
    expect(failure.message).toContain(firstLine(inband[0]!.textHead))
  })

  test("isError:true 但没有文本:仍是失败,不是零结果", async () => {
    const failure = await failureOf(rpc({ content: [], isError: true }))
    expect(failure.kind).toBe("provider_error")
    expect(failure.message).toContain("without details")
  })
})

// ── 票面开头那种「{"error":{…}} 原文当结果」与坏响应 ────────────────────────────
describe("#1449 parser:200 + 未置 isError 的结构化 error,与解不出的负载", () => {
  test("文本本身是 {error:{message,code}} ⇒ provider_error,code 进模型面", async () => {
    const failure = await failureOf(
      rpc({ content: [{ type: "text", text: JSON.stringify({ error: { message: "quota rejected", code: "quota" } }) }] }),
    )
    expect(failure.kind).toBe("provider_error")
    expect(failure.code).toBe("quota")
    expect(failure.message).toContain("quota rejected")
    expect(failure.message).toContain("(quota)")
  })

  test("structuredContent 里的 {error:…} 同判", async () => {
    const failure = await failureOf(rpc({ content: [], structuredContent: { error: { message: "no budget" } } }))
    expect(failure.kind).toBe("provider_error")
    expect(failure.message).toContain("no budget")
  })

  test("解不出 McpResult 的负载 ⇒ invalid_response,原 body 附上", async () => {
    const failure = await failureOf('{"jsonrpc":"2.0","id":1,"result":{"content":"nope"}}')
    expect(failure.kind).toBe("invalid_response")
    expect(failure.message).toContain('"content":"nope"')
  })
})

// ── AC3(parser 半场):「没有结果」与「搜索失败」可区分 ─────────────────────────
describe("#1449 AC3 parser:真的零结果仍是 undefined(叶子换成 NO_RESULTS),不是失败", () => {
  const zeroHits = [
    ["content 为空", rpc({ content: [] })],
    ["content 为空 + structuredContent.results 明确为空数组", rpc({ content: [], structuredContent: { results: [] } })],
    ["只有空白文本", rpc({ content: [{ type: "text", text: "  " }] })],
  ] as const

  for (const [name, body] of zeroHits) {
    test(`零结果(${name})⇒ undefined`, async () => {
      expect(await Effect.runPromise(WebSearchTool.parseResponse(body))).toBeUndefined()
      expect(await Effect.runPromise(WebSearchTool.parseResponse(sse(body)))).toBeUndefined()
    })
  }

  test("同一判据:失败负载 ⇒ Failure;换成零结果负载 ⇒ Success(已知的坏 → 红)", async () => {
    const bad = await Effect.runPromiseExit(WebSearchTool.parseResponse(sse(inbandBody(inband[0]!))))
    const zero = await Effect.runPromiseExit(WebSearchTool.parseResponse(sse(rpc({ content: [] }))))
    expect(Exit.isFailure(bad)).toBe(true)
    expect(Exit.isSuccess(zero)).toBe(true)
  })
})

// ── 模型面:真实 ToolRegistry.materialize → settle 链路 ───────────────────────────
const sessionID = SessionV2.ID.make("ses_alpha_websearch_failure")
const requests: string[] = []
const liveResults = () => new Response(rpc({ content: [{ type: "text", text: "live results" }] }), { status: 200 })
let respond: () => Response = liveResults

afterEach(() => {
  requests.length = 0
  respond = liveResults
})

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url)
      return HttpClientResponse.fromWeb(request, respond())
    }),
  ),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const websearchConfig = Layer.succeed(
  WebSearchTool.ConfigService,
  WebSearchTool.ConfigService.of({ provider: "exa", enableExa: true, enableParallel: false }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebSearchTool.configNode, WebSearchTool.node]),
    [
      [PermissionV2.node, permission],
      [LayerNodePlatform.httpClient, http],
      [WebSearchTool.configNode, websearchConfig],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)
const call = (id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "websearch", input: { query: "alpha failure honesty" } },
})
/** 模型面的 error 正文;不是 error 就红,不让「结果串恰好包含某词」混过去。 */
const errorValue = (settled: { result: { type: string; value: unknown } }) => {
  expect(settled.result.type).toBe("error")
  return String(settled.result.value)
}

describe("#1449 模型面:失败以具名 error 到达,零结果仍是 NO_RESULTS,两者可区分", () => {
  it.effect("基线:这条链是活的(200 + 结果文本 ⇒ text)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call("live"))
      expect(settled.result).toEqual({ type: "text", value: "live results" })
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("AC1:HTTP 200 SSE + isError:true ⇒ 具名 error(不是结果、不是 NO_RESULTS、不是通用文案)", () =>
    Effect.gen(function* () {
      const row = inband[0]!
      respond = () =>
        new Response(sse(inbandBody(row)), { status: 200, headers: { "content-type": "text/event-stream" } })
      const registry = yield* ToolRegistry.Service
      const value = errorValue(yield* settleTool(registry, call("ac1-inband")))
      expect(value).toContain("Web search failed: the provider reported an error")
      expect(value).toContain(firstLine(row.textHead))
      expect(value).not.toBe(WebSearchTool.NO_RESULTS)
      expect(value).not.toContain("Unable to search the web")
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("AC2:HTTP 429 + JSON-RPC error -32000(免费额度用尽)⇒ 具名 error,带 HTTP 429 与上游原文", () =>
    Effect.gen(function* () {
      const row = rateLimited!
      respond = () =>
        new Response(rateLimitBody(row), { status: row.status, headers: { "content-type": "application/json" } })
      const registry = yield* ToolRegistry.Service
      const value = errorValue(yield* settleTool(registry, call("ac2-429")))
      expect(value).toContain("Web search failed: unexpected HTTP status (HTTP 429)")
      expect(value).toContain(firstLine(row.textHead))
      expect(value).not.toBe(WebSearchTool.NO_RESULTS)
      expect(value).not.toContain("Unable to search the web")
    }),
  )

  const statuses = [
    [401, { error: { message: "unauthorized" } }, "unauthorized"],
    [403, { error: { message: "forbidden", code: "action_forbidden" } }, "forbidden (HTTP 403 action_forbidden)"],
    [400, { error: { message: "query required" } }, "bad request"],
    [402, { error: { message: "no budget" } }, "payment required (out of budget)"],
    [502, { error: { message: "no search backend configured" } }, "upstream failure"],
    [503, { error: { message: "BILLING_UNREADY" } }, "unexpected HTTP status"],
  ] as const

  for (const [status, body, label] of statuses) {
    it.effect(`AC2 矩阵:HTTP ${status} ⇒ 「${label}」+ 上游 body,不被压成通用文案`, () =>
      Effect.gen(function* () {
        respond = () => Response.json(body, { status })
        const registry = yield* ToolRegistry.Service
        const value = errorValue(yield* settleTool(registry, call(`ac2-${status}`)))
        expect(value).toContain(label)
        expect(value).toContain(`HTTP ${status}`)
        expect(value).toContain(body.error.message)
        expect(value).not.toContain("Unable to search the web")
      }),
    )
  }

  it.effect("AC2:每个状态类别在模型面互不相同(不是六种输入一句话)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const messages: string[] = []
      for (const [status, body] of statuses) {
        respond = () => Response.json(body, { status })
        messages.push(errorValue(yield* settleTool(registry, call(`ac2-distinct-${status}`))))
      }
      expect(new Set(messages).size).toBe(statuses.length)
    }),
  )

  it.effect("AC3:真的零结果 ⇒ NO_RESULTS 正文;同一条链换成失败负载 ⇒ error(模型面可区分)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      respond = () => new Response(sse(rpc({ content: [] })), { status: 200 })
      const zero = yield* settleTool(registry, call("ac3-zero"))
      expect(zero.result).toEqual({ type: "text", value: WebSearchTool.NO_RESULTS })

      respond = () => new Response(sse(inbandBody(inband[1]!)), { status: 200 })
      const value = errorValue(yield* settleTool(registry, call("ac3-bad")))
      expect(value).not.toBe(WebSearchTool.NO_RESULTS)
      expect(value).toContain(firstLine(inband[1]!.textHead))
    }),
  )

  it.effect("200 + 文本是 {error:{message}} ⇒ error 带 message(票面开头那种「原文当结果」)", () =>
    Effect.gen(function* () {
      respond = () =>
        new Response(rpc({ content: [{ type: "text", text: JSON.stringify({ error: { message: "key expired" } }) }] }), {
          status: 200,
        })
      const registry = yield* ToolRegistry.Service
      const value = errorValue(yield* settleTool(registry, call("structured-error")))
      expect(value).toContain("key expired")
      expect(value).not.toContain('{"error"')
    }),
  )
})
