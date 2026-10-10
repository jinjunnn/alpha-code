import { createSignal, For, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import "./toast.css"

/**
 * alpha-ui Toast — a tiny singleton store + viewport for feedback.
 * Mount <ToastViewport/> once near the app root; call pushToast(...) from anywhere.
 * Consumes only --a-* tokens. No external deps; ids come from a counter (no Math.random).
 *
 * `#1476`(REQ-230 AC3)定下的通知规则,全在这一个文件里:
 * - 普通通知(info / success)默认 4 秒自动消失;鼠标停在上面(或键盘焦点在里面)时**暂停**,
 *   离开后按剩余时间继续 —— 用户正在读的那条不会在眼皮底下消失。
 * - **出错通知常驻**,只能由用户关掉;并且用 `role="alert"` + `aria-live="assertive"` 立即朗读。
 *   调用方传的 `duration` 对错误不起作用:「错误会自己消失」本身就是要消灭的那种缺陷。
 */
export type ToastKind = "info" | "success" | "error"
/** `persistent` = 这条不自己消失,只能由用户关掉。它**不是**独立开关:见 `pushToast` —— 它与
 *  「有没有装拆除定时器」由同一个值派生,所以 DOM 上的 `data-persistent` 与真实存活行为
 *  不可能各说各话。 */
export type ToastItem = { id: number; kind: ToastKind; title: string; detail?: string; persistent: boolean }

/** 普通通知的默认停留时长。 */
export const TOAST_DEFAULT_MS = 4000

const [items, setItems] = createSignal<ToastItem[]>([])
let seq = 0

type Timer = { remaining: number; startedAt: number; handle: ReturnType<typeof setTimeout> | undefined }
const timers = new Map<number, Timer>()

function arm(id: number) {
  const timer = timers.get(id)
  if (!timer || timer.handle !== undefined) return
  timer.startedAt = Date.now()
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining)
}

/**
 * 是否常驻只由一个值决定:`error` 一律常驻;其余 `duration <= 0` 常驻,否则按 `duration`
 * (缺省 4 秒)自走。`persistent` 与「装不装定时器」读的是同一个结论,所以视口上的
 * `data-persistent` 是真实存活行为的投影,而不是一个可能与它不一致的第二事实。
 */
export function pushToast(t: { kind?: ToastKind; title: string; detail?: string; duration?: number }): number {
  const id = ++seq
  const kind = t.kind ?? "info"
  const ms = t.duration ?? TOAST_DEFAULT_MS
  const persistent = kind === "error" || ms <= 0
  setItems((xs) => [...xs, { id, kind, title: t.title, detail: t.detail, persistent }])
  if (!persistent) {
    timers.set(id, { remaining: ms, startedAt: 0, handle: undefined })
    arm(id)
  }
  return id
}

/** 暂停自动消失(悬停 / 焦点进入)。常驻通知没有定时器,调用是空操作。 */
export function pauseToast(id: number): void {
  const timer = timers.get(id)
  if (!timer || timer.handle === undefined) return
  clearTimeout(timer.handle)
  timer.handle = undefined
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
}

/** 按剩余时间继续(悬停 / 焦点离开)。 */
export function resumeToast(id: number): void {
  arm(id)
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer?.handle !== undefined) clearTimeout(timer.handle)
  timers.delete(id)
  setItems((xs) => xs.filter((x) => x.id !== id))
}

export function ToastViewport(): JSX.Element {
  return (
    <Portal>
      <div class="a-toast-viewport a-ui">
        <For each={items()}>
          {(toast) => (
            <div
              class="a-toast"
              data-kind={toast.kind}
              data-persistent={toast.persistent ? "true" : undefined}
              role={toast.kind === "error" ? "alert" : "status"}
              aria-live={toast.kind === "error" ? "assertive" : "polite"}
              onMouseEnter={() => pauseToast(toast.id)}
              onMouseLeave={() => resumeToast(toast.id)}
              onFocusIn={() => pauseToast(toast.id)}
              onFocusOut={() => resumeToast(toast.id)}
            >
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
