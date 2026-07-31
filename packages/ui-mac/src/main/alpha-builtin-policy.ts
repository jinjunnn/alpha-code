// alpha-governance — 上游能力治理层(REQ-037):原生 agent/skill/command 的隐藏/禁用/重写。
//
// 真源 = `~/.alpha/governance.json`(用户意图);物化 = `~/.opencode/opencode.jsonc` 的受控**叶子键**
// (ADR-014 v3 文件通道,dispose 后引擎重读 → 热生效)。只写叶子(agent.<n>.hidden 而非整个 agent.<n>)
// → 用户自有的同名兄弟字段不被清除(验收⑥);`_materialized` 记录我们写过的每个叶子路径,重放时
// 先移除 stale、重置时全量净除(卸载净除纪律,同 REQ-023)。
//
// 保护名单(硬校验,loud 拒绝):
//   - 上游 load-bearing:compaction(禁则自动压缩必崩,compaction.ts:328)/ title / summary → 拒 disable;
//   - alpha 注入 agent(alpha-automation 等,S18 X2)→ 拒 disable + hide(禁掉 = 自动化静默失效);
//   - build = 引擎兜底 agent → disable 需 confirm(UI 二次确认)。
//
// 机制依据(REQ-037 档,2026-07-05 代码确证):agent `disable` 删除/`hidden` UI 过滤/同名字段覆盖;
// skill 走全局 `permission.skill` 按名 deny(泄漏:斜杠菜单仍见 → 同名 command 占位模板诚实缓解);
// command 只可同名覆盖不可移除(内置 /init /review)。

import * as fs from "node:fs"
import * as path from "node:path"
import { isExtensionName } from "../shared/extension-name"
import { alphaGlobalRoot } from "./alpha-installs"
import { applyBuiltinPolicyEdits, type BuiltinPolicyEdit } from "./ext-config"

export interface BuiltinPolicy {
  version: 1
  mode: "denylist" | "allowlist"
  agents: {
    hide: string[]
    disable: string[]
    /** allowlist 模式下允许显示的 agent 名(denylist 模式忽略) */
    allow: string[]
    /** 同名字段级覆盖(prompt/model/permission/description/temperature/steps) */
    override: Record<string, Record<string, unknown>>
  }
  skills: {
    deny: string[]
    /** REQ-067:对「出厂默认禁」项的用户解禁名单(出厂禁不入 deny、不落明文,见 FACTORY_DENIED_SKILLS)。 */
    allowFactory: string[]
  }
  commands: { override: Record<string, { template: string; description?: string }> }
}

/** REQ-067(用户拍板 2026-07-08):上游自带、alpha 出厂即禁的技能 —— 内置默认,零明文。
 *  禁用经 env → ext config hook 内存注入;用户在治理面解禁 = 记入 skills.allowFactory。 */
export const FACTORY_DENIED_SKILLS = ["customize-opencode"] as const

/** 出厂禁用的有效名单 = 出厂清单 − 用户解禁(供 env 注入与菜单过滤)。 */
export function effectiveFactoryDenied(gov: BuiltinPolicy): string[] {
  const allow = new Set(gov.skills.allowFactory)
  return FACTORY_DENIED_SKILLS.filter((n) => !allow.has(n))
}

export const DEFAULT_BUILTIN_POLICY: BuiltinPolicy = {
  version: 1,
  mode: "denylist",
  agents: { hide: [], disable: [], allow: [], override: {} },
  skills: { deny: [], allowFactory: [] },
  commands: { override: {} },
}

/** 上游 load-bearing agent:disable 直接拒绝(compaction 必崩;title/summary 为引擎内部消费)。 */
export const HARD_PROTECTED_AGENTS = ["compaction", "title", "summary"] as const
/** alpha 注入 agent(S18 X2):disable/hide 都拒绝 —— 治理它们 = 自动化/只读档静默失效。 */
export const ALPHA_INJECTED_AGENTS = ["alpha-automation", "alpha-automation-standard", "alpha-readonly"] as const
/** 引擎兜底 agent:disable 需 confirm(全禁抛错/回退语义见上游 agent.ts:328-340)。 */
export const CONFIRM_AGENTS = ["build"] as const

/** agent 字段级覆盖允许的字段(上游 ConfigAgentV1 已验证面;prompt 即 system prompt)。 */
const AGENT_OVERRIDE_FIELDS = new Set(["prompt", "model", "permission", "description", "temperature", "steps", "variant", "color"])
const govPath = () => path.join(alphaGlobalRoot(), "governance.json")
const materializedPath = () => path.join(alphaGlobalRoot(), "governance-materialized.json")

/** 任意输入 → 合法 BuiltinPolicy(字段级白名单清洗;renderer 传入的 gov 一律过此关)。 */
export function normalizeBuiltinPolicy(raw: unknown): BuiltinPolicy {
  const r = raw as Partial<BuiltinPolicy> | undefined
  if (r && r.version === 1 && (r.mode === "denylist" || r.mode === "allowlist")) {
    return {
      version: 1,
      mode: r.mode,
      agents: {
        hide: asNames(r.agents?.hide),
        disable: asNames(r.agents?.disable),
        allow: asNames(r.agents?.allow),
        override: asOverrides(r.agents?.override),
      },
      skills: {
        // REQ-067:出厂默认禁项从 deny 收敛剔除(它们不靠用户治理记录;历史数据自愈)
        deny: asNames(r.skills?.deny).filter((n) => !(FACTORY_DENIED_SKILLS as readonly string[]).includes(n)),
        allowFactory: asNames((r.skills as { allowFactory?: unknown } | undefined)?.allowFactory).filter((n) =>
          (FACTORY_DENIED_SKILLS as readonly string[]).includes(n),
        ),
      },
      commands: { override: asCommandOverrides(r.commands?.override) },
    }
  }
  return structuredClone(DEFAULT_BUILTIN_POLICY)
}

export function readBuiltinPolicy(): BuiltinPolicy {
  try {
    return normalizeBuiltinPolicy(JSON.parse(fs.readFileSync(govPath(), "utf8")))
  } catch {
    /* missing/corrupt → default(诚实:空治理,不猜) */
  }
  return structuredClone(DEFAULT_BUILTIN_POLICY)
}

const asNames = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && isExtensionName(x)) : []
// codex M3:字段值按类型校验 —— 坏值(temperature:"hot")进 home jsonc 会让引擎整份 config 解码失败
const OVERRIDE_FIELD_OK: Record<string, (v: unknown) => boolean> = {
  prompt: (v) => typeof v === "string",
  model: (v) => typeof v === "string",
  description: (v) => typeof v === "string",
  variant: (v) => typeof v === "string",
  color: (v) => typeof v === "string",
  temperature: (v) => typeof v === "number" && Number.isFinite(v),
  steps: (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  permission: (v) => !!v && typeof v === "object" && !Array.isArray(v),
}
const asOverrides = (v: unknown): Record<string, Record<string, unknown>> => {
  if (!v || typeof v !== "object") return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, fields] of Object.entries(v as Record<string, unknown>)) {
    if (!isExtensionName(name) || !fields || typeof fields !== "object") continue
    const picked: Record<string, unknown> = {}
    for (const [f, val] of Object.entries(fields as Record<string, unknown>))
      if (AGENT_OVERRIDE_FIELDS.has(f) && OVERRIDE_FIELD_OK[f]?.(val)) picked[f] = val
    if (Object.keys(picked).length) out[name] = picked
  }
  return out
}
const asCommandOverrides = (v: unknown): Record<string, { template: string; description?: string }> => {
  if (!v || typeof v !== "object") return {}
  const out: Record<string, { template: string; description?: string }> = {}
  for (const [name, o] of Object.entries(v as Record<string, any>)) {
    if (!isExtensionName(name) || typeof o?.template !== "string" || !o.template.trim()) continue
    out[name] = { template: o.template, ...(typeof o.description === "string" ? { description: o.description } : {}) }
  }
  return out
}

export type Violation = { kind: "agent" | "skill" | "command"; name: string; reason: string }

/** 保护名单硬校验(apply 前;confirmBuildDisable 由 UI 二次确认后传入)。 */
export function validateBuiltinPolicy(gov: BuiltinPolicy, confirmBuildDisable: boolean): Violation[] {
  const v: Violation[] = []
  for (const n of gov.agents.disable) {
    if ((HARD_PROTECTED_AGENTS as readonly string[]).includes(n))
      v.push({ kind: "agent", name: n, reason: `受保护:禁用 ${n} 会破坏引擎(compaction 自动压缩必崩 / title·summary 为内部消费),已拒绝` })
    if ((ALPHA_INJECTED_AGENTS as readonly string[]).includes(n))
      v.push({ kind: "agent", name: n, reason: `受保护:${n} 是 alpha 注入的功能载体(自动化等),禁用会使其静默失效,已拒绝` })
    if ((CONFIRM_AGENTS as readonly string[]).includes(n) && !confirmBuildDisable)
      v.push({ kind: "agent", name: n, reason: `build 是引擎兜底 agent,禁用需在确认框中确认(未确认,已拒绝)` })
  }
  for (const n of gov.agents.hide) {
    if ((ALPHA_INJECTED_AGENTS as readonly string[]).includes(n))
      v.push({ kind: "agent", name: n, reason: `受保护:${n} 是 alpha 注入的功能载体,隐藏会使其入口消失,已拒绝` })
  }
  return v
}

/** 计算需要物化到 home jsonc 的叶子编辑集(声明式:desired 全量,diff 由 apply 层做)。 */
export function materializeEdits(gov: BuiltinPolicy, visibleAgents: string[]): BuiltinPolicyEdit[] {
  const edits: BuiltinPolicyEdit[] = []
  const hideSet = new Set(gov.agents.hide)

  // allowlist 模式:可见 agent 中未列名者一律 hidden(保护名单 + alpha 注入豁免)
  if (gov.mode === "allowlist") {
    const allow = new Set(gov.agents.allow)
    for (const n of visibleAgents) {
      if (!isExtensionName(n)) continue
      if (allow.has(n)) continue
      if ((HARD_PROTECTED_AGENTS as readonly string[]).includes(n)) continue
      if ((ALPHA_INJECTED_AGENTS as readonly string[]).includes(n)) continue
      hideSet.add(n)
    }
  }
  for (const n of hideSet) edits.push({ path: ["agent", n, "hidden"], value: true })
  for (const n of gov.agents.disable) edits.push({ path: ["agent", n, "disable"], value: true })
  for (const [n, fields] of Object.entries(gov.agents.override))
    for (const [f, val] of Object.entries(fields)) edits.push({ path: ["agent", n, f], value: val })

  // skills deny:叶子写 permission.skill.<n>(append 在既有键之后 → 引擎 findLast 命中 deny);
  // 若用户完全没有 permission.skill,补一个 "*"="allow" 打底(不带它引擎默认仍 allow,但显式化防歧义)。
  if (gov.skills.deny.length) {
    edits.push({ path: ["permission", "skill", "*"], value: "allow", onlyIfAbsent: true })
    for (const n of gov.skills.deny) {
      edits.push({ path: ["permission", "skill", n], value: "deny" })
      // 键入兜底占位(REQ-066 后菜单已隐藏,此模板只服务手动键入全名):诚实说明,非误导执行。
      // REQ-062 T4:customize-opencode 的占位额外指路接替者 customize-alpha。
      const successor = n === "customize-opencode" ? `定制 alpha-code 请改用 /customize-alpha(alpha 自带的定制指南技能)。` : ""
      edits.push({ path: ["command", n, "description"], value: `(已禁用)该技能已在 alpha 治理中禁用` })
      edits.push({ path: ["command", n, "template"], value: `该技能(${n})已在 alpha 的治理设置中被禁用。请告知用户:此技能不可用;如需恢复,到 定制中心 → 已安装 → 内置(上游) 解除禁用。${successor}不要尝试其它方式执行该技能。` })
    }
  }
  for (const [n, o] of Object.entries(gov.commands.override)) {
    edits.push({ path: ["command", n, "template"], value: o.template })
    if (o.description) edits.push({ path: ["command", n, "description"], value: o.description })
  }
  return edits
}

type Materialized = { keys: string[][] }
const readMaterialized = (): Materialized => {
  try {
    const raw = JSON.parse(fs.readFileSync(materializedPath(), "utf8"))
    if (Array.isArray(raw?.keys)) return { keys: raw.keys.filter((k: unknown) => Array.isArray(k) && (k as unknown[]).every((s) => typeof s === "string")) }
  } catch {
    /* none yet */
  }
  return { keys: [] }
}

export type ApplyResult = { ok: boolean; reason?: string; violations: Violation[]; written: number; removedStale: number }

/** 应用治理:校验 → 计算 desired → 移除 stale 叶子 → 写入 → 持久化真源与 _materialized。 */
export function applyBuiltinPolicy(gov: BuiltinPolicy, visibleAgents: string[], confirmBuildDisable = false): ApplyResult {
  const violations = validateBuiltinPolicy(gov, confirmBuildDisable)
  if (violations.length) return { ok: false, reason: violations.map((v) => v.reason).join("; "), violations, written: 0, removedStale: 0 }

  const prev = readMaterialized()
  // allowlist 漂移环防护:被 allowlist 隐藏的 agent 下次就不在 renderer 的可见列表里 —— 若只按
  // visibleAgents 计算,重放会把 hidden 叶子当 stale 清掉 → agent 复现 → 再 apply 又隐藏,来回震荡。
  // 已知面 = 可见 ∪ 上次物化过 hidden 的名字,声明式收敛。
  const prevHidden = prev.keys.filter((k) => k[0] === "agent" && k[2] === "hidden").map((k) => k[1])
  const knownAgents = [...new Set([...visibleAgents, ...prevHidden])]
  const desired = materializeEdits(gov, knownAgents)
  const desiredKeys = new Set(desired.map((e) => e.path.join(" ")))
  const stale: BuiltinPolicyEdit[] = prev.keys
    .filter((k) => !desiredKeys.has(k.join(" ")))
    .map((k) => ({ path: k, value: undefined }))

  // codex M1:记账先行(prev ∪ desired 超集)再写 jsonc —— jsonc 写成功而记账失败的孤儿叶子不可清;
  // 反向(记账超集 + jsonc 失败)只是 reset 时多删几个不存在的键,无害。成功后再收敛为精确 applied 集。
  fs.mkdirSync(alphaGlobalRoot(), { recursive: true })
  const superset = [...new Map([...prev.keys, ...desired.map((e) => e.path)].map((k) => [k.join(" "), k])).values()]
  fs.writeFileSync(materializedPath(), JSON.stringify({ keys: superset }, null, 2))

  const r = applyBuiltinPolicyEdits([...stale, ...desired])
  if (!r.ok) {
    // 回滚记账到 prev(jsonc 未动,超集记账无害但收敛回去更干净)
    fs.writeFileSync(materializedPath(), JSON.stringify({ keys: prev.keys }, null, 2))
    return { ok: false, reason: r.reason, violations: [], written: 0, removedStale: 0 }
  }

  // codex H1:只记**实际写入**的叶子(onlyIfAbsent 被跳过 = 用户自有键,绝不入账 → reset 不碰)
  fs.writeFileSync(govPath(), JSON.stringify(gov, null, 2))
  fs.writeFileSync(materializedPath(), JSON.stringify({ keys: r.applied }, null, 2))
  return { ok: true, violations: [], written: r.applied.length, removedStale: stale.length }
}

/** 重置治理:净除全部受控叶子 + 真源回默认(用户自有 jsonc 内容不动)。 */
export function resetBuiltinPolicy(): ApplyResult {
  const prev = readMaterialized()
  const r = applyBuiltinPolicyEdits(prev.keys.map((k) => ({ path: k, value: undefined })))
  if (!r.ok) return { ok: false, reason: r.reason, violations: [], written: 0, removedStale: 0 }
  fs.mkdirSync(alphaGlobalRoot(), { recursive: true })
  fs.writeFileSync(govPath(), JSON.stringify(DEFAULT_BUILTIN_POLICY, null, 2))
  fs.writeFileSync(materializedPath(), JSON.stringify({ keys: [] }, null, 2))
  return { ok: true, violations: [], written: 0, removedStale: prev.keys.length }
}

export function protectionInfo() {
  return {
    hard: [...HARD_PROTECTED_AGENTS],
    alphaInjected: [...ALPHA_INJECTED_AGENTS],
    confirm: [...CONFIRM_AGENTS],
  }
}
