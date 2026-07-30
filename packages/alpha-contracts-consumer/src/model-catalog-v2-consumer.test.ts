// #681 / ADR-039 —— ModelCatalogV2 的独立 pin + 严格 decoder 闸门。
//
// 这道闸保证三件删掉就没人守的事:
//   1. V2 artifact 是**独立**钉住的(自己的 lock / vendor 子树 / 逐文件 sha256)——
//      上游改写 schema 或 producer fixture,本仓在解码之前就红;
//   2. 生产 decoder **不存在** ModelCatalogV1 —— 喂 V1 原文必须炸,且失败记录如实说
//      「expected 2 / received 1」;这是 ADR-039 §1「一个 flow 只有一代」的机械保证;
//   3. 本仓提交给平台 cutover gate 的 consumer pin,是被**出货 decoder** 真解过一遍的,
//      不是一份声称兼容的散文。
//
// ⚠️ 未换真 pin(2026-07-29):platform#138 尚未发布 contracts/v2,vendor/ 下两份字节是本仓
// 按已批基线自制的占位,`commit` 是哨兵字符串而非 sha。真 artifact 发布后重跑 vendor 并
// 更新下面的 commit 断言 —— **换完才可合并**(PR 描述里写死这条)。

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { ContractIncompatibleError, decodeContract, decodeJsonContract, validateFixture } from "./index"

const root = resolve(import.meta.dir, "..")
const vendor = resolve(root, "vendor/alpha-platform-model-catalog")
const LOCK = "alpha-platform-model-catalog.lock.json"
const PENDING_COMMIT = "pending-alpha-platform-138-model-catalog-v2-publish"
const PRODUCER = "contracts/v2/fixtures/producer/model-catalog.json"

const vendored = async (path: string) => Bun.file(resolve(vendor, path)).json()
const authored = async (path: string) => Bun.file(resolve(root, "fixtures", path)).json()
/** 生产响应体的形状:`decodeJsonContract` 收到的是 `value`,不是包装 fixture 的整份文件。 */
const wire = (value: unknown) => JSON.stringify(value)
const producerValue = async () => structuredClone((await vendored(PRODUCER)).value)

describe("ModelCatalogV2 的独立 immutable pin", () => {
  test("catalog pin 与 V1 bundle 是两条独立的锁,且逐文件哈希对得上", async () => {
    const lock = (await Bun.file(resolve(root, LOCK)).json()) as {
      repo: string
      commit: string
      files: Array<{ path: string; sha256: string }>
    }
    expect(lock.repo).toBe("jinjunnn/alpha-platform")
    expect(lock.commit).toBe(PENDING_COMMIT)
    expect(lock.files.map((file) => file.path).sort()).toEqual([PRODUCER, "contracts/v2/model-catalog.schema.json"])
    for (const file of lock.files) {
      const bytes = new Uint8Array(await Bun.file(resolve(vendor, file.path)).arrayBuffer())
      expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256)
    }

    // 独立性的另一半:V1 bundle 的锁里**不再**有 model catalog,也没被这次代际切换重钉。
    const v1 = (await Bun.file(resolve(root, "alpha-platform-contract.lock.json")).json()) as {
      commit: string
      files: Array<{ path: string }>
    }
    expect(v1.commit).toBe("2fe1d0103b7c3f68acb98c44d13ed0fcfe8bf196")
    expect(v1.files.some((file) => file.path.includes("model-catalog"))).toBe(false)
  })

  test("schema artifact 的 $id 是 pin 的锚点:改名即 decoder 失锚", async () => {
    const schema = (await vendored("contracts/v2/model-catalog.schema.json")) as Record<string, unknown>
    expect(schema.$id).toBe("model-catalog.schema.json")
    expect(schema.title).toBe("ModelCatalogV2")
  })
})

describe("生产 decoder 只认 V2", () => {
  test("vendored producer fixture 经出货 decoder 解开", async () => {
    expect(validateFixture(await vendored(PRODUCER))).toBe(true)
  })

  test("validates the independently pinned V2 producer fixture and rejects V1", async () => {
    const v2 = await producerValue()
    expect(decodeJsonContract("ModelCatalogV2", wire(v2), "model-catalog").schema_version).toBe(2)

    // 真实的 V1 wire(平台今天还在发的那一份),必须整份被拒。
    const v1 = {
      schema_version: 1,
      object: "list",
      data: [{ id: "deepseek-v4-flash", object: "model", provider: "deepseek", min_plan: "free" }],
      edition: "cn",
      byok_providers: ["deepseek"],
    }
    expect(() => decodeJsonContract("ModelCatalogV2", wire(v1), "model-catalog")).toThrow(ContractIncompatibleError)
    try {
      decodeJsonContract("ModelCatalogV2", wire(v1), "model-catalog")
      throw new Error("unreachable")
    } catch (error) {
      expect((error as ContractIncompatibleError).failure).toEqual({
        code: "contract-incompatible",
        surface: "model-catalog",
        expected_version: 2,
        received_version: 1,
        reason: "schema-validation",
      })
    }
  })

  test("ModelCatalogV1 这个 decoder 已经不存在(不是「还在但没人调」)", async () => {
    // validateFixture 按名字查 validator 表;查不到即 false。这是「V1 catalog 解码器已从出货代码里
    // 消失」的机械证据 —— 恢复它就是 ADR-039 §4 要求的那次 inversion。
    expect(validateFixture({ kind: "schema", contract: "ModelCatalogV1", expect: "valid", value: {} })).toBe(false)
    const v1 = {
      kind: "schema",
      contract: "ModelCatalogV1",
      expect: "valid",
      value: {
        schema_version: 1,
        object: "list",
        data: [{ id: "deepseek-v4-flash", object: "model", provider: "deepseek", min_plan: "free" }],
        edition: "cn",
        byok_providers: null,
      },
    }
    expect(validateFixture(v1)).toBe(false)
  })
})

describe("变异一律整份拒绝(不逐行降级)", () => {
  const reject = async (mutate: (value: any) => void, label: string) => {
    const value = await producerValue()
    mutate(value)
    expect(() => decodeContract("ModelCatalogV2", value, "model-catalog"), label).toThrow(ContractIncompatibleError)
  }

  test("缺 pricing_multiplier / 缺 basis / 缺一侧 / 多一个键 / 非正数,全部判不兼容", async () => {
    await reject((v) => delete v.data[0].pricing_multiplier, "删掉整个 pricing_multiplier")
    await reject((v) => delete v.pricing_basis_model_id, "删掉 pricing_basis_model_id")
    await reject((v) => (v.pricing_basis_model_id = ""), "basis 为空串")
    await reject((v) => delete v.data[0].pricing_multiplier.output, "只给 input 不给 output")
    await reject((v) => (v.data[0].pricing_multiplier.cache = 1), "偷偷多一个 cache 倍数")
    await reject((v) => (v.data[0].pricing_multiplier.input = 0), "input = 0")
    await reject((v) => (v.data[0].pricing_multiplier.input = -1), "input 为负")
    await reject((v) => (v.data[0].pricing_multiplier.input = "1"), "input 是字符串")
    await reject((v) => (v.data[0].provider = "DeepSeek"), "provider 枚举大小写漂移")
    await reject((v) => (v.schema_version = 1), "版本号退回 1")
  })

  test("落在 0.1 网格外的倍数是 schema 之外的语义问题,由消费侧 isTrustedPair 拒(schema 仍放行)", async () => {
    // ⚠️ 判据只能证明「落在 0.1 网格上」,证明不了「恰好一位小数」—— JSON 解码后 `1` 与 `1.0`
    // 是同一个 JS number。所以反例用 1.05,不能用 1.0。schema 层不表达网格,这里如实断言它放行,
    // 真正的拒绝发生在 main/alpha-live-allowlist.ts 的 isTrustedPair(见 models-catalog-v2 闸门)。
    const value = await producerValue()
    value.data[0].pricing_multiplier.input = 1.05
    expect(() => decodeContract("ModelCatalogV2", value, "model-catalog")).not.toThrow()
  })
})

describe("#681 consumer pin", () => {
  test("consumer pin 经出货 decoder 解出真实 12 模型与真实倍数", async () => {
    const pin = await authored("consumers/alpha-code-681/model-catalog-v2.json")
    expect(pin.contract).toBe("ModelCatalogV2")
    expect(pin.consumer).toBe("alpha-code")
    expect(pin.expect).toBe("valid")
    expect(validateFixture(pin)).toBe(true)

    const catalog = decodeJsonContract("ModelCatalogV2", wire(pin.value), "model-catalog")
    expect(catalog.data.length).toBe(12)
    expect(catalog.pricing_basis_model_id).toBe("deepseek-v4-flash")
    // 基准行本身是 1/1;最贵的一行必须逐字段全等地穿过 decoder —— 折叠成单一 scalar 或
    // 就近取整都会在这里红(I4/I5)。
    const byId = new Map(catalog.data.map((model) => [model.id, model.pricing_multiplier]))
    expect(byId.get("deepseek-v4-flash")).toEqual({ input: 1, output: 1 })
    expect(byId.get("claude-fable-5")).toEqual({ input: 71.4, output: 178.6 })
    expect(byId.get("claude-sonnet-5")).toEqual({ input: 21.4, output: 53.6 })
    // input ≠ output 的行必须真的存在,否则这份 pin 证明不了双倍数。
    expect(catalog.data.some((model) => model.pricing_multiplier.input !== model.pricing_multiplier.output)).toBe(true)
  })

  test("consumer pin 声明的是出货桌面版本(cutover gate 据此判本仓是否已切)", async () => {
    const pin = await authored("consumers/alpha-code-681/model-catalog-v2.json")
    const shipped = await Bun.file(resolve(root, "../ui-mac/package.json")).json()
    expect(pin.consumer_version).toBe(shipped.version)
  })
})
