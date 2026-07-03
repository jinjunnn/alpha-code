// B21:BYOK env 桥变更计算单测。红线:用户提供的值永不动;自己注入的改键必覆盖、删键必清。

import { describe, expect, test } from "bun:test"
import { computeByokEnvMutations } from "./alpha-byok-env"

describe("computeByokEnvMutations", () => {
  test("首次注入:var 不存在 → set 并记账", () => {
    const injected = new Set<string>()
    const m = computeByokEnvMutations({ DEEPSEEK_API_KEY: "sk-1" }, {}, injected)
    expect(m.set).toEqual({ DEEPSEEK_API_KEY: "sk-1" })
    expect(injected.has("DEEPSEEK_API_KEY")).toBe(true)
  })

  test("用户 shell/alpha.env 已有值 → 永不覆盖(set-if-unset 对用户值保留)", () => {
    const injected = new Set<string>()
    const m = computeByokEnvMutations({ DEEPSEEK_API_KEY: "sk-keychain" }, { DEEPSEEK_API_KEY: "sk-user" }, injected)
    expect(m.set).toEqual({})
    expect(injected.has("DEEPSEEK_API_KEY")).toBe(false)
  })

  test("B21 根修:改键后自己注入的 var 必须覆盖(旧实现 set-if-unset 滞留旧 key)", () => {
    const injected = new Set<string>(["DEEPSEEK_API_KEY"])
    const m = computeByokEnvMutations({ DEEPSEEK_API_KEY: "sk-NEW" }, { DEEPSEEK_API_KEY: "sk-OLD" }, injected)
    expect(m.set).toEqual({ DEEPSEEK_API_KEY: "sk-NEW" })
  })

  test("删键:自己注入的 var 清除;用户值不受删键影响", () => {
    const injected = new Set<string>(["ZHIPU_API_KEY"])
    const m = computeByokEnvMutations({}, { ZHIPU_API_KEY: "sk-old", MOONSHOT_API_KEY: "sk-user" }, injected)
    expect(m.del).toEqual(["ZHIPU_API_KEY"])
    expect(m.set).toEqual({})
    expect(injected.size).toBe(0)
  })

  test("值未变的自有注入不重复 set(幂等)", () => {
    const injected = new Set<string>(["DEEPSEEK_API_KEY"])
    const m = computeByokEnvMutations({ DEEPSEEK_API_KEY: "sk-same" }, { DEEPSEEK_API_KEY: "sk-same" }, injected)
    expect(m.set).toEqual({})
    expect(m.del).toEqual([])
  })
})
