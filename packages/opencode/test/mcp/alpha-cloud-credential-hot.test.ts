// REQ-236 AC2 / AC3(`#1562`)—— alpha 治理的云连接器每次请求现读凭据文件,续期热应用不重启引擎。
//
// 引擎侧接缝:`connectRemote` 对 `isGovernedMcpEntry` 成立的条目给 MCP SDK transport 一个 fetch 包装器
// (`@opencode-ai/plugin/alpha-cloud-authority` 的 governedCredentialFetch),凭据从 `ALPHA_CLOUD_MCP_DEF` 定义里的
// `{file:}` 引用现读,不用已装载条目里的字面量。这里用真 streamable-HTTP MCP server 记下每一个请求的
// Authorization,跑两种装载形态:
//   · 生产形态:定义由 ui-mac 注入面的工厂 `materializeCloudMcpConfig` + `secretFileRef` 产出(带 `{file:}` 引用),
//     经引擎**真配置加载器**替换成字面令牌 A 后装进条目;`ALPHA_CLOUD_MCP_DEF` 保留引用形态;
//   · kill-switch 形态:条目由 ext 的 `installCloudMcp` 解析引用后写入(同样是字面令牌 A)。
// 每种形态都在换文件(令牌 B,生产 `writeSecretFileAtomic`)之后走三条路:POST(调用工具)、GET/SSE 重连
// (服务端关掉独立 SSE 流,SDK 重连)、404 会话恢复(服务端换代,旧会话 404 ⇒ 重新 initialize 再重试)——
// 换文件之后的每一个请求都必须带 B,一个 A 都没有。读不到臂:删掉文件 ⇒ 调用以认证错误失败,服务端零请求;
// 启动时就读不到 ⇒ 状态 failed + code auth,服务端零请求(条目里的旧字面量从未发出)。
// 新测试按 ADR-043 放 `test/mcp/alpha-*.test.ts`(方案 §2.7)。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CLOUD_MCP_DEF_ENV, CLOUD_MCP_SERVER_ENV } from "@opencode-ai/plugin/alpha-cloud-authority"
import { Effect, Exit } from "effect"
import { MCP } from "../../src/mcp/index"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { materializeCloudMcpConfig } from "../../../ui-mac/src/main/cloud-sidecar-config"
import { secretFilePath, secretFileRef, writeSecretFileAtomic } from "../../../ui-mac/src/main/alpha-secret-files"
import { CLOUD_MCP_ARM_ENV, installCloudMcp } from "../../../ext/src/cloud-websearch-kill"

const it = testEffect(LayerNode.compile(MCP.node))
const CLOUD = "cloud"
const TOKEN_A = "SENTINEL-CLOUD-MCP-A-58d2"
const TOKEN_B = "SENTINEL-CLOUD-MCP-B-c07e"

type Seen = { method: string; rpc?: string; authorization: string | null; status?: number }
type CloudServer = {
  url: string
  seen: Seen[]
  closeStandaloneSse: () => void
  restart: () => Promise<void>
  close: () => Promise<void>
}

/** 远端云 server 的替身:真 MCP 协议、真 HTTP,逐个记下请求的方法与 Authorization(= 出网证据)。 */
async function startCloudServer(): Promise<CloudServer> {
  const make = async () => {
    const protocol = new Server({ name: "alpha-cloud-stand-in", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({ tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] }),
    )
    protocol.setRequestHandler(CallToolRequestSchema, () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    return { protocol, transport }
  }
  let current = await make()
  const seen: Seen[] = []
  const http = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const body = request.method === "POST" ? await request.clone().text() : ""
      const entry: Seen = { method: request.method, authorization: request.headers.get("authorization") }
      try {
        entry.rpc = (JSON.parse(body) as { method?: string }).method
      } catch {}
      seen.push(entry)
      // 会话已不在(服务端换代)⇒ 按 Streamable HTTP 规范答 404,客户端据此重新 initialize。新建的 transport 自己
      // 对未初始化时的会话请求答的是 400,所以这一格在入口判。
      const session = request.headers.get("mcp-session-id")
      if (session && session !== current.transport.sessionId) {
        entry.status = 404
        return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 })
      }
      const response = await current.transport.handleRequest(request)
      entry.status = response.status
      return response
    },
  })
  return {
    url: http.url.toString(),
    seen,
    closeStandaloneSse: () => current.transport.closeStandaloneSSEStream(),
    restart: async () => {
      await current.protocol.close().catch(() => {})
      current = await make()
    },
    close: async () => {
      await current.protocol.close().catch(() => {})
      http.stop(true)
    },
  }
}

let root = ""
let production: CloudServer
let killSwitch: CloudServer
let unreadable: CloudServer
const savedEnv: Record<string, string | undefined> = {}
const MANAGED = [CLOUD_MCP_SERVER_ENV, CLOUD_MCP_DEF_ENV]
/** 每个用例开始前设好的 DEF(按用例连哪个替身)。 */
const definitionFor = (server: CloudServer) => materializeCloudMcpConfig(server.url, secretFileRef(root, "ALPHA_MCP_TOKEN"))

beforeAll(async () => {
  MANAGED.forEach((key) => (savedEnv[key] = process.env[key]))
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-cloud-credential-")))
  fs.mkdirSync(path.join(root, "alpha-secrets"), { recursive: true, mode: 0o700 })
  production = await startCloudServer()
  killSwitch = await startCloudServer()
  unreadable = await startCloudServer()
})

afterAll(async () => {
  MANAGED.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  })
  await production?.close()
  await killSwitch?.close()
  await unreadable?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** 注入面在 fork 时置的那两份 env:server 名与带引用的定义(两种形态都一样)。 */
function armGovernedEnv(server: CloudServer, token: string | undefined) {
  process.env[CLOUD_MCP_SERVER_ENV] = CLOUD
  process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify(definitionFor(server))
  const file = secretFilePath(root, "ALPHA_MCP_TOKEN")
  if (token) writeSecretFileAtomic(path.dirname(file), "ALPHA_MCP_TOKEN", token)
  else fs.rmSync(file, { force: true })
}

const auths = (entries: Seen[]) => [...new Set(entries.map((entry) => entry.authorization))]

/** 换文件之后三条路都换凭据;最后删文件 ⇒ 认证错误、零出网。两种装载形态共用。 */
const scenario = (server: CloudServer) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const tools = yield* pollWithTimeout(
      mcp.tools().pipe(Effect.map((all) => (`${CLOUD}_whoami` in all ? all : undefined))),
      "governed cloud MCP never connected",
      "10 seconds",
    )
    const tool = tools[`${CLOUD}_whoami`]!
    const call = mcp.callTool!(CLOUD, "whoami", {}, { generation: tool.generation, defDigest: tool.defDigest })
    // 装载时条目里已是字面令牌 A,首次连接各请求都带 A。
    expect(auths(server.seen)).toEqual([`Bearer ${TOKEN_A}`])

    // 续期热应用:原子换成 B,引擎与连接都不动。
    writeSecretFileAtomic(path.join(root, "alpha-secrets"), "ALPHA_MCP_TOKEN", TOKEN_B)

    // ① POST
    const beforePost = server.seen.length
    expect((yield* call).content).toEqual([{ type: "text", text: "ok" }])
    const posts = server.seen.slice(beforePost)
    expect(posts.map((entry) => entry.rpc)).toEqual(["tools/call"])
    expect(auths(posts)).toEqual([`Bearer ${TOKEN_B}`])

    // ② GET/SSE 重连:服务端关掉独立 SSE 流,SDK 按退避重连(同一条 GET 路径)。
    const beforeSse = server.seen.length
    server.closeStandaloneSse()
    const reconnect = yield* pollWithTimeout(
      Effect.sync(() => server.seen.slice(beforeSse).find((entry) => entry.method === "GET")),
      "the SSE stream never reconnected",
      "10 seconds",
    )
    expect(reconnect.authorization).toBe(`Bearer ${TOKEN_B}`)

    // ③ 404 会话恢复:服务端换代 ⇒ 旧会话 POST 404 ⇒ 同一 transport 重新 initialize ⇒ 重试那次调用。
    yield* Effect.promise(server.restart)
    const beforeRecovery = server.seen.length
    expect((yield* call).content).toEqual([{ type: "text", text: "ok" }])
    const recovery = server.seen.slice(beforeRecovery).filter((entry) => entry.method === "POST")
    expect(recovery[0]).toMatchObject({ rpc: "tools/call", status: 404 })
    expect(recovery.map((entry) => entry.rpc)).toContain("initialize")
    expect(recovery.at(-1)).toMatchObject({ rpc: "tools/call", status: 200 })
    expect(auths(server.seen.slice(beforePost))).toEqual([`Bearer ${TOKEN_B}`])

    // 读不到:删掉文件 ⇒ 这次调用以认证错误失败,请求不出网;错误里没有任何令牌。
    fs.rmSync(secretFilePath(root, "ALPHA_MCP_TOKEN"))
    const beforeRefusal = server.seen.length
    const refused = yield* Effect.exit(call)
    expect(Exit.isFailure(refused)).toBe(true)
    const message = JSON.stringify(refused)
    expect(message).toContain("401")
    expect(message).not.toContain(TOKEN_A)
    expect(message).not.toContain(TOKEN_B)
    expect(server.seen.length).toBe(beforeRefusal)
  })

it.instance("生产形态(注入面定义 + 真加载器替换):换文件后 POST、GET/SSE 重连、404 会话恢复都带新凭据;删文件即认证错误、零出网", () => scenario(production), {
  config: () => {
    armGovernedEnv(production, TOKEN_A)
    return { mcp: { [CLOUD]: definitionFor(production) } }
  },
}, 40_000)

it.instance("kill-switch 形态(ext installCloudMcp 写入的条目):同样三条路换凭据;删文件即认证错误、零出网", () => scenario(killSwitch), {
  config: () => {
    armGovernedEnv(killSwitch, TOKEN_A)
    const cfg: { mcp?: Record<string, unknown> } = {}
    expect(installCloudMcp(cfg, { [CLOUD_MCP_ARM_ENV]: CLOUD, [CLOUD_MCP_DEF_ENV]: process.env[CLOUD_MCP_DEF_ENV] })).toBe(CLOUD)
    return cfg as { mcp: Record<string, never> }
  },
}, 40_000)

it.instance("启动时就读不到 ⇒ failed + code auth,条目里的旧字面量从未发出(服务端零请求)", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const status = yield* pollWithTimeout(
      mcp.status().pipe(Effect.map((all) => (all[CLOUD]?.status === "failed" ? all[CLOUD] : undefined))),
      "governed cloud MCP did not fail",
      "10 seconds",
    )
    expect(status).toMatchObject({ status: "failed", code: "auth" })
    expect(JSON.stringify(status)).not.toContain(TOKEN_A)
    expect(unreadable.seen).toEqual([])
  }), {
  config: () => {
    // kill-switch 形态的条目带着字面令牌 A,随后凭据文件消失(登出 / 同步失败)—— 引擎不得把 A 发出去。
    armGovernedEnv(unreadable, TOKEN_A)
    const cfg: { mcp?: Record<string, unknown> } = {}
    installCloudMcp(cfg, { [CLOUD_MCP_ARM_ENV]: CLOUD, [CLOUD_MCP_DEF_ENV]: process.env[CLOUD_MCP_DEF_ENV] })
    armGovernedEnv(unreadable, undefined)
    return cfg as { mcp: Record<string, never> }
  },
}, 40_000)
