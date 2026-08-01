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
import { mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AlphaPackageEnvelopeV1, PackageProfilePayloadV1 } from "../shared/host-extension-package-contract/decoder"
import type { PackageAdmissionPreviewV1 } from "../shared/package-admission"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { bundleOwner } from "./ext-package-ledger-v3"
import { findRecordV2, packageClaimOwners, readPackageGraphs, readPackageLedgerStateV1 } from "./ext-receipt-v2"
import { runExtensionTransaction } from "./ext-transaction"
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
function generation(base: Corpus, options: { agentBody: string; keepMcp: boolean; addSkill: boolean }): Generation {
  const envelope = structuredClone(base.envelope)
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
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: true })
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

    // ── v2:root 换内容(replaced)、mcp 离场(removed)、多一个 skill(added)。
    select(1)
    const second = await install(admit, "attempt-v2")
    // preview 必须先把变化摆出来 —— 这是「update preview 显示 capability/prerequisite/claim 变化」。
    const update = second.preview.update
    expect(update.operation).toBe("update")
    expect(update.ownerChanged).toBe(true)
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

    // 离场 child 的实物**真的**经生产接缝删了一次,而且只删它。
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

  test("离场 child 的实物删不掉 ⇒ 整次更新失败,账本停在旧版本(全旧)", async () => {
    const base = (await Bun.file(corpus).json()) as Corpus
    const v1 = generation(base, { agentBody: AGENT_V1, keepMcp: true, addSkill: false })
    const v2 = generation(base, { agentBody: AGENT_V2, keepMcp: false, addSkill: true })
    const removed: Array<Array<{ kind: string; name: string }>> = []
    const { admit, select } = coordinatorFor([v1, v2], removed, () => ({
      ok: false,
      reason: "injected artifact removal failure",
      removed: [],
      warnings: [],
    }))

    expect((await install(admit, "attempt-v1", secretsFor(v1))).result.ok).toBe(true)
    const graphBefore = readPackageGraphs(root)

    select(1)
    const second = await install(admit, "attempt-v2")
    expect(second.result.ok).toBe(false)
    if (!second.result.ok) expect(second.result.reason).toContain("the ledger is unchanged")
    // 全旧:图、claim、record 一律停在 v1;新组件没进账。
    expect(readPackageGraphs(root)).toEqual(graphBefore)
    expect(findRecordV2(root, "mcp", "generic-bundle-remote")).not.toBeNull()
    expect(findRecordV2(root, "skill", "generic-bundle-extra")).toBeNull()
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
