import { createSignal, For, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import "./toast.css"

/**
 * alpha-ui Toast — a tiny singleton store + viewport for feedback (transient by default;
 * `duration <= 0` pins a toast until the user dismisses it — see pushToast).
 * Mount <ToastViewport/> once near the app root; call pushToast(...) from anywhere.
 * Consumes only --a-* tokens. No external deps; ids come from a counter (no Math.random).
 */
export type ToastKind = "info" | "success" | "error"
/** `persistent` = 这条不自己消失,只能由用户关掉。它**不是**独立开关:见 `pushToast` —— 它与
 *  「有没有装拆除定时器」由同一个值派生,所以 DOM 上的 `data-persistent` 与真实存活行为
 *  不可能各说各话。 */
export type ToastItem = { id: number; kind: ToastKind; title: string; detail?: string; persistent: boolean }

const [items, setItems] = createSignal<ToastItem[]>([])
let seq = 0

/**
 * `duration <= 0` = 常驻(不装拆除定时器,用户按 × 才走)。这个能力从一开始就在这里,
 * 只是没人用过 —— `#771` 把它接上,不新造第二种呈现形态。
 *
 * `persistent` 与「装不装定时器」读的是**同一个** `ms`,所以视口上的 `data-persistent`
 * 是真实存活行为的投影,而不是一个可能与它不一致的第二事实。
 */
export function pushToast(t: { kind?: ToastKind; title: string; detail?: string; duration?: number }): number {
  const id = ++seq
  const ms = t.duration ?? 4000
  const persistent = ms <= 0
  setItems((xs) => [...xs, { id, kind: t.kind ?? "info", title: t.title, detail: t.detail, persistent }])
  if (!persistent) setTimeout(() => dismissToast(id), ms)
  return id
}

export function dismissToast(id: number): void {
  setItems((xs) => xs.filter((x) => x.id !== id))
}

export function ToastViewport(): JSX.Element {
  return (
    <Portal>
      <div class="a-toast-viewport a-ui">
        <For each={items()}>
          {(toast) => (
            <div class="a-toast" data-kind={toast.kind} data-persistent={toast.persistent ? "true" : undefined} role="status" aria-live="polite">
              <span class="a-toast-ico" aria-hidden="true" />
              <div class="a-toast-body">
                <b>{toast.title}</b>
                {toast.detail ? <small>{toast.detail}</small> : null}
              </div>
              <button class="a-toast-x" aria-label={t("alpha.common.close")} onClick={() => dismissToast(toast.id)}>
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  )
}
