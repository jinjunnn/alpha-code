// REQ-237 `#1556` —— BYOK 预置目录采纳规则的判据(方案 §2.3 规则 1–5,AC2;带 baseURL 被拒,AC3)。
//
// 子进程运行(byok-catalog-adopt.test.ts spawn):adoptByokCatalog 住在 catalog-refresher.ts,模块求值即拖入
// electron / logging,这里只 mock 到能 import 为止,被测的是纯函数本身与 alpha-live-allowlist 的「已下载 = LKG 与
// 随包首启引导取高者」。文档一律取上游 producer fixture 的 `value` 再改一处(不手写替身)。

import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

mock.module("electron", () => ({
  app: { getPath: () => tmpdir(), getVersion: () => "9.9.9", getName: () => "alpha-code", isPackaged: false, on: () => {} },
  BrowserWindow: class {},
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
}))
const logger = { log: () => {}, warn: () => {}, error: () => {} }
mock.module("./logging", () => ({ getLogger: () => logger, initLogging: () => logger, write: () => {}, rotateServerLogs: () => {} }))
mock.module("./alpha-auth", () => ({ getAccessToken: () => undefined, isStoredTokenExpired: () => false, getAuthIdentityTag: () => undefined }))

const { adoptByokCatalog } = await import("./catalog-refresher")
const { BYOK_ADAPTERS } = await import("./byok-adapters")
const { downloadedByokCatalog, pinAppliedCatalog, readAppliedByokCatalog, writeByokCatalogLkg } = await import("./alpha-live-allowlist")
const bundled = (await import("./alpha-models.json")).default.byokCatalog

const PRODUCER = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v1/fixtures/producer/byok-catalog.json",
)
/** 上游 producer 文档,版本抬到随包首启引导之上(否则规则 2 先拦住,测不到后面几条)。 */
const doc = (mutate?: (value: any) => void): any => {
  const value = structuredClone(JSON.parse(readFileSync(PRODUCER, "utf8")).value)
  value.catalog_version = bundled.catalog_version + 1
  mutate?.(value)
  return value
}
const adopt = (value: unknown, current = bundled.catalog_version) => adoptByokCatalog(JSON.stringify(value), BYOK_ADAPTERS, current)

const dirs: string[] = []
const userData = () => {
  const dir = mkdtempSync(join(tmpdir(), "byok-adopt-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("`#1556` AC2:采纳规则 1–5", () => {
  test("控制组:上游 producer 文档(版本更高、provider 全认识)被整份采纳", () => {
    const result = adopt(doc())
    expect(result.kind).toBe("adopted")
    if (result.kind !== "adopted") return
    expect(result.skippedProviders).toEqual([])
    expect(result.catalog.providers.map((provider) => provider.id)).toEqual(BYOK_ADAPTERS.map((adapter) => adapter.id))
  })

  test("规则 1:信封不合 schema 即整份拒绝(缺字段 / schema_version 不是 1 / 不是 JSON)", () => {
    expect(adopt(doc((value) => delete value.published_at))).toEqual({ kind: "rejected" })
    expect(adopt(doc((value) => (value.schema_version = 2)))).toEqual({ kind: "rejected" })
    expect(adopt(doc((value) => (value.providers[0].models = [])))).toEqual({ kind: "rejected" })
    expect(adoptByokCatalog("<html>gateway error</html>", BYOK_ADAPTERS, bundled.catalog_version)).toEqual({ kind: "rejected" })
  })

  test("规则 2:catalog_version 不高于当前(LKG 与随包首启引导取高者)就不采纳 —— 相等与回退都一样", () => {
    expect(adopt(doc((value) => (value.catalog_version = 5)), 5)).toEqual({ kind: "not-newer", version: 5 })
    expect(adopt(doc((value) => (value.catalog_version = 4)), 5)).toEqual({ kind: "not-newer", version: 4 })
    expect(adopt(doc((value) => (value.catalog_version = 6)), 5).kind).toBe("adopted")
  })

  test("规则 3:provider 不在 App 适配器表 ⇒ 只跳过那一个 provider,其余照常采纳", () => {
    const result = adopt(
      doc((value) =>
        value.providers.splice(1, 0, { id: "openai", name: "OpenAI", brand: "openai", preset: true, models: [{ id: "gpt-9", name: "GPT-9", image_input: true }] }),
      ),
    )
    expect(result.kind).toBe("adopted")
    if (result.kind !== "adopted") return
    expect(result.skippedProviders).toEqual(["openai"])
    expect(result.catalog.providers.map((provider) => provider.id)).toEqual(BYOK_ADAPTERS.map((adapter) => adapter.id))
  })

  test("规则 4:档位出现允许集外的选项键 ⇒ 不采纳,不会半应用(选项键集合由 ByokCatalogV1 封闭,整份拒绝)", () => {
    // 允许集 reasoningEffort | reasoning | thinking;temperature 越界。schema 在档位对象上 additionalProperties:false,
    // 所以越界键在规则 1 那一步就让整份文档不合 —— 不存在「这个模型被跳过、其余模型照用」的中间态。
    expect(adopt(doc((value) => (value.providers[1].models[0].variants["高"] = { reasoningEffort: "high", temperature: 0 })))).toEqual({
      kind: "rejected",
    })
    // 允许集内的三种键照常采纳(控制组:证明拒绝来自越界键,而不是档位本身)。
    expect(adopt(doc((value) => (value.providers[1].models[0].variants["高"] = { reasoning: { effort: "high" } }))).kind).toBe("adopted")
  })

  test("规则 5:随包 BYOK 段只作首启引导 —— 没有 LKG / LKG 不更高时用随包;LKG 更高才用远程;钉住与读回同一判据", () => {
    const fresh = userData()
    expect(downloadedByokCatalog(fresh)).toEqual({ byok: bundled, source: "bundled" })
    expect(readAppliedByokCatalog(fresh)).toEqual({ byok: bundled, source: "bundled" }) // 首次 fork 之前

    // 相等版本(App 升级带来的随包版本追上了远程)⇒ 随包胜出。
    const tie = userData()
    expect(writeByokCatalogLkg(tie, doc((value) => (value.catalog_version = bundled.catalog_version)))).toBe(true)
    expect(downloadedByokCatalog(tie).source).toBe("bundled")

    const newer = userData()
    const remote = doc((value) => value.providers[4].models.push({ id: "kimi-k9", name: "Kimi K9", image_input: true }))
    expect(writeByokCatalogLkg(newer, remote)).toBe(true)
    expect(downloadedByokCatalog(newer)).toEqual({ byok: remote, source: "remote" })
    pinAppliedCatalog(newer, 3)
    expect(readAppliedByokCatalog(newer)).toEqual({ byok: remote, source: "remote" })
  })
})

describe("`#1556` AC3:远程文档不能带端点 / Key 名 / 协议适配器", () => {
  test("provider 或模型上出现 baseURL / keyEnv / compat / npm ⇒ 整份拒绝", () => {
    for (const [where, key, value] of [
      ["provider", "baseURL", "https://evil.example/v1"],
      ["provider", "keyEnv", "OPENAI_API_KEY"],
      ["provider", "compat", "anthropic"],
      ["model", "npm", "@ai-sdk/anthropic"],
      ["model", "baseURL", "https://evil.example/v1"],
    ] as const) {
      const result = adopt(
        doc((document) => {
          const target = where === "provider" ? document.providers[0] : document.providers[0].models[0]
          target[key] = value
        }),
      )
      expect({ where, key, result }).toEqual({ where, key, result: { kind: "rejected" } })
    }
  })
})
