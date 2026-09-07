// REQ-153 #1238 —— harness 侧 max_tokens 跟随 route 上限:平台代理节点不发 max_tokens(网关填 route 值),
// 直连 BYOK / 自定义节点保持上游行为。两层:①纯判据 platformOutputCap;②真 AlphaExt 的 chat.params 钩子
// (与引擎装它的方式同款:同一个模块、同一份 ownHooks),证明判据真的接在钩子上而不是只在纯函数里成立。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { platformOutputCap } from "./platform-output-cap"

const GW = "https://gw.example/v1"

describe("platformOutputCap —— 判据形状域", () => {
  test("平台节点(baseURL 逐字等于 ALPHA_BASE_URL)⇒ 不发 max_tokens", () => {
    expect(platformOutputCap({ providerBaseURL: GW, alphaBaseURL: GW })).toEqual({ omit: true, reason: "platform-gateway" })
  })
  test("直连 BYOK / 自定义节点(baseURL 不同)⇒ 保持上游行为", () => {
    expect(platformOutputCap({ providerBaseURL: "https://open.bigmodel.cn/api/paas/v4", alphaBaseURL: GW })).toEqual({
      omit: false,
      reason: "not-platform-provider",
    })
  })
  test("ALPHA_BASE_URL 缺席 / 空串 ⇒ 没有平台节点可言,任何 baseURL 都不省略(fail-closed 到上游行为)", () => {
    expect(platformOutputCap({ providerBaseURL: GW, alphaBaseURL: undefined })).toEqual({ omit: false, reason: "no-alpha-base-url" })
    expect(platformOutputCap({ providerBaseURL: GW, alphaBaseURL: "" })).toEqual({ omit: false, reason: "no-alpha-base-url" })
  })
  test("严格相等:尾斜杠 / 大小写 / 非字符串 baseURL 都不算平台节点(注入侧写的是逐字同一串)", () => {
    expect(platformOutputCap({ providerBaseURL: `${GW}/`, alphaBaseURL: GW }).omit).toBe(false)
    expect(platformOutputCap({ providerBaseURL: GW.toUpperCase(), alphaBaseURL: GW }).omit).toBe(false)
    expect(platformOutputCap({ providerBaseURL: undefined, alphaBaseURL: GW }).omit).toBe(false)
    expect(platformOutputCap({ providerBaseURL: 42, alphaBaseURL: GW }).omit).toBe(false)
  })
})

describe("真 AlphaExt 的 chat.params 钩子", () => {
  let root = ""
  let savedBase: string | undefined
  let savedGlobal: string | undefined
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-outcap-")))
    const global = join(root, "global", "env", "dev")
    mkdirSync(global, { recursive: true })
    mkdirSync(join(root, "project"), { recursive: true })
    savedBase = process.env.ALPHA_BASE_URL
    savedGlobal = process.env.ALPHA_GLOBAL_DIR
    process.env.ALPHA_GLOBAL_DIR = global
  })
  afterEach(() => {
    if (savedBase === undefined) delete process.env.ALPHA_BASE_URL
    else process.env.ALPHA_BASE_URL = savedBase
    if (savedGlobal === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = savedGlobal
    rmSync(root, { recursive: true, force: true })
  })

  type ChatParams = (
    input: { sessionID: string; agent: string; model: unknown; provider: { options?: Record<string, unknown> }; message: unknown },
    output: { temperature?: number; topP?: number; topK?: number; maxOutputTokens: number | undefined; options: Record<string, unknown> },
  ) => Promise<void>

  const load = async () => {
    const { AlphaExt } = await import("./plugin")
    const hooks = await AlphaExt({
      directory: join(root, "project"),
      worktree: join(root, "project"),
      client: { instance: { dispose: async () => {} } },
    } as unknown as Parameters<typeof AlphaExt>[0])
    const hook = (hooks as unknown as Record<string, unknown>)["chat.params"]
    expect(typeof hook).toBe("function")
    return hook as ChatParams
  }
  const call = async (hook: ChatParams, baseURL: string) => {
    const output = { temperature: 0.6, topP: 0.95, topK: 20, maxOutputTokens: 32000 as number | undefined, options: { reasoningEffort: "high" } }
    await hook({ sessionID: "s", agent: "build", model: {}, provider: { options: { baseURL, apiKey: "sk" } }, message: {} }, output)
    return output
  }

  test("平台节点:maxOutputTokens 置 undefined,其它参数原样", async () => {
    process.env.ALPHA_BASE_URL = GW
    const out = await call(await load(), GW)
    expect(out.maxOutputTokens).toBeUndefined()
    expect({ temperature: out.temperature, topP: out.topP, topK: out.topK, options: out.options }).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      options: { reasoningEffort: "high" },
    })
  })
  // REQ-156 起这句话有了前提:直连 BYOK 节点**没有读数时**才停在 32000 —— 有读数的由
  // `byok-output-cap.ts` 抬到该模型实读上限(见 byok-output-cap.test.ts)。这里的 `model: {}`
  // 取不到 providerID/api.id ⇒ 查不到读数 ⇒ 走的正是「无读数」那一支。
  test("直连 BYOK 节点:本模块不省略;无读数时仍是上游的 32000", async () => {
    process.env.ALPHA_BASE_URL = GW
    const out = await call(await load(), "https://api.deepseek.com/v1")
    expect(out.maxOutputTokens).toBe(32000)
  })
  test("无 ALPHA_BASE_URL(未登录 / 无网关):谁都不省略", async () => {
    delete process.env.ALPHA_BASE_URL
    const out = await call(await load(), GW)
    expect(out.maxOutputTokens).toBe(32000)
  })
})
