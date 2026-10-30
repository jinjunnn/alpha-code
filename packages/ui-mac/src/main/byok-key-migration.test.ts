// REQ-237 `#1556` AC5(方案 §2.3 读者迁移表 / I11)—— 迁移前已配置的 BYOK Key 在目录格式迁移后仍然可用。
//
// 迁移把 `keyEnv` / `baseURL` / `compat` 从随包目录搬进 App 内置适配器表(byok-adapters.ts),随包 BYOK 段改成
// ByokCatalogV1 形状。四个直接读者若仍读旧字段,已存的 Key 会**静默**失效:映射不到 env ⇒ 不物化;更糟的是
// syncSecretFiles 的清理分支会把「不在 wanted 集」的既有密钥文件删掉 ⇒ 已配好的直连全部不可执行。
//
// 这里照生产 fork 的顺序走一遍(index.ts 启动 → server.ts spawnLocalServer):
//   钥匙串里一把**真实存储格式**的 Key(alpha-byok-keys.json `{v:1, enc}`,与 persist() 写出的同形)
//   → initByokKeys → injectByokKeysIntoEnv → syncSecretFiles → pinAppliedCatalog → buildAlphaModelConfig
//   → 真引擎(packages/opencode/src/index.ts run,与打包 sidecar 同一份请求装配)发一次请求,
// 断言:引擎配置里有这个 provider、`{file:}` 指向的文件在、本地桩收到的鉴权头就是这把 Key;迁移前就在盘上的
// 密钥文件在前后两次 fork 里都没被清理分支删掉。只把生产配置里该 provider 的 baseURL 改指本地桩
// (alpha-reasoning-badge-parity.test.ts 同款);其余全是生产函数。
//
// 先红后绿:把 alpha-secret-files.ts 的 secretEnvVars 改回只含平台三项(BYOK 读者没迁好时的效果),第一条断言
// 「removed 不含 DEEPSEEK_API_KEY」转红;把 alpha-byok-keys.ts 的 keyEnvFor 改成返回 undefined,物化那一步转红。

import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const flip = (input: Uint8Array): Buffer => {
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ 0x5a
  return out
}
mock.module("./alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => flip(Buffer.from(value, "utf8")),
    decryptString: (value: Buffer) => flip(value).toString("utf8"),
  }),
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))
const { clearByokKeys, getByokKey, initByokKeys, injectByokKeysIntoEnv } = await import("./alpha-byok-keys")
const { secretFilePath, secretFileRef, syncSecretFiles } = await import("./alpha-secret-files")
const { pinAppliedCatalog } = await import("./alpha-live-allowlist")
const { buildAlphaModelConfig } = await import("./alpha-models")

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const engineEntry = path.resolve(repoRoot, "packages/opencode/src/index.ts")
const modelsFixture = path.resolve(repoRoot, "packages/opencode/test/tool/fixtures/models-api.json")
const BUN_EXEC = process.execPath
const PATH_AT_LOAD = process.env.PATH ?? ""

// 刻意不像真密钥的测试值;它只出现在本进程起的本地桩上。
const STORED_KEY = "test-stored-key-not-real-Zq81-1556"
const MANAGED = ["DEEPSEEK_API_KEY", "ALPHA_MODELS_DISABLE", "ALPHA_BASE_URL", "ALPHA_DEFAULT_MODEL", "ALPHA_GLOBAL_DIR", "OPENCODE_CONFIG_DIR"]
const saved: Record<string, string | undefined> = {}
let root = ""
let userData = ""
let server: ReturnType<typeof Bun.serve> | undefined
const seen: Array<{ path: string; authorization: string | null }> = []

function sse() {
  const enc = new TextEncoder()
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return new ReadableStream({
    start(controller) {
      for (const item of [chunk({ role: "assistant", content: "ok" }, null), chunk({}, "stop"), "data: [DONE]\n\n"]) controller.enqueue(enc.encode(item))
      controller.close()
    },
  })
}

beforeAll(() => {
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "byok-key-migration-")))
  userData = path.join(root, "userdata")
  fs.mkdirSync(userData, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = path.join(root, "alpha-global", "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config-dir")
  fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, authorization: request.headers.get("authorization") })
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [] })
      await request.text()
      return new Response(sse(), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
})

afterAll(() => {
  server?.stop(true)
  clearByokKeys()
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test("`#1556` AC5:迁移前已存的 BYOK Key → 物化为密钥文件、注入引擎配置、真引擎请求带上它;既有密钥文件两次 fork 都不被删", async () => {
  // ① 迁移前的盘面:钥匙串金库(persist() 写出的形状)+ 上一版 fork 留下的密钥文件。
  fs.writeFileSync(
    path.join(userData, "alpha-byok-keys.json"),
    JSON.stringify({ v: 1, enc: flip(Buffer.from(JSON.stringify({ deepseek: STORED_KEY }), "utf8")).toString("base64") }),
    { mode: 0o600 },
  )
  const keyFile = secretFilePath(userData, "DEEPSEEK_API_KEY")
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(keyFile, STORED_KEY, { mode: 0o600 })

  // ② 新版启动:读金库 → 按适配器表的 Key 名注入 main env → fork 前物化 → 钉住目录 → 装配引擎配置。
  initByokKeys(userData)
  expect(getByokKey("deepseek")).toBe(STORED_KEY)
  injectByokKeysIntoEnv()
  expect(process.env.DEEPSEEK_API_KEY).toBe(STORED_KEY)
  for (const generation of [1, 2]) {
    const sync = syncSecretFiles(userData, process.env, {})
    expect({ generation, written: sync.written.includes("DEEPSEEK_API_KEY"), removed: sync.removed }).toEqual({
      generation,
      written: true,
      removed: [],
    })
    expect(fs.readFileSync(keyFile, "utf8")).toBe(STORED_KEY)
    pinAppliedCatalog(userData, generation)
  }

  const config = buildAlphaModelConfig(userData)!
  expect(config.enabled_providers).toContain("deepseek-byok")
  const node = config.provider["deepseek-byok"] as { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }
  expect(node.options.apiKey).toBe(secretFileRef(userData, "DEEPSEEK_API_KEY"))
  expect(fs.existsSync(keyFile)).toBe(true)
  expect(JSON.stringify(config)).not.toContain(STORED_KEY) // 配置里只有 {file:} 引用(A6)

  // ③ 真引擎发一次请求:只把这个 provider 的端点改指本地桩,鉴权头必须是金库里那把 Key。
  node.options.baseURL = `http://127.0.0.1:${server!.port}/byok/v1`
  const dir = path.join(root, "run")
  for (const sub of ["home", "xdg-config", "xdg-data", "xdg-cache", "xdg-state", "proj"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(configPath, JSON.stringify(config))
  const proc = Bun.spawn([BUN_EXEC, "run", engineEntry, "run", "--print-logs", "--dir", path.join(dir, "proj"), "--model", "deepseek-byok/deepseek-v4-pro", "hi"], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: PATH_AT_LOAD,
      HOME: path.join(dir, "home"),
      XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
      XDG_DATA_HOME: path.join(dir, "xdg-data"),
      XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
      XDG_STATE_HOME: path.join(dir, "xdg-state"),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      NO_COLOR: "1",
      ALPHA_GLOBAL_DIR: process.env.ALPHA_GLOBAL_DIR!,
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_MODELS_PATH: modelsFixture,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DB: path.join(dir, "engine.db"),
    },
  })
  const killer = setTimeout(() => proc.kill(), 90_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const rc = await proc.exited
  clearTimeout(killer)
  const log = `${stdout}\n${stderr}`.slice(-1500)
  expect(rc, log).toBe(0)
  const completions = seen.filter((entry) => entry.path.endsWith("/chat/completions"))
  expect(completions.length, log).toBeGreaterThan(0)
  for (const entry of completions) expect(entry.authorization).toBe(`Bearer ${STORED_KEY}`)
}, 120_000)
