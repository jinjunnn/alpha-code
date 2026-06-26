// composer-controls — the SINGLE source of truth for the alpha composer toolbar chips (权限 · 模型 ·
// effort). Rendered by BOTH the home composer (AlphaHome) and the in-session composer (composer-inject
// Portals these into opencode's toolbar), so the two surfaces are literally one set of components and
// a change is made in ONE place. opencode's heavy in-session composer (textarea/send/slash/attach) is
// kept per ADR-016; only this alpha chrome is shared.
//
// Each chip is self-contained: it owns its popover open-state and a target-aware outside-click close
// (SolidJS delegates events on document, so a chip's stopPropagation can't stop a document listener —
// we ignore clicks that land inside .a-pop-wrap and close on everything else).

import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"

export const EFFORTS = ["低", "中", "高", "超高"] as const
export type Effort = (typeof EFFORTS)[number]
// full = 完全访问 (autoaccept on), ask = 请求审批 (autoaccept off / prompt each time),
// read = 只读 (禁止写/执行). opencode has no runtime read-only command, so 只读 maps to the strictest
// available (autoaccept off → prompt before any write/exec); the chip still surfaces the intent.
export type PermMode = "full" | "ask" | "read"
const PERM_LABEL: Record<PermMode, string> = { full: "完全访问", ask: "请求审批", read: "只读" }

const ico = "0 0 24 24"

/* ── icons ─────────────────────────────────────────────────────────────────── */
export const Plus = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const Chevron = () => (
  <svg class="a-ic a-chev" viewBox={ico}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
// 完全访问 = SOLID filled shield (strong/trusted). 请求审批 = OUTLINE shield + check (cautious).
// The two are intentionally distinct so the active mode reads at a glance.
export const ShieldSolid = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico} style={{ fill: "currentColor", stroke: "none" }}>
    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
  </svg>
)
export const ShieldAsk = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)
export const Eye = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
)
export const Bolt = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6z" />
  </svg>
)
export const Check = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico} style={{ color: "var(--a-accent)" }}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)
export const ArrowUp = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

// Self-managed popover close: registers a target-aware document listener while open.
function useOutsideClose(close: () => void) {
  const onDoc = (e: MouseEvent) => {
    const t = e.target as Element | null
    if (t && t.closest(".a-pop-wrap")) return
    close()
  }
  document.addEventListener("click", onDoc)
  onCleanup(() => document.removeEventListener("click", onDoc))
}

const stop = (e: Event) => e.stopPropagation()

/* ── 权限 chip ─────────────────────────────────────────────────────────────── */
export function PermChip(props: { mode: PermMode; onChange: (m: PermMode) => void }) {
  const [open, setOpen] = createSignal(false)
  useOutsideClose(() => setOpen(false))
  const pick = (m: PermMode) => {
    props.onChange(m)
    setOpen(false)
  }
  const PermIcon = (p: { mode: PermMode }) => (
    <Switch fallback={<ShieldAsk />}>
      <Match when={p.mode === "full"}>
        <ShieldSolid />
      </Match>
      <Match when={p.mode === "read"}>
        <Eye />
      </Match>
    </Switch>
  )
  return (
    <div class="a-pop-wrap a-comp-inject-chip" data-kind="perm">
      <button
        class="a-chip a-chip-perm"
        data-mode={props.mode}
        onClick={(e) => {
          stop(e)
          setOpen(!open())
        }}
      >
        <PermIcon mode={props.mode} />
        {PERM_LABEL[props.mode]}
        <Chevron />
      </button>
      <Show when={open()}>
        <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "230px" }}>
          <div class="a-pop-label">运行权限</div>
          <button class="a-pop-item" classList={{ "is-on": props.mode === "full" }} onClick={() => pick("full")}>
            <ShieldSolid /> 完全访问 <span class="a-pop-desc">允许全部</span>
          </button>
          <button class="a-pop-item" classList={{ "is-on": props.mode === "ask" }} onClick={() => pick("ask")}>
            <ShieldAsk /> 请求审批 <span class="a-pop-desc">逐次询问</span>
          </button>
          <button class="a-pop-item" classList={{ "is-on": props.mode === "read" }} onClick={() => pick("read")}>
            <Eye /> 只读 <span class="a-pop-desc">禁止写/执行</span>
          </button>
        </div>
      </Show>
    </div>
  )
}

/* ── effort chip ───────────────────────────────────────────────────────────── */
export function EffortChip(props: { value: Effort; onChange: (e: Effort) => void }) {
  const [open, setOpen] = createSignal(false)
  useOutsideClose(() => setOpen(false))
  return (
    <div class="a-pop-wrap a-comp-inject-chip" data-kind="effort">
      <button
        class="a-chip"
        onClick={(e) => {
          stop(e)
          setOpen(!open())
        }}
      >
        <Bolt />
        <span class="a-comp-eff">{props.value}</span>
        <Chevron />
      </button>
      <Show when={open()}>
        <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "180px" }}>
          <div class="a-pop-label">推理强度 · effort</div>
          <For each={EFFORTS}>
            {(lv) => (
              <button
                class="a-pop-item"
                classList={{ "is-on": props.value === lv }}
                onClick={() => (props.onChange(lv), setOpen(false))}
              >
                <Show when={props.value === lv} fallback={<span style={{ width: "16px" }} />}>
                  <Check />
                </Show>
                {lv}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/* ── 模型 chip ─────────────────────────────────────────────────────────────── */
// Clickable: opens opencode's model picker (the shared three-tier selector) via the `model.choose`
// command, so the home chip behaves the same as the in-session one (was a dead button before).
export function ModelChip(props: { label?: string; onClick: () => void }) {
  return (
    <button
      class="a-chip a-chip-model a-comp-inject-chip"
      data-kind="model"
      title="选择模型"
      onClick={(e) => {
        stop(e)
        props.onClick()
      }}
    >
      <span class="a-pico" style={{ background: "var(--a-accent)" }}>
        α
      </span>
      {props.label ?? "ALPHA"}
      <Chevron />
    </button>
  )
}
