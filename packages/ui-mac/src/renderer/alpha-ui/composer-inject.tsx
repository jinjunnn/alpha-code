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
import { useCommand } from "@opencode-ai/app"
import { EffortChip, PermChip, type Effort, type PermMode } from "./composer-controls"

export function ComposerInject() {
  const command = useCommand()
  // Two mount points so the chips land where AlphaHome puts them: 权限 after the +/attach (LEFT), and
  // effort right after opencode's model button (RIGHT). One shared host can't do this — opencode keeps
  // + and the model button in separate sub-containers, so flex `order` can't move effort across them.
  const [permHost, setPermHost] = createSignal<HTMLElement | null>(null)
  const [effortHost, setEffortHost] = createSignal<HTMLElement | null>(null)
  const [perm, setPerm] = createSignal<PermMode>("ask")
  const [effort, setEffort] = createSignal<Effort>("高")

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
    if (!composer || !plus) {
      if (permHost()) setPermHost(null)
      if (effortHost()) setEffortHost(null)
      return
    }
    // 权限 → right after the +/attach button (LEFT).
    const ph = ensureHost("perm")
    placeAfter(ph, plus)
    if (permHost() !== ph) setPermHost(ph)
    // effort → right after the model button's wrapper (RIGHT), so it rides next to 模型/发送. Falls
    // back next to + until the model button mounts, then migrates.
    const eh = ensureHost("effort")
    placeAfter(eh, (model?.parentElement as HTMLElement | null) ?? plus)
    if (effortHost() !== eh) setEffortHost(eh)
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

  const setPermMode = (mode: PermMode) => {
    setPerm(mode)
    try {
      command.trigger(mode === "full" ? "permissions.autoaccept.enable" : "permissions.autoaccept.disable")
    } catch {
      /* command may be unregistered in some states; chip still reflects intent */
    }
  }

  return (
    <>
      <Show when={permHost()}>{(h) => <Portal mount={h()}><PermChip mode={perm()} onChange={setPermMode} /></Portal>}</Show>
      <Show when={effortHost()}>{(h) => <Portal mount={h()}><EffortChip value={effort()} onChange={setEffort} /></Portal>}</Show>
    </>
  )
}
