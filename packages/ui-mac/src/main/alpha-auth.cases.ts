import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContractIncompatibleError, type RoutePurpose } from "@alpha-code/contracts-consumer"

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
  initAuthEnv,
  isStoredTokenExpired,
  refreshTokens,
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

function readStoredAuth() {
  const envelope: unknown = JSON.parse(readFileSync(join(dataPath, "alpha-auth.json"), "utf8"))
  if (!isRecord(envelope) || typeof envelope.plain !== "string") throw new Error("invalid stored auth envelope")
  const auth: unknown = JSON.parse(envelope.plain)
  if (!isRecord(auth)) throw new Error("invalid stored auth payload")
  return auth
}

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), "alpha-auth-"))
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
    expect(getAuthState()).toMatchObject({ status: "logged-in", expiresAt: 1 })
    expect(isStoredTokenExpired()).toBe(true)

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

    expect(await refreshTokens()).toBe(true)
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

    expect(await refreshTokens()).toBe(false)
    PURPOSES.forEach((purpose) => expect(getAccessToken(purpose)).toBe(oldBundle[purpose]))
    expect(readStoredAuth()).toMatchObject({
      platformAccessTokens: oldBundle,
      refreshToken: "refresh-old",
      sessionId: "session-old",
    })
  })
})
