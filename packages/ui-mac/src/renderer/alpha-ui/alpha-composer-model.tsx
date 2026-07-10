// ModelPickPop — REQ-055:AlphaComposer 的自建模型选择弹层(本地选择真源)。
//
// 与 model-picker-inject(接管上游原生弹窗、点隐藏原生行触发上游 model.set)的本质区别:这里
// **不依赖上游任何 DOM** —— 行来自 catalog(代理节点)+ SDK config.providers(BYOK/自定义,即
// 引擎实际注册的模型),选择写入 composer-state(localStorage 持久),提交时作 SDK model 参数。
// 账户横幅/锁定语义与 model-picker-inject 保持一字不差(同一设计稿)。

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import { composerModelSuspended, setComposerModel, type ComposerModel, type SuspendReason } from "./composer-state"
import { lockedPickAction, nextEngineRetryDelay } from "./model-picker-logic"
import type { AlphaProjectsApi } from "../sidebar/use-projects"
import { AddProvider } from "./model-picker-add"

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`

/** REQ-069:挂起原因 → 用户语言(说人话,不出现「预授权/provider」字眼)。 */
const suspendText = (r: SuspendReason) =>
  r === "needs-login" ? "需登录后使用,已暂停" : r === "needs-credit" ? "需会员或钱包余额,已暂停" : "对应节点已被移除,已暂停"

type Row = {
  model: ComposerModel
  sub: string
  pico: { letter: string; color: string }
  tier?: Tier
  mult?: string
  reasoning: boolean
  locked?: boolean
  /** catalog BYOK 供应商但未配置 KEY:如实显示,点击进配置表单(与旧 picker 同语义;
   *  此前整行隐藏 = 用户「BYOK 消失了」报障 2026-07-07 的直接根因之一)。 */
  needKey?: boolean
  /** 已配置 KEY 但引擎模型表尚未拉到(respawn 窗口)的占位行:如实存在、不可点(REQ-083;
   *  此前整体消失 = 用户「BYOK 又消失了」报障 2026-07-10 的直接根因之一)。 */
  pending?: boolean
}

export function ModelPickPop(props: { sdk: AlphaProjectsApi["sdk"]; onPicked: () => void }) {
  const [catalog, setCatalog] = createSignal<EffectiveCatalog | null>(null)
  const [auth, setAuth] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  const [summary, setSummary] = createSignal<AccountSummary | null>(null)
  const [summaryError, setSummaryError] = createSignal<string | null>(null)
  const [keyStatus, setKeyStatus] = createSignal<ProviderKeyStatus>({})
  const [engineModels, setEngineModels] = createSignal<Array<{ providerID: string; modelID: string }>>([])
  /** 引擎模型表至少成功拉到过一次。false = respawn 窗口/引导中,UI 走诚实占位而非「消失/全灰」(REQ-083)。 */
  const [engineReady, setEngineReady] = createSignal(false)
  /** 至少失败过一次且尚未恢复 —— note/占位行的显示门(健康路径首拉 ~ms 级,不闪占位)。 */
  const [engineStalled, setEngineStalled] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [addOpen, setAddOpen] = createSignal(false)
  const [configureId, setConfigureId] = createSignal<string | null>(null)
  const endpoints = useAlphaEndpoints()

  // REQ-083:拉取失败不再静默吞掉 —— 退避重试直到弹窗卸载(sidecar respawn ~秒级,弹窗内自愈)。
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    clearTimeout(retryTimer)
  })
  const scheduleEngineRetry = () => {
    if (disposed) return
    setEngineStalled(true)
    clearTimeout(retryTimer)
    retryTimer = setTimeout(loadEngineModels, nextEngineRetryDelay(retryAttempt++))
  }
  const loadEngineModels = () => {
    if (disposed) return
    const c = props.sdk()
    if (!c) {
      // renderer 刚被 respawn reload 时 SDK 客户端可能尚未就绪 —— 视作可重试,不放弃。
      scheduleEngineRetry()
      return
    }
    void c.config
      .providers({} as any)
      .then(({ data, error }: any) => {
        const provs = Array.isArray(data?.providers) ? data.providers : Array.isArray(data) ? data : null
        if (error || !provs) {
          scheduleEngineRetry()
          return
        }
        const out: Array<{ providerID: string; modelID: string }> = []
        for (const p of provs) {
          const pid = p?.id ?? p?.providerID
          const models = p?.models && typeof p.models === "object" ? Object.keys(p.models) : []
          for (const mid of models) out.push({ providerID: pid, modelID: mid })
        }
        setEngineModels(out)
        setEngineReady(true)
        setEngineStalled(false)
        retryAttempt = 0
      })
      .catch(() => scheduleEngineRetry())
  }
  const refreshKeys = () => {
    window.api.providers.keyStatus().then(setKeyStatus).catch(() => {})
    // 改键触发 sidecar respawn,引擎模型表随后变化 —— 延迟再拉一次收敛(失败进重试循环)。
    loadEngineModels()
    setTimeout(loadEngineModels, 3000)
  }

  onMount(() => {
    window.api.models.catalog().then(setCatalog).catch(() => {})
    window.api.providers.keyStatus().then(setKeyStatus).catch(() => {})
    window.api.auth.getState().then(setAuth).catch(() => {})
    window.api.account
      .summary()
      .then((r) => {
        if (r && typeof r === "object" && "error" in r) setSummaryError(String((r as { error: string }).error))
        else {
          setSummary(r as AccountSummary)
          setSummaryError(null)
        }
      })
      .catch(() => setSummaryError("network"))
    // 引擎实际注册的模型(BYOK/自定义直连;代理模型也在其中 —— 用于 locked 判定)
    loadEngineModels()
  })

  const state = createMemo<"member" | "balance" | "empty" | "out" | "error">(() => {
    if (auth().status !== "logged-in") return "out"
    const s = summary()
    if (!s) return summaryError() ? "error" : "balance"
    if (s.plan.status === "active") return "member"
    return s.balanceFen > 0 ? "balance" : "empty"
  })
  const accountLocked = createMemo(() => state() === "out" || state() === "empty")
  const proxyLive = createMemo(() => {
    const cat = catalog()
    return !!cat && engineModels().some((m) => m.providerID === cat.platformProvider.id)
  })

  const matchQ = (name: string, sub: string) => {
    const q = query().trim().toLowerCase()
    return !q || `${name} ${sub}`.toLowerCase().includes(q)
  }

  const proxyRows = createMemo<Row[]>(() => {
    const cat = catalog()
    if (!cat) return []
    return cat.platformModels
      .map((m): Row => ({
        model: { providerID: cat.platformProvider.id, modelID: m.id, name: m.name, variants: m.variants ? Object.keys(m.variants) : [] },
        sub: m.id,
        pico: cat.platformProvider.pico,
        tier: m.tier,
        mult: cat.tiers[m.tier]?.mult,
        reasoning: !!m.reasoning,
        locked: accountLocked() || !proxyLive(),
      }))
      .filter((r) => matchQ(r.model.name, r.sub))
  })

  const otherRows = createMemo<Row[]>(() => {
    const cat = catalog()
    const platformID = cat?.platformProvider.id ?? "alpha"
    return engineModels()
      .filter((m) => m.providerID !== platformID)
      .filter((m) => keyStatus()[m.providerID]?.configured ?? false)
      .map((m): Row => {
        const bp = cat?.byokProviders.find((p) => p.id === m.providerID)
        return {
          model: { providerID: m.providerID, modelID: m.modelID, name: m.modelID, variants: [] },
          sub: bp?.name ?? m.providerID,
          pico: bp?.pico ?? { letter: m.providerID.slice(0, 1).toUpperCase(), color: "#71717a" },
          reasoning: false,
        }
      })
      .filter((r) => matchQ(r.model.name, r.sub))
  })

  /* REQ-083:已配置 KEY 但引擎模型表还没拉到(respawn 窗口/引导中)→ 占位行如实存在。
   * 此前直接消失:configured 被排除出「需 KEY」区,模型行又依赖空的引擎表 —— 两头落空。 */
  const pendingByokRows = createMemo<Row[]>(() => {
    if (engineReady() || !engineStalled()) return []
    const cat = catalog()
    if (!cat) return []
    return cat.byokProviders
      .filter((p) => keyStatus()[p.id]?.configured ?? false)
      .map(
        (p): Row => ({
          model: { providerID: p.id, modelID: "", name: p.name, variants: [] },
          sub: "已配置 · 模型加载中…",
          pico: p.pico,
          reasoning: false,
          pending: true,
        }),
      )
      .filter((r) => matchQ(r.model.name, r.sub))
  })

  /* catalog BYOK 供应商、KEY 未配置 → 如实显示为「需 KEY」行(点击进配置表单)。
   * 旧 picker(model-picker-inject)一直是这个语义;新 picker 曾整行隐藏 —— 用户填过 KEY 的
   * DeepSeek 在换 userData(渠道分裂)后"凭空消失",无从发现也无从修复。 */
  const needKeyRows = createMemo<Row[]>(() => {
    const cat = catalog()
    if (!cat) return []
    return cat.byokProviders
      .filter((p) => !(keyStatus()[p.id]?.configured ?? false))
      .map(
        (p): Row => ({
          model: { providerID: p.id, modelID: "", name: p.name, variants: [] },
          sub: "未配置 KEY · 点击配置",
          pico: p.pico,
          reasoning: false,
          needKey: true,
        }),
      )
      .filter((r) => matchQ(r.model.name, r.sub))
  })

  const pick = (r: Row) => {
    if (r.pending) return // 占位行:引擎连上后自动变成真模型行,点了不该有副作用
    if (r.needKey) {
      setConfigureId(r.model.providerID)
      setAddOpen(true)
      return
    }
    if (r.locked) {
      // REQ-083:只有「引擎在线且代理节点确实缺席」才触发 enableProxy(respawn 是修复);
      // 引擎不可达时 respawn 只会扩大故障面(点灰行 → 重启 → renderer reload → 再点 的自续循环)。
      const action = lockedPickAction(state(), engineReady(), proxyLive())
      if (action === "login") void window.api.auth.start()
      else if (action === "recharge") window.api.openLink(`${endpoints().web}${ALPHA_PATHS.wallet}?tab=recharge`)
      else if (action === "activate") void window.api.auth.enableProxy()
      return
    }
    setComposerModel(r.model)
    props.onPicked()
  }

  const tierLabel = (t?: Tier) => (t ? (catalog()?.tiers[t]?.label ?? t) : "")

  return (
    <div class="a-mpp">
      <div class="a-mpp-search">
        <input type="text" placeholder="搜索模型 / 供应商" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </div>
      <Show when={state() === "member"}>
        <div class="a-acct-banner member">
          <span class="bt">
            {(() => {
              const pl = summary()?.plan
              return pl && pl.status === "active" ? pl.name : "Pro"
            })()} 会员 · 本周期额度充足
          </span>
        </div>
      </Show>
      <Show when={state() === "balance"}>
        <div class="a-acct-banner balance">
          <span class="bt">钱包余额 {fmtYuan(summary()?.balanceFen ?? 0)} · 按量扣费</span>
        </div>
      </Show>
      <Show when={state() === "empty"}>
        <div class="a-acct-banner empty">
          <span class="bt">余额不足 · 充值后解锁代理</span>
        </div>
      </Show>
      <Show when={state() === "out"}>
        <div class="a-acct-banner out">
          <span class="bt">登录解锁代理节点</span>
        </div>
      </Show>
      {/* REQ-069:上次使用的模型被挂起(登出残留/余额不足/节点移除)→ 如实说明,不静默换不静默删。 */}
      <Show when={composerModelSuspended()}>
        <div class="a-pop-note">
          上次使用的「{composerModelSuspended()!.model.name}」{suspendText(composerModelSuspended()!.reason)};恢复后自动还原,也可直接改选其他模型。
        </div>
      </Show>
      {/* REQ-083:引擎模型表未就绪(sidecar 重启窗口)→ 如实说明 + 自动重试,不静默渲染成「全灰 + BYOK 消失」。 */}
      <Show when={engineStalled() && !engineReady()}>
        <div class="a-pop-note">正在连接引擎(可能正在重启)…模型列表稍后自动恢复,无需重开此窗口。</div>
      </Show>
      <div class="a-mpp-scroll">
        {/* REQ-069:未登录不逐条外显海外 model id(用户拍板 2026-07-08)—— 平台区收敛为登录引导卡
            (品牌可提、id 不列);登录后恢复全量清单(锁定语义不变)。 */}
        <Show
          when={state() !== "out"}
          fallback={
            <>
              <div class="a-pop-label">代理节点 · 经 ALPHA 代理</div>
              <button class="a-pop-item a-mpp-row" onClick={() => void window.api.auth.start()}>
                <span class="a-pico" style={{ background: "var(--a-accent)" }}>α</span>
                <span class="a-mpp-name">
                  登录后可用 GPT / Claude 等海外模型
                  <small>零配置 · 登录即用,按量或会员计费</small>
                </span>
              </button>
            </>
          }
        >
          <Show when={proxyRows().length}>
            <div class="a-pop-label">代理节点 · 经 ALPHA 代理</div>
            <For each={proxyRows()}>
              {(r) => (
                <button class="a-pop-item a-mpp-row" classList={{ locked: !!r.locked }} onClick={() => pick(r)}>
                  <span class="a-pico" style={{ background: r.pico.color }}>{r.pico.letter}</span>
                  <span class="a-mpp-name">
                    {r.model.name}
                    <small>{r.sub}</small>
                  </span>
                  <Show when={r.reasoning}>
                    <span class="a-mpp-dot" />
                  </Show>
                  <span class="a-pop-desc">{tierLabel(r.tier)}{r.mult ? ` ${r.mult}` : ""}</span>
                </button>
              )}
            </For>
          </Show>
        </Show>
        <Show when={otherRows().length || needKeyRows().length || pendingByokRows().length}>
          <div class="a-pop-label">直连 · 自带 KEY</div>
          <For each={otherRows()}>
            {(r) => (
              <button class="a-pop-item a-mpp-row" onClick={() => pick(r)}>
                <span class="a-pico" style={{ background: r.pico.color }}>{r.pico.letter}</span>
                <span class="a-mpp-name">
                  {r.model.name}
                  <small>{r.sub}</small>
                </span>
              </button>
            )}
          </For>
          <For each={pendingByokRows()}>
            {(r) => (
              <button class="a-pop-item a-mpp-row a-mpp-pending" disabled onClick={() => pick(r)}>
                <span class="a-pico" style={{ background: r.pico.color }}>{r.pico.letter}</span>
                <span class="a-mpp-name">
                  {r.model.name}
                  <small>{r.sub}</small>
                </span>
              </button>
            )}
          </For>
          <For each={needKeyRows()}>
            {(r) => (
              <button class="a-pop-item a-mpp-row a-mpp-needkey" onClick={() => pick(r)}>
                <span class="a-pico" style={{ background: r.pico.color }}>{r.pico.letter}</span>
                <span class="a-mpp-name">
                  {r.model.name}
                  <small>{r.sub}</small>
                </span>
                <span class="a-pop-desc">需 KEY</span>
              </button>
            )}
          </For>
        </Show>
        <Show when={!proxyRows().length && !otherRows().length && !needKeyRows().length && !pendingByokRows().length}>
          <div class="a-mpp-empty">无匹配模型</div>
        </Show>
      </div>
      <button
        class="a-pop-item a-mpp-addrow"
        onClick={() => {
          setConfigureId(null)
          setAddOpen(true)
        }}
      >
        ＋ 添加自定义节点 / 供应商
      </button>
      <Show when={addOpen()}>
        <AddProvider
          catalog={catalog()}
          initialId={configureId() ?? undefined}
          keyStatus={keyStatus()}
          onClose={() => {
            setAddOpen(false)
            setConfigureId(null)
          }}
          onSaved={refreshKeys}
        />
      </Show>
    </div>
  )
}
