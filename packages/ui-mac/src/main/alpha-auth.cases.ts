import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test, vi } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContractIncompatibleError, type RoutePurpose } from "@alpha-code/contracts-consumer"
import { createAuthedGet } from "./alpha-account-request"
import { deepLinkFor } from "../shared/route-manifest"

const logger = { log: () => {}, warn: () => {}, error: () => {} }
// R1 Major4:DEV_PLATFORM_TOKEN 只该在非 packaged 构建生效;测试要能翻这个开关。
let packagedBuild = false
// alpha-web#283 AC3:startAuth 交给浏览器的授权地址(断言 client_id / redirect_uri 用)。
const openedUrls: string[] = []

mock.module("electron", () => ({
  app: {
    getVersion: () => "9.9.9",
    getPath: () => "/tmp",
    getName: () => "alpha-code",
    get isPackaged() {
      return packagedBuild
    },
    on: () => {},
    off: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    isDestroyed() {
      return false
    }

    static getAllWindows() {
      return []
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox: () => {},
  },
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: {
    openExternal: async (url: string) => {
      openedUrls.push(url)
    },
    showItemInFolder: () => {},
  },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
}))
mock.module("./logging", () => ({
  getLogger: () => logger,
  initLogging: () => logger,
  initCrashReporter: () => {},
  startNetLog: async () => {},
  exportDebugLogs: async () => "",
  write: () => {},
  tail: () => "",
  serverLogRoots: () => [],
  rotateServerLogs: () => {},
}))

const {
  PlatformAccessTokenBundleError,
  applyAuthEnv,
  decodeTokenResponse,
  getAccessToken,
  getArchiveAccessToken,
  getAuthIdentityTag,
  getAuthRenewalTiming,
  getAuthState,
  getTokenGeneration,
  handleAuthDeepLink,
  initAuthEnv,
  getAuthIdentityEpoch,
  isStoredTokenExpired,
  ensureFreshToken,
  logout,
  markTokenGenerationApplied,
  refreshTokens,
  setAuthDeps,
  startAuth,
} = await import("./alpha-auth")

const PURPOSES = [
  "model.invoke",
  "cloud.dispatch",
  "cloud.read",
  "artifact.read",
  "account.read",
] as const satisfies readonly RoutePurpose[]
const MANAGED_ENV = [
  "ALPHA_API_KEY",
  "ALPHA_CLOUD_TOKEN",
  "ALPHA_MCP_TOKEN",
  "ALPHA_BASE_URL",
  "ALPHA_CLOUD_MCP_URL",
  "DEV_PLATFORM_TOKEN",
] as const
const originalFetch = globalThis.fetch
const savedEnv: Partial<Record<(typeof MANAGED_ENV)[number], string>> = {}
let dataPath = ""
let structuralRespawns = 0
let renewedGenerations: number[] = []

function jwt(purpose: RoutePurpose, generation = "old", sub = "tenant-a") {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
    JSON.stringify({
      schema_version: 1,
      iss: "codepuppy-web",
      aud: "codepuppy-platform-api",
      sub,
      token_use: "platform_access",
      purpose,
      scope: [purpose],
      iat: 1,
      exp: 2,
      jti: `${generation}-${purpose}`,
    }),
  ).toString("base64url")}.signature`
}

function tokenBundle(generation = "old", sub = "tenant-a") {
  return {
    "model.invoke": jwt("model.invoke", generation, sub),
    "cloud.dispatch": jwt("cloud.dispatch", generation, sub),
    "cloud.read": jwt("cloud.read", generation, sub),
    "artifact.read": jwt("artifact.read", generation, sub),
    "account.read": jwt("account.read", generation, sub),
  }
}

/** 落一份凭据再像冷启动一样恢复。缺省 `clientId: "codepuppy"` = 已经用当前客户端 id 刷新过(迁移完成后的
 *  常态);`clientId: null` = 0.1.24 及更早写下、没有这个字段的凭据(alpha-web#283 AC4 的起点)。 */
function storeAuth(value: {
  platformAccessTokens?: Partial<Record<RoutePurpose, string>>
  mcpAccessToken?: string
  archiveAccessToken?: string
  refreshToken?: string
  sessionId?: string
  expiresAt?: number
  lifetimeMs?: number
  mode?: "byok" | "platform"
  clientId?: string | null
}) {
  const { clientId = "codepuppy", ...rest } = value
  writeFileSync(
    join(dataPath, "alpha-auth.json"),
    JSON.stringify({
      v: 1,
      plain: JSON.stringify({ mode: "platform", ...rest, ...(clientId === null ? {} : { clientId }) }),
    }),
  )
  initAuthEnv(dataPath)
}

function captureBundleError(value: unknown) {
  try {
    decodeTokenResponse(value)
  } catch (error) {
    if (error instanceof PlatformAccessTokenBundleError) return error
    throw error
  }
  throw new Error("expected platform_access_tokens bundle rejection")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** 捕获 main → renderer 的 auth 推送。`platformStatuses` 记录每次 auth-state 的平台态,
 *  用来断言「ready 什么时候被发布」而不是只断言最终值。 */
function fakeWindow(sends: string[], platformStatuses: (string | undefined)[] = []) {
  return windowWith((channel, payload) => {
    sends.push(channel)
    if (channel === "auth-state" && isRecord(payload))
      platformStatuses.push(typeof payload.platformStatus === "string" ? payload.platformStatus : undefined)
  })
}

/** 测试替身窗口的唯一断言点(其余用例都经 fakeWindow / windowWith,不再各自 cast)。 */
function windowWith(send: (channel: string, payload?: unknown) => void) {
  return { isDestroyed: () => false, webContents: { send } } as unknown as ReturnType<
    Parameters<typeof setAuthDeps>[0]["getWindow"]
  >
}

function jsonResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

function readStoredAuth() {
  const envelope: unknown = JSON.parse(readFileSync(join(dataPath, "alpha-auth.json"), "utf8"))
  if (!isRecord(envelope) || typeof envelope.plain !== "string") throw new Error("invalid stored auth envelope")
  const auth: unknown = JSON.parse(envelope.plain)
  if (!isRecord(auth)) throw new Error("invalid stored auth payload")
  return auth
}

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), "alpha-auth-"))
  structuralRespawns = 0
  renewedGenerations = []
  setAuthDeps({
    getWindow: () => null,
    respawn: () => {
      structuralRespawns++
    },
    // REQ-236 `#1562`:续期提交后同步热应用;renewedGenerations = 被热应用的 token 代。
    applyCredentials: () => {
      renewedGenerations.push(getTokenGeneration())
      return "applied"
    },
  })
  MANAGED_ENV.forEach((key) => {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  })
  globalThis.fetch = originalFetch
})

afterEach(() => {
  setSystemTime()
  vi.useRealTimers()
  MANAGED_ENV.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  })
  globalThis.fetch = originalFetch
  rmSync(dataPath, { recursive: true, force: true })
})

describe("purpose-keyed platform access token response", () => {
  test("accepts and preserves a complete validated bundle with optional identity metadata absent", () => {
    const bundle = tokenBundle()
    expect(
      decodeTokenResponse({
        token_type: "Bearer",
        platform_access_tokens: bundle,
        refresh_token: "refresh-old",
        expires_in: 3600,
        refresh_expires_in: 7200,
        session_id: "session-old",
      }),
    ).toEqual({
      platform_access_tokens: bundle,
      refresh_token: "refresh-old",
      expires_in: 3600,
      session_id: "session-old",
    })
  })

  test("missing required purpose fails with the distinct bundle error", () => {
    const bundle: Partial<Record<RoutePurpose, string>> = tokenBundle()
    delete bundle["account.read"]
    const error = captureBundleError({ platform_access_tokens: bundle })
    expect(error.reason).toBe("missing-required-purpose")
    expect(error.purpose).toBe("account.read")
    expect("failure" in error).toBe(false)
  })

  test("a valid token filed under another purpose key is rejected as a bundle mismatch", () => {
    const bundle = tokenBundle()
    bundle["cloud.dispatch"] = jwt("model.invoke")
    const error = captureBundleError({ platform_access_tokens: bundle })
    expect(error.reason).toBe("purpose-key-mismatch")
    expect(error.purpose).toBe("cloud.dispatch")
  })

  test.each([
    [{}, "missing-bundle"],
    [{ platform_access_tokens: {} }, "empty-bundle"],
  ] as const)("absent or empty bundle fails closed with reason %s", (value, reason) => {
    expect(captureBundleError(value).reason).toBe(reason)
  })

  // ── platform#177 cross-repository regressions ───────────────────────────────────────────────
  // The wire vocabulary grew a sixth purpose (`account.keys.manage`). alpha-web deliberately does
  // NOT put it in the bundle, and these two cases pin the two halves of why that matters, from
  // the consumer side — the only side that can say what an installed desktop actually tolerates.

  test("a sixth purpose in the bundle is rejected — the vocabulary may grow, this bundle may not", () => {
    // If alpha-web ever derives the bundle from the purpose enum again, every shipped copy of this
    // application fails at login with exactly this error. Written as a test here so the fact lives
    // where the strictness lives, not only in the issuer's comments.
    const bundle: Record<string, string> = tokenBundle()
    bundle["account.keys.manage"] = jwt("model.invoke")
    const error = captureBundleError({ platform_access_tokens: bundle })
    expect(error.reason).toBe("unknown-purpose")
    // Measured while writing this: `unknown-purpose` is the ONE bundle error thrown without the
    // offending key, so a login broken this way says "unknown-purpose" and nothing else. Asserted
    // as the current fact rather than quietly wished otherwise — improving it is its own change.
    expect(error.purpose).toBeUndefined()
  })

  test("an extra TOP-LEVEL key is tolerated — the strictness is inside the bundle, not around it", () => {
    // Measured, not assumed: the ticket for this change said "one extra key kills the published
    // desktop", and reading `decodeTokenResponse` shows that is only true INSIDE
    // `platform_access_tokens`. alpha-web's third-party path returns a top-level `access_token` on
    // its own branch; pinning today's tolerance here keeps the next review from re-deriving it.
    const bundle = tokenBundle()
    expect(
      decodeTokenResponse({
        token_type: "Bearer",
        access_token: "a-token-for-somebody-else",
        scope: "openid profile",
        platform_access_tokens: bundle,
        refresh_token: "refresh-old",
        expires_in: 3600,
        refresh_expires_in: 7200,
        session_id: "session-old",
      }),
    ).toEqual({
      platform_access_tokens: bundle,
      refresh_token: "refresh-old",
      expires_in: 3600,
      session_id: "session-old",
    })
  })

  test("`#1195` optional top-level mcp_access_token: absent is legal, present rides through opaquely", () => {
    const bundle = tokenBundle()
    // 缺席 ⇒ 结果里没有这个键(不是 undefined 值,是不存在)。
    expect("mcp_access_token" in decodeTokenResponse({ platform_access_tokens: bundle })).toBe(false)
    // 在场 ⇒ 不透明传递:不是 JWT 也照收(decodeTokenClaims 钉的是 platform_access,
    // 对本 token 结构性不适用;真伪由 RS 验)。
    expect(
      decodeTokenResponse({ platform_access_tokens: bundle, mcp_access_token: "opaque-mcp-credential" }),
    ).toMatchObject({ mcp_access_token: "opaque-mcp-credential" })
  })

  test("`#1195` a present-but-broken mcp_access_token fails loud as a contract error, not a bundle error", () => {
    for (const broken of ["", 42, null, { token: "x" }]) {
      let thrown: unknown
      try {
        decodeTokenResponse({ platform_access_tokens: tokenBundle(), mcp_access_token: broken })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ContractIncompatibleError)
      expect(thrown).not.toBeInstanceOf(PlatformAccessTokenBundleError)
    }
  })

  test("malformed JWT remains a token-schema failure rather than masquerading as a bundle error", () => {
    const bundle = tokenBundle()
    bundle["artifact.read"] = "not-a-jwt"
    let thrown: unknown
    try {
      decodeTokenResponse({ platform_access_tokens: bundle })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ContractIncompatibleError)
    expect(thrown).not.toBeInstanceOf(PlatformAccessTokenBundleError)
  })
})

describe("stored bundle consumption", () => {
  test("applyAuthEnv maps only the matching bundle token onto each sidecar seam", () => {
    const bundle = tokenBundle()
    storeAuth({ platformAccessTokens: bundle })
    delete process.env.ALPHA_API_KEY
    delete process.env.ALPHA_CLOUD_TOKEN
    applyAuthEnv()
    expect(process.env.ALPHA_API_KEY).toBe(bundle["model.invoke"])
    expect(process.env.ALPHA_CLOUD_TOKEN).toBe(bundle["cloud.dispatch"])
  })

  test("`#1195` applyAuthEnv writes ALPHA_MCP_TOKEN from the stored opaque credential, and clears a stale one", () => {
    process.env.ALPHA_MCP_TOKEN = "stale-from-previous-identity"
    storeAuth({ platformAccessTokens: tokenBundle(), mcpAccessToken: "minted-mcp-token" })
    expect(process.env.ALPHA_MCP_TOKEN).toBe("minted-mcp-token")

    // 缺席 ⇒ 权威清除(A8 同款):不残留上一身份/上一信封的值。
    process.env.ALPHA_MCP_TOKEN = "stale-again"
    storeAuth({ platformAccessTokens: tokenBundle() })
    expect(process.env.ALPHA_MCP_TOKEN).toBeUndefined()

    // DEV_PLATFORM_TOKEN 不得顶进来:它是 platform_access 形状的静态短路,受众错了(I4)。
    process.env.DEV_PLATFORM_TOKEN = jwt("model.invoke", "dev")
    storeAuth({ platformAccessTokens: tokenBundle() })
    expect(process.env.ALPHA_MCP_TOKEN).toBeUndefined()
  })

  test("DEV_PLATFORM_TOKEN keeps precedence while still enforcing the requested purpose", () => {
    const bundle = tokenBundle()
    process.env.DEV_PLATFORM_TOKEN = jwt("model.invoke", "dev")
    storeAuth({ platformAccessTokens: bundle })
    expect(process.env.ALPHA_API_KEY).toBe(process.env.DEV_PLATFORM_TOKEN)
    expect(process.env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(getAccessToken("model.invoke")).toBe(process.env.DEV_PLATFORM_TOKEN)
    expect(() => getAccessToken("cloud.dispatch")).toThrow(ContractIncompatibleError)
  })

  test("getAccessToken selects by purpose, returns undefined when absent, and rejects a wrong-purpose stored entry", () => {
    const bundle: Partial<Record<RoutePurpose, string>> = tokenBundle()
    storeAuth({ platformAccessTokens: bundle })
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(bundle[purpose]))

    delete bundle["artifact.read"]
    storeAuth({ platformAccessTokens: bundle })
    expect(getAccessToken("artifact.read")).toBeUndefined()
    bundle["cloud.dispatch"] = jwt("model.invoke", "wrong")
    storeAuth({ platformAccessTokens: bundle })
    expect(() => getAccessToken("cloud.dispatch")).toThrow(ContractIncompatibleError)
  })

  test("login and expiry require a complete bundle and use its shared expiresAt", () => {
    const bundle: Partial<Record<RoutePurpose, string>> = tokenBundle()
    storeAuth({ platformAccessTokens: bundle, expiresAt: 1 })
    expect(getAuthState()).toMatchObject({ status: "logged-in", expiresAt: 1, platformStatus: "recovering" })
    expect(isStoredTokenExpired()).toBe(true)

    storeAuth({ platformAccessTokens: bundle, expiresAt: Date.now() + 60_000 })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "ready" })

    delete bundle["cloud.read"]
    storeAuth({ platformAccessTokens: bundle, expiresAt: 1 })
    expect(getAuthState()).toMatchObject({ status: "logged-out", expiresAt: 1 })
    expect(isStoredTokenExpired()).toBe(false)
  })
})

describe("refresh bundle rotation", () => {
  test("validates the refreshed bundle before replacing every access token and the rotated refresh token", async () => {
    const oldBundle = tokenBundle()
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: oldBundle,
      refreshToken: "refresh-old",
      sessionId: "session-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON refresh request")
      const body: unknown = JSON.parse(init.body)
      if (!isRecord(body)) throw new Error("expected JSON refresh object")
      requestBody = body
      return new Response(
        JSON.stringify({
          token_type: "Bearer",
          platform_access_tokens: newBundle,
          refresh_token: "refresh-new",
          refresh_expires_in: 7200,
          expires_in: 3600,
          session_id: "session-new",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
    expect(renewedGenerations).toHaveLength(1)
    expect(requestBody).toMatchObject({
      grant_type: "refresh_token",
      client_id: "codepuppy",
      refresh_token: "refresh-old",
    })
    // #79 Breaking v1: the issuer rejects any refresh request carrying `sid`
    // (Object.hasOwn(body,"sid") → invalid_request 400). Lock that we never send it.
    expect(requestBody).not.toHaveProperty("sid")
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(newBundle[purpose]))
    expect(process.env.ALPHA_API_KEY).toBe(newBundle["model.invoke"])
    expect(process.env.ALPHA_CLOUD_TOKEN).toBe(newBundle["cloud.dispatch"])

    expect(readStoredAuth()).toMatchObject({
      platformAccessTokens: newBundle,
      refreshToken: "refresh-new",
      sessionId: "session-new",
      lifetimeMs: 3_600_000,
      clientId: "codepuppy",
    })
  })

  test("`#1195` refresh rotates the mcp credential with the envelope, and an envelope without it clears everything (I6)", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      mcpAccessToken: "mcp-old",
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    expect(process.env.ALPHA_MCP_TOKEN).toBe("mcp-old")

    // ① 信封带新值 ⇒ env 与持久态一起轮换。
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: tokenBundle("new"),
        mcp_access_token: "mcp-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
    expect(process.env.ALPHA_MCP_TOKEN).toBe("mcp-new")
    expect(readStoredAuth()).toMatchObject({ mcpAccessToken: "mcp-new" })

    // ② 信封缺席 ⇒ 整体清除,不保留旧值当回退(15 分钟 TTL 的旧值只会 401;I6 无回退)。
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: tokenBundle("newer"),
        refresh_token: "refresh-newer",
        expires_in: 3600,
      })) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
    expect(process.env.ALPHA_MCP_TOKEN).toBeUndefined()
    expect(readStoredAuth()).not.toMatchObject({ mcpAccessToken: expect.anything() })
  })

  test("`#1324` refresh rotates the archive credential with the envelope; an envelope without it clears it", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      archiveAccessToken: "archive-old",
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    // 这里读的是**持久态**,不是 getArchiveAccessToken():夹具的 expiresAt=1 已过期,而
    // `#1324` 起过期即当缺席(那条单独一格的用例在下面)。本条要判的是「轮换有没有发生」。
    expect(readStoredAuth()).toMatchObject({ archiveAccessToken: "archive-old" })

    // ① 信封带新值 ⇒ 持久态与读回一起轮换。
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: tokenBundle("new"),
        archive_access_token: "archive-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
    expect(getArchiveAccessToken()).toBe("archive-new")
    expect(readStoredAuth()).toMatchObject({ archiveAccessToken: "archive-new" })

    // ② 信封缺席 ⇒ 清除,不留旧值当回退 —— 留下来只会让每一次上报 401,而 401 是终态。
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: tokenBundle("newer"),
        refresh_token: "refresh-newer",
        expires_in: 3600,
      })) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
    expect(getArchiveAccessToken()).toBeUndefined()
    expect(readStoredAuth()).not.toMatchObject({ archiveAccessToken: expect.anything() })
  })

  test("`#1324` R2 账号标记:跨刷新稳定、随 sub 变、登出为 undefined —— 且**不**随 session_id 轮换", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      sessionId: "session-1",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    const first = getAuthIdentityTag()
    expect(typeof first).toBe("string")
    // 只做相等比较,所以存的是哈希 —— 游标文件里不出现 sub 原文。
    expect(first).not.toContain("tenant-a")

    // 刷新:同一个 sub、**换了** session_id 与整套令牌 ⇒ 标记必须一个字节都不变。
    // (拿 session_id 当标记的实现会在这里变,于是每 10 分钟把本账号的积压清一次。)
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: tokenBundle("new"),
        refresh_token: "refresh-new",
        session_id: "session-2",
        expires_in: 3600,
      })) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
    expect(readStoredAuth()).toMatchObject({ sessionId: "session-2" })
    expect(getAuthIdentityTag()).toBe(first!)

    // 换账号(换 sub)⇒ 标记必须变。
    storeAuth({ platformAccessTokens: tokenBundle("old", "tenant-b"), refreshToken: "r", expiresAt: 1, lifetimeMs: 1000 })
    const second = getAuthIdentityTag()
    expect(typeof second).toBe("string")
    expect(second).not.toBe(first)

    // 登出 ⇒ undefined(= 不知道是谁,不是「换了账号」)。
    await logout()
    expect(getAuthIdentityTag()).toBeUndefined()
  })

  test("`#1324` 已过期的 archive 凭证当**缺席**处理 —— 省掉那一发注定 401 的上报", () => {
    // 令牌 TTL 15 分钟、约 10 分钟刷一轮。睡眠唤醒之后、或一次刷新失败之后,凭证会处在
    // 「在场但已过期」的状态;拿它去发只会换回一串 401,而 401 那一格的止损在游标侧。
    const expired = Date.now() - 60_000
    storeAuth({
      platformAccessTokens: tokenBundle(),
      archiveAccessToken: "archive-stale",
      refreshToken: "refresh-old",
      expiresAt: expired,
      lifetimeMs: 900_000,
    })
    expect(isStoredTokenExpired()).toBe(true)
    expect(getArchiveAccessToken()).toBeUndefined()

    // 前提自证:同一份存储,只把有效期挪到未来,它就该拿得到 —— 否则这条断言分不清
    // 「因为过期」还是「这个读取器恒空」。
    storeAuth({
      platformAccessTokens: tokenBundle(),
      archiveAccessToken: "archive-stale",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 600_000,
      lifetimeMs: 900_000,
    })
    expect(isStoredTokenExpired()).toBe(false)
    expect(getArchiveAccessToken()).toBe("archive-stale")
  })

  test("`#1324` a present-but-empty archive_access_token is an issuer contract break, not an absence", () => {
    expect(() =>
      decodeTokenResponse({ platform_access_tokens: tokenBundle(), archive_access_token: "" }),
    ).toThrow()
    expect(() =>
      decodeTokenResponse({ platform_access_tokens: tokenBundle(), archive_access_token: 7 }),
    ).toThrow()
    // 缺席合法(签发端还没铸这个字段时就是缺席)。
    expect(decodeTokenResponse({ platform_access_tokens: tokenBundle() })).not.toHaveProperty(
      "archive_access_token",
    )
  })

  test("an incomplete refreshed bundle is rejected without replacing the last validated tokens", async () => {
    const oldBundle = tokenBundle()
    const incompleteBundle: Partial<Record<RoutePurpose, string>> = tokenBundle("incomplete")
    delete incompleteBundle["account.read"]
    storeAuth({
      platformAccessTokens: oldBundle,
      refreshToken: "refresh-old",
      sessionId: "session-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          platform_access_tokens: incompleteBundle,
          refresh_token: "must-not-store",
          expires_in: 3600,
          session_id: "must-not-store",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch

    expect(await refreshTokens()).toMatchObject({ outcome: "transient-failure" })
    expect(structuralRespawns).toBe(0)
    expect(renewedGenerations).toEqual([])
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(oldBundle[purpose]))
    expect(readStoredAuth()).toMatchObject({
      platformAccessTokens: oldBundle,
      refreshToken: "refresh-old",
      sessionId: "session-old",
    })
  })

  test("a rejected refresh is modeled as invalid-grant and keeps the existing logout semantics", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-revoked",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    globalThis.fetch = (async () => new Response("", { status: 400 })) as typeof fetch

    expect(await refreshTokens()).toMatchObject({ outcome: "invalid-grant" })
    expect(getAuthState().status).toBe("logged-out")
    expect(structuralRespawns).toBe(1)
    expect(renewedGenerations).toEqual([])
  })

  // #600 M1 → REQ-236 `#1562`:续期需要结构性重启(凭据在场性变化 / 热写失败)时,ready 只在捕获代 ≥ 本次续期代的
  // fork 健康完成后发布。两臂:直接确认;先来一个迟到的旧 fork(捕获旧代)—— 它不得确认,随后新 fork 才确认。
  test.each([false, true] as const)(
    "a structural renewal publishes ready only once a fork that captured it is confirmed (late old fork first=%p)",
    async (lateOldForkFirst) => {
      const newBundle = tokenBundle("new")
      storeAuth({
        platformAccessTokens: tokenBundle(),
        refreshToken: "refresh-old",
        expiresAt: 1,
        lifetimeMs: 1000,
      })
      const events: string[] = []
      const published: (string | undefined)[] = []
      setAuthDeps({
        getWindow: () => fakeWindow([], published),
        respawn: (trigger) => {
          events.push(`respawn:${trigger}`)
          published.push(`during-respawn:${getAuthState().platformStatus}`)
        },
        applyCredentials: () => "needs-structural",
      })
      globalThis.fetch = (async () =>
        jsonResponse({
          platform_access_tokens: newBundle,
          refresh_token: "refresh-new",
          expires_in: 3600,
        })) as typeof fetch

      const pending = refreshTokens().then((result) => {
        events.push("renewal:reported")
        return result
      })
      for (let tick = 0; tick < 200 && !events.includes("respawn:credential-change"); tick++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      // 重启在途:续期尚未回报,平台态是「恢复中」——即便 main 已经握着新 token。
      expect(events).toEqual(["respawn:credential-change"])
      expect(getAuthState().platformStatus).toBe("recovering")
      expect(published).not.toContain("ready")
      expect(published).toContain("during-respawn:recovering")

      const renewed = getTokenGeneration()
      if (lateOldForkFirst) {
        markTokenGenerationApplied(renewed - 1)
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(events).toEqual(["respawn:credential-change"])
        expect(getAuthState().platformStatus).toBe("recovering")
      }
      markTokenGenerationApplied(renewed)
      const result = await pending
      expect(events).toEqual(["respawn:credential-change", "renewal:reported"])
      expect(result).toMatchObject({ outcome: "refreshed", applied: true, generation: renewed })
      expect(getAuthState().platformStatus).toBe("ready")
      expect(published.indexOf("ready")).toBeGreaterThan(published.indexOf("recovering"))
      expect(renewedGenerations).toEqual([])
    },
  )

  // 结构性确认不是终局:有界等待超时后如实回 applied:false,此后那次 fork 健康完成仍会把平台面带回 ready。
  test("a confirmation that lands after the bounded wait still clears the recovering platform state", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        structuralRespawns++
      },
      applyCredentials: () => "needs-structural",
    })
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    vi.useFakeTimers()
    const pending = refreshTokens()
    for (let tick = 0; tick < 50 && structuralRespawns === 0; tick++) await Promise.resolve()
    expect(structuralRespawns).toBe(1)
    for (let tick = 0; tick < 50; tick++) await Promise.resolve()
    vi.advanceTimersByTime(10_000)
    const result = await pending
    vi.useRealTimers()
    expect(result).toMatchObject({ outcome: "refreshed", applied: false })
    expect(getAuthState().platformStatus).toBe("recovering")

    markTokenGenerationApplied(result.generation)
    expect(getAuthState().platformStatus).toBe("ready")
  })

  // #1543 AC1:续期因网络错误失败 ⇒ 登录态带 refreshUnreachable,且**只翻这一位也必须推送**(publish 的
  // 去重签名若漏了它,renderer 永远看不到「续不上」);随后续期成功 ⇒ 标记消失并再次推送。
  test("#1543 a network-failed refresh publishes refreshUnreachable; the next successful refresh clears it", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    const pushed: unknown[] = []
    setAuthDeps({
      getWindow: () =>
        windowWith((channel, payload) => {
          if (channel === "auth-state") pushed.push(payload)
        }),
      respawn: () => {
        structuralRespawns++
      },
      applyCredentials: () => "applied",
    })
    // 尚未失败过:恢复中,但不是「续不上」。
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
    expect(getAuthState()).not.toHaveProperty("refreshUnreachable")

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "transient-failure" })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering", refreshUnreachable: true })
    expect(pushed.at(-1)).toMatchObject({ platformStatus: "recovering", refreshUnreachable: true })

    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: tokenBundle("new"),
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch
    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed", applied: true })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "ready" })
    expect(getAuthState()).not.toHaveProperty("refreshUnreachable")
    expect(pushed.at(-1)).toMatchObject({ platformStatus: "ready" })
    expect(pushed.at(-1)).not.toHaveProperty("refreshUnreachable")
    expect(structuralRespawns).toBe(0)
  })

  test("ensureFreshToken models a not-due token as still-valid without network or respawn", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-current",
      expiresAt: Date.now() + 15 * 60_000,
      lifetimeMs: 15 * 60_000,
    })
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      throw new Error("unexpected fetch")
    }) as typeof fetch

    expect(await ensureFreshToken()).toMatchObject({ outcome: "still-valid" })
    expect(requests).toBe(0)
    expect(structuralRespawns).toBe(0)
    expect(renewedGenerations).toEqual([])
  })
})

// alpha-web#283(REQ-236)AC3 / AC4:登录客户端改为 `codepuppy`、回调 `codepuppy://auth/callback`;
// 0.1.24 及更早写下的凭据(没有 clientId 标记)在任何平台调用之前先用新 id 强制刷新一次。
// 「任何平台调用」在本模块里的咽喉只有三处:applyAuthEnv 写给引擎的 env、getAccessToken、getArchiveAccessToken
// —— 下面逐个断言它们在刷新前拿不到旧令牌。
describe("alpha-web#283 client id cut-over", () => {
  function servePlatformRefresh(bundle: Record<RoutePurpose, string>, bodies: Record<string, unknown>[]) {
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON refresh request")
      const body: unknown = JSON.parse(init.body)
      if (!isRecord(body)) throw new Error("expected JSON refresh object")
      bodies.push(body)
      return jsonResponse({
        platform_access_tokens: bundle,
        mcp_access_token: "mcp-new",
        archive_access_token: "archive-new",
        refresh_token: "refresh-new",
        expires_in: 900,
        session_id: "session-new",
      })
    }) as typeof fetch
  }

  function storeLegacyCredentials() {
    storeAuth({
      platformAccessTokens: tokenBundle("old"),
      mcpAccessToken: "mcp-old",
      archiveAccessToken: "archive-old",
      refreshToken: "refresh-old",
      // 旧 access token 还远没到续期窗口 —— 只按到期时间判断的启动续期会跳过它。
      expiresAt: Date.now() + 14 * 60_000,
      lifetimeMs: 15 * 60_000,
      clientId: null,
    })
  }

  // 回调地址只经路由清单取(本文件不写 scheme 字面量 —— route-authority-ratchet 守这一条);
  // 它的值是 `codepuppy://auth/callback`、旧 scheme 不再属于登录,由 route-manifest.test.ts 钉住。
  test("login asks for client codepuppy with the manifest callback and records the client marker", async () => {
    initAuthEnv(dataPath)
    openedUrls.length = 0
    const exchanges: Record<string, unknown>[] = []
    servePlatformRefresh(tokenBundle("login"), exchanges)
    await startAuth()
    const authorize = new URL(openedUrls.at(-1)!)
    expect(authorize.searchParams.get("client_id")).toBe("codepuppy")
    expect(authorize.searchParams.get("redirect_uri")).toBe(deepLinkFor.authCallback())
    const pkce: unknown = JSON.parse(readFileSync(join(dataPath, "alpha-pkce.json"), "utf8"))
    if (!isRecord(pkce) || typeof pkce.state !== "string") throw new Error("expected a persisted pkce state")
    const callback = new URL(deepLinkFor.authCallback())
    callback.searchParams.set("code", "code-1")
    callback.searchParams.set("state", pkce.state)
    expect(handleAuthDeepLink(callback.toString())).toBe(true)
    for (let tick = 0; tick < 500 && getAuthState().status !== "logged-in"; tick++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(exchanges).toEqual([
      expect.objectContaining({
        grant_type: "authorization_code",
        client_id: "codepuppy",
        redirect_uri: deepLinkFor.authCallback(),
      }),
    ])
    expect(readStoredAuth()).toMatchObject({ clientId: "codepuppy" })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "ready" })
  })

  test("credentials from the previous client are withheld from every platform seam until the forced refresh", async () => {
    storeLegacyCredentials()
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
    expect(isStoredTokenExpired()).toBe(true)
    expect(process.env.ALPHA_API_KEY).toBeUndefined()
    expect(process.env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(process.env.ALPHA_MCP_TOKEN).toBeUndefined()
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBeUndefined())
    expect(getArchiveAccessToken()).toBeUndefined()
    // 调度器视之为立即到期:开机那次刷新若失败,按地板节奏重试,而不是等旧令牌走到续期窗口。
    expect(getAuthRenewalTiming()).toMatchObject({ active: true, expiresAt: undefined })
  })

  test("the first ensureFreshToken refreshes with the new client id even though the old token is not due", async () => {
    storeLegacyCredentials()
    const fresh = tokenBundle("new")
    const bodies: Record<string, unknown>[] = []
    servePlatformRefresh(fresh, bodies)

    expect(await ensureFreshToken()).toMatchObject({ outcome: "refreshed" })
    expect(bodies).toEqual([{ grant_type: "refresh_token", client_id: "codepuppy", refresh_token: "refresh-old" }])
    expect(process.env.ALPHA_API_KEY).toBe(fresh["model.invoke"])
    expect(process.env.ALPHA_CLOUD_TOKEN).toBe(fresh["cloud.dispatch"])
    expect(process.env.ALPHA_MCP_TOKEN).toBe("mcp-new")
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(fresh[purpose]))
    expect(getArchiveAccessToken()).toBe("archive-new")
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "ready" })
    expect(readStoredAuth()).toMatchObject({ clientId: "codepuppy", refreshToken: "refresh-new" })

    // 一次性:标记已落盘,同一进程与冷启动后都按到期时间正常续期,不再强制。
    expect(await ensureFreshToken()).toMatchObject({ outcome: "still-valid" })
    initAuthEnv(dataPath)
    expect(isStoredTokenExpired()).toBe(false)
    expect(await ensureFreshToken()).toMatchObject({ outcome: "still-valid" })
    expect(bodies).toHaveLength(1)
  })

  test("a rejected forced refresh takes the existing login-failure path instead of keeping the old tokens", async () => {
    storeLegacyCredentials()
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch

    expect(await ensureFreshToken()).toMatchObject({ outcome: "invalid-grant" })
    expect(getAuthState()).toMatchObject({ status: "logged-out" })
    expect(process.env.ALPHA_API_KEY).toBeUndefined()
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBeUndefined())
  })

  test("a transient or contract-incompatible forced refresh keeps the platform recovering on no token at all", async () => {
    storeLegacyCredentials()
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    expect(await ensureFreshToken()).toMatchObject({ outcome: "transient-failure" })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
    expect(process.env.ALPHA_API_KEY).toBeUndefined()
    expect(getAccessToken("account.read")).toBeUndefined()

    // 签发端若还在发旧 iss 的令牌(网站没切过去),decoder 拒收,旧凭据照样不放出来。
    const previousIssuer = Object.fromEntries(
      PURPOSES.map((purpose) => {
        const [header, payload, signature] = jwt(purpose, "stale-issuer").split(".")
        const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))
        const legacy = Buffer.from(JSON.stringify({ ...claims, iss: "alpha-web", aud: "alpha-platform-api" }))
        return [purpose, `${header}.${legacy.toString("base64url")}.${signature}`]
      }),
    ) as Record<RoutePurpose, string>
    servePlatformRefresh(previousIssuer, [])
    expect(await ensureFreshToken()).toMatchObject({ outcome: "transient-failure" })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
    expect(process.env.ALPHA_API_KEY).toBeUndefined()
    expect(getAccessToken("account.read")).toBeUndefined()
    expect(readStoredAuth()).not.toHaveProperty("clientId")
  })
})

// #602 B4:旧 refresh 响应必须在提交前做 CAS。此前 doRefresh() 直接 `...stored` 写回,
// 在途期间的 logout 会被复活,新账号登录会被账号 A 的 token 覆盖(UI 显示 B、bearer 是 A)。
describe("refresh compare-and-set before commit", () => {
  test("a refresh in flight is discarded when logout changes the auth generation", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      mcpAccessToken: "mcp-live", // #1195:让下面的 logout 断言真的有值可清
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    const sends: string[] = []
    setAuthDeps({
      getWindow: () => fakeWindow(sends),
      respawn: () => {
        structuralRespawns++
      },
      applyCredentials: () => {
        renewedGenerations.push(getTokenGeneration())
        return "applied"
      },
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async () => {
      await gate
      return jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        session_id: "session-new",
        expires_in: 3600,
      })
    }) as typeof fetch

    const pending = refreshTokens()
    await logout()
    const publishedByLogout = sends.length
    release()

    expect(await pending).toMatchObject({ outcome: "transient-failure" })
    expect(getAuthState().status).toBe("logged-out")
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBeUndefined())
    expect(process.env.ALPHA_API_KEY).toBeUndefined()
    expect(process.env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(process.env.ALPHA_MCP_TOKEN).toBeUndefined() // #1195:登出同样清 mcp 凭证 env
    // 丢弃 = 不持久化、不发布、不换血(structural respawn 只有 logout 自己那一次)
    expect(readStoredAuth()).toEqual({ mode: "byok" })
    expect(sends.length).toBe(publishedByLogout)
    expect(structuralRespawns).toBe(1)
    expect(renewedGenerations).toEqual([])
  })

  test("a refresh in flight never overwrites the account that logged in while it was open", async () => {
    const staleBundle = tokenBundle("stale")
    const nextBundle = tokenBundle("next")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-a",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async (_input, init) => {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (isRecord(body) && body.grant_type === "refresh_token") {
        await gate
        return jsonResponse({
          platform_access_tokens: staleBundle,
          refresh_token: "refresh-a2",
          session_id: "session-a2",
          expires_in: 3600,
          email: "a@example.invalid",
        })
      }
      return jsonResponse({
        platform_access_tokens: nextBundle,
        refresh_token: "refresh-b",
        session_id: "session-b",
        expires_in: 3600,
        email: "b@example.invalid",
        plan: "pro",
      })
    }) as typeof fetch

    const pending = refreshTokens()
    await startAuth()
    const pkce: unknown = JSON.parse(readFileSync(join(dataPath, "alpha-pkce.json"), "utf8"))
    if (!isRecord(pkce) || typeof pkce.state !== "string") throw new Error("expected a persisted pkce state")
    const callback = new URL(deepLinkFor.authCallback())
    callback.searchParams.set("code", "code-b")
    callback.searchParams.set("state", pkce.state)
    expect(handleAuthDeepLink(callback.toString())).toBe(true)
    for (let tick = 0; tick < 500 && getAuthState().account?.email !== "b@example.invalid"; tick++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(getAuthState().account?.email).toBe("b@example.invalid")

    release()
    expect(await pending).toMatchObject({ outcome: "transient-failure" })
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(nextBundle[purpose]))
    expect(process.env.ALPHA_API_KEY).toBe(nextBundle["model.invoke"])
    expect(getAuthState().account).toEqual({ email: "b@example.invalid", plan: "pro" })
    expect(readStoredAuth()).toMatchObject({
      platformAccessTokens: nextBundle,
      refreshToken: "refresh-b",
      sessionId: "session-b",
    })
    // REQ-236 `#1562`:换号之后到达的旧账号续期结果不得热写凭据文件 —— 续期写入不晚于撤权生效。
    expect(renewedGenerations).toEqual([])
  })
})

// #602 M2:有效期缺失/无效必须 fail-closed 为 recovering 并进入续期路径,
// 不得标 ready(基线 ③:不得为视觉目标把未验证的过期平台 token 标成可用)。
// #602 M2 + R1 Blocker3:有效期缺失/无效必须 fail-closed —— 而且「成功但结果不可用」的
// 续期响应**不得提交**:提交就意味着 generation++ → 换血 → 有效期仍未知 → 调度器 30s 后再刷,
// 与 #601 同类的第二条自激。
describe("expiry fail-closed", () => {
  // R2 B3:判据必须落在换算出来的绝对期限上 —— Number.MIN_VALUE 是合法有限正数,
  // 但 now + 5e-324*1000 被浮点吸收后就等于 now(Codex 实测它原样通过旧判据并复活了 30 秒循环)。
  test.each([undefined, 0, -1, Number.MIN_VALUE, 1e-9, 29.999] as const)(
    "a refresh response whose expires_in is %p is unusable: not committed, no generation, no rotation",
    async (expiresIn) => {
      const oldBundle = tokenBundle()
      const newBundle = tokenBundle("new")
      storeAuth({
        platformAccessTokens: oldBundle,
        refreshToken: "refresh-old",
        expiresAt: Date.now() + 60_000,
        lifetimeMs: 15 * 60_000,
      })
      const generationBefore = getTokenGeneration()
      let refreshRequests = 0
      globalThis.fetch = (async () => {
        refreshRequests++
        return jsonResponse({
          platform_access_tokens: newBundle,
          refresh_token: "refresh-new",
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        })
      }) as typeof fetch

      expect(await refreshTokens()).toMatchObject({ outcome: "unusable-response" })
      expect(refreshRequests).toBe(1)
      // 保留上一份已验证凭证(与 incomplete-bundle 同一降级语义),且不推进 generation/不换血。
      PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(oldBundle[purpose]))
      expect(getTokenGeneration()).toBe(generationBefore)
      expect(renewedGenerations).toEqual([])
      expect(structuralRespawns).toBe(0)
      expect(readStoredAuth()).toMatchObject({ platformAccessTokens: oldBundle, refreshToken: "refresh-old" })
    },
  )

  test("a stored credential without an expiry is recovering and enters the boot renewal path", () => {
    storeAuth({ platformAccessTokens: tokenBundle(), refreshToken: "refresh-old" })
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
    expect(getAuthState().expiresAt).toBeUndefined()
    expect(isStoredTokenExpired()).toBe(true)
  })

  test("a login whose token response has no usable expiry is recovering, never ready", async () => {
    initAuthEnv(dataPath) // 未登录起步:本例走完整登录回调,不预置凭证
    const bundle = tokenBundle("login")
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: bundle,
        refresh_token: "refresh-login",
        expires_in: 0,
        email: "a@example.invalid",
      })) as typeof fetch

    await startAuth()
    const pkce: unknown = JSON.parse(readFileSync(join(dataPath, "alpha-pkce.json"), "utf8"))
    if (!isRecord(pkce) || typeof pkce.state !== "string") throw new Error("expected a persisted pkce state")
    const callback = new URL(deepLinkFor.authCallback())
    callback.searchParams.set("code", "code-a")
    callback.searchParams.set("state", pkce.state)
    handleAuthDeepLink(callback.toString())
    for (let tick = 0; tick < 500 && getAuthState().status !== "logged-in"; tick++)
      await new Promise((resolve) => setTimeout(resolve, 1))

    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
    expect(getAuthState().expiresAt).toBeUndefined()
    expect(isStoredTokenExpired()).toBe(true)
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY] as const)(
    "expires_in %p is not a usable lifetime and is dropped from the decoded response",
    (expiresIn) => {
      const decoded = decodeTokenResponse({
        platform_access_tokens: tokenBundle(),
        expires_in: expiresIn,
      })
      expect(decoded.expires_in).toBeUndefined()
    },
  )
})

// R1 Blocker2:CAS 曾只保护成功响应。账号 A 的**拒绝**响应迟到时会直接 logout() ——
// 把刚登录的账号 B 的凭证、env、持久态清空并触发 structural respawn。
describe("late refresh rejections must not act on a newer identity", () => {
  test.each([400, 401] as const)("a stale HTTP %p arriving after a new login does not log it out", async (status) => {
    const nextBundle = tokenBundle("next")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-a",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async (_input, init) => {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (isRecord(body) && body.grant_type === "refresh_token") {
        await gate
        return new Response("", { status })
      }
      return jsonResponse({
        platform_access_tokens: nextBundle,
        refresh_token: "refresh-b",
        session_id: "session-b",
        expires_in: 3600,
        email: "b@example.invalid",
      })
    }) as typeof fetch

    const pending = refreshTokens()
    await startAuth()
    const pkce: unknown = JSON.parse(readFileSync(join(dataPath, "alpha-pkce.json"), "utf8"))
    if (!isRecord(pkce) || typeof pkce.state !== "string") throw new Error("expected a persisted pkce state")
    const callback = new URL(deepLinkFor.authCallback())
    callback.searchParams.set("code", "code-b")
    callback.searchParams.set("state", pkce.state)
    handleAuthDeepLink(callback.toString())
    for (let tick = 0; tick < 500 && getAuthState().account?.email !== "b@example.invalid"; tick++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(getAuthState().account?.email).toBe("b@example.invalid")

    release()
    expect(await pending).toMatchObject({ outcome: "transient-failure" })
    expect(getAuthState().status).toBe("logged-in")
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(nextBundle[purpose]))
    expect(process.env.ALPHA_API_KEY).toBe(nextBundle["model.invoke"])
    expect(readStoredAuth()).toMatchObject({ platformAccessTokens: nextBundle, refreshToken: "refresh-b" })
  })
})

// R1 Major4:DEV_PLATFORM_TOKEN 是 §A 的开发短路。packaged 构建里读到它就会把一个未验证的
// token 标 ready 并物化给 sidecar —— 登录 shell 里恰好设了这个变量的生产构建同样中招。
describe("DEV_PLATFORM_TOKEN is a non-packaged override only", () => {
  afterEach(() => {
    packagedBuild = false
  })

  test("a packaged build ignores it entirely (no ready, no env, no logged-in)", () => {
    packagedBuild = true
    process.env.DEV_PLATFORM_TOKEN = jwt("model.invoke", "dev")
    initAuthEnv(dataPath)
    expect(getAuthState().status).toBe("logged-out")
    expect(getAuthState().platformStatus).toBeUndefined()
    expect(getAccessToken("model.invoke")).toBeUndefined()
    expect(process.env.ALPHA_API_KEY).toBeUndefined()
  })

  test("a non-packaged build keeps the development short-circuit", () => {
    packagedBuild = false
    process.env.DEV_PLATFORM_TOKEN = jwt("model.invoke", "dev")
    initAuthEnv(dataPath)
    expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "ready" })
    expect(process.env.ALPHA_API_KEY).toBe(process.env.DEV_PLATFORM_TOKEN)
  })
})

// R1 Major5:换血链最坏含 allowlist 8s + stop 6s + ready IPC 60s + health 20s ≈ 94s。
// 让 account 401 路径悬那么久不可接受 —— 等待必须有界,超时如实报 applied:false。
describe("the rotation wait is bounded", () => {
  test("a structural renewal whose fork never confirms releases the renewal as not-applied", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    let rotationStarted = false
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        rotationStarted = true // 结构性重启已请求,但它的 fork 永远不健康完成(不调 markTokenGenerationApplied)
      },
      applyCredentials: () => "needs-structural",
    })
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    const result = await refreshTokens()

    expect(rotationStarted).toBe(true)
    // 「有界」的结构性证据就是这一行落定了、且重启仍悬着(确认永不到来):等待若无界,
    // refreshTokens 永不返回,由用例自己的 40s 超时判红。不再另断 `waited < 30_000`(`#1300`:
    // 那是墙钟上界,满载下会假红,而它只多排除「ROTATION_WAIT_MS 被改到 30s–40s 之间」这一格)。
    expect(result).toMatchObject({ outcome: "refreshed", applied: false })
    // 超时不是 ready:换血还没落定,平台面继续恢复中。
    expect(getAuthState().platformStatus).toBe("recovering")
  }, 40_000)
})

// R1 Minor1:#601 退出条件② 此前只在 createAuthedGet 的单测里数了几次调用 —— 既没跨过那个
// 已退役的 30 秒窗口,也没经过生产 composition。这条走真实链路:真 refreshTokens + 真 createAuthedGet,
// 并把系统时钟真的推过 30 秒窗口若干轮。REQ-236 `#1562` 起续期热应用,引擎重启恰好 0 次。
describe("a persistently 401 account endpoint (production composition)", () => {
  test("drives exactly one refresh, one hot apply and zero engine restarts across a span well past the retired 30s window", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 60_000,
      lifetimeMs: 15 * 60_000,
    })
    let tokenPosts = 0
    let accountRequests = 0
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes("account.invalid")) {
        accountRequests++
        return new Response("", { status: 401 })
      }
      tokenPosts++
      return jsonResponse({
        platform_access_tokens: tokenBundle(`gen${tokenPosts}`),
        refresh_token: `refresh-${tokenPosts}`,
        expires_in: 3600,
      })
    }) as typeof fetch
    const authedGet = createAuthedGet({
      accountBase: () => "https://account.invalid",
      getAccessToken,
      refreshTokens,
      authIdentityEpoch: getAuthIdentityEpoch,
      fetch: (input, init) => globalThis.fetch(input, init),
      warn: () => {},
      isContractIncompatibleError: () => false,
      reportContractFailure: () => {},
    })

    const base = Date.now()
    for (let round = 0; round < 6; round++) {
      setSystemTime(new Date(base + round * 31_000)) // 真的越过每一个 30 秒窗口
      expect(await authedGet("/v1/account/summary", "account.read", (text) => text)).toEqual({
        error: "unauthorized",
      })
    }
    setSystemTime()

    expect(tokenPosts).toBe(1)
    expect(renewedGenerations).toHaveLength(1)
    expect(structuralRespawns).toBe(0)
    expect(accountRequests).toBe(7) // 首轮 401 + 续期后重试 401,其后 5 轮各一次(锁住,不再续期)
  })
})

// R2 新 Major2 / Minor2 的 composition 侧:结构性确认与 auth 发布必须真的把平台面
// 从 recovering 带回 ready,而且不能被「报了更旧的代」或「一次 IPC 抛出」永久卡住。
describe("clearing the recovering platform state", () => {
  const structuralHarness = (confirm: () => void) =>
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        structuralRespawns++
        confirm()
      },
      applyCredentials: () => "needs-structural",
    })

  test("a fork that captured a newer generation than the renewal still clears recovering", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    // 队列 follow-up 让这次 fork 实际捕获了比本次续期更新的一代,且在续期回报之前就健康完成。
    structuralHarness(() => queueMicrotask(() => markTokenGenerationApplied(getTokenGeneration() + 5)))
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed", applied: true })
    expect(getAuthState().platformStatus).toBe("ready")
  })

  test("an applied notification for an older generation must not clear a newer pending rotation", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    structuralHarness(() => {}) // 重启已请求,确认由下面手动给出
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    const pending = refreshTokens()
    for (let tick = 0; tick < 200 && structuralRespawns === 0; tick++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(getAuthState().platformStatus).toBe("recovering")

    const renewed = getTokenGeneration()
    markTokenGenerationApplied(renewed - 1)
    expect(getAuthState().platformStatus).toBe("recovering")

    markTokenGenerationApplied(renewed)
    expect(getAuthState().platformStatus).toBe("ready")
    expect(await pending).toMatchObject({ outcome: "refreshed", applied: true })
  })

  test("an auth-state push that throws is not recorded, so the next publish still delivers it", () => {
    const sends: string[] = []
    let failing = false
    const win = windowWith((channel) => {
      if (failing) throw new Error("renderer gone")
      sends.push(channel)
    })
    const install = () => setAuthDeps({ getWindow: () => win, respawn: () => {} })

    initAuthEnv(dataPath) // 未登录:先把已发布签名推到一个已知状态
    install()
    sends.length = 0

    failing = true
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 15 * 60_000,
      lifetimeMs: 15 * 60_000,
    })
    install() // 登录态发布 —— IPC 抛出
    expect(sends).toEqual([])

    failing = false
    install() // 同一个签名必须真的补发,不能被身份门控当成「已发过」
    expect(sends).toEqual(["auth-state"])
  })
})
