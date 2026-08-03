// ext-package-uninstall — REQ-128 `#698`:整包卸载,以及 update 时**离场 child** 的实物清除。
//
// 为什么必须有这个入口:`#706` 之后,一个属于 Bundle 的 child 被直接卸载会被响亮拒绝
// (「owned by bundle:pkg@digest — uninstall the package instead」)。在本票之前,那句话指向的
// 「the package」根本不存在 —— 用户装完一个 Bundle 就再也删不掉它。这是一条**用户可达的死路**,
// 不是一个待办的增强。
//
// ── 顺序(这是本模块唯一重要的东西)──────────────────────────────────────────────────────────
//
//   ① **判决**(`planPackageUninstallV1`):读**一次**账本,跑与写盘期**同一条**校验
//      (`readPackageLedgerStateV1` 里的 `validateV3State` + `validatePackageMutationScopeV1`),
//      逐 child 算「释放本包 owner 之后还剩谁」。只读。
//   ② **删实物**(`removePackageChildArtifactsV1`):只删判决为 `delete` 的那些,幂等。
//   ③ **一次** root `PackageLedgerMutationV1`。
//
// review R1 Blocker 2 修正的正是 ①:此前判决期只解析不校验,于是一本带 dangling claim /
// unknown child / 孤儿 owner 的账本会让计划顺利通过、实物被真删,直到 ③ 才拒 —— 「先动实物、
// 后做判决」。现在 `applyPackageMutation` 会拒的每一种账本状态,①都已经拒过了。
//
// **update 的顺序与这里不同,而且必须不同**:它有事务。离场 child 的实物删除挂在
// `commitTransactionLedger` 里、账本 mutation 成功之后 —— 因为引擎在 receipt commit 之前
// 都还会 `rollbackAll`,在那之前删就会造出「事务回滚了、实物却没了」。两条路径的共同规则是
// **destroy 一律晚于那条路径上最后一个可能改变判决的检查**,而不是「都写成同一个顺序」。
//
// ── 崩溃语义:账本自己就是恢复点 ─────────────────────────────────────────────────────────────
//
// 本路径**不**走 `uninstallExtensionTransaction` 的 journal,这是一条有意的、有界的偏离,理由
// 是可验证的而不是省事:那个引擎持 bundle 锁跑 `removeArtifacts`,而 agent 与 MCP 的配置删除
// 内部会再取**同一把**锁(`withConfigWriteLock`,非重入)⇒ 整包卸载会以「config busy」失败。
// 把每个 child 的实物删除各自包一次 `uninstallExtensionTransaction` 又回到 `#706` 消灭掉的形状:
// 各自一把锁、各自一份 journal、各自一次去账。
//
// 代替它的不变量是:**账本在 ③ 之前逐字不变,而 ① 与 ② 都幂等**。于是 ② 失败时盘面是
// 「图还在(用户看得见这个包)+ 若干实物已经不在」,用户再点一次「移除」就收敛 —— 这与今天
// skill/agent 直接卸载的失败语义**逐字相同**(那条路径同样没有 journal)。
//
// **已知残余窗口**(review R2 更正了我上一版的说法,那版是错的):
// ② 与 ③ 之间**不需要任何其它进程参与**就可能失败 —— ③ 里 `writeLedgerFile` 会先收窄 skill 允许集
// (pre-shrink),再做 tmp→rename 的原子写,这两步都可能因 I/O 或权限失败。届时盘面是
// **实物已缺失、旧账本尚存**。我上一版把触发条件写成「另一个进程改了账本」,不属实。
//
// 为什么仍然选这个顺序:反过来(先 ③ 后 ②)的失败态更差。图一旦消失就再也算不出该删哪些 child,
// 而残留的 `mcp.<name>` 配置会让一个没人认领的 server 继续跑 —— 从「可重试」变成「卡死且在跑」。
// 现在这个方向的残留是「实物没了、账本还在」:用户再点一次「移除」就收敛(① 与 ② 都幂等)。
// 今天的 `uninstallByKey` 对 skill/agent 走的是同一顺序、同一暴露面。
//
// update 之所以能做得更好,是因为它有事务:那里的 config 清除是普通事务项,由 before-image 回滚
// 兜底(见 `buildDepartingChildConfigItemsV1`)。卸载没有事务,所以这条不是纪律问题,是结构差异。

import * as fs from "node:fs"
import * as path from "node:path"
import { agentConfigItemKey, agentInstallKey } from "./ext-agent-install"
import { removeOwnedGenerationStoreInLock } from "./ext-transaction"
import { skillGenerationKey, skillStorePaths } from "./ext-skill-generations"
import {
  packageChildTxKeyV1,
  packageVersionFromRecordsV1,
  planPackageChildRemovalsV1,
  uninstallDiffV1,
  planPackageClaimTransferV1,
  type PackageChildRemovalVerdictV1,
} from "./ext-package-lifecycle"
import { validatePackageMutationScopeV1, type PackageGraphV1, type PackageLedgerMutationV1 } from "./ext-package-ledger-v3"
import { applyPackageMutation, findRecordV2, readPackageLedgerStateV1 } from "./ext-receipt-v2"

/** 实物删除需要的注入面。刻意是 `PlannerInstallers` 的**子集**(同名同签名)—— 生产接线传的就是
 *  同一组实现,测试传的是同一组假件,于是「卸载真的会删东西」这件事在两边是同一个意思。 */
export type PackageArtifactInstallersV1 = {
  removeFsInstall(type: "skill" | "agent", name: string, target?: { scope: "global" }): { ok: true; files?: string[] } | { ok: false; reason: string }
  removeMcpConfig(name: string): { ok: true } | { ok: false; reason: string }
  removeMcpSecretsStrict(name: string): { ok: true } | { ok: false; reason: string }
  releaseAlphaConnectionBindings(componentId: string): { ok: true } | { ok: false; reason: string }
  removeInstallGrants(root: string, keys: string[]): { ok: true; removed: string[] } | { ok: false; reason: string }
  /** `#809`:managed plugin 的 `plugin[]` 条目摘除。与 `PlannerInstallers.removePluginPath` 同名
   *  同签名(`uninstallByKey` 的 plugin 臂用的就是它)—— 两条卸载路径摘的必须是同一个东西,
   *  且按**引擎解析语义**等值,不是词法比较。 */
  removePluginPath(name: string, absJsPath: string): { ok: true } | { ok: false; reason: string }
}

export type PackageArtifactRemovalV1 =
  | { ok: true; removed: string[]; warnings: string[] }
  | { ok: false; reason: string; removed: string[]; warnings: string[] }

/**
 * 删掉这些 child 的实物。**零账本副作用** —— 账本只由调用方的那一次 root mutation 提交。
 *
 * 每一种 kind 的动作与 `uninstallByKey` 的对应分支逐条对齐(同样的原语、同样的顺序、同样的
 * 「失败即失败」),因为「在 Bundle 里装的」与「单装的」删的必须是同一堆东西。任何一件删不掉
 * 就整体失败并**立刻返回** —— 继续删下去只会扩大「实物没了、账本还在」的面。
 */
export function removePackageChildArtifactsV1(
  root: string,
  children: ReadonlyArray<{ kind: string; name: string }>,
  installers: PackageArtifactInstallersV1,
  /**
   * `#698`(review R2):**update** 传 `skipConfig: true` —— 那条路径上离场 child 的 config 键
   * 已由事务自己的 config item 删掉(在引擎的锁与 before-image 回滚里),这里再去碰配置就会
   * 重入 `withConfigWriteLock`。整包卸载不传:它没有事务,配置删除本来就归它,且它在锁外跑。
   */
  options?: { skipConfig?: boolean },
): PackageArtifactRemovalV1 {
  const removed: string[] = []
  const warnings: string[] = []
  for (const child of children) {
    if (child.kind === "skill") {
      // generation-backed skill:受控 ext-store 是真源(`uninstallByKey` 同判据)。
      if (fs.existsSync(skillStorePaths(root, child.name).store)) {
        const store = removeOwnedGenerationStoreInLock(root, skillGenerationKey(child.name))
        removed.push(...store.removed)
        warnings.push(...store.warnings)
        if (!store.ok) return { ok: false, reason: store.reason, removed, warnings }
        continue
      }
      const flat = installers.removeFsInstall("skill", child.name, { scope: "global" })
      if (!flat.ok) return { ok: false, reason: `skill:${child.name}: ${flat.reason}`, removed, warnings }
      removed.push(...(flat.files ?? []))
      const grants = installers.removeInstallGrants(root, [skillGenerationKey(child.name)])
      if (!grants.ok) return { ok: false, reason: `skill:${child.name}: ${grants.reason}`, removed, warnings }
      removed.push(...grants.removed)
      continue
    }
    if (child.kind === "agent") {
      const fsOut = installers.removeFsInstall("agent", child.name, { scope: "global" })
      if (!fsOut.ok) return { ok: false, reason: `agent:${child.name}: ${fsOut.reason}`, removed, warnings }
      removed.push(...(fsOut.files ?? []))
      const grants = installers.removeInstallGrants(root, [agentInstallKey(child.name), agentConfigItemKey(child.name)])
      if (!grants.ok) return { ok: false, reason: `agent:${child.name}: ${grants.reason}`, removed, warnings }
      removed.push(...grants.removed)
      continue
    }
    if (child.kind === "mcp") {
      // 顺序与 `uninstallByKey` 的 MCP 分支同:config 先消失(残留密钥不可达),再吊销密钥。
      if (!options?.skipConfig) {
        const cfg = installers.removeMcpConfig(child.name)
        if (!cfg.ok) return { ok: false, reason: `mcp:${child.name}: ${cfg.reason}`, removed, warnings }
      }
      const sec = installers.removeMcpSecretsStrict(child.name)
      if (!sec.ok) return { ok: false, reason: `mcp:${child.name}: ${sec.reason}`, removed, warnings }
      const grants = installers.removeInstallGrants(root, [packageChildTxKeyV1("mcp", child.name)])
      if (!grants.ok) return { ok: false, reason: `mcp:${child.name}: ${grants.reason}`, removed, warnings }
      removed.push(...grants.removed)
      // `#704`:**只释放绑定**,绝不 disconnect/revoke —— 连接是共享的,真实撤销在 provider 那边。
      // 释放失败不阻断卸载(陈旧绑定只让连接看起来还被用着,那是保守方向)。
      const released = installers.releaseAlphaConnectionBindings(`mcp:${child.name}`)
      if (!released.ok) warnings.push(`connection binding not released for mcp:${child.name}: ${released.reason}`)
      continue
    }
    if (child.kind === "plugin") {
      // 落点是**内容寻址**的(`plugins/<name>@<payload digest 前16>/`)—— 名字算不出目录。
      // 唯一的真源是账本 record 的 `configKey`(`plugin-path:<abs>`),它由 `buildPluginTxItems`
      // 在同一次事务里写下,而账本此刻**逐字未动**(mutation 是步骤 ③)。`uninstallByKey` 的
      // plugin 臂读的是同一个字段、跑的是同一道圈禁判据 —— 「在 Bundle 里装的」与「单装的」
      // 删的必须是同一堆东西。
      const record = findRecordV2(root, "plugin", child.name)
      const configKey = record?.configKey ?? ""
      if (!configKey.startsWith("plugin-path:"))
        return {
          ok: false,
          reason: `plugin:${child.name}: ledger record has no plugin-path configKey — cannot prove which file to remove (fail closed)`,
          removed,
          warnings,
        }
      const pluginsRoot = path.join(root, "plugins")
      const ledgerJs = path.resolve(configKey.slice("plugin-path:".length))
      const ledgerDir = path.dirname(ledgerJs)
      const dirBase = path.basename(ledgerDir)
      // 账本路径不可指向树外(与 `uninstallByKey` 的 plugin 臂逐条同判):否则一条被改过的
      // 账本就是一个任意目录删除通道。
      if (
        path.basename(ledgerJs) !== "plugin.js" ||
        path.dirname(ledgerDir) !== pluginsRoot ||
        !(dirBase === child.name || dirBase.startsWith(`${child.name}@`))
      )
        return {
          ok: false,
          reason: `plugin:${child.name}: ledger plugin path "${ledgerJs}" is not under "${pluginsRoot}/${child.name}[@…]" — refusing (fail closed)`,
          removed,
          warnings,
        }
      // `skipConfig` 对 plugin **不适用**,刻意不接:传它的是 update 那条路径,而离场 child 的
      // config 清除(`buildDepartingChildConfigItemsV1`)只覆盖 `agent.<name>` / `mcp.<name>`
      // 两个**映射键**;`plugin[]` 是数组,那里没有对应的 item。照 mcp 的姿势跳过 config 就会
      // 留下一条指向已删目录的加载路径。本函数在事务**返回之后**跑(锁已释放),`removePluginPath`
      // 自取 config 写锁不会重入。
      const cfg = installers.removePluginPath(child.name, ledgerJs)
      if (!cfg.ok) return { ok: false, reason: `plugin:${child.name}: ${cfg.reason}`, removed, warnings }
      try {
        fs.rmSync(ledgerDir, { recursive: true, force: true })
      } catch {
        /* best-effort:config 已净除,残留目录已不可加载 */
      }
      removed.push(ledgerDir)
      const grants = installers.removeInstallGrants(root, [packageChildTxKeyV1("plugin", child.name)])
      if (!grants.ok) return { ok: false, reason: `plugin:${child.name}: ${grants.reason}`, removed, warnings }
      removed.push(...grants.removed)
      continue
    }
    // 认不出的 kind 一律响亮拒绝 —— 「跳过不认识的」会让那件东西的实物永远留下,
    // 而它的 record 已经被去掉了。
    return { ok: false, reason: `no artifact removal seam for package child kind "${child.kind}" — refusing (fail closed)`, removed, warnings }
  }
  return { ok: true, removed, warnings }
}

export type PackageUninstallPlanV1 =
  | {
      ok: true
      packageId: string
      graph: PackageGraphV1
      owner: string
      verdicts: PackageChildRemovalVerdictV1[]
      mutation: PackageLedgerMutationV1
    }
  | { ok: false; reason: string }

const PACKAGE_ID_INTENT = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$/

/**
 * 整包卸载的**只读**判决(步骤 ①)。产出的 `mutation` 是最终会被提交的那一份 —— preview 与提交
 * 因此看的是同一个对象,而不是两次各算一遍的两份。
 */
export function planPackageUninstallV1(root: string, packageId: string, transactionId: string): PackageUninstallPlanV1 {
  if (typeof packageId !== "string" || !PACKAGE_ID_INTENT.test(packageId))
    return { ok: false, reason: `package uninstall: invalid packageId ${JSON.stringify(packageId)}` }
  const state = readPackageLedgerStateV1(root)
  if (!state.ok) return { ok: false, reason: `package uninstall: ${state.reason}` }
  const graph = state.packageGraphs.find((candidate) => candidate.packageId === packageId)
  if (!graph) return { ok: false, reason: `package uninstall: "${packageId}" is not installed in this ledger` }
  // `#764`:整包卸载的 diff 也带上「正在卸的是哪个版本」。来源与 update preview 同一条 ——
  // root 组件的 v2 record,同一次账本读。留空会让这里长出第二个恒 null 的版本栏。
  const diff = uninstallDiffV1(graph, packageVersionFromRecordsV1(graph, state.records))
  const owner = diff.ownerBefore!
  const verdicts = planPackageChildRemovalsV1({
    departing: diff.changes.map((change) => ({ kind: change.kind, name: change.name })),
    ownerBefore: owner,
    claims: state.claims,
    recordKeys: state.recordKeys,
  })
  const mutation: PackageLedgerMutationV1 = {
    transactionId,
    operation: "uninstall",
    graphBeforeDigest: graph.installedGraphDigest,
    graphAfter: null,
    childRecordMutations: verdicts
      .filter((verdict) => verdict.decision === "delete")
      .map((verdict) => ({ op: "remove" as const, kind: verdict.kind, name: verdict.name })),
    claimMutations: planPackageClaimTransferV1(diff),
  }
  // review R1 Blocker 2 的第二半:把写盘期会跑的作用域闸**提前到判决期**跑一遍(同一个函数,
  // 不是另写一份等价判据)。这样「这份 mutation 会不会被账本拒」在删任何实物之前就有答案;
  // 留到写盘期才发现,实物已经没了而账本还是旧的。
  const scope = validatePackageMutationScopeV1(mutation, graph)
  if (!scope.ok) return { ok: false, reason: `package uninstall: ${scope.reason}` }
  return { ok: true, packageId, graph, owner, verdicts, mutation }
}

export type PackageUninstallOutcomeV1 =
  | {
      ok: true
      packageId: string
      /** 真的被删掉的 child(实物 + record + claim)。 */
      removed: Array<{ kind: string; name: string }>
      /** 留下来的 child 及其具名理由(共享 / 用户自己装过 / legacy / 不受管)。 */
      retained: PackageChildRemovalVerdictV1[]
      files: string[]
      warning?: string
    }
  | { ok: false; reason: string; stage: "plan" | "artifacts" | "ledger" }

export type PackageUninstallDepsV1 = {
  globalRoot: () => string
  installers: PackageArtifactInstallersV1
  newTransactionId?: () => string
}

/**
 * 整包卸载的生产入口。renderer 只运输 packageId;要删什么、能不能删,全部由 main 从**自己的账本**
 * 重新算(与 `uninstallByKey` 同一信任边界:调用方给不出 receipt、给不出路径、给不出 owner)。
 */
export function uninstallPackageV1(rawPackageId: unknown, deps: PackageUninstallDepsV1): PackageUninstallOutcomeV1 {
  const root = deps.globalRoot()
  const txId = (deps.newTransactionId ?? defaultTransactionId)()
  const planned = planPackageUninstallV1(root, typeof rawPackageId === "string" ? rawPackageId : "", txId)
  if (!planned.ok) return { ok: false, reason: planned.reason, stage: "plan" }

  const doomed = planned.verdicts.filter((verdict) => verdict.decision === "delete")
  const artifacts = removePackageChildArtifactsV1(root, doomed, deps.installers)
  if (!artifacts.ok)
    return {
      ok: false,
      // 账本此刻**逐字未动**:图还在,重试会重新算出同一份判决,而已删掉的部分是幂等的。
      reason: `package uninstall: ${artifacts.reason} — the ledger is unchanged; retry (idempotent)`,
      stage: "artifacts",
    }

  const written = applyPackageMutation(root, planned.mutation)
  if (!written.ok) return { ok: false, reason: `package uninstall: ledger commit failed: ${written.reason}`, stage: "ledger" }

  const warnings = [...artifacts.warnings, ...written.warnings]
  return {
    ok: true,
    packageId: planned.packageId,
    removed: doomed.map((verdict) => ({ kind: verdict.kind, name: verdict.name })),
    retained: planned.verdicts.filter((verdict) => verdict.decision === "retain"),
    files: artifacts.removed,
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  }
}

function defaultTransactionId(): string {
  return `pkg-uninstall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
