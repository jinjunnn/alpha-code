// ext-package-lifecycle — REQ-128 `#698`(已批基线 §2.9)。
//
// `#706` 给了账本「这个 package 由哪些组件组成、每个组件归谁所有」的表示;`#697` 让一次安装把
// 整张图装进一次事务。剩下的两件事都发生在**第二次**:改版本(update)与卸载(uninstall)。
// 它们共用同一个问题 —— 「这张图变成那张图,谁该被删、谁必须留下」。本模块只回答这个问题,
// 而且只用**exact digest** 回答:不解 semver、不猜「差不多是同一个东西」。
//
// 为什么这一层必须是纯的:update/uninstall 的每一条判决都要在**动任何实物之前**做完
// (`#706` R2 Blocker 的形状:先删实物再问账本 ⇒ repository 拒绝时东西已经没了)。判决与执行
// 分开,判决才能被单测穷举,也才能在执行前被 repository 复核一次。
//
// 三条不许在这里发生的事:
//   · 不解 semver —— 版本只当不透明字符串比较是否相等;「新旧」由用户在目录里选,不由这里推断。
//   · 不猜身份 —— 一个 child 的身份是 `(kind, name)`,即账本 record 与 claim 的键;componentId
//     变了而 (kind,name) 没变 = **replaced**(同一个位置换了内容),不是新增+删除。
//   · 不做自动 GC —— 「删」永远只发生在「本 package 释放后 owner 集合空 + 有 v2 record(managed)」
//     这一格。legacy-protected 与 unmanaged 存量落在 owner 非空 / 非 managed 两支上,结构上到不了删。

import type { InstallReceiptType } from "../preload/types"
import { agentInstallKey } from "./ext-agent-install"
import { skillGenerationKey } from "./ext-skill-generations"
import {
  bundleOwner,
  findClaim,
  parseOwnerToken,
  LEGACY_PROTECTED_OWNER,
  type ClaimMutationV1,
  type PackageClaimV1,
  type PackageGraphNodeV1,
  type PackageGraphV1,
} from "./ext-package-ledger-v3"

/** 一个 child 在事务 / 授权账里的 key。**唯一**派生点 —— `package-admission` 与本模块共用,
 *  否则「安装时用的 key」与「卸载时清授权账用的 key」会各算各的,而偏差只在卸载后现身。 */
export function packageChildTxKeyV1(kind: "skill" | "agent" | "mcp", name: string): string {
  return kind === "skill" ? skillGenerationKey(name) : kind === "agent" ? agentInstallKey(name) : `mcp--${name}`
}

export type PackageChildIdentityV1 = { kind: InstallReceiptType; name: string }

export type PackageGraphChangeKindV1 = "added" | "removed" | "replaced" | "optional-changed" | "unchanged"

/** 一个 `(kind,name)` 位置在两代图之间发生了什么。判据全是 exact 值:
 *  · `replaced` = manifestDigest 或 componentId 变了(同一个位置换了内容 / 换了组件身份);
 *  · `optional-changed` = 内容逐字未变,只有 `required` 翻转;
 *  · `unchanged` = 三者全同。 */
export type PackageGraphChangeV1 = {
  kind: InstallReceiptType
  name: string
  change: PackageGraphChangeKindV1
  before: PackageGraphNodeV1 | null
  after: PackageGraphNodeV1 | null
}

export type PackageGraphDiffV1 = {
  packageId: string
  /** 前一代的 owner token(首次安装为 null)。 */
  ownerBefore: string | null
  ownerAfter: string
  /** root 的 manifestDigest 变了 ⇒ owner token 变了 ⇒ **每个**留下来的 child 都要换 owner。 */
  ownerChanged: boolean
  envelopeChanged: boolean
  versionBefore: string | null
  versionAfter: string | null
  /** 按 `${kind}:${name}` 排序,含 unchanged —— 「没变」也是 preview 要说的事实。 */
  changes: PackageGraphChangeV1[]
}

const identityKey = (kind: string, name: string) => `${kind}:${name}`
const byIdentity = (left: PackageGraphChangeV1, right: PackageGraphChangeV1) => {
  const a = identityKey(left.kind, left.name)
  const b = identityKey(right.kind, right.name)
  return a < b ? -1 : a > b ? 1 : 0
}

const nodesOf = (graph: PackageGraphV1): PackageGraphNodeV1[] => [graph.root, ...graph.children]

export type PackageGraphDiffResultV1 = { ok: true; diff: PackageGraphDiffV1 } | { ok: false; reason: string }

/**
 * 两代**有效安装图**的 exact diff。
 *
 * `before` 为 null = 首次安装(全部 added)。两张图的 packageId 不同 = 调用方拿错了图 ——
 * 响亮失败,绝不「按位置对齐」硬算:那会让 A 包的 child 被当成 B 包的 child 删掉。
 */
export function diffPackageGraphsV1(
  before: PackageGraphV1 | null,
  after: PackageGraphV1,
  versions: { before?: string | null; after?: string | null } = {},
): PackageGraphDiffResultV1 {
  if (before && before.packageId !== after.packageId)
    return {
      ok: false,
      reason: `package graph diff: before graph is "${before.packageId}" but after graph is "${after.packageId}" — refusing (graph mismatch)`,
    }
  const beforeNodes = new Map<string, PackageGraphNodeV1>()
  if (before)
    for (const node of nodesOf(before)) {
      const k = identityKey(node.kind, node.name)
      // 图解码器已拒重复 (kind,name);这里再挡一次,因为 diff 之后就没人再看得见重复了。
      if (beforeNodes.has(k)) return { ok: false, reason: `package graph diff: before graph names ${k} twice — refusing` }
      beforeNodes.set(k, node)
    }
  const afterNodes = new Map<string, PackageGraphNodeV1>()
  for (const node of nodesOf(after)) {
    const k = identityKey(node.kind, node.name)
    if (afterNodes.has(k)) return { ok: false, reason: `package graph diff: after graph names ${k} twice — refusing` }
    afterNodes.set(k, node)
  }

  const changes: PackageGraphChangeV1[] = []
  for (const [k, node] of afterNodes) {
    const prev = beforeNodes.get(k)
    if (!prev) {
      changes.push({ kind: node.kind, name: node.name, change: "added", before: null, after: node })
      continue
    }
    const change: PackageGraphChangeKindV1 =
      prev.manifestDigest !== node.manifestDigest || prev.componentId !== node.componentId
        ? "replaced"
        : prev.required !== node.required
          ? "optional-changed"
          : "unchanged"
    changes.push({ kind: node.kind, name: node.name, change, before: prev, after: node })
  }
  for (const [k, node] of beforeNodes)
    if (!afterNodes.has(k)) changes.push({ kind: node.kind, name: node.name, change: "removed", before: node, after: null })

  const ownerBefore = before ? bundleOwner(before.packageId, before.root.manifestDigest) : null
  const ownerAfter = bundleOwner(after.packageId, after.root.manifestDigest)
  return {
    ok: true,
    diff: {
      packageId: after.packageId,
      ownerBefore,
      ownerAfter,
      ownerChanged: ownerBefore !== null && ownerBefore !== ownerAfter,
      envelopeChanged: before ? before.envelopeDigest !== after.envelopeDigest : true,
      versionBefore: versions.before ?? null,
      versionAfter: versions.after ?? null,
      changes: changes.sort(byIdentity),
    },
  }
}

/**
 * REQ-128 `#764`:一个**已安装** package 当前落在账本上的版本。
 *
 * 账本里没有 package 级的版本存储,也不需要有:安装时 `package-admission` 把信封 prelude 的
 * 同一个 version 写进这个包**每一个**组件的 v2 record,而 root 组件的 `(kind, name)` 由图给出。
 * 于是「当前版本」是一次查表,不是第二份真源 —— 多存一份就多一个会和 record 分叉的答案。
 *
 * root 的 record **必然在场**:`validateV3State` 要求图里每个节点都有 claim、每条 claim 都有
 * install record,而账本的读与写两侧都跑这条判据。因此返回 null 只有一个含义 —— 那一代信封
 * 本来就没声明版本(`version` 是信封里的可选字段),不是「查不到」。
 */
export function packageVersionFromRecordsV1(
  graph: PackageGraphV1,
  records: ReadonlyArray<{ kind: string; name: string; version?: string }>,
): string | null {
  return records.find((record) => record.kind === graph.root.kind && record.name === graph.root.name)?.version ?? null
}

/** 卸载 = 「after 图为空」的 diff。同一份代数,不另写一套 —— 两套会各自漂移。 */
export function uninstallDiffV1(graph: PackageGraphV1, version?: string | null): PackageGraphDiffV1 {
  const owner = bundleOwner(graph.packageId, graph.root.manifestDigest)
  return {
    packageId: graph.packageId,
    ownerBefore: owner,
    ownerAfter: owner,
    ownerChanged: false,
    envelopeChanged: true,
    versionBefore: version ?? null,
    versionAfter: null,
    changes: nodesOf(graph)
      .map((node) => ({ kind: node.kind, name: node.name, change: "removed" as const, before: node, after: null }))
      .sort(byIdentity),
  }
}

/**
 * claim 转移。**释放全部在前,获取全部在后** —— `applyPackageMutation` 按数组顺序施加集合代数,
 * 反过来写就会把刚获取的 owner 立刻释放掉(owner token 不变时 release/acquire 作用在同一格)。
 *
 * 规则只有两条,不分支:
 *   · before 图里的每个节点,释放 `ownerBefore`;
 *   · after 图里的每个节点,获取 `ownerAfter`。
 * owner 未变且节点未变时两者相消 —— 净效果为零,而不是「聪明地跳过」。跳过是第二套规则。
 */
export function planPackageClaimTransferV1(diff: PackageGraphDiffV1): ClaimMutationV1[] {
  const releases: ClaimMutationV1[] = []
  const acquires: ClaimMutationV1[] = []
  for (const change of diff.changes) {
    if (change.before && diff.ownerBefore)
      releases.push({ op: "release", kind: change.kind, name: change.name, owner: diff.ownerBefore })
    if (change.after) acquires.push({ op: "acquire", kind: change.kind, name: change.name, owner: diff.ownerAfter })
  }
  return [...releases, ...acquires]
}

export type PackageChildRemovalVerdictV1 = {
  kind: InstallReceiptType
  name: string
  /** `delete` = 实物 + record + claim 一起走;`retain` = 一件都不动,只把本 package 的 owner 释放掉。 */
  decision: "delete" | "retain"
  /** 释放本 package 的 owner 之后还剩谁。`delete` 一支恒为空。 */
  remainingOwners: string[]
  /** `retain` 的具名理由(用户可见:为什么这个东西没跟着包一起消失)。 */
  reasonCode: "shared-with-package" | "user-installed" | "legacy-protected" | "unmanaged" | null
}

/**
 * 离开本 package 的 child 该不该删。三条判据全部成立才删(基线 §2.9,票面 Development plan 4):
 *
 *   ① **owner set 空** —— 释放本 package 的 owner 之后没有别人了;
 *   ② **managed** —— 账本里有它的 v2 record(main 知道它是什么、知道怎么删);
 *   ③ **无 legacy protection** —— `legacy-protected` 是 V3 之前的存量,身份不确定,永不自动回收。
 *
 * ③ 在集合上是 ① 的子情形(legacy-protected 留在 owner set 里 ⇒ 非空),但它单独出一个 reasonCode:
 * 「还有别的包在用」与「这是台机器上原来就有的东西」对用户是两句话,合并成一句就没人看得懂。
 */
export function planPackageChildRemovalsV1(input: {
  departing: ReadonlyArray<PackageChildIdentityV1>
  ownerBefore: string
  claims: readonly PackageClaimV1[]
  /** 账本里存在 v2 record 的 `${kind}:${name}` 集合(managed 的判据)。 */
  recordKeys: ReadonlySet<string>
}): PackageChildRemovalVerdictV1[] {
  return input.departing
    .map((child) => {
      const claim = findClaim(input.claims, child.kind, child.name)
      const remainingOwners = (claim?.owners ?? []).filter((owner) => owner !== input.ownerBefore).sort()
      if (remainingOwners.length > 0) {
        const hasBundle = remainingOwners.some((owner) => parseOwnerToken(owner)?.kind === "bundle")
        const hasLegacy = remainingOwners.includes(LEGACY_PROTECTED_OWNER)
        return {
          kind: child.kind,
          name: child.name,
          decision: "retain" as const,
          remainingOwners,
          reasonCode: hasBundle ? ("shared-with-package" as const) : hasLegacy ? ("legacy-protected" as const) : ("user-installed" as const),
        }
      }
      if (!input.recordKeys.has(identityKey(child.kind, child.name)))
        return { kind: child.kind, name: child.name, decision: "retain" as const, remainingOwners, reasonCode: "unmanaged" as const }
      return { kind: child.kind, name: child.name, decision: "delete" as const, remainingOwners, reasonCode: null }
    })
    .sort((left, right) => {
      const a = identityKey(left.kind, left.name)
      const b = identityKey(right.kind, right.name)
      return a < b ? -1 : a > b ? 1 : 0
    })
}

export type PackageChildConflictV1 = {
  kind: InstallReceiptType
  name: string
  /** 已经拥有这个 child 的**另一个** package。 */
  holderPackageId: string
  holderDigest: string
  candidateDigest: string
}

/**
 * 计划期的 exact digest 冲突闸(票面 Development plan 6)。
 *
 * 两个 Bundle 共享同一个 child 是**允许的**(canonical permutation:Bundle A/B 共享 child)——
 * 条件是两边指的是**逐字同一件东西**(同 manifestDigest)。digest 不同 = 装第二个会覆盖第一个的
 * 内容,而第一个的图仍然指着旧 digest ⇒ 那张图从此对不上盘面。这必须在计划期拒,不是在写盘期
 * 才被 `validateV3State` 以一句「graph mismatch」拦下 —— 那时用户已经点过确认了。
 *
 * 同一个 packageId 的旧图**不算冲突**:那是 update,由 diff 处理(一个 packageId 只有一张图,
 * 所以「两版同时激活」在账本结构上就不可能 —— `validateV3State` 拒重复 packageId)。
 */
export function planPackageChildConflictsV1(input: {
  graphs: readonly PackageGraphV1[]
  candidate: PackageGraphV1
}): PackageChildConflictV1[] {
  const conflicts: PackageChildConflictV1[] = []
  for (const node of nodesOf(input.candidate))
    for (const graph of input.graphs) {
      if (graph.packageId === input.candidate.packageId) continue
      const held = nodesOf(graph).find((other) => other.kind === node.kind && other.name === node.name)
      if (!held || held.manifestDigest === node.manifestDigest) continue
      conflicts.push({
        kind: node.kind,
        name: node.name,
        holderPackageId: graph.packageId,
        holderDigest: held.manifestDigest,
        candidateDigest: node.manifestDigest,
      })
    }
  return conflicts.sort((left, right) => {
    const a = `${identityKey(left.kind, left.name)}\u0000${left.holderPackageId}`
    const b = `${identityKey(right.kind, right.name)}\u0000${right.holderPackageId}`
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** preview 里逐组件的一行。capability 那一栏来自**已提交的授权账**(grants.json),不是来自图 ——
 *  图不存 capability,而「这次要不要重新授权」的真源本来就是授权账(`ext-capability-grants`)。 */
export type PackageUpdateComponentV1 = {
  componentId: string | null
  kind: InstallReceiptType
  name: string
  key: string
  change: PackageGraphChangeKindV1
  requiredBefore: boolean | null
  requiredAfter: boolean | null
  /** 本次会被采集的前置(after 侧;removed 组件为空 —— 它不会再被采集)。 */
  prerequisiteIds: string[]
  capabilities: { previous: string[] | null; requested: string[]; added: string[]; removed: string[] }
}

export type PackageUpdatePreviewV1 = {
  operation: "install" | "update" | "uninstall"
  packageId: string
  versionBefore: string | null
  versionAfter: string | null
  graphBeforeDigest: string | null
  graphAfterDigest: string | null
  ownerChanged: boolean
  components: PackageUpdateComponentV1[]
  claims: PackageChildRemovalVerdictV1[]
  /** 任何一个组件相对**已提交授权账**新增了 capability ⇒ 必须重新授权。 */
  capabilityExpansion: boolean
}

/**
 * update/uninstall 的 preview 主体(票面 Development plan 2)。
 *
 * 「扩大能力必须重授权」在本仓的实现不是一个新开关:`evaluateBundleAuthorization` 每次都拿
 * **已提交的** grants.json 与本次请求集做 diff,`requiresConfirmation` 为真就得重新确认,而 package
 * admission 的每一次尝试本来就必过 authorize 阶段。本函数做的是把那份 diff **摆到 update 语境里**——
 * 用户看到的是「这次更新新增了哪些能力」,而不是一串与「更新」无关的 diff 行。
 */
export function buildPackageUpdatePreviewV1(input: {
  diff: PackageGraphDiffV1
  graphBeforeDigest: string | null
  graphAfterDigest: string | null
  claims: PackageChildRemovalVerdictV1[]
  /** 逐组件 after 侧前置 id(key → prerequisiteIds);removed 组件不在表内。 */
  prerequisiteIdsByKey: ReadonlyMap<string, string[]>
  /** 逐组件 capability diff(key → 已提交授权账 vs 本次请求集)。 */
  capabilityDiffByKey: ReadonlyMap<string, { previous: string[] | null; requested: string[]; added: string[]; removed: string[] }>
}): PackageUpdatePreviewV1 {
  const components = input.diff.changes.map((change) => {
    const node = change.after ?? change.before!
    const key = packageChildTxKeyV1(node.kind as "skill" | "agent" | "mcp", node.name)
    const capabilities = input.capabilityDiffByKey.get(key) ?? { previous: null, requested: [], added: [], removed: [] }
    return {
      componentId: change.after?.componentId ?? change.before?.componentId ?? null,
      kind: change.kind,
      name: change.name,
      key,
      change: change.change,
      requiredBefore: change.before?.required ?? null,
      requiredAfter: change.after?.required ?? null,
      prerequisiteIds: [...(input.prerequisiteIdsByKey.get(key) ?? [])].sort(),
      capabilities,
    }
  })
  return {
    operation: input.graphAfterDigest === null ? "uninstall" : input.graphBeforeDigest === null ? "install" : "update",
    packageId: input.diff.packageId,
    versionBefore: input.diff.versionBefore,
    versionAfter: input.diff.versionAfter,
    graphBeforeDigest: input.graphBeforeDigest,
    graphAfterDigest: input.graphAfterDigest,
    ownerChanged: input.diff.ownerChanged,
    components,
    claims: input.claims,
    capabilityExpansion: components.some((component) => component.capabilities.added.length > 0),
  }
}
