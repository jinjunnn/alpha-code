// alpha 自有文件(basename `alpha-*`;ADR-043 谓词因子②)。
//
// REQ-131 / #1129(reopen)—— **dynamic tool policy inventory**(#724 §5 末条)。
//
// 从 **live registry/materialization** 派生:V1 ToolRegistry(builtin/plugin/host 门面)、
// MCP.tools()(当前连接的 server 与工具)、以及仅当有 resource-capable server 时才存在的
// 三个 host 伪工具(与 `session/tools.ts` 同一谓词)。**不读**历史 `ToolPart.display`、
// 不读 UI 名单(§5 禁令)。
//
// effective 判定与咽喉是**同一个 resolver**(§6):同一份 `resolveToolPolicy` 纯核、同一个
// `effectiveFromSnapshot` 合成(ruleset 轴 deny 折 cap)。差别只有 §6 允许的那一条 ——
// inventory 是当轮 snapshot,executor 逐次重读。所以 Settings 徽标显示的 disabled/ask,
// 就是 executor 下一次调用会做的事。
//
// ruleset 轴取**全局 config** 的 `permission`(`Permission.fromConfig(cfg.permission)`)——
// Settings 是长期策略面板,不进任何会话态;per-agent 附加规则与 session 规则只会在执行时
// **更严**,不会更松(deny 折 cap、ask 只多问),方向 fail-closed。
//
// 返回值先过 `parseToolPolicyInventory`(schema decode)再交出:引擎侧形状漂移 loud fail,
// 不让 Settings 拿到解释不了的对象。
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { canonicalToolIdentity, type ToolAuthority, type ToolIdentity } from "@opencode-ai/schema/tool-identity"
import {
  classifyTool,
  selectorKey,
  selectorMatches,
  type ToolClass,
  type ToolPolicyRecord,
  type ToolPolicySubject,
} from "@opencode-ai/schema/alpha-tool-policy"
import {
  parseToolPolicyInventory,
  type EffectiveToolPolicyV1,
  type ToolPolicyInventoryServiceV1,
  type ToolPolicyInventoryToolV1,
  type ToolPolicyInventoryV1,
} from "@opencode-ai/schema/alpha-tool-inventory"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "./index"
import { AlphaToolPolicy, mcpBindingDigest, type EffectiveToolPolicy } from "./alpha-tool-policy"
import { AlphaToolPolicyGate } from "./alpha-tool-policy-gate"

const MCP_RESOURCE_HOST_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const

/** 9 型逐型转换(exhaustive switch = 编译期漂移闸:resolver 加第 10 型,这里当场红)。 */
function wireReason(reason: EffectiveToolPolicy["reason"]): EffectiveToolPolicyV1["reason"] {
  switch (reason.kind) {
    case "invalid-identity":
      return { kind: "invalid-identity", detail: reason.detail }
    case "cap-managed":
      return { kind: "cap-managed" }
    case "cap-managed-unreadable":
      return { kind: "cap-managed-unreadable", detail: reason.detail }
    case "cap-entitlement":
      return { kind: "cap-entitlement", verdict: reason.verdict }
    case "cap-hard-deny":
      return { kind: "cap-hard-deny", sources: [...reason.sources] }
    case "quarantine":
      return { kind: "quarantine", detail: reason.detail }
    case "user":
      return { kind: "user", level: reason.level }
    case "binding-changed":
      return { kind: "binding-changed", level: reason.level }
    case "default":
      return { kind: "default", class: reason.class }
  }
}

function wireEffective(effective: EffectiveToolPolicy): EffectiveToolPolicyV1 {
  return { state: effective.state, action: effective.action, reason: wireReason(effective.reason) }
}

const DYNAMIC_CLASSES: ReadonlySet<ToolClass> = new Set(["alpha-cloud", "third-party-mcp", "plugin"])

export interface Interface {
  readonly list: () => Effect.Effect<ToolPolicyInventoryV1>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AlphaToolInventory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const policy = yield* AlphaToolPolicy.Service

    type LiveTool = {
      technicalId: string
      identity: ToolIdentity
      authority: ToolAuthority
      bindingDigest?: string
    }

    const list: Interface["list"] = Effect.fn("AlphaToolInventory.list")(function* () {
      const snap = yield* policy.snapshot()
      const cfg = yield* config.get()
      const ruleset = Permission.fromConfig(cfg.permission ?? {})

      // ── live 枚举 ────────────────────────────────────────────────────────────
      const live: LiveTool[] = []
      const invalid: { technicalId: string; detail: string }[] = []

      for (const item of yield* registry.all()) {
        const bindingDigest =
          item.identity.source === "plugin"
            ? yield* registry.pluginBinding(item.identity.origin)
            : AlphaToolPolicyGate.APP_BUILTIN_BINDING_DIGEST
        live.push({ technicalId: item.id, identity: item.identity, authority: { kind: "not-asserted" }, bindingDigest })
      }

      const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
        (client) => !!client.getServerCapabilities()?.resources,
      )
      if (hasMcpResourceServer) {
        for (const name of MCP_RESOURCE_HOST_TOOLS) {
          live.push({
            technicalId: name,
            identity: { source: "host", origin: "", name },
            authority: { kind: "not-asserted" },
            bindingDigest: AlphaToolPolicyGate.APP_BUILTIN_BINDING_DIGEST,
          })
        }
      }

      const mcpDigests = new Map<string, string | undefined>()
      for (const [alias, entry] of Object.entries(yield* mcp.tools())) {
        if (!entry.identity || !entry.authority) {
          invalid.push({ technicalId: alias, detail: "MCP tool is missing its source identity" })
          continue
        }
        if (!mcpDigests.has(entry.identity.origin)) {
          const facts = mcp.bindingFacts ? yield* mcp.bindingFacts(entry.identity.origin) : undefined
          mcpDigests.set(
            entry.identity.origin,
            facts?.entry ? mcpBindingDigest(entry.identity.origin, facts.entry) : undefined,
          )
        }
        live.push({
          technicalId: alias,
          identity: entry.identity,
          authority: entry.authority,
          bindingDigest: mcpDigests.get(entry.identity.origin),
        })
      }

      // ── 用户记录索引(§3:同一 selector 只有一条)─────────────────────────────
      const records: readonly ToolPolicyRecord[] = snap.user.status === "ok" ? snap.user.records : []
      const recordBySelectorKey = new Map(records.map((record) => [selectorKey(record.selector), record]))
      const classRecords = records.filter((record) => record.selector.level === "class")

      // ── 逐工具判定 + 按 (source, origin) 分组 ────────────────────────────────
      const services = new Map<string, ToolPolicyInventoryServiceV1>()
      for (const item of live) {
        let canonical: string
        let cls: ToolClass | undefined
        try {
          canonical = canonicalToolIdentity(item.identity)
          cls = classifyTool({ identity: item.identity, authority: item.authority })
        } catch (error) {
          invalid.push({ technicalId: item.technicalId, detail: error instanceof Error ? error.message : String(error) })
          continue
        }
        if (cls === undefined) {
          invalid.push({ technicalId: item.technicalId, detail: `unclassifiable subject: ${canonical}` })
          continue
        }
        const subject: ToolPolicySubject = {
          identity: item.identity,
          authority: item.authority,
          bindingDigest: item.bindingDigest,
        }
        const effective = AlphaToolPolicyGate.effectiveFromSnapshot(snap, subject, ruleset)
        const toolRecord = recordBySelectorKey.get(selectorKey({ level: "tool", canonical }))
        const hasAnyOverride = records.some((record) => selectorMatches(record.selector, subject))
        // 写 enabled 记录要携带的 digest:alpha-cloud 用 verified authority 证据(§5),
        // 其余用宿主派生的当前 binding —— 与 resolver 的 `subjectBindingDigest` 同一取向。
        const writeDigest =
          item.authority.kind === "alpha-cloud" ? item.authority.evidenceDigest : item.bindingDigest
        const tool: ToolPolicyInventoryToolV1 = {
          canonical,
          identity: item.identity,
          technicalId: item.technicalId,
          authority: item.authority,
          ...(writeDigest !== undefined ? { bindingDigest: writeDigest } : {}),
          effective: wireEffective(effective),
          ...(toolRecord !== undefined ? { record: toolRecord } : {}),
          newlyDiscovered: DYNAMIC_CLASSES.has(cls) && !hasAnyOverride,
        }

        const serviceKey = selectorKey({ level: "service", source: item.identity.source, origin: item.identity.origin })
        let service = services.get(serviceKey)
        if (!service) {
          const serviceRecord = recordBySelectorKey.get(serviceKey)
          service = {
            source: item.identity.source,
            origin: item.identity.origin,
            class: cls,
            authority: item.authority,
            ...(writeDigest !== undefined ? { bindingDigest: writeDigest } : {}),
            ...(serviceRecord !== undefined ? { record: serviceRecord } : {}),
            tools: [],
          }
          services.set(serviceKey, service)
        }
        service.tools.push(tool)
      }

      for (const service of services.values()) {
        service.tools.sort((a, b) => a.canonical.localeCompare(b.canonical))
      }

      const built: ToolPolicyInventoryV1 = {
        version: 1,
        partition: snap.partition,
        user:
          snap.user.status === "quarantined"
            ? { status: "quarantined", reason: snap.user.reason }
            : { status: snap.user.status },
        managed:
          snap.managed.status === "unreadable"
            ? { status: "unreadable", reason: snap.managed.reason }
            : { status: "ok" },
        classRecords,
        services: [...services.values()].toSorted(
          (a, b) => a.source.localeCompare(b.source) || a.origin.localeCompare(b.origin),
        ),
        invalid: { count: invalid.length, entries: invalid },
      }
      // decode = 对 wire 契约的运行期自证(schema 变了而这里没跟 ⇒ loud fail,不静默漂)。
      return parseToolPolicyInventory(built)
    })

    return Service.of({ list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ToolRegistry.node, MCP.node, Config.node, AlphaToolPolicy.node],
})

export * as AlphaToolInventory from "./alpha-tool-inventory"
