// REQ-228 `#1420` —— 「这个模型能不能看图」走到**真引擎**的那一格:`capabilities.input.image`。
//
// 读它的是 packages/opencode/src/provider/transform.ts 的 unsupportedParts():看不了图的模型收到的图片被换成一句
// `ERROR: Cannot read … Inform the user.`;云端识图插件(#1419)也按它决定「原样放行还是转写」。写它的是引擎 provider.ts 的
// config 合并:`modalities.input` 含 image ⇒ true;**没写就回落到 models.dev 底表里同 provider id、同 model id 的条目**。
// 所以只判 buildAlphaModelConfig 的产物不够 —— 这里把生产注入交给真引擎(`bun run packages/opencode/src/index.ts models --verbose`,
// 打印的就是 Provider.list() 里每个模型的完整 v1 形状),逐个模型问它最终认的值。
//
// 期望值手写字面量,抄自 models.dev 2026-09-23 快照(不是从被测目录派生):直连能看图的只有 deepseek-flash / qwen3.8-max /
// kimi-k3 / kimi-k2.6;平台模型一个都不能(网关聊天入口拒收图片 —— 哪怕 claude-* 上游本身能看);自定义节点只有用户声明的那个。
//
// 手段自证先于判据:同一台引擎、同一份注入,只把每个模型的 `modalities` 删掉 ⇒ ①直连 kimi 等回到 false(证明「能看」确实来自
// 注入,不是引擎自己知道);②id 恰好叫 `openai` 的自定义节点从 models.dev 继承到 image:true —— 这正是「每个模型都显式写」
// 要堵的回落:用户自己的地址上同名模型不一定是 models.dev 那一个。引擎离线跑,OPENCODE_MODELS_PATH 指向仓内真快照
// (与 custom-provider-derivation.test.ts 同款);`models` 命令不发网络请求。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { environmentMutableRoot } from "./alpha-environment"
import { buildAlphaModelConfig, getModelCatalog } from "./alpha-models"
import { customProviderSecretName, secretFilePath } from "./alpha-secret-files"
import { writeCustomProviderTruth } from "./custom-provider-truth-write"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const engineEntry = path.resolve(repoRoot, "packages/opencode/src/index.ts")
const modelsFixture = path.resolve(repoRoot, "packages/opencode/test/tool/fixtures/models-api.json")
const BUN_EXEC = process.execPath
const PATH_AT_LOAD = process.env.PATH ?? ""

const MANAGED = ["ALPHA_MODELS_DISABLE", "ALPHA_BASE_URL", "ALPHA_DEFAULT_MODEL", "ALPHA_GLOBAL_DIR", "OPENCODE_CONFIG_DIR"]
const saved: Record<string, string | undefined> = {}
let root = ""
let userData = ""

/** 手写期望:引擎应判「能看图」的全部 (provider, model)。出处见文件头。 */
const EXPECTED_IMAGE = [
  "alibaba-byok/qwen3.8-max",
  "deepseek-byok/deepseek-flash",
  "moonshot-byok/kimi-k2.6",
  "moonshot-byok/kimi-k3",
  "my-vision/vl-a",
]

const plant = (name: string) => {
  fs.mkdirSync(path.dirname(secretFilePath(userData, name)), { recursive: true })
  fs.writeFileSync(secretFilePath(userData, name), `sk-fake-${name}`, { mode: 0o600 })
}

beforeAll(() => {
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-input-capability-")))
  userData = path.join(root, "userdata")
  const stateRoot = path.join(root, "alpha-code-state")
  process.env.ALPHA_GLOBAL_DIR = environmentMutableRoot("dev", stateRoot)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config-dir")
  process.env.ALPHA_BASE_URL = "https://gateway.invalid/v1"
  for (const dir of [userData, process.env.ALPHA_GLOBAL_DIR, process.env.OPENCODE_CONFIG_DIR, path.join(root, "home"), path.join(root, "proj")])
    fs.mkdirSync(dir, { recursive: true })
  for (const name of ["ALPHA_API_KEY", ...getModelCatalog().byokProviders.map((p) => p.keyEnv)]) plant(name)
  // 两条自定义记录:一条用户声明了 vl-a 能看图;一条 id 恰好与 models.dev 的 provider 同名、没声明任何东西。
  writeCustomProviderTruth(
    path.join(stateRoot, "custom-providers", "dev.json"),
    [
      { id: "my-vision", name: "My Vision", compat: "openai", baseURL: "https://vision.invalid/v1", models: ["vl-a", "text-b"], imageInput: ["vl-a"] },
      { id: "openai", name: "Same id as models.dev", compat: "openai", baseURL: "https://proxy.invalid/v1", models: ["gpt-5.4"] },
    ],
    { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync },
  )
  for (const id of ["my-vision", "openai"]) plant(customProviderSecretName(id))
})

afterAll(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

type Config = NonNullable<ReturnType<typeof buildAlphaModelConfig>>
type Listed = Map<string, { capabilities?: { input?: { image?: boolean } } }>

/** 生产注入里每一个 (provider, model) —— 判据只问这些,不问引擎从 models.dev 顺带合并进来的别的行。 */
const injectedKeys = (cfg: Config) =>
  Object.entries(cfg.provider as Record<string, { models: Record<string, unknown> }>).flatMap(([p, def]) => Object.keys(def.models).map((m) => `${p}/${m}`))

/** 一次真引擎 `models --verbose`:每行 `provider/model` 后面跟一段该模型的 JSON。 */
async function engineModels(cfg: Config): Promise<{ rc: number; models: Listed; log: string }> {
  const dir = fs.mkdtempSync(path.join(root, "run-"))
  for (const sub of ["xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const content = JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: cfg.enabled_providers, provider: cfg.provider })
  const proc = Bun.spawn([BUN_EXEC, "run", engineEntry, "models", "--verbose"], {
    cwd: path.join(root, "proj"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: PATH_AT_LOAD,
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
      XDG_DATA_HOME: path.join(dir, "xdg-data"),
      XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
      XDG_STATE_HOME: path.join(dir, "xdg-state"),
      NO_COLOR: "1",
      OPENCODE_CONFIG_CONTENT: content,
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
  const models: Listed = new Map()
  let key: string | undefined
  let buf: string[] = []
  const flush = () => {
    if (key && buf.length) models.set(key, JSON.parse(buf.join("\n")))
    buf = []
  }
  for (const line of stdout.split("\n")) {
    if (/^[a-z0-9._-]+\/[^\s{}"]+$/i.test(line)) {
      flush()
      key = line
    } else if (key) buf.push(line)
  }
  flush()
  return { rc, models, log: `${stdout}\n${stderr}`.slice(-1500) }
}

/** 注入里的每个模型 → 引擎最终认的 image 值;引擎没列出的记成 "<missing>"(不许静默当 false)。 */
function imageVerdicts(cfg: Config, listed: Listed): Record<string, boolean | "<missing>"> {
  return Object.fromEntries(
    injectedKeys(cfg).map((k) => {
      const image = listed.get(k)?.capabilities?.input?.image
      return [k, typeof image === "boolean" ? image : "<missing>"]
    }),
  )
}

describe("REQ-228 #1420:真引擎的 capabilities.input.image —— 直连按 models.dev、平台一律不能、自定义只认用户声明", () => {
  test("生产注入 ⇒ 引擎恰好判这五个能看图,其余(含全部平台模型、没声明的同名 openai 节点)都不能", async () => {
    const cfg = buildAlphaModelConfig(userData)!
    const run = await engineModels(cfg)
    expect(run.rc, run.log).toBe(0)
    const verdicts = imageVerdicts(cfg, run.models)
    // 被测对象不是空集:平台 12 行 + 直连 10 行 + 自定义 3 行都真的进了引擎。
    expect(Object.keys(verdicts).filter((k) => k.startsWith("alpha/")).length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(verdicts).filter((k) => k.includes("-byok/")).length).toBe(10)
    expect(Object.values(verdicts).filter((v) => v === "<missing>")).toEqual([])
    expect(Object.entries(verdicts).filter(([, v]) => v === true).map(([k]) => k).sort()).toEqual(EXPECTED_IMAGE)
    // 平台逐行钉死(上游能看图的 claude-* / gpt-* 也不例外):聊天入口拒收图片,图片只走云端识图。
    for (const [k, v] of Object.entries(verdicts)) if (k.startsWith("alpha/")) expect({ k, image: v }).toEqual({ k, image: false })
  }, 120_000)

  test("手段自证:同一台引擎、同一份注入只删掉 modalities ⇒ 直连能看图的全部退回 false,而同名 openai 节点从 models.dev 继承到 true", async () => {
    const cfg = buildAlphaModelConfig(userData)!
    const stripped = structuredClone(cfg)
    for (const def of Object.values(stripped.provider as Record<string, { models: Record<string, { modalities?: unknown }> }>))
      for (const model of Object.values(def.models)) delete model.modalities
    const run = await engineModels(stripped)
    expect(run.rc, run.log).toBe(0)
    const verdicts = imageVerdicts(stripped, run.models)
    expect(Object.values(verdicts).filter((v) => v === "<missing>")).toEqual([])
    expect(Object.entries(verdicts).filter(([, v]) => v === true).map(([k]) => k)).toEqual(["openai/gpt-5.4"])
  }, 120_000)
})
