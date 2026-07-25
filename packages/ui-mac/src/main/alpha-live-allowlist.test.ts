// REQ-001:live 白名单缓存(文件桥)单测。契约:读侧 fail-open——缺失/坏 JSON/形状不对一律 null,
// 调用方回退内置 snapshot;写侧只在同步成功时调用(失败保留 last-known 由调用方保证)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { liveAllowlistPath, readLiveAllowlist, writeLiveAllowlist } from "./alpha-live-allowlist"

let tmp = ""
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-live-allowlist-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("readLiveAllowlist — fail-open 读侧", () => {
  test("无缓存 → null(回退内置 snapshot)", () => {
    expect(readLiveAllowlist(tmp)).toBeNull()
  })

  test("坏 JSON → null,不 throw", () => {
    fs.writeFileSync(liveAllowlistPath(tmp), "{nope")
    expect(readLiveAllowlist(tmp)).toBeNull()
  })

  test("形状不对(models 非数组)→ null", () => {
    fs.writeFileSync(liveAllowlistPath(tmp), JSON.stringify({ fetchedAt: "x", models: "oops" }))
    expect(readLiveAllowlist(tmp)).toBeNull()
  })
})

describe("write → read 回路", () => {
  test("roundtrip 保真(edition/models)", () => {
    writeLiveAllowlist(tmp, {
      fetchedAt: "2026-07-03T00:00:00Z",
      edition: "cn",
      models: [{ id: "deepseek-chat", provider: "deepseek", minPlan: "free" }],
    })
    const r = readLiveAllowlist(tmp)!
    expect(r.edition).toBe("cn")
    expect(r.models.map((m) => m.id)).toEqual(["deepseek-chat"])
  })

  // REQ-109 #595:BYOK 白名单已撤销 —— 写侧不再产出该字段,读侧也不得再据它拒绝旧缓存。
  test("#595:写出的缓存不含任何 BYOK 策略字段;旧缓存残留该字段仍可读(平台无 BYOK 干预面)", () => {
    writeLiveAllowlist(tmp, { fetchedAt: "x", models: [] })
    expect(Object.keys(JSON.parse(fs.readFileSync(liveAllowlistPath(tmp), "utf8")))).not.toContain("byokProviders")
    fs.writeFileSync(liveAllowlistPath(tmp), JSON.stringify({ fetchedAt: "x", byokProviders: "deepseek", models: [] }))
    expect(readLiveAllowlist(tmp)).not.toBeNull()
  })
})
