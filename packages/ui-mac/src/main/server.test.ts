import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"
import { writeCustomProviderTruth } from "./custom-provider-truth-write"
import { mockElectron } from "../../test-component/electron-mock"

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

mockElectron(() => ({
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
// REQ-226 `#1343`:spawnLocalServer 在 fork 前从钥匙串库取自定义服务密钥。库本身真跑;只把它那一个
// 函数的 Electron 接缝(alpha-keychain-backend,见该文件为何不 mock `electron`)换成能落盘的假钥匙串。
// 它不是本文件的被测对象(库的判据在 alpha-byok-keys.test.ts)。
mock.module("./alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}))
// 不 mock ./alpha-secret-files:真 syncSecretFiles 对 test 的临时 userDataPath 是 temp-scoped(写
// <tempdir>/alpha-secrets,无 ALPHA 密钥环境变量时 no-op,afterEach 清理)。全局 mock.module 会跨文件
// 泄漏残缺导出面,撞坏 alpha-secret-files.test.ts 的 `import { secretFileRef, ... }`(2026-07-21 Linux CI 实锤)。

const { hasSecretFile, secretFilePath } = await import("./alpha-secret-files")
const { clearByokKeys, initByokKeys, storeByokKey } = await import("./alpha-byok-keys")
const { writeShellEnvCache } = await import("./shell-env-cache")
const { preferAppEnv, spawnLocalServer } = await import("./server")
// REQ-159 `#1321`:生产 spawnLocalServer 在 fork 前做围栏计划(真 store / 真 sandbox-exec / 真原生模块路径);
// 本文件的假子进程不跑 sidecar.ts,注入一个替身计划 —— 围栏本身的判据在 process-fence-*.test.ts。
const fakePlanFence = () => ({ profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/nonexistent/alpha_fence.node" })
const { creditDanglingSweepForSpawn, resetDanglingSweepLatchForTests } = await import("./dangling-sweep-latch")
// `#1411`(REQ-1414 CODE-1):下面「模型工具表」那一组用的四个**生产**供数方。全部动态 import ——
// 它们要么经 ui-mac 的 main 面(必须排在 electron mock 之后),要么是引擎/注入面的真模块。
const { injectAlphaConfig } = await import("./alpha-config-injection")
const { webSearchEnabled } = await import("../../../opencode/src/tool/registry")
const { RuntimeFlags } = await import("../../../opencode/src/effect/runtime-flags")
const { Permission } = await import("../../../opencode/src/permission/index")
const { AppNodeBuilder } = await import("../../../core/src/effect/app-node-builder")
const { ProviderV2 } = await import("../../../core/src/provider")
const {
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_NAME,
  CLOUD_WEB_SEARCH_TOOL_ID,
  LOCAL_WEB_SEARCH_TOOL_ID,
  WITHHELD_CLOUD_MCP,
} = await import("./cloud-web-search")

let userDataPath = ""
const keylessWebSearchFlags = [
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL_EXA",
  "OPENCODE_ENABLE_PARALLEL",
  "OPENCODE_EXPERIMENTAL_PARALLEL",
] as const
const managedEnv = [
  "SHELL",
  "ALPHA_GLOBAL_DIR",
  "ALPHA_CLOUD_MCP_URL",
  "ALPHA_CLOUD_TOKEN",
  "ALPHA_MCP_TOKEN",
  "ALPHA_ENV_FILE",
  "ALPHA_SECRETS_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  ...keylessWebSearchFlags,
  "OPENCODE_EXPERIMENTAL",
] as const
const savedEnv: Partial<Record<(typeof managedEnv)[number], string>> = {}

beforeEach(() => {
  forkCalls.length = 0
  resetDanglingSweepLatchForTests()
  creditDanglingSweepForSpawn()
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
  creditDanglingSweepForSpawn()
  const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
    userDataPath,
    healthCheck: async () => true,
    planFence: fakePlanFence,
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
  // #1195:登录信封带 mcp_access_token 时 applyAuthEnv 同步写它;它是 #1195 起的代付判据文件源。
  process.env.ALPHA_MCP_TOKEN = "mcp-token"
}

function applyAuthEnvLikeLogout() {
  delete process.env.ALPHA_CLOUD_TOKEN
  delete process.env.ALPHA_MCP_TOKEN
}

function webSearchToolSnapshot(env: Record<string, string | undefined>) {
  const local = keylessWebSearchFlags.some((key) => env[key] === "1")
  return [
    ...(local ? ["websearch"] : []),
    ...(process.env.ALPHA_CLOUD_MCP_URL && hasSecretFile(userDataPath, "ALPHA_MCP_TOKEN")
      ? ["cloud_web_search"]
      : []),
  ]
}

const allFlagsOff = Object.fromEntries(keylessWebSearchFlags.map((key) => [key, "0"]))

function keylessFlagsOf(env: Record<string, string | undefined>) {
  return Object.fromEntries(keylessWebSearchFlags.map((key) => [key, env[key]]))
}

describe("web search sovereignty at sidecar fork (#621)", () => {
  // `#1411`(REQ-1414 CODE-1,owner 2026-09-23 裁决)—— 这两条以前断言的是相反的事:
  // 「登录 ⇒ fork 时把四个 keyless flag 覆盖写 "0"」「登录 ⇒ 压掉用户 shell export」。
  // 那是 ADR-009 B1 的落点,已被推翻:**账户信号只决定云腿在不在,不决定本地腿在不在**。
  test("登录用户冷启动:本地 keyless 腿在 fork 时不被关掉,两条腿一起进 sidecar", async () => {
    // 真实顺序:preferAppEnv 先跑,此刻 initAuthEnv 还没写 ALPHA_CLOUD_MCP_URL/token。
    preferAppEnv(userDataPath)
    expect(process.env.OPENCODE_ENABLE_EXA).toBe("1")

    applyAuthEnvLikeLogin()

    const env = await forkSidecar()
    // `#1411` 之前这里是 `toEqual(allFlagsOff)`。
    expect(env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(env.ALPHA_LOCAL_WEBSEARCH_DENY).toBeUndefined()
    expect(webSearchToolSnapshot(env)).toEqual(["websearch", "cloud_web_search"])
  })

  test("登录用户冷启动:用户 shell export 的 keyless flag 照旧原样进 sidecar", async () => {
    process.env.OPENCODE_ENABLE_PARALLEL = "1"

    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    const env = await forkSidecar()
    // `#1411` 之前这里是 `toBe("0")`。
    expect(env.OPENCODE_ENABLE_PARALLEL).toBe("1")
    expect(webSearchToolSnapshot(env)).toEqual(["websearch", "cloud_web_search"])
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

  // `#1411`:驱动态从「登录 → 登出」换成「kill-switch 开 → 关」—— 被测机制(force-off 会销毁用户
  // 真值,所以必须先留底再还原)一个字没变,只是现在唯一会 force-off 的是 kill-switch。
  // 登录/登出那一半改为断言它**根本不动**这四个 flag。
  test("kill-switch 关掉之后 respawn 还回 keyless 基线,而不是把它永久哑在 \"0\"", async () => {
    process.env.OPENCODE_ENABLE_PARALLEL = "1" // 用户 shell 的真 export

    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()
    expect(keylessFlagsOf(await forkSidecar()).OPENCODE_ENABLE_PARALLEL).toBe("1")

    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    expect(keylessFlagsOf(await forkSidecar())).toEqual(allFlagsOff)

    delete process.env.ALPHA_WEBSEARCH_DISABLE

    const env = await forkSidecar()
    expect(env.OPENCODE_ENABLE_PARALLEL).toBe("1")
    expect(env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(webSearchToolSnapshot(env)).toEqual(["websearch", "cloud_web_search"])

    applyAuthEnvLikeLogout()

    const loggedOut = await forkSidecar()
    expect(loggedOut.OPENCODE_ENABLE_PARALLEL).toBe("1")
    expect(webSearchToolSnapshot(loggedOut)).toEqual(["websearch"])
  })

  test("re-forking without an auth change is idempotent", async () => {
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    expect(keylessFlagsOf(await forkSidecar())).toEqual(keylessFlagsOf(await forkSidecar()))
  })

  // #223 R2 Blocker 1:env force-off 与注入的 permission deny 都能被后置规则顶掉(agent wildcard /
  // 持久 session permission / approved)。主权判决必须另有一条到得了**工具自身**的通道 —— 这条
  // 断言走真实 fork,证明判决确实进了 sidecar 的 env(即 sidecar-env 白名单也放行了它)。
  test("the sovereignty verdict reaches the sidecar so the tool itself can refuse", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    preferAppEnv(userDataPath)

    expect((await forkSidecar()).ALPHA_LOCAL_WEBSEARCH_DENY).toBe("1")
  })

  // `#1411`:以前这条叫「platform pays also ships the sovereignty verdict to the sidecar」,断言
  // 代付也置位本地拒绝判决。代付不再关本地腿 ⇒ 这条判决在代付态必须缺席,否则工具自身那道最终闸
  // 会把本地腿在**执行时**拒掉(permission 层看不出来,模型只会拿到一句「别重试」)。
  test("代付不再把本地拒绝判决送进 sidecar —— 两条腿的通道都保持干净", async () => {
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    const env = await forkSidecar()
    expect(env.ALPHA_LOCAL_WEBSEARCH_DENY).toBeUndefined()
    expect(env.ALPHA_CLOUD_WEBSEARCH_DENY).toBeUndefined()
  })

  test("`#1195` 判据换轴:登录但无 mcp_access(旧轴文件在、新轴文件缺)不算代付,keyless 保持可用", async () => {
    // pre-T1 服务端 / 信封未带字段的真实形态:applyAuthEnv 写了 ALPHA_CLOUD_TOKEN,没写 ALPHA_MCP_TOKEN。
    // 旧轴(ALPHA_CLOUD_TOKEN)的错误实现会在这里把 keyless 关掉 —— 当场红。
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()
    delete process.env.ALPHA_MCP_TOKEN

    const env = await forkSidecar()
    expect(env.ALPHA_LOCAL_WEBSEARCH_DENY).toBeUndefined()
    expect(webSearchToolSnapshot(env)).toEqual(["websearch"])
  })

  // `#1411`:同上,驱动态换成 kill-switch —— 「判决必须两个方向都写」这条纪律没变,变的是唯一能
  // 置位它的状态。登出那一格追加一条:它在任何方向上都不该让判决重新出现。
  test("kill-switch 关掉之后 respawn 清掉本地拒绝判决,而不是把工具留在死状态", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()
    expect((await forkSidecar()).ALPHA_LOCAL_WEBSEARCH_DENY).toBe("1")

    delete process.env.ALPHA_WEBSEARCH_DISABLE

    expect((await forkSidecar()).ALPHA_LOCAL_WEBSEARCH_DENY).toBeUndefined()

    applyAuthEnvLikeLogout()

    expect((await forkSidecar()).ALPHA_LOCAL_WEBSEARCH_DENY).toBeUndefined()
  })

  // #223 R3:云侧的同一条通道。`cloud_web_search` 是远端 MCP 工具,没有 alpha 能改的 execute
  // 首行;最终闸在 @alpha-code/ext 的 tool.execute.before 钩子里,靠这个变量过河。它只在
  // kill-switch 时置位 —— 平台代付态下云工具正是权威通道,不能连它一起关。
  test("the kill switch ships a cloud verdict to the sidecar; platform-pays does not", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    preferAppEnv(userDataPath)
    expect((await forkSidecar()).ALPHA_CLOUD_WEBSEARCH_DENY).toBe("1")

    delete process.env.ALPHA_WEBSEARCH_DISABLE
    applyAuthEnvLikeLogin()
    const paying = await forkSidecar()
    // `#1411`:以前这里是 `toBe("1")` —— 代付即关本地腿。现在代付两条判决都不置位。
    expect(paying.ALPHA_LOCAL_WEBSEARCH_DENY).toBeUndefined()
    expect(paying.ALPHA_CLOUD_WEBSEARCH_DENY).toBeUndefined()
  })

  test("turning the kill switch back off clears the cloud verdict on the next fork", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()
    expect((await forkSidecar()).ALPHA_CLOUD_WEBSEARCH_DENY).toBe("1")

    delete process.env.ALPHA_WEBSEARCH_DISABLE

    expect((await forkSidecar()).ALPHA_CLOUD_WEBSEARCH_DENY).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `#1411`(REQ-1414 CODE-1)—— 退出条件 ①:**登录代付态下模型工具表同时含 `websearch` 与
// `cloud_cloud_web_search`**。
//
// 方案基线(`docs/design/2026-09-23-1414-web-tools-account-routing-baseline.md` §九 第 1 条)把这件事
// 明确标为「从代码结构推出来的**推论**,不是跑出来的」。这一组把它跑成事实。
//
// 「模型工具表」一条规则都不手写,四个供数方全是生产自己的:
//   ① main 的 `applyWebSearchSovereignty()` + `createSidecarEnv()` 白名单 —— 经真 `spawnLocalServer`
//      fork 出来的那份 env(`forkSidecar()`,与上面那组同一条路径);
//   ② 引擎的 `RuntimeFlags`(用真 `ConfigProvider` 解析①给出的那份 env,不是手写 `env[k] === "1"`);
//   ③ 引擎的 `webSearchEnabled()` —— 本地腿的**注册**闸,`tool/registry.ts` 的 `tools()` 用的就是它;
//   ④ 注入面的真 `injectAlphaConfig()` → 引擎的真 `Permission.fromConfig` + `Permission.disabled`
//      —— 两条腿的**可见性**闸,`session/llm/request.ts` 的 `resolveTools()` 用的就是它。
//
// 手段的自证(先证明它测得出已知的坏,再用它判未知的好):kill-switch 臂走同一条链,两条腿必须
// 一个都不在表里 —— 它同时覆盖②(flag 被 force-off)与④(permission deny)。
//
// 诚实边界,不粉饰:
//   · 「登录+有额度」与「登录+无额度」在桌面侧**不可区分**(account 契约里没有只读额度查询,
//     基线 §1.1(b)),两者在这里是同一格;「无额度」的可观察差别是云腿调用时的 402,不在本票范围。
//   · 云腿的「注册与否」判据只保证**代付且无 kill-switch**这一格准确:kill-switch 下真定义经
//     ARM/DEF 交给 ext 的 `installCloudMcp()`,它读不到 `{file:}` 凭证时会响亮不装 —— 那半格这里
//     一律按「已注册」处理,再由 permission deny 兜住,两条路径结论相同(都不在表里)。
// ─────────────────────────────────────────────────────────────────────────────
describe("`#1411` 模型工具表:两条腿按账户态的真实在场性", () => {
  /** 非平台 provider —— 用它是为了让「本地腿在不在」真的由那四个 keyless flag 决定:
   *  `webSearchEnabled()` 对 `opencode`/`opencode-go` 无条件放行,拿它当被测 provider 会让①②③恒真。 */
  const BYOK_PROVIDER = ProviderV2.ID.make("deepseek-byok")

  /** 引擎自己怎么解释这份 env(真 `RuntimeFlags`,真 `ConfigProvider`)。 */
  const engineFlags = (env: Record<string, string | undefined>) =>
    Effect.runSync(
      RuntimeFlags.Service.useSync((flags) => ({ exa: flags.enableExa, parallel: flags.enableParallel })).pipe(
        Effect.provide(
          AppNodeBuilder.build(RuntimeFlags.node).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          ),
        ),
      ),
    )

  /** 在「sidecar 真正拿到的那份 env」下跑真注入面,拿它写出的引擎配置与它自己置位的 env。 */
  function injectUnderSidecarEnv(forkEnv: Record<string, string | undefined>) {
    const saved = { ...process.env }
    for (const key of Object.keys(process.env)) delete process.env[key]
    for (const [key, value] of Object.entries(forkEnv)) if (value !== undefined) process.env[key] = value
    try {
      // 注入面的三个环境根钉进本用例的临时盘,免得读到宿主机的真实配置。
      process.env.ALPHA_GLOBAL_DIR = join(userDataPath, "alpha-code-state", "env", "dev")
      process.env.XDG_CONFIG_HOME = join(userDataPath, "xdg-config")
      process.env.XDG_DATA_HOME = join(userDataPath, "xdg-data")
      mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
      // 先证明注入真的跑成了 —— 它有一层函数级 catch,拿一份空配置当结论正是本文件要防的那类假绿。
      expect(injectAlphaConfig(userDataPath, undefined, "stable")).toEqual({ ok: true })
      const content = process.env.OPENCODE_CONFIG_CONTENT
      expect(typeof content).toBe("string")
      return { config: JSON.parse(content!) as EngineConfigShape, env: { ...process.env } }
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  }

  type McpEntry = { url?: string; enabled?: boolean }
  type EngineConfigShape = { permission?: Record<string, unknown>; mcp?: Record<string, McpEntry | undefined> }

  /** 云腿到底注册没注册:注入面写进配置的那条定义,或 ARM+DEF 一起交给 ext 装的那条(缺一 ext 不装)。 */
  function cloudLegRegistered({ config, env }: { config: EngineConfigShape; env: Record<string, string | undefined> }) {
    const connectable = (entry: McpEntry | undefined) =>
      Boolean(entry) && entry!.enabled !== false && entry!.url !== WITHHELD_CLOUD_MCP.url
    if (connectable(config.mcp?.[CLOUD_MCP_SERVER_NAME])) return true
    const handed = env[CLOUD_MCP_ARM_ENV] && env[CLOUD_MCP_DEF_ENV] ? (JSON.parse(env[CLOUD_MCP_DEF_ENV]!) as McpEntry) : undefined
    return connectable(handed)
  }

  /** 模型这一刻真正拿得到的那两个 web search 工具。 */
  function modelWebSearchTools(forkEnv: Record<string, string | undefined>) {
    const flags = engineFlags(forkEnv)
    const injected = injectUnderSidecarEnv(forkEnv)
    const registered = [
      ...(webSearchEnabled(BYOK_PROVIDER, flags) ? [LOCAL_WEB_SEARCH_TOOL_ID] : []),
      ...(cloudLegRegistered(injected) ? [CLOUD_WEB_SEARCH_TOOL_ID] : []),
    ]
    const hidden = Permission.disabled(registered, Permission.fromConfig((injected.config.permission ?? {}) as never))
    return registered.filter((id) => !hidden.has(id))
  }

  test("登录代付:`websearch` 与 `cloud_cloud_web_search` **同时**在模型工具表里", async () => {
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    expect(modelWebSearchTools(await forkSidecar())).toEqual([LOCAL_WEB_SEARCH_TOOL_ID, CLOUD_WEB_SEARCH_TOOL_ID])
  })

  test("登出 / BYOK:只有本地腿在表里(云腿没有凭证,注入面给的是 enabled:false)", async () => {
    preferAppEnv(userDataPath)

    expect(modelWebSearchTools(await forkSidecar())).toEqual([LOCAL_WEB_SEARCH_TOOL_ID])
  })

  // 反例臂 —— 证明上面那两条不是「怎么测都绿」:同一条链在 kill-switch 下两条腿一个都不在表里。
  test("kill-switch:同一条链下两条腿一个都不在表里(手段测得出已知的坏)", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()

    expect(modelWebSearchTools(await forkSidecar())).toEqual([])
  })

  test("kill-switch 关掉之后,下一次 fork 两条腿一起回来", async () => {
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    preferAppEnv(userDataPath)
    applyAuthEnvLikeLogin()
    expect(modelWebSearchTools(await forkSidecar())).toEqual([])

    delete process.env.ALPHA_WEBSEARCH_DISABLE

    expect(modelWebSearchTools(await forkSidecar())).toEqual([LOCAL_WEB_SEARCH_TOOL_ID, CLOUD_WEB_SEARCH_TOOL_ID])
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

  // `#1411`:驱动 force-off 的状态从「登录」换成 kill-switch(登录不再关本地腿),被测的
  // 「基线必须在真实 shell 导入**之后**截取」这条 Major 3 判据一个字没变 —— 只是换了驱动它的开关。
  // 顺带钉住新事实:登录/登出这一整圈根本不该动那四个 flag。
  test("a shell-exported keyless flag survives the kill-switch on → off round trip", async () => {
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

    // ②(`#1411`)登录/登出整圈不动这四个 flag —— 本地腿与账户状态解耦。
    applyAuthEnvLikeLogin()
    expect((await forkSidecar()).OPENCODE_ENABLE_PARALLEL).toBe("1")
    applyAuthEnvLikeLogout()
    expect((await forkSidecar()).OPENCODE_ENABLE_PARALLEL).toBe("1")

    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    expect(keylessFlagsOf(await forkSidecar())).toEqual(allFlagsOff)

    delete process.env.ALPHA_WEBSEARCH_DISABLE
    // ③ kill-switch 关掉后 respawn 还原的必须是用户真值,而不是「探测之前的空基线」。
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

    // `#1411`:同上 —— 登录不再 force-off,能 force-off 的只有 kill-switch。
    applyAuthEnvLikeLogin()
    expect((await forkSidecar()).OPENCODE_ENABLE_PARALLEL).toBe("1")

    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    expect(keylessFlagsOf(await forkSidecar())).toEqual(allFlagsOff)

    delete process.env.ALPHA_WEBSEARCH_DISABLE
    expect((await forkSidecar()).OPENCODE_ENABLE_PARALLEL).toBe("1")
  })
})

describe("spawnLocalServer", () => {
  test("token rotation bounds graceful stop at 500ms while the default keeps the 6s budget", async () => {
    class HangingStopChild extends FakeChild {
      kills = 0

      postMessage(message: { type: string }) {
        if (message.type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
        // stop 故意不 exit:复现活动连接拖住 graceful stop 的 packaged 现场。
      }

      kill() {
        this.kills++
        queueMicrotask(() => this.emit("exit", 0))
      }
    }

    const run = async (mode: "token-rotation" | "graceful", beforeKillMs: number) => {
      creditDanglingSweepForSpawn()
      const child = new HangingStopChild()
      const result = await spawnLocalServer("127.0.0.1", 4098, "password", {
        userDataPath,
        healthCheck: async () => true,
        planFence: fakePlanFence,
        fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
      })
      await result.health.wait

      const stopping = result.listener.stop(mode)
      vi.advanceTimersByTime(beforeKillMs)
      await Promise.resolve()
      expect(child.kills).toBe(0)
      vi.advanceTimersByTime(1)
      await stopping
      expect(child.kills).toBe(1)
    }

    vi.useFakeTimers()
    try {
      await run("token-rotation", 499)
      await run("graceful", 5_999)
    } finally {
      vi.useRealTimers()
    }
  })

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
        planFence: fakePlanFence,
        fork: fakeFork,
      }),
    ).rejects.toThrow(/alpha-secrets sync failed/)
    expect(forkCalls).toHaveLength(0)
  })

  // REQ-226 `#1343` AC4 咽喉点在**这条**生产 fork 路径上:自定义服务密钥 = 钥匙串库 → custom-provider--<id>
  // 文件,不经 env;sidecar env 里没有值;只有「真源文件里的 id ∩ 库键集」才物化(孤儿条目不落盘);
  // 库里没了 ⇒ 下一次 fork 清扫文件(与目录 BYOK 同一撤销语义)。
  test("REQ-226: an off-catalog custom provider's key is materialized keychain → file at fork; the forked env never carries it; gone from the store ⇒ swept next fork", async () => {
    const base = join(realpathSync(userDataPath), "alpha-code-state")
    const root = join(base, "env", "dev")
    mkdirSync(root, { recursive: true })
    // `#1392`:记录的真源是 <casBaseRoot>/custom-providers/<env>.json(围栏写不到的那棵树),alpha.jsonc 里的
    // provider 块从此**既不注入也不物化**。本用例因此播在真源上 —— 播错地方时这条用例就不再驱动 fork 前物化那一步
    // (2026-09-22 `#1392` 合入后实测转红,`#1416`)。用生产写端落盘,不在这里手抄它的字节。
    writeCustomProviderTruth(
      join(base, "custom-providers", "dev.json"),
      [{ id: "my-endpoint", name: "Mine", compat: "openai", baseURL: "https://x.invalid/v1", models: ["m"] }],
      { mkdirSync, writeFileSync, renameSync, rmSync },
    )
    process.env.ALPHA_GLOBAL_DIR = root
    const value = "test-value-not-a-real-key-Zq81"
    initByokKeys(userDataPath)
    try {
      expect(storeByokKey("my-endpoint", value)).toEqual({ ok: true })
      expect(storeByokKey("orphan", `${value}-orphan`)).toEqual({ ok: true })
      const env = await forkSidecar()
      const file = "custom-provider--my-endpoint"
      expect(hasSecretFile(userDataPath, file)).toBe(true)
      expect(readFileSync(secretFilePath(userDataPath, file), "utf8")).toBe(value)
      expect(hasSecretFile(userDataPath, "custom-provider--orphan")).toBe(false)
      expect(JSON.stringify(env)).not.toContain("test-value")
      clearByokKeys()
      initByokKeys(userDataPath)
      await forkSidecar()
      expect(hasSecretFile(userDataPath, file)).toBe(false)
    } finally {
      clearByokKeys()
    }
  })

  test("forks the sidecar in the userData scratch directory", async () => {
    const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
      userDataPath,
      healthCheck: async () => true,
      planFence: fakePlanFence,
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
      planFence: fakePlanFence,
      fork: (() => new InjectionFailedChild()) as unknown as typeof import("electron").utilityProcess.fork,
    })
    await result.health.wait

    expect(result.injectionFailure).toEqual({ message: "ENOTDIR: mkdir userdata" })

    await result.listener.stop()
  })
})
