import { createSignal, For, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import "./toast.css"

/**
 * alpha-ui Toast — a tiny singleton store + viewport for feedback.
 * Mount <ToastViewport/> once near the app root; call pushToast(...) from anywhere.
 * Consumes only --a-* tokens. No external deps; ids come from a counter (no Math.random).
 *
 * REQ-230 AC3(#1476)的通知规则:
 * - 普通通知(info / success)默认 4 秒自动消失;鼠标停在上面或键盘焦点在里面时**暂停**,离开后接着走剩下的时间。
 * - 出错通知(`kind: "error"`)**不自动消失**,只能由用户关掉;并以 `role="alert"`(assertive)立即朗读 ——
 *   出错是用户需要读完、可能还要照着做的信息,4 秒一闪而过等于没说。
 * - `duration <= 0` 仍可让任何一条常驻(`#771` 的既有能力)。
 */
export type ToastKind = "info" | "success" | "error"
/** `persistent` = 这条不自己消失,只能由用户关掉。它**不是**独立开关:见 `pushToast` —— 它与
 *  「有没有装拆除定时器」由同一个值派生,所以 DOM 上的 `data-persistent` 与真实存活行为
 *  不可能各说各话。 */
export type ToastItem = { id: number; kind: ToastKind; title: string; detail?: string; persistent: boolean }

/** 普通通知的停留时长。 */
export const TOAST_DURATION_MS = 4000

const [items, setItems] = createSignal<ToastItem[]>([])
let seq = 0

/** 每条非常驻通知的拆除计时:`remaining` 在暂停时冻结,恢复时从剩下的时间接着走。 */
type DismissTimer = { handle: ReturnType<typeof setTimeout> | undefined; deadline: number; remaining: number }
const timers = new Map<number, DismissTimer>()

function schedule(id: number, ms: number): void {
  const timer: DismissTimer = { handle: undefined, deadline: Date.now() + ms, remaining: ms }
  timer.handle = setTimeout(() => dismissToast(id), ms)
  timers.set(id, timer)
}

/**
 * 常驻 = 出错通知,或 `duration <= 0`(不装拆除定时器,用户按 × 才走)。
 *
 * `persistent` 与「装不装定时器」读的是**同一个**判据,所以视口上的 `data-persistent`
 * 是真实存活行为的投影,而不是一个可能与它不一致的第二事实。
 */
export function pushToast(t: { kind?: ToastKind; title: string; detail?: string; duration?: number }): number {
  const id = ++seq
  const kind = t.kind ?? "info"
  const ms = t.duration ?? TOAST_DURATION_MS
  const persistent = kind === "error" || ms <= 0
  setItems((xs) => [...xs, { id, kind, title: t.title, detail: t.detail, persistent }])
  if (!persistent) schedule(id, ms)
  return id
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer.handle)
  timers.delete(id)
  setItems((xs) => xs.filter((x) => x.id !== id))
}

/** 悬停 / 聚焦时暂停这条通知的倒计时(常驻的没有倒计时,空操作)。 */
export function pauseToast(id: number): void {
  const timer = timers.get(id)
  if (!timer || timer.handle === undefined) return
  clearTimeout(timer.handle)
  timer.handle = undefined
  timer.remaining = Math.max(0, timer.deadline - Date.now())
}

/** 离开后从剩下的时间接着走。 */
export function resumeToast(id: number): void {
  const timer = timers.get(id)
  if (!timer || timer.handle !== undefined) return
  schedule(id, timer.remaining)
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
              onFocusOut={(event) => {
                const next = event.relatedTarget
                if (next instanceof Node && event.currentTarget.contains(next)) return
                resumeToast(toast.id)
              }}
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
