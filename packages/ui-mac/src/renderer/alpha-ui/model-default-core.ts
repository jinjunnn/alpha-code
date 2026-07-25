// model-default-core — REQ-069:默认模型解析链的纯核(可单测,无 signal/IPC)。
//
// 用户报障(2026-07-08):未登录冷启动默认命中 member-only 代理模型 → 发第一条消息就被网关
// 「预授权拒绝: member-only model 需 active 会员」原文糊脸。两条旁路绕过了 REQ-056 的默认门:
//   ① 旧 localStorage 选择曾在冷启动直接生效,不做当前可用性校验(登录期选过代理模型 → 登出残留);
//   ② 自动默认只看 logged-in,不看账户 entitlement(登录但无会员/零余额同样默认到锁定模型)。
//
// 解析链(REQ-069 需求档,每级不满足才降级):
//   1. 当前 session 选择 —— 先过 checkSelectedModel;不可用 → 挂起并如实说明。
//   2. 已登录 + 账户可用 + 代理已注册 → catalog 默认档(REQ-056 语义原样保留,含单测锁定的
//      「绝不默认到 ×8 旗舰」兜底)。
//   3. 已配 KEY 的 BYOK provider → 其引擎注册的第一个模型(「上次使用」排序由第 1 级承担,MVP 不重复)。
//   4. 全无 → none:composer 保持引导占位,picker 内登录/配 KEY 双出口,发送前 preflight 拦截。

import type { ModelRef } from "@opencode-ai/sdk/v2/client"
import { isByokEngineId } from "../../shared/alpha-model-types"

export type EngineModelRef = Pick<ModelRef, "providerID" | "id">

export type ResolvedModel = ModelRef & { name: string; variants: string[] }

export type ModelResolveCtx = {
  loggedIn: boolean
  /** 账户可用于代理计费:会员 active 或钱包余额 > 0。summary 未验证或恢复中时只能传 false；
   *  该状态只门控平台代理,不能阻止已验证的本地/BYOK 目录进入解析链。 */
  accountUsable: boolean
  platformProviderId: string | null
  /** 引擎实际注册的模型;空数组 = 引擎/sdk 未就绪(冷启动常态),解析返回 wait。 */
  engineModels: EngineModelRef[]
  /** BYOK KEY 已配置(keyStatus.configured)**且**已在引擎注册的 provider id;未配 KEY 的 builtin
   *  注入行不算。只服务第 ③ 级自动默认(默认必须真能跑)。 */
  configuredProviders: string[]
  /** REQ-109 #595:本地目录 BYOK ∩ 本地 KEY 已配置的**引擎侧** provider id(`<id>-byok`)。
   *  判据只由本地目录 + 本地钥匙串决定,**不经引擎清单过滤** —— 它是「BYOK 本地可选择」谓词的载体,
   *  用于禁止引擎清单反向撤销一个本地事实支撑的选择。契约:docs/contracts/byok-availability.md。 */
  localKeyedByokProviders: string[]
  catalog: {
    defaultModel: string | null
    platformModels: Array<{ id: string; name: string; tier: string; variants?: Record<string, unknown> }>
  } | null
}

export type SelectedVerdict = { ok: true } | { ok: false; reason: "needs-login" | "needs-credit" | "provider-gone" }

/** 第 1 级:session 当前选择的可用性。判定只依据**确定的负面事实**——代理模型看登录/entitlement
 *  (auth 侧,冷启动即刻可得);BYOK 只有在引擎表已加载且查无此 provider 才判失效(空表 = 未就绪,
 *  不误杀)。代理模型不因「引擎尚未注册代理 provider」挂起 —— 那是 fork 时序,登录态下必然到来。
 *
 *  REQ-109 #595:本地目录 BYOK(本地 KEY 已配置)**豁免** provider-membership 撤销。引擎清单缺该
 *  节点是**执行面**事实 —— 由发送门(canSend)与会话切换门(switchModel)承担,**不得**反向撤销
 *  选择,否则 `model.list` 又成了「BYOK 本地可选择」的最终裁判。 */
export function checkSelectedModel(m: { providerID: string }, ctx: ModelResolveCtx): SelectedVerdict {
  if (ctx.platformProviderId && m.providerID === ctx.platformProviderId) {
    if (!ctx.loggedIn) return { ok: false, reason: "needs-login" }
    if (!ctx.accountUsable) return { ok: false, reason: "needs-credit" }
    return { ok: true }
  }
  if (ctx.localKeyedByokProviders.includes(m.providerID)) return { ok: true }
  if (ctx.engineModels.length && !ctx.engineModels.some((e) => e.providerID === m.providerID))
    return { ok: false, reason: "provider-gone" }
  return { ok: true }
}

export type DefaultResolution = { kind: "model"; model: ResolvedModel } | { kind: "wait" } | { kind: "none" }

/** 第 2/3 级:自动默认(非持久)。wait = 引擎未就绪,调用方有界重试;none = 无可默认,
 *  composer 保持占位(第 4 级空态)。 */
export function resolveDefaultModel(ctx: ModelResolveCtx): DefaultResolution {
  if (!ctx.engineModels.length) return { kind: "wait" }

  // ② 代理默认(REQ-056 原样):登录 + 账户可用 + 代理 provider 已在引擎注册
  const cat = ctx.catalog
  if (cat && ctx.platformProviderId && ctx.loggedIn && ctx.accountUsable) {
    const pid = ctx.platformProviderId
    if (ctx.engineModels.some((e) => e.providerID === pid)) {
      const hasTiers = (m: (typeof cat.platformModels)[number]) => !!m.variants && Object.keys(m.variants).length > 0
      // 偏好显式钉死:生效 catalog 的模型顺序随网关 live 清单漂移,不能拿"第一个"当默认。
      const pick =
        cat.platformModels.find((m) => m.id === (cat.defaultModel ?? "claude-sonnet-4.6") && hasTiers(m)) ??
        cat.platformModels.find((m) => m.tier !== "flag" && hasTiers(m)) ?? // 兜底:非旗舰带档位,绝不默认到 ×8
        cat.platformModels.find(hasTiers)
      if (pick)
        return {
          kind: "model",
          model: {
            providerID: pid,
            id: pick.id,
            name: pick.name,
            variants: pick.variants ? Object.keys(pick.variants) : [],
          },
        }
    }
    // 登录且可用但代理未注册:provider 与引擎模型表同来自一次 fork 的 config —— 表非空而代理缺席
    // 即本次会话确实没有代理(如 BYOK 模式),正常降级第 ③ 级,不空等。
  }

  // ③ BYOK:KEY 已配置 ∩ 引擎已注册 → 该 provider 第一个模型
  for (const pid of ctx.configuredProviders) {
    if (pid === ctx.platformProviderId) continue
    const m = ctx.engineModels.find((e) => e.providerID === pid)
    if (m) return { kind: "model", model: { providerID: m.providerID, id: m.id, name: m.id, variants: [] } }
  }

  return { kind: "none" }
}

/** preflight(发送前最后一道):平台代理模型在未登录态绝不出手 —— 用引导替代网关拒绝原文
 *  (网关校验保留为兜底防线,但正常流不该触达)。返回 null = 放行。
 *
 *  REQ-109 #595 谓词 2:`checkSelectedModel` 不再用引擎清单撤销本地 BYOK 选择(谓词 1 不可被引擎
 *  否决),**执行面就必须在这里真的挡住** —— 否则选择保住了却把一个引擎里不存在的 Model Ref 提交
 *  上去。两个谓词各自执行:可选择性归本地事实,可执行性归引擎清单。
 *
 *  **空清单同样算不满足成员关系。** 本判据刻意**不**依赖「空清单 ⇒ 引擎未就绪」—— 那是一个状态机
 *  从未承诺的不变量:`model.list` 可以成功返回 `[]`,链照样进 `ready`。把「未就绪」的判断留在
 *  它真正的所有者(`modelChainState`)身上:调用方必须在链 ready 之后才让本结论生效
 *  (`canSend` 与 `submit` 都已先行把门),冷启动窗口因此不会被误杀。 */
export function preflightBlockReason(
  model: { providerID: string; id: string } | null,
  ctx: {
    loggedIn: boolean
    platformProviderId: string | null
    hasConfiguredByok: boolean
    /** 引擎**本次实际注册**的模型。空数组不是「未知」而是「什么都没注册」——
     *  调用方负责只在 `modelChainState === "ready"` 后消费本结论。 */
    engineModels: EngineModelRef[]
  },
): "platform-needs-login" | "nothing-usable" | "byok-not-registered" | null {
  if (model && ctx.platformProviderId && model.providerID === ctx.platformProviderId && !ctx.loggedIn)
    return "platform-needs-login"
  if (
    model &&
    isByokEngineId(model.providerID) &&
    !ctx.engineModels.some((e) => e.providerID === model.providerID && e.id === model.id)
  )
    return "byok-not-registered"
  // 无选择时引擎会用自己的默认 —— 未登录且一个 KEY 都没配,那个默认不可能可用,拦下给引导。
  if (!model && !ctx.loggedIn && !ctx.hasConfiguredByok) return "nothing-usable"
  return null
}
