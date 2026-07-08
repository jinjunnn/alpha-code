// model-default-core — REQ-069:默认模型解析链的纯核(可单测,无 signal/IPC)。
//
// 用户报障(2026-07-08):未登录冷启动默认命中 member-only 代理模型 → 发第一条消息就被网关
// 「预授权拒绝: member-only model 需 active 会员」原文糊脸。两条旁路绕过了 REQ-056 的默认门:
//   ① localStorage 持久选择冷启动直接生效,不做当前可用性校验(登录期选过代理模型 → 登出残留);
//   ② 自动默认只看 logged-in,不看账户 entitlement(登录但无会员/零余额同样默认到锁定模型)。
//
// 解析链(REQ-069 需求档,每级不满足才降级):
//   1. 持久化的上次选择 —— 先过 checkPersistedModel;不可用 → 挂起(不删 localStorage,恢复条件
//      满足即还原),绝不静默沿用、也不静默换(C28)。
//   2. 已登录 + 账户可用 + 代理已注册 → catalog 默认档(REQ-056 语义原样保留,含单测锁定的
//      「绝不默认到 ×8 旗舰」兜底)。
//   3. 已配 KEY 的 BYOK provider → 其引擎注册的第一个模型(「上次使用」排序由第 1 级承担,MVP 不重复)。
//   4. 全无 → none:composer 保持引导占位,picker 内登录/配 KEY 双出口,发送前 preflight 拦截。

export type EngineModelRef = { providerID: string; modelID: string }

export type ResolvedModel = { providerID: string; modelID: string; name: string; variants: string[] }

export type ModelResolveCtx = {
  loggedIn: boolean
  /** 账户可用于代理计费:会员 active 或钱包余额 > 0。summary 网络失败时调用方给 true(疑罪从无,
   *  网关是最终裁决),summary 明确为空账户时 false(这才是要堵的坑)。 */
  accountUsable: boolean
  platformProviderId: string | null
  /** 引擎实际注册的模型;空数组 = 引擎/sdk 未就绪(冷启动常态),解析返回 wait。 */
  engineModels: EngineModelRef[]
  /** BYOK KEY 已配置(keyStatus.configured)的 provider id;未配 KEY 的 builtin 注入行不算。 */
  configuredProviders: string[]
  catalog: {
    defaultModel: string | null
    platformModels: Array<{ id: string; name: string; tier: string; variants?: Record<string, unknown> }>
  } | null
}

export type PersistedVerdict = { ok: true } | { ok: false; reason: "needs-login" | "needs-credit" | "provider-gone" }

/** 第 1 级:持久化选择的当前可用性。判定只依据**确定的负面事实**——代理模型看登录/entitlement
 *  (auth 侧,冷启动即刻可得);BYOK 只有在引擎表已加载且查无此 provider 才判失效(空表 = 未就绪,
 *  不误杀)。代理模型不因「引擎尚未注册代理 provider」挂起 —— 那是 fork 时序,登录态下必然到来。 */
export function checkPersistedModel(m: { providerID: string }, ctx: ModelResolveCtx): PersistedVerdict {
  if (ctx.platformProviderId && m.providerID === ctx.platformProviderId) {
    if (!ctx.loggedIn) return { ok: false, reason: "needs-login" }
    if (!ctx.accountUsable) return { ok: false, reason: "needs-credit" }
    return { ok: true }
  }
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
          model: { providerID: pid, modelID: pick.id, name: pick.name, variants: pick.variants ? Object.keys(pick.variants) : [] },
        }
    }
    // 登录且可用但代理未注册:provider 与引擎模型表同来自一次 fork 的 config —— 表非空而代理缺席
    // 即本次会话确实没有代理(如 BYOK 模式),正常降级第 ③ 级,不空等。
  }

  // ③ BYOK:KEY 已配置 ∩ 引擎已注册 → 该 provider 第一个模型
  for (const pid of ctx.configuredProviders) {
    if (pid === ctx.platformProviderId) continue
    const m = ctx.engineModels.find((e) => e.providerID === pid)
    if (m) return { kind: "model", model: { providerID: m.providerID, modelID: m.modelID, name: m.modelID, variants: [] } }
  }

  return { kind: "none" }
}

/** preflight(发送前最后一道):平台代理模型在未登录态绝不出手 —— 用引导替代网关拒绝原文
 *  (网关校验保留为兜底防线,但正常流不该触达)。返回 null = 放行。 */
export function preflightBlockReason(
  model: { providerID: string } | null,
  ctx: { loggedIn: boolean; platformProviderId: string | null; hasConfiguredByok: boolean },
): "platform-needs-login" | "nothing-usable" | null {
  if (model && ctx.platformProviderId && model.providerID === ctx.platformProviderId && !ctx.loggedIn)
    return "platform-needs-login"
  // 无选择时引擎会用自己的默认 —— 未登录且一个 KEY 都没配,那个默认不可能可用,拦下给引导。
  if (!model && !ctx.loggedIn && !ctx.hasConfiguredByok) return "nothing-usable"
  return null
}
