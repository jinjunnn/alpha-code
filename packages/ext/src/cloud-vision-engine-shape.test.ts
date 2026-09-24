// cloud-vision-engine-shape.test.ts —— `#1419`:「这个模型能不能看图」在 chat.message 里只能经 `client.provider.list()`
// (引擎 `/provider`,Provider.ListResult)去问,而本插件读的那一格是 `models[<id>].capabilities.input.image`。
// 这条判据钉的是**字段路径与引擎真的一致**:把生产注入交给真引擎(`bun run packages/opencode/src/index.ts models --verbose`,
// 打印的就是 Provider.list() 里每个模型的完整 v1 形状,与 ui-mac image-input-capability.test.ts 同一手段),
// 再把引擎打印出来的模型 JSON 原样喂给 imageCapabilityOf() —— 引擎哪天把这一格改名,这里当场红,
// 而不是插件静默地把每个模型都当成看不了图(fail-closed 的代价是每张图多花一次识图钱)。
//
// 手段自证:同一台引擎、同一份注入,只删掉 `modalities` ⇒ 引擎判 false;把引擎给的 JSON 里那一格抠掉 ⇒ 读出来是
// undefined(不是 false)—— 「不知道」与「不能」在读端是两个值,插件对前者才走 fail-closed。
// 引擎离线跑:OPENCODE_MODELS_PATH 指向仓内真快照,`models` 命令不发网络请求。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { imageCapabilityOf } from "./cloud-vision-hooks"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")
const ENGINE = resolve(REPO_ROOT, "packages/opencode/src/index.ts")
const MODELS_FIXTURE = resolve(REPO_ROOT, "packages/opencode/test/tool/fixtures/models-api.json")
const BUN_EXEC = process.execPath
const PATH_AT_LOAD = process.env.PATH ?? ""

let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ext-vision-engine-shape-")))
  for (const d of ["home", "proj"]) mkdirSync(join(root, d), { recursive: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 生产注入面给自定义节点写的模型形状就是 `{ name, modalities }`(ui-mac alpha-models.ts:186);引擎补齐其余字段。 */
const PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "My VL",
  options: { baseURL: "https://vl.invalid/v1", apiKey: "sk-test" },
  models: {
    "vl-a": { name: "VL A", modalities: { input: ["text", "image"], output: ["text"] } },
    "text-b": { name: "Text B", modalities: { input: ["text"], output: ["text"] } },
  },
}

type Listed = Map<string, Record<string, unknown>>
async function engineModels(provider: Record<string, unknown>): Promise<{ rc: number; models: Listed; log: string }> {
  const dir = mkdtempSync(join(root, "run-"))
  for (const sub of ["xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) mkdirSync(join(dir, sub), { recursive: true })
  const content = JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["myvl"], provider: { myvl: provider } })
  const proc = Bun.spawn([BUN_EXEC, "run", ENGINE, "models", "--verbose"], {
    cwd: join(root, "proj"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: PATH_AT_LOAD,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(dir, "xdg-config"),
      XDG_DATA_HOME: join(dir, "xdg-data"),
      XDG_CACHE_HOME: join(dir, "xdg-cache"),
      XDG_STATE_HOME: join(dir, "xdg-state"),
      NO_COLOR: "1",
      OPENCODE_CONFIG_CONTENT: content,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_MODELS_PATH: MODELS_FIXTURE,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DB: join(dir, "engine.db"),
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
    if (key && buf.length) models.set(key, JSON.parse(buf.join("\n")) as Record<string, unknown>)
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

/** 把引擎打印的模型 JSON 装回 `/provider` 的形状(Provider.ListResult:`{ all: [{ id, models }] }`,hey-api 再套一层 data)。 */
const asProviderList = (models: Listed) => ({
  data: { all: [{ id: "myvl", models: Object.fromEntries([...models].map(([k, v]) => [k.slice("myvl/".length), v])) }], default: {}, connected: [] },
})

describe("`#1419` 插件读的 capabilities.input.image 与真引擎 Provider.list() 的形状一致", () => {
  test("引擎说 vl-a 能看图、text-b 不能;imageCapabilityOf 从引擎原样 JSON 里读出同样两个值", async () => {
    const run = await engineModels(PROVIDER)
    expect(run.rc, run.log).toBe(0)
    expect([...run.models.keys()].filter((k) => k.startsWith("myvl/")).sort()).toEqual(["myvl/text-b", "myvl/vl-a"])
    const list = asProviderList(run.models)
    expect(imageCapabilityOf(list, { providerID: "myvl", modelID: "vl-a" })).toBe(true)
    expect(imageCapabilityOf(list, { providerID: "myvl", modelID: "text-b" })).toBe(false)
    // 不在表里的模型 / provider:undefined,不是 false
    expect(imageCapabilityOf(list, { providerID: "myvl", modelID: "ghost" })).toBeUndefined()
    expect(imageCapabilityOf(list, { providerID: "nobody", modelID: "vl-a" })).toBeUndefined()
  }, 120_000)

  test("手段自证:注入里删掉 modalities ⇒ 引擎判 false;引擎 JSON 里抠掉那一格 ⇒ 读端给 undefined(「不知道」≠「不能」)", async () => {
    const stripped = structuredClone(PROVIDER) as { models: Record<string, { modalities?: unknown }> }
    for (const m of Object.values(stripped.models)) delete m.modalities
    const run = await engineModels(stripped)
    expect(run.rc, run.log).toBe(0)
    const list = asProviderList(run.models)
    expect(imageCapabilityOf(list, { providerID: "myvl", modelID: "vl-a" })).toBe(false)
    const vla = run.models.get("myvl/vl-a") as { capabilities: { input: Record<string, unknown> } }
    const gutted = structuredClone(vla)
    delete gutted.capabilities.input.image
    expect(imageCapabilityOf({ all: [{ id: "myvl", models: { "vl-a": gutted } }] }, { providerID: "myvl", modelID: "vl-a" })).toBeUndefined()
  }, 120_000)
})
