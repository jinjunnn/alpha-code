// hub-tools — REQ-234 `#1531`(基线 §2.1 / §2.3 / §2.4,不变量 I2 / I3 / I7 / I8 / I9):agent 的三个定制中心工具。
//
// agent 只发请求、只读结论:状态与目录都由 main 即时计算(经 hub-bridge 的 parentPort 窄消息),安装只经引擎自己的审批请求
// (`ctx.ask`)运输到 renderer —— 那边弹定制中心**自己的**安装确认框,用户在框里点同意、在框里填密钥,安装由框发起。
// 本模块不安装任何东西,也够不着任何写通道。
//
//   hub_search(query)    —— 本目录视图(可安装目录 ∪ 已安装),按 query 过滤
//   hub_install(catalogId)—— ctx.ask 运输确认请求;醒来后按 requestId 向 main 查这一次请求走到哪一步,返回固定结论之一
//   hub_status(catalogId) —— 单条的档与原因
//
// I2:三个工具的参数只有字符串标识(`query` / `catalogId`),没有任何密钥形状的字段;返回值只含视图字段(变量名、状态、原因)。
// I3:确认框一定会出现 —— pinHubInstallPermission 在每次实例重建时把 `hub_install: ask` 钉到全局与每个 agent 的末位
//     (默认规则是 `*: allow`,不钉就不弹框);即便被绕过(规则放行),安装也只由确认框发起 ⇒ 查不到记录 ⇒ 如实说没装。
// I7:`always: []` —— 用户点「始终允许」也不会产生能抵消下一次 hub_install 的 grant。
// I9:审批应答只负责唤醒工具;结局以 main 记录的 requestId 阶段为准 —— 用户已确认、主进程还在提交时期限到了,
//     工具说的是「已提交,结果待定」,不是「用户拒绝」。

import { randomUUID } from "node:crypto"
import { tool } from "@opencode-ai/plugin"
import type { HubRequestRecord, HubView, HubViewRow } from "../../ui-mac/src/main/alpha-sidecar-messages"
import { TOOL_TEXT } from "./context-injection"
import type { BridgeFailure, HubBridge } from "./hub-bridge"

/** hub_install 的固定结论(逐字;基线 §2.1)。 */
export const HUB_INSTALL_OUTCOME = {
  declined: "declined",
  reloadPending: "installed; reload pending",
  available: "installed; available",
  disabledByPolicy: "installed; disabled by policy",
  submitted: "submitted; result pending",
  noBox: "not installed: no confirmation box ran",
  unknownEntry: "unknown entry",
} as const

/** 每次 hub_install 结论之后的固定提示(约束 5:只对「可用」之后的下一条消息承诺)。 */
export const HUB_NEXT_MESSAGE_HINT =
  "Once it shows available, it can be used from the next message; it does not take effect within this reply."
/** 云条目在场而目录没有价格说明字段时的固定一句(如实报告缺项;不算 AC1 的价格部分已满足,见基线 §4 C5)。 */
export const HUB_PRICE_NOTE_MISSING = "This catalog does not provide price notes yet; charges are determined by the service."
export const HUB_UNAVAILABLE = "The Customization Center is not available in this engine host."

const AGENT_AUTOMATION_PREFIX = "alpha-automation"

/**
 * I3:把 `hub_install` 钉成**末位**规则 —— 全局 `cfg.permission` 与每个 `cfg.agent[*].permission`。引擎按对象插入序展开、
 * `findLast` 求值,所以「只改值不动位置」不够:前面写的 `hub_install: ask` 会被同表后面的 `"*": "allow"` 顶掉;删键再写回 = 移到末位
 * (先例 ui-mac cloud-web-search.ts 的 pinDeny)。无人值守的自动化 agent(`alpha-automation*`,「零 ask」硬前提)钉 deny ——
 * 没有人会看到那个框。用户 / 项目配置里写 `hub_install: allow` 也压不过它。
 */
export function pinHubInstallPermission(cfg: Record<string, unknown>) {
  cfg.permission = pinLast(cfg.permission, "ask")
  const agents = cfg.agent
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return
  for (const [name, agent] of Object.entries(agents as Record<string, unknown>)) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue
    const entry = agent as Record<string, unknown>
    entry.permission = pinLast(entry.permission, name.startsWith(AGENT_AUTOMATION_PREFIX) ? "deny" : "ask")
  }
}

function pinLast(permission: unknown, action: "ask" | "deny"): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof permission === "string"
      ? { "*": permission }
      : permission && typeof permission === "object" && !Array.isArray(permission)
        ? { ...(permission as Record<string, unknown>) }
        : {}
  delete base.hub_install
  base.hub_install = action
  return base
}

export function createHubTools(bridge: HubBridge) {
  return {
    hub_search: tool({
      description: TOOL_TEXT.hub_search.description,
      args: { query: tool.schema.string().describe(TOOL_TEXT.hub_search.args.query).default("") },
      async execute(args, ctx) {
        if (!bridge.available) return result("hub_search", HUB_UNAVAILABLE, { ok: false })
        const answer = await bridge.view({ directory: ctx.directory, sessionID: ctx.sessionID, agent: ctx.agent, query: args.query })
        if (!answer.ok) return result("hub_search", unreachable(answer), { ok: false })
        return result("hub_search", renderRows(answer.view, answer.view.rows), { ok: true, count: answer.view.rows.length })
      },
    }),
    hub_install: tool({
      description: TOOL_TEXT.hub_install.description,
      args: { catalogId: tool.schema.string().describe(TOOL_TEXT.hub_install.args.catalogId) },
      async execute(args, ctx) {
        if (!bridge.available) return result("hub_install", HUB_UNAVAILABLE, { ok: false })
        const catalogId = args.catalogId.trim()
        const before = await bridge.view({ directory: ctx.directory, sessionID: ctx.sessionID, agent: ctx.agent })
        if (!before.ok) return result("hub_install", `not installed: ${unreachable(before)}`, { ok: false, catalogId })
        if (!before.view.rows.some((row) => row.id === catalogId))
          return result("hub_install", `${HUB_INSTALL_OUTCOME.unknownEntry}\nUse hub_search to find the exact id.`, { ok: false, catalogId })
        const requestId = randomUUID().replaceAll("-", "")
        // 应答只负责唤醒;三种醒法(放行 / RejectedError / UnansweredError)一律接住,结局按 requestId 去 main 查。
        let approved = false
        try {
          await ctx.ask({ permission: "hub_install", patterns: [catalogId], always: [], metadata: { alphaHub: { catalogId, requestId } } })
          approved = true
        } catch {
          approved = false
        }
        const stage = await bridge.request(requestId)
        if (!stage.ok) return result("hub_install", `result unknown: ${unreachable(stage)} — check with hub_status`, { ok: false, catalogId, requestId })
        const outcome = await settle(stage.record, approved, catalogId, ctx)
        return result("hub_install", `${outcome}\n${HUB_NEXT_MESSAGE_HINT}`, { ok: true, catalogId, requestId, stage: stage.record?.stage ?? null })
      },
    }),
    hub_status: tool({
      description: TOOL_TEXT.hub_status.description,
      args: { catalogId: tool.schema.string().describe(TOOL_TEXT.hub_status.args.catalogId) },
      async execute(args, ctx) {
        if (!bridge.available) return result("hub_status", HUB_UNAVAILABLE, { ok: false })
        const catalogId = args.catalogId.trim()
        const answer = await bridge.view({ directory: ctx.directory, sessionID: ctx.sessionID, agent: ctx.agent })
        if (!answer.ok) return result("hub_status", unreachable(answer), { ok: false, catalogId })
        const rows = answer.view.rows.filter((row) => row.id === catalogId)
        if (rows.length === 0) return result("hub_status", `${HUB_INSTALL_OUTCOME.unknownEntry}\nUse hub_search to find the exact id.`, { ok: false, catalogId })
        return result("hub_status", renderRows(answer.view, rows), { ok: true, catalogId })
      },
    }),
  }

  /** §2.3 末段:main 记的阶段 → 固定结论。committed 之后再读一次视图取该行(id, scope)此刻的档。 */
  async function settle(
    record: HubRequestRecord | null,
    approved: boolean,
    catalogId: string,
    ctx: { directory: string; sessionID: string; agent: string },
  ): Promise<string> {
    if (!record) return approved ? HUB_INSTALL_OUTCOME.noBox : `${HUB_INSTALL_OUTCOME.noBox} (the request was not answered)`
    if (record.stage === "declined") return HUB_INSTALL_OUTCOME.declined
    if (record.stage === "failed") return `${HUB_INSTALL_OUTCOME.declined}: install failed — ${record.reason ?? "no reason given"}`
    if (record.stage === "confirming") return `${HUB_INSTALL_OUTCOME.declined}: the confirmation was not answered before the request ended`
    if (record.stage === "submitted") return HUB_INSTALL_OUTCOME.submitted
    const after = await bridge.view({ directory: ctx.directory, sessionID: ctx.sessionID, agent: ctx.agent })
    const row = after.ok ? after.view.rows.find((item) => item.id === catalogId && item.scope === (record.scope ?? "global")) : undefined
    if (!row) return `installed; state unknown — check with hub_status`
    if (row.state === "available") return HUB_INSTALL_OUTCOME.available
    if (row.state === "reload-pending") return `${HUB_INSTALL_OUTCOME.reloadPending} (${reasonText(row)})`
    if (row.stateReason?.code === "disabled") return HUB_INSTALL_OUTCOME.disabledByPolicy
    return `installed; not available in this directory yet (${reasonText(row)})`
  }
}

function result(title: string, output: string, metadata: Record<string, unknown>) {
  return { title, output, metadata }
}

function unreachable(failure: BridgeFailure): string {
  return `the Customization Center could not answer (${failure.detail})`
}

/** 给人 / agent 读的原因短句(§2.1 hub_status 行)。 */
function reasonText(row: HubViewRow): string {
  const detail = row.stateReason?.detail
  switch (row.stateReason?.code) {
    case "disabled":
      return "disabled by policy"
    case "reload-waiting":
      return `waiting: ${detail ?? "queued"}`
    case "reload-failed":
      return `last reload failed: ${detail ?? "unknown reason"}`
    case "not-loaded":
      return `not loaded in this directory: ${detail ?? "unknown reason"}`
    default:
      return ""
  }
}

/** 一行一条 JSON(只含视图字段);云条目在场时末尾固定缺项句;main 的 warnings 不原样外发(可能带内部细节),只说视图可能不全。 */
function renderRows(view: HubView, rows: HubViewRow[]): string {
  if (rows.length === 0) return "No matching entries."
  const lines = rows.map((row) =>
    JSON.stringify({
      id: row.id,
      scope: row.scope ?? "not installed",
      name: row.displayName,
      type: row.kind,
      description: row.description,
      installed: row.installed,
      enabled: row.enabled,
      state: row.state,
      ...(row.stateReason ? { reason: reasonText(row) } : {}),
      authorization: row.authorization,
      ...(row.agentNote ? { agentNote: row.agentNote } : {}),
    }),
  )
  if (rows.some((row) => row.kind === "cloud")) lines.push(HUB_PRICE_NOTE_MISSING)
  if (view.warnings.length > 0) lines.push("Note: some installed items could not be read; this list may be incomplete.")
  return lines.join("\n")
}
