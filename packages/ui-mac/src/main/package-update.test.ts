// REQ-128 `#698` —— Bundle **update** 的生产路径闸:add / remove / replace 三种变化各走一遍
// 真 admission → 真 `runExtensionTransaction` → 真 V3 账本。
//
// 为什么必须走真 admission 而不是直接喂 mutation:`#697` 之后「装第二个版本」在结构上是**装不上**的
// —— root 的 manifestDigest 一变,owner token 就变,而旧 claim 上的旧 token 会成为「孤儿 owner」
// (`validateV3State`:claim 指名一张这本账里没有的图),整次写盘被拒。这条只有沿生产链跑才看得见,
// 手搓 mutation 会不小心把 release 一起写对而证明不了任何事。
//
// 两代信封都从**vendored producer 产物**派生(`expected.bundle.compiled.json`):基线形状是真的,
// 只有「第二代长什么样」这个 delta 是合成的 —— 而 update 本来就是一个 delta,没有任何产物能替我们
// 提供「同一个包的下一版」。

import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AlphaPackageEnvelopeV1, PackageProfilePayloadV1 } from "../shared/host-extension-package-contract/decoder"
import type { PackageAdmissionPreviewV1 } from "../shared/package-admission"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { bundleOwner } from "./ext-package-ledger-v3"
import { findRecordV2, packageClaimOwners, readPackageGraphs, readPackageLedgerStateV1 } from "./ext-receipt-v2"
import { recoverExtensionTransactions, runExtensionTransaction, TX_CRASH_POINTS, type TxCrashPoint } from "./ext-transaction"
import { extensionHealthProbeRouter } from "./ext-health-probe-router"
import { commitTransactionLedger } from "./ext-package-ledger-commit"
import type { PackageArtifactRemovalV1 } from "./ext-package-uninstall"

const corpus = resolve(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.bundle.compiled.json",
)
const snapshotDigest = "9".repeat(64)

let tmp = ""
let root = ""
let userData = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "req128-698-update-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

/** live 配置里还有没有这个 mcp 叶 —— 「离场组件还能不能跑」的直接观测点。 */
const mcpConfigKeys = (): string[] => {
  const file = join(root, "alpha.jsonc")
  if (!existsSync(file)) return []
  return Object.keys((JSON.parse(readFileSync(file, "utf8")) as { mcp?: Record<string, unknown> }).mcp ?? {})
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const payloadBytes = (payload: PackageProfilePayloadV1): Uint8Array => utf8(`${JSON.stringify(payload, null, 2)}\n`)

type Corpus = { envelope: AlphaPackageEnvelopeV1; payloads: Record<string, PackageProfilePayloadV1> }

type Generation = {
  envelope: AlphaPackageEnvelopeV1
  payloadByDigest: Map<string, Uint8Array>
  assetByDigest: Map<string, Uint8Array>
}

const AGENT_V1 = "---\nname: generic-bundle-agent\ndescription: v1\n---\nsystem v1\n"
const AGENT_V2 = "---\nname: generic-bundle-agent\ndescription: v2\n---\nsystem v2\n"
const SKILL_MD = "---\nname: generic-bundle-skill\ndescription: leaf skill\n---\nbody\n"
const SKILL_NEW = "---\nname: generic-bundle-extra\ndescription: new leaf\n---\nbody\n"

/**
 * 从 producer 产物派生一代信封。`agentBody` 换内容 ⇒ root 的 payloadRef 变 ⇒ root manifestDigest 变
 * ⇒ **owner token 变**,这正是 update 最容易漏掉的一步。
 */
function generation(base: Corpus, options: { agentBody: string; keepMcp: boolean; addSkill: boolean; version?: string }): Generation {
  const envelope = structuredClone(base.envelope)
  if (options.version !== undefined) envelope.prelude = { ...envelope.prelude, version: options.version }
  const rootId = envelope.root
  const skillId = "skill:generic-bundle-skill"
  const mcpId = "mcp:generic-bundle-remote"
  const extraId = "skill:generic-bundle-extra"

  const assetByDigest = new Map<string, Uint8Array>()
  const payloadByDigest = new Map<string, Uint8Array>()

  const withAsset = (payload: PackageProfilePayloadV1, body: string, url: string): PackageProfilePayloadV1 => {
    const asset = utf8(body)
    assetByDigest.set(sha(asset), asset)
    const behavior = (payload as { behavior: Record<string, unknown> }).behavior
    return {
      ...payload,
      behavior: { ...behavior, asset: { bytes: asset.byteLength, mediaType: "text/markdown", sha256: sha(asset), url } },
    } as PackageProfilePayloadV1
  }

  const agentPayload = withAsset(
    structuredClone(base.payloads[rootId]!),
    options.agentBody,
    "https://alphacodeone.com/catalog/assets/agent.generic-bundle-agent/1.0.0/AGENT.md",
  )
  const skillPayload = withAsset(
    structuredClone(base.payloads[skillId]!),
    SKILL_MD,
    "https://alphacodeone.com/catalog/assets/skill.generic-bundle-skill/1.0.0/SKILL.md",
  )
  const extraPayload = withAsset(
    structuredClone(base.payloads[skillId]!),
    SKILL_NEW,
    "https://alphacodeone.com/catalog/assets/skill.generic-bundle-extra/1.0.0/SKILL.md",
  )
  const mcpPayload = structuredClone(base.payloads[mcpId]!)

  const refFor = (id: string, payload: PackageProfilePayloadV1, mediaProfile: string) => {
    const bytes = payloadBytes(payload)
    payloadByDigest.set(sha(bytes), bytes)
    return {
      sha256: sha(bytes),
      bytes: bytes.byteLength,
      mediaType: `application/vnd.alpha.host-extension-package.${mediaProfile}.v1+json`,
      url: `https://alphacodeone.com/catalog/assets/${id.replace(":", ".")}/1.0.0/alpha-package/payload.json`,
    }
  }

  const byId = new Map(envelope.components.map((component) => [component.id, structuredClone(component)]))
  const rootComponent = byId.get(rootId)!
  rootComponent.payloadRef = refFor(rootId, agentPayload, "agent")
  const skillComponent = byId.get(skillId)!
  skillComponent.payloadRef = refFor(skillId, skillPayload, "skill")
  const mcpComponent = byId.get(mcpId)!
  mcpComponent.payloadRef = refFor(mcpId, mcpPayload, "mcp-remote")
  const extraComponent = {
    ...structuredClone(skillComponent),
    id: extraId,
    required: false,
    payloadRef: refFor(extraId, extraPayload, "skill"),
  }

  const leaves = [
    skillComponent,
    ...(options.keepMcp ? [mcpComponent] : []),
    // 新增项刻意排在**最后**:只看数组前几位的实现要能被抓住。
    ...(options.addSkill ? [extraComponent] : []),
  ]
  rootComponent.dependencies = leaves.map((component) => component.id)
  envelope.components = [rootComponent, ...leaves]
  envelope.capabilities = [...new Set(envelope.components.flatMap((component) => component.capabilities))].sort()
  return { envelope, payloadByDigest, assetByDigest }
}

type AdmitOutcome = Awaited<ReturnType<ReturnType<typeof createPackageAdmissionCoordinator>>>

function coordinatorFor(
  generations: Generation[],
  removed: Array<Array<{ kind: string; name: string }>>,
  removalOutcome: () => PackageArtifactRemovalV1 = () => ({ ok: true, removed: [], warnings: [] }),
) {
  let index = 0
  const current = () => generations[Math.min(index, generations.length - 1)]!
  const admit = createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [current().envelope] },
      snapshotDigest,
    }),
    root: () => root,
    userDataPath: userData,
    environment: () => "dev",
    installability: {
      fetchPayload: async (ref) => current().payloadByDigest.get(ref.sha256)!,
    },
    fetchAsset: async (ref) => current().assetByDigest.get(ref.sha256)!,
    transaction: runExtensionTransaction,
    removePackageChildArtifacts: (children) => {
      removed.push(children.map((child) => ({ kind: child.kind, name: child.name })))
      return removalOutcome()
    },
  })
  return { admit, select: (next: number) => (index = next) }
}

const previewOf = (outcome: AdmitOutcome): PackageAdmissionPreviewV1 => {
  if (outcome.ok || !("packageAuthorization" in outcome)) throw new Error(`expected an authorization preview, got ${JSON.stringify(outcome).slice(0, 200)}`)
  return outcome.packageAuthorization
}

async function install(
  admit: ReturnType<typeof coordinatorFor>["admit"],
  attemptId: string,
  secrets?: Record<string, string>,
): Promise<{ preview: PackageAdmissionPreviewV1; result: AdmitOutcome }> {
  const catalogId = "package:generic-bundle"
  const intent = { catalogId, scope: { scope: "global" as const }, attemptId }
  const staged = await admit(intent)
  const preview = previewOf(staged)
  const result = await admit({
    ...intent,
    ...(secrets ? { grants: { secrets } } : {}),
    authorization: {
      confirmed: Object.fromEntries(preview.items.map((item) => [item.key, item.requested])),
      binding: preview.binding,
    },
  })
  return { preview, result }
}

const secretsFor = (generation: Generation): Record<string, string> => {
  const mcp = generation.envelope.components.find((component) => component.id === "mcp:generic-bundle-remote")
  if (!mcp) return {}
  const bytes = generation.payloadByDigest.get(mcp.payloadRef.sha256)!
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as { behavior: { requiredSecrets: string[] } }
  return Object.fromEntries(payload.behavior.requiredSecrets.map((name) => [`${mcp.id}#${name}`, "REQ128_698_SECRET_c4f1"]))
}

describe("REQ-128 #698 —— Bundle update 的生产路径", () => {
  test("add / remove / replace 一次跑完:owner token 转移、离场 child 去账并删实物、一次 root mutation", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    // `#764`:两代**版本号也不同**。版本是 update preview 里「你正在从哪个版本升上来」的唯一
    // 来源,而两代同版本会让「取到了真值」与「取到了写死的那个值」看起来一样。
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false, version: "1.0.0-req764a" })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: true, version: "2.0.0-req764b" })
    const removed: Array<Array<{ kind: string; name: string }>> = []
    const { admit, select } = coordinatorFor([v1, v2], removed)

    const first = await install(admit, "attempt-v1", secretsFor(v1))
    expect(first.result.ok, JSON.stringify(first.result).slice(0, 300)).toBe(true)
    const graphV1 = readPackageGraphs(root)[0]!
    expect([graphV1.root, ...graphV1.children].map((node) => node.componentId).sort()).toEqual([
      "agent:generic-bundle-agent",
      "mcp:generic-bundle-remote",
      "skill:generic-bundle-skill",
    ])
    const ownerV1 = bundleOwner("package:generic-bundle", graphV1.root.manifestDigest)
    expect(packageClaimOwners(root, "skill", "generic-bundle-skill")).toEqual([ownerV1])
    expect(findRecordV2(root, "mcp", "generic-bundle-remote")).not.toBeNull()
    // `#764`:v2 提交之后这条 record 会被覆盖成新版本,所以「装完 v1 时账上写的是什么」必须
    // 在这里取,不能等 update 跑完再回头读。
    const rootRecordVersionV1 = findRecordV2(root, "agent", "generic-bundle-agent")!.version

    // ── v2:root 换内容(replaced)、mcp 离场(removed)、多一个 skill(added)。
    select(1)
    const second = await install(admit, "attempt-v2")
    // preview 必须先把变化摆出来 —— 这是「update preview 显示 capability/prerequisite/claim 变化」。
    const update = second.preview.update
    expect(update.operation).toBe("update")
    expect(update.ownerChanged).toBe(true)
    // `#764`:「当前版本」必须是**真值**。账本从来没有 package 级记录 —— 它由这个包 root 组件的
    // v2 record 派生,而 `validateV3State` 保证图里每个节点都有 claim、每条 claim 都有 record,
    // 所以只要图在,root 的 record 就一定在。这里同时钉三条:
    //   ① 等于这一代信封声明的版本(不是任何写死的常量);
    //   ② 与账本里那条 record 逐字相同(派生点没有第二个答案);
    //   ③ 与 versionAfter 不同(否则「显示了旧版本」和「显示了新版本」分不开)。
    expect(update.versionBefore).toBe("1.0.0-req764a")
    expect(update.versionBefore).toBe(rootRecordVersionV1)
    expect(update.versionAfter).toBe("2.0.0-req764b")
    expect(update.versionBefore).not.toBe(update.versionAfter)
    expect(
      Object.fromEntries(update.components.map((component) => [`${component.kind}:${component.name}`, component.change])),
    ).toEqual({
      "agent:generic-bundle-agent": "replaced",
      "mcp:generic-bundle-remote": "removed",
      "skill:generic-bundle-extra": "added",
      "skill:generic-bundle-skill": "unchanged",
    })
    expect(update.claims).toEqual([
      { kind: "mcp", name: "generic-bundle-remote", decision: "delete", remainingOwners: [], reasonCode: null },
    ])
    expect(second.result.ok, JSON.stringify(second.result).slice(0, 300)).toBe(true)

    // 离场 child 的**config 叶**由事务自己删掉 —— 这是「它还能不能跑」的直接观测点。
    expect(mcpConfigKeys()).toEqual([])
    // 内容文件那一半经生产接缝清理了一次,而且只清它。
    expect(removed).toEqual([[{ kind: "mcp", name: "generic-bundle-remote" }]])

    // 账本:一张图、新 owner、旧 owner 一条不剩、离场 child 去账、新 child 进账。
    const graphs = readPackageGraphs(root)
    expect(graphs).toHaveLength(1) // 两版绝不同时激活
    const graphV2 = graphs[0]!
    const ownerV2 = bundleOwner("package:generic-bundle", graphV2.root.manifestDigest)
    expect(ownerV2).not.toBe(ownerV1)
    expect([graphV2.root, ...graphV2.children].map((node) => node.componentId).sort()).toEqual([
      "agent:generic-bundle-agent",
      "skill:generic-bundle-extra",
      "skill:generic-bundle-skill",
    ])
    expect(packageClaimOwners(root, "skill", "generic-bundle-skill")).toEqual([ownerV2])
    expect(packageClaimOwners(root, "agent", "generic-bundle-agent")).toEqual([ownerV2])
    expect(packageClaimOwners(root, "skill", "generic-bundle-extra")).toEqual([ownerV2])
    expect(packageClaimOwners(root, "mcp", "generic-bundle-remote")).toEqual([])
    expect(findRecordV2(root, "mcp", "generic-bundle-remote")).toBeNull()
    expect(findRecordV2(root, "skill", "generic-bundle-extra")).not.toBeNull()
    // 整本账仍自洽(dangling claim / 孤儿 owner / unknown child 任一存在都会让下一次写被拒)。
    const state = readPackageLedgerStateV1(root)
    expect(state.ok).toBe(true)
  }, 60_000)

  /**
   * 事务提交**之后**清理失败,是另一种语义:更新已经成功(账本 durable、config 叶已删除、
   * 离场组件再也加载不起来),留下的只是一份**惰性磁盘残留**,而不是一次失败。这里绝不能报
   * `ok:false` —— 那会让用户以为旧版本还在,而账本上是新的。
   *
   * **这份残留不会被自动重试。** 事务此刻已终态,恢复会跳过终态 journal,没有任何东西会去收它。
   * 用户可见面拿到的是一条具名 warning(由 hub 呈现),这就是全部补偿。
   */
  /**
   * R1 Blocker 1 的直接回归。**这条曾在 R1 的一次块替换里被我静默删掉**(替换区间的起点落在它
   * 前面一条用例上,把它一起吞了),而两轮审计都没抓到 —— 抓到它的是「改了生产判据却没有用例变红」
   * 的绕过实验。所以它现在的断言写成对**两个半场**都成立:
   *   · 文件清理接缝零调用(受 `result.ok` 那道判据保护);
   *   · 离场组件的 config 叶**原样还在**(受事务 before-image 回滚保护)。
   * 少任何一半,「更新失败 ⇒ 旧版本完好」都不成立。
   */
  test("事务失败 ⇒ 离场 child 一个字节都没被碰过(文件零调用 + config 叶原样)", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: true })
    const removed: Array<Array<{ kind: string; name: string }>> = []
    let failNextTransaction = false
    let index = 0
    const current = () => [v1, v2][Math.min(index, 1)]!
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [current().envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async (ref) => current().payloadByDigest.get(ref.sha256)! },
      fetchAsset: async (ref) => current().assetByDigest.get(ref.sha256)!,
      // 在**可回滚阶段**失败(lock 与 probe 同侧:都在 receipt commit 之前)。
      transaction: async (...args) =>
        failNextTransaction
          ? { ok: false as const, stage: "lock" as const, reason: "injected pre-commit failure", warnings: [] }
          : runExtensionTransaction(...args),
      removePackageChildArtifacts: (children) => {
        removed.push(children.map((child) => ({ kind: child.kind, name: child.name })))
        return { ok: true, removed: [], warnings: [] }
      },
    })

    expect((await install(admit, "attempt-v1", secretsFor(v1))).result.ok).toBe(true)
    const graphBefore = readPackageGraphs(root)
    index = 1
    failNextTransaction = true
    const second = await install(admit, "attempt-v2")

    expect(second.result.ok).toBe(false)
    // ① 文件清理接缝零调用。
    expect(removed).toEqual([])
    // ② 离场组件的 config 叶原样还在 ⇒ 旧版本仍然完整可跑。
    expect(mcpConfigKeys()).toEqual(["generic-bundle-remote"])
    // ③ 账本全旧。
    expect(readPackageGraphs(root)).toEqual(graphBefore)
    expect(findRecordV2(root, "mcp", "generic-bundle-remote")).not.toBeNull()
    expect(findRecordV2(root, "skill", "generic-bundle-extra")).toBeNull()
  }, 60_000)

  test("事务成功后清理失败 ⇒ 更新成功 + 具名 warning(离场组件已不可加载,剩下的是惰性残留)", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: true })
    const removed: Array<Array<{ kind: string; name: string }>> = []
    // 接缝被调用的**那一刻**,账本必须已经是新图 —— 这条断言钉住的正是「destroy 在 decide 之后」。
    const graphWhenCalled: string[] = []
    const { admit, select } = coordinatorFor([v1, v2], removed, () => {
      graphWhenCalled.push(readPackageGraphs(root)[0]?.installedGraphDigest ?? "<none>")
      return { ok: false, reason: "injected artifact removal failure", removed: [], warnings: [] }
    })

    expect((await install(admit, "attempt-v1", secretsFor(v1))).result.ok).toBe(true)
    select(1)
    const second = await install(admit, "attempt-v2")

    expect(second.result.ok, JSON.stringify(second.result).slice(0, 300)).toBe(true)
    if (!second.result.ok) return
    expect(second.result.warning).toContain("no longer active")
    expect(second.result.warning).toContain("nothing retries this automatically")
    // 账本是**新**版本,离场 child 已去账 —— 清理失败不回退这些。
    const graphs = readPackageGraphs(root)
    expect(graphs).toHaveLength(1)
    expect(findRecordV2(root, "mcp", "generic-bundle-remote")).toBeNull()
    expect(findRecordV2(root, "skill", "generic-bundle-extra")).not.toBeNull()
    // 接缝被调用时看到的就是这张新图(= 它跑在 mutation 之后)。
    expect(graphWhenCalled).toEqual([graphs[0]!.installedGraphDigest])
  }, 60_000)

  /**
   * BLOCKER 1 的**全量**形态:引擎每一个崩溃点各来一次。不变量只有一条 ——
   * **绝不出现「账本还是旧的、而离场 child 的实物已经被删」**。
   * 崩在 receipt commit 之前 ⇒ 零删除;越过之后 ⇒ 账本是新的。两者之外没有第三种合法盘面。
   */
  test.each(TX_CRASH_POINTS)("crash at %s:盘面恒「全旧且零删除」或「全新」,绝无中间态", async (point) => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: true })
    const removed: Array<Array<{ kind: string; name: string }>> = []
    let crashAt: TxCrashPoint | undefined
    let index = 0
    const current = () => [v1, v2][Math.min(index, 1)]!
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [current().envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async (ref) => current().payloadByDigest.get(ref.sha256)! },
      fetchAsset: async (ref) => current().assetByDigest.get(ref.sha256)!,
      transaction: (txRoot, plan, hooks) => runExtensionTransaction(txRoot, plan, { ...hooks, ...(crashAt ? { crashAt } : {}) }),
      removePackageChildArtifacts: (children) => {
        removed.push(children.map((child) => ({ kind: child.kind, name: child.name })))
        return { ok: true, removed: [], warnings: [] }
      },
    })

    expect((await install(admit, "attempt-v1", secretsFor(v1))).result.ok).toBe(true)
    const graphBefore = readPackageGraphs(root)
    index = 1
    crashAt = point
    await install(admit, `attempt-${point}`).catch(() => undefined)

    // 崩溃点之后的盘面**不是**终态判据 —— 引擎的合同是「**恢复之后**全旧或全新」。跑真实恢复,
    // 接缝与生产 `recoveryOpts` 同源(同一个 probe router、同一个 commitTransactionLedger)。
    // 不跑恢复就断言,等于把「journal 停在 switched」当成终局,那是对引擎合同的误读。
    const recovered = await recoverExtensionTransactions(root, {
      probe: extensionHealthProbeRouter(root),
      commitReceipt: (recs) => commitTransactionLedger(root, recs),
      // 崩溃注入**故意**不释放锁(进程猝死就是这样),但本进程还活着 ⇒ 生产恢复看到的是一把
      // 「持有者仍在跑」的锁,永远不会接管。把 pid 探活换成「都死了」,盘面才真的长成崩溃后的样子;
      // 收敛逻辑本身仍是生产的那一份(`#697` 的 wiring case 用改写 lock 文件 pid 达到同一效果)。
      pidAlive: () => false,
    })
    expect(recovered.ok, `crash ${point}: recovery itself failed`).toBe(true)

    const graphNow = readPackageGraphs(root)
    const ledgerIsOld = JSON.stringify(graphNow) === JSON.stringify(graphBefore)
    if (ledgerIsOld) {
      // 全旧 ⇒ 一次文件清理都不许发生,且离场组件的 config 叶必须还在(它还能跑 = 旧版本完好)。
      expect(removed, `crash ${point}: ledger is old but files were cleaned up`).toEqual([])
      expect(findRecordV2(root, "mcp", "generic-bundle-remote")).not.toBeNull()
      expect(mcpConfigKeys(), `crash ${point}: ledger is old but the departing config leaf is gone`).toEqual([
        "generic-bundle-remote",
      ])
    } else {
      // 全新 ⇒ 离场 child 已去账、config 叶已消失(两者同属一次事务)。
      expect(findRecordV2(root, "mcp", "generic-bundle-remote")).toBeNull()
      expect(mcpConfigKeys()).toEqual([])
    }
  }, 60_000)

  test("没有实物删除接缝而确实有 child 要离场 ⇒ 响亮拒绝(不装作删过)", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: false })
    let index = 0
    const current = () => [v1, v2][Math.min(index, 1)]!
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [current().envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async (ref) => current().payloadByDigest.get(ref.sha256)! },
      fetchAsset: async (ref) => current().assetByDigest.get(ref.sha256)!,
      transaction: runExtensionTransaction,
      // removePackageChildArtifacts 故意不传。
    })
    expect((await install(admit, "attempt-v1", secretsFor(v1))).result.ok).toBe(true)
    index = 1
    const second = await install(admit, "attempt-v2")
    expect(second.result.ok).toBe(false)
    if (!second.result.ok) expect(second.result.reason).toContain("no artifact-removal seam is wired")
    expect(findRecordV2(root, "mcp", "generic-bundle-remote")).not.toBeNull()
  }, 60_000)

  test("首装的 preview:operation=install、每一行都是 added、claim 变化为空", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const { admit } = coordinatorFor([v1], [])
    const staged = await admit({ catalogId: "package:generic-bundle", scope: { scope: "global" as const }, attemptId: "attempt-fresh" })
    const preview = previewOf(staged)
    expect(preview.update.operation).toBe("install")
    expect(preview.update.graphBeforeDigest).toBeNull()
    // `#764`:首装**没有**「当前版本」,所以这里必须是 null 而 versionAfter 有值。它与上面
    // update 用例里「versionBefore 恰是上一代那个版本」互为反例:一个写死的常量满足不了两边。
    expect(preview.update.versionBefore).toBeNull()
    expect(preview.update.versionAfter).toBe("1.0.0")
    expect(preview.update.components.every((component) => component.change === "added")).toBe(true)
    expect(preview.update.claims).toEqual([])
    // 首装没有已提交的授权账 ⇒ 每个组件都是「从无到有」,必须重新授权。
    expect(preview.update.capabilityExpansion).toBe(preview.items.some((item) => item.added.length > 0))
  }, 60_000)

  test("另一个包已经拥有同名 child 且 digest 不同 ⇒ 计划期拒(零事务调用)", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    // 先把 v1 装上,再把它的 packageId 换个名字重装 —— 第二个包会与第一个争同一批 child,
    // 而 root 内容不同 ⇒ digest 不同 ⇒ 冲突。
    const { admit } = coordinatorFor([v1], [])
    expect((await install(admit, "attempt-v1", secretsFor(v1))).result.ok).toBe(true)

    const rival = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: false })
    rival.envelope.prelude = { ...rival.envelope.prelude, packageId: "package:rival-bundle" }
    let transactionCalls = 0
    const rivalAdmit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [rival.envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async (ref) => rival.payloadByDigest.get(ref.sha256)! },
      fetchAsset: async (ref) => rival.assetByDigest.get(ref.sha256)!,
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const staged = await rivalAdmit({
      catalogId: "package:rival-bundle",
      scope: { scope: "global" as const },
      attemptId: "attempt-rival",
    })
    expect(staged.ok).toBe(false)
    if (!staged.ok) {
      expect(staged.reason).toContain("package-child-conflict")
      expect(staged.reason).toContain("package:generic-bundle")
    }
    // 计划期拒 = 用户还没看到确认屏就被挡下,事务一次都没跑。
    expect(transactionCalls).toBe(0)
    expect(readPackageGraphs(root).map((graph) => graph.packageId)).toEqual(["package:generic-bundle"])
  }, 60_000)
})

/** `#698` 之前的形状留个证:v1 的实物落在受控根内(agent md / skill 目录),不是凭空断言。 */
test("REQ-128 #698 —— 夹具自证:v1 安装确实在盘上留下了 agent 与 skill 实物", async () => {
  const base = (await Bun.file(corpus).json()) as Corpus
  const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: false, addSkill: false })
  const { admit } = coordinatorFor([v1], [])
  expect((await install(admit, "attempt-materialise")).result.ok).toBe(true)
  expect(existsSync(join(root, "agents", "generic-bundle-agent.md"))).toBe(true)
  expect(existsSync(join(root, "ext-store", "skill--generic-bundle-skill"))).toBe(true)
}, 60_000)

// ── R2 Blocker 1 的根因闸:**走真实生产删除接缝**,而不是注入的假 seam ────────────────────────
//
// Blocker 1 之所以逃掉,是因为 update 的用例全部注入假 seam:真实接缝对 Agent/MCP 会取
// `withConfigWriteLock`,而它与事务共用同一把**非重入**的 root bundle 锁 —— 放在事务里必然失败。
// 下面两条**持着那把锁**跑真实生产函数,一正一负:
//   · update 用的 files-only 接缝必须成功(它按构造不碰配置);
//   · 整包卸载用的完整接缝必须**失败**,失败理由点名 config busy。
// 后者是前者的区分度证明:没有它,「files-only 能过」可能只是因为这把锁根本不起作用。

import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { removeFsInstall, removeFsInstallFilesOnly } from "./ext-fs-installer"
import { removeInstallGrants } from "./ext-install-planner"
import { removePackageChildArtifactsV1, type PackageArtifactInstallersV1 } from "./ext-package-uninstall"
import { removeMcpConfigInLock, withConfigWriteLock } from "./ext-config"
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs"

/** 生产接线的两个变体,与 `ext-ipc.ts` 逐字同源(只是这里不需要 userDataPath 相关的两条)。 */
const productionInstallers = (): PackageArtifactInstallersV1 => ({
  removeFsInstall,
  removeMcpConfig: (name) => withConfigWriteLock(() => removeMcpConfigInLock(name)),
  removeMcpSecretsStrict: () => ({ ok: true as const }),
  releaseAlphaConnectionBindings: () => ({ ok: true as const }),
  removeInstallGrants,
})

function materialiseDepartingAgent(): void {
  mkdirSync2(join(root, "agents"), { recursive: true })
  writeFileSync2(join(root, "agents", "departing-agent.md"), "---\ndescription: d\n---\nsys")
}

test("R2 Blocker 1:持 root bundle 锁时,update 的 files-only 生产接缝必须成功(结构上碰不到配置锁)", () => {
  materialiseDepartingAgent()
  const held = tryAcquireBundleLock(root, { txId: "probe-files-only" })
  expect(held.ok).toBe(true)
  if (!held.ok) return
  try {
    const outcome = removePackageChildArtifactsV1(
      root,
      [{ kind: "agent", name: "departing-agent" }],
      { ...productionInstallers(), removeFsInstall: removeFsInstallFilesOnly },
      { skipConfig: true },
    )
    expect(outcome.ok, JSON.stringify(outcome).slice(0, 300)).toBe(true)
    expect(existsSync(join(root, "agents", "departing-agent.md"))).toBe(false)
  } finally {
    held.lock.release()
  }
})

test("R2 Blocker 1 的区分度:同一把锁下,整包卸载用的**完整**接缝会因 config busy 失败", () => {
  materialiseDepartingAgent()
  const held = tryAcquireBundleLock(root, { txId: "probe-full-seam" })
  expect(held.ok).toBe(true)
  if (!held.ok) return
  try {
    const outcome = removePackageChildArtifactsV1(root, [{ kind: "agent", name: "departing-agent" }], productionInstallers())
    // 这正是 R1 那版把删除搬进 commitReceipt 之后会发生的事 —— 而当时它被 warning 吞掉、报成功。
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("busy")
  } finally {
    held.lock.release()
  }
})
