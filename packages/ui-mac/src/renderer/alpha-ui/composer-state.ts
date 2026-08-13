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

/* ── 档位的会话归属(#570)──────────────────────────────────────────────────────
 * 已批稿(`docs/design/current/assemble-popup/design.html`「③ 计划作用域:会话级;新会话默认
 * build」)说档位是**会话级**的,而上面那个 signal 是**模块级**的 —— 所有渲染面共用一份
 * composer 状态。两者不一致时档位跟着人跑:在会话 A 开「计划」、点侧栏进会话 B,B 的 chip 照样
 * 显示「计划」,B 的下一条消息也真的以 `agent=plan` 发出 —— 而用户从没在 B 开过它。
 *
 * #570 原本的两条候选路(消费 v2 `session.next.agent.switched`、或给档位补版本号)已随
 * [[ADR-036]] §决策 1 一起没了主体:v2 `switchAgent` 在 alpha 侧零生产调用方,档位随每条消息走
 * `PromptInput.agent`,全程不过网 —— 没有信道,也没有「陈旧」可言。**今天仅存的档位不一致就是
 * 这条作用域**,它是纯本地的。
 *
 * 归属的做法与草稿暂存同形(`session-workspace/session-dock-core` 的
 * `createComposerDraftStash`):composer 按会话 adopt / release。只登记**非默认**档位(默认档
 * 不占位),且**登记无损**——没有容量淘汰。
 *
 * #896:这里原先照抄草稿暂存写了个 32 项 LRU,并说「越界回默认档,那是引擎自己的 build,永远是
 * 可解释的一档」——**那句话是错的**,与 #884 里被证伪的「丢登记只会多问一次」是同一形态。实读
 * `packages/opencode/src/agent/agent.ts`:`build` 自陈 "The default agent. Executes tools based on
 * configured permissions",而 `plan` 把 `edit` 的写口限死在 plan 目录。所以越界回落 build 不是
 * 「回到安全默认」,是**放宽能力**:依次在 33 个会话里开计划,第 1 个就被挤掉,回到它时 chip 变回
 * 普通档、请求也不再带 `agent=plan` —— 用户选的「只做计划、别动我的文件」被系统悄悄关掉了。
 * 登记是「用户显式选过非默认档」的唯一凭据,不能有损。规模量级:一条登记 = 一把身份键 + 一个
 * 档位名(百字节量级),且只有**显式开过非默认档**的会话才占位,与同文件里已经无界的 perm 那份、
 * 以及会话草稿暂存同量级 —— 没有实测得出的规模问题,就不留一个会静默改语义的上界。
 *
 * #891:键是**仓内既有的 canonical 会话身份键** —— `session-workspace-core` 的
 * `identityKey(AlphaSessionIdentity)`(`serverKey\0directory\0sessionID`),与草稿暂存
 * (`createComposerDraftStash`)、artifacts、review 用的是同一把钥匙。此前这里拿 raw `sessionID`
 * 当永久身份,同一个仓里就有了两套会话口径:同一个 id 出现在不同 serverKey / directory 下时
 * 两边共用一条登记(串档),会话删掉后又出现同 id 也会静默继承旧的只读档。本模块不认识身份的
 * 结构,只认宿主传进来的那把钥匙 —— 造钥匙的地方只有一处(`alpha-composer` 的 scope effect
 * 与 home 提交后的 seed),都过 `identityKey`。 */
const agentByScope = new Map<string, string>()
/** 当前持有档位信号的会话身份键;null = 首页(新会话入口)、身份未定、或无人持有。 */
let agentScopeOwner: string | null = null
/** 每次 adopt 发一张新租约。release 必须**同时**匹配 scope 与租约 —— 只比 scope 的话,同一个
 *  身份键的新旧两个实例分不开:旧实例的 cleanup 会把新实例刚拿到的持有权清成 null,新实例
 *  之后的改动就再也落不了账。租约单调递增,永不复位(复位会让陈旧租约与新租约撞号)。 */
let agentScopeLease = 0

function rememberScopedAgent(scopeKey: string, value: string | null) {
  if (value === null) {
    agentByScope.delete(scopeKey) // 默认档 = 不登记(显式切回 build 时要把旧登记删掉)
    return
  }
  agentByScope.set(scopeKey, value)
}

/** 挂载:接管该身份的档位(无登记 = 默认 build)。`null` = 首页或身份未定,一律回默认。返回本次
 *  租约,卸载时必须原样交回 `releaseComposerAgentScope`。 */
export function adoptComposerAgentScope(scopeKey: string | null): number {
  // 先把**现任持有者**的值落账。宿主完全可能 adopt 早于 release(新面先挂、旧面后卸),那时旧值
  // 根本还没机会写回,只在 release 上设守卫等于「防错写、不防丢写」:A 开了计划、B 先 adopt、
  // A 后 release 看见 owner 是 B 就直接 return ⇒ 回到 A 永久掉回默认档。
  if (agentScopeOwner !== null) rememberScopedAgent(agentScopeOwner, agent())
  agentScopeOwner = scopeKey
  agentScopeLease += 1
  setAgent(scopeKey === null ? null : (agentByScope.get(scopeKey) ?? null))
  return agentScopeLease
}

/** 卸载:把当前档位交还给该身份。**只有仍持有那张租约时才写** —— 别的实例已经接管(不论它接管的
 *  是不是同一个身份键)就不许再覆盖它的值。 */
export function releaseComposerAgentScope(scopeKey: string | null, lease: number) {
  if (agentScopeLease !== lease || agentScopeOwner !== scopeKey) return
  if (scopeKey !== null) rememberScopedAgent(scopeKey, agent())
  agentScopeOwner = null
}

/** 首页发出第一条消息后新建的那个会话,继承这条消息用的档位 —— 它就是同一段对话的开头。
 *  少了这一步,「在首页开计划模式发第一条」会在跳进会话页的瞬间掉回默认档。
 *  `scopeKey` 与会话页 adopt 时用的必须是同一把钥匙(`identityKey`),否则这条登记永远没人认领。 */
export function seedComposerAgentScope(scopeKey: string, value: string | null) {
  rememberScopedAgent(scopeKey, value)
}

/** 测试隔离:清空会话档位登记与持有者(模块级状态跨用例会串,和 signal 本身一样要复位)。 */
export function resetComposerAgentScopesForTests() {
  agentByScope.clear()
  agentScopeOwner = null
}

/* ── 只读档的会话归属(#884)────────────────────────────────────────────────────
 * 上面把**档位**归到会话名下了,只读档没跟上就等于没改:`buildPromptRequest` 里
 * `perm === "readonly"` 会把 agent 强制成 READONLY_AGENT 并**压过**手选档位(本文件末尾那段),
 * 而 perm 同样是模块级 signal、同样没有任何重置点(连 home 挂载那段都只重置了 model/投影)。
 * 合起来:在 A 打开只读、切到 B,B 的只读 chip 照样亮着,B 手选的档位也被 READONLY_AGENT 顶掉
 * —— 用户在 B 从没开过只读,只会看到模型忽然不肯动文件。
 *
 * 机制与档位那份**逐条同形**:同一把钥匙(canonical 身份键 / null=首页,见 #891)、同一处
 * adopt/release(alpha-composer 的那一个 createEffect)、同一套租约守卫。两处差别,都在这一段说清:
 *
 * ① 默认值不同 —— 档位的默认是 `null`(引擎自己的 build),只读档的默认是 `"ask"`(引擎默认的
 *    逐次审批),所以「默认不登记」这条判的是 `=== "ask"`。
 * ② **只读档这一份没有容量上界**(#896 起档位那份也没有,两份至此逐条同形)。
 *    原先照抄了草稿暂存的 LRU,并在这里写着「丢登记只会多问一次,不会静默放松限制」——
 *    **那句话是错的**:依次在 33 个会话里开只读,第 1 个就被淘汰,回到它时 chip 变回「请求审批」、
 *    请求也不再带 `alpha-readonly`。ask 确实不会未经批准就写盘,但**是系统替用户把只读关掉了**,
 *    而用户从没做过这个动作。登记是「用户显式开过只读」的唯一凭据,不能有损。 */
const permByScope = new Map<string, PermMode>()
/** 当前持有只读档信号的会话身份键;null = 首页(新会话入口)、身份未定、或无人持有。 */
let permScopeOwner: string | null = null
/** 租约语义同档位那份(见 `agentScopeLease`)。两份各自持有,不共用计数器。 */
let permScopeLease = 0

function rememberScopedPerm(scopeKey: string, value: PermMode) {
  if (value === "ask") {
    permByScope.delete(scopeKey) // 默认档 = 不登记(显式退出只读时要把旧登记删掉)
    return
  }
  permByScope.set(scopeKey, value)
}

/** 挂载:接管该身份的只读档(无登记 = 默认 ask)。`null` = 首页或身份未定,一律回默认。 */
export function adoptComposerPermScope(scopeKey: string | null): number {
  // 先落账现任持有者的值,理由同档位那份(adopt 可能早于 release)。
  if (permScopeOwner !== null) rememberScopedPerm(permScopeOwner, perm())
  permScopeOwner = scopeKey
  permScopeLease += 1
  setPerm(scopeKey === null ? "ask" : (permByScope.get(scopeKey) ?? "ask"))
  return permScopeLease
}

/** 卸载:把当前只读档交还给该身份。守卫同档位那条 —— 租约不匹配即不写。 */
export function releaseComposerPermScope(scopeKey: string | null, lease: number) {
  if (permScopeLease !== lease || permScopeOwner !== scopeKey) return
  if (scopeKey !== null) rememberScopedPerm(scopeKey, perm())
  permScopeOwner = null
}

/** 首页发出第一条消息后新建的那个会话,继承这条消息用的只读档 —— 第一条就是以只读发出去的。
 *  `scopeKey` 同上:必须与会话页 adopt 用的是同一把 `identityKey`。 */
export function seedComposerPermScope(scopeKey: string, value: PermMode) {
  rememberScopedPerm(scopeKey, value)
}

/** 测试隔离:清空会话只读档登记与持有者。 */
export function resetComposerPermScopesForTests() {
  permByScope.clear()
  permScopeOwner = null
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

/** 斜杠命令来源(引擎 `/command` 注册方声明的 `source`;E3/E4 chip 分型的唯一依据)。 */
export type SlashCommandSource = "command" | "mcp" | "skill"

/**
 * 从 `/command` 响应条目读注册方声明的 `source`(REQ-125 E3/E4)。
 * 只认引擎给出的三个字面量;缺席/未知值 → undefined(fail-closed:chip 回通用形,不猜)。
 * 基线 2026-08-08 §6/T3:来源只读声明,禁止从命令名反推。
 */
export function slashSourceOf(entry: unknown): SlashCommandSource | undefined {
  if (typeof entry !== "object" || entry === null) return undefined
  const source = (entry as { source?: unknown }).source
  return source === "command" || source === "mcp" || source === "skill" ? source : undefined
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
