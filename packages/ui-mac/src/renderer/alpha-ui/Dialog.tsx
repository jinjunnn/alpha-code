import { Show, type JSX, createEffect, createUniqueId, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { createDialogFocusManager } from "./dialog-core"
import "./dialog.css"

/**
 * alpha-ui Dialog — the canonical modal. The foundation for every alpha-owned dialog
 * (settings, model picker, etc.). Bug-proof by construction: the overlay only exists in the
 * DOM while `open` is true (mounted inside <Show> + <Portal>), so a closed dialog can NEVER
 * intercept clicks — the class of bug that broke the Extension Hub. Owns the complete modal focus,
 * keyboard, accessible-name, and dismissal contract without domain-specific behavior.
 */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  title: JSX.Element
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
}) {
  const canDismiss = () => props.dismissible !== false
  const titleId = createUniqueId()
  const descriptionId = createUniqueId()
  let panel!: HTMLDivElement
  let focusManager: ReturnType<typeof createDialogFocusManager> | undefined

  createEffect(() => {
    if (!props.open) return
    const manager = createDialogFocusManager(panel, document.activeElement)
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.target && panel.contains(event.target as Node)) return
      manager.handleKeyDown(event, canDismiss(), props.onClose)
    }
    focusManager = manager
    document.addEventListener("keydown", onDocumentKeyDown, true)
    queueMicrotask(() => manager.focusInitial())
    onCleanup(() => {
      document.removeEventListener("keydown", onDocumentKeyDown, true)
      if (focusManager === manager) focusManager = undefined
      queueMicrotask(() => manager.restore())
    })
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div class="a-ui a-dialog-root" data-beside-sidebar={props.besideSidebar ? "" : undefined}>
          <div aria-hidden="true" class="a-dialog-backdrop" onClick={() => canDismiss() && props.onClose()} />
          <div
            ref={panel}
            class="a-dialog-panel"
            data-size={props.size ?? "md"}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={props.description ? descriptionId : undefined}
            aria-busy={props.busy ? "true" : undefined}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => focusManager?.handleKeyDown(event, canDismiss(), props.onClose)}
          >
            <header class="a-dialog-header">
              <div id={titleId} class="a-dialog-title">
                {props.title}
              </div>
              <Show when={canDismiss()}>
                <button type="button" class="a-dialog-close" aria-label={props.closeLabel ?? "Close"} onClick={() => props.onClose()}>
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
          </div>
        </div>
      </Portal>
    </Show>
  )
}
