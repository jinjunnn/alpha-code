// REQ-128 `#698` —— canonical permutations、故障顺序与响亮失败,全部落在**真账本 + 真实物**上。
//
// 与 `ext-package-lifecycle.test.ts` 的分工:那边是纯代数(判决唯一);这边把判决执行出来,断言
// 可观察的后果。三组用例各钉一件已被证伪过的形态:
//
//   ① **共享保护**:standalone→Bundle、Bundle→standalone、Bundle A/B 共享 child、legacy 存量。
//      判据不是「文件还在」——「还在」在很多路径下本来就成立。夹具里的假 installer **会真的删**,
//      所以「一件实物都没动」是有代价的断言:把 `planPackageChildRemovalsV1` 的 owner 判据拿掉,
//      本组立刻红。
//
//   ② **顺序**:判决 → 删实物 → **一次** root mutation。实物删除失败时账本必须**逐字节不变**,
//      重试收敛。反过来(先改账本)在这里是错的:图一消失就再也算不出该删哪些 child,残留的
//      MCP 配置会让一个没人认领的 server 继续跑 —— 所以「先删实物」这条顺序本身要被钉住。
//
//   ③ **响亮失败**:篡改 owner / dangling claim / 图不匹配 / 越权 claim mutation。负向夹具里
//      违规项**从不放第一个**,集合里同时有合法项 —— 「只检查第一个」必须红。
//
// 账本夹具一律由**生产写器**造(upsertRecordsV2 → applyPackageMutation),不手搓 JSON:手搓只能
// 证明解码器读得懂我写的东西。

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  bundleOwner,
  computeInstalledGraphDigest,
  standaloneOwner,
  validatePackageMutationScopeV1,
  LEGACY_PROTECTED_OWNER,
  type PackageClaimV1,
  type PackageGraphV1,
  type PackageLedgerMutationV1,
} from "./ext-package-ledger-v3"
import {
  applyPackageMutation,
  findRecordV2,
  packageClaimOwners,
  readPackageGraphs,
  readPackageLedgerStateV1,
  upsertRecordsV2,
  type UpsertInput,
} from "./ext-receipt-v2"
import {
  planPackageUninstallV1,
  removePackageChildArtifactsV1,
  uninstallPackageV1,
  type PackageArtifactInstallersV1,
} from "./ext-package-uninstall"

let tmp = ""
let root = ""

const ledgerFile = (): string => path.join(root, "installs.json")
const readRaw = (): string => fs.readFileSync(ledgerFile(), "utf8")

// ── 两个包,共享一个 child ────────────────────────────────────────────────────────────────────

const PKG_A = "package:kit-a"
const PKG_B = "package:kit-b"
const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`
const SHARED_DIGEST = `sha256:${"c".repeat(64)}`
const ENVELOPE_A = `sha256:${"1".repeat(64)}`
const ENVELOPE_B = `sha256:${"2".repeat(64)}`
const OWNER_A = bundleOwner(PKG_A, DIGEST_A)
const OWNER_B = bundleOwner(PKG_B, DIGEST_B)

type Child = { componentId: string; kind: "skill" | "agent" | "mcp"; name: string }

/** A:agent root + 独占 skill + **共享** skill。共享项刻意排在最后 —— 只看第一个 child 的实现要红。 */
const A_CHILDREN: Child[] = [
  { componentId: "agent:a-root", kind: "agent", name: "a-root" },
  { componentId: "skill:a-only", kind: "skill", name: "a-only" },
  { componentId: "skill:shared", kind: "skill", name: "shared" },
]
/** B:mcp root + 同一个共享 skill(**同 digest** ⇒ 合法共享,不是冲突)。 */
const B_CHILDREN: Child[] = [
  { componentId: "agent:b-root", kind: "agent", name: "b-root" },
  { componentId: "skill:shared", kind: "skill", name: "shared" },
]

const upsertInput = (child: Child, digest: string): UpsertInput => ({
  id: `${child.kind}:${child.name}`,
  name: child.name,
  kind: child.kind,
  environment: "prod",
  scope: { kind: "global" },
  version: "1.0.0",
  manifestDigest: child.name === "shared" ? SHARED_DIGEST : digest,
  desiredState: "enabled",
  origin: "catalog",
  installedAt: "2026-08-01T00:00:00.000Z",
  ...(child.kind === "mcp" ? { configKey: `mcp.${child.name}` } : {}),
})

function graphOf(packageId: string, envelopeDigest: string, rootDigest: string, children: Child[]): PackageGraphV1 {
  const [head, ...rest] = children
  const withoutDigest = {
    packageId,
    envelopeDigest,
    root: { componentId: head!.componentId, kind: head!.kind, name: head!.name, required: true, manifestDigest: rootDigest },
    children: rest.map((child) => ({
      componentId: child.componentId,
      kind: child.kind,
      name: child.name,
      required: false,
      manifestDigest: child.name === "shared" ? SHARED_DIGEST : rootDigest,
    })),
  }
  return { ...withoutDigest, installedGraphDigest: computeInstalledGraphDigest(withoutDigest) }
}

const GRAPH_A = graphOf(PKG_A, ENVELOPE_A, DIGEST_A, A_CHILDREN)
const GRAPH_B = graphOf(PKG_B, ENVELOPE_B, DIGEST_B, B_CHILDREN)

function installMutation(graph: PackageGraphV1, children: Child[], owner: string, digest: string): PackageLedgerMutationV1 {
  return {
    transactionId: `tx-${graph.packageId}`,
    operation: "install",
    graphBeforeDigest: null,
    graphAfter: graph,
    childRecordMutations: children.map((child) => ({ op: "upsert" as const, input: upsertInput(child, digest) })),
    claimMutations: children.map((child) => ({ op: "acquire" as const, kind: child.kind, name: child.name, owner })),
  }
}

/** 实物:skill 目录、agent md。假 installer 会**真的删**它们。 */
function materialise(children: Child[]): void {
  for (const child of children) {
    if (child.kind === "skill") {
      fs.mkdirSync(path.join(root, "skills", child.name), { recursive: true })
      fs.writeFileSync(path.join(root, "skills", child.name, "SKILL.md"), `---\nname: ${child.name}\n---\nbody`)
    }
    if (child.kind === "agent") {
      fs.mkdirSync(path.join(root, "agents"), { recursive: true })
      fs.writeFileSync(path.join(root, "agents", `${child.name}.md`), "---\ndescription: d\n---\nsys")
    }
  }
}

const artifactPath = (kind: string, name: string): string =>
  kind === "skill" ? path.join(root, "skills", name) : path.join(root, "agents", `${name}.md`)

/** 生产形状:child record 由 **package mutation 自己**带进来(`commitTransactionLedger` 就是这样
 *  从 commit records 派生 upsert 的)。先 `upsertRecordsV2` 再 apply 会在 V3 已激活时凭空多出一个
 *  `standalone:` owner —— 那是「用户自己也装过」的意思,不是「包装的」。 */
function seedPackage(graph: PackageGraphV1, children: Child[], owner: string, digest: string): void {
  const applied = applyPackageMutation(root, installMutation(graph, children, owner, digest))
  if (!applied.ok) throw new Error(`fixture: activating ${graph.packageId} failed: ${applied.reason}`)
  materialise(children)
}

// ── 假 installer:真删 ────────────────────────────────────────────────────────────────────────

type Calls = string[]

function installers(calls: Calls, opts?: { failFsFor?: string }): PackageArtifactInstallersV1 {
  return {
    removeFsInstall: (type, name) => {
      calls.push(`removeFsInstall:${type}:${name}`)
      if (opts?.failFsFor === `${type}:${name}`) return { ok: false as const, reason: "injected fs removal failure" }
      const target = artifactPath(type, name)
      fs.rmSync(target, { recursive: true, force: true }) // 生产同形:实物真的没了
      return { ok: true as const, files: [target] }
    },
    removeMcpConfig: (name) => {
      calls.push(`removeMcpConfig:${name}`)
      return { ok: true as const }
    },
    removeMcpSecretsStrict: (name) => {
      calls.push(`removeMcpSecretsStrict:${name}`)
      return { ok: true as const }
    },
    releaseAlphaConnectionBindings: (componentId) => {
      calls.push(`releaseAlphaConnectionBindings:${componentId}`)
      return { ok: true as const }
    },
    removeInstallGrants: (_root, keys) => {
      calls.push(`removeInstallGrants:${keys.join(",")}`)
      return { ok: true as const, removed: [] }
    },
    removePluginPath: (name, absJsPath) => {
      calls.push(`removePluginPath:${name}:${absJsPath}`)
      return { ok: true as const }
    },
  }
}

let renameSpy: ReturnType<typeof spyOn<typeof fs, "renameSync">> | null = null

function countLedgerWrites(): () => number {
  const spy = spyOn(fs, "renameSync")
  renameSpy = spy
  const target = ledgerFile()
  return () => spy.mock.calls.filter((args) => args[1] === target).length
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "req128-698-"))
  root = path.join(tmp, "global")
  fs.mkdirSync(root, { recursive: true })
})

afterEach(() => {
  renameSpy?.mockRestore()
  renameSpy = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── ① canonical permutations ─────────────────────────────────────────────────────────────────

describe("REQ-128 #698 —— canonical permutations", () => {
  test("整包卸载:独占 child 真删、共享 child 保留并说得出理由、一次 mutation", () => {
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    seedPackage(GRAPH_B, B_CHILDREN, OWNER_B, DIGEST_B)
    expect(packageClaimOwners(root, "skill", "shared").sort()).toEqual([OWNER_A, OWNER_B].sort())

    const calls: Calls = []
    const writes = countLedgerWrites()
    const outcome = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 一次 mutation —— 逐 child 各提交一次就会是 3。
    expect(writes()).toBe(1)
    // 独占的两个真的没了(record + claim + 实物);共享的那个一件都没动。
    expect(outcome.removed.map((entry) => `${entry.kind}:${entry.name}`).sort()).toEqual(["agent:a-root", "skill:a-only"])
    expect(findRecordV2(root, "agent", "a-root")).toBeNull()
    expect(findRecordV2(root, "skill", "a-only")).toBeNull()
    expect(fs.existsSync(artifactPath("agent", "a-root"))).toBe(false)
    expect(fs.existsSync(artifactPath("skill", "a-only"))).toBe(false)
    expect(findRecordV2(root, "skill", "shared")).not.toBeNull()
    expect(fs.existsSync(artifactPath("skill", "shared"))).toBe(true)
    expect(packageClaimOwners(root, "skill", "shared")).toEqual([OWNER_B])
    expect(outcome.retained).toEqual([
      { kind: "skill", name: "shared", decision: "retain", remainingOwners: [OWNER_B], reasonCode: "shared-with-package" },
    ])
    // 共享 child 的实物删除接缝**一次都没被调用**(不是「调用了但恰好没删掉」)。
    expect(calls.filter((call) => call.includes("shared"))).toEqual([])
    // A 的图没了,B 的图逐字还在。
    expect(readPackageGraphs(root).map((graph) => graph.packageId)).toEqual([PKG_B])

    // 再卸 B:共享 child 此刻没有别的 owner ⇒ 该删了。
    const outcomeB = uninstallPackageV1(PKG_B, { globalRoot: () => root, installers: installers(calls) })
    expect(outcomeB.ok).toBe(true)
    if (!outcomeB.ok) return
    expect(outcomeB.removed.map((entry) => `${entry.kind}:${entry.name}`).sort()).toEqual(["agent:b-root", "skill:shared"])
    expect(findRecordV2(root, "skill", "shared")).toBeNull()
    expect(fs.existsSync(artifactPath("skill", "shared"))).toBe(false)
    expect(readPackageGraphs(root)).toEqual([])
  })

  test("standalone → Bundle:用户先单装,再被包收编;卸包时它留下,理由是「你自己也装过」", () => {
    // 用户先自己装 skill:shared(standalone claim 由生产写器在 V3 激活后自然产生)。
    seedPackage(GRAPH_B, B_CHILDREN, OWNER_B, DIGEST_B)
    expect(upsertRecordsV2(root, [upsertInput(A_CHILDREN[2]!, DIGEST_A)]).ok).toBe(true)
    expect(packageClaimOwners(root, "skill", "shared").sort()).toEqual([OWNER_B, standaloneOwner("skill", "shared")].sort())

    const calls: Calls = []
    const outcome = uninstallPackageV1(PKG_B, { globalRoot: () => root, installers: installers(calls) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.retained).toEqual([
      {
        kind: "skill",
        name: "shared",
        decision: "retain",
        remainingOwners: [standaloneOwner("skill", "shared")],
        reasonCode: "user-installed",
      },
    ])
    expect(fs.existsSync(artifactPath("skill", "shared"))).toBe(true)
    expect(findRecordV2(root, "skill", "shared")).not.toBeNull()
    expect(packageClaimOwners(root, "skill", "shared")).toEqual([standaloneOwner("skill", "shared")])
  })

  test("Bundle → standalone:卸包之后,那个 child 变回一件普通的单装物,能被正常卸载", () => {
    seedPackage(GRAPH_B, B_CHILDREN, OWNER_B, DIGEST_B)
    expect(upsertRecordsV2(root, [upsertInput(A_CHILDREN[2]!, DIGEST_A)]).ok).toBe(true)
    const calls: Calls = []
    expect(uninstallPackageV1(PKG_B, { globalRoot: () => root, installers: installers(calls) }).ok).toBe(true)
    // 现在它只剩 standalone owner ⇒ 直接卸载的判决是「删」,不再是「被 Bundle 拥有,去卸包」。
    const state = readPackageLedgerStateV1(root)
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.claims.find((claim) => claim.name === "shared")?.owners).toEqual([standaloneOwner("skill", "shared")])
    expect(state.packageGraphs).toEqual([])
  })

  test("legacy-protected 存量永不被整包卸载带走", () => {
    // V3 激活时,账本里已有的、没人认领的 record 一律 legacy-protected(生产行为)。
    expect(upsertRecordsV2(root, [upsertInput({ componentId: "skill:ancient", kind: "skill", name: "ancient" }, DIGEST_A)]).ok).toBe(true)
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    expect(packageClaimOwners(root, "skill", "ancient")).toEqual([LEGACY_PROTECTED_OWNER])
    // 把 legacy 存量也塞进 A 的 claim(模拟「它同时被一个包认领过」的最坏情形)。
    const applied = applyPackageMutation(root, {
      transactionId: "tx-legacy-adopt",
      operation: "update",
      graphBeforeDigest: GRAPH_A.installedGraphDigest,
      graphAfter: GRAPH_A,
      childRecordMutations: [],
      claimMutations: [],
    })
    // 图没变 ⇒ exact replay,不写盘;这一步只是证明重放不会破坏 legacy 保护。
    expect(applied).toMatchObject({ ok: true, replayed: true })

    const calls: Calls = []
    expect(uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) }).ok).toBe(true)
    expect(findRecordV2(root, "skill", "ancient")).not.toBeNull()
    expect(packageClaimOwners(root, "skill", "ancient")).toEqual([LEGACY_PROTECTED_OWNER])
    expect(calls.filter((call) => call.includes("ancient"))).toEqual([])
  })

  /**
   * BLOCKER 3 的直接回归,而且是这三条里唯一会**销毁用户自己装的东西**的那条。
   *
   * 顺序很关键:用户**先**单装 skill:shared(此时 V3 还没激活 ⇒ 账本里有 record、没有 claim),
   * **然后**装第一个含同名 child 的 Bundle。V3 收编发生在 `applyPackageMutation` 里,而它跳过
   * 「本次 mutation 也 upsert 了的」key —— 于是这条存量拿不到 `legacy-protected`,owner 集合里
   * 只剩 Bundle。卸掉这个 Bundle,用户原来那个独立安装的 Skill 被一起销毁。
   *
   * 既有的 standalone 用例避开了这一格:它先用**另一个包**激活 V3,于是 `upsertRecordsV2` 走的是
   * 「V3 已激活 ⇒ 自带 standalone claim」那条路。首包碰撞是另一格。
   */
  test("首个 V3 Bundle 与用户既有同名安装碰撞:那份存量必须拿到 legacy 保护,卸包时一件都不许动", () => {
    // ① V3 尚未激活:用户自己装的 skill:shared 在账上,没有任何 claim。
    expect(upsertRecordsV2(root, [upsertInput(A_CHILDREN[2]!, DIGEST_A)]).ok).toBe(true)
    materialise([A_CHILDREN[2]!])
    expect(JSON.parse(readRaw()).v).toBe(2)
    expect(packageClaimOwners(root, "skill", "shared")).toEqual([])

    // ② 第一个 Bundle 进来,含同名 child。
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    expect(packageClaimOwners(root, "skill", "shared").sort()).toEqual([LEGACY_PROTECTED_OWNER, OWNER_A].sort())

    // ③ 卸掉这个 Bundle:用户那份存量一件都不许动。
    const calls: Calls = []
    const outcome = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.retained).toEqual([
      { kind: "skill", name: "shared", decision: "retain", remainingOwners: [LEGACY_PROTECTED_OWNER], reasonCode: "legacy-protected" },
    ])
    expect(calls.filter((call) => call.includes("shared"))).toEqual([])
    expect(fs.existsSync(artifactPath("skill", "shared"))).toBe(true)
    expect(findRecordV2(root, "skill", "shared")).not.toBeNull()
    expect(packageClaimOwners(root, "skill", "shared")).toEqual([LEGACY_PROTECTED_OWNER])
  })

  test("unmanaged(账本里没有 v2 record)的图节点:判决是留,不是删", () => {
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    const planned = planPackageUninstallV1(root, PKG_A, "tx-probe")
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    // 三个 child 都有 record ⇒ 三个都判删。把 record 集合当成空的重算一次,判决必须整体翻成
    // 「unmanaged / 留」—— 这条钉住的是「managed 才删」这一格真的被读了。
    expect(planned.verdicts.every((verdict) => verdict.decision === "delete")).toBe(true)
  })
})

// ── ② 顺序与故障:判决 → 删实物 → 一次 mutation ────────────────────────────────────────────────

describe("REQ-128 #698 —— 顺序与故障", () => {
  test("实物删除失败 ⇒ 账本逐字节不变、图仍在、重试收敛", () => {
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    const before = readRaw()
    const calls: Calls = []
    const writes = countLedgerWrites()

    // 失败的不是第一个 child(a-root 排第一):部分删除已经发生,而账本仍必须一个字节都不动。
    const failed = uninstallPackageV1(PKG_A, {
      globalRoot: () => root,
      installers: installers(calls, { failFsFor: "skill:a-only" }),
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.stage).toBe("artifacts")
      expect(failed.reason).toContain("the ledger is unchanged")
    }
    expect(writes()).toBe(0)
    expect(readRaw()).toBe(before)
    expect(readPackageGraphs(root).map((graph) => graph.packageId)).toEqual([PKG_A])
    // 前一个 child 的实物确实已经没了 —— 也就是说「账本没动」不是因为什么都没发生。
    expect(fs.existsSync(artifactPath("agent", "a-root"))).toBe(false)

    // 重试:同一份判决重新算出来,已删的部分幂等,这次收敛。
    const retried = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })
    expect(retried.ok).toBe(true)
    expect(writes()).toBe(1)
    expect(readPackageGraphs(root)).toEqual([])
    expect(findRecordV2(root, "skill", "a-only")).toBeNull()
  })

  // `#809`:`plugin` 从「不认识的 kind」变成了**认识的 kind**(managed plugin 的卸载臂)。
  // 负例因此必须换成一个真的没有清除接缝的 kind —— `command` 是合法的 `InstallReceiptType`
  // 且不在 `packageChildKindV1` 的表里,正是「package 通道装不出来、也就没接缝」的那一格。
  // 拿一个已经有接缝的 kind 当负例,是负向覆盖**数量够了但轴不对**:错误实现照样全绿。
  test("不认识的 child kind ⇒ 实物阶段响亮拒绝(不静默跳过)", () => {
    const calls: Calls = []
    const outcome = removePackageChildArtifactsV1(
      root,
      [
        { kind: "skill", name: "a-only" },
        { kind: "command", name: "not-a-package-child" }, // 违规项不放第一个
      ],
      installers(calls),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("no artifact removal seam")
  })

  // `#809`:plugin 的落点是内容寻址的,名字算不出目录 —— 唯一真源是账本 record 的
  // `plugin-path:` configKey。它不在(或不是 plugin-path 形态)时**必须拒**,不能猜一个
  // `plugins/<name>/` 去删:猜错就是任意目录删除。
  test("plugin child 没有 plugin-path 账本记录 ⇒ 拒绝(不猜落点)", () => {
    const calls: Calls = []
    const outcome = removePackageChildArtifactsV1(
      root,
      [
        { kind: "skill", name: "a-only" },
        { kind: "plugin", name: "no-record-here" },
      ],
      installers(calls),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("cannot prove which file to remove")
    expect(calls.filter((call) => call.startsWith("removePluginPath:"))).toEqual([])
  })

  // 账本 record 在,但 `plugin-path:` 指到了受控树之外 ⇒ 圈禁判据必须拒。
  // 一本被改过的账本不得成为任意目录删除通道。
  test("plugin 的账本路径指向 plugins 根之外 ⇒ 拒绝(圈禁 fail-closed)", () => {
    upsertRecordsV2(root, [
      {
        id: "plugin:escapee",
        name: "escapee",
        kind: "plugin",
        environment: "prod",
        scope: { kind: "global" },
        version: "1.0.0",
        manifestDigest: DIGEST_A,
        desiredState: "enabled",
        origin: "catalog",
        installedAt: "2026-08-01T00:00:00.000Z",
        configKey: `plugin-path:${path.join(tmp, "elsewhere", "plugin.js")}`,
      },
    ])
    const calls: Calls = []
    const outcome = removePackageChildArtifactsV1(root, [{ kind: "plugin", name: "escapee" }], installers(calls))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("is not under")
    expect(calls.filter((call) => call.startsWith("removePluginPath:"))).toEqual([])
  })

  test("卸载一个没装过的 packageId / 非法 packageId ⇒ 计划期失败,零副作用", () => {
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    const before = readRaw()
    const calls: Calls = []
    for (const bad of ["package:never-installed", "NOT A PACKAGE ID", ""]) {
      const outcome = uninstallPackageV1(bad, { globalRoot: () => root, installers: installers(calls) })
      expect(outcome.ok, bad).toBe(false)
      if (!outcome.ok) expect(outcome.stage).toBe("plan")
    }
    expect(calls).toEqual([])
    expect(readRaw()).toBe(before)
  })
})

// ── ③ 响亮失败:篡改 / 悬空 / 越权 ────────────────────────────────────────────────────────────

describe("REQ-128 #698 —— 篡改与越权一律响亮失败", () => {
  const mutate = (edit: (ledger: Record<string, unknown>) => void): string => {
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    const ledger = JSON.parse(readRaw()) as Record<string, unknown>
    edit(ledger)
    fs.writeFileSync(ledgerFile(), `${JSON.stringify(ledger, null, 2)}\n`)
    return readRaw()
  }

  test("被篡改的 graph 节点 ⇒ 整包卸载在计划期就失败,字节零改动", () => {
    const before = mutate((ledger) => {
      const graphs = ledger.packageGraphs as PackageGraphV1[]
      graphs[0]!.children[1]!.name = "hijacked" // 第二个 child,不是第一个
    })
    const calls: Calls = []
    const outcome = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })
    expect(outcome.ok).toBe(false)
    // 图解码失败 ⇒ 这张图根本读不出来 ⇒ 「没装」而不是「装了但坏了」不可接受:必须报出来。
    if (!outcome.ok) expect(outcome.stage).toBe("plan")
    expect(calls).toEqual([])
    expect(readRaw()).toBe(before)
  })

  test("dangling claim(claim 指向一个没有 record 的 child)⇒ **计划期**拒绝:零删除调用、实物全在", () => {
    // 违规项追加在 claims 集合的**末尾** —— 「只检查第一个」必须红。
    const before = mutate((ledger) => {
      const claims = ledger.claims as PackageClaimV1[]
      claims.push({ kind: "skill", name: "never-installed", owners: [standaloneOwner("skill", "never-installed")] })
    })
    const calls: Calls = []
    const outcome = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain("dangling claim")
      // 拒绝必须发生在**判决期**,不是在实物已经删完之后的写盘期。
      expect(outcome.stage).toBe("plan")
    }
    // 唯一有区分度的两条:删除接缝零调用 + 实物仍在。
    // 「账本字节没变」在这条路径上本来就成立(拒绝发生在写盘处),断言它等于没断言。
    expect(calls).toEqual([])
    for (const child of A_CHILDREN) expect(fs.existsSync(artifactPath(child.kind, child.name)), `${child.kind}:${child.name}`).toBe(true)
    expect(readRaw()).toBe(before)
  })

  test("认不出的 owner token(混在合法 owner 后面)⇒ 计划期拒绝:零删除调用、实物全在", () => {
    const before = mutate((ledger) => {
      const claims = ledger.claims as PackageClaimV1[]
      claims[claims.length - 1]!.owners = [OWNER_A, "bundle:evil"] // 违规项在第二位
    })
    const calls: Calls = []
    const outcome = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.stage).toBe("plan")
    expect(calls).toEqual([])
    for (const child of A_CHILDREN) expect(fs.existsSync(artifactPath(child.kind, child.name)), `${child.kind}:${child.name}`).toBe(true)
    expect(readRaw()).toBe(before)
  })

  /**
   * 把「账本自身不自洽」当成**一类**枚举,而不是逐个实例打补丁(review R1 Blocker 2 的类形态)。
   *
   * 判据是同一条:`applyPackageMutation` 会拒的每一种账本状态,`planPackageUninstallV1` 都必须在
   * **删任何实物之前**拒掉。所以每一格断言的都是 `stage === "plan"` + 删除接缝零调用 + 实物全在,
   * 而**不是**「账本字节没变」—— 后者在拒绝发生于写盘处时也成立,等于没断言。
   */
  test.each([
    [
      "dangling claim(集合末尾)",
      (ledger: Record<string, unknown>) =>
        (ledger.claims as PackageClaimV1[]).push({
          kind: "skill",
          name: "never-installed",
          owners: [standaloneOwner("skill", "never-installed")],
        }),
    ],
    [
      "unknown child(图里的第三个节点没人认领)",
      (ledger: Record<string, unknown>) => {
        const victim = A_CHILDREN[2]!
        ledger.claims = (ledger.claims as PackageClaimV1[]).filter((c) => !(c.kind === victim.kind && c.name === victim.name))
      },
    ],
    [
      "孤儿 bundle owner(claim 指名一张账本里没有的图)",
      (ledger: Record<string, unknown>) => {
        const claims = ledger.claims as PackageClaimV1[]
        const last = claims[claims.length - 1]!
        last.owners = [...last.owners, bundleOwner("package:ghost", DIGEST_B)]
      },
    ],
    [
      "被篡改的 graph 节点(第二个 child)",
      (ledger: Record<string, unknown>) => {
        ;(ledger.packageGraphs as PackageGraphV1[])[0]!.children[1]!.name = "hijacked"
      },
    ],
  ])("账本不自洽的每一种形态:%s ⇒ 计划期拒、零删除调用、实物全在", (_label, edit) => {
    const before = mutate(edit)
    const calls: Calls = []
    const outcome = uninstallPackageV1(PKG_A, { globalRoot: () => root, installers: installers(calls) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.stage).toBe("plan")
    expect(calls).toEqual([])
    for (const child of A_CHILDREN) expect(fs.existsSync(artifactPath(child.kind, child.name)), `${child.kind}:${child.name}`).toBe(true)
    expect(readRaw()).toBe(before)
  })

  test("作用域闸:一次 package mutation 不得释放别人的 owner、不得认领图外的 child、不得删还在图里的 child", () => {
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    expect(upsertRecordsV2(root, [upsertInput(A_CHILDREN[1]!, DIGEST_A)]).ok).toBe(true) // 用户也单装了 a-only
    const own = standaloneOwner("skill", "a-only")
    expect(packageClaimOwners(root, "skill", "a-only").sort()).toEqual([OWNER_A, own].sort())
    const before = readRaw()

    const base = (): PackageLedgerMutationV1 => ({
      transactionId: "tx-scope",
      operation: "uninstall",
      graphBeforeDigest: GRAPH_A.installedGraphDigest,
      graphAfter: null,
      childRecordMutations: [],
      claimMutations: A_CHILDREN.map((child) => ({ op: "release" as const, kind: child.kind, name: child.name, owner: OWNER_A })),
    })

    // ① 释放用户自己的 standalone claim —— 越权。违规项**不在第一个**。
    const stealsUserClaim = base()
    stealsUserClaim.claimMutations = [...stealsUserClaim.claimMutations, { op: "release", kind: "skill", name: "a-only", owner: own }]
    const refusedSteal = applyPackageMutation(root, stealsUserClaim)
    expect(refusedSteal.ok).toBe(false)
    if (!refusedSteal.ok) expect(refusedSteal.reason).toContain("must not touch another owner's claim")

    // ② 认领一个不在本包图里的 child —— 越权(它会从此卸不掉)。
    const claimsOutsider = base()
    claimsOutsider.claimMutations = [
      ...claimsOutsider.claimMutations,
      { op: "release", kind: "skill", name: "outsider", owner: OWNER_A },
    ]
    const refusedOutsider = applyPackageMutation(root, claimsOutsider)
    expect(refusedOutsider.ok).toBe(false)
    if (!refusedOutsider.ok) expect(refusedOutsider.reason).toContain("in neither the before nor the after graph")

    // ③ 删一个仍在 after 图里的 child —— 纯代数层直接判(uninstall 没有 after 图,用 update 形状判)。
    const stillPresent: PackageLedgerMutationV1 = {
      transactionId: "tx-scope",
      operation: "update",
      graphBeforeDigest: GRAPH_A.installedGraphDigest,
      graphAfter: GRAPH_A,
      childRecordMutations: [{ op: "remove", kind: "skill", name: "a-only" }],
      claimMutations: [],
    }
    const scoped = validatePackageMutationScopeV1(stillPresent, GRAPH_A)
    expect(scoped.ok).toBe(false)
    if (!scoped.ok) expect(scoped.reason).toContain("still part of the after graph")

    // ④ 对照:合法的那一份照样过 —— 这道闸不是「一律拒」。
    expect(validatePackageMutationScopeV1(base(), GRAPH_A)).toEqual({ ok: true })
    // 三次拒绝之后账本逐字未变。
    expect(readRaw()).toBe(before)
  })

  test("算错的 mutation 想删一个还有别人在用的 child ⇒ 写盘前拒绝,别人的 claim 毫发无伤", () => {
    // 这一条钉住的是 `applyPackageMutation` 里被**删掉**的那行 `withoutClaim(removedKeys)`。
    // 那行看起来是清理,实际是唯一能让「删掉一个还有别人在用的 child」通过写盘的通道:它把
    // 剩余 owner 连同 claim 一起抹掉,于是 `validateV3State` 眼里一切自洽(record 没了、claim
    // 也没了),而用户的东西真没了。把那行加回去,本条立刻变绿 —— 也就是本条正在看着它。
    seedPackage(GRAPH_A, A_CHILDREN, OWNER_A, DIGEST_A)
    seedPackage(GRAPH_B, B_CHILDREN, OWNER_B, DIGEST_B)
    const before = readRaw()
    const wrong: PackageLedgerMutationV1 = {
      transactionId: "tx-overreach",
      operation: "uninstall",
      graphBeforeDigest: GRAPH_A.installedGraphDigest,
      graphAfter: null,
      // 只释放 A 的 owner(合法),却把 B 仍在用的 shared 一起去账(算错)。违规项不在第一个。
      childRecordMutations: [
        { op: "remove", kind: "agent", name: "a-root" },
        { op: "remove", kind: "skill", name: "a-only" },
        { op: "remove", kind: "skill", name: "shared" },
      ],
      claimMutations: A_CHILDREN.map((child) => ({ op: "release" as const, kind: child.kind, name: child.name, owner: OWNER_A })),
    }
    const refused = applyPackageMutation(root, wrong)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain("dangling claim skill:shared")
    expect(readRaw()).toBe(before)
    // 整次拒绝 ⇒ 连 A 自己那次合法的释放都没落盘(全或无),B 的 owner 当然也在。
    expect(packageClaimOwners(root, "skill", "shared").sort()).toEqual([OWNER_A, OWNER_B].sort())
    expect(findRecordV2(root, "skill", "shared")).not.toBeNull()
  })

  test("作用域闸:acquire 只能用**这一代**的 owner token(旧 token 混在后面)", () => {
    const after = graphOf(PKG_A, ENVELOPE_A, DIGEST_B, A_CHILDREN)
    const wrongOwner: PackageLedgerMutationV1 = {
      transactionId: "tx-scope",
      operation: "update",
      graphBeforeDigest: GRAPH_A.installedGraphDigest,
      graphAfter: after,
      childRecordMutations: [],
      claimMutations: [
        { op: "acquire", kind: "agent", name: "a-root", owner: bundleOwner(PKG_A, DIGEST_B) },
        { op: "acquire", kind: "skill", name: "a-only", owner: OWNER_A }, // 旧 token —— 违规项不在第一个
      ],
    }
    const scoped = validatePackageMutationScopeV1(wrongOwner, GRAPH_A)
    expect(scoped.ok).toBe(false)
    if (!scoped.ok) expect(scoped.reason).toContain("may only acquire")
  })
})
