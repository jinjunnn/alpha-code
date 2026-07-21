import { Show, type JSX, createEffect, createUniqueId, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import {
  createDialogFocusManager,
  registerDialog,
  type DialogRestoreFocus,
} from "./dialog-core"
import "./dialog.css"

export const DIALOG_TITLE_ERROR = "Alpha Dialog requires a non-empty title"

/**
 * alpha-ui Dialog — the canonical modal. The overlay exists only while `open` is true and owns
 * the complete modal stack, focus, keyboard, accessible-name, and dismissal contract.
 */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  title: string
  description?: JSX.Element
  size?: "sm" | "md" | "lg"
  children?: JSX.Element
  footer?: JSX.Element
  /** Reserve the sidebar gutter so the modal centers within the content area. */
  besideSidebar?: boolean
  /** #348:false = busy 期间不可关(背景点击/Esc 无效,关闭按钮隐藏)。IPC 驱动中无取消能力,
   *  放任关闭会造成「用户以为取消了,main 已提交」的竞态。默认 true。 */
  dismissible?: boolean
  /** Processing state is announced independently from whether policy allows dismissal. */
  busy?: boolean
  closeLabel?: string
  /** Stable calling-surface target used when the original trigger no longer accepts focus. */
  restoreFocus?: DialogRestoreFocus
}) {
  const canDismiss = () => props.dismissible !== false
  const title = () => {
    if (!props.open) return undefined
    if (typeof props.title === "string" && props.title.trim()) return props.title
    throw new Error(DIALOG_TITLE_ERROR)
  }
  const titleId = createUniqueId()
  const descriptionId = createUniqueId()
  let root!: HTMLDivElement
  let panel!: HTMLDivElement
  let registration: ReturnType<typeof registerDialog> | undefined

  createEffect(() => {
    if (!props.open) return
    const manager = createDialogFocusManager(panel, document.activeElement, () => props.restoreFocus)
    const current = registerDialog({ root, panel, manager, canDismiss, onClose: () => props.onClose() })
    registration = current
    queueMicrotask(() => {
      if (current.isTop()) manager.focusInitial()
    })
    onCleanup(() => {
      current.unregister()
      if (registration === current) registration = undefined
      queueMicrotask(() => manager.restore())
    })
  })

  const requestClose = () => {
    if (!registration?.isTop() || !canDismiss()) return
    props.onClose()
  }

  return (
    <Show when={title()}>
      {(accessibleTitle) => (
        <Portal>
          <div ref={(element) => (root = element)} class="a-ui a-dialog-root" data-beside-sidebar={props.besideSidebar ? "" : undefined}>
            <div aria-hidden="true" class="a-dialog-backdrop" onClick={requestClose} />
            <div
              ref={(element) => (panel = element)}
              class="a-dialog-panel"
              data-size={props.size ?? "md"}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={props.description ? descriptionId : undefined}
              aria-busy={props.busy ? "true" : undefined}
              tabIndex={-1}
            >
              <span
                class="a-dialog-focus-guard"
                data-dialog-focus-guard="start"
                tabIndex={0}
                onFocus={(event) => registration?.focusGuard(event.currentTarget)}
              />
              <header class="a-dialog-header">
                <div id={titleId} class="a-dialog-title">
                  {accessibleTitle()}
                </div>
                <Show when={canDismiss()}>
                  <button type="button" class="a-dialog-close" aria-label={props.closeLabel ?? "Close"} onClick={requestClose}>
                    ✕
                  </button>
                </Show>
              </header>
              <div class="a-dialog-body">
                <Show when={props.description}>
                  <div id={descriptionId} class="a-dialog-description">
                    {props.description}
                  </div>
                </Show>
                {props.children}
              </div>
              <Show when={props.footer}>
                <footer class="a-dialog-footer">{props.footer}</footer>
              </Show>
              <span
                class="a-dialog-focus-guard"
                data-dialog-focus-guard="end"
                tabIndex={0}
                onFocus={(event) => registration?.focusGuard(event.currentTarget)}
              />
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}
