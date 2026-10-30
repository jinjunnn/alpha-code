// REQ-236 AC3(`#1562`)—— 平台模型请求的凭据在请求边界现读;读不到 ⇒ 抛 `@ai-sdk/provider` 的 `LoadAPIKeyError`
// (引擎归为 ProviderAuthError,请求不发出),绝不回落。两层:①纯判据 platformCredentialHeader;②真 AlphaExt 的
// `chat.headers` 钩子(与引擎装它的方式同款),证明判据接在钩子上。端到端(真引擎、网关零请求)在 ui-mac
// token-hot-apply.engine.test.ts。令牌用可识别哨兵串,任何错误消息里都不得出现它或文件路径。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoadAPIKeyError } from "@ai-sdk/provider"
import { platformCredentialHeader } from "./platform-credential-header"

const GW = "https://gw.example/v1"
const SENTINEL = "SENTINEL-PLATFORM-CREDENTIAL-41b7"

let root = ""
let keyFile = ""
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-credhdr-")))
  keyFile = join(root, "alpha-secrets", "ALPHA_API_KEY")
  mkdirSync(join(root, "alpha-secrets"), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const envWith = (ref: string | undefined) => ({ ALPHA_BASE_URL: GW, ALPHA_PLATFORM_AUTH_REF: ref })

/** 抛出的必须是 LoadAPIKeyError(按 SDK 自己的 isInstance 认),且消息不带令牌、不带路径。 */
function expectLoadApiKeyError(run: () => unknown) {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(LoadAPIKeyError.isInstance(thrown)).toBe(true)
  const message = (thrown as Error).message
  expect(message).not.toContain(SENTINEL)
  expect(message).not.toContain(root)
}

describe("platformCredentialHeader —— 判据", () => {
  test("平台节点 + 文件在 ⇒ 每次调用现读文件,换文件后立刻是新值", () => {
    writeFileSync(keyFile, `${SENTINEL}-A\n`)
    const env = envWith(`{file:${keyFile}}`)
    expect(platformCredentialHeader({ providerBaseURL: GW, env })).toBe(`Bearer ${SENTINEL}-A`)
    writeFileSync(keyFile, `${SENTINEL}-B`)
    expect(platformCredentialHeader({ providerBaseURL: GW, env })).toBe(`Bearer ${SENTINEL}-B`)
  })

  test("文件缺席 / 为空 ⇒ LoadAPIKeyError,不回落任何值", () => {
    const env = envWith(`{file:${keyFile}}`)
    expectLoadApiKeyError(() => platformCredentialHeader({ providerBaseURL: GW, env }))
    writeFileSync(keyFile, "  \n")
    expectLoadApiKeyError(() => platformCredentialHeader({ providerBaseURL: GW, env }))
  })

  test("引用缺席 / 不是 {file:} 形状(哪怕是一个字面令牌)⇒ LoadAPIKeyError,字面值绝不当凭据发出", () => {
    writeFileSync(keyFile, SENTINEL)
    expectLoadApiKeyError(() => platformCredentialHeader({ providerBaseURL: GW, env: envWith(undefined) }))
    expectLoadApiKeyError(() => platformCredentialHeader({ providerBaseURL: GW, env: envWith(SENTINEL) }))
    expectLoadApiKeyError(() => platformCredentialHeader({ providerBaseURL: GW, env: envWith(`prefix {file:${keyFile}}`) }))
  })

  test("非平台节点(BYOK / 自定义 / 无 ALPHA_BASE_URL)⇒ 不动请求头,也不读文件", () => {
    let reads = 0
    const readFile = () => {
      reads++
      return SENTINEL
    }
    const ref = `{file:${keyFile}}`
    expect(platformCredentialHeader({ providerBaseURL: "https://api.deepseek.com/v1", env: envWith(ref), readFile })).toBeUndefined()
    expect(platformCredentialHeader({ providerBaseURL: GW, env: { ALPHA_PLATFORM_AUTH_REF: ref }, readFile })).toBeUndefined()
    expect(platformCredentialHeader({ providerBaseURL: undefined, env: envWith(ref), readFile })).toBeUndefined()
    expect(reads).toBe(0)
  })
})

describe("真 AlphaExt 的 chat.headers 钩子", () => {
  let saved: Record<string, string | undefined> = {}
  const KEYS = ["ALPHA_BASE_URL", "ALPHA_GLOBAL_DIR", "ALPHA_PLATFORM_AUTH_REF"]
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    const global = join(root, "global", "env", "dev")
    mkdirSync(global, { recursive: true })
    mkdirSync(join(root, "project"), { recursive: true })
    process.env.ALPHA_GLOBAL_DIR = global
    process.env.ALPHA_BASE_URL = GW
    process.env.ALPHA_PLATFORM_AUTH_REF = `{file:${keyFile}}`
  })
  afterEach(() => {
    KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    })
  })

  type ChatHeaders = (
    input: { sessionID: string; agent: string; model: unknown; provider: { options?: Record<string, unknown> }; message: unknown },
    output: { headers: Record<string, string> },
  ) => Promise<void>

  const load = async () => {
    const { AlphaExt } = await import("./plugin")
    const hooks = await AlphaExt({
      directory: join(root, "project"),
      worktree: join(root, "project"),
      client: { instance: { dispose: async () => {} } },
    } as unknown as Parameters<typeof AlphaExt>[0])
    const hook = (hooks as unknown as Record<string, unknown>)["chat.headers"]
    expect(typeof hook).toBe("function")
    return hook as ChatHeaders
  }
  const call = async (hook: ChatHeaders, baseURL: string) => {
    const output = { headers: {} as Record<string, string> }
    await hook({ sessionID: "s", agent: "build", model: {}, provider: { options: { baseURL, apiKey: "placeholder" } }, message: {} }, output)
    return output.headers
  }

  test("平台节点:写请求级 authorization;文件删掉后钩子抛 LoadAPIKeyError(请求被终止)", async () => {
    writeFileSync(keyFile, SENTINEL)
    const hook = await load()
    expect(await call(hook, GW)).toEqual({ authorization: `Bearer ${SENTINEL}` })
    rmSync(keyFile)
    const thrown = await call(hook, GW).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(LoadAPIKeyError.isInstance(thrown)).toBe(true)
    expect(String((thrown as Error).message)).not.toContain(SENTINEL)
  })

  test("直连 BYOK 节点:钩子不碰请求头", async () => {
    writeFileSync(keyFile, SENTINEL)
    expect(await call(await load(), "https://api.deepseek.com/v1")).toEqual({})
  })
})
