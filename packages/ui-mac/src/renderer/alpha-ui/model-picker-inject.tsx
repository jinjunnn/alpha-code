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
import { ALPHA_ENDPOINTS, ALPHA_PATHS } from "../../shared/alpha-config"
import { setExtHubOpen } from "../extensions/ext-hub-state"

type Tier = { cls: "flag" | "pro" | "std"; label: string; mult: string }

// Tier follows the model id. Flagship = frontier (×8); premium = strong mid-tier (×3); else standard
// (×1). Matches the mockup (Opus/GPT-5.5=旗舰, Sonnet/Gemini=高级, DeepSeek=标准). Substring heuristic
// so new gateway models slot in without a hardcoded table.
function tierOf(modelId: string): Tier {
  const id = modelId.toLowerCase()
  if (/opus|gpt-5\.5|gpt-5-pro|grok-4/.test(id)) return { cls: "flag", label: "旗舰", mult: "×8" }
  if (/sonnet|gemini|gpt-5|grok|reasoner|thinking|-r1|glm-4\.6/.test(id)) return { cls: "pro", label: "高级", mult: "×3" }
  return { cls: "std", label: "标准", mult: "×1" }
}

// Per-provider pico (mockup #20: every row leads with a colored square + initial; alpha proxy = α).
const PROV_COLOR: Record<string, string> = {
  alpha: "#4f46e5",
  deepseek: "#2563eb",
  zhipuai: "#16a34a",
  moonshot: "#18181b",
  kimi: "#18181b",
  qwen: "#7c3aed",
  dashscope: "#7c3aed",
  openrouter: "#18181b",
}
const PROV_LETTER: Record<string, string> = {
  alpha: "α",
  deepseek: "D",
  zhipuai: "智",
  moonshot: "K",
  kimi: "K",
  qwen: "通",
  dashscope: "通",
  openrouter: "OR",
}
// Reasoning dot = model supports effort (mockup: 蓝点). Heuristic on id (no variants data in the DOM).
const EFFORT_RE = /reasoner|thinking|-r1|opus|sonnet|gpt-5|gemini|o1|o3|grok-4|glm-4\.6|qwq/i

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
  const t = tierOf(modelId)
  const isAlpha = provider === "alpha"
  const inner = (row.querySelector(":scope > div") as HTMLElement | null) ?? row

  // leading provider/α pico
  const pico = document.createElement("span")
  pico.className = "a-mp-pico"
  pico.style.background = PROV_COLOR[provider] || "#71717a"
  pico.textContent = PROV_LETTER[provider] || provider.slice(0, 1).toUpperCase()

  // name → two lines (name + "经代理 · 旗舰" / model-id subtitle)
  const nameSpan = inner.querySelector("span") as HTMLElement | null
  const col = document.createElement("div")
  col.className = "a-mp-namecol"
  const sub = document.createElement("div")
  sub.className = "a-mp-sub"
  sub.textContent = isAlpha ? `经代理 · ${t.label}` : modelId
  if (nameSpan) {
    nameSpan.replaceWith(col)
    col.append(nameSpan, sub)
  }
  inner.insertBefore(pico, inner.firstChild)

  // right side: reasoning dot · tier badge · cost multiplier
  if (EFFORT_RE.test(modelId)) {
    const dot = document.createElement("span")
    dot.className = "a-mp-dot"
    inner.append(dot)
  }
  const badge = document.createElement("span")
  badge.className = `a-mp-tier ${t.cls}`
  badge.textContent = t.label
  const mult = document.createElement("span")
  mult.className = "a-mp-mult"
  mult.textContent = t.mult
  inner.append(badge, mult)
}

// Relabel the alpha provider's group header → 代理节点 · ALPHA-PLATFORM 推荐 (mockup #20). The header
// text is the provider display name ("ALPHA"); idempotent via a marker.
function relabelGroups() {
  for (const h of document.querySelectorAll<HTMLElement>("[data-slot='list-header']")) {
    if (h.hasAttribute("data-alpha-grp")) continue
    const txt = (h.textContent || "").trim()
    if (txt === "ALPHA" || /alpha-?platform/i.test(txt)) {
      h.setAttribute("data-alpha-grp", "")
      h.textContent = "代理节点 · ALPHA-PLATFORM"
      const tag = document.createElement("span")
      tag.className = "a-mp-grouptag"
      tag.textContent = "推荐"
      h.append(tag)
    }
  }
}

// Footer: "+ 添加自定义节点 / 供应商" → opens the custom-node setup (mockup #20/§06). Appended once to
// the list, below the scroll. Wired to the Extension Hub for now (the §06 add-node dialog is V1+).
function ensureFooter() {
  const list = document.querySelector("[data-component='list']")
  if (!list || !list.querySelector("[data-slot='list-item'][data-key*=':']")) return
  if (list.querySelector(":scope > [data-alpha-mp-foot]")) return
  const foot = document.createElement("button")
  foot.setAttribute("data-alpha-mp-foot", "")
  foot.className = "a-mp-foot"
  foot.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>添加自定义节点 / 供应商</span>`
  foot.addEventListener("click", () => {
    setExtHubOpen(true)
  })
  list.append(foot)
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
    ensureFooter()
    // Pin the account banner above the model list — ONLY in the model picker (a list with model rows),
    // not the provider-select dialog (which reuses [data-component=list] with bare provider keys).
    const list = document.querySelector("[data-component='list']")
    const scroll = list?.querySelector("[data-slot='list-scroll']")
    const hasModels = list?.querySelector("[data-slot='list-item'][data-key*=':']")
    if (list && scroll && hasModels) {
      let h = list.querySelector(":scope > [data-alpha-acct-banner]") as HTMLElement | null
      if (!h) {
        h = document.createElement("div")
        h.setAttribute("data-alpha-acct-banner", "")
        list.insertBefore(h, scroll)
      }
      if (bannerHost() !== h) setBannerHost(h)
    } else if (bannerHost()) {
      setBannerHost(null)
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
    scan()
    for (const d of [80, 250, 600]) setTimeout(scan, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })

  return <Show when={bannerHost()}>{(h) => <Portal mount={h()}><AccountBanner state={state()} summary={summary()} /></Portal>}</Show>
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
