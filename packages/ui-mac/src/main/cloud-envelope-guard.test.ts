// REQ-020 T1(ADR-021 §2)—— dispatch 上行三校验的纯逻辑单测:1MB 帽 / secrets 拒发指字段 /
// denied_paths 缺省注入。真发路径(登录态 dispatch 被拒)在 S14 真机批验证。

import { describe, expect, test } from "bun:test"
import type { CloudJobEnvelope } from "../preload/types"
import { DEFAULT_DENIED_PATHS, MAX_ENVELOPE_BYTES, guardCloudEnvelope, scanEnvelopeSecrets } from "./cloud-envelope-guard"

const base = (over?: Partial<CloudJobEnvelope>): CloudJobEnvelope => ({
  autonomy: "pipeline",
  kind: "code-review",
  input: { diff: "diff --git a/x b/x\n-old\n+new\n" },
  ...over,
})

describe("① denied_paths 缺省注入", () => {
  test("未声明 → 注入默认四条", () => {
    const r = guardCloudEnvelope(base())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.envelope.constraints?.denied_paths).toEqual(DEFAULT_DENIED_PATHS)
  })
  test("空数组 = 无有效声明 → 同样注入(零保护无正当用例)", () => {
    const r = guardCloudEnvelope(base({ constraints: { denied_paths: [] } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.envelope.constraints?.denied_paths).toEqual(DEFAULT_DENIED_PATHS)
  })
  test("显式声明 → 完全尊重,不合并不覆盖", () => {
    const r = guardCloudEnvelope(base({ constraints: { denied_paths: ["secrets/"], network: "none" } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.envelope.constraints?.denied_paths).toEqual(["secrets/"])
      expect(r.envelope.constraints?.network).toBe("none")
    }
  })
  test("注入不改写调用方对象(纯函数)", () => {
    const env = base()
    void guardCloudEnvelope(env)
    expect(env.constraints).toBeUndefined()
  })
})

describe("② 1MB 体积帽(loud,不截断)", () => {
  test("超限拒发,错误信息带实际字节数", () => {
    const r = guardCloudEnvelope(base({ input: { diff: "x".repeat(MAX_ENVELOPE_BYTES) } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^envelope-too-large: \d+ bytes/)
  })
  test("帽内正常放行", () => {
    const r = guardCloudEnvelope(base({ input: { diff: "x".repeat(1000) } }))
    expect(r.ok).toBe(true)
  })
  test("多字节字符按 utf8 字节计,不按字符数", () => {
    // 40 万个中文 ≈ 120 万 utf8 字节 > 1MB,字符数却只有 40 万
    const r = guardCloudEnvelope(base({ input: { diff: "汉".repeat(400_000) } }))
    expect(r.ok).toBe(false)
  })
})

describe("③ secrets 扫描(拒发 + 指出字段)", () => {
  test("input 嵌套字段命中 → 拒发并给出字段路径", () => {
    const r = guardCloudEnvelope(base({ input: { diff: "clean", extra: { key: "sk-abcdefghij0123456789abcd" } } }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain("secrets-detected")
      expect(r.error).toContain("input.extra.key")
    }
  })
  test("objective 命中 → 指出 objective 字段", () => {
    const r = guardCloudEnvelope({
      autonomy: "bounded-agent",
      objective: "deploy with token AKIAABCDEFGHIJKLMNOP please",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("objective(aws-access-key)")
  })
  test("各模式族逐一命中", () => {
    const cases: [string, string][] = [
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIE...", "private-key-block"],
      ["ghp_" + "a".repeat(36), "github-token"],
      ["github_pat_" + "a".repeat(30), "github-token"],
      ["AIza" + "a".repeat(35), "google-api-key"],
      ["xoxb-1234567890-abcdef", "slack-token"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM", "jwt"],
    ]
    for (const [text, pattern] of cases) {
      const hits = scanEnvelopeSecrets(base({ input: { diff: text } }))
      expect(hits.map((h) => h.pattern)).toContain(pattern)
    }
  })
  test("普通代码 diff 不误杀(变量名/短前缀/URL)", () => {
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "+const skipCache = true // sk- 前缀但不是 key",
      "+const url = 'https://api.github.com/repos?per_page=100'",
      "+function getToken(): string { return readSecretFile() }",
    ].join("\n")
    expect(scanEnvelopeSecrets(base({ input: { diff } }))).toEqual([])
  })
  test("数组元素也被扫到(字段路径带下标)", () => {
    const hits = scanEnvelopeSecrets(base({ input: { files: ["ok", "sk-abcdefghij0123456789abcd"] } }))
    expect(hits[0]?.field).toBe("input.files[1]")
  })
})
