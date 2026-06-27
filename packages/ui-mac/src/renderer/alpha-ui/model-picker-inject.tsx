// ModelPickerInject — decorates opencode's model picker to the approved three-tier mockup, WITHOUT
// editing dialog-select-model (ADR-016: reuse the heavy engine, restyle). Three additive layers, all
// hung off stable hooks (verified live via CDP):
//   1. TIER badges (旗舰/高级/标准) + cost multiplier per row — appended to each
//      `[data-slot="list-item"][data-key="<provider>:<modelId>"]`.
//   2. ACCOUNT banner (会员 / 余额 / 余额不足 / 未登录) pinned above the list, from window.api auth +
//      account summary (same contract the sidebar uses).
//   3. SOFT-LOCK — when logged-out or out of balance, the alpha proxy rows (data-key `alpha:*`) dim
//      and stop accepting clicks (they need login/credit), with a hint line.
// A debounced MutationObserver re-applies after the list re-renders (search filter recreates rows).

import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { AlphaModelCatalog, Tier } from "../../shared/alpha-model-types"
import { ALPHA_ENDPOINTS, ALPHA_PATHS } from "../../shared/alpha-config"
import { AddProvider } from "./model-picker-add"

// Module-level so the footer button (deep in the decorated DOM) and the add-flow overlay share state,
// and so the catalog (loaded once on mount) is reachable by both the decoration helpers and the flow.
const [catalogStore, setCatalogStore] = createSignal<AlphaModelCatalog | null>(null)
const [addOpen, setAddOpen] = createSignal(false)

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string)
}

// Catalog-driven metadata (config source: main/alpha-models.json via window.api.models.catalog).
// Loaded once on mount BEFORE the first decoration so rows never render with stale heuristics.
// Defaults keep the picker working if the IPC fails.
let TIERS: AlphaModelCatalog["tiers"] = {
  flag: { label: "旗舰", mult: "×8" },
  pro: { label: "高级", mult: "×3" },
  std: { label: "标准", mult: "×1" },
}
let PLATFORM_TIER = new Map<string, Tier>() // modelId → tier class (proxy models only)
let PLATFORM_REASONING = new Set<string>() // modelId with reasoning (proxy models)
let PROV_PICO = new Map<string, { letter: string; color: string }>()
const PLATFORM_ID = "alpha"

function applyCatalog(cat: AlphaModelCatalog) {
  TIERS = cat.tiers
  PLATFORM_TIER = new Map(cat.platformModels.map((m) => [m.id, m.tier]))
  PLATFORM_REASONING = new Set(cat.platformModels.filter((m) => m.reasoning).map((m) => m.id))
  PROV_PICO = new Map<string, { letter: string; color: string }>()
  PROV_PICO.set(cat.platformProvider.id, cat.platformProvider.pico)
  for (const p of cat.byokProviders) PROV_PICO.set(p.id, p.pico)
  setCatalogStore(cat)
}

// Tier class falls back to a substring heuristic for non-catalog (BYOK/custom) models so new ids
// still slot in. Flagship = frontier; premium = strong mid-tier; else standard.
function heuristicTier(modelId: string): Tier {
  const id = modelId.toLowerCase()
  if (/opus|gpt-5\.5|gpt-5-pro|grok-4/.test(id)) return "flag"
  if (/sonnet|gemini|gpt-5|grok|reasoner|thinking|-r1|glm-4\.6/.test(id)) return "pro"
  return "std"
}
function tierFor(modelId: string): { cls: Tier; label: string; mult: string } {
  const cls = PLATFORM_TIER.get(modelId) ?? heuristicTier(modelId)
  const meta = TIERS[cls] ?? { label: cls, mult: "" }
  return { cls, label: meta.label, mult: meta.mult }
}
// Reasoning dot: catalog flag for proxy models, else a heuristic on the id (no variants in the DOM).
const EFFORT_RE = /reasoner|thinking|-r1|opus|sonnet|gpt-5|gemini|o1|o3|grok-4|glm-4\.6|qwq/i
function isReasoning(modelId: string): boolean {
  return PLATFORM_REASONING.has(modelId) || EFFORT_RE.test(modelId)
}

function decorate(row: HTMLElement) {
  if (row.hasAttribute("data-alpha-tier")) return
  const key = row.getAttribute("data-key") || ""
  // Model rows are keyed `<provider>:<modelId>`. The provider-SELECT dialog reuses the same list with
  // bare provider keys (no colon) — skip those so providers don't get a spurious tier badge.
  if (!key.includes(":")) return
  const provider = key.slice(0, key.indexOf(":"))
  const modelId = key.slice(key.indexOf(":") + 1)
  if (!modelId) return
  row.setAttribute("data-alpha-tier", "")
  const t = tierFor(modelId)
  const isAlpha = provider === PLATFORM_ID
  const inner = (row.querySelector(":scope > div") as HTMLElement | null) ?? row

  // leading provider/α pico (catalog-driven; fallback to provider initial)
  const picoMeta = PROV_PICO.get(provider)
  const pico = document.createElement("span")
  pico.className = "a-mp-pico"
  pico.style.background = picoMeta?.color || "#71717a"
  pico.textContent = picoMeta?.letter || provider.slice(0, 1).toUpperCase()

  // name → two lines (name + model-id subtitle). The group header now conveys "经 ALPHA 代理", so the
  // row subtitle is just the model id (no repeated "经代理"), per the 2026-06-27 redesign.
  const nameSpan = inner.querySelector("span") as HTMLElement | null
  const col = document.createElement("div")
  col.className = "a-mp-namecol"
  const sub = document.createElement("div")
  sub.className = "a-mp-sub"
  sub.textContent = modelId
  if (nameSpan) {
    nameSpan.replaceWith(col)
    col.append(nameSpan, sub)
  }
  inner.insertBefore(pico, inner.firstChild)

  // right side: reasoning dot · tier badge · cost multiplier (倍率 only on proxy rows — BYOK is 自付).
  if (isReasoning(modelId)) {
    const dot = document.createElement("span")
    dot.className = "a-mp-dot"
    inner.append(dot)
  }
  const badge = document.createElement("span")
  badge.className = `a-mp-tier ${t.cls}`
  badge.textContent = t.label
  inner.append(badge)
  if (isAlpha && t.mult) {
    const mult = document.createElement("span")
    mult.className = "a-mp-mult"
    mult.textContent = t.mult
    inner.append(mult)
  }
}

// Relabel the alpha provider's group header → 代理节点 · 经 ALPHA 代理 推荐. The header text is the
// provider display name ("ALPHA"); idempotent via a marker.
function relabelGroups() {
  for (const h of document.querySelectorAll<HTMLElement>("[data-slot='list-header']")) {
    if (h.hasAttribute("data-alpha-grp")) continue
    const txt = (h.textContent || "").trim()
    if (txt === "ALPHA" || /alpha-?platform/i.test(txt)) {
      h.setAttribute("data-alpha-grp", "")
      h.textContent = "代理节点 · 经 ALPHA 代理"
      const tag = document.createElement("span")
      tag.className = "a-mp-grouptag"
      tag.textContent = "推荐"
      h.append(tag)
    }
  }
}

// Footer: "+ 添加自定义节点 / 供应商" → opens the custom-node setup (mockup #20/§06). Appended once to
// the list, below the scroll. Wired to the Extension Hub for now (the §06 add-node dialog is V1+).
function ensureFooter(ok: boolean) {
  const list = document.querySelector("[data-component='list']")
  if (!list || !ok) return
  if (list.querySelector(":scope > [data-alpha-mp-foot]")) return
  const foot = document.createElement("button")
  foot.setAttribute("data-alpha-mp-foot", "")
  foot.className = "a-mp-foot"
  foot.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>添加自定义节点 / 供应商</span>`
  foot.addEventListener("click", () => {
    setAddOpen(true)
  })
  list.append(foot)
}

// Logged-out locked preview: when the user isn't logged in, the alpha gateway provider isn't injected
// so the native list has no `alpha:*` rows. Inject a read-only preview of the proxy models (from the
// config-driven catalog) so the user SEES what login unlocks (诉求①). Rows route to login; idempotent.
function ensureLockedPreview(state: string) {
  const scroll = document.querySelector("[data-component='list'] [data-slot='list-scroll']") as HTMLElement | null
  const cat = catalogStore()
  const hasRealAlpha = !!document.querySelector("[data-slot='list-item'][data-key^='alpha:']")
  const existing = scroll?.querySelector(":scope > [data-alpha-locked-preview]") as HTMLElement | null
  if (!scroll || !cat || state !== "out" || hasRealAlpha) {
    existing?.remove()
    return
  }
  if (existing) return
  const block = document.createElement("div")
  block.setAttribute("data-alpha-locked-preview", "")
  const head = document.createElement("div")
  head.className = "a-mp-prevhead"
  head.innerHTML = `<span class="gt">代理节点 · 经 ALPHA 代理</span><span class="a-mp-grouptag">推荐</span><span class="a-mp-prevlock">已锁定</span>`
  block.append(head)
  const cta = document.createElement("button")
  cta.className = "a-mp-prevcta"
  cta.textContent = `登录后解锁 ${cat.platformModels.length}+ 代理模型 →`
  cta.addEventListener("click", () => void window.api.auth.start())
  block.append(cta)
  for (const m of cat.platformModels) {
    const tierMeta = cat.tiers[m.tier] ?? { label: m.tier, mult: "" }
    const row = document.createElement("button")
    row.className = "a-mp-prevrow"
    row.addEventListener("click", () => void window.api.auth.start())
    const dot = m.reasoning ? `<span class="a-mp-dot"></span>` : ""
    row.innerHTML =
      `<span class="a-mp-pico" style="background:${cat.platformProvider.pico.color}">${cat.platformProvider.pico.letter}</span>` +
      `<div class="a-mp-namecol"><span>${escapeHtml(m.name)}</span><div class="a-mp-sub">${escapeHtml(m.id)}</div></div>` +
      `${dot}<span class="a-mp-tier ${m.tier}">${escapeHtml(tierMeta.label)}</span><span class="a-mp-mult">${escapeHtml(tierMeta.mult)}</span>`
    block.append(row)
  }
  scroll.insertBefore(block, scroll.firstChild)
}

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`

function AccountBanner(props: { state: "member" | "balance" | "empty" | "out"; summary: AccountSummary | null }) {
  const rechargeUrl = `${ALPHA_ENDPOINTS.web}${ALPHA_PATHS.wallet}?tab=recharge`
  const subscribeUrl = `${ALPHA_ENDPOINTS.web}${ALPHA_PATHS.wallet}?tab=subscription`
  const planName = () => (props.summary?.plan.status === "active" ? props.summary.plan.name : "Pro")
  return (
    <>
      <Show when={props.state === "member"}>
        <div class="a-acct-banner member">
          <Check /> {planName()} 会员 · 本周期额度充足
        </div>
      </Show>
      <Show when={props.state === "balance"}>
        <div class="a-acct-banner balance">
          <Card /> 钱包余额 {fmtYuan(props.summary?.balanceFen ?? 0)} · 未订阅,按量扣费
        </div>
      </Show>
      <Show when={props.state === "empty"}>
        <div class="a-acct-banner empty lockbar">
          <Card /> 余额不足 · 充值后解锁
          <span class="a-acct-bbs">
            <button class="a-acct-bb" onClick={() => window.api.openLink(rechargeUrl)}>
              <Plus /> 充值
            </button>
            <button class="a-acct-bb ghost" onClick={() => window.api.openLink(subscribeUrl)}>订阅</button>
          </span>
        </div>
      </Show>
      <Show when={props.state === "out"}>
        <div class="a-acct-banner out lockbar">
          <Lock /> 登录解锁代理节点 · 平台计费
          <button class="a-acct-bb" onClick={() => void window.api.auth.start()}>
            <Login /> 登录
          </button>
        </div>
      </Show>
    </>
  )
}

export function ModelPickerInject() {
  const [auth, setAuth] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  const [summary, setSummary] = createSignal<AccountSummary | null>(null)
  const [bannerHost, setBannerHost] = createSignal<HTMLElement | null>(null)
  const [panelHost, setPanelHost] = createSignal<HTMLElement | null>(null)

  onMount(() => {
    const unsub = window.api.auth.subscribe(setAuth)
    onCleanup(unsub)
  })
  createEffect(() => {
    if (auth().status !== "logged-in") {
      setSummary(null)
      return
    }
    window.api.account
      .summary()
      .then((r) => {
        if (r && !("error" in r)) setSummary(r as AccountSummary)
      })
      .catch(() => {})
  })

  const state = createMemo<"member" | "balance" | "empty" | "out">(() => {
    if (auth().status !== "logged-in") return "out"
    const s = summary()
    if (!s) return "balance" // optimistic until the summary lands — don't flash a lock
    if (s.plan.status === "active") return "member"
    return s.balanceFen > 0 ? "balance" : "empty"
  })
  const locked = createMemo(() => state() === "out" || state() === "empty")

  let mo: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    for (const row of document.querySelectorAll<HTMLElement>("[data-slot='list-item'][data-key]")) {
      decorate(row)
      if ((row.getAttribute("data-key") || "").startsWith("alpha:")) {
        row.toggleAttribute("data-alpha-locked", locked())
      }
    }
    relabelGroups()
    // Distinguish the model picker from the provider-SELECT dialog (both reuse [data-component=list]):
    // model rows are keyed `<prov>:<model>` (colon); provider rows are bare. A list with items but NO
    // colon keys is the provider dialog → skip. An empty list is treated as the model picker (the
    // common empty case is logged-out / no-key), so the banner + locked preview still show.
    const list = document.querySelector("[data-component='list']")
    const scroll = (list?.querySelector("[data-slot='list-scroll']") as HTMLElement | null) ?? null
    const items = list?.querySelectorAll("[data-slot='list-item'][data-key]")
    const hasColonKeys = !!list?.querySelector("[data-slot='list-item'][data-key*=':']")
    const isProviderDialog = !!items && items.length > 0 && !hasColonKeys
    const isModelPicker = !!list && !!scroll && !isProviderDialog
    ensureFooter(isModelPicker)
    if (isModelPicker && list && scroll) {
      ensureLockedPreview(state())
      let h = list.querySelector(":scope > [data-alpha-acct-banner]") as HTMLElement | null
      if (!h) {
        h = document.createElement("div")
        h.setAttribute("data-alpha-acct-banner", "")
        list.insertBefore(h, scroll)
      }
      if (bannerHost() !== h) setBannerHost(h)
      const panel = document.querySelector("[data-popper-positioner]:has([data-slot='list-scroll']) > *") as HTMLElement | null
      if (panelHost() !== panel) setPanelHost(panel)
    } else {
      if (bannerHost()) setBannerHost(null)
      if (panelHost()) setPanelHost(null)
      if (addOpen()) setAddOpen(false)
    }
  }
  // setTimeout (not rAF — throttled when headless/backgrounded).
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      scan()
    }, 0)
  }
  // re-run when lock state flips so already-decorated rows update their lock attribute.
  createEffect(() => {
    locked()
    schedule()
  })
  onMount(() => {
    // Load the config-driven catalog BEFORE the first decoration so tier/倍率/pico come from
    // alpha-models.json (not the heuristic). Picker opens long after mount, so this always wins.
    const start = () => {
      scan()
      for (const d of [80, 250, 600]) setTimeout(scan, d)
      mo = new MutationObserver(schedule)
      mo.observe(document.body, { childList: true, subtree: true })
    }
    window.api.models.catalog().then(applyCatalog).catch(() => {}).finally(start)
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })

  return (
    <>
      <Show when={bannerHost()}>
        {(h) => (
          <Portal mount={h()}>
            <AccountBanner state={state()} summary={summary()} />
          </Portal>
        )}
      </Show>
      <Show when={addOpen() ? panelHost() : null}>
        {(h) => (
          <Portal mount={h()}>
            <AddProvider catalog={catalogStore()} onClose={() => setAddOpen(false)} />
          </Portal>
        )}
      </Show>
    </>
  )
}

/* ── icons (1.6 stroke, matching the composer chips) ─────────────────────────── */
const ico = "0 0 24 24"
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
  <svg class="a-ic a-ic-2xs" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const Lock = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)
const Login = () => (
  <svg class="a-ic a-ic-2xs" viewBox={ico}>
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <path d="M10 17l5-5-5-5M15 12H3" />
  </svg>
)
