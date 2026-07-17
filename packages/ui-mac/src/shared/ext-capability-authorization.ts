/**
 * capability→authorize 的 IPC wire 形状(REQ-100 #348)。main 是授权语义的唯一真源
 * (ext-capability-grants / ext-transaction);此处只放可序列化 DTO,供 main、preload、
 * renderer 三方共用,避免手工镜像漂移。运行时校验仍在 main(意图严格解码 + 引擎 validatePlan)。
 */

/** capability 枚举白名单 —— 真源自 ext-manifest-v2 上移至此(REQ-104 #396):main 解码期白名单、
 *  #348 确认框派生(planner)与 Pack 整包事实派生(renderer)共用同一定义,三方永不漂移。 */
export const MANIFEST_CAPABILITIES = [
  "prompt:context", // 文本注入(skill/agent)
  "engine:config", // 写引擎配置条目
  "engine:plugin", // 在引擎进程内执行 JS
  "process:spawn", // 派生本机子进程(local MCP)
  "network:remote", // 连接远程服务(remote MCP)
  "cloud:dispatch", // 云 pipeline 派发
] as const
export type ManifestCapability = (typeof MANIFEST_CAPABILITIES)[number]

/** 能力派生所需的最小条目形状(结构类型,shared 不依赖 renderer catalog-types —— ext-ownership
 *  的 OwnershipCatalogEntryLike 同款先例)。 */
export type CapabilityEntryLike = { type: string; installSpec?: { kind?: string; mcpType?: string } }

/** 按目录条目类型派生能力集(6 枚举语义,非作者自报)。#348 安装确认框(经 planner)与
 *  #396 Pack 整包事实(renderer)的同一真源 —— 两处展示/授权永不漂移(v5 稿硬约束)。 */
export function capabilitiesForCatalogEntry(entry: CapabilityEntryLike): ManifestCapability[] {
  if (entry.type === "mcp") {
    const spec = entry.installSpec
    return spec?.kind === "mcp" && spec.mcpType === "remote" ? ["network:remote", "engine:config"] : ["process:spawn", "engine:config"]
  }
  if (entry.type === "plugin") return ["engine:plugin", "engine:config"]
  if (entry.type === "agent") return ["prompt:context", "engine:config"]
  if (entry.type === "skill") return ["prompt:context"]
  if (entry.type === "cloud") return ["cloud:dispatch"]
  return []
}

/** 引擎锁内评估的逐 item 能力差异(main/ext-capability-grants.CapabilityDiff 的 wire 同形)。
 *  previous === null = 盘上无授权基线(首装/不可读,fail-closed 视为首装)。 */
export type CapabilityDiffWire = {
  key: string
  previous: string[] | null
  requested: string[]
  added: string[]
  removed: string[]
  requiresConfirmation: boolean
}

/** renderer 唯一能表达的授权事实:「对哪些 item 确认了哪个完整能力集」(展示什么确认什么,
 *  防 TOCTOU;引擎按 requested ⊆ confirmed[key] 整集覆盖判定)。decidedAt 是审计事实,
 *  由 main 收到确认后打戳 —— renderer 无通道提供。 */
export type AuthorizationConfirmationWire = {
  confirmed: Record<string, string[]>
}

/** 事务阶段(authorize 之外)的 wire 枚举 —— 本模块是唯一定义点,`ext-transaction.TxStage`
 *  由此拼装("authorize" | 本类型),preload/renderer 失败分支据此成为**真**判别联合:
 *  `stage:"authorize"` 只可能出现在强制携带 diff 的分支上,中间层折叠丢字段过不了类型检查。 */
export type TxStageNonAuthorizeWire =
  | "validate"
  | "lock"
  | "precondition"
  | "staging"
  | "verify"
  | "materialize"
  | "pre-switch-probe"
  | "switch"
  | "post-switch-probe"
  | "receipt-commit"
