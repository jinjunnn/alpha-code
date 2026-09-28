// alpha-owned(ADR-035 §1):`alpha-code#1445` **重写后 AC** 的闸门 —— legacy 引擎那份本地搜网
//(`src/tool/mcp-websearch.ts` 传输 + `src/tool/websearch.ts` 叶子)。V2 core 那份同名同形:
// `packages/core/test/alpha-websearch-nokey-outcomes.test.ts`。
//
// 票面原 AC1(从响应里认出「限流提示被伪装成结果」)已用等价类论证判定不可满足
//(`docs/architecture/2026-09-24-exa-mcp-failure-signal-recon.md`《2026-09-26 补勘》),作废。重写后:
//   AC1 无 key 路径的每一种结局(429 限流 / 无契约信号的文本提示 / 真零命中)在**模型面**可区分,
//       「没搜到」与「没搜」不是同一句话;已知的坏 = 把那份 246 字节的提示当结果喂进去,用户面看不到
//       「我查了,没查到」。2026-09-27 先量后判:三种结局今天已可区分(实测记录在 PR),本文件只钉住它,
//       **不改生产判决**。
//   AC2 托管端行为漂移的绊线:每次响应记下信封的**结构字段**(不含正文),只记录、不判决;
//       对照臂 = 开关关闭时输出逐字节不变。
//   AC3 不引入文案匹配、不把致命前提押在无契约字段上:`_meta` 缺席即放行。
//
// 负载不是手写的,全部读库里的实抓件(夹具自检钉住,读空读歪即红):
//   C  `docs/verification/2026-09-24-1445-exa-mcp-response-shapes/results/arms.json` 的 nokey-search
//      (2026-09-24 实读 Exa 本体:429 + JSON-RPC -32000 + 四个限流头,43/43);
//   D  同目录 `ticket-payload.json`(`#1433` 走生产传输实抓的 246 字文本 + 生产代码反推的最小信封);
//   Z  `docs/verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/results/vendor-source-excerpts.txt`
//      里 exa-mcp-server 四个发行版逐字一致的零命中散文(期望值取自 vendor 源码,不取自被测代码);
//   A/P 同目录 `live-shapes.json`:2026-09-26 nokey Exa / keyless Parallel 的**原始** body(对照臂)。
//
// 「已知的坏 → 必须变红」(2026-09-27 变异实测,记录在 PR):把 parsePayload 改成「无 `_meta` 即零命中」
//(勘破点名过的假闸门形态)⇒ 8 红(AC1 的 D/Z 两臂、叶子 D/Z、AC3 三臂与普查);删掉 `call()` 里那行记录 ⇒ 6 红
// (AC2 四种负载的记录 + 对照臂 + AC3 的 `_meta` 臂);记录里带上正文 ⇒ 3 红;让记录参与判决(无 `_meta` 即拒)⇒ 10 红。

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  call,
  envelopeDiagEnabled,
  envelopeShape,
  SearchArgs,
  WEBSEARCH_ENVELOPE_DIAG_ENV,
  WebSearchFailure,
  type EnvelopeShape,
} from "../../src/tool/mcp-websearch"
import { WebSearchTool } from "../../src/tool/websearch"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Tool } from "../../src/tool/tool"
import * as Truncate from "../../src/tool/truncate"
import { ToolFailure } from "@opencode-ai/llm"

// ── 夹具 ──────────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SHAPES = join(ROOT, "docs", "verification", "2026-09-24-1445-exa-mcp-response-shapes", "results")
const LIVE = join(ROOT, "docs", "verification", "2026-09-26-1445-exa-vendor-source-and-live-shapes", "results")
const read = (path: string) => readFileSync(path, "utf8")

type Arm = {
  arm: string
  status: number
  contentType?: string | null
  jsonrpc: string
  jsonrpcErrorCode: number | null
  rateLimitHeaders: Record<string, string | null>
  textHead: string
}
type LiveRow = { arm: string; status: number; headers: Record<string, string>; body: string }

const ticket = JSON.parse(read(join(SHAPES, "ticket-payload.json"))) as {
  text: string
  minimalEnvelope: { result: Record<string, unknown> & { content: { type: string; text: string }[] } }
}
const arms = (JSON.parse(read(join(SHAPES, "arms.json"))) as { rows: Arm[] }).rows
const live = (JSON.parse(read(join(LIVE, "live-shapes.json"))) as { rows: LiveRow[] }).rows
const vendor = read(join(LIVE, "vendor-source-excerpts.txt"))

const D_TEXT = ticket.text
const rateLimited = arms.find((row) => row.arm === "nokey-search")!
const exaLive = live.find((row) => row.arm === "exa-nokey-search")!
const parallelLive = live.find((row) => row.arm === "parallel-keyless-search")!
const zeroHitLiterals = [...vendor.matchAll(/text:"(No search results found[^"]*)"/g)].map((m) => m[1]!)
const ZERO_TEXT = zeroHitLiterals[0]!

const rpc = (result: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: 1, result })
const sse = (frame: string) => `event: message\ndata: ${frame}\n\n`
const firstLine = (text: string) => text.split("\n")[0]!
const presentHeaders = (headers: Record<string, string | null>) =>
  Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))

type Wire = { status: number; headers: Record<string, string>; body: string }
const WIRE: Record<"C" | "D" | "Z" | "Z2" | "A" | "P", Wire> = {
  C: {
    status: rateLimited.status,
    headers: { "content-type": rateLimited.contentType ?? "application/json", ...presentHeaders(rateLimited.rateLimitHeaders) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: rateLimited.jsonrpcErrorCode, message: rateLimited.textHead } }),
  },
  D: { status: 200, headers: { "content-type": "text/event-stream" }, body: sse(JSON.stringify(ticket.minimalEnvelope)) },
  Z: { status: 200, headers: { "content-type": "text/event-stream" }, body: sse(rpc({ content: [{ type: "text", text: ZERO_TEXT }] })) },
  Z2: { status: 200, headers: { "content-type": "text/event-stream" }, body: sse(rpc({ content: [] })) },
  A: { status: exaLive.status, headers: exaLive.headers, body: exaLive.body },
  P: { status: parallelLive.status, headers: parallelLive.headers, body: parallelLive.body },
}
const NOKEY_OUTCOMES = ["C", "D", "Z", "Z2"] as const

/** 从 SSE body 里取第一帧 JSON(只给夹具自检与 `_meta` 摘除用,不是生产解析)。 */
function frameOf(body: string): Record<string, unknown> {
  const line = body.split("\n").find((l) => l.startsWith("data: "))!
  return JSON.parse(line.substring(6)) as Record<string, unknown>
}

const stub = (wire: Wire) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(wire.body, { status: wire.status, headers: wire.headers }))),
  )
const ARGS = { query: "alpha nokey outcomes", type: "auto", numResults: 8, livecrawl: "fallback" }
const transport = (wire: Wire) => call(stub(wire), "https://mcp.exa.ai/mcp", "web_search_exa", SearchArgs, ARGS, "5 seconds")
/** 不往测试输出里刷日志;AC2 的捕获用另一个 logger。 */
const quiet = Logger.layer([])

/** 模型面:成功 ⇒ 叶子把值原样放进 `output`(websearch.ts);失败 ⇒ `ToolFailure.message = failure.message`。 */
type Face = { kind: "output"; text: string } | { kind: "error"; message: string; failure: WebSearchFailure }
async function face(wire: Wire): Promise<Face> {
  const exit = await Effect.runPromiseExit(transport(wire).pipe(Effect.provide(quiet)))
  if (Exit.isSuccess(exit)) return { kind: "output", text: exit.value }
  const failure = Cause.squash(exit.cause)
  if (!(failure instanceof WebSearchFailure)) throw new Error(`not a WebSearchFailure: ${String(failure)}`)
  return { kind: "error", message: failure.message, failure }
}
const faceText = (result: Face) => (result.kind === "output" ? result.text : result.message)

const previousEnv = process.env[WEBSEARCH_ENVELOPE_DIAG_ENV]
afterEach(() => {
  if (previousEnv === undefined) delete process.env[WEBSEARCH_ENVELOPE_DIAG_ENV]
  else process.env[WEBSEARCH_ENVELOPE_DIAG_ENV] = previousEnv
})

describe("#1445 夹具自检:读到的就是库里那几份实抓件", () => {
  test("D:246 字逐字(字符数 = 字节数 = 246),最小信封无 isError / structuredContent / _meta", () => {
    expect(D_TEXT.length).toBe(246)
    expect(Buffer.byteLength(D_TEXT, "utf8")).toBe(246)
    expect(D_TEXT).toStartWith("You've hit Exa's free MCP rate limit")
    const result = ticket.minimalEnvelope.result
    expect(result.content[0]!.text).toBe(D_TEXT)
    expect("isError" in result).toBe(false)
    expect("structuredContent" in result).toBe(false)
    expect("_meta" in result.content[0]!).toBe(false)
  })

  test("C:429 + JSON-RPC error -32000 + 四个限流头都在", () => {
    expect(rateLimited.status).toBe(429)
    expect(rateLimited.jsonrpc).toBe("error")
    expect(rateLimited.jsonrpcErrorCode).toBe(-32000)
    expect(Object.keys(presentHeaders(rateLimited.rateLimitHeaders)).sort()).toEqual([
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ])
    expect(rateLimited.textHead).toStartWith("You've hit Exa's free MCP rate limit")
  })

  test("Z:vendor 源码里的零命中散文唯一且非空;它与 D 不是同一句话", () => {
    expect(zeroHitLiterals.length).toBeGreaterThanOrEqual(1)
    expect(new Set(zeroHitLiterals).size).toBe(1)
    expect(ZERO_TEXT).toStartWith("No search results found")
    expect(D_TEXT).not.toBe(ZERO_TEXT)
    expect(D_TEXT).not.toContain("No search results found")
  })

  test("A/P:今日真结果的原始 body —— Exa 带 content[0]._meta.searchTime,Parallel 带 isError:false + structuredContent + result._meta", () => {
    expect(exaLive.status).toBe(200)
    const exa = frameOf(exaLive.body).result as { content: { text: string; _meta?: Record<string, unknown> }[] }
    expect(typeof exa.content[0]!._meta?.searchTime).toBe("number")
    expect("isError" in exa).toBe(false)
    expect(parallelLive.status).toBe(200)
    const parallel = JSON.parse(parallelLive.body).result as Record<string, unknown>
    expect(parallel.isError).toBe(false)
    expect("structuredContent" in parallel).toBe(true)
    expect(Object.keys(parallel._meta as object)).toEqual(["parallel/usage"])
  })
})

// ── AC1(传输半场):三种无 key 结局在模型面可区分 ─────────────────────────────
describe("#1445 AC1 传输:无 key 路径的每一种结局在模型面各是一句不同的话", () => {
  test("C 429 限流 ⇒ 具名失败:类别 + HTTP 429 + 上游原文,不是「没搜到」", async () => {
    const result = await face(WIRE.C)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.failure.kind).toBe("unexpected_status")
    expect(result.failure.status).toBe(429)
    expect(result.message).toContain("Web search failed")
    expect(result.message).toContain("HTTP 429")
    expect(result.message).toContain(firstLine(rateLimited.textHead))
    expect(result.message).not.toContain(ZERO_TEXT)
  })

  test("D 无契约信号的提示 ⇒ vendor 原文逐字到模型面(不静默降级、不改写成「没搜到」)", async () => {
    const result = await face(WIRE.D)
    expect(result.kind).toBe("output")
    expect(faceText(result)).toBe(D_TEXT)
    expect(faceText(result)).not.toBe(ZERO_TEXT)
    expect(faceText(result)).not.toContain("No search results found")
    expect(faceText(result)).not.toContain("no usable result")
  })

  test("Z 真零命中(vendor 散文)⇒ 原文到模型面", async () => {
    const result = await face(WIRE.Z)
    expect(result.kind).toBe("output")
    expect(faceText(result)).toBe(ZERO_TEXT)
  })

  test("Z2 真零命中(content: [])⇒ empty_result 具名失败,带原 body(#489:不编造成功串)", async () => {
    const result = await face(WIRE.Z2)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.failure.kind).toBe("empty_result")
    expect(result.message).not.toContain("No search results found")
  })

  test("四种结局两两不同;「没搜到」(Z / Z2)与「没搜」(D / C)不是同一句话", async () => {
    const faces = await Promise.all(NOKEY_OUTCOMES.map((key) => face(WIRE[key])))
    const texts = faces.map(faceText)
    expect(new Set(texts).size).toBe(NOKEY_OUTCOMES.length)
    const [c, d, z] = texts as [string, string, string, string]
    expect(d).not.toBe(z)
    expect(c).not.toBe(z)
    expect(d).not.toContain(ZERO_TEXT)
    expect(c).not.toContain(ZERO_TEXT)
  })
})

// ── AC1(叶子半场):真 `Tool.init → execute`,模型拿到的 output / ToolFailure ──────
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

/** 与 `session/tools.ts` 同一入口;permission 一律放行(主权闸与 ruleset 归 alpha-websearch-failure.test.ts)。 */
async function leaf(wire: Wire) {
  const program = Effect.gen(function* () {
    const def = yield* Tool.init(yield* WebSearchTool)
    return yield* def.execute(
      { query: ARGS.query },
      {
        sessionID: "ses_nokey_outcomes" as never,
        messageID: "msg_nokey_outcomes" as never,
        agent: stubAgent.name,
        abort: new AbortController().signal,
        callID: "call_1",
        extra: {},
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
  }).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: Cause.squash(cause) })),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, stub(wire)),
        RuntimeFlags.Service.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_ENABLE_EXA: "1" }))),
          Layer.orDie,
        ),
        truncateStub,
        agentStub,
        quiet,
      ),
    ),
  )
  return Effect.runPromise(program)
}

describe("#1445 AC1 叶子:模型面拿到的 output / ToolFailure 与传输半场一致", () => {
  test("D ⇒ output 就是那 246 字(vendor 自己的话,模型看得见「rate limit」)", async () => {
    const run = await leaf(WIRE.D)
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.value.output).toBe(D_TEXT)
    expect(run.value.metadata).toMatchObject({ provider: "exa" })
  })

  test("C ⇒ ToolFailure,消息带 HTTP 429 与上游原文", async () => {
    const run = await leaf(WIRE.C)
    expect(run.ok).toBe(false)
    if (run.ok) return
    expect(run.error).toBeInstanceOf(ToolFailure)
    const message = (run.error as ToolFailure).message
    expect(message).toContain("HTTP 429")
    expect(message).toContain(firstLine(rateLimited.textHead))
    expect(message).not.toContain(ZERO_TEXT)
  })

  test("Z ⇒ output 是 vendor 的零命中散文;与 D 的 output 不是同一句话", async () => {
    const run = await leaf(WIRE.Z)
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.value.output).toBe(ZERO_TEXT)
    expect(run.value.output).not.toBe(D_TEXT)
  })
})

// ── AC2:只记录、不判决 ──────────────────────────────────────────────────────
const MARKER = "websearch envelope"
function capturing() {
  const records: EnvelopeShape[] = []
  const logger = Logger.make((options) => {
    const message = options.message
    if (Array.isArray(message) && message[0] === MARKER) records.push(message[1] as EnvelopeShape)
  })
  return { records, layer: Logger.layer([logger]) }
}
async function withDiag(wire: Wire, enabled: boolean) {
  if (enabled) delete process.env[WEBSEARCH_ENVELOPE_DIAG_ENV]
  else process.env[WEBSEARCH_ENVELOPE_DIAG_ENV] = "0"
  const capture = capturing()
  const exit = await Effect.runPromiseExit(transport(wire).pipe(Effect.provide(capture.layer)))
  return { exit, records: capture.records }
}
const ALL_ABSENT = {
  "retry-after": "absent",
  "x-ratelimit-limit": "absent",
  "x-ratelimit-remaining": "absent",
  "x-ratelimit-reset": "absent",
} as const
/** 记录里不许出现正文:拿每份负载正文开头 24 字与几个只在正文里才有的字样去撞。 */
function expectNoBodyText(record: EnvelopeShape, bodyText: string, ...needles: string[]) {
  const serialized = JSON.stringify(record)
  expect(serialized).not.toContain(bodyText.slice(0, 24))
  for (const needle of needles) expect(serialized).not.toContain(needle)
}

describe("#1445 AC2 记录:信封的结构字段进日志,正文不进", () => {
  test("开关缺省开着(绊线预先拉上);只有 \"0\" 关得掉", () => {
    expect(envelopeDiagEnabled({})).toBe(true)
    expect(envelopeDiagEnabled({ [WEBSEARCH_ENVELOPE_DIAG_ENV]: "1" })).toBe(true)
    expect(envelopeDiagEnabled({ [WEBSEARCH_ENVELOPE_DIAG_ENV]: "" })).toBe(true)
    expect(envelopeDiagEnabled({ [WEBSEARCH_ENVELOPE_DIAG_ENV]: "0" })).toBe(false)
  })

  test("D:该有的字段都在 —— 契约信号全 absent、无 _meta、textLength 246、无限流头;不含正文", async () => {
    const { records } = await withDiag(WIRE.D, true)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      tool: "web_search_exa",
      status: 200,
      jsonrpc: "result",
      isError: "absent",
      structuredContent: "absent",
      contentBlocks: 1,
      contentMetaKeys: "absent",
      resultMetaKeys: "absent",
      textLength: 246,
      rateLimit: ALL_ABSENT,
    })
    expectNoBodyText(records[0]!, D_TEXT, "rate limit", "exa.ai")
  })

  test("C:429 的四个限流头逐字记下,jsonrpc=error;不含正文", async () => {
    const { records } = await withDiag(WIRE.C, true)
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe(429)
    expect(records[0]!.jsonrpc).toBe("error")
    expect(records[0]!.contentBlocks).toBe("absent")
    expect(records[0]!.rateLimit).toEqual(presentHeaders(rateLimited.rateLimitHeaders) as EnvelopeShape["rateLimit"])
    expectNoBodyText(records[0]!, rateLimited.textHead, "rate limit")
  })

  test("A:今日 Exa 真结果记下 content[0]._meta 的键名 [searchTime];不含正文", async () => {
    const { records } = await withDiag(WIRE.A, true)
    expect(records).toHaveLength(1)
    const text = (frameOf(exaLive.body).result as { content: { text: string }[] }).content[0]!.text
    expect(records[0]).toMatchObject({
      status: 200,
      jsonrpc: "result",
      isError: "absent",
      structuredContent: "absent",
      contentBlocks: 1,
      contentMetaKeys: ["searchTime"],
      resultMetaKeys: "absent",
      textLength: text.length,
      rateLimit: ALL_ABSENT,
    })
    expectNoBodyText(records[0]!, text, "Title:", "developer.mozilla.org")
  })

  test("P:今日 Parallel 真结果记下 isError:false、structuredContent present、result._meta 键名 [parallel/usage];不含正文", async () => {
    const { records } = await withDiag(WIRE.P, true)
    expect(records).toHaveLength(1)
    const text = (JSON.parse(parallelLive.body).result as { content: { text: string }[] }).content[0]!.text
    expect(records[0]).toMatchObject({
      status: 200,
      jsonrpc: "result",
      isError: false,
      structuredContent: "present",
      contentBlocks: 1,
      contentMetaKeys: "absent",
      resultMetaKeys: ["parallel/usage"],
      textLength: text.length,
    })
    expectNoBodyText(records[0]!, text, "search_id")
  })

  test("对照臂:开关关闭 ⇒ 零记录,且六种负载的模型面输出逐字节不变(含失败的类别与消息)", async () => {
    for (const key of ["C", "D", "Z", "Z2", "A", "P"] as const) {
      const on = await withDiag(WIRE[key], true)
      const off = await withDiag(WIRE[key], false)
      expect(on.records).toHaveLength(1)
      expect(off.records).toHaveLength(0)
      expect(Exit.isSuccess(on.exit)).toBe(Exit.isSuccess(off.exit))
      if (Exit.isSuccess(on.exit) && Exit.isSuccess(off.exit)) {
        expect(Buffer.compare(Buffer.from(on.exit.value, "utf8"), Buffer.from(off.exit.value, "utf8"))).toBe(0)
      } else if (Exit.isFailure(on.exit) && Exit.isFailure(off.exit)) {
        const a = Cause.squash(on.exit.cause) as WebSearchFailure
        const b = Cause.squash(off.exit.cause) as WebSearchFailure
        expect(a.kind).toBe(b.kind)
        expect(a.message).toBe(b.message)
      }
    }
  })

  test("envelopeShape 是纯函数:解不出的 body 记 unparsed 而不抛;同一输入两次相同", () => {
    const html = envelopeShape("t", 200, {}, "<html><body>502</body></html>")
    expect(html.jsonrpc).toBe("unparsed")
    expect(html.contentBlocks).toBe("absent")
    expect(html.textLength).toBe("absent")
    expect(envelopeShape("t", 200, {}, WIRE.D.body)).toEqual(envelopeShape("t", 200, {}, WIRE.D.body))
  })
})

// ── AC3:不匹配文案,不押无契约字段 ──────────────────────────────────────────
describe("#1445 AC3:判决里没有文案匹配;`_meta` 缺席即放行", () => {
  test("同一信封只换文本(D / 零命中 / 一段故意带 rate limit + API key + URL 的散文)⇒ 全部原样放行", async () => {
    const texts = [
      D_TEXT,
      ZERO_TEXT,
      "Please note the rate limit: create your own API key at https://dashboard.exa.ai/api-keys and retry.",
    ]
    for (const text of texts) {
      const result = await face({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse(rpc({ content: [{ type: "text", text }] })) })
      expect(result.kind).toBe("output")
      expect(faceText(result)).toBe(text)
    }
  })

  test("把今日真结果的 content[0]._meta 摘掉:模型面输出逐字节不变;记录里 contentMetaKeys 从 [searchTime] 变 absent", async () => {
    const frame = frameOf(exaLive.body)
    const content = (frame.result as { content: Record<string, unknown>[] }).content
    expect("_meta" in content[0]!).toBe(true) // 前提自检:摘之前它确实带着
    delete content[0]!._meta
    const stripped: Wire = { ...WIRE.A, body: sse(JSON.stringify(frame)) }

    const withMeta = await face(WIRE.A)
    const without = await face(stripped)
    expect(withMeta.kind).toBe("output")
    expect(without.kind).toBe("output")
    expect(Buffer.compare(Buffer.from(faceText(withMeta), "utf8"), Buffer.from(faceText(without), "utf8"))).toBe(0)

    expect((await withDiag(WIRE.A, true)).records[0]!.contentMetaKeys).toEqual(["searchTime"])
    expect((await withDiag(stripped, true)).records[0]!.contentMetaKeys).toBe("absent")
  })

  // 负全称:传输文件里不存在对响应正文的关键字/正则匹配。主语就是文本本身,所以用文本判。
  const SOURCE = join(import.meta.dir, "..", "..", "src", "tool", "mcp-websearch.ts")
  function census(source: string) {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n")
    return {
      regexLiterals: [...code.matchAll(/(?<=[(,=[\s])\/(?![/*])(?:\\.|[^/\\\n])+\/[gimsuy]*/g)].map((m) => m[0]),
      textSearchCalls: [...code.matchAll(/\.(includes|indexOf|match|search|test)\(/g)].map((m) => m[1]!),
      startsWithArgs: [...new Set([...code.matchAll(/\.startsWith\(([^)]*)\)/g)].map((m) => m[1]!))].sort(),
      regExpCtor: (code.match(/\bRegExp\b/g) ?? []).length,
    }
  }

  test("源码普查:mcp-websearch.ts 里唯一的正则是 detailOf 的空白折叠,没有 includes/indexOf/match/search/test,startsWith 只认 JSON 与 SSE 框架", () => {
    const result = census(read(SOURCE))
    expect(result.regexLiterals).toEqual(["/\\s+/g"])
    expect(result.textSearchCalls).toEqual([])
    expect(result.startsWithArgs).toEqual(['"data: "', '"{"'])
    expect(result.regExpCtor).toBe(0)
  })

  test("普查自检:往源码里塞一行关键字匹配,普查必须抓到(否则上一条是空对空)", () => {
    const poisoned = `${read(SOURCE)}\nif (text.includes("rate limit") || /API key/i.test(text)) return undefined\n`
    const result = census(poisoned)
    expect(result.regexLiterals).toEqual(["/\\s+/g", "/API key/i"])
    expect(result.textSearchCalls).toEqual(["includes", "test"])
  })
})
