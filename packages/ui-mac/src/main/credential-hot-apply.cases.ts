// REQ-236 AC1 / AC2(原子写)/ AC4(`#1562`)—— 续期热应用的生产链:真 alpha-auth(refreshTokens → doRefresh →
// applyCredentials)+ 真 alpha-secret-files(syncSecretFiles 记 fork 集合、applyPlatformCredentialsHot 原子写)+ 真
// sidecar-lifecycle(createSidecarRespawnQueue、armRespawnGenerationTerminal)。index.ts 结构上进不了 bun,
// doRespawnSidecar 里「先捕获代 → fork → 健康终态后才 markTokenGenerationApplied(捕获代)」那一行 glue 在下面照抄,
// 形状由 sidecar-lifecycle.test.ts 的 ANCHOR 钉住。终态上界用生产同一个数(index.ts 的 20000)。
// 子进程宿主:credential-hot-apply.test.ts(本文件要 mock electron,同进程会污染别的测试文件)。

import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RoutePurpose } from "@alpha-code/contracts-consumer"
import type { SidecarGenerationState } from "../preload/types"

const logged: string[] = []
const record = (message: unknown, meta?: unknown) => logged.push(`${String(message)} ${JSON.stringify(meta ?? null)}`)
const logger = { log: record, warn: record, error: record }

mock.module("electron", () => ({
  app: {
    getVersion: () => "9.9.9",
    getPath: () => "/tmp",
    getName: () => "alpha-code",
    isPackaged: true,
    on: () => {},
    off: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  },
  dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox: () => {} },
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
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

const { getAuthState, getTokenGeneration, initAuthEnv, markTokenGenerationApplied, refreshTokens, setAuthDeps } = await import(
  "./alpha-auth"
)
const { applyPlatformCredentialsHot, secretFilePath, syncSecretFiles, writeSecretFileAtomic } = await import(
  "./alpha-secret-files"
)
const { armRespawnGenerationTerminal, createSidecarRespawnQueue } = await import("./sidecar-lifecycle")

const PURPOSES = ["model.invoke", "cloud.dispatch", "cloud.read", "artifact.read", "account.read"] as const
const MANAGED_ENV = ["ALPHA_API_KEY", "ALPHA_CLOUD_TOKEN", "ALPHA_MCP_TOKEN", "ALPHA_BASE_URL", "ALPHA_CLOUD_MCP_URL", "DEV_PLATFORM_TOKEN"]
/** index.ts doRespawnSidecar 传给 armRespawnGenerationTerminal 的终态上界。 */
const RESPAWN_TERMINAL_MS = 20_000
const ROTATION_WAIT_MS = 10_000

const originalFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}
let dataPath = ""
let respawns: string[] = []
let pushed: unknown[] = []
/** 每一代签出去的哨兵令牌;用例结束时断言它们一个都没进日志与推给 renderer 的状态。 */
let issued: string[] = []

function jwt(purpose: RoutePurpose, generation: string) {
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

function bundle(generation: string) {
  const tokens = Object.fromEntries(PURPOSES.map((purpose) => [purpose, jwt(purpose, generation)])) as Record<RoutePurpose, string>
  issued.push(...Object.values(tokens))
  return tokens
}

/** 已登录、令牌仍有效(平台面 ready)、mcp 凭证可选;随后像 boot fork 一样跑一次生产 syncSecretFiles,返回 fork 集合。 */
function loginAndFork(withMcp: boolean) {
  const mcp = withMcp ? "SENTINEL-MCP-BOOT-77e1" : undefined
  if (mcp) issued.push(mcp)
  fs.writeFileSync(
    join(dataPath, "alpha-auth.json"),
    JSON.stringify({
      v: 1,
      plain: JSON.stringify({
        mode: "platform",
        platformAccessTokens: bundle("SENTINEL-BOOT"),
        ...(mcp ? { mcpAccessToken: mcp } : {}),
        refreshToken: "refresh-boot",
        expiresAt: Date.now() + 5 * 60_000,
        lifetimeMs: 15 * 60_000,
      }),
    }),
  )
  initAuthEnv(dataPath)
  return new Set(syncSecretFiles(dataPath, process.env).written)
}

function serveRenewal(generation: string, withMcp: boolean) {
  const tokens = bundle(generation)
  const mcp = `SENTINEL-MCP-${generation}`
  issued.push(mcp)
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        platform_access_tokens: tokens,
        ...(withMcp ? { mcp_access_token: mcp } : {}),
        refresh_token: `refresh-${generation}`,
        expires_in: 900,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch
  return { tokens, mcp }
}

const fakeWindow = () =>
  ({
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => channel === "auth-state" && pushed.push(payload) },
  }) as unknown as ReturnType<Parameters<typeof setAuthDeps>[0]["getWindow"]>

const readSecret = (name: string) => fs.readFileSync(secretFilePath(dataPath, name), "utf8")
const statuses = () => pushed.map((state) => (state as { platformStatus?: string }).platformStatus)
const flush = async (ticks = 50) => {
  for (let tick = 0; tick < ticks; tick++) await Promise.resolve()
}

beforeEach(() => {
  dataPath = fs.mkdtempSync(join(tmpdir(), "alpha-hot-apply-"))
  respawns = []
  pushed = []
  issued = []
  logged.length = 0
  MANAGED_ENV.forEach((key) => {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  })
})

afterEach(() => {
  vi.useRealTimers()
  // 哨兵臂(每条用例都过):签出去的令牌一个都不进日志、不进推给 renderer 的 auth 状态。
  const surfaces = `${logged.join("\n")}\n${JSON.stringify(pushed)}`
  expect(issued.filter((token) => surfaces.includes(token))).toEqual([])
  MANAGED_ENV.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  })
  globalThis.fetch = originalFetch
  fs.rmSync(dataPath, { recursive: true, force: true })
})

describe("AC1 同身份普通续期热应用,不重启引擎", () => {
  test("连续三次续期:凭据文件逐代换成新值,respawn 恰好 0 次,平台态一次 recovering 都没有,每次回报 applied", async () => {
    const forked = loginAndFork(true)
    setAuthDeps({
      getWindow: fakeWindow,
      respawn: (trigger) => respawns.push(trigger),
      applyCredentials: () => applyPlatformCredentialsHot(dataPath, process.env, forked),
    })
    for (const round of ["SENTINEL-R1", "SENTINEL-R2", "SENTINEL-R3"]) {
      const renewal = serveRenewal(round, true)
      const result = await refreshTokens()
      expect(result).toMatchObject({ outcome: "refreshed", applied: true })
      expect(readSecret("ALPHA_API_KEY")).toBe(renewal.tokens["model.invoke"])
      expect(readSecret("ALPHA_MCP_TOKEN")).toBe(renewal.mcp)
      expect(getAuthState().platformStatus).toBe("ready")
    }
    expect(respawns).toEqual([])
    expect(statuses()).not.toContain("recovering")
    expect(statuses()).toContain("ready")
  })
})

describe("AC4 凭据在场性改变或热写失败 ⇒ structural,只认捕获代 ≥ 本次续期代的健康 fork", () => {
  /** index.ts 的 respawn 队列 + doRespawnSidecar 确认 glue(见文件头)。`forks` 依次给出每次 fork 的 spawning。 */
  function structuralHarness(forked: Set<string>, forks: Array<() => Promise<{ health: { wait: Promise<unknown> } }>>) {
    const terminals: SidecarGenerationState[] = []
    let generation = 0
    const request = createSidecarRespawnQueue(async (trigger) => {
      respawns.push(trigger)
      const captured = getTokenGeneration()
      const healthy = await armRespawnGenerationTerminal({
        generation: ++generation,
        spawning: forks.shift()!(),
        timeoutMs: RESPAWN_TERMINAL_MS,
        publish: (state) => terminals.push(state),
        logError: () => {},
      })
      if (healthy) markTokenGenerationApplied(captured)
      return healthy
    })
    setAuthDeps({
      getWindow: fakeWindow,
      respawn: (trigger) => void request(trigger),
      applyCredentials: () => applyPlatformCredentialsHot(dataPath, process.env, forked),
    })
    return { terminals, request }
  }

  test("正向:续期带来 fork 时没有的 mcp 凭据 ⇒ credential-change 重启;这次 fork 健康后才 ready", async () => {
    const forked = loginAndFork(false)
    const harness = structuralHarness(forked, [() => Promise.resolve({ health: { wait: Promise.resolve("ok") } })])
    serveRenewal("SENTINEL-PRESENCE", true)
    const result = await refreshTokens()
    expect(respawns).toEqual(["credential-change"])
    expect(result).toMatchObject({ outcome: "refreshed", applied: true })
    expect(getAuthState().platformStatus).toBe("ready")
    expect(statuses().indexOf("recovering")).toBeGreaterThan(-1)
    expect(statuses().lastIndexOf("ready")).toBeGreaterThan(statuses().indexOf("recovering"))
    expect(harness.terminals.map((state) => state.status)).toEqual(["ready"])
  })

  test("热写失败(凭据目录不可写)⇒ 同样走 credential-change 重启,不报已应用", async () => {
    const forked = loginAndFork(true)
    const harness = structuralHarness(forked, [() => Promise.resolve({ health: { wait: Promise.resolve("ok") } })])
    fs.chmodSync(join(dataPath, "alpha-secrets"), 0o500)
    try {
      serveRenewal("SENTINEL-WRITE-FAIL", true)
      expect(await refreshTokens()).toMatchObject({ outcome: "refreshed", applied: true })
    } finally {
      fs.chmodSync(join(dataPath, "alpha-secrets"), 0o700)
    }
    expect(respawns).toEqual(["credential-change"])
    expect(harness.terminals.map((state) => state.status)).toEqual(["ready"])
  })

  test("fork 失败 ⇒ 不确认:有界等待后回报 applied:false,平台态保持 recovering", async () => {
    const forked = loginAndFork(false)
    vi.useFakeTimers()
    const harness = structuralHarness(forked, [() => Promise.reject(new Error("fork failed"))])
    serveRenewal("SENTINEL-FORK-FAIL", true)
    const pending = refreshTokens()
    await flush()
    vi.advanceTimersByTime(ROTATION_WAIT_MS)
    expect(await pending).toMatchObject({ outcome: "refreshed", applied: false })
    expect(respawns).toEqual(["credential-change"])
    expect(harness.terminals.map((state) => state.status)).toEqual(["failed"])
    expect(getAuthState().platformStatus).toBe("recovering")
  })

  test("fork 20 秒不健康 ⇒ 超时终态 failed,不确认;平台态保持 recovering", async () => {
    const forked = loginAndFork(false)
    vi.useFakeTimers()
    const harness = structuralHarness(forked, [() => Promise.resolve({ health: { wait: new Promise(() => {}) } })])
    serveRenewal("SENTINEL-TIMEOUT", true)
    const pending = refreshTokens()
    await flush()
    vi.advanceTimersByTime(ROTATION_WAIT_MS)
    expect(await pending).toMatchObject({ outcome: "refreshed", applied: false })
    expect(harness.terminals).toEqual([])
    vi.advanceTimersByTime(RESPAWN_TERMINAL_MS)
    await flush()
    expect(harness.terminals.map((state) => state.status)).toEqual(["failed"])
    expect(getAuthState().platformStatus).toBe("recovering")
  })

  test("迟到完成的旧 fork(捕获的是续期之前的代)健康了也不确认;排在它后面的新 fork 失败 ⇒ 仍 recovering", async () => {
    const forked = loginAndFork(false)
    vi.useFakeTimers()
    let oldForkHealthy!: () => void
    const harness = structuralHarness(forked, [
      () =>
        Promise.resolve({
          health: {
            wait: new Promise<void>((resolve) => {
              oldForkHealthy = resolve
            }),
          },
        }),
      () => Promise.reject(new Error("fork failed")),
    ])
    // 续期之前已有一次重启在飞(比如用户刚改了 BYOK 键),它捕获的是续期之前的代。
    void harness.request("byok-change")
    await flush()
    const before = getTokenGeneration()
    serveRenewal("SENTINEL-LATE-OLD", true)
    const pending = refreshTokens()
    await flush()
    expect(getTokenGeneration()).toBe(before + 1)
    expect(getAuthState().platformStatus).toBe("recovering")
    oldForkHealthy()
    await flush()
    expect(harness.terminals.map((state) => state.status)).toEqual(["ready", "failed"])
    expect(getAuthState().platformStatus).toBe("recovering")
    vi.advanceTimersByTime(ROTATION_WAIT_MS)
    expect(await pending).toMatchObject({ outcome: "refreshed", applied: false })
    expect(respawns).toEqual(["byok-change", "credential-change"])
    expect(getAuthState().platformStatus).toBe("recovering")
  })
})

describe("AC2 凭据文件原子替换", () => {
  // 另一个进程在写入期间不停地读;读者只许看到完整的旧值或新值。手段自证:同一个读者对截断后写(旧的
  // writeFileSync 写法)必须读到过半截/空文件 —— 否则这个判据测不出已知的坏。
  const A = "A".repeat(512 * 1024)
  const B = "B".repeat(256 * 1024)
  const READER = `
    const fs = require("node:fs")
    const [file, a, b] = [process.argv[1], "A".repeat(512 * 1024), "B".repeat(256 * 1024)]
    let reads = 0, torn = 0
    const end = Date.now() + 1500
    while (Date.now() < end) {
      let value = ""
      try { value = fs.readFileSync(file, "utf8") } catch {}
      reads++
      if (value !== a && value !== b) torn++
    }
    console.log(JSON.stringify({ reads, torn }))
  `

  async function race(write: (dir: string, name: string, value: string) => void) {
    const dir = join(dataPath, "alpha-secrets")
    fs.mkdirSync(dir, { recursive: true })
    write(dir, "ALPHA_API_KEY", A)
    const reader = Bun.spawn([process.execPath, "-e", READER, join(dir, "ALPHA_API_KEY")], { stdout: "pipe", stderr: "pipe" })
    const end = Date.now() + 1500
    for (let index = 0; Date.now() < end; index++) {
      write(dir, "ALPHA_API_KEY", index % 2 === 0 ? B : A)
      if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const output = await new Response(reader.stdout).text()
    await reader.exited
    return JSON.parse(output) as { reads: number; torn: number }
  }

  test("writeSecretFileAtomic:并发读者从不读到半截或空文件;截断后写对照臂读得到", async () => {
    const atomic = await race(writeSecretFileAtomic)
    expect(atomic.reads).toBeGreaterThan(50)
    expect(atomic.torn).toBe(0)
    const truncating = await race((dir, name, value) => fs.writeFileSync(join(dir, name), value))
    expect(truncating.torn).toBeGreaterThan(0)
  }, 20_000)
})
