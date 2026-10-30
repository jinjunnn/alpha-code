// REQ-234 `#1529`(基线 §2.2 / §2.5,不变量 I4)—— 「已安装 / 待重载 / 可用」的**唯一权威**。
//
// 定制中心(经 IPC `ext-hub-view`)与 agent 工具(经 parentPort `alpha.hub.view.request`)读的都是本模块对同一个
// `(id, scope, directory)` **即时**算出的同一档:没有缓存、没有中间文件,账本被谁改了下一次查询自然读到。
//
// 视图 = 已验 catalog 的可安装视图(installableCatalogEntries)∪ 该目录的安装行(ext-inventory:global 账本 + 该项目账本)。
// 每个安装行:
//   desiredState = disabled           ⇒ installed(原因 disabled;不承诺可用)
//   本目录即时核验通过                ⇒ available
//   否则                              ⇒ reload-pending,原因按序:在途重载(reload-coordinator)⇒ 即时核验没过的细节
//                                        (云条目除外,见下)
// 核验按种类(全部带 directory,全部可失败;**核不了 = 不标 available**):
//   mcp(global)  该目录 mcp.status[name] = connected(verifyInstalledMcp)
//   mcp(project) 既有 D-scoped 判据 = active(信任门 + probeProjectMcpActivation)
//   cloud        云 MCP 在该目录 connected ∧ tool-policy inventory 里云服务的 cloud_dispatch 在列且 enabled
//                (DECIDE `#1524` 结论,基线 §2.5 云行)。没有重载环节:核验不过时**最高 installed**,原因写明缺的是
//                连接还是工具,不出重载入口、不取在途重载的原因
//   skill        GET /skill?directory 有同名,且 location 落在 main 为它安装的目录里(generation live 目录,
//                否则账本根下的 skills/<name>)—— 身份,不只名字
//   agent        GET /agent?directory 有同名且 disable !== true
//   command      GET /command?directory 有同名
//   其它种类      核不了 —— 落 installed + 原因(重载修不好「没有判据」),不出重载入口(`#1531`)
//   MCP 要授权    needs_auth / needs_client_registration 同上:installed + 原状态词,不出重载入口(`#1531`)
//   MCP 准备中    pending(引擎后台启动中)同上;后台重连时细节附上次失败(`#1563`)
//
// 状态词与会话无关(I4)。会话 / agent 的权限只进 ext 侧应答的 agentNote,且只对技能行。

import { realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerReadyData } from "../preload/types"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import { installableCatalogEntries, installableCatalogPackages } from "../renderer/extensions/catalog-installable-view"
import type { CatalogPackageViewV1 } from "../shared/catalog-package-view"
import { readPackageGraphs } from "./ext-receipt-v2"
import {
  AGENT_NOTE_DENIED,
  AGENT_NOTE_UNVERIFIED,
  buildHubRequestReply,
  buildHubViewReply,
  isAlphaSidecarMessage,
  isHubRequestId,
  parseAlphaSidecarInbound,
  type AlphaSidecarOutbound,
  type HubRequestRecord,
  type HubRequestStage,
  type HubStateReason,
  type HubView,
  type HubViewRow,
} from "./alpha-sidecar-messages"
import { CLOUD_MCP_SERVER_NAME } from "./cloud-web-search"
import { collectInventory, type InventoryCatalogInput, type InventoryRow } from "./ext-inventory"
import { type McpVerification, verifyInstalledMcp } from "./ext-mcp-activation"
import { skillGenerationKey } from "./ext-skill-generations"
import { resolveLiveGenerationDir } from "./ext-transaction"
import type { ReloadCoordinator } from "./reload-coordinator"
import { createToolPolicyClient } from "./tool-policy-client"

/** 云 worker 自己 advertise 的派发工具名。与 packages/ext/src/cloud-contract-hook.ts 的
 *  `CLOUD_DISPATCH_REMOTE_TOOL` 同值;两处相等由 hub-view.test.ts 钉住(不跨包 import:ext 依赖 ui-mac,反之不)。 */
export const CLOUD_DISPATCH_TOOL = "cloud_dispatch"

export type HubViewDeps = {
  /** 已验 catalog(remote/cache 验签 → 随包快照),与 governance 只读查询同一个 resolve 面(ext-ipc 的 resolveEffectiveCatalog)。
   *  `packages` = main 评估过的签名包视图(同一次刷新的 packageViews;随包快照没有)。 */
  resolveCatalog(): Promise<(InventoryCatalogInput & { packages?: CatalogPackageViewV1[] }) | null>
  advisoryBlocked(): ReadonlySet<string>
  seedDir: string | null
  globalRoot(): string
  /** 与 IPC 同口径的项目解析;不是项目 ⇒ 只读 global 账本。 */
  projectEntry(directory: string): { ok: true; projectDir: string; root: string } | { ok: false; reason: string }
  /** renderer 不在项目里时用的目录:引擎的初始工作区。 */
  defaultDirectory(): string
  /** 项目 MCP 的既有 D-scoped 判据(信任门 + probeProjectMcpActivation);`active` 才算可用。 */
  projectMcpState(name: string, projectDir: string): Promise<string>
  awaitServer(): Promise<ServerReadyData>
  /** reload-coordinator.pendingFor。 */
  pendingFor(directory: string): HubStateReason | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}

export type HubAgentViewRequest = { directory: string; sessionID?: string; agent?: string; query?: string }

export type HubViewService = {
  /** 定制中心:只按目录(renderer 从不发送会话字段)。 */
  view(directory?: string): Promise<HubView>
  /** agent 工具:同一份计算 + 技能行的 agentNote + query 过滤。 */
  viewForAgent(request: HubAgentViewRequest): Promise<HubView>
}

/** `reloadable: false` = 核验没过,但重载修不好它(要授权 / 没有核验判据):落 installed + 原因,不出重载入口(`#1531`)。 */
type Verdict = { ok: true } | { ok: false; detail: string; reloadable?: false }

/** 原因细节:状态词原样;后台重连中的 pending 附上一次失败(`#1563`)。 */
const mcpDetail = (label: string, status: McpVerification) =>
  status.status === "pending" && status.lastFailure
    ? `${label} pending (last failure: ${status.lastFailure})`
    : `${label} ${status.status}`
type Read = { ok: true; items: Record<string, unknown>[] } | { ok: false; detail: string }

const DEFAULT_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ])
}

function authorizationOf(entry: CatalogEntry | undefined, byId: ReadonlyMap<string, CatalogEntry>): string {
  if (!entry) return "none"
  if (entry.type === "cloud") return "platform-login"
  const vars = new Set<string>()
  const add = (e: CatalogEntry | undefined) => {
    if (e?.installSpec?.kind === "mcp") for (const v of e.installSpec.requiredEnvVars ?? []) vars.add(v)
  }
  if (entry.type === "bundle") for (const item of entry.bundleItems ?? []) add(byId.get(item.catalogEntryId))
  else add(entry)
  return vars.size > 0 ? `secret:${[...vars].sort().join(",")}` : "none"
}

/** location 是否落在 dir 之内(两侧都 realpath;读不出 = 否)。 */
function isInside(location: string, dir: string): boolean {
  try {
    const rel = relative(realpathSync(dir), realpathSync(location))
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
  } catch {
    return false
  }
}

/** 与上游 `@opencode-ai/core/util/wildcard` 的 `match` 同一规则(ui-mac 不依赖 core 包;
 *  逐用例对照见 hub-view.test.ts 的 parity 用例)。 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

type Rule = { permission: string; pattern: string; action: string }
function asRuleset(value: unknown): Rule[] | undefined {
  if (!Array.isArray(value)) return
  const rules: Rule[] = []
  for (const rule of value) {
    if (!isRecord(rule) || typeof rule.permission !== "string" || typeof rule.pattern !== "string" || typeof rule.action !== "string")
      return
    rules.push({ permission: rule.permission, pattern: rule.pattern, action: rule.action })
  }
  return rules
}

/** 引擎的求值:agent ruleset ++ session ruleset 扁平拼接,findLast(permission/index.ts `evaluate`)。 */
export function skillActionFor(name: string, agentRules: readonly Rule[], sessionRules: readonly Rule[]): string {
  const rule = [...agentRules, ...sessionRules].findLast(
    (r) => wildcardMatch("skill", r.permission) && wildcardMatch(name, r.pattern),
  )
  return rule?.action ?? "ask"
}

function packageRowsFor(views: CatalogPackageViewV1[], rows: HubViewRow[], globalRoot: string, warnings: string[]): HubViewRow[] {
  if (views.length === 0) return []
  const graphsRead = readPackageGraphs(globalRoot)
  if (!graphsRead.ok) warnings.push(`package ledger unreadable: ${graphsRead.reason}`)
  const graphs = graphsRead.ok ? graphsRead.packageGraphs : []
  return views.map((view): HubViewRow => {
    const ids = view.prerequisites.items.map((item) => item.prerequisiteId)
    const base = {
      id: view.catalogId,
      name: view.catalogId,
      kind: "package",
      displayName: view.presentation.displayName,
      description: view.presentation.description,
      authorization: ids.length > 0 ? `secret:${[...ids].sort().join(",")}` : "none",
      ...(view.cloud ? { priceNote: priceNoteFor(view) } : {}),
    }
    const graph = graphs.find((item) => item.packageId === view.catalogId)
    if (!graph) return { ...base, scope: null, installed: false, enabled: false, state: "not-installed" }
    const components = [graph.root, ...graph.children].map((node) => ({
      node,
      row: rows.find((row) => row.scope === "global" && row.kind === node.kind && row.name === node.name),
    }))
    const enabled = components.every((component) => component.row?.enabled === true)
    const blocking = components.find((component) => component.row?.state !== "available")
    if (!blocking) return { ...base, scope: "global", installed: true, enabled, state: "available" }
    const label = `${blocking.node.kind} ${blocking.node.name}`
    if (!blocking.row)
      return { ...base, scope: "global", installed: true, enabled, state: "installed", stateReason: { code: "not-loaded", detail: `${label}: not in the install ledger` } }
    const reason = blocking.row.stateReason
    const state = blocking.row.state === "reload-pending" ? "reload-pending" : "installed"
    return {
      ...base,
      scope: "global",
      installed: true,
      enabled,
      state,
      ...(reason ? { stateReason: { code: reason.code, ...(reason.code === "not-loaded" ? { detail: `${label}: ${reason.detail ?? "not loaded"}` } : reason.detail ? { detail: reason.detail } : {}) } } : {}),
    }
  })
}

/** REQ-235 的目录预留金额只作说明,沿用云表单文案;不是最终报价。 */
function priceNoteFor(view: CatalogPackageViewV1 | undefined) {
  return view?.cloud
    ? `预留 US$${view.cloud.holdUsd.toFixed(2)},按实际用量结算;失败时已产生的费用仍会结算。`
    : undefined
}

export function createHubViewService(deps: HubViewDeps): HubViewService {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = deps.fetch ?? fetch
  const toolPolicy = createToolPolicyClient({ awaitServer: deps.awaitServer, fetch: fetchImpl, timeoutMs })

  /** 一次计算内的引擎读(每种只读一次)。 */
  function engineReads(directory: string) {
    let client: Promise<ReturnType<typeof createOpencodeClient>> | undefined
    const getClient = () =>
      (client ??= withTimeout(deps.awaitServer(), timeoutMs, "timed out waiting for the engine").then((server) =>
        createOpencodeClient({
          baseUrl: server.url,
          fetch: fetchImpl,
          headers:
            server.username || server.password
              ? { Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")}` }
              : undefined,
        }),
      ))
    const list = (label: string, call: (c: ReturnType<typeof createOpencodeClient>) => Promise<unknown>) => {
      let memo: Promise<Read> | undefined
      return () =>
        (memo ??= (async (): Promise<Read> => {
          try {
            const response = await withTimeout(getClient().then(call), timeoutMs, `timed out reading ${label}`)
            if (!isRecord(response) || response.error !== undefined || !Array.isArray(response.data))
              return { ok: false, detail: `${label} unreadable` }
            return { ok: true, items: response.data.filter(isRecord) }
          } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : String(error) }
          }
        })())
    }
    let inventory: ReturnType<typeof toolPolicy.inventory> | undefined
    return {
      skills: list("skills", (c) => c.app.skills({ directory })),
      agents: list("agents", (c) => c.app.agents({ directory })),
      commands: list("commands", (c) => c.command.list({ directory })),
      toolInventory: () => (inventory ??= toolPolicy.inventory({ directory })),
      session: async (sessionID: string): Promise<Rule[] | undefined> => {
        try {
          const response = await withTimeout(
            getClient().then((c) => c.session.get({ sessionID, directory })),
            timeoutMs,
            "timed out reading the session",
          )
          if (!isRecord(response) || response.error !== undefined || !isRecord(response.data)) return
          return response.data.permission === undefined ? [] : asRuleset(response.data.permission)
        } catch {
          return
        }
      },
    }
  }

  async function verify(
    row: InventoryRow,
    directory: string,
    project: { projectDir: string; root: string } | undefined,
    reads: ReturnType<typeof engineReads>,
  ): Promise<Verdict> {
    if (row.kind === "mcp") {
      if (row.scope === "project") {
        if (!project) return { ok: false, detail: "project MCP outside its project" }
        const state = await deps.projectMcpState(row.name, project.projectDir)
        if (state === "active") return { ok: true }
        // `#1563`:pending = 引擎还在后台启动它(准备中);重载修不好「还没连上」,不出重载入口。
        if (state === "pending") return { ok: false, detail: "project MCP pending", reloadable: false }
        return { ok: false, detail: `project MCP ${state}` }
      }
      const status = await verifyInstalledMcp(row.name, directory, deps.awaitServer, fetchImpl, { awaitServer: timeoutMs, status: timeoutMs })
      if (status.status === "connected") return { ok: true }
      // `#1563`:pending = 引擎还在后台启动它(准备中),不是失败;与要授权一样,重载修不好,不出重载入口。
      if (status.status === "needs_auth" || status.status === "needs_client_registration" || status.status === "pending")
        return { ok: false, detail: mcpDetail("MCP", status), reloadable: false }
      return { ok: false, detail: mcpDetail("MCP", status) }
    }
    if (row.kind === "cloud") {
      const status = await verifyInstalledMcp(CLOUD_MCP_SERVER_NAME, directory, deps.awaitServer, fetchImpl, { awaitServer: timeoutMs, status: timeoutMs })
      if (status.status !== "connected") return { ok: false, detail: mcpDetail("cloud MCP", status) }
      const inventory = await reads.toolInventory()
      if (!inventory.ok) return { ok: false, detail: `tool list unreadable (${inventory.code})` }
      const tool = inventory.inventory.services
        .filter((service) => service.source === "mcp" && service.origin === CLOUD_MCP_SERVER_NAME)
        .flatMap((service) => service.tools)
        .find((candidate) => candidate.identity.name === CLOUD_DISPATCH_TOOL)
      if (!tool) return { ok: false, detail: `${CLOUD_DISPATCH_TOOL} is not in this directory's tool list` }
      if (tool.effective.state !== "enabled") return { ok: false, detail: `${CLOUD_DISPATCH_TOOL} is ${tool.effective.state} by tool policy` }
      return { ok: true }
    }
    if (row.kind === "skill") {
      const root = row.scope === "project" ? project?.root : deps.globalRoot()
      if (!root) return { ok: false, detail: "project skill outside its project" }
      const installDir = resolveLiveGenerationDir(root, skillGenerationKey(row.name)) ?? join(root, "skills", row.name)
      const skills = await reads.skills()
      if (!skills.ok) return { ok: false, detail: skills.detail }
      const loaded = skills.items.find((skill) => skill.name === row.name)
      if (!loaded) return { ok: false, detail: "skill not loaded" }
      if (typeof loaded.location !== "string" || !isInside(loaded.location, installDir))
        return { ok: false, detail: "a different skill with this name is loaded" }
      return { ok: true }
    }
    if (row.kind === "agent") {
      const agents = await reads.agents()
      if (!agents.ok) return { ok: false, detail: agents.detail }
      return agents.items.some((agent) => agent.name === row.name && agent.disable !== true)
        ? { ok: true }
        : { ok: false, detail: "agent not loaded" }
    }
    if (row.kind === "command") {
      const commands = await reads.commands()
      if (!commands.ok) return { ok: false, detail: commands.detail }
      return commands.items.some((command) => command.name === row.name)
        ? { ok: true }
        : { ok: false, detail: "command not loaded" }
    }
    return { ok: false, detail: `no verification for kind "${row.kind}"`, reloadable: false }
  }

  async function compute(directory: string): Promise<{ view: HubView; reads: ReturnType<typeof engineReads> }> {
    const warnings: string[] = []
    let catalog: (InventoryCatalogInput & { packages?: CatalogPackageViewV1[] }) | null = null
    try {
      catalog = await deps.resolveCatalog()
    } catch (error) {
      warnings.push(`catalog unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const projectResolved = deps.projectEntry(directory)
    const project = projectResolved.ok ? { projectDir: projectResolved.projectDir, root: projectResolved.root } : undefined
    const inventory = collectInventory({
      catalog,
      seedDir: deps.seedDir,
      globalRoot: deps.globalRoot(),
      ...(project ? { projectDir: project.projectDir } : {}),
    })
    warnings.push(...inventory.warnings)
    const entries = catalog?.entries ?? []
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
    const installable = new Set(installableCatalogEntries(entries, deps.advisoryBlocked()).map((entry) => entry.id))
    const reads = engineReads(directory)
    const pending = deps.pendingFor(directory)

    const rows = await Promise.all(
      inventory.rows
        .filter((row) => row.scope !== null || installable.has(row.id))
        .map(async (row): Promise<HubViewRow> => {
          const entry = byId.get(row.id)
          const priceNote = row.kind === "cloud"
            ? priceNoteFor(catalog?.packages?.find((view) => view.components.some((component) => component.included && component.componentId === row.id)))
            : undefined
          const base = {
            id: row.id,
            scope: row.scope,
            name: row.name,
            kind: row.kind,
            displayName: entry?.displayName ?? row.name,
            description: entry?.description ?? "",
            authorization: authorizationOf(entry, byId),
            ...(priceNote !== undefined ? { priceNote } : {}),
          }
          if (row.scope === null) return { ...base, installed: false, enabled: false, state: "not-installed" }
          if (row.activation === "disabled")
            return { ...base, installed: true, enabled: false, state: "installed", stateReason: { code: "disabled" } }
          const verdict = await verify(row, directory, project, reads)
          if (verdict.ok) return { ...base, installed: true, enabled: true, state: "available" }
          // 云条目没有重载环节(基线 §2.5 云行):最高 installed,原因说清缺的是连接还是工具。重载修不好的(要授权 / 没有
          // 核验判据,`#1531`)同样落 installed + 原因 —— 给它一个「现在重载」只会打断会话而改不了状态。
          if (row.kind === "cloud" || verdict.reloadable === false)
            return { ...base, installed: true, enabled: true, state: "installed", stateReason: { code: "not-loaded", detail: verdict.detail } }
          const reason: HubStateReason = pending ?? { code: "not-loaded", detail: verdict.detail }
          return { ...base, installed: true, enabled: true, state: "reload-pending", stateReason: reason }
        }),
    )
    // 审计 R1 Major 2:签名包也是客户端可安装的条目(与定制中心同一个可安装视图 installableCatalogPackages)。
    // 包只装 global;装上之后的档按它的组件行定(组件行就在上面,同一次即时核验):全部可用 = available,
    // 否则取第一条没可用的组件的档与原因(带组件名)。
    const packageRows = packageRowsFor(
      installableCatalogPackages(catalog?.packages ?? [], entries, deps.advisoryBlocked()),
      rows,
      deps.globalRoot(),
      warnings,
    )
    return { view: { directory, rows: [...rows, ...packageRows], warnings }, reads }
  }

  return {
    async view(directory) {
      const target = typeof directory === "string" && directory.length > 0 ? directory : deps.defaultDirectory()
      return (await compute(target)).view
    },

    async viewForAgent(request) {
      const { view, reads } = await compute(request.directory)
      const query = request.query?.trim().toLowerCase()
      const rows = query
        ? view.rows.filter((row) =>
            [row.id, row.name, row.displayName, row.description].some((text) => text.toLowerCase().includes(query)),
          )
        : view.rows
      const installedSkills = rows.filter((row) => row.kind === "skill" && row.installed)
      if (installedSkills.length === 0) return { ...view, rows }

      let agentRules: Rule[] | undefined
      let sessionRules: Rule[] | undefined
      if (request.sessionID && request.agent) {
        const agents = await reads.agents()
        const agent = agents.ok ? agents.items.find((item) => item.name === request.agent) : undefined
        agentRules = agent ? asRuleset(agent.permission) : undefined
        sessionRules = await reads.session(request.sessionID)
      }
      return {
        ...view,
        rows: rows.map((row) => {
          if (row.kind !== "skill" || !row.installed) return row
          if (!agentRules || !sessionRules) return { ...row, agentNote: AGENT_NOTE_UNVERIFIED }
          return skillActionFor(row.name, agentRules, sessionRules) === "deny" ? { ...row, agentNote: AGENT_NOTE_DENIED } : row
        }),
      }
    },
  }
}

// ── 安装请求的阶段簿记(§2.3,I9 的 main 半边)───────────────────────────────────────────────────
//
// requestId 由 ext 生成、随审批请求的 metadata 走;renderer 守望者**先**经 IPC `ext-hub-request-stage` 记阶段**再**回复
// 审批;`committed` 只由 main 安装体在提交成功后写(带 (id, scope)),renderer 写不了。阶段只前进不后退:
//   (无) → confirming → submitted → committed | failed
//               └──────→ declined | failed
// 终态(committed / failed / declined)之后的任何记录一律拒 —— 于是 submitted / committed 之后那条 300 s 期限的
// reject 回执**不可能**被记成「用户拒绝」。只存 main 内存(sidecar 一代之内有效;main 重启即失 ⇒ 查不到 = 无法判断)。

const STAGE_FROM: Record<HubRequestStage, readonly (HubRequestStage | "none")[]> = {
  confirming: ["none"],
  submitted: ["confirming"],
  declined: ["confirming"],
  failed: ["confirming", "submitted"],
  committed: ["confirming", "submitted"],
}
const RENDERER_STAGES: ReadonlySet<string> = new Set<HubRequestStage>(["confirming", "submitted", "declined", "failed"])
const MAX_REQUESTS = 256

export type HubRequestStages = {
  /** renderer 守望者记阶段(committed 不在其列)。 */
  record(input: unknown): { ok: true } | { ok: false; reason: string }
  /** main 安装体:带 hubRequestId 的一次安装落定(授权暂停不算落定,不在此调用)。 */
  settleInstall(requestId: string, outcome: { ok: true; catalogId: string; scope: "global" | "project" } | { ok: false; reason: string }): void
  get(requestId: string): HubRequestRecord | null
}

export function createHubRequestStages(deps: { log: (line: string) => void }): HubRequestStages {
  const records = new Map<string, HubRequestRecord>()
  const advance = (requestId: string, next: HubRequestRecord): { ok: true } | { ok: false; reason: string } => {
    const current = records.get(requestId)
    if (!STAGE_FROM[next.stage].includes(current?.stage ?? "none"))
      return { ok: false, reason: `hub request ${requestId}: ${current?.stage ?? "no record"} → ${next.stage} refused` }
    if (current && current.catalogId !== next.catalogId)
      return { ok: false, reason: `hub request ${requestId}: catalog id changed` }
    records.delete(requestId)
    records.set(requestId, next)
    while (records.size > MAX_REQUESTS) records.delete(records.keys().next().value!)
    return { ok: true }
  }
  return {
    record(input) {
      if (!isRecord(input)) return { ok: false, reason: "stage record: must be an object" }
      const { requestId, stage, catalogId, reason } = input
      if (!isHubRequestId(requestId)) return { ok: false, reason: "stage record: requestId malformed" }
      if (typeof stage !== "string" || !RENDERER_STAGES.has(stage)) return { ok: false, reason: "stage record: stage not recordable here" }
      const known = records.get(requestId)
      const id = stage === "confirming" ? catalogId : (catalogId ?? known?.catalogId)
      if (typeof id !== "string" || id.length === 0 || id.length > 200) return { ok: false, reason: "stage record: catalogId required" }
      if (reason !== undefined && (typeof reason !== "string" || reason.length > 1_000))
        return { ok: false, reason: "stage record: reason malformed" }
      const result = advance(requestId, {
        requestId,
        catalogId: id,
        stage: stage as HubRequestStage,
        ...(stage === "failed" && typeof reason === "string" && reason ? { reason } : {}),
      })
      if (!result.ok) deps.log(result.reason)
      return result
    },
    settleInstall(requestId, outcome) {
      const known = records.get(requestId)
      if (!known) {
        deps.log(`hub request ${requestId}: install settled without a recorded confirmation — not recorded`)
        return
      }
      const result = outcome.ok
        ? advance(requestId, { requestId, catalogId: outcome.catalogId, stage: "committed", scope: outcome.scope })
        : advance(requestId, { requestId, catalogId: known.catalogId, stage: "failed", reason: outcome.reason.slice(0, 1_000) })
      if (!result.ok) deps.log(result.reason)
    },
    get(requestId) {
      const record = records.get(requestId)
      return record ? { ...record } : null
    },
  }
}

// ── parentPort 上 `alpha.*` 的 main 侧分发(I6)──────────────────────────────────────────────────
//
// server.ts 在 `child.on("message")` 旁挂这一个入口(与 writeProbes.receive 并列)。只做三件事:只读视图、只读阶段、
// 记录重载报告。是本族但形状不对 ⇒ 丢弃 + 记一行;不是本族 ⇒ 返回 false,原样交还给别的接收者。
// 回复发不出去(sidecar 已退出)⇒ 记一行,不抛:ext 侧的请求簿记会按超时 / 子进程退出答「无法判断」。

export type AlphaSidecarHost = {
  receive(message: unknown, post: (message: AlphaSidecarOutbound) => void): boolean
  /** sidecar ready:返回该次连接的断开函数(只断开自己那一次,晚到的旧 exit 不会断开新连接)。 */
  attach(post: (message: AlphaSidecarOutbound) => void): (reason: string) => void
}

export function createAlphaSidecarHost(deps: {
  view: HubViewService
  requests: HubRequestStages
  reloads: ReloadCoordinator
  log: (line: string) => void
}): AlphaSidecarHost {
  const reply = (post: (message: AlphaSidecarOutbound) => void, message: AlphaSidecarOutbound) => {
    try {
      post(message)
    } catch (error) {
      deps.log(`alpha sidecar: reply ${message.type} could not be delivered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    receive(message, post) {
      if (!isAlphaSidecarMessage(message)) return false
      const inbound = parseAlphaSidecarInbound(message)
      if (!inbound) {
        deps.log(`alpha sidecar: dropped malformed or unknown message type=${String((message as { type: unknown }).type).slice(0, 80)}`)
        return true
      }
      if (inbound.type === "alpha.hub.view.request") {
        deps.view.viewForAgent(inbound).then(
          (view) => reply(post, buildHubViewReply(inbound.id, { view })),
          (error) => reply(post, buildHubViewReply(inbound.id, { error: error instanceof Error ? error.message : String(error) })),
        )
        return true
      }
      if (inbound.type === "alpha.hub.request.request") {
        reply(post, buildHubRequestReply(inbound.id, { record: deps.requests.get(inbound.requestId) }))
        return true
      }
      deps.reloads.receiveReport(inbound)
      return true
    },
    attach(post) {
      return deps.reloads.attach(post)
    },
  }
}
