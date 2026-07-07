// ModelPickPop — REQ-055:AlphaComposer 的自建模型选择弹层(本地选择真源)。
//
// 与 model-picker-inject(接管上游原生弹窗、点隐藏原生行触发上游 model.set)的本质区别:这里
// **不依赖上游任何 DOM** —— 行来自 catalog(代理节点)+ SDK config.providers(BYOK/自定义,即
// 引擎实际注册的模型),选择写入 composer-state(localStorage 持久),提交时作 SDK model 参数。
// 账户横幅/锁定语义与 model-picker-inject 保持一字不差(同一设计稿)。

import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import { setComposerModel, type ComposerModel } from "./composer-state"
import type { AlphaProjectsApi } from "../sidebar/use-projects"

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`

type Row = {
  model: ComposerModel
  sub: string
  pico: { letter: string; color: string }
  tier?: Tier
  mult?: string
  reasoning: boolean
  locked?: boolean
}

export function ModelPickPop(props: { sdk: AlphaProjectsApi["sdk"]; onPicked: () => void }) {
  const [catalog, setCatalog] = createSignal<EffectiveCatalog | null>(null)
  const [auth, setAuth] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  const [summary, setSummary] = createSignal<AccountSummary | null>(null)
  const [summaryError, setSummaryError] = createSignal<string | null>(null)
  const [keyStatus, setKeyStatus] = createSignal<ProviderKeyStatus>({})
  const [engineModels, setEngineModels] = createSignal<Array<{ providerID: string; modelID: string }>>([])
  const [query, setQuery] = createSignal("")
  const endpoints = useAlphaEndpoints()

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
    const c = props.sdk()
    if (c)
      void c.config
        .providers({} as any)
        .then(({ data }: any) => {
          const out: Array<{ providerID: string; modelID: string }> = []
          const provs = Array.isArray(data?.providers) ? data.providers : Array.isArray(data) ? data : []
          for (const p of provs) {
            const pid = p?.id ?? p?.providerID
            const models = p?.models && typeof p.models === "object" ? Object.keys(p.models) : []
            for (const mid of models) out.push({ providerID: pid, modelID: mid })
          }
          setEngineModels(out)
        })
        .catch(() => {})
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

  const pick = (r: Row) => {
    if (r.locked) {
      if (state() === "out") void window.api.auth.start()
      else if (state() === "empty") window.api.openLink(`${endpoints().web}${ALPHA_PATHS.wallet}?tab=recharge`)
      else void window.api.auth.enableProxy()
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
      <div class="a-mpp-scroll">
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
        <Show when={otherRows().length}>
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
        </Show>
        <Show when={!proxyRows().length && !otherRows().length}>
          <div class="a-mpp-empty">无匹配模型</div>
        </Show>
      </div>
    </div>
  )
}
