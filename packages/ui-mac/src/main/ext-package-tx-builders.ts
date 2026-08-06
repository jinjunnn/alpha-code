// ext-package-tx-builders — REQ-128 #705:把「一个已接受的 package 组件 → 一次事务里的那几条 item」
// 从 package-admission 的执行体里抽成**纯计划构造**。
//
// 为什么:Bundle(#697)要把 skill + agent + mcp 的 item 拼进**同一次** runExtensionTransaction。
// 单装时代这三段构造内联在 executePreparedPackage 里,与「执行」纠缠在同一个函数(构造 → 立即跑事务
// → 立即判结果)。若 Bundle 另写一套构造,就会出现两套 plan 真源:同一个组件单装与在 Bundle 里装
// 出来的 item / receipt / probe 不同,而这种偏差只在真机重启后以「装得上但恢复期判不健康」现身。
//
// 本模块只回答「计划长什么样」:items、receipt(引擎透传的账本模板)、populate(把内容写进 staging)、
// precondition(锁内业务前置)、probe(唯一 typed probe router)、以及受限 prepared resource 的
// 类型化描述符(MCP 版本化密钥)。**不执行**:锁、授权闸、staging、switch、账本提交仍只归
// runExtensionTransaction 与调用方。#712 会把 prepared descriptor 落进 journal,形状在此先定。
//
// 纪律:构造期的读盘(账本在册判定、live MCP 叶 strict 读、server 形状校验)保持与单装同序同点位 ——
// 它们决定 requireAbsent / 拒绝理由,挪位就是行为变化。

import { lstatSync } from "node:fs"
import { join, posix } from "node:path"
import {
  claimMcpSecretVersionDir,
  mcpSecretVersionedRef,
  writeMcpSecretVersioned,
} from "./alpha-mcp-secrets"
import { readMcpLeafStrict, validateServer } from "./ext-config"
import { agentConfigItemKey } from "./ext-agent-install"
import { populateFromCas } from "./ext-cas"
import { extensionHealthProbeRouter } from "./ext-health-probe-router"
import { findRecordV2, probeLedgerForWrite, type UpsertInput } from "./ext-receipt-v2"
import type { HealthProbe, HealthVerdict, TxFileSpec, TxPlanItem, TxPreparedResourceV1 } from "./ext-transaction"
import {
  SKILL_MD_PATH,
  type PackageProfilePayloadV1,
} from "../shared/host-extension-package-contract/decoder"
import {
  packageSecretReferenceV1,
  type PackageSecretPrerequisiteProfileV1,
} from "../shared/package-secret-prerequisite"

/** 受限 prepared resource 的计划面(#705 定形状;#712 落 journal)。
 *
 *  `descriptor` 是**唯一**会被持久化的东西:类型化身份(store/server/version),进事务 journal,
 *  崩溃恢复据它释放。`files` 与两个闭包只活在本进程内 —— 明文、绝对路径都不进 journal/receipt/log。 */
export type PreparedMcpSecretVersionV1 = {
  /** 进 journal 的类型化身份(引擎 TxPlan.prepared;只此四字段,多一个字段引擎就拒计划)。 */
  descriptor: TxPreparedResourceV1
  /** 版本目录内的密钥文件绝对路径 —— **仅进程内**服务 populate/probe;绝不进 journal。 */
  files: string[]
  /** 授权终闸之后、任何 live switch 之前填充(引擎 populatePrepared)。失败抛错 = 零 live 变更。 */
  populate: () => void
  /** 候选探测(引擎 probePrepared);失败同样发生在 switch 之前。 */
  probe: () => HealthVerdict
}

/** 一个组件在事务里的完整计划面。调用方只负责拼进 TxPlan 并执行。 */
export type PackageTxBuildV1 = {
  items: TxPlanItem[]
  /** 与 items 中主 item 共享同一对象(引擎透传进 journal;builder 会补 files/configKey)。 */
  receipt: UpsertInput
  populate: (item: TxPlanItem, stagingDir: string) => void
  precondition: () => { ok: true } | { ok: false; reason: string }
  probe: HealthProbe
  prepared?: PreparedMcpSecretVersionV1
}

export type PackageTxBuildResultV1 = { ok: true; build: PackageTxBuildV1 } | { ok: false; reason: string }

type CommonInput = {
  root: string
  /** fs-safe 事务 key(授权账/journal/store 同键)。 */
  key: string
  name: string
  capabilities: string[]
  /** `sha256:<hex>`,本层不解释、只透传。 */
  manifestDigest: string
  /** 账本模板(调用方按已验事实构造;builder 只补 files / configKey)。 */
  receipt: UpsertInput
}

/**
 * `#698`(review R2):离场 child 的 **config 清除**,表达成普通的事务计划项。
 *
 * 为什么是这个形状,而不是提交后的一条接缝(前两版都被证伪):
 *   · 放事务**外**(R1 前)⇒ 事务回滚时实物已删,半态;
 *   · 放事务**内的 commitReceipt**(R1 后)⇒ 引擎正持着 root bundle 锁,而 agent/MCP 的配置删除
 *     内部要取**同一把非重入锁**(`ext-config.ts` `withConfigWriteLock`)⇒ Agent/MCP 清理必然失败,
 *     而账本已 durable ⇒ 吞掉 warning 报成功。
 *
 * config 编辑本来就是事务自己的东西:`prepareConfigTx` 在**计划期、进程内**把 edits 塌缩成
 * pre/next 整文件 image(journal 只落 digest,`value: undefined` 不需要活过 JSON),apply 在 switch
 * 阶段、restore 走 before-image。所以离场 child 的 config 清除不需要第二把锁、不需要提交后接缝,
 * 原子性由构造保证。已执行验证:同一 target 上「新增 + 删除」两条 item 提交后键消失且无关键不动;
 * receipt commit 失败回滚后被删的键**逐字回来**。
 *
 * skill 不出 config item:它的启用面是账本派生的允许集(`writeLedgerFile` 按 records 重算),
 * 随同一次 `applyPackageMutation` 一起变 —— 再造一条 config item 就是第二个真源。
 */
export function buildDepartingChildConfigItemsV1(input: {
  root: string
  children: ReadonlyArray<{ kind: string; name: string }>
}): TxPlanItem[] {
  const items: TxPlanItem[] = []
  for (const child of input.children) {
    // keyPath 与 target 与**安装侧逐字同源**(见上面两个 builder):写第二份就是替配置文法造替身。
    if (child.kind === "agent")
      items.push({
        key: `${agentConfigItemKey(child.name)}--departing`,
        action: "config",
        config: { target: join(input.root, "alpha.jsonc"), edits: [{ keyPath: ["agent", child.name], value: undefined }] },
      })
    else if (child.kind === "mcp")
      items.push({
        key: `mcp--${child.name}--departing`,
        action: "config",
        config: { target: join(input.root, "alpha.jsonc"), edits: [{ keyPath: ["mcp", child.name], value: undefined }] },
      })
  }
  return items
}

export type SkillTxBuildInputV1 = CommonInput & {
  /**
   * `#828`:技能载荷**已提升进验证共享 CAS** 之后的 spec 清单(`promotePayloadToCas` 的产物)。
   *
   * 为什么是 spec 而不是 Buffer:那个函数的第一遍(路径安全 / 大小写折叠碰撞 / Windows 保留名 /
   * 重复 / bytes 精确)是**本仓这套路径文法的唯一所有者**,且校验失败时 CAS 零写入。
   * 在这里改收 Buffer 再自己写 staging,等于把那一遍换成一条自己拼的等价链 —— 而 `../` 这类
   * 路径会在 `verifyStagedItem` 走目录之前就已经写到 staging 之外去了。
   */
  assetFiles?: TxFileSpec[]
  /** CAS 基根;populate 走既有的 `populateFromCas`,不自己写文件。 */
  casBaseRoot?: string
}
export type AgentTxBuildInputV1 = CommonInput & { asset?: Buffer; agentEntry?: Record<string, unknown> }
export type McpTxBuildInputV1 = CommonInput & {
  userDataPath: string
  payload: PackageProfilePayloadV1
  prerequisite: PackageSecretPrerequisiteProfileV1
  /** 用户本次提交的密钥明文(只在 populate 闭包内用,不进描述符、不进 receipt)。 */
  secretValues: Record<string, string>
  /** 版本号发生器(注入以便测试固定;生产 = newMcpSecretVersionId)。 */
  newSecretVersionId: () => string
}

/** 计划无法构造(缺资产/缺解析结果)时的统一理由 —— 与 #705 之前 planItems 为空的落点逐字相同。 */
const NO_PLAN = "package profile could not produce a transaction plan"

/**
 * skill:单 generation item —— **整份文件清单**写进 staging,probe 验 `SKILL.md` frontmatter 与 key 一致。
 *
 * `#828` 之前这里把 `files` 与 populate **各写死一次** `SKILL.md`,于是签名 package 这条路
 * 结构上装不了多文件技能(真实语料 40/162),装完是残件而安装全绿。现在两处都由同一份
 * `assetFiles` 派生 —— **一份清单,两个消费者**,不可能再各自漂。
 *
 * populate 走既有的 `populateFromCas`(`ext-cas.ts`),与 Phase 3 本地导入路径
 * (`claude-plugin-install.ts`)是同一个函数:那边当初正是因为本函数写死 `SKILL.md` 才不敢复用它。
 */
export function buildSkillTxItems(input: SkillTxBuildInputV1): PackageTxBuildResultV1 {
  const assetFiles = input.assetFiles
  const casBaseRoot = input.casBaseRoot
  if (!assetFiles?.length || !casBaseRoot) return { ok: false, reason: NO_PLAN }
  // 锚点在解码期已是合同项(`decoder.ts` 的 `decodeSkillAssetFiles`)。这里再判一次是纵深:
  // 本函数还有别的调用方时,缺 SKILL.md 的计划会在**构造期**被具名拒绝,而不是先建 generation
  // 再让 pre-switch probe 判不健康(那条路要多走一次下载 + CAS 提升 + materialize)。
  if (!assetFiles.some((file) => file.path === SKILL_MD_PATH))
    return { ok: false, reason: `skill payload has no ${SKILL_MD_PATH}` }
  const items: TxPlanItem[] = [
    {
      key: input.key,
      files: assetFiles,
      manifestDigest: input.manifestDigest,
      capabilities: input.capabilities,
      receipt: input.receipt,
    },
  ]
  const populate = populateFromCas(casBaseRoot)
  return {
    ok: true,
    build: {
      items,
      receipt: input.receipt,
      populate: (item, stagingDir) => populate({ files: item.files ?? [] }, stagingDir),
      precondition: () => probeLedgerForWrite(input.root),
      probe: extensionHealthProbeRouter(input.root),
    },
  }
}

/** agent:file(md 内容真源)+ config(`agent.<name>` 生效叶)双 item 单事务;授权与账本只挂主 item。 */
export function buildAgentTxItems(input: AgentTxBuildInputV1): PackageTxBuildResultV1 {
  const asset = input.asset
  const agentEntry = input.agentEntry
  if (!asset || !agentEntry) return { ok: false, reason: NO_PLAN }
  const receipt = input.receipt
  const relTarget = posix.join("agents", `${input.name}.md`)
  receipt.files = [join(input.root, relTarget)]
  receipt.configKey = `agent.${input.name}`
  const items: TxPlanItem[] = [
    {
      key: input.key,
      action: "file",
      file: {
        relTarget,
        next: asset,
        // fresh-only:在册才允许带前像覆盖(锁内 requireAbsent 断言,封锁外 TOCTOU)。
        requireAbsent: findRecordV2(input.root, "agent", input.name) === null,
      },
      manifestDigest: input.manifestDigest,
      capabilities: input.capabilities,
      receipt,
    },
    {
      key: agentConfigItemKey(input.name),
      action: "config",
      config: {
        target: join(input.root, "alpha.jsonc"),
        edits: [
          {
            keyPath: ["agent", input.name],
            value: receipt.desiredState === "disabled" ? { ...agentEntry, disable: true } : agentEntry,
          },
        ],
      },
    },
  ]
  return {
    ok: true,
    build: {
      items,
      receipt,
      populate: () => {},
      precondition: () => probeLedgerForWrite(input.root),
      probe: extensionHealthProbeRouter(input.root),
    },
  }
}

/** mcp:单 config item + 版本化密钥 prepared resource;live 叶未在册即拒(不认领、不覆盖)。 */
export function buildMcpTxItems(input: McpTxBuildInputV1): PackageTxBuildResultV1 {
  const receipt = input.receipt
  const secretVersion = input.prerequisite.items.length ? input.newSecretVersionId() : undefined
  const refs = Object.fromEntries(
    input.prerequisite.items.map((item) => [
      item.target.variable,
      mcpSecretVersionedRef(input.userDataPath, input.prerequisite.server, secretVersion!, item.target.variable),
    ]),
  )
  const config =
    input.payload.schema === "alpha.host-extension-package.payload.mcp-local.v1"
      ? {
          type: "local",
          command: input.payload.behavior.command,
          environment: { ...input.payload.behavior.environment, ...refs },
        }
      : input.payload.schema === "alpha.host-extension-package.payload.mcp-remote.v1"
        ? {
            type: "remote",
            url: input.payload.behavior.url,
            headers: Object.fromEntries(
              Object.entries(input.payload.behavior.headersTemplate).map(([header, template]) => [
                header,
                input.prerequisite.items.reduce(
                  (value, item) => value.replaceAll(`{${item.target.variable}}`, refs[item.target.variable]!),
                  template,
                ),
              ]),
            ),
          }
        : undefined
  if (!config) return { ok: false, reason: "profile cannot build an MCP transaction" }
  const valid = validateServer(config)
  if (!valid.ok) return { ok: false, reason: valid.reason }
  receipt.configKey = `mcp.${input.name}`
  const items: TxPlanItem[] = [
    {
      key: input.key,
      action: "config",
      config: {
        target: join(input.root, "alpha.jsonc"),
        edits: [
          {
            keyPath: ["mcp", input.name],
            value: receipt.desiredState === "disabled" ? { ...config, enabled: false } : config,
          },
        ],
      },
      manifestDigest: input.manifestDigest,
      capabilities: input.capabilities,
      receipt,
    },
  ]
  const secretFiles = Object.values(refs).map((ref) => ref.slice("{file:".length, -1))

  const existing = readMcpLeafStrict(input.name)
  if (!existing.ok) return { ok: false, reason: existing.reason }
  if (existing.value && !findRecordV2(input.root, "mcp", input.name))
    return { ok: false, reason: "unregistered MCP config is not adopted or overwritten" }

  const prepared: PreparedMcpSecretVersionV1 | undefined = secretVersion
    ? {
        descriptor: {
          kind: "mcp-secret-version",
          store: "alpha-mcp-secrets",
          server: input.prerequisite.server,
          version: secretVersion,
        },
        files: secretFiles,
        populate: () => {
          const claimed = claimMcpSecretVersionDir(input.userDataPath, input.prerequisite.server, secretVersion)
          if (!claimed.ok) throw new Error(claimed.reason)
          for (const item of input.prerequisite.items) {
            const reference = packageSecretReferenceV1(input.prerequisite, item.prerequisiteId, secretVersion)
            if (!reference) throw new Error(`invalid secret reference for ${item.prerequisiteId}`)
            const written = writeMcpSecretVersioned(
              input.userDataPath,
              reference.server,
              reference.version,
              reference.variable,
              input.secretValues[item.prerequisiteId]!,
            )
            if (!written.ok) throw new Error(written.reason)
          }
        },
        probe: () => ({
          healthy: secretFiles.every((file) => {
            try {
              return lstatSync(file).isFile()
            } catch {
              return false
            }
          }),
          reason: "prepared secret file is missing",
        }),
      }
    : undefined

  return {
    ok: true,
    build: {
      items,
      receipt,
      populate: () => {},
      // 锁内重读:账本可写 + live 叶仍未被未登记配置占用(封死锁外读的 TOCTOU)。
      precondition: () => {
        const ledger = probeLedgerForWrite(input.root)
        if (!ledger.ok) return ledger
        const current = readMcpLeafStrict(input.name)
        if (!current.ok) return current
        if (current.value && !findRecordV2(input.root, "mcp", input.name))
          return { ok: false, reason: "unregistered MCP config appeared before commit" }
        return { ok: true }
      },
      probe: extensionHealthProbeRouter(input.root),
      ...(prepared ? { prepared } : {}),
    },
  }
}
