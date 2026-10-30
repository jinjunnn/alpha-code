// REQ-236 AC2 / AC3(`#1562`)—— 续期热应用的端到端判据:**真引擎 + 真 ext + 本机假网关**。
//
// 「真引擎」= 本仓 `packages/opencode/src/index.ts serve`(与打包 sidecar 同一份 v1 请求装配:provider.ts 的 SDK 缓存
// → session/llm/request.ts 触发 `chat.headers` → streamText);「真 ext」= `packages/ext/src/plugin.ts` 经配置
// `plugin` 装进引擎(与 sidecar 注入同一个入口,钩子同一份);配置由**生产** `buildAlphaModelConfig` 生成(平台
// provider 的 apiKey 是占位值),只把 `ALPHA_BASE_URL` 指到本进程起的假网关;凭据文件由**生产**
// `syncSecretFiles`(fork 时)与 `applyPlatformCredentialsHot`(续期时)写。引用 `ALPHA_PLATFORM_AUTH_REF` 由生产
// `secretFileRef` 给出,与 server.ts 在 fork 时置的那一份同形。
//
// 一个引擎进程里连发三条消息,中间换文件 / 删文件 —— 只有「同一个进程、不重启」才证明 SDK 缓存不再握旧令牌:
//   ① 令牌 A ⇒ 网关收到的每个请求都带 `Bearer A`;
//   ② 热应用令牌 B(不重启)⇒ 下一条消息的每个请求都带 `Bearer B`,一个 A 都没有;
//   ③ 删掉凭据文件 ⇒ 下一条消息以 `ProviderAuthError` 失败,且网关**一个请求都没收到**(发出前被拒,不回落)。
// 反向臂(手段自证):同一份配置去掉 ext 钩子 ⇒ 网关收到的是占位值,被网关拒 —— 证明 ①② 里的令牌确实来自钩子,
// 而不是配置里还藏着凭据。哨兵臂:令牌是可识别哨兵串,引擎 stdout/stderr 与 HTTP 响应体里一次都不出现。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { PLATFORM_API_KEY_PLACEHOLDER, buildAlphaModelConfig } from "./alpha-models"
import { applyPlatformCredentialsHot, secretFilePath, secretFileRef, syncSecretFiles } from "./alpha-secret-files"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const engineEntry = path.resolve(repoRoot, "packages/opencode/src/index.ts")
const extEntry = path.resolve(repoRoot, "packages/ext/src/plugin.ts")
const modelsFixture = path.resolve(repoRoot, "packages/opencode/test/tool/fixtures/models-api.json")
/** 全量并跑时有测试文件会改写 `process.env.PATH`:引擎子进程用绝对 bun 路径 + 装载期 PATH 快照。 */
const BUN_EXEC = process.execPath
const PATH_AT_LOAD = process.env.PATH ?? ""

const TOKEN_A = "SENTINEL-HOT-APPLY-TOKEN-A-6c1f0e"
const TOKEN_B = "SENTINEL-HOT-APPLY-TOKEN-B-93ad27"

const MANAGED = ["ALPHA_MODELS_DISABLE", "ALPHA_BASE_URL", "ALPHA_DEFAULT_MODEL", "ALPHA_GLOBAL_DIR"]
const saved: Record<string, string | undefined> = {}

let root = ""
let userData = ""
let gateway: ReturnType<typeof Bun.serve> | undefined
/** 网关收到的每个 chat 请求的 Authorization 头(按到达顺序)。 */
const seen: string[] = []
const responseBodies: string[] = []

function sse(text: string) {
  const enc = new TextEncoder()
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(chunk({ role: "assistant", content: text }, null)))
      controller.enqueue(enc.encode(chunk({}, "stop")))
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}

beforeAll(() => {
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-token-hot-apply-")))
  userData = path.join(root, "userdata")
  process.env.ALPHA_GLOBAL_DIR = path.join(root, "alpha-global", "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  // 假网关:只认已签发的两个令牌;别的(含占位值)一律 401 —— 与真网关「凭据不对就拒」同一结论。
  gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [] })
      await request.text()
      const authorization = request.headers.get("authorization") ?? "<none>"
      seen.push(authorization)
      if (authorization !== `Bearer ${TOKEN_A}` && authorization !== `Bearer ${TOKEN_B}`)
        return Response.json({ error: { message: "invalid credential", type: "invalid_request_error" } }, { status: 401 })
      return new Response(sse("ok"), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  process.env.ALPHA_BASE_URL = `http://127.0.0.1:${gateway.port}/v1`
})

afterAll(() => {
  gateway?.stop(true)
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

type Engine = { url: string; directory: string; model: string; output: () => string; stop: () => void }

/** 起一个真引擎(隔离 HOME/XDG/DB);`withExt` 决定配置里有没有 ext 插件。 */
async function startEngine(tag: string, withExt: boolean): Promise<Engine> {
  const dir = path.join(root, "runs", tag)
  for (const sub of ["home", "xdg-config", "xdg-data", "xdg-cache", "xdg-state", "proj"])
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const cfg = buildAlphaModelConfig(userData)
  if (!cfg?.provider.alpha) throw new Error("生产 buildAlphaModelConfig 没给出平台 provider —— 凭据文件或 ALPHA_BASE_URL 缺席?")
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(configPath, JSON.stringify({ ...cfg, ...(withExt ? { plugin: [pathToFileURL(extEntry).href] } : {}) }))
  const port = 4600 + Math.floor(Math.random() * 3000)
  const proc = Bun.spawn([BUN_EXEC, "run", engineEntry, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
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
      ALPHA_BASE_URL: process.env.ALPHA_BASE_URL!,
      ALPHA_GLOBAL_DIR: process.env.ALPHA_GLOBAL_DIR!,
      ALPHA_PLATFORM_AUTH_REF: secretFileRef(userData, "ALPHA_API_KEY"),
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_MODELS_PATH: modelsFixture,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DB: path.join(dir, "engine.db"),
    },
  })
  let stdout = ""
  let stderr = ""
  const decoder = new TextDecoder()
  void (async () => {
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk)
  })()
  const reader = proc.stdout.getReader()
  const deadline = Date.now() + 90_000
  while (!stdout.includes("listening")) {
    if (Date.now() > deadline) throw new Error(`engine did not listen; stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`)
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`engine exited before listening; stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`)
    stdout += decoder.decode(chunk.value)
  }
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (chunk.done) return
      stdout += decoder.decode(chunk.value)
    }
  })()
  return {
    url: `http://127.0.0.1:${port}`,
    directory: path.join(dir, "proj"),
    model: Object.keys(cfg.provider.alpha.models)[0]!,
    output: () => `${stdout}\n${stderr}`,
    stop: () => proc.kill(),
  }
}

async function call(engine: Engine, route: string, body: unknown) {
  const response = await fetch(`${engine.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": engine.directory },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  responseBodies.push(text)
  if (!response.ok) throw new Error(`${route} -> ${response.status}: ${text.slice(0, 400)}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** 发一条消息并等它结束;返回 assistant 消息的 error(没有则 undefined)与这条消息期间网关收到的头。 */
async function prompt(engine: Engine, sessionID: string) {
  const before = seen.length
  const result = await call(engine, `/session/${sessionID}/message`, {
    model: { providerID: "alpha", modelID: engine.model },
    parts: [{ type: "text", text: "hi" }],
  })
  const info = result.info as { error?: { name?: string } }
  return { error: info.error, headers: seen.slice(before) }
}

describe("REQ-236 #1562 续期热应用:同一个引擎进程里换凭据文件", () => {
  test(
    "换文件后下一请求带新令牌;删文件后请求在发出前以 ProviderAuthError 失败、网关零请求;令牌不进引擎输出",
    async () => {
      // fork 时:生产 syncSecretFiles 物化令牌 A,记录 fork 时的凭据集合(server.ts 同形)。
      const forked = new Set(syncSecretFiles(userData, { ALPHA_API_KEY: TOKEN_A }).written)
      const engine = await startEngine("hot", true)
      try {
        const session = await call(engine, "/session", {})
        const sessionID = String(session.id)

        const first = await prompt(engine, sessionID)
        expect(first.error).toBeUndefined()
        expect(first.headers.length).toBeGreaterThan(0)
        expect(new Set(first.headers)).toEqual(new Set([`Bearer ${TOKEN_A}`]))

        // 续期:生产热应用把令牌 B 原子写进同一份文件;引擎不重启。
        expect(applyPlatformCredentialsHot(userData, { ALPHA_API_KEY: TOKEN_B }, forked)).toBe("applied")
        expect(fs.readFileSync(secretFilePath(userData, "ALPHA_API_KEY"), "utf8")).toBe(TOKEN_B)
        const second = await prompt(engine, sessionID)
        expect(second.error).toBeUndefined()
        expect(second.headers.length).toBeGreaterThan(0)
        expect(new Set(second.headers)).toEqual(new Set([`Bearer ${TOKEN_B}`]))

        // 读不到:请求在发出前被拒,且不回落 SDK 缓存或配置里的任何值。
        fs.rmSync(secretFilePath(userData, "ALPHA_API_KEY"))
        const started = Date.now()
        const third = await prompt(engine, sessionID)
        expect(third.error?.name).toBe("ProviderAuthError")
        expect(third.headers).toEqual([])
        // 确定性的认证失败不进引擎的退避重试(那条路至少 2+4+8+16+32 秒才放弃);上界取得很宽,只排除「被重试了」。
        expect(Date.now() - started).toBeLessThan(30_000)

        // 哨兵臂:令牌一次都不出现在引擎输出与 HTTP 响应里(请求头之外没有任何一处带它)。
        const output = engine.output()
        expect(output).not.toContain(TOKEN_A)
        expect(output).not.toContain(TOKEN_B)
        expect(responseBodies.join("\n")).not.toContain(TOKEN_A)
        expect(responseBodies.join("\n")).not.toContain(TOKEN_B)
      } finally {
        engine.stop()
      }
    },
    180_000,
  )

  test(
    "反向臂:去掉 ext 钩子 ⇒ 请求带的是占位值,被网关拒(令牌确实只来自钩子)",
    async () => {
      syncSecretFiles(userData, { ALPHA_API_KEY: TOKEN_A })
      const engine = await startEngine("no-ext", false)
      try {
        const session = await call(engine, "/session", {})
        const result = await prompt(engine, String(session.id))
        expect(result.headers.length).toBeGreaterThan(0)
        expect(new Set(result.headers)).toEqual(new Set([`Bearer ${PLATFORM_API_KEY_PLACEHOLDER}`]))
        expect(result.error).toBeDefined()
      } finally {
        engine.stop()
      }
    },
    180_000,
  )
})
