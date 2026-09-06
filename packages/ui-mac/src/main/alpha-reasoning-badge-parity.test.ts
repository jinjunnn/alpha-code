// REQ-153 #1266 / #1267 —— 「推理」徽标 ⇔ 引擎实际带推理参数,**双向**、走桌面可达路径、用真引擎判。
//
// 上一道闸(alpha-models.test.ts,#1236)判的是「徽标集合 == 注入 `reasoning:true` 的集合」——
// 它对的,但它停在 config 这一层。#1239 矩阵实打之后,两个方向都翻了:
//   ① 有徽标 ⇒ 拿不到档:桌面档位 chip 只读目录 JSON 的 `variants`,deepseek-v4-pro / glm-5.2
//      (平台 + 直连)在 chip 上一档都选不到,默认发出去的主请求体**零**推理参数(#1266);
//   ② 无徽标 ⇒ 却在推理:上游 `transform.options()` 不看 `capabilities.reasoning` 就给 gpt-5*
//      写 `reasoning_effort: medium`、给 zhipuai* 写 `thinking: enabled`(#1267)。
// 两个方向单独锁任何一边都看不见另一边,所以这里一次判两边。
//
// 判据形状(每一行 picker 行都过):
//   有徽标 ⇒ chip 列出 ≥1 档;**每一档**经真引擎发出的主请求体带推理控制参数,且档位声明的
//           `reasoningEffort` 值逐字落到 `reasoning_effort` 上;桌面提交层 buildPromptRequest 真的带上它。
//   无徽标 ⇒ chip 零档;默认发出的主请求体**不带**任何推理控制参数。
//
// 「真引擎」= 本仓 `packages/opencode/src/index.ts run`(与打包 sidecar 同一份 v1 请求装配:
// provider.ts 的 config 合并 → transform.variants()/options() → session/llm/request.ts 的 mergeOptions),
// 配置由**生产** `buildAlphaModelConfig` 生成(只把 baseURL 改指向本进程起的假上游)。桌面端与 CLI
// 在这一段共用同一条链:composer 发的 `model.variant` 就是 CLI `--variant` 落到的同一个字段
// (`request.ts:84-87`),所以 CLI 是引擎侧的忠实代理;桌面自己那一头(chip 列表 / 提交层)在本文件
// 用生产函数直接判。
//
// 手段自证先于矩阵:①假上游先吃一个探针请求证明捕获不是恒空;②`alpha/glm-5-turbo --variant high`
// (目录未标 reasoning、上游黑名单)必须**不**带参数 —— 判据会红,不是恒真。
//
// 已知不修(#1267 的另一半):`zhipuai-byok/glm-4.5-air`。它是 BYOK-only 的 id(平台目录没有同名条目),
// 而 BYOK 目录 `models` 是 `string[]`,没有逐模型元数据槽 —— 要给它打徽标 / 给档位是 schema 扩面,
// 超出 #1266/#1267 边界。KNOWN_UNFIXED 里的行只断言「仍然无徽标且仍然带参数」:一旦有人补了槽,
// 这条登记自己会红,必须删掉。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog } from "../shared/alpha-model-types"
import { buildModelPickerRows, type ModelPickerRow } from "../renderer/alpha-ui/model-picker-core"
import { buildPromptRequest } from "../renderer/alpha-ui/composer-state"
import { buildAlphaModelConfig, getModelCatalog } from "./alpha-models"
import { secretFilePath } from "./alpha-secret-files"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const engineEntry = path.resolve(repoRoot, "packages/opencode/src/index.ts")
// 真快照(4.9 MB / 159 providers),让引擎离线也装得出 models.dev 目录;alpha 注入的 provider 不在其中,
// 走的是 config 路径 —— 与打包 sidecar 相同。
const modelsFixture = path.resolve(repoRoot, "packages/opencode/test/tool/fixtures/models-api.json")
/** 全量并跑时有测试文件会改写 `process.env.PATH`:引擎子进程用绝对 bun 路径 + 装载期 PATH 快照。 */
const BUN_EXEC = process.execPath
const PATH_AT_LOAD = process.env.PATH ?? ""

/** 引擎请求体里算作「推理控制」的键(与 #1239 判据同一张表,去掉 `top_k` —— 那是采样参数)。
 *  `thinking: { type: "disabled" }` 是显式关闭,不算「在推理」。 */
const REASONING_KEYS = [
  "reasoning_effort",
  "reasoning",
  "thinking",
  "enable_thinking",
  "chat_template_kwargs",
  "chat_template_args",
  "effort",
  "thinkingConfig",
  "reasoning_summary",
] as const

/** 已知不修:行键 → 理由。登记的行必须**仍然**无徽标且**仍然**带参数,否则这条登记过期,当场红。 */
const KNOWN_UNFIXED: Record<string, string> = {
  "zhipuai-byok:glm-4.5-air":
    "BYOK-only id,平台目录无同名条目可派生徽标/档位;BYOK 目录 models 是 string[] 无逐模型元数据槽(schema 扩面,超出 #1266/#1267 边界)。上游 transform.options() 对 zhipuai* 无条件写 thinking:enabled。",
}

function reasoningControls(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of REASONING_KEYS) {
    if (!(key in body)) continue
    const value = body[key]
    if (key === "thinking" && typeof value === "object" && value !== null && (value as { type?: unknown }).type === "disabled") continue
    out[key] = value
  }
  return out
}

const MANAGED = ["ALPHA_MODELS_DISABLE", "ALPHA_BASE_URL", "ALPHA_DEFAULT_MODEL", "ALPHA_GLOBAL_DIR", "OPENCODE_CONFIG_DIR"]
const saved: Record<string, string | undefined> = {}

type Captured = { path: string; body: Record<string, unknown> }
const captures = new Map<string, Captured[]>()
let root = ""
let userData = ""
let server: ReturnType<typeof Bun.serve> | undefined
let upstream = ""

function sse(text: string) {
  const enc = new TextEncoder()
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
  const chunks = [
    chunk({ role: "assistant", content: text }, null),
    chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    "data: [DONE]\n\n",
  ]
  return new ReadableStream({
    start(controller) {
      for (const item of chunks) controller.enqueue(enc.encode(item))
      controller.close()
    },
  })
}

beforeAll(async () => {
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-reasoning-parity-")))
  userData = path.join(root, "userdata")
  const secrets = ["ALPHA_API_KEY", ...getModelCatalog().byokProviders.map((provider) => provider.keyEnv)]
  for (const name of secrets) {
    fs.mkdirSync(path.dirname(secretFilePath(userData, name)), { recursive: true })
    fs.writeFileSync(secretFilePath(userData, name), `sk-fake-${name}`, { mode: 0o600 })
  }
  process.env.ALPHA_GLOBAL_DIR = path.join(root, "alpha-global", "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config-dir")
  fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })

  // 假上游:按路径前缀 `/run/<tag>/…` 归档每一个请求,所以多条引擎并跑也能逐条归因。
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      const tag = /^\/run\/([^/]+)\//.exec(url.pathname)?.[1] ?? "<untagged>"
      let body: Record<string, unknown> = {}
      if (request.method === "POST") {
        try {
          body = JSON.parse(await request.text()) as Record<string, unknown>
        } catch {
          body = { "<unparsable>": true }
        }
      }
      const list = captures.get(tag) ?? []
      list.push({ path: url.pathname, body })
      captures.set(tag, list)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [] })
      return new Response(sse("ok"), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  upstream = `http://127.0.0.1:${server.port}`
  process.env.ALPHA_BASE_URL = `${upstream}/v1`
})

afterAll(() => {
  server?.stop(true)
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

/** 路径前缀 + 目录名两用,所以只留 `[A-Za-z0-9_.-]`;档位标签是中文,按 UTF-8 hex 编码(不能用 `%` 转义 ——
 *  引擎会把 `--dir` 里的百分号序列解码回去,目录就对不上了,实测 ENOENT)。 */
const tagOf = (providerID: string, id: string, variant?: string) => {
  const safe = (text: string) => (/^[A-Za-z0-9_.-]+$/.test(text) ? text : `x${Buffer.from(text, "utf8").toString("hex")}`)
  return `${safe(providerID)}__${safe(id)}${variant ? `__${safe(variant)}` : ""}`
}

/** 生产 `buildAlphaModelConfig` 的产物,只把每个 provider 的 baseURL 指到本进程假上游的 `/run/<tag>/` 前缀。 */
function configFor(tag: string) {
  const cfg = buildAlphaModelConfig(userData)
  if (!cfg) throw new Error("buildAlphaModelConfig 返回 undefined —— ALPHA_MODELS_DISABLE 漏清?")
  for (const [id, provider] of Object.entries(cfg.provider as Record<string, { options: { baseURL: string } }>)) {
    provider.options.baseURL = id === "alpha" ? `${upstream}/run/${tag}/v1` : `${upstream}/run/${tag}/byok/${id}/v1`
  }
  return cfg
}

type RunResult = { tag: string; rc: number; main: Record<string, unknown> | null; posts: number; log: string }

/** 一次真引擎 `run`:隔离 HOME/XDG/DB,stdin 关死(打开不关的管道会让 run 在 session 建立前无限挂住)。 */
async function engineRun(providerID: string, id: string, variant?: string): Promise<RunResult> {
  const tag = tagOf(providerID, id, variant)
  const dir = path.join(root, "runs", tag)
  for (const sub of ["home", "xdg-config", "xdg-data", "xdg-cache", "xdg-state", "proj"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(configPath, JSON.stringify(configFor(tag)))
  const proc = Bun.spawn(
    [
      BUN_EXEC,
      "run",
      engineEntry,
      "run",
      "--print-logs",
      "--dir",
      path.join(dir, "proj"),
      "--model",
      `${providerID}/${id}`,
      ...(variant ? ["--variant", variant] : []),
      "hi",
    ],
    {
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
        OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_MODELS_PATH: modelsFixture,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DB: path.join(dir, "engine.db"),
      },
    },
  )
  const killer = setTimeout(() => proc.kill(), 90_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const rc = await proc.exited
  clearTimeout(killer)
  const posts = (captures.get(tag) ?? []).filter((entry) => Array.isArray(entry.body.messages))
  // 引擎每次 run 还会发一条标题生成的辅助调用(走 smallOptions,不是用户那条);主请求 = 非标题那条。
  const isTitle = (body: Record<string, unknown>) =>
    (body.messages as Array<{ role?: string; content?: unknown }>).some(
      (message) => message.role === "system" && String(message.content).slice(0, 200).includes("title generator"),
    )
  const mains = posts.filter((entry) => !isTitle(entry.body))
  return {
    tag,
    rc,
    main: mains.length === 1 ? mains[0]!.body : null,
    posts: posts.length,
    log: `${stdout}\n${stderr}`.slice(-1200),
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        out[index] = await fn(items[index]!)
      }
    }),
  )
  return out
}

const rowKey = (row: ModelPickerRow) => `${row.model.providerID}:${row.model.id}`

/** 生产 picker 行:静态目录、全部 BYOK key 已配置、引擎清单 = 注入的那些模型(平台行的可用性需要它在册)。 */
function pickerRows(): ModelPickerRow[] {
  const base = getModelCatalog()
  const cfg = buildAlphaModelConfig(userData)!
  const models: ModelV2Info[] = Object.entries(cfg.provider as Record<string, { models: Record<string, unknown> }>).flatMap(
    ([providerID, provider]) =>
      Object.keys(provider.models).map(
        (id): ModelV2Info => ({
          id,
          providerID,
          name: id,
          api: { id: providerID, type: "aisdk", package: "@ai-sdk/openai-compatible" },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        }),
      ),
  )
  const catalog: EffectiveCatalog = { ...base, liveSync: { status: "static" }, pricingBasisModelId: null }
  return buildModelPickerRows({
    catalog,
    models,
    listState: "ready",
    keyStatusState: "ready",
    keyStatus: Object.fromEntries(base.byokProviders.map((provider) => [provider.id, { configured: true, source: "keychain" as const }])),
    accountState: "member",
    sessionScoped: false,
    query: "",
  })
}

/** 目录里该档位声明的 wire 值(`reasoningEffort: x` → 请求体 `reasoning_effort: x`;其它形状只判「有参数」)。 */
function declaredEffort(row: ModelPickerRow, variant: string): string | undefined {
  const platform = getModelCatalog().platformModels.find((model) => model.id === row.model.id)
  const declared = platform?.variants?.[variant]
  return typeof declared?.reasoningEffort === "string" ? declared.reasoningEffort : undefined
}

describe("REQ-153 #1266/#1267:徽标集合 == 引擎实际带推理参数的集合(真引擎 · 假上游 · 双向)", () => {
  test("手段自证:假上游的捕获不是恒空;无徽标模型 + --variant high 不带参数(判据会红)", async () => {
    const probe = await fetch(`${upstream}/run/__probe__/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ probe: "KNOWN-GOOD", messages: [] }),
    })
    expect(probe.ok).toBe(true)
    expect(captures.get("__probe__")?.[0]?.body.probe).toBe("KNOWN-GOOD")

    // 已知的坏:目录未标 reasoning 的 glm-5-turbo(上游黑名单族)硬塞 --variant high ⇒ 主请求体零推理键。
    const control = await engineRun("alpha", "glm-5-turbo", "high")
    expect({ rc: control.rc, main: control.main !== null, log: control.main ? "" : control.log }).toEqual({ rc: 0, main: true, log: "" })
    expect(reasoningControls(control.main!)).toEqual({})
  }, 120_000)

  test("桌面提交层:chip 列出的每一档,buildPromptRequest 都真的带上 variant(C28 不把它当未知档丢掉)", () => {
    const rows = pickerRows()
    const withVariants = rows.filter((row) => row.model.variants.length > 0)
    expect(withVariants.length).toBeGreaterThan(0)
    for (const row of withVariants) {
      for (const variant of row.model.variants) {
        const request = buildPromptRequest({ text: "hi", model: row.model, effort: variant, perm: "ask", agent: null })
        expect({ row: rowKey(row), variant, sent: request.model?.variant }).toEqual({ row: rowKey(row), variant, sent: variant })
      }
    }
  })

  test("矩阵:有徽标 ⇒ 每一档请求带参数且值逐字对上;无徽标 ⇒ 零档且默认请求不带参数", async () => {
    const rows = pickerRows()
    expect(rows.length).toBeGreaterThan(0)
    // 空集会让下面所有断言空转 —— 先钉住两侧都非空。
    expect(rows.some((row) => row.reasoning)).toBe(true)
    expect(rows.some((row) => !row.reasoning)).toBe(true)

    const jobs = rows.flatMap((row) => [
      { row, variant: undefined as string | undefined },
      ...row.model.variants.map((variant) => ({ row, variant })),
    ])
    const results = await pool(jobs, 6, async (job) => ({ ...job, result: await engineRun(job.row.model.providerID, job.row.model.id, job.variant) }))

    const failures: string[] = []
    const harness: string[] = []
    const verdicts: string[] = []
    for (const { row, variant, result } of results) {
      const key = rowKey(row)
      const label = variant ? `${key}@${variant}` : `${key}(默认)`
      if (result.rc !== 0 || !result.main) {
        harness.push(`${label}: 引擎 rc=${result.rc} 主请求=${result.main ? 1 : 0} posts=${result.posts}\n${result.log}`)
        continue
      }
      const controls = reasoningControls(result.main)
      const carried = Object.keys(controls).length > 0
      verdicts.push(`${label} badge=${row.reasoning} chip=[${row.model.variants.join("|")}] request=${JSON.stringify(controls)}`)
      if (KNOWN_UNFIXED[key]) {
        // 已知不修的行只登记现状:仍无徽标、仍带参数。任一条不再成立 ⇒ 登记过期,删掉它。
        if (variant !== undefined) failures.push(`${label}: 已知不修的行不该有档位`)
        if (row.reasoning || !carried) failures.push(`${label}: KNOWN_UNFIXED 登记已过期(badge=${row.reasoning} carried=${carried})—— 删掉登记`)
        continue
      }
      if (row.reasoning) {
        if (variant === undefined) {
          if (row.model.variants.length === 0) failures.push(`${label}: 有徽标但档位 chip 一档都没有(#1266)`)
          continue
        }
        if (!carried) failures.push(`${label}: 有徽标、选了档,主请求体却零推理参数(#1266)`)
        const expected = declaredEffort(row, variant)
        if (expected !== undefined && result.main.reasoning_effort !== expected)
          failures.push(`${label}: 档位声明 reasoningEffort=${expected},请求体 reasoning_effort=${String(result.main.reasoning_effort)}`)
      } else {
        if (variant !== undefined) failures.push(`${label}: 无徽标却列出了档位`)
        else if (carried) failures.push(`${label}: 无徽标,默认请求却带 ${JSON.stringify(controls)}(#1267)`)
      }
    }
    // 引擎没跑起来 / 没捕到主请求 = 本次测量作废,不是通过也不是红 —— 单独报,先于判据。
    expect(harness, "引擎侧 harness 故障(测量作废)").toEqual([])
    expect(failures, `逐格结论:\n${verdicts.join("\n")}`).toEqual([])
  }, 600_000)
})
