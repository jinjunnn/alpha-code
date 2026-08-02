// REQ-128 Phase 3 `[T2-install]`(#781):把 T1 清点出来的 N 个技能**一次事务**装进去,
// 并在 V3 账本里落成**一个包**。装成就全装成,中途挂就一个都不留;装完默认是**关**的。
//
// 本模块只做一件事:**输入适配** —— 从「一个本地 Claude 插件目录 + 一份 T1 预览」得出
// 那份 `TxPlan` 与那份 `PackageMutationEnvelopeV1`。事务引擎、账本落账入口、卸载判决
// 一行都不改:
//   · 计划执行 = `runExtensionTransaction`(`ext-transaction.ts`)
//   · 落账     = `commitTransactionLedger`(`ext-package-ledger-commit.ts`)唯一入口
//   · 卸载     = `uninstallPackageV1` / `planDirectUninstall` 原样
// 「一个包由哪些组件组成 / 每个组件归谁所有 / 怎么整包卸载」这三个问题的答案继续由 V3
// 账本**唯一**持有。本模块不回答它们,只把问题按既有形状提出来。
//
// ── 三条降级,写成降级(基线 §8 纪律 3;任何把它们写成「等价保证」的表述都是造假闸)──────
//
//   1. **admission 的那一整套渠道保证在这条路上没有替代品。** 已验签 Catalog 快照、catalogId
//      成员资格、逐组件载荷摘要、binding 五键 —— 一件都不在。兜底只有三件:用户亲手选的目录
//      (main 自弹 picker,renderer 全程给不出路径)、preview 里逐条告知、账本里恒为 user 的
//      策展维。**这不是「用别的方式提供了同等保证」。**
//   2. **引擎的 capability 授权闸在这条路上是空的。** 本地插件没有能力声明 ⇒ `capabilities`
//      恒 `[]` ⇒ `diffCapabilities` 的 `requiresConfirmation` 恒 false(`ext-capability-grants.ts:100`)
//      ⇒ authorize 循环全 `continue`。接线是真的(把 capabilities 改成非空,真实 confirm 必须
//      停在 authorize、零安装 —— 那条用例在测试里),只是这条路上永远喂它空集。
//   3. **binding 从五键降为一键本地 snapshotDigest。** 图上的 `envelopeDigest` 在这条路上
//      装的是「本地规范化载荷摘要」,不是任何签名信封的摘要;provenance 一律从 child record 的
//      `origin`(`imported-claude`)读,**绝不从 packageId 前缀读结构**(`#737`)。
//
// ── 为什么不复用 `buildSkillTxItems` ─────────────────────────────────────────────────────
//
// 它把 `files` 硬编码成单条 `SKILL.md`(`ext-package-tx-builders.ts:133-161`),populate 也
// 只写那一个文件。真实语料 40/162 是多文件技能 —— 照它实现,这 40 个会装成残件:安装成功、
// 账本干净、技能能启用,而它引用的脚本与参考资料一个都不在。所以载荷这一半走
// `collectImportSkillPayload` → `promotePayloadToCas` → **多文件** generation item。
// (账本那一半仍然一个字都不另写:root item 挂 `packageMutation`,落账走既有唯一入口。)

import * as path from "node:path"

import type { AppEnvironment } from "./alpha-environment"
import type { LocalPackagePreviewV1 } from "./claude-plugin-intake"
import { populateFromCas } from "./ext-cas"
import { collectImportSkillPayload } from "./ext-fs-installer"
import { nextDesiredState } from "./ext-install-policy"
import { promotePayloadToCas, uncuratedSkillFreshGate, type InstallScope } from "./ext-install-planner"
import { sha256Hex } from "./ext-manifest-v2"
import { commitTransactionLedger } from "./ext-package-ledger-commit"
import {
  computeInstalledGraphDigest,
  PACKAGE_ID_RE,
  type ClaimMutationV1,
  type PackageGraphNodeV1,
  isValidPackageDisplayName,
  type PackageGraphV1,
  type PackageMutationEnvelopeV1,
} from "./ext-package-ledger-v3"
import { diffPackageGraphsV1, planPackageClaimTransferV1 } from "./ext-package-lifecycle"
import { readPackageLedgerStateV1, type UpsertInput } from "./ext-receipt-v2"
import { skillGenerationKey, skillGenerationProbe, type SkillPayloadFile } from "./ext-skill-generations"
import { runExtensionTransaction, type TxFileSpec, type TxHooks, type TxPlan, type TxPlanItem } from "./ext-transaction"

/** T1 的 `contentDigest` 用 NUL 做字段分隔。这里必须逐字复现同一口径 —— 否则「留在 main 的
 *  字节就是用户在预览屏上看到的那些」这条断言比的是两个不同的东西。
 *  写成 `String.fromCharCode(0)` 而不是转义字面量:本仓已两次把「转义的 NUL」落盘成**真的**
 *  NUL 字节(见 `aweb#115` / `ac#760`,真 NUL 会让 `rg` 静默返回空)。 */
const NUL = String.fromCharCode(0)

/** 本地包的组件 id 命名空间。与 child record 的 `id`(`user:<name>`)逐字相同 ——
 *  非 catalog 来源的 record id 本来就恒为 `user:<name>`(`#306`),图里再换一套就是第二个身份。 */
const COMPONENT_ID_NS = "user"

/** 本地包的 packageId 命名空间(T1 铸造,这里只校验)。**只是命名空间保留,不是行为判据**:
 *  「这个包是不是本地来的」一律从 child record 的 `origin` 回答(基线 §8 纪律 2)。 */
const LOCAL_PACKAGE_ID_PREFIX = "local:"

/** 落账 origin。REQ-063 的既有词汇,**不发明新 origin** —— 换一个新的会静默掉出
 *  `composer-autocomplete.tsx:155` 的 `startsWith("imported")` 过滤器,而 typecheck 不会红。 */
const LOCAL_PACKAGE_ORIGIN = "imported-claude" as const

// ── 输入 ──────────────────────────────────────────────────────────────────────────────────

/** preview 期采到、**留在 main** 的载荷字节(照 REQ-033 的形状:confirm 期**不重扫**目录)。 */
export type LocalPackagePayloadV1 = {
  /** frontmatter name —— 安装名、事务 key、record 名、图节点名的唯一来源。 */
  readonly name: string
  /** 相对插件根的 POSIX 路径(与 preview 组件的 `dir` 逐字相同,是两者的连接键)。 */
  readonly dir: string
  readonly files: readonly SkillPayloadFile[]
}

export type LocalPackageInstallInputV1 = {
  /** T1 判定为插件包的那个目录(main 自弹 picker 的产物)。 */
  readonly pluginRoot: string
  /** T1 的预览。它的 `install` 组件集是四集双射的**第一个**集合。 */
  readonly preview: LocalPackagePreviewV1
  /** preview 期留下的载荷字节,逐条与预览的 `install` 组件对应。 */
  readonly payloads: readonly LocalPackagePayloadV1[]
  /** ADR-030:project 本地技能维持 `<project>/.alpha/skills` 的 sanctioned flat 路径,
   *  本期不 reopen project generation。传 project ⇒ **显式拒绝**,绝不悄悄落回 flat。 */
  readonly scope?: InstallScope
}

export type LocalPackageInstallDepsV1 = {
  globalRoot(): string
  casBaseRoot(): string
  environment(): AppEnvironment
}

// ── 输出 ──────────────────────────────────────────────────────────────────────────────────

export type LocalPackageInstallRefusalCodeV1 =
  | "invalid-input"
  | "unsupported-scope"
  | "preview-not-installable"
  | "package-already-installed"
  | "preview-stale"
  | "payload-mismatch"
  | "bijection-mismatch"
  | "cas-promotion-failed"
  | "transaction-failed"

export type LocalPackageInstallOutcomeV1 =
  | {
      ok: true
      packageId: string
      /** 真被装进去的技能名(= 图节点集 = 带 receipt 的 item 集 = claim 获取集)。 */
      installed: string[]
      /** owner 裁决 B:本地包装完默认是**关**的。逐条落账值,不是一句声明。 */
      desiredState: "disabled"
      warning?: string
    }
  | { ok: false; code: LocalPackageInstallRefusalCodeV1; reason: string; stage?: string }

// ── preview 期的载荷采集 ──────────────────────────────────────────────────────────────────

/**
 * 把预览里判为「可装」的技能逐个采成载荷字节。
 *
 * **在 preview 期调用一次,把结果留在 main**(K15 / G19 的形状),confirm 期直接用留下来的字节。
 * 在 confirm 期再调一次就是「confirm 期重扫」—— 用户确认的是他看过的那份预览,不是确认之后
 * 目录里恰好还剩下什么。
 *
 * 内容只经 `collectImportSkillPayload`(realpath 圈禁 / `O_NOFOLLOW` / `O_NONBLOCK` / fstat 帽 /
 * 定长读 / 增长探测 / 10MB·500 条帽)。本模块自己不开任何文件句柄读技能内容。
 */
export function collectLocalPackagePayloadsV1(
  pluginRoot: string,
  preview: LocalPackagePreviewV1,
): { ok: true; payloads: LocalPackagePayloadV1[] } | { ok: false; reason: string } {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot))
    return { ok: false, reason: "插件目录必须是绝对路径" }
  const payloads: LocalPackagePayloadV1[] = []
  for (const component of preview.components) {
    if (component.disposition !== "install") continue
    const collected = collectImportSkillPayload(path.join(pluginRoot, component.dir))
    if (!collected.ok) return { ok: false, reason: `${component.dir}: ${collected.reason}` }
    payloads.push({ name: collected.name, dir: component.dir, files: collected.files })
  }
  return { ok: true, payloads }
}

// ── 计划 ──────────────────────────────────────────────────────────────────────────────────

/** 一个被接受的技能。**四件东西全部由这一个数组派生** —— 这是 G15 的全部要点。 */
type AcceptedSkillV1 = {
  /** 双射比较键 `skill:<name>`。四个集合都用它,比的是同一个键空间。 */
  readonly key: string
  readonly name: string
  readonly dir: string
  /** 事务 key `skill--<name>`(与单装、与整包卸载的 grant 清除逐字同源)。 */
  readonly txKey: string
  readonly componentId: string
  /** 本地内容摘要(hex,不带前缀)。 */
  readonly contentDigest: string
  readonly files: readonly SkillPayloadFile[]
}

export type LocalPackageInstallPlanV1 = {
  readonly packageId: string
  readonly accepted: readonly AcceptedSkillV1[]
  readonly graph: PackageGraphV1
  readonly claimMutations: readonly ClaimMutationV1[]
  readonly plan: TxPlan
  readonly hooks: TxHooks
  /** CAS 提升期的 loud 诊断信号(在店 blob 损坏被自愈、GC 竞态、mtime 刷新失败)。
   *  它必须一路走到成功结果的 `warning` 上:`#765` 之后呈现的咽喉在 renderer 的 `extIpc`
   *  包装层 —— 凡返回值带具名 warning 就统一推 toast。所以本模块**不另发明一条传递通道**,
   *  只负责把它挂在既有字段上;收集了不往上传 = 静默吞掉。 */
  readonly casWarnings: readonly string[]
}

const identityKey = (name: string): string => `skill:${name}`

/** T1 的逐技能内容摘要口径,逐字复现(`claude-plugin-intake.ts` 的 `judgeSkill`)。 */
function contentDigestOf(files: readonly SkillPayloadFile[]): string {
  return sha256Hex(files.map((f) => `${f.path}${NUL}${sha256Hex(f.data)}`).sort().join("\n"))
}

const sortedJoin = (keys: readonly string[]): string => [...keys].sort().join(",")

/**
 * 建计划。**不跑事务、不写账本**;唯一的写是把载荷提升进内容寻址 CAS(与单装路径同序同点位)。
 *
 * 拒绝一律发生在这里 —— 事务函数**根本不会被调用**,所以「一个都装不上」「预览已过期」
 * 「这个包已经装过了」这些终态都是零 journal、零锁、零账本副作用。
 */
export function buildLocalPackageInstallPlanV1(
  input: LocalPackageInstallInputV1,
  deps: LocalPackageInstallDepsV1,
): { ok: true; plan: LocalPackageInstallPlanV1 } | { ok: false; code: LocalPackageInstallRefusalCodeV1; reason: string } {
  const refuse = (code: LocalPackageInstallRefusalCodeV1, reason: string) => ({ ok: false as const, code, reason })

  // ── ① 输入闸 ──
  if (!input || typeof input.pluginRoot !== "string" || !path.isAbsolute(input.pluginRoot))
    return refuse("invalid-input", "插件目录必须是绝对路径")
  const preview = input.preview
  if (!preview || preview.schema !== "local-claude-plugin-preview/v1")
    return refuse("invalid-input", "预览不是本版本认识的形状")
  // ADR-030:显式拒绝,不悄悄落回 flat 路径。
  if (input.scope && input.scope.scope !== "global")
    return refuse("unsupported-scope", "本地扩展包只装到全局;项目级技能仍走既有的项目内技能目录")
  if (preview.disposition !== "installable" || !preview.packageId)
    return refuse(
      "preview-not-installable",
      preview.blockedReason ?? "这个插件没有本版本能装的技能",
    )
  const packageId = preview.packageId
  // 铸造侧的命名空间校验(G8 的第一个方向)。**只是校验**,不是行为判据。
  if (!packageId.startsWith(LOCAL_PACKAGE_ID_PREFIX) || !PACKAGE_ID_RE.test(packageId))
    return refuse("invalid-input", `本地扩展包的标识必须是 "local:<name>" 形态,收到 ${JSON.stringify(packageId)}`)
  // R2 Major 的兜底:preview 交上来一个账本存不下的显示名 ⇒ **在这里**具名拒绝(零写盘、
  // 事务函数根本不会被调用),而不是让它一路走到 receipt commit 再整个回滚。
  // 正常路径上这一条永远不会命中(preview 已经用同一个谓词定过案了)—— 它存在的意义是:
  // 万一将来有人绕过 intake 直接构造 preview,失败也发生在**动任何东西之前**。
  if (preview.displayName !== null && !isValidPackageDisplayName(preview.displayName))
    return refuse("invalid-input", "这个插件的名字这一版显示不了,请重新预览一次")

  // ── ② 由**同一个 accepted 数组**开始(G15 的源头)──
  //     preview 的 install 组件按**组件名字典序**取,root 因此是确定的(基线 §12 风险 3)。
  const included = preview.components
    .filter((component) => component.disposition === "install")
    .slice()
    .sort((a, b) => (a.name === b.name ? (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0) : a.name < b.name ? -1 : 1))
  if (included.length === 0) return refuse("preview-not-installable", "这个插件里没有本版本能装的技能")

  const payloadByDir = new Map(input.payloads.map((payload) => [payload.dir, payload]))
  if (payloadByDir.size !== input.payloads.length)
    return refuse("payload-mismatch", "留存载荷里有重复的技能目录")
  const accepted: AcceptedSkillV1[] = []
  for (const component of included) {
    const payload = payloadByDir.get(component.dir)
    if (!payload) return refuse("payload-mismatch", `预览里的「${component.dir}」没有对应的留存载荷`)
    if (payload.name !== component.name)
      return refuse("payload-mismatch", `「${component.dir}」的技能名与预览不符(${payload.name} ≠ ${component.name})`)
    // 用户确认的是他看过的那份预览。留存字节与预览摘要不符 ⇒ 整次拒绝,不装。
    const digest = contentDigestOf(payload.files)
    if (digest !== component.contentDigest)
      return refuse("payload-mismatch", `「${component.dir}」的内容与预览时不一致,请重新预览`)
    const componentId = `${COMPONENT_ID_NS}:${component.name}`
    // 图节点的 componentId 只收小写文法(`PACKAGE_ID_RE`),而技能名允许大写 ——
    // 不合就在**这里**具名拒绝,不要等写盘时被一句 "componentId: invalid" 拦下。
    if (!PACKAGE_ID_RE.test(componentId))
      return refuse("invalid-input", `技能名「${component.name}」不能作为扩展包的组件标识(只允许小写)`)
    accepted.push({
      key: identityKey(component.name),
      name: component.name,
      dir: component.dir,
      txKey: skillGenerationKey(component.name),
      componentId,
      contentDigest: digest,
      files: payload.files,
    })
  }
  if (input.payloads.length !== accepted.length)
    return refuse("payload-mismatch", "留存载荷与预览里可装的技能对不上")
  if (new Set(accepted.map((entry) => entry.key)).size !== accepted.length)
    return refuse("bijection-mismatch", "这一包里有两个同名技能,装下去账本里会只剩一个")

  const root = deps.globalRoot()

  // ── ③ 这个包已经在账上 ⇒ 先移除整包(K19 与 G4 同源:重导入是唯一更新通道)──
  const state = readPackageLedgerStateV1(root)
  if (!state.ok) return refuse("preview-stale", `账本读不出来,不装:${state.reason}`)
  if (state.packageGraphs.some((graph) => graph.packageId === packageId))
    return refuse("package-already-installed", "这个插件已经装过了。要更新它,请先移除整包,再重新导入。")

  // ── ④ G4 锁外预检:**导出并复用**既有的 `uncuratedSkillFreshGate`(不写替身)──
  //     它同时查:损坏账本(`probeLedgerForWrite`)、v1/v2 record(`lookupForUninstall`)、
  //     **无账本的 flat 目录**、**残留 generation store**。自己写一个「查账本 record」的版本
  //     会漏掉后两条,而那两条正是「静默认领用户既有内容」的入口。
  const preflight = compositeFreshGateV1(root, accepted)
  if (!preflight.ok) return refuse("preview-stale", preflight.reason)

  // ── ⑤ 载荷提升进验证共享 CAS(与单装路径同一个函数、同一个顺序)──
  const casBaseRoot = deps.casBaseRoot()
  const specsByKey = new Map<string, TxFileSpec[]>()
  const warnings: string[] = []
  for (const entry of accepted) {
    const manifest = entry.files.map((file) => ({ path: file.path, sha256: sha256Hex(file.data), bytes: file.data.length }))
    const promoted = promotePayloadToCas(casBaseRoot, [...entry.files], manifest)
    if (!promoted.ok) return refuse("cas-promotion-failed", `${entry.dir}: ${promoted.reason}`)
    // 与单技能生产路径(`ext-install-planner.ts:2668`)逐字同形:立刻 loud log，并把 warning
    // 带到成功结果上。收集了不往上传就是静默吞掉 —— 这个形态在本仓已栽三次(`#765`/`#771`)。
    if (promoted.warnings.length)
      console.error(`[claude-plugin-install] local package skill ${entry.name}: CAS promotion warnings: ${promoted.warnings.join("; ")}`)
    warnings.push(...promoted.warnings.map((warning) => `${entry.name}: ${warning}`))
    specsByKey.set(entry.txKey, promoted.specs)
  }

  // ── ⑥ 四件东西,同一个数组派生 ──
  const now = new Date().toISOString()
  const items: TxPlanItem[] = accepted.map((entry) => ({
    key: entry.txKey,
    files: specsByKey.get(entry.txKey)!,
    // 降级 2:本地插件没有能力声明。空集 = authorize 闸静默通过 —— 显式传,不缺省
    // (`ext-transaction.ts:1091` 只对 `capabilities !== undefined` 的 item 落授权账)。
    capabilities: [],
    // 授权账里的这一栏在这条路上是**本机对本地字节算的哈希**,不是供给链摘要。前缀让读账本的人
    // 一眼看出这件事(它不参与任何安全判定:授权闸只看 capabilities 集合)。
    manifestDigest: `sha256-local:${entry.contentDigest}`,
    receipt: receiptOf(root, entry, preview, deps.environment(), now),
  }))

  const graphNodeOf = (entry: AcceptedSkillV1): PackageGraphNodeV1 => ({
    componentId: entry.componentId,
    kind: "skill",
    name: entry.name,
    // root 与 leaf 本期一律 required 且行为对称(基线 §12 风险 3)。
    required: true,
    manifestDigest: `sha256:${entry.contentDigest}`,
  })
  const withoutDigest = {
    packageId,
    // D3(编排者裁决 F):字段名保留,装的是**本地规范化载荷摘要**。见 `ext-package-ledger-v3.ts`
    // 的字段注释与 `ext-package-ledger-v3.test.ts` 里钉住这件事的那条用例。
    envelopeDigest: `sha256:${preview.snapshotDigest}`,
    // `#784`(owner 裁决):列表里显示的是**插件作者自己写的名字**,不是包里某个技能的名字,
    // 也**不是**从 packageId 前缀反推的(`#737`)。
    //
    // R2 Major:这里**只透传 preview 已经定好的那一个值**,不再自己从 `preview.name` 派生。
    // 派生就是第二份文法 —— 而 `preview.name` 是 manifest 的原样值,可能超长/带控制字符,
    // 账本存不下,于是「预览说能装、点了确认在 receipt commit 那一刻整个回滚」。
    // 名字显示不了是**呈现问题**,不该让安装失败:此时 preview 已把它定成 `null` 并在
    // 确认之前告知用户,这里就干脆不写这个字段(缺席合法,呈现层回退 root 组件名)。
    ...(preview.displayName === null ? {} : { displayName: preview.displayName }),
    // G14:root 必须是一个**真被装的 skill**。合成的 `kind:"plugin"` root 装得上,但
    // `removePackageChildArtifactsV1` 对 skill/agent/mcp 之外 fail-closed ⇒ 装得上、卸不掉。
    root: graphNodeOf(accepted[0]!),
    children: accepted.slice(1).map(graphNodeOf),
  }
  const graph: PackageGraphV1 = { ...withoutDigest, installedGraphDigest: computeInstalledGraphDigest(withoutDigest) }

  // claim 获取集走既有的集合代数(`diffPackageGraphsV1` → `planPackageClaimTransferV1`),
  // 不手写「给每个组件 acquire 一次」—— 手写的那份会在 update 语义上与账本分叉。
  const diffed = diffPackageGraphsV1(null, graph, { before: null, after: preview.version })
  if (!diffed.ok) return refuse("bijection-mismatch", diffed.reason)
  const claimMutations = planPackageClaimTransferV1(diffed.diff)

  // ── ⑦ G15:调事务**之前**,四个 key 集逐字相等 ──────────────────────────────────────────
  //
  // 为什么这道闸必须存在:`validateV3State`(`ext-package-ledger-v3.ts:534-556`)只走
  // 「图 → claim → record」,**没有 record → 图**这个方向。于是「多一条不在任何图里的 record」
  // 是一个完全自洽的账本状态,`applyPackageMutation` 会返回 `{ok:true}`:
  //   · `commitTransactionLedger:47` 把**每个带 receipt 的 item** 独立转成一条 upsert;
  //   · `validatePackageMutationScopeV1:504` 只查 `remove`,`continue` 过所有 upsert。
  // 后果不是「数据不好看」:用户装了 N 个只看见 N−1 个在包里,整包卸载之后漏掉的那个
  // **继续留在盘上、还能被单独卸载**,而安装、账本、探针全绿。
  const previewKeys = included.map((component) => identityKey(component.name))
  const itemKeys = items
    .filter((item) => item.receipt !== undefined)
    .map((item) => {
      const receipt = item.receipt as UpsertInput
      return `${receipt.kind}:${receipt.name}`
    })
  const graphKeys = [graph.root, ...graph.children].map((node) => `${node.kind}:${node.name}`)
  const claimKeys = claimMutations.filter((mutation) => mutation.op === "acquire").map((mutation) => `${mutation.kind}:${mutation.name}`)
  const sets: Array<[string, readonly string[]]> = [
    ["预览可装集", previewKeys],
    ["事务 receipt 集", itemKeys],
    ["包图节点集", graphKeys],
    ["claim 获取集", claimKeys],
  ]
  const expected = sortedJoin(previewKeys)
  for (const [label, keys] of sets)
    if (sortedJoin(keys) !== expected)
      return refuse(
        "bijection-mismatch",
        `拒绝安装:${label}与预览可装集不一致(${sortedJoin(keys) || "空"} ≠ ${expected || "空"})——` +
          `这会让账本里出现一条不属于任何扩展包的记录,整包移除之后它还留在盘上`,
      )

  // ── ⑧ V3 mutation 的静态半场,**只挂在 root item 上** ──
  const envelope: PackageMutationEnvelopeV1 = {
    operation: "install",
    graphBeforeDigest: null,
    graphAfter: graph,
    claimMutations: [...claimMutations],
    childRemovals: [],
  }
  const rootIndex = items.findIndex((item) => item.key === accepted[0]!.txKey)
  if (rootIndex < 0) return refuse("bijection-mismatch", "计划里没有 root 组件,拒绝安装(没有落账载体)")
  items[rootIndex] = { ...items[rootIndex]!, packageMutation: envelope }

  const populate = populateFromCas(casBaseRoot)
  const hooks: TxHooks = {
    // G4 锁内半场:与锁外预检**同一个函数**。preview 之后被别人占了同名 skill ⇒ 整次零写。
    precondition: () => compositeFreshGateV1(root, accepted),
    populate: (item, stagingDir) => {
      const specs = specsByKey.get(item.key)
      if (!specs) throw new Error(`no populate seam for transaction item "${item.key}" — refusing (fail closed)`)
      populate({ files: specs }, stagingDir)
    },
    probe: skillGenerationProbe,
    // 落账走**唯一入口**(主提交与崩溃前滚同源);写失败必须抛错,引擎据此 rollback + quarantine。
    commitReceipt: (records) => commitTransactionLedger(root, records),
  }

  return {
    ok: true,
    plan: {
      packageId,
      accepted,
      graph,
      claimMutations,
      plan: { items },
      hooks,
      casWarnings: warnings,
    },
  }
}

/** N 个 accepted 的**组合** fresh-only 前置。锁外预检与锁内 `precondition` 跑的是这一个函数,
 *  它内部跑的又是**导出的既有** `uncuratedSkillFreshGate` —— 不是一个「查账本 record」的替身。
 *
 *  任一条不成立 ⇒ **整次零写**,并且**不许**临时把那一个从 accepted 集里摘掉继续装:
 *  用户确认的是他看过的那份预览。 */
function compositeFreshGateV1(root: string, accepted: readonly AcceptedSkillV1[]): { ok: true } | { ok: false; reason: string } {
  for (const entry of accepted) {
    const verdict = uncuratedSkillFreshGate(root, entry.name)
    if (!verdict.ok) return { ok: false, reason: `预览已过期,请重新预览(${entry.name}:${verdict.reason})` }
  }
  return { ok: true }
}

/** child record 模板。**不携任何供给链摘要**(`#306`:非 catalog 来源禁带 manifest/payload/grant/
 *  previousDigest),id 恒 `user:<name>`,origin 恒 `imported-claude`。 */
function receiptOf(
  root: string,
  entry: AcceptedSkillV1,
  preview: LocalPackagePreviewV1,
  environment: AppEnvironment,
  installedAt: string,
): UpsertInput {
  return {
    id: `${COMPONENT_ID_NS}:${entry.name}`,
    name: entry.name,
    kind: "skill",
    environment,
    scope: { kind: "global" },
    ...(preview.version ? { version: preview.version } : {}),
    // owner 裁决 B:本地**包**装完默认 `disabled`(本地**单个** skill 维持 `enabled`)。
    // 判别维加在共享真源 `shared/ext-install-policy.ts` 上 —— 两者的 origin 逐字相同,
    // 今天的入参里没有第二个东西能区分它们,所以**不许**在这个调用点分叉。
    desiredState: nextDesiredState(root, "skill", entry.name, { origin: LOCAL_PACKAGE_ORIGIN, localPackage: true }),
    origin: LOCAL_PACKAGE_ORIGIN,
    installedAt,
  }
}

// ── 执行 ──────────────────────────────────────────────────────────────────────────────────

/** 生产入口:建计划 → **一次** `runExtensionTransaction`。 */
export async function installLocalClaudePluginV1(
  input: LocalPackageInstallInputV1,
  deps: LocalPackageInstallDepsV1,
): Promise<LocalPackageInstallOutcomeV1> {
  const built = buildLocalPackageInstallPlanV1(input, deps)
  if (!built.ok) return built
  const result = await runExtensionTransaction(deps.globalRoot(), built.plan.plan, built.plan.hooks)
  if (!result.ok)
    return {
      ok: false,
      code: "transaction-failed",
      reason: result.reason,
      stage: result.stage,
    }
  // CAS 提升的 warning 与事务自己的 warning 并到**同一个字段**上 —— renderer 的 `extIpc`
  // 包装层(`#765` 的咽喉)对任何带具名 warning 的返回值统一推 toast,这里不另开通道。
  const warnings = [...built.plan.casWarnings, ...result.warnings]
  return {
    ok: true,
    packageId: built.plan.packageId,
    installed: built.plan.accepted.map((entry) => entry.name),
    desiredState: "disabled",
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  }
}
