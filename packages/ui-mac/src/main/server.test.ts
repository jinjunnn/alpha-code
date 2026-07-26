import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const { hasSecretFile } = await import("./alpha-secret-files")
const { writeShellEnvCache } = await import("./shell-env-cache")
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
  "ALPHA_CLOUD_TOKEN",
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

const fakeFork = ((file: string, args: string[], options: Record<string, unknown>) => {
  forkCalls.push({ file, args, options })
  return new FakeChild()
}) as unknown as typeof import("electron").utilityProcess.fork

/** Fork the sidecar the way boot/respawn does and hand back the env it was forked with. */
async function forkSidecar() {
  const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
    userDataPath,
    healthCheck: async () => true,
    fork: fakeFork,
  })
  await result.health.wait
  await result.listener.stop()
  return (forkCalls.at(-1)?.options.env ?? {}) as Record<string, string | undefined>
}

/** #621:登录态由 initAuthEnv/applyAuthEnv 建立,**晚于** preferAppEnv;env token 在下次 fork 时
 *  才经 syncSecretFiles 变成密钥文件。测试照这个真实顺序走,不预置 force-off 的判据。 */
function applyAuthEnvLikeLogin() {
  process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
  process.env.ALPHA_CLOUD_TOKEN = "token"
}

function applyAuthEnvLikeLogout() {
  delete process.env.ALPHA_CLOUD_TOKEN
}

function webSearchToolSnapshot(env: Record<string, string | undefined>) {
  const local = keylessWebSearchFlags.some((key) => env[key] === "1")
  return [
    ...(local ? ["websearch"] : []),
    ...(process.env.ALPHA_CLOUD_MCP_URL && hasSecretFile(userDataPath, "ALPHA_CLOUD_TOKEN")
      ? ["cloud_web_search"]
      : []),
  ]
}

const allFlagsOff = Object.fromEntries(keylessWebSearchFlags.map((key) => [key, "0"]))

function keylessFlagsOf(env: Record<string, string | undefined>) {
  return Object.fromEntries(keylessWebSearchFlags.map((key) => [key, env[key]]))
}

describe("web search sovereignty at sidecar fork (#621)", () => {
  test("cold start with a logged-in user forces keyless off at fork, not at preferAppEnv", async () => {
    // 真实顺序:preferAppEnv 先跑,此刻 initAuthEnv 还没写 ALPHA_CLOUD_MCP_URL/token。
    preferAppEnv(userDataPath)
    expect(process.env.OPENCODE_ENABLE_EXA).toBe("1") // boot 期只能判「登出」——这正是 #621 的现场

    applyAuthEnvLikeLogin()

    const env = await forkSidecar()
    expect(keylessFlagsOf(env)).toEqual(allFlagsOff)
    expect(webSearchToolSnapshot(env)).toEqual(["cloud_web_search"])
  })

  test("cold start overrides a shell-exported keyless flag at fork time", async () => {
    process.env.OPENCODE_ENABLE_PARALLEL = "1"

    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    const env = await forkSidecar()
    expect(env.OPENCODE_ENABLE_PARALLEL).toBe("0")
    expect(webSearchToolSnapshot(env)).toEqual(["cloud_web_search"])
  })

  test.each(keylessWebSearchFlags)("disable overrides a shell-exported %s flag in every auth state", async (flag) => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    process.env[flag] = "1"

    preferAppEnv(userDataPath)

    const env = await forkSidecar()
    expect(keylessFlagsOf(env)).toEqual(allFlagsOff)
    expect(webSearchToolSnapshot(env)).toEqual([])
  })

  test("disable wins over all shell-exported keyless flags even when cloud is registered", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    Object.assign(process.env, Object.fromEntries(keylessWebSearchFlags.map((key) => [key, "1"])))

    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    const env = await forkSidecar()
    expect(keylessFlagsOf(env)).toEqual(allFlagsOff)
  })

  test("logged-out/BYOK forks with the unchanged local keyless websearch", async () => {
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp" // URL 在场但无密钥文件 = 未登录

    preferAppEnv(userDataPath)

    const env = await forkSidecar()
    expect(webSearchToolSnapshot(env)).toEqual(["websearch"])
    expect(env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(env.OPENCODE_EXPERIMENTAL_EXA).toBeUndefined()
    expect(env.OPENCODE_ENABLE_PARALLEL).toBeUndefined()
    expect(env.OPENCODE_EXPERIMENTAL_PARALLEL).toBeUndefined()
  })

  test("logout respawn gives the keyless baseline back instead of leaving it forced off", async () => {
    process.env.OPENCODE_ENABLE_PARALLEL = "1" // 用户 shell 的真 export

    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()
    expect(keylessFlagsOf(await forkSidecar())).toEqual(allFlagsOff)

    applyAuthEnvLikeLogout()

    const env = await forkSidecar()
    expect(env.OPENCODE_ENABLE_PARALLEL).toBe("1")
    expect(env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(webSearchToolSnapshot(env)).toEqual(["websearch"])
  })

  test("re-forking without an auth change is idempotent", async () => {
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    expect(keylessFlagsOf(await forkSidecar())).toEqual(keylessFlagsOf(await forkSidecar()))
  })
})

// #223 对抗审计 Major 3(2026-07-25):基线曾在**登录 shell env 合入之前**截取。上面那组用例
// 靠 `SHELL=nu` 跳过真实 shell 导入(`loadShellEnv` 对 nushell 直接 return null),又在
// `preferAppEnv` 之前手写 `process.env` —— 于是整条真实导入序零覆盖,缺陷从测试面前溜过去了。
// 这组换成**真实登录 shell 探测**:SHELL 指向一个真脚本,由 spawnSync 真跑、真回吐 `env -0`。
describe("keyless baseline vs the real login-shell import (#223 Major 3)", () => {
  /** 写一个真能被 `spawnSync(shell, ["-il","-c","env -0"])` 跑起来的登录 shell 替身。 */
  function fakeLoginShell(name: string, exported: Record<string, string>) {
    const script = join(userDataPath, name)
    const body = Object.entries(exported)
      .map(([key, value]) => `${key}=${value}`)
      .join("\\000")
    writeFileSync(script, `#!/bin/sh\nprintf '${body}\\000'\n`)
    chmodSync(script, 0o755)
    return script
  }

  test("a shell-exported keyless flag survives the login → logout round trip", async () => {
    // 用户 rc 里 `export OPENCODE_ENABLE_PARALLEL=1`,当前进程 env 里没有它 —— 只有真实导入能带进来。
    process.env.SHELL = fakeLoginShell("login-shell.sh", {
      PATH: "/usr/bin:/bin",
      OPENCODE_ENABLE_PARALLEL: "1",
    })
    expect(process.env.OPENCODE_ENABLE_PARALLEL).toBeUndefined()

    preferAppEnv(userDataPath)
    // ① Finder 首启(已登出)就必须用用户真值。基线取早了的话,「还原基线」会把它直接删掉,
    //    再默认打开 Exa —— 首次启动就换错了 provider。
    expect(process.env.OPENCODE_ENABLE_PARALLEL).toBe("1")
    expect(webSearchToolSnapshot(await forkSidecar())).toEqual(["websearch"])

    applyAuthEnvLikeLogin()
    expect(keylessFlagsOf(await forkSidecar())).toEqual(allFlagsOff)

    applyAuthEnvLikeLogout()
    // ② 登出 respawn 还原的必须是用户真值,而不是「探测之前的空基线」。
    const env = await forkSidecar()
    expect(env.OPENCODE_ENABLE_PARALLEL).toBe("1")
    expect(webSearchToolSnapshot(env)).toEqual(["websearch"])
  })

  test("the cached shell env path has the same baseline truth", async () => {
    // 生产上的常见路径是缓存命中(0ms 套用)。故意让脚本非零退出:缓存照常命中并套用,
    // 而后台异步刷新拿不到结果(`if (!fresh) return`),用例保持确定性。
    const shell = join(userDataPath, "broken-shell.sh")
    writeFileSync(shell, "#!/bin/sh\nexit 1\n")
    chmodSync(shell, 0o755)
    process.env.SHELL = shell
    writeShellEnvCache(userDataPath, shell, { PATH: "/usr/bin:/bin", OPENCODE_ENABLE_PARALLEL: "1" })

    preferAppEnv(userDataPath)
    expect(process.env.OPENCODE_ENABLE_PARALLEL).toBe("1")

    applyAuthEnvLikeLogin()
    expect(keylessFlagsOf(await forkSidecar())).toEqual(allFlagsOff)

    applyAuthEnvLikeLogout()
    expect((await forkSidecar()).OPENCODE_ENABLE_PARALLEL).toBe("1")
  })
})

describe("spawnLocalServer", () => {
  // #223 对抗审计 Major 4(2026-07-25):密钥文件同步失败后仍继续 fork —— 登出删不掉旧 token
  // 文件时只写日志继续,主权闸读到旧文件仍判 platformPays=true,新 sidecar 带着已作废的 token
  // 注册云工具;反向地登录写失败会静默回落 keyless。密钥同步是 fork 的前置条件,不是尽力而为。
  test("refuses to fork when the secret file sync fails", async () => {
    const parentIsAFile = join(userDataPath, "not-a-directory")
    writeFileSync(parentIsAFile, "")
    const brokenUserData = join(parentIsAFile, "userdata")

    await expect(
      spawnLocalServer("127.0.0.1", 4096, "password", {
        userDataPath: brokenUserData,
        healthCheck: async () => true,
        fork: fakeFork,
      }),
    ).rejects.toThrow(/alpha-secrets sync failed/)
    expect(forkCalls).toHaveLength(0)
  })

  test("forks the sidecar in the userData scratch directory", async () => {
    const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: fakeFork,
    })
    await result.health.wait

    expect(forkCalls).toHaveLength(1)
    const cwd = forkCalls[0]?.options.cwd
    expect(cwd).toBe(join(userDataPath, "engine-scratch-cwd"))
    expect(cwd).not.toBe(process.cwd())
    expect(cwd).not.toBe(resolve(homedir()))
    expect(cwd).not.toBe(parse(resolve(userDataPath)).root)
    // #613:正常 ready 不携带注入失败
    expect(result.injectionFailure).toBeUndefined()

    await result.listener.stop()
  })

  // #613 反向闸门(退出条件 1/3:main 侧可观测,链条第三环):ready IPC 携带 injectionFailure 时,
  // spawnLocalServer 必须把它暴露给调用方(终态生产者据此发布 "injection-failed")。
  // 把 server.ts 里的 `injectionFailure = message.injectionFailure` 删掉(main 重新装聋),本用例转红。
  test("ready IPC 携带 injectionFailure 时,spawnLocalServer 把注入失败暴露给 main", async () => {
    class InjectionFailedChild extends FakeChild {
      postMessage(message: { type: string }) {
        if (message.type === "start")
          queueMicrotask(() =>
            this.emit("message", { type: "ready", injectionFailure: { message: "ENOTDIR: mkdir userdata" } }),
          )
        if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0))
      }
    }
    const result = await spawnLocalServer("127.0.0.1", 4097, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: (() => new InjectionFailedChild()) as unknown as typeof import("electron").utilityProcess.fork,
    })
    await result.health.wait

    expect(result.injectionFailure).toEqual({ message: "ENOTDIR: mkdir userdata" })

    await result.listener.stop()
  })
})
