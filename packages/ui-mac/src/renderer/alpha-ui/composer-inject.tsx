// ComposerInject — makes opencode's in-session composer match AlphaHome by Portaling the SAME shared
// chips (权限 + effort, from composer-controls.tsx — the single source AlphaHome also uses) into its
// toolbar. opencode's prompt-input.tsx can't be edited (ADR-005), so we mount a host <div> into its
// toolbar DOM (verified to survive Solid's re-renders) and Portal the chips in. A debounced
// MutationObserver re-attaches the host when the composer remounts (route changes / new session).
//
// Layout parity with home is done in composer-reskin.css via flex `order` + margin-left:auto on
// opencode's native model button (权限 left · 模型/effort/发送 right). 权限 wires to opencode's real
// `permissions.autoaccept.*` command; effort is local intent (opencode's effort context isn't exported).

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { AddButton, EffortChip, PermChip, setComposerAgentLabel, setComposerModelLabel, setComposerVariantLabel } from "./composer-controls"

export function ComposerInject() {
  // Two mount points so the chips land where AlphaHome puts them: 权限 after the +/attach (LEFT), and
  // effort right after opencode's model button (RIGHT). One shared host can't do this — opencode keeps
  // + and the model button in separate sub-containers, so flex `order` can't move effort across them.
  const [addHost, setAddHost] = createSignal<HTMLElement | null>(null)
  const [permHost, setPermHost] = createSignal<HTMLElement | null>(null)
  const [effortHost, setEffortHost] = createSignal<HTMLElement | null>(null)
  // perm/effort state now lives in composer-controls (shared with AlphaHome) — the chips are self-contained.

  const PLUS_SEL = "[data-action=prompt-attach], [data-slot=icon-button]"

  // find-or-create a `display:contents` host (children join the toolbar's flex row).
  const ensureHost = (name: string): HTMLElement => {
    let h = document.querySelector(`[data-alpha-composer-inject="${name}"]`) as HTMLElement | null
    if (!h) {
      h = document.createElement("div")
      h.setAttribute("data-alpha-composer-inject", name)
      // A real flex item (not display:contents) so its CSS `order` actually re-positions it relative to
      // opencode's model button — display:contents hosts let the child's order be ignored by the flex row.
      h.style.display = "inline-flex"
      h.style.alignItems = "center"
    }
    return h
  }
  // Move `h` to sit immediately after `ref` — but ONLY when it isn't already there. Re-checking each
  // sync lets effort migrate from its fallback to the model wrapper once the model button mounts; the
  // identity guard makes the move a no-op afterwards (otherwise the re-insert would loop the observer).
  const placeAfter = (h: HTMLElement, ref: HTMLElement) => {
    if (ref.nextSibling !== h) ref.parentElement!.insertBefore(h, ref.nextSibling)
  }

  const sync = () => {
    const composer = document.querySelector(
      "[data-component=session-composer],[data-component=session-new-composer]",
    )
    const plus = composer?.querySelector(PLUS_SEL) as HTMLElement | null
    const model = composer?.querySelector("[data-action=prompt-model]") as HTMLElement | null
    // REQ-028:发布当前 agent 名(PermChip「只读」判停与状态一致性的观察源)
    const agentBtn = composer?.querySelector('[data-action="prompt-agent"]') as HTMLElement | null
    setComposerAgentLabel(agentBtn?.textContent?.trim().toLowerCase() || undefined)
    // REQ-029:发布 variant 控件状态(存在性=模型支持推理档;文本=当前档)
    const variantBtn = composer?.querySelector('[data-action="prompt-model-variant"]') as HTMLElement | null
    setComposerVariantLabel(variantBtn?.textContent?.trim() || undefined)
    if (!composer || !plus) {
      if (addHost()) setAddHost(null)
      if (permHost()) setPermHost(null)
      if (effortHost()) setEffortHost(null)
      return
    }
    // publish the live model name (shared with AlphaHome's ModelChip so home shows the SAME model, not
    // the "ALPHA" placeholder). opencode renders the name in a `.truncate` span inside the model button.
    const modelName = (model?.querySelector(".truncate")?.textContent ?? model?.textContent)?.trim()
    if (modelName) setComposerModelLabel(modelName)
    // alpha + menu → BEFORE opencode's (now hidden) + so it sits at the far left (#31). Same AddButton
    // as the home composer, so the "+" interaction is identical on both surfaces.
    const ah = ensureHost("add")
    if (plus.previousSibling !== ah) plus.parentElement!.insertBefore(ah, plus)
    if (addHost() !== ah) setAddHost(ah)
    // 权限 → right after the +/attach button (LEFT).
    const ph = ensureHost("perm")
    placeAfter(ph, plus)
    if (permHost() !== ph) setPermHost(ph)
    // effort → right after the model button's wrapper (RIGHT), so it rides next to 模型/发送. Falls
    // back next to + until the model button mounts, then migrates.
    const eh = ensureHost("effort")
    placeAfter(eh, (model?.parentElement as HTMLElement | null) ?? plus)
    if (effortHost() !== eh) setEffortHost(eh)

    // usage ring → MOVE opencode's own context-usage button into the toolbar, left of the model chip
    // (#21/#25: the design puts the context ring in the composer). We relocate the live node (keeps its
    // % reactive) since SessionContextUsage isn't exported.
    //
    // BUG FIX (rings pile up — one per session-tab click): opencode keeps each visited session's
    // timeline mounted (tab keep-alive), and every timeline renders its OWN context-usage ring. The old
    // code `appendChild`'d whatever ring it found into the host on each sync but never removed the prior
    // one, so each session switch stacked another ○ in the toolbar. Fix = adopt ONLY the *currently
    // visible* session's ring (hidden keep-alive timelines have offsetParent === null) and
    // `replaceChildren` so the host holds at most one. Excluding rings already inside an alpha host means
    // that once the live ring is adopted there's no other candidate → the sync is a stable no-op (no
    // observer storm), and a session switch surfaces a new visible ring → a single clean swap.
    if (model) {
      const uh = ensureHost("usage")
      const modelWrap = model.parentElement as HTMLElement | null
      if (modelWrap && uh.nextSibling !== modelWrap) modelWrap.parentElement!.insertBefore(uh, modelWrap)
      // Adopt ONLY the real toolbar usage button (ghost icon-button, circle-only). The session side
      // panel's 「上下文」 TAB TRIGGER also contains a progress-circle (session-side-panel.tsx renders
      // SessionContextUsage variant=indicator + a text label inside Tabs.Trigger) — the old selector
      // adopted it whenever that tab was open, which both showed a stray "上下文" label in the toolbar
      // (user report, REQ-038 walkthrough) AND stole the trigger out of the side panel's tab strip.
      // Discriminators: not a tab / not inside a tablist, and icon-only (no text).
      const live = [...document.querySelectorAll('button:has([data-component="progress-circle"])')].find(
        (b) =>
          !b.closest("[data-alpha-composer-inject]") &&
          !b.closest('[role="tab"], [role="tablist"]') &&
          (b.textContent ?? "").trim() === "" &&
          (b as HTMLElement).offsetParent !== null,
      ) as HTMLElement | undefined
      // Evict a previously mis-adopted tab trigger (pre-fix sessions): a host child with label text
      // is never the real usage button. Dropping it lets the toolbar heal; the side panel rebuilds
      // its triggers reactively on the next tabs update.
      const cur = uh.firstElementChild as HTMLElement | null
      if (cur && (cur.textContent ?? "").trim() !== "") uh.replaceChildren()
      if (live && uh.firstChild !== live) uh.replaceChildren(live)
    }
  }

  // Debounce with setTimeout, NOT requestAnimationFrame (rAF is throttled when backgrounded/headless,
  // which would leave the chips un-injected).
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
    sync()
    for (const d of [80, 250, 600, 1200]) setTimeout(sync, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })

  return (
    <>
      <Show when={addHost()}>{(h) => <Portal mount={h()}><AddButton /></Portal>}</Show>
      <Show when={permHost()}>{(h) => <Portal mount={h()}><PermChip /></Portal>}</Show>
      <Show when={effortHost()}>{(h) => <Portal mount={h()}><EffortChip /></Portal>}</Show>
    </>
  )
}
