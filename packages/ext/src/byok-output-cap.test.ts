// REQ-156 —— 直连 BYOK 节点的 `max_tokens` 取逐模型实读上限。三层:
//   ① 纯判据 `byokOutputCap`(只抬不降 / baseURL 逐字 / 无读数不动);
//   ② 真 `AlphaExt` 的 `chat.params` 钩子(证明判据真的接在钩子上,而不是只在纯函数里成立);
//   ③ **双向漂移锁**:实读表 ↔ 出货目录 `alpha-models.json`。`#1265` 的教训是只锁一个方向等于没锁 ——
//      表里多出目录没有的条目(读数发给一个已下架的模型)与目录新增而没人量它(静默留在 32000),
//      两个方向都必须红。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BYOK_OUTPUT_CAP_READINGS, BYOK_OUTPUT_CAP_UNREAD, byokOutputCap } from "./byok-output-cap"
import catalog from "../../ui-mac/src/main/alpha-models.json"
// 生产公式,不手抄 —— 抄一份的话公式变了,readings 里写死的 `zhipuai-byok` 会在生产上静默
// 查不到(fail-closed ⇒ AC1 无声丢失),而漂移锁照样绿。
import { byokEngineId } from "../../ui-mac/src/shared/alpha-model-types"

const ZHIPU = "https://open.bigmodel.cn/api/paas/v4"
const DEEPSEEK = "https://api.deepseek.com/v1"

describe("byokOutputCap —— 判据形状域", () => {
  const base = { engineProviderID: "zhipuai-byok", apiModelID: "glm-5.2", providerBaseURL: ZHIPU, current: 32000 }

  test("有读数 + baseURL 逐字 + 当前值更低 ⇒ 抬到实读上限", () => {
    expect(byokOutputCap(base)).toEqual({ raise: true, value: 131072 })
    expect(byokOutputCap({ ...base, apiModelID: "glm-4.5-air" })).toEqual({ raise: true, value: 98304 })
    expect(
      byokOutputCap({ engineProviderID: "deepseek-byok", apiModelID: "deepseek-v4-pro", providerBaseURL: DEEPSEEK, current: 32000 }),
    ).toEqual({ raise: true, value: 393216 })
  })

  test("每个模型拿的是自己的那个数,不是全表最大值(glm-4.5-air 的 98304 ≠ glm-5.2 的 131072)", () => {
    // 这条锁的是「一刀切发一个数」这种修法:98304+1 在智谱侧是硬 400,实测见 verification 目录。
    const air = byokOutputCap({ ...base, apiModelID: "glm-4.5-air" })
    const pro = byokOutputCap({ ...base, apiModelID: "glm-5.2" })
    expect(air).not.toEqual(pro)
  })

  test("表里没有这个模型 ⇒ 一个字节都不改(fail-closed,保持上游 32000)", () => {
    expect(byokOutputCap({ ...base, apiModelID: "kimi-k3" })).toEqual({ raise: false, reason: "no-reading" })
    expect(byokOutputCap({ ...base, engineProviderID: "moonshot-byok" })).toEqual({ raise: false, reason: "no-reading" })
    expect(byokOutputCap({ ...base, engineProviderID: undefined })).toEqual({ raise: false, reason: "no-reading" })
  })

  test("baseURL 与读数记录的不逐字相等 ⇒ 不改(这条读数不适用于那个端点)", () => {
    for (const url of [`${ZHIPU}/`, ZHIPU.toUpperCase(), "https://evil.example/v4", undefined, 42])
      expect(byokOutputCap({ ...base, providerBaseURL: url })).toEqual({ raise: false, reason: "base-url-mismatch" })
  })

  test("只抬不降:当前值已 ≥ 读数,或不是有限数,都不动", () => {
    expect(byokOutputCap({ ...base, current: 131072 })).toEqual({ raise: false, reason: "already-at-or-above" })
    expect(byokOutputCap({ ...base, current: 200000 })).toEqual({ raise: false, reason: "already-at-or-above" })
    // config `limit.output` 是「主动往低调」的合法旋钮 —— 但 5000 < 131072,仍然会被抬。
    // 真正不该动的是「已经比我们高」和「别的插件说了这次别发」两种:
    expect(byokOutputCap({ ...base, current: undefined })).toEqual({ raise: false, reason: "not-a-number" })
    expect(byokOutputCap({ ...base, current: Number.NaN })).toEqual({ raise: false, reason: "not-a-number" })
    expect(byokOutputCap({ ...base, current: Number.POSITIVE_INFINITY })).toEqual({ raise: false, reason: "not-a-number" })
  })
})

describe("真 AlphaExt 的 chat.params 钩子", () => {
  let root = ""
  let savedBase: string | undefined
  let savedGlobal: string | undefined
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-byokcap-")))
    const global = join(root, "global", "env", "dev")
    mkdirSync(global, { recursive: true })
    mkdirSync(join(root, "project"), { recursive: true })
    savedBase = process.env.ALPHA_BASE_URL
    savedGlobal = process.env.ALPHA_GLOBAL_DIR
    process.env.ALPHA_GLOBAL_DIR = global
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
  })
  afterEach(() => {
    if (savedBase === undefined) delete process.env.ALPHA_BASE_URL
    else process.env.ALPHA_BASE_URL = savedBase
    if (savedGlobal === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = savedGlobal
    rmSync(root, { recursive: true, force: true })
  })

  type ChatParams = (
    input: { sessionID: string; agent: string; model: unknown; provider: { options?: Record<string, unknown> }; message: unknown },
    output: { temperature?: number; topP?: number; topK?: number; maxOutputTokens: number | undefined; options: Record<string, unknown> },
  ) => Promise<void>

  const load = async () => {
    const { AlphaExt } = await import("./plugin")
    const hooks = await AlphaExt({
      directory: join(root, "project"),
      worktree: join(root, "project"),
      client: { instance: { dispose: async () => {} } },
    } as unknown as Parameters<typeof AlphaExt>[0])
    return (hooks as unknown as Record<string, unknown>)["chat.params"] as ChatParams
  }
  const call = async (hook: ChatParams, providerID: string, modelID: string, baseURL: string) => {
    const output = { temperature: 0.6, topP: 0.95, topK: 20, maxOutputTokens: 32000 as number | undefined, options: { reasoningEffort: "high" } }
    await hook(
      { sessionID: "s", agent: "build", model: { providerID, api: { id: modelID } }, provider: { options: { baseURL, apiKey: "sk" } }, message: {} },
      output,
    )
    return output
  }

  test("直连 BYOK 节点(有读数):32000 → 该模型的实读上限,其它参数原样", async () => {
    const out = await call(await load(), "zhipuai-byok", "glm-5.2", ZHIPU)
    expect(out.maxOutputTokens).toBe(131072)
    expect({ temperature: out.temperature, topP: out.topP, topK: out.topK, options: out.options }).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      options: { reasoningEffort: "high" },
    })
  })

  test("同一个 provider 的两个模型各拿各的数", async () => {
    const hook = await load()
    expect((await call(hook, "zhipuai-byok", "glm-4.5-air", ZHIPU)).maxOutputTokens).toBe(98304)
    expect((await call(hook, "deepseek-byok", "deepseek-v4-flash", DEEPSEEK)).maxOutputTokens).toBe(393216)
  })

  test("无读数的 BYOK 模型 / 用户自定义节点:仍是上游的 32000", async () => {
    const hook = await load()
    expect((await call(hook, "moonshot-byok", "kimi-k3", "https://api.moonshot.cn/v1")).maxOutputTokens).toBe(32000)
    expect((await call(hook, "my-own", "glm-5.2", "https://my.proxy.example/v1")).maxOutputTokens).toBe(32000)
  })

  test("平台代理节点仍然走 #1238 那条路(置空),BYOK 那一问不得把它改回一个数", async () => {
    const out = await call(await load(), "alpha", "glm-5.2", "https://gw.example/v1")
    expect(out.maxOutputTokens).toBeUndefined()
  })

  // 本钩子里抛异常 = 整条请求死。`model` 缺 `api`(或整个缺席)必须走到「查不到读数 ⇒ 不改」,
  // 而不是 TypeError —— 这一格是本仓 platform-output-cap.test.ts 先抓到的,补进来当回归。
  test("model 形状残缺(无 api / 无 model)时不抛,退回上游的 32000", async () => {
    const hook = await load()
    const bare = (model: unknown) => {
      const output = { maxOutputTokens: 32000 as number | undefined, options: {} }
      return hook(
        { sessionID: "s", agent: "build", model, provider: { options: { baseURL: ZHIPU, apiKey: "sk" } }, message: {} },
        output,
      ).then(() => output)
    }
    expect((await bare({})).maxOutputTokens).toBe(32000)
    expect((await bare({ providerID: "zhipuai-byok" })).maxOutputTokens).toBe(32000)
    expect((await bare(undefined)).maxOutputTokens).toBe(32000)
  })
})

describe("双向漂移锁:实读表 ↔ 出货目录 alpha-models.json", () => {
  const byok = (catalog as { byokProviders: { id: string; baseURL: string; models: string[] }[] }).byokProviders
  const engineId = byokEngineId
  const catalogPairs = byok.flatMap((p) => p.models.map((m) => `${engineId(p.id)}/${m}`))

  test("方向一:表里的每条读数,目录里都真有这个 provider + 模型,且 baseURL 逐字相同", () => {
    for (const r of BYOK_OUTPUT_CAP_READINGS) {
      const provider = byok.find((p) => engineId(p.id) === r.engineProviderID)
      expect(`${r.engineProviderID} 在目录里`).toBe(provider ? `${r.engineProviderID} 在目录里` : "缺失")
      expect(provider!.models).toContain(r.apiModelID)
      expect(provider!.baseURL).toBe(r.baseURL)
    }
  })

  test("方向二:目录里的每个 BYOK 模型,要么有读数,要么显式登记在 UNREAD 里说明为什么没量", () => {
    const read = new Set(BYOK_OUTPUT_CAP_READINGS.map((r) => `${r.engineProviderID}/${r.apiModelID}`))
    const unread = new Set(BYOK_OUTPUT_CAP_UNREAD.map((u) => u.apiModelID))
    const orphans = catalogPairs.filter((pair) => !read.has(pair) && !unread.has(pair.split("/")[1]!))
    expect(orphans).toEqual([])
  })

  test("UNREAD 名单不许留旧账:里面的每个 id 目录里都还在,且都还没有读数", () => {
    const catalogModels = new Set(byok.flatMap((p) => p.models))
    const read = new Set(BYOK_OUTPUT_CAP_READINGS.map((r) => r.apiModelID))
    for (const u of BYOK_OUTPUT_CAP_UNREAD) {
      expect(catalogModels.has(u.apiModelID)).toBe(true)
      expect(read.has(u.apiModelID)).toBe(false)
      expect(u.why.length).toBeGreaterThan(0)
    }
  })

  test("每条读数带日期与出处原文,且值是正整数(留着下次复读对照)", () => {
    for (const r of BYOK_OUTPUT_CAP_READINGS) {
      expect(r.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isInteger(r.value) && r.value > 32000).toBe(true)
      expect(r.selfReported).toContain(String(r.value))
      expect(["probed", "catalog"]).toContain(r.grade)
    }
  })

  // 两级证据不是同一种东西。`probed` 的出处必须是**端点自己说的话**(区间原文),`catalog` 的出处
  // 必须点名那个目录 —— 否则一条网查来的数字可以悄悄穿上 probed 的外衣,而它们的风险完全不同
  // (catalog 值若高于端点真实上限 ⇒ 该模型每一发硬 400)。
  test("probed 的出处是端点自报原文;catalog 的出处点名目录且不得冒充实打", () => {
    for (const r of BYOK_OUTPUT_CAP_READINGS) {
      if (r.grade === "probed") {
        expect(r.selfReported).toMatch(/max_tokens/)
        expect(r.selfReported).not.toMatch(/openrouter|目录|文档/)
      } else {
        expect(r.selfReported).toMatch(/openrouter|目录|文档/)
      }
    }
  })

  test("实打过的那四个仍是 probed —— 把它们降级或把 catalog 冒充成 probed,这里都红", () => {
    const probed = BYOK_OUTPUT_CAP_READINGS.filter((r) => r.grade === "probed").map((r) => r.apiModelID).sort()
    expect(probed).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "glm-4.5-air", "glm-5.2"])
  })
})
