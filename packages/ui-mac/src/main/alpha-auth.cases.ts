import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test, vi } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContractIncompatibleError, type RoutePurpose } from "@alpha-code/contracts-consumer"
import { createTokenRotationLatch } from "./auth-renewal"
import { createAuthedGet } from "./alpha-account-request"
import { deepLinkFor } from "../shared/route-manifest"

const logger = { log: () => {}, warn: () => {}, error: () => {} }
// R1 Major4:DEV_PLATFORM_TOKEN 只该在非 packaged 构建生效;测试要能翻这个开关。
let packagedBuild = false

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
    openExternal: async () => {},
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
  "ALPHA_BASE_URL",
  "ALPHA_CLOUD_MCP_URL",
  "DEV_PLATFORM_TOKEN",
] as const
const originalFetch = globalThis.fetch
const savedEnv: Partial<Record<(typeof MANAGED_ENV)[number], string>> = {}
let dataPath = ""
let structuralRespawns = 0
let renewedGenerations: number[] = []

function jwt(purpose: RoutePurpose, generation = "old") {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
    JSON.stringify({
      schema_version: 1,
      iss: "alpha-web",
      aud: "alpha-platform-api",
      sub: "tenant-a",
      token_use: "platform_access",
      purpose,
      scope: [purpose],
      iat: 1,
      exp: 2,
      jti: `${generation}-${purpose}`,
    }),
  ).toString("base64url")}.signature`
}

function tokenBundle(generation = "old") {
  return {
    "model.invoke": jwt("model.invoke", generation),
    "cloud.dispatch": jwt("cloud.dispatch", generation),
    "cloud.read": jwt("cloud.read", generation),
    "artifact.read": jwt("artifact.read", generation),
    "account.read": jwt("account.read", generation),
  }
}

function storeAuth(value: {
  platformAccessTokens?: Partial<Record<RoutePurpose, string>>
  refreshToken?: string
  sessionId?: string
  expiresAt?: number
  lifetimeMs?: number
  mode?: "byok" | "platform"
}) {
  writeFileSync(
    join(dataPath, "alpha-auth.json"),
    JSON.stringify({ v: 1, plain: JSON.stringify({ mode: "platform", ...value }) }),
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
    onRenewed: (result) => renewedGenerations.push(result.generation),
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
    })
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

  // #600 M1(R1 Blocker1 + Minor2 重写):此前本条**接受**「换血失败仍返回 refreshed」,
  // 且用 getWindow:null 绕开了正要验证的 platform-ready 发布 —— 假闸门。正确行为三条:
  // ① 换血落定之前绝不发布 platformStatus:"ready";② 换血失败 ⇒ 结果 applied:false 且平台面
  // 保持 recovering;③ 低频重试真正应用后才转 ready。
  test.each([true, false] as const)(
    "platform ready is published only after the rotation applied (rotation healthy=%p)",
    async (rotationHealthy) => {
      const newBundle = tokenBundle("new")
      storeAuth({
        platformAccessTokens: tokenBundle(),
        refreshToken: "refresh-old",
        expiresAt: 1,
        lifetimeMs: 1000,
      })
      const events: string[] = []
      const published: (string | undefined)[] = []
      let releaseRotation!: () => void
      const rotationGate = new Promise<void>((resolve) => {
        releaseRotation = resolve
      })
      let forkedGeneration = getTokenGeneration()
      const rotation = createTokenRotationLatch({
        forkedGeneration: () => forkedGeneration,
        canRespawn: () => true,
        respawn: async () => {
          events.push("rotation:start")
          published.push(`during-rotation:${getAuthState().platformStatus}`)
          await rotationGate
          if (!rotationHealthy) {
            events.push("rotation:failed")
            return false
          }
          forkedGeneration = getTokenGeneration()
          events.push("rotation:applied")
          return true
        },
        onApplied: (generation) => markTokenGenerationApplied(generation),
      })
      setAuthDeps({
        getWindow: () => fakeWindow([], published),
        respawn: () => {
          structuralRespawns++
        },
        onRenewed: (result) => rotation.accept(result, "renewal"),
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
      for (let tick = 0; tick < 200 && !events.includes("rotation:start"); tick++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      // 换血在途:续期尚未回报,且此刻的平台态是「恢复中」——即便 main 已经握着新 token。
      expect(events).toEqual(["rotation:start"])
      expect(getAuthState().platformStatus).toBe("recovering")
      expect(published).not.toContain("ready")
      expect(published).toContain("during-rotation:recovering")

      releaseRotation()
      const result = await pending
      expect(events).toEqual(
        rotationHealthy
          ? ["rotation:start", "rotation:applied", "renewal:reported"]
          : ["rotation:start", "rotation:failed", "renewal:reported"],
      )
      expect(result).toMatchObject({ outcome: "refreshed", applied: rotationHealthy })
      expect(getAuthState().platformStatus).toBe(rotationHealthy ? "ready" : "recovering")
      // ready 一次都不能出现在换血落定之前
      if (rotationHealthy) expect(published.indexOf("ready")).toBeGreaterThan(published.indexOf("recovering"))
      else expect(published).not.toContain("ready")
    },
  )

  // 换血失败后不是终局:latch 的低频重试真正应用该代时,平台面才从 recovering 转 ready。
  test("a later successful rotation retry is what clears the recovering platform state", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    const timers: Array<() => void> = []
    let healthy = false
    let forkedGeneration = getTokenGeneration()
    const rotation = createTokenRotationLatch({
      forkedGeneration: () => forkedGeneration,
      canRespawn: () => true,
      respawn: async () => {
        if (!healthy) return false
        forkedGeneration = getTokenGeneration()
        return true
      },
      onApplied: (generation) => markTokenGenerationApplied(generation),
      setTimer: (run) => {
        timers.push(run)
        return setTimeout(() => {}, 0)
      },
      clearTimer: (timer) => clearTimeout(timer),
    })
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        structuralRespawns++
      },
      onRenewed: (result) => rotation.accept(result, "renewal"),
    })
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    expect(await refreshTokens()).toMatchObject({ outcome: "refreshed", applied: false })
    expect(getAuthState().platformStatus).toBe("recovering")
    expect(timers).toHaveLength(1)

    healthy = true
    timers[0]()
    await rotation.flush()
    expect(getAuthState().platformStatus).toBe("ready")
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

// #602 B4:旧 refresh 响应必须在提交前做 CAS。此前 doRefresh() 直接 `...stored` 写回,
// 在途期间的 logout 会被复活,新账号登录会被账号 A 的 token 覆盖(UI 显示 B、bearer 是 A)。
describe("refresh compare-and-set before commit", () => {
  test("a refresh in flight is discarded when logout changes the auth generation", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
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
      onRenewed: (result) => {
        renewedGenerations.push(result.generation)
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
  test("a rotation that never settles releases the renewal as not-applied", async () => {
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
        structuralRespawns++
      },
      onRenewed: () =>
        new Promise<boolean>(() => {
          rotationStarted = true
        }),
    })
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    const started = Date.now()
    const result = await refreshTokens()
    const waited = Date.now() - started

    expect(rotationStarted).toBe(true)
    expect(result).toMatchObject({ outcome: "refreshed", applied: false })
    expect(waited).toBeLessThan(30_000)
    // 超时不是 ready:换血还没落定,平台面继续恢复中。
    expect(getAuthState().platformStatus).toBe("recovering")
  }, 40_000)
})

// R1 Minor1:#601 退出条件② 此前只在 createAuthedGet 的单测里数了几次调用 —— 既没跨过那个
// 已退役的 30 秒窗口,也没经过生产 composition。这条走真实链路:真 refreshTokens + 真 latch +
// 真 createAuthedGet,并把系统时钟真的推过 30 秒窗口若干轮。
describe("a persistently 401 account endpoint (production composition)", () => {
  test("drives exactly one refresh and one token-only rotation across a span well past the retired 30s window", async () => {
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 60_000,
      lifetimeMs: 15 * 60_000,
    })
    let tokenPosts = 0
    let accountRequests = 0
    const rotations: string[] = []
    let forkedGeneration = getTokenGeneration()
    const rotation = createTokenRotationLatch({
      forkedGeneration: () => forkedGeneration,
      canRespawn: () => true,
      respawn: async (reason) => {
        rotations.push(reason)
        forkedGeneration = getTokenGeneration()
        return true
      },
      onApplied: (generation) => markTokenGenerationApplied(generation),
    })
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        structuralRespawns++
      },
      onRenewed: (result) => rotation.accept(result, "renewal"),
    })
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
    expect(rotations).toEqual(["token-only"])
    expect(accountRequests).toBe(7) // 首轮 401 + 续期后重试 401,其后 5 轮各一次(锁住,不再续期)
  })
})

// R2 新 Major2 / Minor2 的 composition 侧:换血落定的通知与 auth 发布必须真的把平台面
// 从 recovering 带回 ready,而且不能被「报了更旧的代」或「一次 IPC 抛出」永久卡住。
describe("clearing the recovering platform state", () => {
  const rotationHarness = (adopt: (current: number) => number) => {
    let forked = getTokenGeneration()
    const rotation = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      respawn: async () => {
        forked = adopt(getTokenGeneration())
        return true
      },
      onApplied: (generation) => markTokenGenerationApplied(generation),
    })
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        structuralRespawns++
      },
      onRenewed: (result) => rotation.accept(result, "renewal"),
    })
    return rotation
  }

  test("a rotation that adopts a newer generation than the request still clears recovering", async () => {
    const newBundle = tokenBundle("new")
    storeAuth({
      platformAccessTokens: tokenBundle(),
      refreshToken: "refresh-old",
      expiresAt: 1,
      lifetimeMs: 1000,
    })
    // 队列 follow-up 让本次换血实际带上了比 target 更新的一代。
    rotationHarness((current) => current + 5)
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
    setAuthDeps({
      getWindow: () => null,
      respawn: () => {
        structuralRespawns++
      },
      onRenewed: () => false, // 换血失败:该代仍未应用
    })
    globalThis.fetch = (async () =>
      jsonResponse({
        platform_access_tokens: newBundle,
        refresh_token: "refresh-new",
        expires_in: 3600,
      })) as typeof fetch

    const result = await refreshTokens()
    expect(result).toMatchObject({ outcome: "refreshed", applied: false })
    expect(getAuthState().platformStatus).toBe("recovering")

    markTokenGenerationApplied(result.generation - 1)
    expect(getAuthState().platformStatus).toBe("recovering")

    markTokenGenerationApplied(result.generation)
    expect(getAuthState().platformStatus).toBe("ready")
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
