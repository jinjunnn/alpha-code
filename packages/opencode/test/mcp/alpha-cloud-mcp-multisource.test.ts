// #223 R6 Major —— 「继承来的同名条目一并抹掉」只对 `OPENCODE_CONFIG_CONTENT` 自己那一份成立。
//
// R5 的注入面在 kill-switch 下从**继承来的 `OPENCODE_CONFIG_CONTENT` 对象**里删掉 `mcp.cloud`,
// 并据此声称配置里「没有任何名为 cloud 的条目」。R6 勘破那不成立:引擎还分别加载
//
//   ① XDG global(`Global.Path.config` 下的 config.json / opencode.json / opencode.jsonc)
//   ② `OPENCODE_CONFIG`(alpha 自己的 alpha.jsonc)
//   ③ 项目目录(`ConfigPaths.files`)
//   ④ managed 目录(`ConfigManaged.managedConfigDir()`)与 macOS MDM 托管偏好
//
// 而 `mergeDeep`(`src/config/config.ts`)里「后一个来源缺少某个键」**不会删除**先前来源的定义。
// 于是 ext 缺席时,上述任一来源里的一份完整 `cloud` 定义仍会被自动连接;写成 `enabled:false`
// 也没用 —— `MCP.connect()` 无条件复制成 `enabled:true`(见 alpha-cloud-mcp-revival.test.ts)。
//
// 修法 = 注入面改写一份**中和条目**(`ui-mac/src/main/cloud-web-search.ts` 的
// `WITHHELD_CLOUD_MCP`),靠 later-wins 的标量覆盖压过先前来源的**连接控制字段**:`type` / `url` /
// `enabled` 全部被换成一个不做 DNS、必然 ECONNREFUSED 的 `127.0.0.1:1` 端点 + `enabled:false`。
// **不是「逐字段完整覆盖」(#223 R7 措辞更正)**:继承来的 `headers` / `timeout` 会留在合并结果里
// (`oauth` 子对象被 `false` 整体替换)。URL 已是不可用 loopback,它们发不出去,故判决不变 ——
// 但宣称只能写「覆盖连接控制字段」。
//
// 本文件用**真实的多源 Config 加载**(真 `Config.Service`、真文件、真 `Flag.OPENCODE_CONFIG`、
// 真 managed 目录)逐来源证明这件事,并用**真实的 MCP lifecycle + HttpApi 路由**证明「压过之后
// 确实连不上、远端零请求」。每组都带正向对照:没有中和条目时,同一份来源真的会被连上 ——
// 没有对照,红旗可能只是构造不对。
//
// 上游文件一个字都没改。测试文件对 north-star 守卫是 `A`(新增)。

import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { WITHHELD_CLOUD_MCP } from "../../../ui-mac/src/main/cloud-web-search"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { it as plainIt, testEffect } from "../lib/effect"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CLOUD = "cloud"
/** 用户/继承来源里那份「完整的 cloud 定义」—— 与 alpha 真实注入的形状同款(URL 由替身填)。 */
const inheritedCloud = (url: string) => ({
  type: "remote" as const,
  url,
  enabled: true,
  headers: { Authorization: "Bearer inherited-token" },
  oauth: false as const,
})

// ─────────────────────────────────────────────────────────────────────────────
// ① 真实多源 Config 加载:逐来源证明「中和条目覆盖继承定义的连接控制字段」
// ─────────────────────────────────────────────────────────────────────────────

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const configLayer = LayerNode.compile(
  LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]),
  [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
  ],
)
const it = testEffect(configLayer)

const managedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!
const INHERITED_URL = "https://inherited-cloud.example/mcp"

let root = ""
let savedGlobalConfig = ""
let savedOpencodeConfig: string | undefined
let savedContent: string | undefined

const write = async (file: string, body: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...(body as object) }))
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-cloud-multisource-")))
  savedGlobalConfig = Global.Path.config
  savedOpencodeConfig = Flag.OPENCODE_CONFIG
  savedContent = process.env.OPENCODE_CONFIG_CONTENT
  // XDG global 换到本用例自己的空目录(默认不放任何 cloud 定义)。
  ;(Global.Path as { config: string }).config = path.join(root, "xdg")
  await fs.mkdir(path.join(root, "xdg"), { recursive: true })
  delete process.env.OPENCODE_CONFIG_CONTENT
  ;(Flag as { OPENCODE_CONFIG?: string }).OPENCODE_CONFIG = undefined
})

afterEach(async () => {
  ;(Global.Path as { config: string }).config = savedGlobalConfig
  ;(Flag as { OPENCODE_CONFIG?: string }).OPENCODE_CONFIG = savedOpencodeConfig
  if (savedContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = savedContent
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  await fs.rm(root, { force: true, recursive: true }).catch(() => {})
})

/** 注入面在 kill-switch 下写出的 `OPENCODE_CONFIG_CONTENT`(真实形状,见 alpha-config-injection.ts)。 */
const withheldContent = () =>
  JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { [CLOUD]: WITHHELD_CLOUD_MCP } })

/** 四个来源各写一份完整 cloud 定义;`use` 决定这一轮用哪一个。 */
const plantInherited = async (source: "global" | "alpha-jsonc" | "project" | "managed", directory: string) => {
  const entry = { mcp: { [CLOUD]: inheritedCloud(INHERITED_URL) } }
  if (source === "global") return write(path.join(Global.Path.config, "config.json"), entry)
  if (source === "alpha-jsonc") {
    const file = path.join(root, "alpha", "alpha.jsonc")
    await write(file, entry)
    ;(Flag as { OPENCODE_CONFIG?: string }).OPENCODE_CONFIG = file
    return
  }
  if (source === "project") return write(path.join(directory, "opencode.json"), entry)
  return write(path.join(managedConfigDir, "opencode.json"), entry)
}

describe("#223 R6 Major:kill-switch 的中和条目压过每一个用户可及的配置源(连接控制字段)", () => {
  // 正向对照:没有中和条目时,四个来源里的完整定义**真的**都会进合并结果 —— 这就是 R6 判 Major
  // 的事实。没有这一条,下面的绿可能只是「来源根本没被加载」。
  for (const source of ["global", "alpha-jsonc", "project", "managed"] as const)
    it.instance(`正向对照(${source}):没有中和条目时,该来源的完整 cloud 定义原样进合并结果`, () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => plantInherited(source, tmp.directory))

        const cfg = yield* Config.use.get()
        expect(cfg.mcp?.[CLOUD]).toMatchObject({ type: "remote", url: INHERITED_URL, enabled: true })
      }),
    )

  // 修复后:注入面的中和条目排在 global / `OPENCODE_CONFIG` / 项目**之后**,标量 later-wins,
  // 于是 type/url/enabled 全被换掉 —— 那份继承定义再也连不到它原来的端点。
  for (const source of ["global", "alpha-jsonc", "project"] as const)
    it.instance(`修复(${source}):中和条目把继承定义的连接控制字段压成不可连接的端点`, () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => plantInherited(source, tmp.directory))
        process.env.OPENCODE_CONFIG_CONTENT = withheldContent()

        const cfg = yield* Config.use.get()
        const entry = cfg.mcp?.[CLOUD] as { type?: string; url?: string; enabled?: boolean } | undefined
        expect(entry?.type).toBe(WITHHELD_CLOUD_MCP.type)
        expect(entry?.url).toBe(WITHHELD_CLOUD_MCP.url)
        expect(entry?.enabled).toBe(false)
        expect(JSON.stringify(cfg.mcp)).not.toContain(INHERITED_URL)
      }),
    )

  // 诚实登记(**未闭合**,不谎称):managed 目录与 macOS MDM 托管偏好在引擎的加载序里排在
  // `OPENCODE_CONFIG_CONTENT` **之后**(`src/config/config.ts`),因此能把中和条目覆盖回去。
  // 两者都需要 root / 管理员(macOS 上是 `/Library/Application Support/opencode` 与 MDM 描述文件),
  // 是系统管理通道而不是用户面,不在本票的威胁模型内。ADR-009 已按此措辞登记。
  it.instance("残留(登记,非闭合):managed 目录排在 CONTENT 之后,能覆盖回中和条目", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      yield* Effect.promise(() => plantInherited("managed", tmp.directory))
      process.env.OPENCODE_CONFIG_CONTENT = withheldContent()

      const cfg = yield* Config.use.get()
      expect((cfg.mcp?.[CLOUD] as { url?: string } | undefined)?.url).toBe(INHERITED_URL)
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 真实 MCP lifecycle + HttpApi:压过之后**确实**连不上,远端零请求
// ─────────────────────────────────────────────────────────────────────────────

type StandIn = { url: string; requests: string[]; close: () => Promise<void> }

/** 继承定义指向的「远端 cloud」替身:真 MCP 协议、真 HTTP,记录每一次收到的请求(= egress 计数)。 */
async function startStandIn(): Promise<StandIn> {
  const protocol = new McpServer({ name: "inherited-cloud", version: "1.0.0" }, { capabilities: { tools: {} } })
  protocol.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [{ name: "web_search", description: "inherited web search", inputSchema: { type: "object" } }],
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

const context = Context.empty() as Context.Context<unknown>

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

describe("#223 R6 Major:项目源的继承定义被中和后,真实 MCP 生命周期里连不上", () => {
  // 一个 streamable-HTTP transport 只服一次握手,所以两条用例各占一个替身。
  let control: StandIn
  let neutralised: StandIn

  beforeEach(async () => {
    control = await startStandIn()
    neutralised = await startStandIn()
  })
  afterEach(async () => {
    await Promise.all([control?.close(), neutralised?.close()])
  })

  // 正向对照:项目 `opencode.json` 里的完整 cloud 定义**真的**会在实例初始化时自动连上远端。
  plainIt.instance(
    "正向对照:项目源的完整 cloud 定义在初始化时自动连上远端",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        expect(yield* statusOf(tmp.directory, CLOUD)).toBe("connected")
        expect(control.requests.length).toBeGreaterThan(0)
      }),
    { config: () => ({ mcp: { [CLOUD]: inheritedCloud(control.url) } }) },
    30_000,
  )

  plainIt.instance(
    "修复:同一份项目定义 + 注入面的中和条目 ⇒ disabled、/connect 也连不上、远端零请求",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        expect(yield* statusOf(tmp.directory, CLOUD)).toBe("disabled")

        const connected = yield* request(`/mcp/${CLOUD}/connect`, tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* statusOf(tmp.directory, CLOUD)).not.toBe("connected")
        expect(neutralised.requests).toEqual([])
      }),
    {
      config: () => ({ mcp: { [CLOUD]: inheritedCloud(neutralised.url) } }),
      init: (directory) =>
        Effect.sync(() => {
          void directory
          process.env.OPENCODE_CONFIG_CONTENT = withheldContent()
        }),
    },
    30_000,
  )
})
