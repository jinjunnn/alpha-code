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

import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { decodePackageEnvelopeHeaderV1 } from "../shared/host-extension-package-contract/decoder"
import { HOST_EXTENSION_PACKAGE_CORPUS } from "../shared/host-extension-package-contract/generate-artifact"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import { RECORD_KINDS } from "./ext-receipt-v2"
import {
  LEGACY_PROTECTED_OWNER,
  PACKAGE_ID_RE,
  PACKAGE_LEDGER_KINDS,
  blockingOwners,
  bundleOwner,
  computeInstalledGraphDigest,
  PACKAGE_DISPLAY_NAME_MAX,
  decodePackageClaimV1,
  decodePackageGraphV1,
  decodePackageMutationEnvelopeV1,
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

const graph = (over: Partial<Omit<PackageGraphV1, "installedGraphDigest">> = {}): PackageGraphV1 => {
  const base = {
    packageId: "skill:demo",
    envelopeDigest: D1,
    root: { componentId: "skill:demo", kind: "skill" as const, name: "demo", required: true, manifestDigest: D2 },
    children: [],
    ...over,
  }
  return { ...base, installedGraphDigest: computeInstalledGraphDigest(base) }
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
  test("graph 往返 + installedGraphDigest 篡改响亮失败", () => {
    const g = graph()
    expect(decodePackageGraphV1(g)).toEqual({ ok: true, value: g })
    const tampered = { ...g, root: { ...g.root, name: "other" } }
    const bad = decodePackageGraphV1(tampered)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toContain("does not match the graph contents")
  })

  // `#758`:落盘键从 `graphDigest` 改名为 `installedGraphDigest`,**不迁移**。旧账本必须
  // 响亮拒绝而不是被默默读成「没有图」——「没有图」会让一个装好的包显示成没装、claim 随之
  // 无人认领。严格 schema 已经给出这个行为,这条断言把它钉住:未知键 + 缺必填键,两条都报。
  test("旧键 `graphDigest` 的账本:响亮拒绝,不迁移", () => {
    const g = graph()
    const { installedGraphDigest, ...rest } = g
    const legacy = { ...rest, graphDigest: installedGraphDigest }
    const decoded = decodePackageGraphV1(legacy)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) {
      const joined = decoded.errors.join(" | ")
      expect(joined).toContain('unknown key "graphDigest"')
      expect(joined).toContain("packageGraph.installedGraphDigest: invalid")
    }
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
    expect(decodePackageGraphV1({ ...dupComponent, installedGraphDigest: computeInstalledGraphDigest(dupComponent as never) }).ok).toBe(false)
    const dupChild = {
      packageId: "skill:demo",
      envelopeDigest: D1,
      root: { componentId: "skill:demo", kind: "skill", name: "demo", required: true, manifestDigest: D2 },
      children: [{ componentId: "skill:other-id", kind: "skill", name: "demo", required: false, manifestDigest: D3 }],
    }
    expect(decodePackageGraphV1({ ...dupChild, installedGraphDigest: computeInstalledGraphDigest(dupChild as never) }).ok).toBe(false)
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

  test("mutation envelope:install/update 必须带 after 图;uninstall 必须没有", () => {
    const g = graph()
    const ok = decodePackageMutationEnvelopeV1({
      operation: "install",
      graphBeforeDigest: null,
      graphAfter: g,
      claimMutations: [{ op: "acquire", kind: "skill", name: "demo", owner: bundleOwner(g.packageId, D2) }],
      childRemovals: [],
    })
    expect(ok.ok).toBe(true)
    // 每条负向只坏**一处**,其余字段一律合法 —— 少写一个新增的必填键会让整组「因为缺字段」而红,
    // 那时这道闸测的就不再是它抬头写的东西了(`#698` 加 `childRemovals` 时正是这个陷阱)。
    for (const bad of [
      { operation: "install", graphBeforeDigest: null, graphAfter: null, claimMutations: [], childRemovals: [] },
      { operation: "uninstall", graphBeforeDigest: g.installedGraphDigest, graphAfter: g, claimMutations: [], childRemovals: [] },
      { operation: "install", graphBeforeDigest: null, graphAfter: { ...g, installedGraphDigest: D3 }, claimMutations: [], childRemovals: [] },
      { operation: "bogus", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: [] },
      { operation: "install", graphBeforeDigest: "nope", graphAfter: g, claimMutations: [], childRemovals: [] },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [{ op: "acquire", kind: "skill", name: "demo", owner: "junk" }], childRemovals: [] },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: [], extra: 1 },
      // `#764`:`packageRecord` 曾经是这个信封的必填键,现在它是**未知键**。这一条钉的是
      // 「删掉之后没有任何地方还在假装它存在」的另一半 —— 旧构建写下的 journal 半场必须被响亮
      // 拒绝,而不是被忽略后照着一份少了字段的 mutation 前滚。
      {
        operation: "install",
        graphBeforeDigest: null,
        graphAfter: g,
        claimMutations: [],
        childRemovals: [],
        packageRecord: { packageId: g.packageId, envelopeDigest: g.envelopeDigest, installedGraphDigest: g.installedGraphDigest, transactionId: "tx-1", installedAt: "2026-07-31T00:00:00.000Z" },
      },
      // `#698` childRemovals 自身的负向:缺字段 / 未知 kind / 非法 name / 未知键 / 重复项。
      // 重复项刻意**不放第一个**,并且前面有一个合法项 —— 「只看第一个」时必须红。
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [] },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: {} },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: [{ kind: "skill" }] },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: [{ kind: "wat", name: "demo" }] },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: [{ kind: "skill", name: "../escape" }] },
      { operation: "install", graphBeforeDigest: null, graphAfter: g, claimMutations: [], childRemovals: [{ kind: "skill", name: "demo", extra: 1 }] },
      {
        operation: "install",
        graphBeforeDigest: null,
        graphAfter: g,
        claimMutations: [],
        childRemovals: [
          { kind: "agent", name: "legit" },
          { kind: "skill", name: "demo" },
          { kind: "skill", name: "demo" },
        ],
      },
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

// REQ-128 Phase 3 `#781`(基线 §9 D3 = 编排者裁决 F):`envelopeDigest` 保留字段名,填本地
// 规范化载荷摘要,**由测试钉住**「它不是信封摘要、provenance 从 record.origin 读」。
// 裁决明写「不许靠注释解决」—— 所以这两条在这里,不在文件抬头。
describe("REQ-128 #781 — `envelopeDigest` 名不副实,且它不承载任何判决", () => {
  /** catalog:一份已验签信封的摘要。 */
  const CATALOG_ENVELOPE = `sha256:${"c".repeat(64)}`
  /** 本地 Claude 插件包:**本机对本地字节算的**规范化载荷摘要。格式相同,语义不同。 */
  const LOCAL_PAYLOAD = `sha256:${"1".repeat(64)}`

  const localGraph = graph({
    packageId: "local:tide-plugin",
    envelopeDigest: LOCAL_PAYLOAD,
    root: { componentId: "user:premarket", kind: "skill", name: "premarket", required: true, manifestDigest: D2 },
  })
  const catalogGraph = graph({
    packageId: "skill:demo",
    envelopeDigest: CATALOG_ENVELOPE,
    root: { componentId: "skill:demo", kind: "skill", name: "premarket", required: true, manifestDigest: D2 },
  })

  test("`local:` 命名空间与本地载荷摘要:decoder 照收 —— 它只校验格式,不校验来源", () => {
    expect(PACKAGE_ID_RE.test("local:tide-plugin")).toBe(true)
    expect(decodePackageGraphV1(localGraph)).toEqual({ ok: true, value: localGraph })
    // 这正是本地路线不必改 `#306` 的全部理由:图节点的摘要与 child record 的摘要互不校验。
  })

  test("换掉 envelopeDigest 的语义,本模块的每一个判决逐字不变", () => {
    const localOwner = bundleOwner(localGraph.packageId, localGraph.root.manifestDigest)
    const catalogOwner = bundleOwner(catalogGraph.packageId, catalogGraph.root.manifestDigest)
    const state = (g: PackageGraphV1, owner: string) =>
      validateV3State({ recordKeys: new Set(["skill:premarket"]), packageGraphs: [g], claims: [claim("skill", "premarket", [owner])] })
    expect(state(localGraph, localOwner)).toEqual({ ok: true })
    expect(state(catalogGraph, catalogOwner)).toEqual({ ok: true })
    // 直接卸载判决同样只看 owner 集合,不看图上的 digest 是打哪来的。
    // (理由串里会点名 owner —— 那是给用户看的「去卸哪个包」,判决本身是 `decision` 这一格。)
    const verdictOf = (owner: string) => directUninstallVerdict(claim("skill", "premarket", [owner]), "skill", "premarket")
    expect(verdictOf(localOwner).decision).toBe("refuse")
    expect(verdictOf(localOwner).decision).toBe(verdictOf(catalogOwner).decision)
    // 但它仍被 installedGraphDigest 覆盖 —— 改一个字节照样响亮失败,不是「随便填」。
    expect(decodePackageGraphV1({ ...localGraph, envelopeDigest: CATALOG_ENVELOPE }).ok).toBe(false)
  })

  test("provenance 不在这本账里:V3 的状态入参结构上答不出「这东西哪来的」", () => {
    // `validateV3State` 的 recordKeys 是 `${kind}:${name}` 字符串集 —— 没有 origin、没有 id、
    // 没有 digest。所以「这个包是不是策展来的」只能问 child record 的 `origin`
    // (`ext-receipt-v2` 的 `decodeRecordV2`:非 catalog 恒 `user:<name>` 且禁携供给链摘要)。
    // 若将来有人往 V3 里加「catalog-only」判据,本地扩展包会在这里先红,而不是在用户机器上。
    const owner = bundleOwner(localGraph.packageId, localGraph.root.manifestDigest)
    expect(
      validateV3State({
        recordKeys: new Set(["skill:premarket"]),
        packageGraphs: [localGraph],
        claims: [claim("skill", "premarket", [owner])],
      }),
    ).toEqual({ ok: true })
  })
})

// REQ-128 Phase 3 `#784`(owner 裁决):`displayName` —— **可选,只管显示**。
//
// 加这个字段的理由是可达性,不是打磨:不加的话,用户导入 `tide` 之后在列表里看到的是
// `postmarket-review`(包里某个技能的名字),这条竖线名义上闭合了而**用户看不懂自己装了什么**。
//
// 裁决里的四条约束在这里逐条钉住,**不靠注释成立**。
describe("REQ-128 #784 — 包显示名:可选、只管显示、不承载任何判决", () => {
  const NAME = "tide"
  const withName = graph({ packageId: "local:tide", displayName: NAME })
  const withoutName = graph({ packageId: "local:tide" })

  test("缺席合法:存量图没有这个字段照样解得开(**绝不因为缺字段就拒载真实配置**)", () => {
    expect("displayName" in withoutName).toBe(false)
    const decoded = decodePackageGraphV1(withoutName)
    expect(decoded).toEqual({ ok: true, value: withoutName })
    expect(decoded.ok && decoded.value.displayName).toBeUndefined()
  })

  test("兼容性契约的**前提本身**:canonicalJson 丢弃 undefined 键", () => {
    // 这条不是形式主义:上面那条「摘要没变」真正靠的就是它,而它住在**另一个模块**里。
    // 实测过 —— 把 `computeInstalledGraphDigest` 里的条件展开改成无条件,全部用例仍然绿,
    // 因为 undefined 在这里就被丢掉了。所以要钉的是这条前提,不是那个条件展开。
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
    // 而**填占位**(而不是省略)会真的改掉口径 —— 这才是会让存量图集体拒载的那个改法。
    expect(canonicalJson({ a: 1, b: "" })).not.toBe(canonicalJson({ a: 1 }))
  })

  test("兼容性契约:**没有这个字段的图,摘要与加字段之前逐字节相同**", () => {
    // 判据不是「解得开」——那在无条件写 `displayName: undefined` 时也成立。判据是**摘要口径没变**:
    // 摘要一变,全部存量图会在下一次读取时被判成「被篡改过」而拒载。所以这里手算旧口径去比。
    const legacyDigest = `sha256:${sha256Hex(
      canonicalJson({
        packageId: withoutName.packageId,
        envelopeDigest: withoutName.envelopeDigest,
        root: withoutName.root,
        children: [],
      }),
    )}`
    expect(withoutName.installedGraphDigest).toBe(legacyDigest)
  })

  test("在场时被篡改闸覆盖:改一个字的显示名 ⇒ digest 不符 ⇒ 拒", () => {
    expect(decodePackageGraphV1(withName)).toEqual({ ok: true, value: withName })
    expect(withName.installedGraphDigest).not.toBe(withoutName.installedGraphDigest)
    expect(decodePackageGraphV1({ ...withName, displayName: "tide-x" }).ok).toBe(false)
  })

  test("在场时形状必须合法:空串 / 超长 / 控制字符一律拒(呈现事故不该由 renderer 去兜)", () => {
    const bad = (value: unknown) => decodePackageGraphV1({ ...withName, displayName: value })
    expect(bad("").ok).toBe(false)
    expect(bad("x".repeat(PACKAGE_DISPLAY_NAME_MAX + 1)).ok).toBe(false)
    expect(bad(`a\u0007b`).ok).toBe(false)
    expect(bad(`two\nlines`).ok).toBe(false)
    expect(bad(42).ok).toBe(false)
    // 合法边界:恰好帽长可以过 —— 判据是 `> MAX`,不是 `>= MAX`。
    expect(decodePackageGraphV1(graph({ packageId: "local:tide", displayName: "x".repeat(PACKAGE_DISPLAY_NAME_MAX) })).ok).toBe(true)
  })

  test("**它不承载任何判决**:显示名换成一句谎话,本模块的每一个判决逐字不变", () => {
    // 判据不是「我没在判决里写它」—— 那是一句声明。判据是:把它换成一个**最容易被误读成
    // provenance** 的值(「官方目录」),再把两张图喂给全部判决函数,结果必须逐字相等。
    const honest = graph({ packageId: "local:tide", displayName: NAME })
    const lying = graph({ packageId: "local:tide", displayName: "official-catalog-package" })
    const owner = bundleOwner(honest.packageId, honest.root.manifestDigest)
    const stateOf = (g: PackageGraphV1) =>
      validateV3State({ recordKeys: new Set(["skill:demo"]), packageGraphs: [g], claims: [claim("skill", "demo", [owner])] })
    expect(stateOf(honest)).toEqual(stateOf(lying))
    expect(stateOf(lying)).toEqual({ ok: true })
    expect(directUninstallVerdict(claim("skill", "demo", [owner]), "skill", "demo").decision).toBe("refuse")
    // 身份完全不受它影响 —— 身份是 packageId,显示名不参与 owner token 的铸造。
    expect(bundleOwner(lying.packageId, lying.root.manifestDigest)).toBe(owner)
  })

  test("枚举闸(**减速带,不是安全边界**):账本模块之外只有一个地方读得到 graph.displayName", () => {
    // 诚实降级:这条判的是**源码文本**,把读法换个写法(先解构、先转存)就绕得过去。
    // 它拦的是「顺手在某个判定里读了显示名」,不是「有人存心躲」。真正的行为闸是上面那条
    // 「换成谎话判决不变」,以及 `local-package-renderer.cases.ts` 里「来源标只由 origin 决定」。
    const roots = [resolve(import.meta.dir, "."), resolve(import.meta.dir, "../renderer"), resolve(import.meta.dir, "../preload")]
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(abs)
          continue
        }
        if (!/\.tsx?$/.test(entry.name) || /\.(test|cases)\.tsx?$/.test(entry.name)) continue
        // 只找**图上的**那一个 —— `CatalogEntry.displayName` 是同名不同物,全仓几十处。
        if (/\bgraph\s*\.\s*displayName\b/.test(readFileSync(abs, "utf8"))) hits.push(entry.name)
      }
    }
    for (const dir of roots) walk(dir)
    // 前提自检:走查真的看到了文件 —— 空树会让「无违规」变成假绿。
    expect(hits.length).toBeGreaterThan(0)
    // `ext-package-ledger-v3.ts` = 账本模块自己(类型/解码/摘要);`ext-ipc.ts` = 只读投影。
    expect(hits.sort()).toEqual(["ext-ipc.ts", "ext-package-ledger-v3.ts"])
  })
})
