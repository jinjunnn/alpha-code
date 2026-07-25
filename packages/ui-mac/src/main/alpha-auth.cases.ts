import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContractIncompatibleError, type RoutePurpose } from "@alpha-code/contracts-consumer"
import { createTokenRotationLatch } from "./auth-renewal"
import { deepLinkFor } from "../shared/route-manifest"

const logger = { log: () => {}, warn: () => {}, error: () => {} }

mock.module("electron", () => ({
  app: {
    getVersion: () => "9.9.9",
    getPath: () => "/tmp",
    getName: () => "alpha-code",
    isPackaged: false,
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
  isStoredTokenExpired,
  ensureFreshToken,
  logout,
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

function fakeWindow(sends: string[]) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string) => {
        sends.push(channel)
      },
    },
  } as unknown as ReturnType<Parameters<typeof setAuthDeps>[0]["getWindow"]>
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

  // #600 M1:account 401 路径靠 `await refreshTokens()` 判断"恢复了没有"。旧接线把
  // onRenewed 的 Promise `void` 掉,refresh 立即完成 → UI 报恢复、sidecar 仍握旧 token,
  // 用户此时发送首次推理可能 401。正确行为:续期必须等 latch 对该 generation 的应用结果。
  test.each([true, false] as const)(
    "a renewal reports back only after the token rotation settled (rotation healthy=%p)",
    async (rotationHealthy) => {
      const newBundle = tokenBundle("new")
      storeAuth({
        platformAccessTokens: tokenBundle(),
        refreshToken: "refresh-old",
        expiresAt: 1,
        lifetimeMs: 1000,
      })
      const events: string[] = []
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
          await rotationGate
          if (!rotationHealthy) {
            events.push("rotation:failed")
            return false
          }
          forkedGeneration = getTokenGeneration()
          events.push("rotation:applied")
          return true
        },
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

      const pending = refreshTokens().then((result) => {
        events.push("renewal:reported")
        return result
      })
      for (let tick = 0; tick < 200 && !events.includes("rotation:start"); tick++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(events).toEqual(["rotation:start"])

      releaseRotation()
      expect(await pending).toMatchObject({ outcome: "refreshed" })
      expect(events).toEqual(
        rotationHealthy
          ? ["rotation:start", "rotation:applied", "renewal:reported"]
          : ["rotation:start", "rotation:failed", "renewal:reported"],
      )
    },
  )

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
describe("expiry fail-closed", () => {
  test.each([undefined, 0, -1] as const)(
    "a refreshed response whose expires_in is %p fails closed to recovering and keeps renewing",
    async (expiresIn) => {
      const newBundle = tokenBundle("new")
      storeAuth({
        platformAccessTokens: tokenBundle(),
        refreshToken: "refresh-old",
        expiresAt: Date.now() + 60_000,
        lifetimeMs: 15 * 60_000,
      })
      expect(getAuthState().platformStatus).toBe("ready")
      let refreshRequests = 0
      globalThis.fetch = (async () => {
        refreshRequests++
        return jsonResponse({
          platform_access_tokens: newBundle,
          refresh_token: "refresh-new",
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        })
      }) as typeof fetch

      expect(await refreshTokens()).toMatchObject({ outcome: "refreshed" })
      expect(getAuthState()).toMatchObject({ status: "logged-in", platformStatus: "recovering" })
      expect(getAuthState().expiresAt).toBeUndefined()
      // 进入续期路径:启动宽限判据(A′)为真,且调度到点即刷 —— 不再被陈旧 expiresAt 蒙住。
      expect(isStoredTokenExpired()).toBe(true)
      expect(await ensureFreshToken()).toMatchObject({ outcome: "refreshed" })
      expect(refreshRequests).toBe(2)
    },
  )

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
