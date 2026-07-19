// ModelPickerInject — FULL TAKEOVER of opencode's model picker (ADR-016: alpha owns the UI). When the
// native dialog-select-model popover opens, we HIDE its native content (search + sliders/+ icons +
// the per-provider list) — kept in the DOM so its rows stay programmatically clickable — and render
// our own picker (search · account banner · 代理节点 / 国内直连 / 自定义 分组 · footer) matching the
// 2026-06-27 design. Selecting a row clicks the hidden native [data-key] row so opencode's real
// model.set fires (it lives in a route-scoped context we can't reach from this overlay). Proxy models
// come from the config-driven catalog so the 代理 group shows even before the gateway is connected
// (locked → login). MutationObserver keeps it mounted across the popover's re-renders.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { ByokProvider, EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import { AddProvider } from "./model-picker-add"

const [catalog, setCatalog] = createSignal<EffectiveCatalog | null>(null)
const [addOpen, setAddOpen] = createSignal(false)

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`
const EFFORT_RE = /reasoner|thinking|-r1|opus|sonnet|gpt-5|gemini|o1|o3|grok-4|glm-4\.6|qwq/i
function heuristicTier(id: string): Tier {
  const s = id.toLowerCase()
  if (/opus|gpt-5\.5|gpt-5-pro|grok-4/.test(s)) return "flag"
  if (/sonnet|gemini|gpt-5|grok|reasoner|thinking|-r1|glm-4\.6/.test(s)) return "pro"
  return "std"
}

type Row = {
  key: string // native data-key "prov:id" (selection target)
  name: string
  sub: string
  pico: { letter: string; color: string }
  tier: Tier
  mult?: string
  reasoning: boolean
  locked?: boolean
  /** locked specifically because the BYOK provider has no key → click opens its configure form. */
  needKey?: boolean
}

export function ModelPickerInject() {
  const [auth, setAuth] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  const [summary, setSummary] = createSignal<AccountSummary | null>(null)
  const [panelHost, setPanelHost] = createSignal<HTMLElement | null>(null)
  const [nativeKeys, setNativeKeys] = createSignal<string[]>([])
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [keyStatus, setKeyStatus] = createSignal<ProviderKeyStatus>({})
  const [configureId, setConfigureId] = createSignal<string | null>(null)
  const refreshKeyStatus = () => window.api.providers.keyStatus().then(setKeyStatus).catch(() => {})
  const endpoints = useAlphaEndpoints()

  onMount(() => onCleanup(window.api.auth.subscribe(setAuth)))
  // B11(#1 误显根治):保留 IPC 的 {error} 判别式 —— 此前任何读取失败都被吞成 summary=null,
  // 与「真·已登录未订阅」渲染完全一致(误显「钱包按量扣费」)。失败态单独呈现 + 可重试。
  const [summaryError, setSummaryError] = createSignal<string | null>(null)
  const fetchSummary = () => {
    window.api.account
      .summary()
      .then((r) => {
        if (r && typeof r === "object" && "error" in r) {
          setSummary(null)
          setSummaryError(String((r as { error: string }).error))
        } else {
          setSummary(r as AccountSummary)
          setSummaryError(null)
        }
      })
      .catch(() => setSummaryError("network"))
  }
  createEffect(() => {
    if (auth().status !== "logged-in") {
      setSummary(null)
      setSummaryError(null)
      return
    }
    fetchSummary()
  })

  const state = createMemo<"member" | "balance" | "empty" | "out" | "error">(() => {
    if (auth().status !== "logged-in") return "out"
    const s = summary()
    if (!s) return summaryError() ? "error" : "balance"
    if (s.plan.status === "active") return "member"
    return s.balanceFen > 0 ? "balance" : "empty"
  })
  const accountLocked = createMemo(() => state() === "out" || state() === "empty")
  // Whether opencode actually registered the ALPHA proxy provider this session (= the proxy env was
  // present at sidecar fork time). When false, every 代理 row is locked regardless of account standing:
  // the user can be logged in + funded but the proxy simply isn't live yet and needs one relaunch to
  // pick up ALPHA_BASE_URL/ALPHA_API_KEY (see window.api.auth.enableProxy). This is the real reason a
  // healthy PRO account still saw greyed rows — NOT balance/login.
  const proxyConnected = createMemo(() => {
    const cat = catalog()
    return !!cat && nativeKeys().some((k) => k.startsWith(`${cat.platformProvider.id}:`))
  })

  // ── detect the model picker popover + collect native rows ───────────────────────────────────────
  let mo: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    const list = document.querySelector("[data-component='list']")
    const scroll = list?.querySelector("[data-slot='list-scroll']")
    const dialog = (list?.closest("[role='dialog']") as HTMLElement | null) ?? null
    const items = list ? [...list.querySelectorAll("[data-slot='list-item'][data-key]")] : []
    const keys = items.map((i) => i.getAttribute("data-key") || "")
    const hasColon = keys.some((k) => k.includes(":"))
    const bareOnly = items.length > 0 && !hasColon // provider-SELECT dialog → leave native alone
    const isModelPicker = !!dialog && !!scroll && !bareOnly
    if (!isModelPicker || !dialog) {
      if (panelHost()) setPanelHost(null)
      if (addOpen()) setAddOpen(false)
      return
    }
    const colon = keys.filter((k) => k.includes(":"))
    if (JSON.stringify(colon) !== JSON.stringify(nativeKeys())) setNativeKeys(colon)
    const sel = items.find((i) => i.getAttribute("data-selected") === "true" || i.getAttribute("aria-selected") === "true")
    const selK = sel?.getAttribute("data-key") ?? null
    if (selK !== selectedKey()) setSelectedKey(selK)
    if (panelHost() !== dialog) setPanelHost(dialog)
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      scan()
    }, 0)
  }
  onMount(() => {
    const start = () => {
      scan()
      for (const d of [80, 250, 600]) setTimeout(scan, d)
      mo = new MutationObserver(schedule)
      mo.observe(document.body, { childList: true, subtree: true })
    }
    window.api.models.catalog().then(setCatalog).catch(() => {}).finally(start)
    void refreshKeyStatus()
  })
  // Re-read BYOK key state whenever the picker (re)opens, so a key set elsewhere reflects without reload.
  // REQ-001:同时刷新 B 网关 edition 白名单(platformLive 顺带写缓存 → 重取 effective catalog),
  // 网关侧改配置后「刷新即生效」不需发版;失败静默保留当前目录(缓存/内置 snapshot,picker 不空白)。
  createEffect(() => {
    if (!panelHost()) return
    void refreshKeyStatus()
    window.api.models
      .platformLive()
      .then(() => window.api.models.catalog().then(setCatalog))
      .catch(() => {})
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })

  // ── home picker anchor (CSS-var driven; see model-picker-reskin.css [data-alpha-home-anchor]) ────
  // On HOME the popover anchors to opencode's HIDDEN native button (which sits above the visible chip),
  // so it floats detached above the composer (user-reported 2026-06-30). We tag the positioner and feed
  // `--a-pick-tf` a translate that pins its BOTTOM 8px above the VISIBLE alpha chip; the stylesheet
  // !important transform holds it there so floating-ui's inline transform can't drift it back. In-session
  // there's no `.a-chip-model` → we never tag it, leaving opencode's own (correct) anchoring alone.
  const anchorToChip = () => {
    const dlg = panelHost()
    if (!dlg) return
    const pos = (dlg.closest("[data-popper-positioner]") as HTMLElement | null) ?? dlg.parentElement
    if (!pos) return
    const chip = [...document.querySelectorAll<HTMLElement>(".a-chip-model")].find(
      (c) => c.offsetParent !== null && c.getBoundingClientRect().width > 0,
    )
    if (!chip) {
      pos.removeAttribute("data-alpha-home-anchor")
      return // in-session → opencode's native anchor is correct
    }
    const r = chip.getBoundingClientRect()
    pos.style.setProperty("--a-pick-tf", `translate(${Math.round(r.left)}px, ${Math.round(r.top - 8 - window.innerHeight)}px)`)
    pos.setAttribute("data-alpha-home-anchor", "")
  }
  createEffect(() => {
    if (!panelHost()) return
    anchorToChip()
    for (const d of [0, 30, 90, 200]) setTimeout(anchorToChip, d)
    window.addEventListener("resize", anchorToChip)
    onCleanup(() => window.removeEventListener("resize", anchorToChip))
  })

  // ── initial focus (#250 r1 Major) ────────────────────────────────────────────────────────────────
  // On open, upstream autofocuses ITS native search input (ui/dialog.tsx autofocus) — which our reskin
  // hides, so typing right after mod+' went into an invisible field. Whenever the picker (re)opens,
  // move focus to OUR search box, on the same retry schedule as anchorToChip so a late-arriving
  // upstream autofocus can't win the endgame. Never steals focus that is already inside the alpha
  // picker (user clicked a row / the add-provider form).
  let searchEl: HTMLInputElement | undefined
  const claimFocus = () => {
    if (!searchEl || !searchEl.isConnected) return
    const active = document.activeElement
    if (active && document.querySelector("[data-alpha-picker]")?.contains(active)) return
    searchEl.focus()
  }
  createEffect(() => {
    if (!panelHost()) return
    for (const d of [0, 30, 90, 200]) setTimeout(claimFocus, d)
  })

  // ── build rows from catalog + native keys ───────────────────────────────────────────────────────
  const picoFor = (prov: string): { letter: string; color: string } => {
    const cat = catalog()
    if (!cat) return { letter: prov.slice(0, 1).toUpperCase(), color: "#71717a" }
    if (prov === cat.platformProvider.id) return cat.platformProvider.pico
    const bp = cat.byokProviders.find((p) => p.id === prov)
    return bp?.pico ?? { letter: prov.slice(0, 1).toUpperCase(), color: "#71717a" }
  }
  const provName = (prov: string): string => {
    const bp = catalog()?.byokProviders.find((p) => p.id === prov)
    return bp?.name ?? prov
  }
  const matchQ = (r: Row) => {
    const q = query().trim().toLowerCase()
    return !q || `${r.name} ${r.sub} ${r.key}`.toLowerCase().includes(q)
  }

  const proxyRows = createMemo<Row[]>(() => {
    const cat = catalog()
    if (!cat) return []
    return cat.platformModels
      .map((m): Row => {
        const key = `${cat.platformProvider.id}:${m.id}`
        const hasNative = nativeKeys().includes(key)
        return {
          key,
          name: m.name,
          sub: m.id,
          pico: cat.platformProvider.pico,
          tier: m.tier,
          mult: cat.tiers[m.tier]?.mult,
          reasoning: !!m.reasoning,
          locked: accountLocked() || !hasNative,
        }
      })
      .filter(matchQ)
  })
  const byokRows = createMemo<Row[]>(() => byokOrCustom(true))
  const customRows = createMemo<Row[]>(() => byokOrCustom(false))
  function byokOrCustom(wantBuiltin: boolean): Row[] {
    const cat = catalog()
    return nativeKeys()
      .filter((k) => !k.startsWith(`${cat?.platformProvider.id ?? "alpha"}:`))
      .map((key): Row => {
        const prov = key.slice(0, key.indexOf(":"))
        const id = key.slice(key.indexOf(":") + 1)
        return {
          key,
          name: id,
          sub: provName(prov) + (EFFORT_RE.test(id) ? " · 推理" : ""),
          pico: picoFor(prov),
          tier: heuristicTier(id),
          reasoning: EFFORT_RE.test(id),
        }
      })
      .filter((r) => {
        const prov = r.key.slice(0, r.key.indexOf(":"))
        const known = !!cat?.byokProviders.some((p) => p.id === prov)
        if (wantBuiltin ? !known : known) return false
        // Hide providers with no key entirely (an unconfigured provider's whole row shouldn't show).
        // Add a key via the footer "添加自定义节点 / 供应商" flow (lists every provider + 已配置 state).
        return keyStatus()[prov]?.configured ?? false
      })
      .filter(matchQ)
  }

  const tierLabel = (t: Tier) => catalog()?.tiers[t]?.label ?? t

  function pick(r: Row) {
    if (r.locked) {
      const prov = r.key.slice(0, r.key.indexOf(":"))
      const cat = catalog()
      if (cat && prov !== cat.platformProvider.id) {
        // BYOK / custom row with no key → open the configure form for THIS provider (was: a dead
        // select that 401s at call time). AddProvider opens pre-selected via initialId.
        setConfigureId(prov)
        setAddOpen(true)
        return
      }
      // 代理 row: three distinct reasons → three distinct fixes (not the old recharge/re-login dead-end).
      if (state() === "out")
        void window.api.auth.start() // not logged in → login (login now opts into the proxy by default)
      else if (state() === "empty")
        window.api.openLink(`${endpoints().web}${ALPHA_PATHS.wallet}?tab=recharge`) // no funds → recharge
      else void window.api.auth.enableProxy() // logged in + funded, proxy not live → respawn in place (no restart)
      return
    }
    const el = document.querySelector(`[data-slot="list-item"][data-key="${r.key}"]`) as HTMLElement | null
    el?.click()
  }

  const RowItem = (props: { r: Row }) => (
    <button
      class="a-mp2-row"
      classList={{ locked: !!props.r.locked, sel: props.r.key === selectedKey() }}
      onClick={() => pick(props.r)}
    >
      <span class="a-mp-pico" style={{ background: props.r.pico.color }}>
        {props.r.pico.letter}
      </span>
      <span class="a-mp-namecol">
        <span class="a-mp-nm">{props.r.name}</span>
        <span class="a-mp-sub">{props.r.sub}</span>
      </span>
      <Show when={props.r.reasoning}>
        <span class="a-mp-dot" />
      </Show>
      <Show when={props.r.needKey} fallback={<span class={`a-mp-tier ${props.r.tier}`}>{tierLabel(props.r.tier)}</span>}>
        <span class="a-mp-needkey">需 Key</span>
      </Show>
      <Show when={props.r.mult}>
        <span class="a-mp-mult">{props.r.mult}</span>
      </Show>
    </button>
  )

  const empty = createMemo(() => !proxyRows().length && !byokRows().length && !customRows().length)

  return (
    <Show when={panelHost()}>
      {(h) => (
        <Portal mount={h()}>
          <div class="a-mp2" data-alpha-picker>
            <div class="a-mp2-search">
              <Search />
              <input
                ref={searchEl}
                type="text"
                placeholder="搜索模型 / 供应商"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
            <AccountBanner state={state()} summary={summary()} onRetry={fetchSummary} />
            <div class="a-mp2-scroll">
              <Show when={proxyRows().length}>
                <div class="a-mp2-ghead">
                  <span class="gt">代理节点 · 经 ALPHA 代理</span>
                  <span class="a-mp-grouptag">推荐</span>
                  <Show when={accountLocked()}>
                    <span class="a-mp2-lock">
                      <Lock /> 已锁定
                    </span>
                  </Show>
                  <Show when={!accountLocked() && !proxyConnected()}>
                    <button class="a-mp2-activate" onClick={() => void window.api.auth.enableProxy()}>
                      启用代理
                    </button>
                  </Show>
                  <Show when={catalog()?.liveSync?.status === "static"}>
                    <span class="a-mp2-lock" title="网关模型白名单未同步(离线/不可达),当前显示内置目录;联网后打开本面板即自动同步">
                      内置目录
                    </span>
                  </Show>
                </div>
                <For each={proxyRows()}>{(r) => <RowItem r={r} />}</For>
              </Show>
              <Show when={byokRows().length}>
                <div class="a-mp2-ghead">
                  <span class="gt">国内直连 · 自带 KEY (BYOK)</span>
                </div>
                <For each={byokRows()}>{(r) => <RowItem r={r} />}</For>
              </Show>
              <Show when={customRows().length}>
                <div class="a-mp2-ghead">
                  <span class="gt">自定义</span>
                </div>
                <For each={customRows()}>{(r) => <RowItem r={r} />}</For>
              </Show>
              <Show when={empty()}>
                <div class="a-mp2-empty">
                  无匹配模型
                  <br />
                  <a
                    onClick={() => {
                      setConfigureId(null)
                      setAddOpen(true)
                    }}
                  >
                    ＋ 添加自定义端点
                  </a>
                </div>
              </Show>
            </div>
            <div class="a-mp2-foot">
              <button
                class="a-mp2-addbtn"
                onClick={() => {
                  setConfigureId(null)
                  setAddOpen(true)
                }}
              >
                <span class="a-mp2-plus">
                  <Plus />
                </span>
                添加自定义节点 / 供应商
              </button>
            </div>
            <Show when={addOpen()}>
              <AddProvider
                catalog={catalog()}
                initialId={configureId() ?? undefined}
                keyStatus={keyStatus()}
                onClose={() => {
                  setAddOpen(false)
                  setConfigureId(null)
                }}
                onSaved={() => void refreshKeyStatus()}
              />
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  )
}

function AccountBanner(props: {
  state: "member" | "balance" | "empty" | "out" | "error"
  summary: AccountSummary | null
  onRetry?: () => void
}) {
  const endpoints = useAlphaEndpoints()
  const rechargeUrl = () => `${endpoints().web}${ALPHA_PATHS.wallet}?tab=recharge`
  const subscribeUrl = () => `${endpoints().web}${ALPHA_PATHS.wallet}?tab=subscription`
  const planName = () => (props.summary?.plan.status === "active" ? props.summary.plan.name : "Pro")
  return (
    <>
      <Show when={props.state === "member"}>
        <div class="a-acct-banner member">
          <span class="bi"><Check /></span>
          <span class="bt">
            {planName()} 会员 · 本周期额度充足
            <small>5h / 7d 额度充裕</small>
          </span>
        </div>
      </Show>
      <Show when={props.state === "balance"}>
        <div class="a-acct-banner balance">
          <span class="bi"><Card /></span>
          <span class="bt">
            钱包余额 {fmtYuan(props.summary?.balanceFen ?? 0)} · 未订阅
            <small>按量扣费</small>
          </span>
          <button class="a-acct-bb ghost" onClick={() => window.api.openLink(subscribeUrl())}>订阅</button>
        </div>
      </Show>
      <Show when={props.state === "empty"}>
        <div class="a-acct-banner empty">
          <span class="bi"><Card /></span>
          <span class="bt">
            余额不足 · 充值后解锁代理
            <small>钱包 ¥0.00</small>
          </span>
          <button class="a-acct-bb ghost" onClick={() => window.api.openLink(subscribeUrl())}>订阅</button>
          <button class="a-acct-bb" onClick={() => window.api.openLink(rechargeUrl())}>充值</button>
        </div>
      </Show>
      <Show when={props.state === "out"}>
        <div class="a-acct-banner out">
          <span class="bi"><Lock /></span>
          <span class="bt">
            登录解锁代理节点
            <small>平台计费 · 旗舰模型直达</small>
          </span>
          <button class="a-acct-bb" onClick={() => void window.api.auth.start()}>登录</button>
        </div>
      </Show>
      <Show when={props.state === "error"}>
        <div class="a-acct-banner error">
          <span class="bi"><Lock /></span>
          <span class="bt">
            账户信息读取失败
            <small>网络异常或服务不可达,余额/会员状态未知</small>
          </span>
          <button class="a-acct-bb" onClick={() => props.onRetry?.()}>重试</button>
        </div>
      </Show>
    </>
  )
}

/* ── icons ───────────────────────────────────────────────────────────────────── */
const ico = "0 0 24 24"
const Search = () => (
  <svg class="a-ic" viewBox={ico} width="16" height="16">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)
const Check = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)
const Card = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <rect x="2" y="6" width="20" height="13" rx="2" />
    <path d="M2 10h20" />
  </svg>
)
const Plus = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const Lock = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)
