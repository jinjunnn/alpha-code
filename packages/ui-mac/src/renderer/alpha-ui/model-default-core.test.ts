// REQ-069/090 — 默认模型解析链纯核单测:session 选择校验 / 解析链降级 / 发送 preflight。
import { describe, expect, test } from "bun:test"
import {
  checkSelectedModel,
  preflightBlockReason,
  resolveDefaultModel,
  type ModelResolveCtx,
} from "./model-default-core"

const PLATFORM = "alpha"
const CATALOG: ModelResolveCtx["catalog"] = {
  defaultModel: null,
  platformModels: [
    { id: "claude-fable-5", name: "Claude Fable 5", tier: "flag", variants: { 高: {} } },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", tier: "pro", variants: { 低: {}, 中: {}, 高: {} } },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", tier: "std" },
  ],
}

const ctx = (over: Partial<ModelResolveCtx>): ModelResolveCtx => ({
  loggedIn: false,
  accountUsable: false,
  platformProviderId: PLATFORM,
  engineModels: [],
  configuredProviders: [],
  catalog: CATALOG,
  ...over,
})

const proxyModel = { providerID: PLATFORM }
const dsModel = { providerID: "deepseek" }
const engineWithProxy = [
  { providerID: PLATFORM, id: "claude-sonnet-4.6" },
  { providerID: PLATFORM, id: "claude-fable-5" },
]
const engineWithDs = [{ providerID: "deepseek", id: "deepseek-chat" }]

describe("checkSelectedModel(第①级:session 当前选择校验)", () => {
  test("代理模型 + 未登录 → needs-login(用户报障主路径:登出残留)", () => {
    expect(checkSelectedModel(proxyModel, ctx({}))).toEqual({ ok: false, reason: "needs-login" })
  })
  test("代理模型 + 登录但账户不可用(无会员零余额)→ needs-credit", () => {
    expect(checkSelectedModel(proxyModel, ctx({ loggedIn: true, accountUsable: false }))).toEqual({
      ok: false,
      reason: "needs-credit",
    })
  })
  test("代理模型 + 登录 + 账户可用 → ok(引擎表为空也不挂起 —— fork 时序不误杀)", () => {
    expect(checkSelectedModel(proxyModel, ctx({ loggedIn: true, accountUsable: true }))).toEqual({ ok: true })
  })
  test("BYOK 模型 + 引擎表为空(未就绪)→ ok(不误杀)", () => {
    expect(checkSelectedModel(dsModel, ctx({}))).toEqual({ ok: true })
  })
  test("BYOK 模型 + 引擎表已加载且查无此 provider → provider-gone", () => {
    expect(checkSelectedModel(dsModel, ctx({ engineModels: engineWithProxy }))).toEqual({
      ok: false,
      reason: "provider-gone",
    })
  })
  test("BYOK 模型 + provider 仍注册 → ok(与登录态无关)", () => {
    expect(checkSelectedModel(dsModel, ctx({ engineModels: engineWithDs }))).toEqual({ ok: true })
  })
})

describe("resolveDefaultModel(第②③④级:自动默认)", () => {
  test("引擎未就绪(空表)→ wait(调用方有界重试)", () => {
    expect(resolveDefaultModel(ctx({ loggedIn: true, accountUsable: true })).kind).toBe("wait")
  })
  test("② 登录+可用+代理已注册 → catalog 默认档(defaultModel 空 → 非旗舰带档位,绝不 ×8)", () => {
    const r = resolveDefaultModel(ctx({ loggedIn: true, accountUsable: true, engineModels: engineWithProxy }))
    expect(r).toEqual({
      kind: "model",
      model: { providerID: PLATFORM, id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", variants: ["低", "中", "高"] },
    })
  })
  test("② defaultModel 显式指定且带档位 → 按指定选", () => {
    const cat = { ...CATALOG!, defaultModel: "claude-fable-5" }
    const r = resolveDefaultModel(
      ctx({ loggedIn: true, accountUsable: true, engineModels: engineWithProxy, catalog: cat }),
    )
    expect(r.kind === "model" && r.model.id).toBe("claude-fable-5")
  })
  test("未登录 → 绝不默认平台模型;有已配 KEY 的 BYOK → 降级第③级(报障核心验收)", () => {
    const r = resolveDefaultModel(
      ctx({ engineModels: [...engineWithProxy, ...engineWithDs], configuredProviders: ["deepseek"] }),
    )
    expect(r).toEqual({
      kind: "model",
      model: { providerID: "deepseek", id: "deepseek-chat", name: "deepseek-chat", variants: [] },
    })
  })
  test("登录但账户不可用 → 同样不默认平台模型,走 BYOK", () => {
    const r = resolveDefaultModel(
      ctx({
        loggedIn: true,
        accountUsable: false,
        engineModels: [...engineWithProxy, ...engineWithDs],
        configuredProviders: ["deepseek"],
      }),
    )
    expect(r.kind === "model" && r.model.providerID).toBe("deepseek")
  })
  test("BYOK 只认已配 KEY 的 provider —— 未配 KEY 的 builtin 注入行不算", () => {
    const r = resolveDefaultModel(ctx({ engineModels: [...engineWithProxy, ...engineWithDs], configuredProviders: [] }))
    expect(r.kind).toBe("none")
  })
  test("configuredProviders 混入平台 id → 跳过(平台默认只走②级门)", () => {
    const r = resolveDefaultModel(ctx({ engineModels: engineWithProxy, configuredProviders: [PLATFORM] }))
    expect(r.kind).toBe("none")
  })
  test("④ 全无 → none(空态引导,不是随便选一个装可用)", () => {
    expect(resolveDefaultModel(ctx({ engineModels: engineWithProxy })).kind).toBe("none")
  })
})

describe("preflightBlockReason(发送前最后一道)", () => {
  const pctx = (
    over: Partial<{ loggedIn: boolean; platformProviderId: string | null; hasConfiguredByok: boolean }>,
  ) => ({
    loggedIn: false,
    platformProviderId: PLATFORM,
    hasConfiguredByok: false,
    ...over,
  })
  test("未登录 + 选中平台模型 → 拦(引导替代网关拒绝原文)", () => {
    expect(preflightBlockReason(proxyModel, pctx({}))).toBe("platform-needs-login")
  })
  test("登录 + 平台模型 → 放行(entitlement 由网关最终裁决)", () => {
    expect(preflightBlockReason(proxyModel, pctx({ loggedIn: true }))).toBeNull()
  })
  test("BYOK 模型 → 未登录也放行", () => {
    expect(preflightBlockReason(dsModel, pctx({}))).toBeNull()
  })
  test("无选择 + 未登录 + 无任何 KEY → 拦(引擎默认不可能可用)", () => {
    expect(preflightBlockReason(null, pctx({}))).toBe("nothing-usable")
  })
  test("无选择 + 未登录 + 有 KEY → 放行(引擎默认可落 BYOK)", () => {
    expect(preflightBlockReason(null, pctx({ hasConfiguredByok: true }))).toBeNull()
  })
  test("无选择 + 已登录 → 放行", () => {
    expect(preflightBlockReason(null, pctx({ loggedIn: true }))).toBeNull()
  })
  test("catalog 未知(platformProviderId null)→ 平台判定不误伤", () => {
    expect(preflightBlockReason(proxyModel, pctx({ platformProviderId: null, hasConfiguredByok: true }))).toBeNull()
  })
})
