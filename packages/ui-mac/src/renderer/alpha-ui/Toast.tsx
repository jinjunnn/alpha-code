import { createSignal, For, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import "./toast.css"

/**
 * alpha-ui Toast — a tiny singleton store + viewport for transient feedback.
 * Mount <ToastViewport/> once near the app root; call pushToast(...) from anywhere.
 * Consumes only --a-* tokens. No external deps; ids come from a counter (no Math.random).
 */
export type ToastKind = "info" | "success" | "error"
export type ToastItem = { id: number; kind: ToastKind; title: string; detail?: string }

const [items, setItems] = createSignal<ToastItem[]>([])
let seq = 0

export function pushToast(t: { kind?: ToastKind; title: string; detail?: string; duration?: number }): number {
  const id = ++seq
  setItems((xs) => [...xs, { id, kind: t.kind ?? "info", title: t.title, detail: t.detail }])
  const ms = t.duration ?? 4000
  if (ms > 0) setTimeout(() => dismissToast(id), ms)
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
            <div class="a-toast" data-kind={toast.kind} role="status" aria-live="polite">
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
