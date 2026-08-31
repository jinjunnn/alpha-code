// `#1195`(REQ-144 T2):云 MCP 凭证通道的**形状闸**。
//
// 凭证 = 登录铸的 `mcp_access` token(alpha-web T1 顶层 `mcp_access_token`),经 A6
// `{file:…ALPHA_MCP_TOKEN}` 引用装进静态 `Authorization` header,`oauth:false` 把交互式
// OAuth 整条关掉(基线 `docs/design/req-144-login-minted-mcp-access.md` §2.1/§3)。
//
// 与前身 `cloud-mcp-oauth.test.ts`(`#733`/`#1106`,随本票退役)同一纪律:
// 不手写「引擎会怎么读这份配置」的替身,拉引擎自己的 `Remote` schema 当裁判;
// kill-switch 的最终一跳跑**生产件本体** `installCloudMcp()`(不是替身)。
//
// 四条退出条件在此逐条有闸(票面 `ac#1195`):
//   ① header = `Bearer {file:…ALPHA_MCP_TOKEN}` + `oauth:false`,token 字面量不进
//      `OPENCODE_CONFIG_CONTENT`(I3);
//   ② 字段/文件缺席 ⇒ `enabled:false` 且**无任何回退**(不回 `ALPHA_CLOUD_TOKEN` header、
//      不回交互式 OAuth,I6);
//   ③ 第三方 MCP 定义注入路径回归逐项不变(AC3 静态半边)—— 错误实现(把第三方也改走
//      header 通道 / 动第三方的 oauth 对象)在「第三方条目逐字节不变」上当场红;
//   ④ 仅 cloud 定义携带该文件引用(I4)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
// 相对路径跨包 import:ui-mac 没有 `@opencode-ai/core` 的解析入口(实测 Cannot find module),
// 而这个模块是"引擎会怎么读"的**唯一**真源。测试文件不进 ui-mac 的 typecheck,
// 也不会让生产代码多出一条对上游的依赖。
import { Remote as EngineRemoteSchema } from "../../../core/src/v1/config/mcp"
import { materializeCloudMcpConfig } from "./cloud-sidecar-config"
import { injectAlphaConfig } from "./alpha-config-injection"
import { CLOUD_MCP_ARM_ENV, CLOUD_MCP_DEF_ENV, WITHHELD_CLOUD_MCP } from "./cloud-web-search"
import { secretFilePath, secretFileRef } from "./alpha-secret-files"
// kill-switch 下**最终**进配置的那一份不是注入面写的,是 ext 写回的(#733 审计 B1 的教训原样
// 继承):只断 main 的 config / DEF = 断中间产物。这里 import 生产件本体,让最后一跳真的执行。
import { installCloudMcp } from "../../../ext/src/cloud-websearch-kill"

const CLOUD_URL = "https://cloud.example/mcp"
const MCP_SECRET = "SECRET-MCP-TOKEN-VALUE"
const CLOUD_SECRET = "SECRET-CLOUD-TOKEN-VALUE"

describe("`#1195` 云 MCP header 通道的纯工厂形状", () => {
  test("有凭证:headers.Authorization = Bearer {file:…} 且 oauth 字面 false", () => {
    const ref = "{file:/ud/alpha-secrets/ALPHA_MCP_TOKEN}"
    const cfg = materializeCloudMcpConfig(CLOUD_URL, ref)
    // 逐字面量断言,不拿工厂自己的拼接当基准(锚点不得与被测对象同源)。
    expect(cfg).toEqual({
      type: "remote",
      url: CLOUD_URL,
      enabled: true,
      headers: { Authorization: "Bearer {file:/ud/alpha-secrets/ALPHA_MCP_TOKEN}" },
      oauth: false,
    })
    // `oauth === false` 是引擎的分化判据(`packages/opencode/src/mcp/index.ts` 对 false 完全
    // 不构造 McpOAuthProvider、不碰 mcp-auth.json、不开 loopback)。`toEqual` 已排他,
    // 这里再点名:一个 OAuth 对象(clientId/redirectUri)出现即红。
    expect(cfg.oauth).toBe(false)
    expect(JSON.stringify(cfg)).not.toContain("clientId")
  })

  test("引擎自己的 Remote schema 能解这份定义(headers + oauth:false 是既有语义,不是我们说它合法)", () => {
    const decoded = Schema.decodeUnknownSync(EngineRemoteSchema)(
      materializeCloudMcpConfig(CLOUD_URL, "{file:/ud/alpha-secrets/ALPHA_MCP_TOKEN}"),
    )
    expect(decoded.type).toBe("remote")
    expect(decoded.url).toBe(CLOUD_URL)
    expect(decoded.enabled).toBe(true)
    expect(decoded.headers).toEqual({ Authorization: "Bearer {file:/ud/alpha-secrets/ALPHA_MCP_TOKEN}" })
    expect(decoded.oauth).toBe(false)
  })

  test("缺席(ref=undefined):enabled:false、零凭证通道、零 {file:} 引用(引擎对缺席文件的引用会 fail-loud 掉整个 config 装载)", () => {
    const cfg = materializeCloudMcpConfig(CLOUD_URL, undefined)
    expect(cfg).toEqual({ type: "remote", url: CLOUD_URL, enabled: false, oauth: false })
    const serialized = JSON.stringify(cfg)
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("{file:")
    expect(serialized).not.toContain("clientId")
    // enabled:false 的 Remote 是 schema 合法条目(boot 时 MCP.create 直接 DISABLED_RESULT)。
    expect(Schema.decodeUnknownSync(EngineRemoteSchema)(cfg).enabled).toBe(false)
  })
})

// ── 生产接线:真 injectAlphaConfig / 真密钥文件 / 真 env ────────────────────────────────
describe("`#1195` 生产注入面", () => {
  let tmp: string
  let userData: string
  const saved = { ...process.env }

  const plantSecret = (name: string, value: string) => {
    const file = secretFilePath(userData, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value, { mode: 0o600 })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac1195-"))
    userData = path.join(tmp, "userData")
    fs.mkdirSync(userData, { recursive: true })
    for (const key of Object.keys(process.env))
      if (key.startsWith("ALPHA_") || key.startsWith("OPENCODE_")) delete process.env[key]
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "global")
    // 登录态的两份密钥文件都在:ALPHA_CLOUD_TOKEN 仍由 applyAuthEnv/syncSecretFiles 落盘
    //(它是 cloud.dispatch 的 platform_access),但 `#1195` 起它**不是**云 MCP 的判据 ——
    // 下面的缺席臂靠「它在而 MCP token 不在」证明没有回退。
    plantSecret("ALPHA_CLOUD_TOKEN", CLOUD_SECRET)
    plantSecret("ALPHA_MCP_TOKEN", MCP_SECRET)
    process.env.ALPHA_CLOUD_MCP_URL = CLOUD_URL
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const injectedMcp = () => {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { mcp?: Record<string, unknown> }
    return config.mcp ?? {}
  }

  test("①/④ 注入的 cloud 定义 = Bearer {file:…ALPHA_MCP_TOKEN} + oauth:false;token 字面量不进 config;引用只在 cloud 一处", () => {
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })

    const cloud = injectedMcp().cloud as Record<string, unknown>
    const decoded = Schema.decodeUnknownSync(EngineRemoteSchema)(cloud)
    expect(decoded.url).toBe(CLOUD_URL)
    expect(decoded.enabled).toBe(true)
    expect(decoded.oauth).toBe(false)
    // 引用逐字面量重建(独立于生产的 secretFileRef 拼接也一致 —— 双轴)。
    const expectedRef = `{file:${path.join(userData, "alpha-secrets", "ALPHA_MCP_TOKEN")}}`
    expect(secretFileRef(userData, "ALPHA_MCP_TOKEN")).toBe(expectedRef)
    expect(decoded.headers).toEqual({ Authorization: `Bearer ${expectedRef}` })

    // I3:整份 config 文本里没有 token 值、没有 OAuth 对象残影。
    const content = process.env.OPENCODE_CONFIG_CONTENT!
    expect(content).not.toContain(MCP_SECRET)
    expect(content).not.toContain(CLOUD_SECRET)
    expect(content).not.toContain("clientId")
    // I4:该文件引用在整份 config 里恰好一处(就是 cloud 的 header)。
    expect(content.split("ALPHA_MCP_TOKEN").length - 1).toBe(1)
    // `#1195` 起 ALPHA_CLOUD_TOKEN 不再被任何定义引用。
    expect(content).not.toContain("ALPHA_CLOUD_TOKEN")

    // env 托管通道(DEF)= 同一份定义、同样零 token 值。
    expect(JSON.parse(process.env[CLOUD_MCP_DEF_ENV]!)).toEqual(cloud)
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain(MCP_SECRET)
  })

  test("② 文件缺席 ⇒ enabled:false 且无任何回退(ALPHA_CLOUD_TOKEN 在场也不回退;不回交互式 OAuth)", () => {
    fs.rmSync(secretFilePath(userData, "ALPHA_MCP_TOKEN"))
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })

    // toEqual 排他:没有 headers、没有 oauth 对象、没有 {file:} 引用 —— 一个回退通道都不存在。
    expect(injectedMcp().cloud).toEqual({ type: "remote", url: CLOUD_URL, enabled: false, oauth: false })
    // config 文本里连引用名都不出现(引擎对缺席文件的 {file:} 引用 fail-loud 掉整个装载)。
    expect(process.env.OPENCODE_CONFIG_CONTENT!).not.toContain("ALPHA_MCP_TOKEN")
    // 缺凭证 ⇒ 不代付 ⇒ 本地 keyless websearch 不被 deny(主权判据同轴,ADR-009 B1)。
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { permission?: Record<string, unknown> }
    expect(config.permission?.websearch).toBeUndefined()
    // DEF 身份通道仍是真定义(带引用):ext 端 installCloudMcp 读不到文件会响亮不装(fail-closed)。
    expect(process.env[CLOUD_MCP_DEF_ENV]).toContain("ALPHA_MCP_TOKEN")
  })

  test("反向:旧轴文件 ALPHA_CLOUD_TOKEN 缺席不再影响云 MCP(判据已整体换轴)", () => {
    fs.rmSync(secretFilePath(userData, "ALPHA_CLOUD_TOKEN"))
    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
    expect((injectedMcp().cloud as Record<string, unknown>).enabled).toBe(true)
  })

  test("③ AC3:第三方 MCP 定义(oauth 对象 / local)逐字节不变 —— 分叉只在 cloud 一格", () => {
    const partner = {
      type: "remote",
      url: "https://partner.example/mcp",
      enabled: true,
      oauth: { clientId: "https://partner.example/cimd.json", redirectUri: "http://127.0.0.1:9999/cb" },
    }
    const localTool = { type: "local", command: ["partner-mcp", "--stdio"] }
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { partner, "local-tool": localTool } })

    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })

    const mcp = injectedMcp()
    // 第三方两条:oauth 对象原样、无 headers、无 {file:} —— 错误实现(第三方也改走 header
    // 通道 / 顺手关第三方 oauth)在 toEqual 上当场红。
    expect(mcp.partner).toEqual(partner)
    expect(mcp["local-tool"]).toEqual(localTool)
    // cloud 是 alpha 自己的定义(带引用),与第三方互不串门。
    expect(JSON.stringify(mcp.cloud)).toContain("ALPHA_MCP_TOKEN")
    expect(JSON.stringify(mcp.partner)).not.toContain("ALPHA_MCP_TOKEN")
  })

  // ── kill-switch 的最终一跳:真 installCloudMcp(生产件本体)────────────────────────────
  test("B1:kill-switch 下 ext 写回的最终定义 = 解析后的 Bearer 值 + oauth:false(OAuth 不复活)", () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      expect(injectAlphaConfig(userData, path.join(tmp, "ext.js"), "stable")).toEqual({ ok: true })
    } finally {
      console.error = original
    }
    expect(process.env[CLOUD_MCP_ARM_ENV]).toBe("cloud")
    // 注入面这一半:kill-switch 下配置里只有中和条目。
    expect(injectedMcp().cloud).toEqual({ ...WITHHELD_CLOUD_MCP })

    // ext 那一半:真 installCloudMcp + 真 readFileSync(默认参数)读**真密钥文件**。
    const cfg: { mcp?: Record<string, unknown> } = { mcp: { cloud: injectedMcp().cloud } }
    expect(installCloudMcp(cfg, process.env)).toBe("cloud")
    expect(cfg.mcp!.cloud).toEqual({
      type: "remote",
      url: CLOUD_URL,
      enabled: true,
      headers: { Authorization: `Bearer ${MCP_SECRET}` },
      oauth: false,
    })
    expect(JSON.stringify(cfg.mcp!.cloud)).not.toContain("clientId")
  })

  test("B1 缺席臂:kill-switch + 文件缺席 ⇒ installCloudMcp 响亮不装,留下中和条目(fail-closed)", () => {
    fs.rmSync(secretFilePath(userData, "ALPHA_MCP_TOKEN"))
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    let installed: string | undefined
    let cfg: { mcp?: Record<string, unknown> }
    try {
      expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
      cfg = { mcp: { cloud: injectedMcp().cloud } }
      installed = installCloudMcp(cfg, process.env)
    } finally {
      console.error = original
    }
    expect(installed).toBeUndefined()
    expect(errors.flat().join("\n")).toContain("unresolved {file:} reference")
    expect(cfg!.mcp!.cloud).toEqual({ ...WITHHELD_CLOUD_MCP })
  })
})
