// REQ-020 T1(ADR-021 §2)—— dispatch 上行三校验的纯逻辑单测:256KiB 帽 / secrets 拒发指字段 /
// 工具集合必须显式。真发路径(登录态 dispatch 被拒)在 S14 真机批验证。
//
// [#918] 本文件只判「信封长什么样」。「平台会不会收」是另一件事,判据在
// cloud-dispatch-gate.cases.ts —— 那里把真的 dispatchCloudJob 打到一个施行
// alpha-platform@9cf67bd 诚实门的假服务端上。两者都要,单靠形状断言杀不掉「形状对了但平台仍拒」。

import { describe, expect, test } from "bun:test"
import type { CloudJobEnvelope } from "../preload/types"
import { MAX_ENVELOPE_BYTES, guardCloudEnvelope, scanEnvelopeSecrets } from "./cloud-envelope-guard"

const base = (over?: Partial<CloudJobEnvelope>): CloudJobEnvelope => ({
  autonomy: "pipeline",
  kind: "code-review",
  input: { diff: "diff --git a/x b/x\n-old\n+new\n" },
  ...over,
})

describe("① denied_paths 不再缺省注入(平台侧强制不了 ⇒ 注入 = 假保护 + 恒 400)", () => {
  test("未声明 → 送出去的信封里一条路径限制都没有,连 constraints 都不凭空造", () => {
    const r = guardCloudEnvelope(base())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.envelope.constraints?.denied_paths).toBeUndefined()
      expect(r.envelope.constraints).toBeUndefined()
    }
  })
  test("显式空数组 → 保持空,不被「补齐」成一份默认名单", () => {
    const r = guardCloudEnvelope(base({ constraints: { denied_paths: [] } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.envelope.constraints?.denied_paths).toEqual([])
  })
  test("显式声明 → 原样透传,不静默剥掉(裁决权在平台的诚实门,不在这里)", () => {
    // `secrets/**` 是平台文法认的写法(实跑 ap@9cf67bd DeniedPathV1Schema:`secrets/` 带尾斜杠被拒)。
    const r = guardCloudEnvelope(base({ constraints: { denied_paths: ["secrets/**"], network: "restricted" } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.envelope.constraints?.denied_paths).toEqual(["secrets/**"])
      expect(r.envelope.constraints?.network).toBe("restricted")
    }
  })
  test("不改写调用方对象(纯函数)", () => {
    const env = base()
    void guardCloudEnvelope(env)
    expect(env.constraints).toBeUndefined()
  })
})

describe("① 工具集合必须显式(平台把「没声明」归一成零工具)", () => {
  const agent = (over?: Partial<CloudJobEnvelope>): CloudJobEnvelope => ({
    autonomy: "bounded-agent",
    objective: "Summarise this week's release notes",
    capabilities: ["web_search"],
    ...over,
  })

  test("bounded-agent 未声明 allowed_tools → 拒发(不是发出去再变成零工具作业)", () => {
    expect(guardCloudEnvelope(agent())).toEqual({ ok: false, error: "tools-not-declared" })
  })
  test("bounded-agent 显式空工具集 → 同样拒发:零工具不能被当成一次正常作业悄悄跑起来", () => {
    expect(guardCloudEnvelope(agent({ constraints: { allowed_tools: [] } }))).toEqual({
      ok: false,
      error: "tools-not-declared",
    })
  })
  test("bounded-agent 声明了工具 → 放行,且工具集合原样上行", () => {
    const r = guardCloudEnvelope(agent({ constraints: { allowed_tools: ["web"] } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.envelope.constraints?.allowed_tools).toEqual(["web"])
  })
  test("pipeline 不受此闸约束:固定管线跑自己的代码,allowed_tools 在那条路上不是工具闸", () => {
    expect(guardCloudEnvelope(base()).ok).toBe(true)
  })
  test("上传控制字段的拒绝仍排在工具闸之前(伪造 consent 不会被降级成 tools-not-declared)", () => {
    expect(
      guardCloudEnvelope({ autonomy: "bounded-agent", objective: "work", upload_consent: "forged" }),
    ).toEqual({ ok: false, error: "upload-main-gate-required" })
  })
})

describe("② 256KiB 体积帽(loud,不截断)", () => {
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
    // 10 万个中文 ≈ 300KiB utf8,字符数却只有 10 万
    const r = guardCloudEnvelope(base({ input: { diff: "汉".repeat(100_000) } }))
    expect(r.ok).toBe(false)
  })
})

describe("pinned v1 request shape", () => {
  test("rejects an explicitly incompatible version instead of rewriting it to v1", () => {
    expect(guardCloudEnvelope({ ...base(), schema_version: 2 })).toEqual({ ok: false, error: "contract-incompatible" })
  })

  test("rejects an incompatible artifact policy instead of rewriting it", () => {
    expect(guardCloudEnvelope({ ...base(), artifact_policy: { delivery: "inline" } })).toEqual({
      ok: false,
      error: "contract-incompatible",
    })
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
    // [#918] 工具集合显式声明:否则会先撞上 tools-not-declared,这条断言就测不到 secrets 那条路。
    const r = guardCloudEnvelope({
      autonomy: "bounded-agent",
      objective: "deploy with token AKIAABCDEFGHIJKLMNOP please",
      constraints: { allowed_tools: ["web"] },
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
