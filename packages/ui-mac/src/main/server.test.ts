import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  postMessage(message: { type: string }) {
    if (message.type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0))
  }

  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}

const appEvents = new EventEmitter()
const forkCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    on: appEvents.on.bind(appEvents),
    off: appEvents.off.bind(appEvents),
  },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {} },
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))
mock.module("./store", () => ({ getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }) }))
// 不 mock ./alpha-secret-files:真 syncSecretFiles 对 test 的临时 userDataPath 是 temp-scoped(写
// <tempdir>/alpha-secrets,无 ALPHA 密钥环境变量时 no-op,afterEach 清理)。全局 mock.module 会跨文件
// 泄漏残缺导出面,撞坏 alpha-secret-files.test.ts 的 `import { secretFileRef, ... }`(2026-07-21 Linux CI 实锤)。

const { hasSecretFile, syncSecretFiles } = await import("./alpha-secret-files")
const { preferAppEnv, spawnLocalServer } = await import("./server")

let userDataPath = ""
const keylessWebSearchFlags = [
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL_EXA",
  "OPENCODE_ENABLE_PARALLEL",
  "OPENCODE_EXPERIMENTAL_PARALLEL",
] as const
const managedEnv = [
  "SHELL",
  "ALPHA_CLOUD_MCP_URL",
  "ALPHA_ENV_FILE",
  "ALPHA_SECRETS_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  ...keylessWebSearchFlags,
  "OPENCODE_EXPERIMENTAL",
] as const
const savedEnv: Partial<Record<(typeof managedEnv)[number], string>> = {}

beforeEach(() => {
  forkCalls.length = 0
  userDataPath = mkdtempSync(join(tmpdir(), "server-scratch-cwd-"))
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.SHELL = "nu"
  process.env.ALPHA_SECRETS_DISABLE = "1"
})

afterEach(() => {
  for (const key of managedEnv) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

function webSearchToolSnapshot() {
  const local = keylessWebSearchFlags.some((key) => process.env[key] === "1")
  return [
    ...(local ? ["websearch"] : []),
    ...(process.env.ALPHA_CLOUD_MCP_URL && hasSecretFile(userDataPath, "ALPHA_CLOUD_TOKEN")
      ? ["cloud_web_search"]
      : []),
  ]
}

describe("preferAppEnv websearch selection", () => {
  test("platform-pays exposes only cloud_web_search and forces off every keyless flag", () => {
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
    syncSecretFiles(userDataPath, { ALPHA_CLOUD_TOKEN: "token" })

    preferAppEnv(userDataPath)

    expect(webSearchToolSnapshot()).toEqual(["cloud_web_search"])
    expect({
      OPENCODE_ENABLE_EXA: process.env.OPENCODE_ENABLE_EXA,
      OPENCODE_EXPERIMENTAL_EXA: process.env.OPENCODE_EXPERIMENTAL_EXA,
      OPENCODE_ENABLE_PARALLEL: process.env.OPENCODE_ENABLE_PARALLEL,
      OPENCODE_EXPERIMENTAL_PARALLEL: process.env.OPENCODE_EXPERIMENTAL_PARALLEL,
    }).toEqual({
      OPENCODE_ENABLE_EXA: "0",
      OPENCODE_EXPERIMENTAL_EXA: "0",
      OPENCODE_ENABLE_PARALLEL: "0",
      OPENCODE_EXPERIMENTAL_PARALLEL: "0",
    })
  })

  test("platform-pays overrides a shell-exported keyless flag", () => {
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
    process.env.OPENCODE_ENABLE_PARALLEL = "1"
    syncSecretFiles(userDataPath, { ALPHA_CLOUD_TOKEN: "token" })

    preferAppEnv(userDataPath)

    expect(webSearchToolSnapshot()).toEqual(["cloud_web_search"])
    expect(process.env.OPENCODE_ENABLE_PARALLEL).toBe("0")
  })

  test.each(keylessWebSearchFlags)("disable overrides a shell-exported %s flag in every auth state", (flag) => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    process.env[flag] = "1"

    preferAppEnv(userDataPath)

    expect(webSearchToolSnapshot()).toEqual([])
    expect(Object.fromEntries(keylessWebSearchFlags.map((key) => [key, process.env[key]]))).toEqual(
      Object.fromEntries(keylessWebSearchFlags.map((key) => [key, "0"])),
    )
  })

  test("disable wins over all shell-exported keyless flags even when cloud is registered", () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
    Object.assign(process.env, Object.fromEntries(keylessWebSearchFlags.map((key) => [key, "1"])))
    syncSecretFiles(userDataPath, { ALPHA_CLOUD_TOKEN: "token" })

    preferAppEnv(userDataPath)

    expect(keylessWebSearchFlags.map((key) => process.env[key])).toEqual(["0", "0", "0", "0"])
  })

  test("logged-out/BYOK exposes only the unchanged local keyless websearch", () => {
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"

    preferAppEnv(userDataPath)

    expect(webSearchToolSnapshot()).toEqual(["websearch"])
    expect(process.env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(process.env.OPENCODE_EXPERIMENTAL_EXA).toBeUndefined()
    expect(process.env.OPENCODE_ENABLE_PARALLEL).toBeUndefined()
    expect(process.env.OPENCODE_EXPERIMENTAL_PARALLEL).toBeUndefined()
  })
})

describe("spawnLocalServer", () => {
  test("forks the sidecar in the userData scratch directory", async () => {
    const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: ((file: string, args: string[], options: Record<string, unknown>) => {
        forkCalls.push({ file, args, options })
        return new FakeChild()
      }) as unknown as typeof import("electron").utilityProcess.fork,
    })
    await result.health.wait

    expect(forkCalls).toHaveLength(1)
    const cwd = forkCalls[0]?.options.cwd
    expect(cwd).toBe(join(userDataPath, "engine-scratch-cwd"))
    expect(cwd).not.toBe(process.cwd())
    expect(cwd).not.toBe(resolve(homedir()))
    expect(cwd).not.toBe(parse(resolve(userDataPath)).root)

    await result.listener.stop()
  })
})
