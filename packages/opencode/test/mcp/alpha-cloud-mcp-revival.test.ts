// #223 R5 Major —— 「`enabled:false` 不是不可重开」的反向回归。
//
// R4 把 kill-switch 下的云 MCP server 写成 `{...完整定义, enabled:false}`,并声称它 disarmed、
// 只有 @alpha-code/ext 的 `config` 钩子能把它打开。R5 勘破那是**回归**:
//
//   `MCP.connect()`(`src/mcp/index.ts`)= `createAndStore(name, { ...mcp, enabled: true })`
//   —— **无条件**把配置复制成 enabled:true,不看任何主权信号;
//   该能力还公开为 `POST /mcp/:name/connect`(`httpapi/handlers/mcp.ts`),产品 UI 真的在调。
//
// 于是 ext 缺席(OPENCODE_PURE / bundle import 失败 / 插件初始化抛错)时,用户点一下就能把那份
// **含完整 URL 与 Authorization header** 的 server 热连起来,而此时 `tool.execute.before` 闸并不
// 存在。R3 那版(ext 路径缺席就整个不注册)反而没有这条路径。
//
// 本文件用**真实的** streamable-HTTP MCP server + **真实的** HttpApi 路由跑两条复活路径,断言
// R5 形态(定义根本不进配置)下它们都打不开,且远端零请求。第一条是**正向对照**:R4 那个形态
// 真的能被热连 —— 没有它,后面几条可能只是「测试构造得不对」。
//
// 一切断言都走 HTTP(`GET /mcp` 读状态、`POST /mcp/:name/connect` 复活、`POST /mcp` 新装),
// 与产品 UI 用的是同一条路径;egress 由远端 server 自己的请求计数器判定。
//
// 上游文件一个字都没改:注入面(`ui-mac/src/main/alpha-config-injection.ts`)不再写那份定义,
// ext(`packages/ext/src/cloud-websearch-kill.ts` 的 `installCloudMcp`)在确认装载后才装。

import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Context, Effect } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { WITHHELD_CLOUD_MCP } from "../../../ui-mac/src/main/cloud-web-search"
import { TestInstance } from "../fixture/fixture"
import { it } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const CLOUD = "cloud"

type StandIn = { url: string; requests: string[]; close: () => Promise<void> }

/** 远端云 server 的替身:真 MCP 协议、真 HTTP、记录每一次收到的请求(= egress 计数器)。 */
async function startStandIn(): Promise<StandIn> {
  const protocol = new McpServer({ name: "alpha-cloud-stand-in", version: "1.0.0" }, { capabilities: { tools: {} } })
  protocol.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        { name: "web_search", description: "platform web search", inputSchema: { type: "object", properties: {} } },
        { name: "dispatch", description: "sibling cloud tool", inputSchema: { type: "object", properties: {} } },
      ],
    }),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })
  await protocol.connect(transport)
  const requests: string[] = []
  const http = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return transport.handleRequest(request)
    },
  })
  return {
    url: http.url.toString(),
    requests,
    close: async () => {
      await protocol.close().catch(() => {})
      http.stop(true)
    },
  }
}

// 一个 transport 只服一次握手,所以每条**期望连上**的用例各占一个替身;两个「零 egress」用例
// 共用第一个(它们本来就不该产生任何请求)。
let cloud: StandIn
let spare: StandIn

beforeAll(async () => {
  cloud = await startStandIn()
  spare = await startStandIn()
})

afterAll(async () => {
  await cloud?.close()
  await spare?.close()
})

const request = Effect.fnUntraced(function* (route: string, directory: string, init?: RequestInit) {
  const handler = HttpApiApp.webHandler()
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(handler.handler(new Request(`http://localhost${route}`, { ...init, headers }), context)),
  )
})

const statusOf = Effect.fnUntraced(function* (directory: string, name: string) {
  const response = yield* request(McpPaths.status, directory)
  expect(response.status).toBe(200)
  const body = (yield* Effect.promise(() => response.json() as Promise<Record<string, { status: string }>>)) ?? {}
  return body[name]?.status
})

describe("#223 R5:kill-switch 下云 MCP 的两条复活路径", () => {
  // ── 正向对照 ───────────────────────────────────────────────────────────────
  // R4 的形态。这条**必须**绿在「能连上」,否则下面的红旗只是测试没构造对。
  it.instance(
    "对照(R4 形态):完整定义 + enabled:false 可被 /mcp/:name/connect 热连起来",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const before = cloud.requests.length

        // 初始化确实零建连(R4 当时的依据,这一半是成立的)。
        expect(yield* statusOf(tmp.directory, CLOUD)).toBe("disabled")
        expect(cloud.requests.length).toBe(before)

        const connected = yield* request(`/mcp/${CLOUD}/connect`, tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)

        // …然后一个 HTTP POST 就把它开起来了,连着完整的 URL 与 Authorization 头。
        expect(yield* statusOf(tmp.directory, CLOUD)).toBe("connected")
        expect(cloud.requests.length).toBeGreaterThan(before)
      }),
    {
      // 注入面在代付 + kill-switch 下 R4 写出的那份定义(`ui-mac/src/main/cloud-sidecar-config.ts`
      // 的 materializeCloudMcpConfig 形状;{file:} 已由引擎在配置文本阶段解析成真值)。
      config: () => ({
        mcp: {
          [CLOUD]: {
            type: "remote" as const,
            url: cloud.url,
            enabled: false,
            headers: { Authorization: "Bearer test-token" },
            oauth: false as const,
          },
        },
      }),
    },
  )

  // ── R5/R6 形态 ─────────────────────────────────────────────────────────────
  it.instance("R5 形态:定义不在任何配置源里 ⇒ /mcp/:name/connect 打不开,远端零请求", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const before = cloud.requests.length

      const connected = yield* request(`/mcp/${CLOUD}/connect`, tmp.directory, { method: "POST" })
      expect(connected.status).toBe(404)
      expect(yield* Effect.promise(() => connected.json() as Promise<unknown>)).toMatchObject({ name: CLOUD })

      expect(yield* statusOf(tmp.directory, CLOUD)).toBeUndefined()
      expect(cloud.requests.length).toBe(before)
    }),
  )

  // #223 R6 Major:上一条只在「没有任何来源定义过 cloud」时成立。真实注入面现在总会写一份**中和
  // 条目**(`ui-mac/src/main/cloud-web-search.ts` 的 `WITHHELD_CLOUD_MCP`)—— 它必须在,否则
  // global / alpha.jsonc / 项目里的同名定义不会被深合并覆盖(多源那一半见 alpha-cloud-mcp-multisource)。
  // 这里证明:中和条目在场时 `/connect` 也打不开,远端零请求。
  it.instance(
    "R6 形态:中和条目在场 ⇒ 初始化 disabled,/connect 之后仍连不上,远端零请求",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const before = cloud.requests.length

        expect(yield* statusOf(tmp.directory, CLOUD)).toBe("disabled")

        const connected = yield* request(`/mcp/${CLOUD}/connect`, tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* statusOf(tmp.directory, CLOUD)).not.toBe("connected")
        expect(cloud.requests.length).toBe(before)
      }),
    { config: () => ({ mcp: { [CLOUD]: WITHHELD_CLOUD_MCP } }) },
    30_000,
  )

  it.instance("R5 形态:`mcp.add` 只带 enabled:true(想翻开一个不存在的条目)进不了引擎,远端零请求", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const before = cloud.requests.length

      // 「复活已存在的定义」这条路要求 payload 自带完整 config(`ConfigMCPV1.Info`);只写 enabled
      // 的 payload 连 schema 都过不去 —— 400,零建连。
      const added = yield* request(McpPaths.status, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: CLOUD, config: { enabled: true } }),
      })
      expect(added.status).toBe(400)

      expect(yield* statusOf(tmp.directory, CLOUD)).toBeUndefined()
      expect(cloud.requests.length).toBe(before)
    }),
  )

  // 诚实登记的残留:`add` 自带完整定义时**确实**能装一个新 server —— 那不是「复活 alpha 的定义」,
  // 而是「新装一个第三方 MCP」,拦它等于拦任意第三方 MCP(要收编上游 handlers/mcp.ts 与
  // mcp/index.ts,不在本票范围)。ext 在场时它照样撞上 `tool.execute.before` 那道闸;调用方还得
  // 自带 URL 与 bearer(token 只在 0600 的 {file:} 通道里,不进 env)。
  it.instance("残留(登记,非闭合):`add` 自带完整定义能装上 —— 但那是新装第三方,不是复活", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance

      const added = yield* request(McpPaths.status, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: CLOUD,
          config: { type: "remote", url: spare.url, oauth: false, headers: { Authorization: "Bearer self-supplied" } },
        }),
      })
      expect(added.status).toBe(200)
      expect(yield* statusOf(tmp.directory, CLOUD)).toBe("connected")
    }),
  )
})
