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
// 真 pin 已落地(2026-07-29):alpha-platform#138 合并后,vendored 字节经 `bun run vendor` 从
// `jinjunnn/alpha-platform@7fd62d3e` 逐字节复制而来,lock 由 vendor 流程重写。此前占位期这里是
// **红**的(第一条用例拒绝 `pending-` 哨兵),换上真 sha 后自然转绿 —— 这条判据继续守着下一次:
// 任何 pin 只要不是 40 位 hex 的 immutable sha 就判红。

import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { ContractIncompatibleError, decodeContract, decodeJsonContract, validateFixture } from "./index"

const root = resolve(import.meta.dir, "..")
const vendor = resolve(root, "vendor/alpha-platform-model-catalog")
const LOCK = "alpha-platform-model-catalog.lock.json"
const PRODUCER = "contracts/v2/fixtures/producer/model-catalog.json"
/** 上游发布的 V1 形状 negative fixture。**V1 wire 一律取自这份字节,本文件不手写 V1 样例** ——
 *  手写一份别人文法的替身是本仓最贵的返工来源;要么消费对方的决定,要么直接拒绝该输入。 */
const INVALID_V1_SHAPED = "contracts/v2/fixtures/invalid/v1-shaped-catalog.json"

const vendored = async (path: string) => Bun.file(resolve(vendor, path)).json()
const authored = async (path: string) => Bun.file(resolve(root, "fixtures", path)).json()
/** 生产响应体的形状:`decodeJsonContract` 收到的是 `value`,不是包装 fixture 的整份文件。 */
const wire = (value: unknown) => JSON.stringify(value)
const producerValue = async () => structuredClone((await vendored(PRODUCER)).value)
/** 上游那份 V1 形状载荷本身(同样只取 `.value`,整份包装对象喂给生产 decoder 会得到假红)。 */
const v1ShapedValue = async () => structuredClone((await vendored(INVALID_V1_SHAPED)).value)

describe("ModelCatalogV2 的独立 immutable pin", () => {
  // 占位 pin 必须由**机器**拦住。此前这里断言 `commit === "pending-…"`,于是整条 CI 对着一个哨兵
  // 字符串报绿 —— 闸门正向接受了它要拦的东西,只剩 PR 描述里一句话防误合。判据因此反过来:pin 只
  // 接受 40 位 hex 的 immutable sha。
  //
  // **枚举全部 lock,而不是点名两个**:新增一份 pin 默认被这条覆盖,不依赖谁记得来加一行。
  test("每一份契约 pin 都解析到真实 immutable commit —— 占位 sentinel 一律判红", async () => {
    const locks = readdirSync(root).filter((name) => name.endsWith(".lock.json")).sort()
    // 前提自检:glob 坏掉/锁被删光时,本条必须红而不是空绿。
    expect(locks.length, "契约 lock 文件枚举为空 —— 本闸变成了空闸").toBeGreaterThanOrEqual(3)
    for (const name of locks) {
      const { commit } = (await Bun.file(resolve(root, name)).json()) as { commit: string }
      expect(commit, `${name}:占位 pin 未换成真 sha —— 上游 artifact 尚未发布,**不得合并**`).not.toStartWith(
        "pending-",
      )
      expect(commit, `${name}:pin 的 commit 必须是 40 位 hex 的 immutable sha,实际是 "${commit}"`).toMatch(
        /^[0-9a-f]{40}$/,
      )
    }
  })

  test("catalog pin 与 V1 bundle 是两条独立的锁,且逐文件哈希对得上", async () => {
    const lock = (await Bun.file(resolve(root, LOCK)).json()) as {
      repo: string
      commit: string
      files: Array<{ path: string; sha256: string }>
    }
    expect(lock.repo).toBe("jinjunnn/alpha-platform")
    expect(lock.files.map((file) => file.path).sort()).toEqual([
      INVALID_V1_SHAPED,
      PRODUCER,
      "contracts/v2/model-catalog.schema.json",
    ])
    for (const file of lock.files) {
      const bytes = new Uint8Array(await Bun.file(resolve(vendor, file.path)).arrayBuffer())
      expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256)
    }

    // 独立性的另一半:V1 bundle 的锁里**不再**有 model catalog,也没被这次代际切换重钉。
    const v1 = (await Bun.file(resolve(root, "alpha-platform-contract.lock.json")).json()) as {
      commit: string
      files: Array<{ path: string }>
    }
    expect(v1.commit).toBe("62c7aa6de5589cfcf2af00ecab69f1d3d176512b")
    expect(v1.files.some((file) => file.path.includes("model-catalog"))).toBe(false)
  })

  test("schema artifact 的 $id 是 pin 的锚点:改名即 decoder 失锚", async () => {
    const schema = (await vendored("contracts/v2/model-catalog.schema.json")) as Record<string, unknown>
    expect(schema.$id).toBe("model-catalog.schema.json")
    expect(schema.title).toBe("ModelCatalogV2")
  })
})

describe("生产 decoder 只认 V2", () => {
  test("vendored 的两份 fixture 都经出货 decoder 判定,且与上游声明的 expect 一致", async () => {
    // producer:上游说 valid,我们的 decoder 必须解得开。
    expect(validateFixture(await vendored(PRODUCER))).toBe(true)
    // negative:上游说 invalid,我们的 decoder 必须拒。validateFixture 对 `expect:"invalid"` 的判据
    // 就是「校验器确实拒了」——所以这里同样是 true,而它证明的是**双方对同一份字节的判断一致**。
    const invalid = await vendored(INVALID_V1_SHAPED)
    expect(invalid.contract).toBe("ModelCatalogV2")
    expect(invalid.expect).toBe("invalid")
    expect(validateFixture(invalid)).toBe(true)
  })

  test("validates the independently pinned V2 producer fixture and rejects V1", async () => {
    const v2 = await producerValue()
    expect(decodeJsonContract("ModelCatalogV2", wire(v2), "model-catalog").schema_version).toBe(2)

    // V1 wire 取自**上游发布的 negative fixture**,不是本文件手写的替身。
    const v1 = await v1ShapedValue()
    expect(v1.schema_version).toBe(1)
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
    // 载荷仍取自上游字节;这里唯一由本仓提供的是 `contract` 这个**注册表键名**(它本来就是我们自己的
    // 类型注册表,不是上游文法的一部分)。
    expect(
      validateFixture({ kind: "schema", contract: "ModelCatalogV1", expect: "valid", value: await v1ShapedValue() }),
    ).toBe(false)
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
