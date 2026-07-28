// composer-state — AlphaComposer 的轻量内存投影与提交纯核。
//
// 设计要点(用户拍板 2026-07-07:「自建、不再集成 opencode、不要止血」):
// - model / variant 统一使用 typed Model.Ref；session 以服务端 session state 为真源，本模块只保存
//   已确认的 UI 投影。home 在创建会话前暂存选择，创建时直接写入 Session model。
// - model / variant 不落 localStorage，避免与上游 session context 形成跨会话双真值。
// - 纯函数(buildPromptRequest / routeSlash / filterAgents)与 signals 分离,前者可直接单测。

import { createSignal } from "solid-js"
import type { ModelRef } from "@opencode-ai/sdk/v2/client"

/* ── 类型 ─────────────────────────────────────────────────────────────────── */

export type ComposerModel = ModelRef & {
  /** display name(catalog 有则用,BYOK 用 Model.Ref id) */
  name: string
  /** 该模型定义的推理档位名(alpha-models.json variants 键,如 低/中/高);空 = 不支持 */
  variants: string[]
}

export type ComposerAgent = { name: string; description?: string }

/** REQ-126 AC7(#658):曾经还有第三档 `full`(「全自动」)。它是**空承诺** —— 提交层
 *  (buildPromptRequest)只对 `readonly` 分支,`full` 与 `ask` 产出**逐字节相同**的请求;chip 唯一
 *  的"生效"路径是发上游 `permissions.autoaccept.enable/.disable`,而上游只有单个
 *  `permissions.autoaccept`,这两个 id 从来不存在,且其注册处随 session 叶一起退役。真做「全自动」
 *  = 接权限引擎自动放行,是新能力,不在本票射程内 → 退休该档,不留一个点了不算数的开关。 */
export type PermMode = "ask" | "readonly"

/** 只读档的真载体(REQ-028:静态权限档 edit/bash deny 的引擎 agent)。 */
export const READONLY_AGENT = "alpha-readonly"

/** alpha 内部 agent —— 永不出现在任何用户可见选择列表(用户报障 2026-07-07:「为什么会出现这个」)。
 *  它们仍可被程序化 prompt(调度器/只读档),隐藏只影响列表。 */
export const INTERNAL_AGENTS = new Set(["alpha-automation", "alpha-automation-standard", READONLY_AGENT])

/* #652:会话档位推送账本(recordPushedAgent / pushedAgentFor / DEFAULT_AGENT)随 v2 durable
 * 发送一起退役。它只为「v2 引擎无 per-prompt agent、档位是会话级属性」而存在:composer 发送前
 * 经 switchAgent 落档、失败再 CAS 回滚。回到 v1 promptAsync 后,agent 是**每条消息自带的字段**
 * (SessionPrompt.PromptInput.agent),会话上没有需要被推送与回滚的中间状态,账本无主体。 */

/* ── signals(模块级 = 所有渲染面共享)──────────────────────────────────────── */

const [model, setModelSignal] = createSignal<ComposerModel | null>(null)
export type ComposerModelProjection = {
  status: "loading" | "ready" | "error"
  sessionID: string | null
}
const [modelProjection, setModelProjection] = createSignal<ComposerModelProjection>({
  status: "ready",
  sessionID: null,
})
const [perm, setPerm] = createSignal<PermMode>("ask")
const [agent, setAgent] = createSignal<string | null>(null) // null = 引擎默认(build)
const [agents, setAgents] = createSignal<ComposerAgent[]>([])

export const composerModel = model
export const composerModelProjection = modelProjection
export const composerEffortSel = () => model()?.variant ?? null
export const composerPerm = perm
export const composerAgent = agent
export const composerAgents = agents
export { setPerm as setComposerPerm, setAgent as setComposerAgent, setAgents as setComposerAgents }

/** 登录且代理可用时自动选中 catalog 默认档；只在当前无选择时生效。 */
export function applyDefaultComposerModel(m: ComposerModel) {
  if (model()) return
  setModelSignal(m)
}

/* ── REQ-069:当前选择的挂起/恢复 ────────────────────────────────────────────── */

export type SuspendReason = "needs-login" | "needs-credit" | "provider-gone"
export type SuspendedModel = { model: ComposerModel; reason: SuspendReason }

const [suspended, setSuspended] = createSignal<SuspendedModel | null>(null)
export const composerModelSuspended = suspended

export function suspendComposerModel(reason: SuspendReason) {
  const m = model()
  if (!m) return
  setSuspended({ model: m, reason })
  setModelSignal(null)
}

export function clearSuspendedModel() {
  setSuspended(null)
}

export function setComposerModel(m: ComposerModel | null) {
  setModelSignal(m?.variant && !m.variants.includes(m.variant) ? { ...m, variant: undefined } : m)
}

/** Session 路由一进入新的同步 epoch 就先撤销旧投影，避免上一会话的 Ref 仍可被操作。 */
export function invalidateComposerModelProjection(sessionID: string) {
  setModelSignal(null)
  setSuspended(null)
  setModelProjection({ status: "loading", sessionID })
}

export function resolveComposerModelProjection(sessionID: string, next: ComposerModel | null) {
  setComposerModel(next)
  setSuspended(null)
  setModelProjection({ status: "ready", sessionID })
}

export function failComposerModelProjection(sessionID: string) {
  setModelSignal(null)
  setSuspended(null)
  setModelProjection({ status: "error", sessionID })
}

/** home 没有服务端 Session 投影；控件使用创建会话前的内存选择。 */
export function resetComposerModelProjection() {
  setModelProjection({ status: "ready", sessionID: null })
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
  model?: ModelRef
  agent?: string
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
  if (input.model)
    req.model = {
      id: input.model.id,
      providerID: input.model.providerID,
      ...(input.effort && input.model.variants.includes(input.effort) ? { variant: input.effort } : {}),
    }
  if (input.perm === "readonly") req.agent = READONLY_AGENT
  else if (input.agent) req.agent = input.agent
  return req
}
