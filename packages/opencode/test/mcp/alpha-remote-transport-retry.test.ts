// #1547:远程连接器的 StreamableHTTP 尝试遇到传输类错误时先重试,再改用 SSE;全部失败时报真实原因。
//
// 现场(0.1.21,「cloud」连接器):StreamableHTTP 卡在 TLS 握手、被 undici 10s 连接超时切断,引擎
// 只试一次就改用 SSE,服务端对 GET 回 405(Streamable HTTP 规范允许)⇒ 用户只看到
// `SSE error: Non-200 status code (405)`,真正的原因被覆盖,也不会自己再连。
//
// 本文件经**生产入口** `MCP.Service.add` 跑 `src/mcp/index.ts` 的传输循环本体:替换全局 fetch
// (两种 SDK transport 在没传 `fetch` 选项时都用它),POST 按脚本抛错,其余请求交给一个真的
// MCP server(WebStandardStreamableHTTPServerTransport)处理,GET 一律 405 —— 与线上服务端同形。
//
// 注入的错误形状取自真实样本(编排器诊断 harness,Node 22 / undici,SDK 1.29.0,2026-10-27,
// 经同形 CONNECT 代理连 alpha-cloud.tidelabs.click):
//   TypeError: fetch failed <- ConnectTimeoutError/UND_ERR_CONNECT_TIMEOUT:
//   Connect Timeout Error (attempted address: alpha-cloud.tidelabs.click:443, timeout: 10000ms)
// 引擎在 Electron utilityProcess(Node)里跑,所以线上的 fetch 就是 undici。

import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

const URL_ = "http://alpha-transport-retry.invalid/mcp"
const CONNECT_TIMEOUT_TEXT =
  "Connect Timeout Error (attempted address: alpha-cloud.tidelabs.click:443, timeout: 10000ms)"

function undiciConnectTimeout() {
  const cause = Object.assign(new Error(CONNECT_TIMEOUT_TEXT), {
    name: "ConnectTimeoutError",
    code: "UND_ERR_CONNECT_TIMEOUT",
  })
  return new TypeError("fetch failed", { cause })
}

// 与生产「cloud」注入同形:remote + 静态 Authorization 头 + oauth:false(cloud-sidecar-config.ts)。
const cloud = { type: "remote" as const, url: URL_, oauth: false as const, headers: { Authorization: "Bearer t" } }

/** 替换全局 fetch:前 `failPosts` 个 POST 按 `post` 处理,其余交给真 MCP server;GET 恒 405。 */
function injectFetch(
  failPosts: number,
  post: () => Response = () => {
    throw undiciConnectTimeout()
  },
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "retry-stand-in", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({ tools: [{ name: "probe", inputSchema: { type: "object" as const, properties: {} } }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const original = globalThis.fetch
      const methods: string[] = []
      let failed = 0
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (!request.url.startsWith(URL_)) return original(input, init)
        methods.push(request.method)
        if (request.method === "GET") return new Response(null, { status: 405 })
        if (request.method === "POST" && failed < failPosts) {
          failed++
          return post()
        }
        return transport.handleRequest(request)
      }) as typeof fetch
      return { methods, protocol, original }
    }),
    (s) =>
      Effect.promise(async () => {
        globalThis.fetch = s.original
        await s.protocol.close().catch(() => {})
      }),
  )
}

const posts = (methods: string[]) => methods.filter((m) => m === "POST").length

it.instance("AC1: a transport error on the first StreamableHTTP attempt is retried and ends connected", () =>
  Effect.gen(function* () {
    const net = yield* injectFetch(1)
    const mcp = yield* MCP.Service
    yield* mcp.add("cloud", cloud)

    expect((yield* mcp.status()).cloud).toEqual({ status: "connected" })
    expect(Object.keys(yield* mcp.tools())).toEqual(["cloud_probe"])
    // 第一次 POST 被切断,第二次(新 transport)完成握手;从未落到 SSE。
    expect(net.methods[0]).toBe("POST")
    expect(posts(net.methods)).toBeGreaterThanOrEqual(2)
  }),
)

it.instance("AC2: when every attempt fails the status carries the StreamableHTTP cause, not the SSE 405", () =>
  Effect.gen(function* () {
    const net = yield* injectFetch(Number.POSITIVE_INFINITY)
    const mcp = yield* MCP.Service
    yield* mcp.add("cloud", cloud)

    const status = (yield* mcp.status()).cloud
    expect(status?.status).toBe("failed")
    const error = status?.status === "failed" ? status.error : ""
    expect(error).toContain(CONNECT_TIMEOUT_TEXT)
    expect(error).not.toContain("405")
    // 首次 + 至少 2 次重试,之后才改用 SSE(GET)。
    expect(posts(net.methods)).toBe(3)
    expect(net.methods.indexOf("GET")).toBe(3)
  }),
)

it.instance("an HTTP status from the server is not a transport error and is not retried", () =>
  Effect.gen(function* () {
    const net = yield* injectFetch(Number.POSITIVE_INFINITY, () => new Response("nope", { status: 404 }))
    const mcp = yield* MCP.Service
    yield* mcp.add("cloud", cloud)

    expect((yield* mcp.status()).cloud?.status).toBe("failed")
    expect(posts(net.methods)).toBe(1)
  }),
)
