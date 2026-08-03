// `#733`(REQ-130):云 MCP 走标准 OAuth 的**配置形态闸**。
//
// 这个文件刻意不自己复述一遍「引擎会怎么读这份配置」—— 那正是本仓栽过的形态
//(手写一个别人文法的替身)。它把三个**外部权威**拉进来当裁判:
//
//   ① `packages/core/src/v1/config/mcp.ts` 的 `Remote` / `OAuth` schema —— 引擎自己的解码器;
//   ② `packages/opencode/src/mcp/oauth-provider.ts` 的 `McpOAuthProvider` —— 引擎真的会用
//      我们这份 `oauth` 对象构造它,`redirectUrl` / `clientMetadata` / `clientInformation()`
//      是它自己算出来的,不是这里断言"应该是"的;
//   ③ 同文件的 `parseRedirectUri()` —— 本机回调服务器就是用它决定 listen 哪个端口和路径。
//
// 上游改了它们,这里就该红:那正是我们想知道的事。
//
// **本票只到"配置形态 + 本地门"这一层。** 真机端到端授权跑不通是**预期**的 ——
// alpha-web 与 alpha-platform 两侧都还没部署(实测两侧 `.well-known` 均 404),
// 端到端归部署后的验收,这里不为了"让它绿"去 mock 掉任何生产接线。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
// 相对路径跨包 import:ui-mac 没有 `@opencode-ai/core` 的解析入口(实测 Cannot find module),
// 而这两个模块正是"引擎会怎么读"的**唯一**真源。测试文件不进 ui-mac 的 typecheck,
// 也不会让生产代码多出一条对上游的依赖。
import { OAuth as EngineOAuthSchema, Remote as EngineRemoteSchema } from "../../../core/src/v1/config/mcp"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH, parseRedirectUri } from "../../../opencode/src/mcp/oauth-provider"
import {
  CLOUD_MCP_OAUTH_CLIENT_ID,
  CLOUD_MCP_OAUTH_REDIRECT_URI,
  materializeCloudMcpConfig,
} from "./cloud-sidecar-config"
import { injectAlphaConfig } from "./alpha-config-injection"
import { CLOUD_MCP_DEF_ENV } from "./cloud-web-search"

const CLOUD_URL = "https://cloud.example/mcp"

describe("`#733` 云 MCP 的 OAuth 配置形态", () => {
  test("两个跨仓常量逐字钉死(alpha-web 侧写岔一个字符只会在授权页失败,本地一切正常)", () => {
    // 这两个字面量必须与 alpha-web 侧逐字一致(托管 CIMD 与回环白名单,alpha-web#127)。
    // 钉的是**字面量本身**而不是"它是个 URL":后者一个错误实现随手就能满足。
    expect(CLOUD_MCP_OAUTH_CLIENT_ID).toBe("https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json")
    expect(CLOUD_MCP_OAUTH_REDIRECT_URI).toBe("http://127.0.0.1:19876/callback")
    // 无尾斜杠 —— `http://127.0.0.1:19876/callback/` 与它是两个不同的 redirect_uri,
    // 授权服务器按精确匹配拒绝。
    expect(CLOUD_MCP_OAUTH_REDIRECT_URI.endsWith("/")).toBe(false)
    // 引擎默认值是 `.../mcp/oauth/callback`,而 alpha-web 白名单只放 `.../callback`。
    // 这一条钉住"我们确实离开了默认值"——退回默认即红。
    expect(new URL(CLOUD_MCP_OAUTH_REDIRECT_URI).pathname).not.toBe(OAUTH_CALLBACK_PATH)
    expect(new URL(CLOUD_MCP_OAUTH_REDIRECT_URI).pathname).toBe("/callback")
  })

  test("定义里一个凭证通道都没有:无 headers、无 Authorization、无 {file:} 引用", () => {
    const cfg = materializeCloudMcpConfig(CLOUD_URL)
    expect("headers" in cfg).toBe(false)
    const serialized = JSON.stringify(cfg)
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("{file:")
    expect(serialized).not.toContain("ALPHA_CLOUD_TOKEN")
  })

  test("`oauth` 是对象而不是 `false` —— 这一位决定该 server 能不能进 needs_auth", () => {
    const cfg = materializeCloudMcpConfig(CLOUD_URL)
    // 引擎 `packages/opencode/src/mcp/index.ts:241` 的判别就是 `mcp.oauth === false`;
    // 为 false 时不构造 authProvider,SDK 的 401 分支(`streamableHttp.js:96`)整条不走,
    // `needs_auth` 结构上不可达。断布尔"不是 false"不够,还要它真的是一个引擎能解的 OAuth 对象。
    expect(cfg.oauth).not.toBe(false)
    expect(Schema.decodeUnknownSync(EngineOAuthSchema)(cfg.oauth)).toMatchObject({
      clientId: CLOUD_MCP_OAUTH_CLIENT_ID,
      redirectUri: CLOUD_MCP_OAUTH_REDIRECT_URI,
    })
  })

  test("引擎自己的 Remote schema 能解这份定义(不是我们说它合法)", () => {
    const decoded = Schema.decodeUnknownSync(EngineRemoteSchema)(materializeCloudMcpConfig(CLOUD_URL))
    expect(decoded.type).toBe("remote")
    expect(decoded.url).toBe(CLOUD_URL)
    expect(decoded.enabled).toBe(true)
    expect(decoded.headers).toBeUndefined()
  })

  test("引擎真的会用这份 oauth 造出我们要的 provider(redirectUrl / clientId / 无 scope)", () => {
    const cfg = materializeCloudMcpConfig(CLOUD_URL)
    // 与 `packages/opencode/src/mcp/index.ts:246-266` 同一条构造:配置的 oauth 字段逐个进来。
    const provider = new McpOAuthProvider("cloud", cfg.url, cfg.oauth, { onRedirect: () => {} }, {} as never)

    // ① 授权请求里的 redirect_uri —— provider 自己算的。
    expect(provider.redirectUrl).toBe(CLOUD_MCP_OAUTH_REDIRECT_URI)
    // ② 本机回调服务器 listen 的端口与路径 —— `oauth-callback.ts` 用的就是这个函数。
    //    路径对不上时它对真实回调返回 404,那正是今天这条路断掉的地方。
    expect(parseRedirectUri(provider.redirectUrl)).toEqual({ port: 19876, path: "/callback" })
    // ③ 有 clientId ⇒ 跳过动态客户端注册,直接用我们的 CIMD URL。
    expect(provider.clientMetadata.redirect_uris).toEqual([CLOUD_MCP_OAUTH_REDIRECT_URI])
    // ④ 我们不发 scope。判据在 `@modelcontextprotocol/sdk@1.29.0` 的
    //    `dist/esm/client/auth.js:167-176`:`requestedScope || PRM.scopes_supported || clientMetadata.scope`
    //    —— config 的 scope 排最后,首次连接落 PRM、401 之后落 challenge,两条都在它之前。
    //    写进去不报错也不生效,是个纯 no-op;真出问题时会被误诊成缓存/部署/flaky。
    expect(provider.clientMetadata.scope).toBeUndefined()
  })

  test("clientInformation() 直接返回我们的 CIMD URL(= 不走 RFC 7591 动态注册)", async () => {
    const cfg = materializeCloudMcpConfig(CLOUD_URL)
    const provider = new McpOAuthProvider("cloud", cfg.url, cfg.oauth, { onRedirect: () => {} }, {} as never)
    // `auth` 服务传的是 `{} as never`:有 clientId 时 `clientInformation()` 在第一行就返回,
    // **根本不会**碰凭证库(`oauth-provider.ts:55-61`)。它若去碰了,这条会抛 —— 也是判据。
    expect(await provider.clientInformation()).toEqual({ client_id: CLOUD_MCP_OAUTH_CLIENT_ID, client_secret: undefined })
  })
})

// ── 生产接线:上面断的是纯函数,这里跑的是真的 `injectAlphaConfig` ──────────────────────────
//
// 「我断言的是真实产物」和「我跑了生产的那条路径」不是一回事:把上面那组全留着、
// 同时让 `alpha-config-injection.ts` 改回去塞 bearer,上面六条**照样全绿**。
describe("`#733` 生产注入面(真 injectAlphaConfig / 真密钥文件 / 真 env)", () => {
  let tmp: string
  let userData: string
  const saved = { ...process.env }

  const plantSecret = (name: string, value: string) => {
    const dir = path.join(userData, "alpha-secrets")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), value, { mode: 0o600 })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac733-"))
    userData = path.join(tmp, "userData")
    fs.mkdirSync(userData, { recursive: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("ALPHA_") || key.startsWith("OPENCODE_")) delete process.env[key]
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "global")
    plantSecret("ALPHA_CLOUD_TOKEN", "SECRET-CLOUD-TOKEN-VALUE")
    process.env.ALPHA_CLOUD_MCP_URL = CLOUD_URL
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const injectedCloud = () => {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { mcp?: Record<string, unknown> }
    return config.mcp?.cloud as Record<string, unknown> | undefined
  }

  test("注入的云 server 定义走 OAuth,且不含任何凭证通道", () => {
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })

    const cloud = injectedCloud()
    expect(cloud).toBeDefined()
    // 引擎自己的解码器判合法,再逐条判内容 —— 判"是个对象"不够,一个错误实现随手满足。
    const decoded = Schema.decodeUnknownSync(EngineRemoteSchema)(cloud)
    expect(decoded.url).toBe(CLOUD_URL)
    expect(decoded.headers).toBeUndefined()
    expect(decoded.oauth).toEqual({
      clientId: CLOUD_MCP_OAUTH_CLIENT_ID,
      redirectUri: CLOUD_MCP_OAUTH_REDIRECT_URI,
    })

    // 整份 config 文本里一个凭证影子都不许有(继承面/兄弟键一起覆盖到)。
    const content = process.env.OPENCODE_CONFIG_CONTENT!
    expect(content).not.toContain("Authorization")
    expect(content).not.toContain("Bearer")
    expect(content).not.toContain("{file:")
    expect(content).not.toContain("SECRET-CLOUD-TOKEN-VALUE")
    // ext 托管通道同理(它是同一份定义的第二个出口 —— 只查 config 会漏掉整条 env 通道)。
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("Authorization")
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("{file:")
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("SECRET-CLOUD-TOKEN-VALUE")
    expect(JSON.parse(process.env[CLOUD_MCP_DEF_ENV]!)).toEqual(cloud)
  })

  test("ALPHA_CLOUD_TOKEN 仍是「平台代付」判据 —— 删掉密钥文件,云 server 整个不注册", () => {
    // 这一条是**反方向**的闸:本票只该删掉「它当 MCP Authorization」这一个消费者。
    // 若有人顺手把 `platformPays` 里的 `hasSecretFile` 一起删了,这里会绿得很难看 ——
    // 所以正反两半都断:有密钥文件 ⇒ 注册;没有 ⇒ 不注册。
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
    expect(injectedCloud()).toBeDefined()

    delete process.env.OPENCODE_CONFIG_CONTENT
    fs.rmSync(path.join(userData, "alpha-secrets", "ALPHA_CLOUD_TOKEN"))
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
    expect(injectedCloud()).toBeUndefined()
    expect(process.env[CLOUD_MCP_DEF_ENV]).toBeUndefined()
  })

  test("ADR-009 的 web search 主权没被这次改动带走(代付时本地 websearch 仍被 deny)", () => {
    // 同一个 `platformPays` 判据的第二个消费者。删掉密钥文件判据会让这条一起红。
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { permission?: Record<string, unknown> }
    expect(config.permission?.websearch).toBe("deny")
  })
})
