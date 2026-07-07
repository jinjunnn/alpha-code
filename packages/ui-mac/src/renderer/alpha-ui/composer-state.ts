// composer-state — REQ-055:AlphaComposer 的本地状态核(单一真源,home + session 共用)。
//
// 设计要点(用户拍板 2026-07-07:「自建、不再集成 opencode、不要止血」):
// - 模型 / 推理档(variant)/ agent / 权限全部是 **alpha 本地状态**,提交时作为 SDK 显式参数
//   (session.promptAsync 原生收 model/agent/variant)——彻底废除「驱动/观察上游隐藏控件」
//   (agent.cycle 轮转、variant cycleTo、MutationObserver 标签发布)那一整类脆机制。
// - 未显式选择时**不传参数**(引擎用自己的默认),保持最小干预;显式选过即持久(localStorage),
//   两个界面、跨会话、跨重启永远一致。
// - 纯函数(buildPromptRequest / routeSlash / filterAgents)与 signals 分离,前者可直接单测。

import { createSignal } from "solid-js"

/* ── 类型 ─────────────────────────────────────────────────────────────────── */

export type ComposerModel = {
  providerID: string
  modelID: string
  /** display name(catalog 有则用,BYOK 用 modelID) */
  name: string
  /** 该模型定义的推理档位名(alpha-models.json variants 键,如 低/中/高);空 = 不支持 */
  variants: string[]
}

export type ComposerAgent = { name: string; description?: string }

export type PermMode = "full" | "ask" | "readonly"

/** 只读档的真载体(REQ-028:静态权限档 edit/bash deny 的引擎 agent)。 */
export const READONLY_AGENT = "alpha-readonly"

/** alpha 内部 agent —— 永不出现在任何用户可见选择列表(用户报障 2026-07-07:「为什么会出现这个」)。
 *  它们仍可被程序化 prompt(调度器/只读档),隐藏只影响列表。 */
export const INTERNAL_AGENTS = new Set(["alpha-automation", "alpha-automation-standard", READONLY_AGENT])

/* ── signals(模块级 = 所有渲染面共享)──────────────────────────────────────── */

const MODEL_KEY = "alpha.composer.model"
const EFFORT_KEY = "alpha.composer.effort"

function loadPersistedModel(): ComposerModel | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v.providerID === "string" && typeof v.modelID === "string")
      return { providerID: v.providerID, modelID: v.modelID, name: v.name ?? v.modelID, variants: Array.isArray(v.variants) ? v.variants : [] }
  } catch {
    /* 损坏的持久值按未选择处理 */
  }
  return null
}

const [model, setModelSignal] = createSignal<ComposerModel | null>(loadPersistedModel())
const [effort, setEffortSignal] = createSignal<string | null>(
  (() => {
    try {
      return localStorage.getItem(EFFORT_KEY)
    } catch {
      return null
    }
  })(),
)
const [perm, setPerm] = createSignal<PermMode>("ask")
const [agent, setAgent] = createSignal<string | null>(null) // null = 引擎默认(build)
const [agents, setAgents] = createSignal<ComposerAgent[]>([])

export const composerModel = model
export const composerEffortSel = effort
export const composerPerm = perm
export const composerAgent = agent
export const composerAgents = agents
export { setPerm as setComposerPerm, setAgent as setComposerAgent, setAgents as setComposerAgents }

/** 非持久默认模型:登录且代理可用时自动选中 catalog 默认档(用户报障 2026-07-07:「选择模型」
 *  占位 + effort 无档可点 = 死状态)。只在当前无选择时生效;**不落盘** —— 只有用户显式选择
 *  (setComposerModel)才持久,下次启动重算默认(catalog 换默认即时跟随)。 */
export function applyDefaultComposerModel(m: ComposerModel) {
  if (model()) return
  setModelSignal(m)
}

export function setComposerModel(m: ComposerModel | null) {
  setModelSignal(m)
  try {
    if (m) localStorage.setItem(MODEL_KEY, JSON.stringify(m))
    else localStorage.removeItem(MODEL_KEY)
  } catch {
    /* persistence best-effort */
  }
  // 换模型后旧档位未必存在:不存在则清掉(诚实回默认,不假装还在旧档)。
  const e = effort()
  if (m && e && !m.variants.includes(e)) setComposerEffort(null)
  if (!m) setComposerEffort(null)
}

export function setComposerEffort(v: string | null) {
  setEffortSignal(v)
  try {
    if (v) localStorage.setItem(EFFORT_KEY, v)
    else localStorage.removeItem(EFFORT_KEY)
  } catch {
    /* best-effort */
  }
}

/* ── 纯函数(单测覆盖)────────────────────────────────────────────────────── */

/** `/name args` → 斜杠路由;非斜杠返回 null。与 use-projects.startChat 既有语义一致。 */
export function routeSlash(body: string): { name: string; args: string } | null {
  const [head, ...tail] = body.split(" ")
  if (!head?.startsWith("/") || head.length < 2) return null
  return { name: head.slice(1), args: tail.join(" ") }
}

/** SDK /agent 列表 → 用户可见 agent:排除 subagent、hidden、alpha 内部档。 */
export function filterAgents(
  list: Array<{ name: string; mode?: string; hidden?: boolean; description?: string }>,
): ComposerAgent[] {
  return list
    .filter((a) => a && typeof a.name === "string")
    .filter((a) => a.mode !== "subagent" && a.hidden !== true && !INTERNAL_AGENTS.has(a.name))
    .map((a) => ({ name: a.name, description: a.description }))
}

export type PromptRequest = {
  parts: unknown[]
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
}

/** 提交参数构造:
 *  - readonly 权限 → agent 强制 alpha-readonly(压过手选 agent;退出只读即恢复);
 *  - variant 只在当前模型确实定义了该档时携带(C28:绝不发引擎不认识的档);
 *  - 未显式选择的维度不传(引擎默认)。 */
export function buildPromptRequest(input: {
  text: string
  extraParts?: unknown[]
  model: ComposerModel | null
  effort: string | null
  perm: PermMode
  agent: string | null
}): PromptRequest {
  const req: PromptRequest = {
    parts: [{ type: "text", text: input.text }, ...(input.extraParts ?? [])],
  }
  if (input.model) req.model = { providerID: input.model.providerID, modelID: input.model.modelID }
  if (input.perm === "readonly") req.agent = READONLY_AGENT
  else if (input.agent) req.agent = input.agent
  if (input.model && input.effort && input.model.variants.includes(input.effort)) req.variant = input.effort
  return req
}
