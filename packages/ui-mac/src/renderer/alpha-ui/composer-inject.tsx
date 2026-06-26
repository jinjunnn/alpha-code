// ComposerInject — makes opencode's in-session composer consistent with AlphaHome's composer by
// injecting the same alpha chips (权限 + effort) into its toolbar. opencode's prompt-input.tsx can't
// be edited (ADR-005), so we mount a host <div> into its toolbar DOM (verified to survive Solid's
// re-renders, cdp-injecttest2.ts) and Portal the chips in. A debounced MutationObserver re-attaches
// the host when the composer remounts (route changes / new session). The chips reuse the .a-chip
// styles from home.css, so the two composers read as one design system.
//
// Wiring: 权限 → opencode's `permissions.autoaccept.enable/disable` command (real). effort → local
// (opencode's variant/effort context isn't exported; the chip carries intent and the in-session
// model still runs at server default — same limitation noted for the home composer).

import { createSignal, onCleanup, onMount, Show, For } from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "@opencode-ai/app"

const EFFORTS = ["低", "中", "高", "超高"] as const
const ico = "0 0 24 24"

export function ComposerInject() {
  const command = useCommand()
  const [host, setHost] = createSignal<HTMLElement | null>(null)
  const [perm, setPerm] = createSignal<"full" | "ask">("ask")
  const [effort, setEffort] = createSignal<(typeof EFFORTS)[number]>("高")
  const [pop, setPop] = createSignal<null | "perm" | "effort">(null)

  // The composer toolbar = the flex row that holds opencode's +/model/send (data-slot icon-button /
  // button). We inject our host right after the first icon-button (the +), so 权限 sits where the
  // home composer puts it.
  // The in-session composer (session-composer) anchors its + on data-action="prompt-attach"; the
  // new-session one uses data-slot="icon-button". Match either, and treat the +'s parent as the
  // toolbar row we inject into.
  const PLUS_SEL = "[data-action=prompt-attach], [data-slot=icon-button]"
  const findToolbar = (): HTMLElement | null => {
    const composer = document.querySelector(
      "[data-component=session-composer],[data-component=session-new-composer]",
    )
    if (!composer) return null
    const plus = composer.querySelector(PLUS_SEL) as HTMLElement | null
    return (plus?.parentElement as HTMLElement) ?? null
  }

  const sync = () => {
    const bar = findToolbar()
    if (!bar) {
      if (host()) setHost(null)
      return
    }
    let h = bar.querySelector(":scope > [data-alpha-composer-inject]") as HTMLElement | null
    if (!h) {
      h = document.createElement("div")
      h.setAttribute("data-alpha-composer-inject", "")
      h.style.display = "contents" // children join the toolbar's flex row
      const plus = bar.querySelector(PLUS_SEL)
      if (plus && plus.nextSibling) bar.insertBefore(h, plus.nextSibling)
      else bar.appendChild(h)
    }
    if (host() !== h) setHost(h)
  }

  // Debounce with setTimeout, NOT requestAnimationFrame: rAF is throttled/paused when the window is
  // backgrounded (or driven headlessly), which would leave the chips un-injected. setTimeout fires
  // regardless.
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      sync()
    }, 0)
  }

  let mo: MutationObserver | undefined
  onMount(() => {
    // Initial retries cover the case where the composer mounts slightly after us (no mutation to
    // observe if it was already mid-render), then the observer keeps it attached across remounts.
    sync()
    for (const d of [80, 250, 600, 1200]) setTimeout(sync, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })

  const setPermMode = (mode: "full" | "ask") => {
    setPerm(mode)
    setPop(null)
    try {
      command.trigger(mode === "full" ? "permissions.autoaccept.enable" : "permissions.autoaccept.disable")
    } catch {
      /* command may be unregistered in some states; chip still reflects intent */
    }
  }

  // Close popovers on outside click (target-aware — see AlphaHome for why stopPropagation is not
  // enough under Solid's document-level event delegation).
  const onDoc = (e: MouseEvent) => {
    const t = e.target as Element | null
    if (t && t.closest(".a-pop-wrap")) return
    setPop(null)
  }
  document.addEventListener("click", onDoc)
  onCleanup(() => document.removeEventListener("click", onDoc))
  const stop = (e: Event) => e.stopPropagation()

  return (
    <Show when={host()}>
      {(h) => (
        <Portal mount={h()}>
          {/* 权限 */}
          <div class="a-pop-wrap a-comp-inject-chip">
            <button
              class="a-chip a-chip-perm"
              data-mode={perm()}
              onClick={(e) => {
                stop(e)
                setPop(pop() === "perm" ? null : "perm")
              }}
            >
              <svg class="a-ic a-ic-sm" viewBox={ico}>
                <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
              </svg>
              {perm() === "full" ? "完全访问" : "请求审批"}
              <svg class="a-ic a-chev" viewBox={ico}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <Show when={pop() === "perm"}>
              <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "230px" }}>
                <div class="a-pop-label">运行权限</div>
                <button class="a-pop-item" classList={{ "is-on": perm() === "full" }} onClick={() => setPermMode("full")}>
                  <svg class="a-ic" viewBox={ico}>
                    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
                  </svg>
                  完全访问 <span class="a-pop-desc">允许全部</span>
                </button>
                <button class="a-pop-item" classList={{ "is-on": perm() === "ask" }} onClick={() => setPermMode("ask")}>
                  <svg class="a-ic" viewBox={ico}>
                    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                  请求审批 <span class="a-pop-desc">逐次询问</span>
                </button>
              </div>
            </Show>
          </div>

          {/* effort */}
          <div class="a-pop-wrap a-comp-inject-chip">
            <button
              class="a-chip"
              onClick={(e) => {
                stop(e)
                setPop(pop() === "effort" ? null : "effort")
              }}
            >
              <svg class="a-ic a-ic-sm" viewBox={ico}>
                <path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6z" />
              </svg>
              <span class="a-comp-eff">{effort()}</span>
              <svg class="a-ic a-chev" viewBox={ico}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <Show when={pop() === "effort"}>
              <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "180px" }}>
                <div class="a-pop-label">推理强度 · effort</div>
                <For each={EFFORTS}>
                  {(lv) => (
                    <button class="a-pop-item" classList={{ "is-on": effort() === lv }} onClick={() => (setEffort(lv), setPop(null))}>
                      <Show when={effort() === lv} fallback={<span style={{ width: "16px" }} />}>
                        <svg class="a-ic a-ic-sm" viewBox={ico} style={{ color: "var(--a-accent)" }}>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </Show>
                      {lv}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  )
}
