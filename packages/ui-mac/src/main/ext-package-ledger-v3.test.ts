// REQ-128 `#706` —— V3 账本类型层的强度闸。
//
// 本文件盯三样东西:
//   ① **文法不是我发明的**。packageId / 组件 id 的文法真源是宿主合同 schema(它和 decoder.ts
//      一起被钉进跨仓 artifact,本票不得改动那些字节)。所以本模块只能带一份副本 —— 副本就是
//      「替别人写文法」,本仓最贵的返工形态。这里用**两条互相独立的轴**盯它:逐字比对 schema
//      的 pattern,以及把同一组 id 同时喂给真 decoder 与本正则比对判决。
//   ② **owner token 的解析对未知形状默认拒**。未知 owner 既不能被释放也不能被证明为空,放行
//      等于把「还有别人要」和「谁都不要」混成一个格子。
//   ③ **不变量是落盘前的整体判据**,不是逐条字段校验:dangling claim / unknown child /
//      孤儿 owner —— 三者都是「owner 集合从此无法自证」的具体形态。

import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { decodePackageEnvelopeHeaderV1 } from "../shared/host-extension-package-contract/decoder"
import { HOST_EXTENSION_PACKAGE_CORPUS } from "../shared/host-extension-package-contract/generate-artifact"
import { RECORD_KINDS } from "./ext-receipt-v2"
import {
  LEGACY_PROTECTED_OWNER,
  PACKAGE_ID_RE,
  PACKAGE_LEDGER_KINDS,
  blockingOwners,
  bundleOwner,
  computeGraphDigest,
  decodePackageClaimV1,
  decodePackageGraphV1,
  decodePackageMutationEnvelopeV1,
  decodePackageRecordV1,
  directUninstallVerdict,
  parseOwnerToken,
  standaloneOwner,
  validateV3State,
  withOwner,
  withoutClaim,
  withoutOwner,
  type PackageClaimV1,
  type PackageGraphV1,
} from "./ext-package-ledger-v3"

const CONTRACT_DIR = resolve(import.meta.dir, "..", "shared", "host-extension-package-contract")
const D1 = `sha256:${"1".repeat(64)}`
const D2 = `sha256:${"2".repeat(64)}`
const D3 = `sha256:${"3".repeat(64)}`

const graph = (over: Partial<Omit<PackageGraphV1, "graphDigest">> = {}): PackageGraphV1 => {
  const base = {
    packageId: "skill:demo",
    envelopeDigest: D1,
    root: { componentId: "skill:demo", kind: "skill" as const, name: "demo", required: true, manifestDigest: D2 },
    children: [],
    ...over,
  }
  return { ...base, graphDigest: computeGraphDigest(base) }
}

const claim = (kind: string, name: string, owners: string[]): PackageClaimV1 =>
  ({ kind, name, owners: [...owners].sort() }) as PackageClaimV1

describe("REQ-128 #706 — package id 文法不是本模块发明的", () => {
  test("轴一:与合同 schema 的 pattern 逐字相同(prelude.packageId 与组件 id 同一条)", async () => {
    const schema = (await Bun.file(resolve(CONTRACT_DIR, "alpha-package-envelope-v1.schema.json")).json()) as {
      properties: {
        prelude: { properties: { packageId: { pattern: string } } }
        components: { items: { properties: { id: { pattern: string } } } }
      }
    }
    expect(PACKAGE_ID_RE.source).toBe(schema.properties.prelude.properties.packageId.pattern)
    expect(schema.properties.components.items.properties.id.pattern).toBe(schema.properties.prelude.properties.packageId.pattern)
  })

  test("轴二:真 decoder 与本正则对同一组 id 判决逐条一致", async () => {
    const corpus = (await Bun.file(resolve(CONTRACT_DIR, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
      cases: Array<{ envelope: Record<string, unknown> }>
    }
    const encoder = new TextEncoder()
    const template = corpus.cases[0]!.envelope
    const candidates = [
      "skill:demo", // 合法
      "mcp-remote:mcp-remote-v1", // 合法(带连字符的 profile 段)
      "package:a.b_c", // 下划线不在 name 段文法里 ⇒ 拒
      "Skill:demo", // 大写首字母 ⇒ 拒
      "demo", // 无冒号 ⇒ 拒
      "skill:", // 空 name ⇒ 拒
      ":demo", // 空 profile ⇒ 拒
      "skill:demo:extra", // 第二个冒号 ⇒ 拒
      "skill:-demo", // name 段首字符非字母数字 ⇒ 拒
      `skill:${"d".repeat(200)}`, // 超长 ⇒ 拒
    ]
    for (const candidate of candidates) {
      const envelope = structuredClone(template)
      ;(envelope.prelude as Record<string, unknown>).packageId = candidate
      const decoded = decodePackageEnvelopeHeaderV1(encoder.encode(`${JSON.stringify(envelope, null, 2)}\n`))
      // decoder 拒 packageId 时报的是 header 阶段的 prelude 错误;其余错误与本轴无关。
      const decoderRejectsId =
        !decoded.ok && decoded.errors.some((e) => e.includes("envelope.prelude.packageId"))
      expect(decoderRejectsId, `${candidate}: decoder verdict must match PACKAGE_ID_RE`).toBe(!PACKAGE_ID_RE.test(candidate))
    }
  })

  test("child kind 集与账本 record kind 集**双向**相等", () => {
    expect([...PACKAGE_LEDGER_KINDS].sort()).toEqual([...RECORD_KINDS].sort())
  })
})

describe("REQ-128 #706 — owner token 解析", () => {
  test("三种合法形状各自可往返", () => {
    expect(parseOwnerToken(standaloneOwner("skill", "demo"))).toEqual({ kind: "standalone", childKind: "skill", childName: "demo" })
    expect(parseOwnerToken(bundleOwner("skill:demo", D2))).toEqual({ kind: "bundle", packageId: "skill:demo", manifestDigest: D2 })
    expect(parseOwnerToken(LEGACY_PROTECTED_OWNER)).toEqual({ kind: "legacy-protected" })
  })

  test("未知形状一律 null(不是「宽容当作 legacy」)", () => {
    for (const bad of [
      "",
      "legacy",
      "legacy-protected ",
      "standalone:bogus:demo", // 未知 kind
      "standalone:skill:", // 空 name
      "standalone:skill:../escape",
      "bundle:skill:demo", // 缺 @digest
      "bundle:skill:demo@sha256:zz", // digest 文法非法
      "bundle:@" + D2, // 空 packageId
      "bundle:Skill:Demo@" + D2, // packageId 文法非法
      "owner:whatever",
      42,
      null,
      undefined,
      { kind: "standalone" },
    ])
      expect(parseOwnerToken(bad as unknown), `${JSON.stringify(bad)} must not parse`).toBeNull()
  })
})

describe("REQ-128 #706 — 严格解码", () => {
  test("graph 往返 + graphDigest 篡改响亮失败", () => {
    const g = graph()
    expect(decodePackageGraphV1(g)).toEqual({ ok: true, value: g })
    const tampered = { ...g, root: { ...g.root, name: "other" } }
    const bad = decodePackageGraphV1(tampered)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toContain("does not match the graph contents")
  })

  test("graph 负向集:未知键 / 非 required root / 重复 componentId / 重复 (kind,name) / 非法 digest", () => {
    const g = graph()
    const cases: Array<[string, unknown]> = [
      ["unknown key", { ...g, extra: 1 }],
      ["non-required root", { ...g, root: { ...g.root, required: false } }],
      ["bad digest", { ...g, root: { ...g.root, manifestDigest: "sha256:nope" } }],
      ["bad component id", { ...g, root: { ...g.root, componentId: "NOPE" } }],
      ["children not array", { ...g, children: {} }],
    ]
    for (const [label, input] of cases) expect(decodePackageGraphV1(input).ok, label).toBe(false)
    const dupComponent = {
      packageId: "skill:demo",
      envelopeDigest: D1,
      root: { componentId: "skill:demo", kind: "skill", name: "demo", required: true, manifestDigest: D2 },
      children: [{ componentId: "skill:demo", kind: "agent", name: "other", required: false, manifestDigest: D3 }],
    }
    expect(decodePackageGraphV1({ ...dupComponent, graphDigest: computeGraphDigest(dupComponent as never) }).ok).toBe(false)
    const dupChild = {
      packageId: "skill:demo",
      envelopeDigest: D1,
      root: { componentId: "skill:demo", kind: "skill", name: "demo", required: true, manifestDigest: D2 },
      children: [{ componentId: "skill:other-id", kind: "skill", name: "demo", required: false, manifestDigest: D3 }],
    }
    expect(decodePackageGraphV1({ ...dupChild, graphDigest: computeGraphDigest(dupChild as never) }).ok).toBe(false)
  })

  test("claim:空 owner 集 / 未知 owner / 重复 owner / 张冠李戴的 standalone owner 一律拒", () => {
    expect(decodePackageClaimV1(claim("skill", "demo", [LEGACY_PROTECTED_OWNER])).ok).toBe(true)
    for (const bad of [
      { kind: "skill", name: "demo", owners: [] },
      { kind: "skill", name: "demo", owners: ["nonsense"] },
      { kind: "skill", name: "demo", owners: [LEGACY_PROTECTED_OWNER, LEGACY_PROTECTED_OWNER] },
      // standalone owner 指向另一个 child —— 一个 claim 替另一个 child 背书
      { kind: "skill", name: "demo", owners: [standaloneOwner("skill", "other")] },
      { kind: "bogus", name: "demo", owners: [LEGACY_PROTECTED_OWNER] },
      { kind: "skill", name: "demo", owners: [LEGACY_PROTECTED_OWNER], extra: 1 },
    ])
      expect(decodePackageClaimV1(bad).ok, JSON.stringify(bad)).toBe(false)
  })

  test("packageRecord:未知键 / 非法 digest / 非法 txId / 非法时间戳", () => {
    const rec = { packageId: "skill:demo", envelopeDigest: D1, graphDigest: D2, transactionId: "tx-1", installedAt: "2026-07-31T00:00:00.000Z" }
    expect(decodePackageRecordV1(rec).ok).toBe(true)
    for (const bad of [
      { ...rec, extra: 1 },
      { ...rec, graphDigest: "nope" },
      { ...rec, transactionId: "tx/1" },
      { ...rec, installedAt: "not-a-date" },
      { ...rec, version: "" },
    ])
      expect(decodePackageRecordV1(bad).ok, JSON.stringify(bad)).toBe(false)
  })

  test("mutation envelope:install/update 必须图与记录成对且 digest 互绑;uninstall 必须两者皆 null", () => {
    const g = graph()
    const rec = { packageId: g.packageId, envelopeDigest: g.envelopeDigest, graphDigest: g.graphDigest, transactionId: "tx-1", installedAt: "2026-07-31T00:00:00.000Z" }
    const ok = decodePackageMutationEnvelopeV1({
      operation: "install",
      packageRecord: rec,
      graphBeforeDigest: null,
      graphAfter: g,
      claimMutations: [{ op: "acquire", kind: "skill", name: "demo", owner: bundleOwner(g.packageId, D2) }],
    })
    expect(ok.ok).toBe(true)
    for (const bad of [
      { operation: "install", packageRecord: rec, graphBeforeDigest: null, graphAfter: null, claimMutations: [] },
      { operation: "install", packageRecord: null, graphBeforeDigest: null, graphAfter: g, claimMutations: [] },
      { operation: "uninstall", packageRecord: rec, graphBeforeDigest: g.graphDigest, graphAfter: g, claimMutations: [] },
      { operation: "install", packageRecord: { ...rec, graphDigest: D3 }, graphBeforeDigest: null, graphAfter: g, claimMutations: [] },
      { operation: "install", packageRecord: { ...rec, packageId: "skill:other" }, graphBeforeDigest: null, graphAfter: g, claimMutations: [] },
      { operation: "bogus", packageRecord: rec, graphBeforeDigest: null, graphAfter: g, claimMutations: [] },
      { operation: "install", packageRecord: rec, graphBeforeDigest: "nope", graphAfter: g, claimMutations: [] },
      { operation: "install", packageRecord: rec, graphBeforeDigest: null, graphAfter: g, claimMutations: [{ op: "acquire", kind: "skill", name: "demo", owner: "junk" }] },
      { operation: "install", packageRecord: rec, graphBeforeDigest: null, graphAfter: g, claimMutations: [], extra: 1 },
    ])
      expect(decodePackageMutationEnvelopeV1(bad).ok, JSON.stringify(bad).slice(0, 90)).toBe(false)
  })
})

describe("REQ-128 #706 — claim 集合代数与直接卸载判决", () => {
  test("owner 集合的增删幂等,空集即删 claim", () => {
    let claims = withOwner([], "skill", "demo", standaloneOwner("skill", "demo"))
    claims = withOwner(claims, "skill", "demo", standaloneOwner("skill", "demo"))
    expect(claims).toEqual([{ kind: "skill", name: "demo", owners: [standaloneOwner("skill", "demo")] }])
    claims = withoutOwner(claims, "skill", "demo", standaloneOwner("skill", "demo"))
    expect(claims).toEqual([])
    expect(withoutClaim([claim("skill", "demo", [LEGACY_PROTECTED_OWNER])], "skill", "demo")).toEqual([])
  })

  test("阻挡删除的只有 Bundle owner —— legacy-protected 不挡用户的显式卸载", () => {
    expect(blockingOwners([LEGACY_PROTECTED_OWNER, standaloneOwner("skill", "demo")], standaloneOwner("skill", "demo"))).toEqual([])
    expect(blockingOwners([bundleOwner("skill:demo", D2)], standaloneOwner("skill", "demo"))).toEqual([bundleOwner("skill:demo", D2)])
  })

  test("直接卸载判决:无 claim → 删;只有自己/legacy → 删;仍有 Bundle → 只释放 claim", () => {
    expect(directUninstallVerdict(null, "skill", "demo")).toEqual({ decision: "delete", releasedOwner: null })
    expect(directUninstallVerdict(claim("skill", "demo", [standaloneOwner("skill", "demo")]), "skill", "demo")).toEqual({
      decision: "delete",
      releasedOwner: standaloneOwner("skill", "demo"),
    })
    expect(directUninstallVerdict(claim("skill", "demo", [LEGACY_PROTECTED_OWNER]), "skill", "demo")).toEqual({
      decision: "delete",
      releasedOwner: null,
    })
    expect(
      directUninstallVerdict(claim("skill", "demo", [standaloneOwner("skill", "demo"), bundleOwner("skill:demo", D2)]), "skill", "demo"),
    ).toEqual({ decision: "release-claim-only", remainingOwners: [bundleOwner("skill:demo", D2)] })
  })

  // review #757 Major:上一版只覆盖「standalone + Bundle」,而 fresh package 安装产出的是
  // **只有 Bundle owner**(`package-admission` 的 claimMutations 只 acquire 一个 `bundle:`)。
  // 那个形状被判成 `release-claim-only` ⇒ 上层去释放一份不存在的 claim ⇒ 谎报卸载成功。
  test("直接卸载判决:**只有** Bundle owner(没有 standalone claim 可释放)⇒ refuse,不是 release-claim-only", () => {
    // 违规形状不放在 owner 集合的第一位:多个 Bundle owner 在场,自己那份自始至终不存在。
    const verdict = directUninstallVerdict(claim("skill", "demo", [bundleOwner("kit:a", D1), bundleOwner("kit:b", D2)]), "skill", "demo")
    expect(verdict.decision).toBe("refuse")
    if (verdict.decision === "refuse") {
      expect(verdict.reason).toContain(bundleOwner("kit:a", D1))
      expect(verdict.reason).toContain(bundleOwner("kit:b", D2))
      expect(verdict.reason).toContain("no standalone install to release")
    }
    // legacy-protected 混在 Bundle owner 里同样不是「自己那份」—— 仍然 refuse。
    expect(directUninstallVerdict(claim("skill", "demo", [LEGACY_PROTECTED_OWNER, bundleOwner("skill:demo", D2)]), "skill", "demo").decision).toBe(
      "refuse",
    )
  })
})

describe("REQ-128 #706 — 落盘前的整体不变量", () => {
  const g = graph()
  const owner = bundleOwner(g.packageId, g.root.manifestDigest)

  test("完备状态通过", () => {
    expect(validateV3State({ recordKeys: new Set(["skill:demo"]), packageGraphs: [g], claims: [claim("skill", "demo", [owner])] })).toEqual({ ok: true })
  })

  test("dangling claim:claim 指向没有 record 的 child", () => {
    const r = validateV3State({ recordKeys: new Set(), packageGraphs: [], claims: [claim("skill", "demo", [LEGACY_PROTECTED_OWNER])] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("dangling claim")
  })

  test("unknown child:图里的节点没有 claim 认领", () => {
    const r = validateV3State({ recordKeys: new Set(["skill:demo"]), packageGraphs: [g], claims: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unknown child")
  })

  test("图在册但 claim 没写这个 owner —— 也是 unknown child 的一种", () => {
    const r = validateV3State({
      recordKeys: new Set(["skill:demo"]),
      packageGraphs: [g],
      claims: [claim("skill", "demo", [LEGACY_PROTECTED_OWNER])],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("does not carry that package as an owner")
  })

  test("孤儿 owner:claim 指名一个账本里没有的 package 图 —— 那个 owner 永远不会被释放", () => {
    const r = validateV3State({
      recordKeys: new Set(["skill:demo"]),
      packageGraphs: [],
      claims: [claim("skill", "demo", [bundleOwner("skill:ghost", D3)])],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("orphan owner")
  })

  test("同一个 packageId 两张图 / 同一个 child 两条 claim 都是两个真相", () => {
    const dupGraph = validateV3State({
      recordKeys: new Set(["skill:demo"]),
      packageGraphs: [g, g],
      claims: [claim("skill", "demo", [owner])],
    })
    expect(dupGraph.ok).toBe(false)
    if (!dupGraph.ok) expect(dupGraph.reason).toContain("duplicate package graph")
    const dupClaim = validateV3State({
      recordKeys: new Set(["skill:demo"]),
      packageGraphs: [],
      claims: [claim("skill", "demo", [LEGACY_PROTECTED_OWNER]), claim("skill", "demo", [LEGACY_PROTECTED_OWNER])],
    })
    expect(dupClaim.ok).toBe(false)
    if (!dupClaim.ok) expect(dupClaim.reason).toContain("duplicate claim")
  })
})
