// Package ledger envelope V3 — REQ-128 `#706`(已批基线 §2.9)。
//
// V2 的账本回答「装了什么」。V3 多回答两个问题:
//   · **这个 package 由哪些组件组成**(`packageGraphs`)—— root + leaf 的一张扁平图;
//   · **每个组件现在归谁所有**(`claims`)—— owner **集合**,不是可漂移的整数 refcount。
//
// 为什么是 owner 集合而不是 refcount:refcount 只要有一次漏加/漏减就永久错位,且错位之后
// 无法自证;owner 集合每个元素都能指名道姓(哪个 Bundle、还是用户自己装的、还是 V2 时代的
// 存量),refcount 由集合大小派生,不独立存储也就不会漂移。
//
// owner token 三种,穷举(基线 §2.9):
//   · `standalone:<kind>:<name>` —— 用户自己单装的
//   · `bundle:<packageId>@<manifestDigest>` —— 某个 exact 版本的 package 装的
//   · `legacy-protected`          —— V3 之前就在账本里的存量。**不猜**它是不是历史 Bundle 的
//                                    一部分,所以它永远不被自动回收。
//
// 本模块是**纯**的:只有类型、严格解码器与集合代数,零 fs、零 electron。账本文件的读写
// 仍然只有 `ext-receipt-v2.ts` 一个物理写器(V3 落地时同时删掉了第二个物理写器
// `alpha-installs.writeLedger` 的全部生产调用)。

import { isExtensionName } from "../shared/extension-name"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import type { InstallReceiptType } from "../preload/types"
import type { UpsertInput } from "./ext-receipt-v2"

/** V3 信封版本号。`v: 3` 的账本对只懂 V2 的构建是「读不懂的数据」——
 *  `ext-receipt-v2.parseLedger` 早已对 v ∉ {1,2} 拒触碰,所以 downgrade 天然 fail-closed。 */
export const PACKAGE_LEDGER_ENVELOPE_VERSION = 3 as const

/** V3 图/claim 里允许出现的 child kind。与 `ext-receipt-v2` 的 record kind 集必须逐字相等 ——
 *  由 `ext-package-ledger-v3.test.ts` 对着导出的 `RECORD_KINDS` 双向断言(少一个 = 该 kind
 *  的 child 无法被 claim 保护;多一个 = claim 指向一个不可能存在的 record)。 */
export const PACKAGE_LEDGER_KINDS = new Set<string>(["mcp", "skill", "agent", "command", "plugin", "bundle", "cloud"])

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
/**
 * package id 与组件 id 的文法。真源是宿主合同 schema
 * `alpha-package-envelope-v1.schema.json`(`prelude.packageId.pattern`,组件 `id` 同 pattern),
 * 它与 `decoder.ts` 一起被钉进跨仓 artifact —— 本票不得改动那些字节,所以这里只能带一份副本。
 *
 * 副本 = 替别人写文法,是本仓最贵的返工形态。因此 `ext-package-ledger-v3.test.ts` 用**两条
 * 互相独立的轴**盯住它:①逐字比对 schema 里的 pattern 字符串;②把同一组 id 同时喂给真 decoder
 * 与本正则,断言接受/拒绝逐条一致。任一轴不合 = 红。
 */
export const PACKAGE_ID_RE = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$/
/** 组件 id 与 package id 同文法。 */
const COMPONENT_ID_RE = PACKAGE_ID_RE
const LEGACY_PROTECTED = "legacy-protected"

export type PackageChildRefV1 = { kind: InstallReceiptType; name: string }

export type PackageGraphNodeV1 = {
  /** envelope 组件 id(`<profile>:<name>` 形态;本层只做文法校验,不解释语义)。 */
  componentId: string
  kind: InstallReceiptType
  name: string
  required: boolean
  manifestDigest: string
}

/** 一个 package 的**已安装图**:root 一个、leaf 若干(本期 leaf 恒空,`#697` 起非空)。
 *  `installedGraphDigest` 覆盖 packageId + envelopeDigest + root + children,是 preview / 重验 /
 *  claim mutation 三者共用的绑定值(篡改任一节点 → digest 不符 → 响亮失败)。
 *
 *  `#758`:这个名字里的 `installed` 是承重的。授权侧另有一个
 *  `PackageAdmissionBindingV1.graphDigest`(`shared/package-admission.ts`),它覆盖的是安装**前**
 *  由信封声明的**计划**安装图 —— 输入集不同(那边是 componentId/profileId/profileVersion/
 *  payloadSha256,这边是 componentId/kind/name/required/manifestDigest),连字面格式都不同
 *  (那边裸 hex,这边带 `sha256:` 前缀)。**两者恒不相等,也不该相等。**
 *  可执行判据:`test-component/package-admission.wiring.cases.ts` 在同一次真实安装里同时取两个值。 */
export type PackageGraphV1 = {
  packageId: string
  envelopeDigest: string
  installedGraphDigest: string
  root: PackageGraphNodeV1
  children: PackageGraphNodeV1[]
}

// REQ-128 `#764`:这里**没有** package 级记录类型,这是一个决定,不是遗漏。
//
// 曾经有过一个 `PackageRecordV1{packageId, envelopeDigest, installedGraphDigest, version, transactionId,
// installedAt}`。它每一个字段都是别处已有事实的抄本:前三个由 `PackageGraphV1` 持有(一个
// packageId 只有一张图,`validateV3State` 拒重复),`version` 与 `installedAt` 由这个包**每一个**
// 组件的 v2 record 持有(`package-admission` 写的是同一个信封 prelude version),`transactionId`
// 与 `PackageLedgerMutationV1.transactionId` 逐字相同。它从未被 `writeLedgerFile` 落过盘,也没有
// 任何消费方读它 —— 唯一"用"它的地方是拿它判 install/update 还是 uninstall,而 `graphAfter`
// 回答的是同一个问题。
//
// 抄本不是冗余保险,是第二个会漂移的答案:它一旦落盘,「这个包是哪个版本」就有两处可查,
// 而两处不一致时没有任何判据说哪一处对。所以「当前版本」由 root 组件的 record 派生
// (`packageVersionFromRecordsV1`),不另存一份。

/** 一个 child 的 owner 集合。`owners` 排序去重且**非空** —— 空集不是「没人要」,
 *  空集根本不该落盘(该删 claim 了)。 */
export type PackageClaimV1 = {
  kind: InstallReceiptType
  name: string
  owners: string[]
}

export type ChildRecordMutationV1 =
  | { op: "upsert"; input: UpsertInput }
  | { op: "remove"; kind: InstallReceiptType; name: string }

export type ClaimMutationV1 = {
  op: "acquire" | "release"
  kind: InstallReceiptType
  name: string
  owner: string
}

/** 唯一的事务提交对象(基线 §2.9)。只挂在 **root** package item 上;child item 各自持
 *  capabilities 与 probe,但不独立驱动落账 —— 否则「child 已 durable、graph/claims 缺失」
 *  这种半态就会出现,而它恰恰是 owner 集合无法自证的那一种。 */
export type PackageLedgerMutationV1 = {
  transactionId: string
  operation: "install" | "update" | "uninstall"
  graphBeforeDigest: string | null
  graphAfter: PackageGraphV1 | null
  childRecordMutations: ChildRecordMutationV1[]
  claimMutations: ClaimMutationV1[]
}

/** journal 里持久化的静态半场(childRecordMutations 的 **upsert** 半场在 commit 时由 commit records
 *  派生,主提交与崩溃前滚同源 —— 两条路径算出同一份 mutation 才谈得上 exact replay)。
 *
 *  `#698`:**remove 半场没有 commit record 可派生**(被删掉的 child 这次不会产生任何 item),
 *  所以它必须随 envelope 进 journal。少了它,崩溃前滚会算出一份「只加不减」的 mutation ——
 *  update 删掉的 child 会在前滚后复活成一条没人认领的 record。 */
export type PackageMutationEnvelopeV1 = Omit<PackageLedgerMutationV1, "transactionId" | "childRecordMutations"> & {
  childRemovals: PackageChildRefV1[]
}

// ── owner token ────────────────────────────────────────────────────────────────────────────────

export const standaloneOwner = (kind: string, name: string): string => `standalone:${kind}:${name}`
export const bundleOwner = (packageId: string, manifestDigest: string): string => `bundle:${packageId}@${manifestDigest}`
export const LEGACY_PROTECTED_OWNER = LEGACY_PROTECTED

export type OwnerToken =
  | { kind: "standalone"; childKind: string; childName: string }
  | { kind: "bundle"; packageId: string; manifestDigest: string }
  | { kind: "legacy-protected" }

/** owner token 的严格解析。**不认得的形状一律 null** —— 未知 owner 既不能被释放也不能被
 *  证明为空,放行等于把「还有别人要」和「谁都不要」混成一个格子。 */
export function parseOwnerToken(token: unknown): OwnerToken | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return null
  if (token === LEGACY_PROTECTED) return { kind: "legacy-protected" }
  if (token.startsWith("standalone:")) {
    const rest = token.slice("standalone:".length)
    const sep = rest.indexOf(":")
    if (sep <= 0) return null
    const childKind = rest.slice(0, sep)
    const childName = rest.slice(sep + 1)
    if (!PACKAGE_LEDGER_KINDS.has(childKind) || !isExtensionName(childName)) return null
    return { kind: "standalone", childKind, childName }
  }
  if (token.startsWith("bundle:")) {
    const rest = token.slice("bundle:".length)
    const at = rest.indexOf("@")
    if (at <= 0) return null
    const packageId = rest.slice(0, at)
    const manifestDigest = rest.slice(at + 1)
    if (!PACKAGE_ID_RE.test(packageId) || !DIGEST_RE.test(manifestDigest)) return null
    return { kind: "bundle", packageId, manifestDigest }
  }
  return null
}

// ── 严格解码 ───────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

const GRAPH_NODE_KEYS = new Set(["componentId", "kind", "name", "required", "manifestDigest"])
const GRAPH_KEYS = new Set(["packageId", "envelopeDigest", "installedGraphDigest", "root", "children"])
const CLAIM_KEYS = new Set(["kind", "name", "owners"])

export type Decoded<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function decodeGraphNode(input: unknown, at: string, errors: string[]): PackageGraphNodeV1 | null {
  if (!isObj(input)) {
    errors.push(`${at}: must be an object`)
    return null
  }
  for (const k of Object.keys(input)) if (!GRAPH_NODE_KEYS.has(k)) errors.push(`${at}: unknown key "${k}" — refused (strict schema)`)
  const componentId = input.componentId
  const kind = input.kind
  const name = input.name
  const required = input.required
  const manifestDigest = input.manifestDigest
  if (typeof componentId !== "string" || !COMPONENT_ID_RE.test(componentId)) errors.push(`${at}.componentId: invalid`)
  if (typeof kind !== "string" || !PACKAGE_LEDGER_KINDS.has(kind)) errors.push(`${at}.kind: invalid`)
  if (typeof name !== "string" || !isExtensionName(name)) errors.push(`${at}.name: invalid`)
  if (typeof required !== "boolean") errors.push(`${at}.required: must be a boolean`)
  if (typeof manifestDigest !== "string" || !DIGEST_RE.test(manifestDigest)) errors.push(`${at}.manifestDigest: invalid`)
  if (errors.length > 0) return null
  return {
    componentId: componentId as string,
    kind: kind as InstallReceiptType,
    name: name as string,
    required: required as boolean,
    manifestDigest: manifestDigest as string,
  }
}

/** installedGraphDigest 的计算口径:packageId + envelopeDigest + root + children(children 按
 *  componentId 排序)。**digest 本身不参与计算** —— 否则自指。 */
export function computeInstalledGraphDigest(graph: Omit<PackageGraphV1, "installedGraphDigest">): string {
  return `sha256:${sha256Hex(
    canonicalJson({
      packageId: graph.packageId,
      envelopeDigest: graph.envelopeDigest,
      root: graph.root,
      children: [...graph.children].sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0)),
    }),
  )}`
}

export function decodePackageGraphV1(input: unknown): Decoded<PackageGraphV1> {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ["packageGraph: must be an object"] }
  for (const k of Object.keys(input)) if (!GRAPH_KEYS.has(k)) errors.push(`packageGraph: unknown key "${k}" — refused (strict schema)`)
  const packageId = input.packageId
  const envelopeDigest = input.envelopeDigest
  const installedGraphDigest = input.installedGraphDigest
  if (typeof packageId !== "string" || !PACKAGE_ID_RE.test(packageId)) errors.push("packageGraph.packageId: invalid")
  if (typeof envelopeDigest !== "string" || !DIGEST_RE.test(envelopeDigest)) errors.push("packageGraph.envelopeDigest: invalid")
  if (typeof installedGraphDigest !== "string" || !DIGEST_RE.test(installedGraphDigest)) errors.push("packageGraph.installedGraphDigest: invalid")
  const root = decodeGraphNode(input.root, "packageGraph.root", errors)
  if (!Array.isArray(input.children)) errors.push("packageGraph.children: must be an array")
  const children: PackageGraphNodeV1[] = []
  if (Array.isArray(input.children))
    for (let i = 0; i < input.children.length; i++) {
      const node = decodeGraphNode(input.children[i], `packageGraph.children[${i}]`, errors)
      if (node) children.push(node)
    }
  if (errors.length > 0 || !root) return { ok: false, errors: errors.length ? errors : ["packageGraph.root: invalid"] }
  // root 必须是 required(基线:非 required 的 root 无意义 —— 整包可跳过就不是一个包)。
  if (!root.required) return { ok: false, errors: ["packageGraph.root.required: root component must be required"] }
  // 组件 id / (kind,name) 全局唯一 —— 重复 id 会让 claim 归属出现两个答案。
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const node of [root, ...children]) {
    if (ids.has(node.componentId)) return { ok: false, errors: [`packageGraph: duplicate componentId "${node.componentId}"`] }
    ids.add(node.componentId)
    const k = `${node.kind}:${node.name}`
    if (keys.has(k)) return { ok: false, errors: [`packageGraph: duplicate child ${k}`] }
    keys.add(k)
  }
  const value: PackageGraphV1 = {
    packageId: packageId as string,
    envelopeDigest: envelopeDigest as string,
    installedGraphDigest: installedGraphDigest as string,
    root,
    children,
  }
  // 篡改闸:任何节点被改过 → 重算 digest 不符 → 拒。
  const recomputed = computeInstalledGraphDigest(value)
  if (recomputed !== value.installedGraphDigest)
    return { ok: false, errors: [`packageGraph.installedGraphDigest: does not match the graph contents (expected ${recomputed})`] }
  return { ok: true, value }
}

export function decodePackageClaimV1(input: unknown): Decoded<PackageClaimV1> {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ["claim: must be an object"] }
  for (const k of Object.keys(input)) if (!CLAIM_KEYS.has(k)) errors.push(`claim: unknown key "${k}" — refused (strict schema)`)
  const kind = input.kind
  const name = input.name
  if (typeof kind !== "string" || !PACKAGE_LEDGER_KINDS.has(kind)) errors.push("claim.kind: invalid")
  if (typeof name !== "string" || !isExtensionName(name)) errors.push("claim.name: invalid")
  if (!Array.isArray(input.owners) || input.owners.length === 0) errors.push("claim.owners: must be a non-empty array")
  const owners: string[] = []
  if (Array.isArray(input.owners))
    for (const owner of input.owners) {
      if (parseOwnerToken(owner) === null) {
        errors.push(`claim.owners: unrecognised owner token ${JSON.stringify(owner)} — refused (fail closed)`)
        continue
      }
      if (owners.includes(owner as string)) {
        errors.push(`claim.owners: duplicate owner ${JSON.stringify(owner)}`)
        continue
      }
      owners.push(owner as string)
    }
  if (errors.length > 0) return { ok: false, errors }
  // standalone owner 必须指向 claim 自己那个 child —— 否则一个 child 的 claim 能替另一个背书。
  for (const owner of owners) {
    const parsed = parseOwnerToken(owner)!
    if (parsed.kind === "standalone" && (parsed.childKind !== kind || parsed.childName !== name))
      return { ok: false, errors: [`claim.owners: standalone owner ${owner} does not match ${String(kind)}:${String(name)}`] }
  }
  return { ok: true, value: { kind: kind as InstallReceiptType, name: name as string, owners: [...owners].sort() } }
}

const ENVELOPE_KEYS = new Set(["operation", "graphBeforeDigest", "graphAfter", "claimMutations", "childRemovals"])

/** journal 里那半场的严格解码(不含 transactionId / childRecordMutations —— 那两样在
 *  commit 时由事务与 commit records 提供,不接受调用方自带)。 */
export function decodePackageMutationEnvelopeV1(input: unknown): Decoded<PackageMutationEnvelopeV1> {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ["packageMutation: must be an object"] }
  for (const k of Object.keys(input)) if (!ENVELOPE_KEYS.has(k)) errors.push(`packageMutation: unknown key "${k}" — refused (strict schema)`)
  const operation = input.operation
  if (operation !== "install" && operation !== "update" && operation !== "uninstall") errors.push("packageMutation.operation: invalid")
  let graphAfter: PackageGraphV1 | null = null
  if (input.graphAfter !== null) {
    const decoded = decodePackageGraphV1(input.graphAfter)
    if (!decoded.ok) errors.push(...decoded.errors)
    else graphAfter = decoded.value
  }
  const graphBeforeDigest = input.graphBeforeDigest
  if (graphBeforeDigest !== null && (typeof graphBeforeDigest !== "string" || !DIGEST_RE.test(graphBeforeDigest)))
    errors.push("packageMutation.graphBeforeDigest: must be null or a sha256 digest")
  const claimMutations: ClaimMutationV1[] = []
  if (!Array.isArray(input.claimMutations)) errors.push("packageMutation.claimMutations: must be an array")
  else
    for (let i = 0; i < input.claimMutations.length; i++) {
      const raw = input.claimMutations[i]
      if (!isObj(raw)) {
        errors.push(`packageMutation.claimMutations[${i}]: must be an object`)
        continue
      }
      for (const k of Object.keys(raw)) if (!["op", "kind", "name", "owner"].includes(k)) errors.push(`packageMutation.claimMutations[${i}]: unknown key "${k}"`)
      if (raw.op !== "acquire" && raw.op !== "release") errors.push(`packageMutation.claimMutations[${i}].op: invalid`)
      if (typeof raw.kind !== "string" || !PACKAGE_LEDGER_KINDS.has(raw.kind)) errors.push(`packageMutation.claimMutations[${i}].kind: invalid`)
      if (typeof raw.name !== "string" || !isExtensionName(raw.name)) errors.push(`packageMutation.claimMutations[${i}].name: invalid`)
      if (parseOwnerToken(raw.owner) === null) errors.push(`packageMutation.claimMutations[${i}].owner: unrecognised owner token`)
      if (errors.length === 0)
        claimMutations.push({
          op: raw.op as "acquire" | "release",
          kind: raw.kind as InstallReceiptType,
          name: raw.name as string,
          owner: raw.owner as string,
        })
    }
  // `#698` child removal 半场:严格解码 + 去重。**不接受**指向未知 kind / 非法 name 的删除请求,
  // 也不接受同一个 child 出现两次(两次 remove 读起来像「删得更彻底」,实际是调用方算错了)。
  const childRemovals: PackageChildRefV1[] = []
  if (!Array.isArray(input.childRemovals)) errors.push("packageMutation.childRemovals: must be an array")
  else {
    const seen = new Set<string>()
    for (let i = 0; i < input.childRemovals.length; i++) {
      const raw = input.childRemovals[i]
      if (!isObj(raw)) {
        errors.push(`packageMutation.childRemovals[${i}]: must be an object`)
        continue
      }
      for (const k of Object.keys(raw)) if (k !== "kind" && k !== "name") errors.push(`packageMutation.childRemovals[${i}]: unknown key "${k}"`)
      if (typeof raw.kind !== "string" || !PACKAGE_LEDGER_KINDS.has(raw.kind)) errors.push(`packageMutation.childRemovals[${i}].kind: invalid`)
      if (typeof raw.name !== "string" || !isExtensionName(raw.name)) errors.push(`packageMutation.childRemovals[${i}].name: invalid`)
      if (errors.length > 0) continue
      const k = `${String(raw.kind)}:${String(raw.name)}`
      if (seen.has(k)) {
        errors.push(`packageMutation.childRemovals: duplicate ${k}`)
        continue
      }
      seen.add(k)
      childRemovals.push({ kind: raw.kind as InstallReceiptType, name: raw.name as string })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  // operation 与 graphAfter 必须自洽:uninstall 没有 after 图,install/update 必须有。
  // `graphAfter` 就是这次 mutation 的**唯一** package 身份来源(`#764` 之前还有一份 packageRecord
  // 抄本,以及三条「抄本要等于原件」的校验 —— 抄本没了,那三条也就无处可漂)。
  if (operation === "uninstall") {
    if (graphAfter !== null) return { ok: false, errors: ["packageMutation: uninstall must carry graphAfter=null"] }
  } else if (graphAfter === null) {
    return { ok: false, errors: ["packageMutation: install/update must carry graphAfter"] }
  }
  return {
    ok: true,
    value: {
      operation: operation as "install" | "update" | "uninstall",
      graphBeforeDigest: (graphBeforeDigest ?? null) as string | null,
      graphAfter,
      claimMutations,
      childRemovals,
    },
  }
}

// ── claim 集合代数 ─────────────────────────────────────────────────────────────────────────────

const claimKey = (kind: string, name: string) => `${kind}:${name}`

export function findClaim(claims: readonly PackageClaimV1[], kind: string, name: string): PackageClaimV1 | null {
  return claims.find((c) => c.kind === kind && c.name === name) ?? null
}

/** 阻挡删除的 owner = 仍在使用它的 **Bundle**。`legacy-protected` 不阻挡用户的显式直接卸载
 *  (那是用户自己要求的),但它阻挡任何自动 GC —— 两者是不同的问题,别合并成一个判据。 */
export const blockingOwners = (owners: readonly string[], excluding: string): string[] =>
  owners.filter((o) => o !== excluding && parseOwnerToken(o)?.kind === "bundle")

export type DirectUninstallVerdict =
  | { decision: "delete"; releasedOwner: string | null }
  | { decision: "release-claim-only"; remainingOwners: string[] }
  | { decision: "refuse"; reason: string }

/** 直接(用户发起的)卸载判决。**必须在删任何实物之前调用** —— repository 事后拒绝时实物
 *  已经没了,用户看到「卸载失败」而东西是真没了,这正是 V3 要消灭的那种半态。
 *
 *  三支互斥,**「有 Bundle owner」不等于「有 standalone claim 可释放」**(review #757 Major):
 *  fresh package 安装只 acquire 一个 `bundle:` owner(`package-admission` 的 claimMutations),
 *  standalone owner 要等用户自己再单装一次才出现。把这两件事混成一支 ⇒ 用户对一个纯 Bundle
 *  child 点卸载,系统释放一份根本不存在的 claim、照旧提交一次写、回 ok ⇒ Hub 显示「已移除」
 *  而文件/record/图/claim 全在。所以这里必须拆出第三支:**没有可释放的东西就响亮拒绝**。 */
export function directUninstallVerdict(claim: PackageClaimV1 | null, kind: string, name: string): DirectUninstallVerdict {
  if (!claim) return { decision: "delete", releasedOwner: null }
  const own = standaloneOwner(kind, name)
  const blocking = blockingOwners(claim.owners, own)
  if (blocking.length > 0) {
    if (!claim.owners.includes(own))
      return {
        decision: "refuse",
        reason: `${kind}:${name} is owned by ${[...blocking].sort().join(", ")} and has no standalone install to release — uninstall the package instead`,
      }
    return { decision: "release-claim-only", remainingOwners: [...claim.owners.filter((o) => o !== own)].sort() }
  }
  return { decision: "delete", releasedOwner: claim.owners.includes(own) ? own : null }
}

export function withOwner(claims: readonly PackageClaimV1[], kind: InstallReceiptType, name: string, owner: string): PackageClaimV1[] {
  const next = claims.filter((c) => claimKey(c.kind, c.name) !== claimKey(kind, name))
  const existing = findClaim(claims, kind, name)
  const owners = existing ? [...new Set([...existing.owners, owner])].sort() : [owner]
  next.push({ kind, name, owners })
  return next
}

/** 释放一个 owner。owner 集合空掉 = 这个 claim 该消失(空集不落盘)。 */
export function withoutOwner(claims: readonly PackageClaimV1[], kind: string, name: string, owner: string): PackageClaimV1[] {
  const existing = findClaim(claims, kind, name)
  if (!existing) return [...claims]
  const owners = existing.owners.filter((o) => o !== owner)
  const rest = claims.filter((c) => claimKey(c.kind, c.name) !== claimKey(kind, name))
  return owners.length === 0 ? rest : [...rest, { ...existing, owners: [...owners].sort() }]
}

/** 整条 claim 拿掉(用户显式直接卸载走这条:连 legacy-protected 一起走,因为 record 也没了)。 */
export const withoutClaim = (claims: readonly PackageClaimV1[], kind: string, name: string): PackageClaimV1[] =>
  claims.filter((c) => claimKey(c.kind, c.name) !== claimKey(kind, name))

// ── 一次 mutation 的作用域闸(`#698`)───────────────────────────────────────────────────────────

/**
 * 一个 package mutation **允许触碰什么**。
 *
 * 这是 update/uninstall 唯一新增的咽喉。planner 会先算一份判决,但 planner 算错、被绕过、或将来
 * 多一个调用方时,唯一还站着的就是这里。三条判据各自封一个**账本自身查不出来的**洞:
 *
 *   ① **只准动自己的 owner。** 一次 package mutation 里的 `release` 只能释放**本 package 前一代**
 *      的 owner token,`acquire` 只能获取**本次这一代**的。放开这一条,一个 mutation 就能
 *      `release` 掉 `standalone:skill:foo`(用户自己装的)或 `legacy-protected`(V3 之前的存量)——
 *      owner 集合随即变空,record 与实物合法地被删掉,而 `validateV3State` 全绿:它检查的是
 *      「claim 与 record/graph 互相对得上」,对得上的**空集**是完全自洽的。用户会看到自己单装的
 *      东西在别人更新一个包时消失。
 *
 *   ② **只准动自己图里的 child。** claim mutation 指名的 `(kind,name)` 必须出现在前后两张图之一。
 *      放开这一条,一个包可以对任意 child `acquire` 自己的 owner —— 那个 child 从此被
 *      `directUninstallVerdict` 判为「被 Bundle 拥有」,用户再也卸不掉它,而账本层面同样全绿
 *      (`validateV3State` 只查「bundle owner 有没有对应的图」,不查反向)。
 *
 *   ③ **只准删离场的 child。** `remove` 必须指名前一代图里有、这一代图里没有的节点。
 *
 * 三条都在**写盘之前**判,拒绝即整次 mutation 作废、账本一个字节不动。
 */
export function validatePackageMutationScopeV1(
  mutation: PackageLedgerMutationV1,
  graphBefore: PackageGraphV1 | null,
): { ok: true } | { ok: false; reason: string } {
  const after = mutation.graphAfter
  const ownerAfter = after ? bundleOwner(after.packageId, after.root.manifestDigest) : null
  const ownerBefore = graphBefore ? bundleOwner(graphBefore.packageId, graphBefore.root.manifestDigest) : null
  const nodeKeys = (graph: PackageGraphV1 | null): Set<string> =>
    new Set(graph ? [graph.root, ...graph.children].map((node) => `${node.kind}:${node.name}`) : [])
  const beforeKeys = nodeKeys(graphBefore)
  const afterKeys = nodeKeys(after)

  for (const cm of mutation.claimMutations) {
    const k = `${cm.kind}:${cm.name}`
    if (!beforeKeys.has(k) && !afterKeys.has(k))
      return {
        ok: false,
        reason: `refusing package mutation: claim ${cm.op} names ${k}, which is in neither the before nor the after graph of "${
          after?.packageId ?? graphBefore?.packageId ?? "<unknown>"
        }" — a package may only claim its own children`,
      }
    const expected = cm.op === "acquire" ? ownerAfter : ownerBefore
    if (expected === null)
      return {
        ok: false,
        reason: `refusing package mutation: claim ${cm.op} for ${k} has no ${cm.op === "acquire" ? "after" : "before"} graph to derive an owner from`,
      }
    if (cm.owner !== expected)
      return {
        ok: false,
        reason: `refusing package mutation: claim ${cm.op} for ${k} names owner ${cm.owner}, but this mutation may only ${cm.op} ${expected} — a package must not touch another owner's claim`,
      }
  }

  for (const child of mutation.childRecordMutations) {
    if (child.op !== "remove") continue
    const k = `${child.kind}:${child.name}`
    if (!beforeKeys.has(k))
      return { ok: false, reason: `refusing package mutation: child removal names ${k}, which the before graph does not contain` }
    if (afterKeys.has(k))
      return { ok: false, reason: `refusing package mutation: child removal names ${k}, which is still part of the after graph` }
  }
  return { ok: true }
}

// ── 不变量 ─────────────────────────────────────────────────────────────────────────────────────

export type V3State = {
  recordKeys: ReadonlySet<string>
  packageGraphs: readonly PackageGraphV1[]
  claims: readonly PackageClaimV1[]
}

/**
 * 落盘**之前**的整体不变量。任何一条不成立就拒写并原样保留旧文件 ——
 * 这些都不是「数据不好看」,而是 owner 集合从此无法自证:
 *
 * 1. **dangling claim**:claim 指向一个没有 record 的 child —— 保护一个不存在的东西,
 *    而它会永远挡住同名 child 的将来安装。
 * 2. **unknown child**:图里的 leaf 没有对应 claim —— 这个 leaf 归谁没人知道。
 * 3. **孤儿 bundle owner**:claim 里写着某个 `bundle:pkg@digest`,但账本里没有这张图 ——
 *    那个 owner 永远不会被释放,child 从此不可回收。
 * 4. **packageId / installedGraphDigest 重复**:一个 package 两张图 = 两个真相。
 */
export function validateV3State(state: V3State): { ok: true } | { ok: false; reason: string } {
  const seenPackages = new Set<string>()
  const graphOwners = new Set<string>()
  for (const graph of state.packageGraphs) {
    if (seenPackages.has(graph.packageId)) return { ok: false, reason: `duplicate package graph for "${graph.packageId}"` }
    seenPackages.add(graph.packageId)
    graphOwners.add(bundleOwner(graph.packageId, graph.root.manifestDigest))
    for (const node of [graph.root, ...graph.children]) {
      const claim = findClaim(state.claims, node.kind, node.name)
      if (!claim)
        return { ok: false, reason: `package "${graph.packageId}" graph names ${node.kind}:${node.name} but no claim owns it (unknown child — fail closed)` }
      if (!claim.owners.includes(bundleOwner(graph.packageId, graph.root.manifestDigest)))
        return {
          ok: false,
          reason: `package "${graph.packageId}" graph names ${node.kind}:${node.name} but its claim does not carry that package as an owner`,
        }
    }
  }
  const seenClaims = new Set<string>()
  for (const claim of state.claims) {
    const k = claimKey(claim.kind, claim.name)
    if (seenClaims.has(k)) return { ok: false, reason: `duplicate claim for ${k}` }
    seenClaims.add(k)
    if (claim.owners.length === 0) return { ok: false, reason: `claim ${k} has an empty owner set — it must not exist` }
    if (!state.recordKeys.has(k)) return { ok: false, reason: `dangling claim ${k}: no install record owns this child (fail closed)` }
    for (const owner of claim.owners) {
      const parsed = parseOwnerToken(owner)
      if (!parsed) return { ok: false, reason: `claim ${k} carries an unrecognised owner token ${JSON.stringify(owner)}` }
      if (parsed.kind === "bundle" && !graphOwners.has(owner))
        return { ok: false, reason: `claim ${k} names owner ${owner} but no package graph in this ledger matches it (orphan owner — fail closed)` }
    }
  }
  return { ok: true }
}

/** V3 段是否为空(空 = 账本仍写 V2 信封,老构建照常可用)。 */
export const isV3Active = (graphs: readonly unknown[], claims: readonly unknown[]): boolean => graphs.length > 0 || claims.length > 0
