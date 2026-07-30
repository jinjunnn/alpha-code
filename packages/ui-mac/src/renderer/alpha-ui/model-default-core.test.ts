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
  defaultPlatformModel: "deepseek-v4-flash",
  platformModels: [
    { id: "claude-fable-5", name: "Claude Fable 5", variants: { 高: {} } },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", variants: { 低: {}, 中: {}, 高: {} } },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  ],
}

const ctx = (over: Partial<ModelResolveCtx>): ModelResolveCtx => ({
  loggedIn: false,
  accountUsable: false,
  platformProviderId: PLATFORM,
  engineModels: [],
  configuredProviders: [],
  localKeyedByokProviders: [],
  catalog: CATALOG,
  ...over,
})

const proxyModel = { providerID: PLATFORM, id: "claude-sonnet-5" }
const dsModel = { providerID: "deepseek", id: "deepseek-chat" }
const engineWithProxy = [
  { providerID: PLATFORM, id: "claude-sonnet-5" },
  { providerID: PLATFORM, id: "claude-fable-5" },
  { providerID: PLATFORM, id: "deepseek-v4-flash" },
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

  // REQ-109 #595:引擎清单不得反向撤销一个本地目录 + 本地 KEY 支撑的选择。
  test("#595:本地目录 BYOK(KEY 已配置)+ 引擎表非空且查无此 provider → 仍 ok,不判 provider-gone", () => {
    const local = { providerID: "deepseek-byok" }
    expect(
      checkSelectedModel(local, ctx({ engineModels: engineWithProxy, localKeyedByokProviders: ["deepseek-byok"] })),
    ).toEqual({ ok: true })
    // 反面:同一形状但本地 KEY 未配置(不在 localKeyedByokProviders)→ 照旧撤销,主权不等于放行一切。
    expect(checkSelectedModel(local, ctx({ engineModels: engineWithProxy }))).toEqual({
      ok: false,
      reason: "provider-gone",
    })
    // 豁免只覆盖本地目录 BYOK:自定义节点消失仍照旧撤销。
    expect(
      checkSelectedModel({ providerID: "my-endpoint" }, ctx({
        engineModels: engineWithProxy,
        localKeyedByokProviders: ["deepseek-byok"],
      })),
    ).toEqual({ ok: false, reason: "provider-gone" })
  })

  test("#595:豁免不越界到平台代理 —— 平台 id 即使被误列也仍走登录/额度判据", () => {
    expect(checkSelectedModel(proxyModel, ctx({ localKeyedByokProviders: [PLATFORM] }))).toEqual({
      ok: false,
      reason: "needs-login",
    })
  })
})

describe("resolveDefaultModel(第②③④级:自动默认)", () => {
  test("引擎未就绪(空表)→ wait(调用方有界重试)", () => {
    expect(resolveDefaultModel(ctx({ loggedIn: true, accountUsable: true })).kind).toBe("wait")
  })
  test("② 登录+可用+代理已注册 → 目录显式声明的那个平台模型(而不是顺序或价格挑出来的)", () => {
    const r = resolveDefaultModel(ctx({ loggedIn: true, accountUsable: true, engineModels: engineWithProxy }))
    expect(r).toEqual({
      kind: "model",
      model: { providerID: PLATFORM, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", variants: [] },
    })
  })
  test("② 换一个声明就换一个默认(声明是唯一旋钮;带 variants 的照样能当默认)", () => {
    const cat = { ...CATALOG!, defaultPlatformModel: "claude-fable-5" }
    const r = resolveDefaultModel(
      ctx({ loggedIn: true, accountUsable: true, engineModels: engineWithProxy, catalog: cat }),
    )
    expect(r).toEqual({
      kind: "model",
      model: { providerID: PLATFORM, id: "claude-fable-5", name: "Claude Fable 5", variants: ["高"] },
    })
  })

  // #679 —— 这一组是本票的核心不变量:**默认解析不得看见价格,也不得看见顺序**。
  // 本地档位删除前,第 ② 级是「非旗舰的第一个带档位的模型」;那既是价格判断,也是顺序判断。
  describe("#679:默认解析与价格、与目录顺序都无关", () => {
    const declared = (over: Partial<NonNullable<ModelResolveCtx["catalog"]>> = {}) =>
      resolveDefaultModel(
        ctx({
          loggedIn: true,
          accountUsable: true,
          engineModels: engineWithProxy,
          catalog: { ...CATALOG!, ...over },
        }),
      )
    const pickedId = (r: ReturnType<typeof resolveDefaultModel>) => (r.kind === "model" ? r.model.id : r.kind)

    test("目录顺序反过来,选中的还是同一个", () => {
      expect(pickedId(declared({ platformModels: [...CATALOG!.platformModels].reverse() }))).toBe("deepseek-v4-flash")
    })

    test("给声明的那个模型挂上全场最贵的倍数,结论不变(解析链根本读不到 pricing)", () => {
      // 刻意把 pricing 塞进目录条目 —— ctx 的类型里没有它,所以这是「万一将来漏进来」的实测。
      const priced = CATALOG!.platformModels.map((model) => ({
        ...model,
        pricing: model.id === "deepseek-v4-flash" ? { input: 71.4, output: 178.6 } : { input: 1, output: 1 },
      })) as NonNullable<ModelResolveCtx["catalog"]>["platformModels"]
      expect(pickedId(declared({ platformModels: priced }))).toBe("deepseek-v4-flash")
      expect(pickedId(declared({ platformModels: [...priced].reverse() }))).toBe("deepseek-v4-flash")
    })

    test("声明缺席(null)→ 不回落到任何平台模型,直接降级", () => {
      expect(declared({ defaultPlatformModel: null }).kind).toBe("none")
    })

    test("声明的 id 不在生效目录中(被 edition 白名单筛掉)→ 同样不回落,反序也一样", () => {
      expect(declared({ defaultPlatformModel: "model-that-edition-filtered-out" }).kind).toBe("none")
      expect(
        declared({
          defaultPlatformModel: "model-that-edition-filtered-out",
          platformModels: [...CATALOG!.platformModels].reverse(),
        }).kind,
      ).toBe("none")
    })

    test("声明缺席时仍老实降级到已配 KEY 的 BYOK(不默认平台 ≠ 什么都不给)", () => {
      const r = resolveDefaultModel(
        ctx({
          loggedIn: true,
          accountUsable: true,
          engineModels: [...engineWithProxy, ...engineWithDs],
          configuredProviders: ["deepseek"],
          catalog: { ...CATALOG!, defaultPlatformModel: null },
        }),
      )
      expect(r.kind === "model" && r.model.providerID).toBe("deepseek")
    })
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
    over: Partial<Parameters<typeof preflightBlockReason>[1]>,
  ): Parameters<typeof preflightBlockReason>[1] => ({
    loggedIn: false,
    platformProviderId: PLATFORM,
    hasConfiguredByok: false,
    engineModels: [],
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
  // REQ-109 #595 谓词 2:撤销豁免让选择活了下来,发送门必须自己挡住不可执行的提交。
  test("#595:本地 BYOK 已选但引擎清单(非空)查无该节点 → byok-not-registered", () => {
    const byok = { providerID: "deepseek-byok", id: "deepseek-v4-flash" }
    expect(preflightBlockReason(byok, pctx({ engineModels: engineWithProxy }))).toBe("byok-not-registered")
  })
  test("#595:引擎清单含该节点 → 放行(不得过度收紧)", () => {
    const byok = { providerID: "deepseek-byok", id: "deepseek-v4-flash" }
    expect(preflightBlockReason(byok, pctx({ engineModels: [byok] }))).toBeNull()
    // 同 provider 但 model id 不在册 —— 提交的是引擎不认识的 Ref,照样拦。
    expect(
      preflightBlockReason({ providerID: "deepseek-byok", id: "ghost" }, pctx({ engineModels: [byok] })),
    ).toBe("byok-not-registered")
  })
  // R3:`model.list` 可以成功返回 [] 且链照样进 ready —— 判据不得依赖「空清单 ⇒ 未就绪」
  // 这个状态机从未承诺的不变量。空清单同样算不满足成员关系;「未就绪」由 modelChainState 单独把门。
  test("#595:引擎成功返回空清单 → 同样判 byok-not-registered(不靠「空=未就绪」放行)", () => {
    expect(preflightBlockReason({ providerID: "deepseek-byok", id: "deepseek-v4-flash" }, pctx({}))).toBe(
      "byok-not-registered",
    )
  })
  test("#595:空清单不外溢 —— 平台行与非 BYOK 节点仍按各自既有判据", () => {
    expect(preflightBlockReason(proxyModel, pctx({ loggedIn: true }))).toBeNull()
    expect(preflightBlockReason({ providerID: "my-endpoint", id: "x" }, pctx({ loggedIn: true }))).toBeNull()
  })
  test("#595:约束不外溢 —— 平台行与非 BYOK 自定义节点的既有语义不变", () => {
    expect(preflightBlockReason(proxyModel, pctx({ loggedIn: true, engineModels: engineWithDs }))).toBeNull()
    expect(
      preflightBlockReason({ providerID: "my-endpoint", id: "x" }, pctx({ loggedIn: true, engineModels: engineWithDs })),
    ).toBeNull()
  })
  test("catalog 未知(platformProviderId null)→ 平台判定不误伤", () => {
    expect(preflightBlockReason(proxyModel, pctx({ platformProviderId: null, hasConfiguredByok: true }))).toBeNull()
  })
})
