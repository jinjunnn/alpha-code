import { Show, type JSX, createEffect, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import "./dialog.css"

/**
 * alpha-ui Dialog — the canonical modal. The foundation for every alpha-owned dialog
 * (settings, model picker, etc.). Bug-proof by construction: the overlay only exists in the
 * DOM while `open` is true (mounted inside <Show> + <Portal>), so a closed dialog can NEVER
 * intercept clicks — the class of bug that broke the Extension Hub. Backdrop click + Escape close.
 */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  title?: JSX.Element
  size?: "sm" | "md" | "lg"
  children: JSX.Element
  footer?: JSX.Element
  /** Reserve the sidebar gutter so the modal centers within the content area. */
  besideSidebar?: boolean
  /** #348:false = busy 期间不可关(背景点击/Esc 无效,关闭按钮隐藏)。IPC 驱动中无取消能力,
   *  放任关闭会造成「用户以为取消了,main 已提交」的竞态。默认 true。 */
  dismissible?: boolean
}) {
  const canDismiss = () => props.dismissible !== false
  createEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && canDismiss()) props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div class="a-ui a-dialog-root" data-beside-sidebar={props.besideSidebar ? "" : undefined}>
          <div class="a-dialog-backdrop" onClick={() => canDismiss() && props.onClose()} />
          <div
            class="a-dialog-panel"
            data-size={props.size ?? "md"}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={props.title}>
              <header class="a-dialog-header">
                <div class="a-dialog-title">{props.title}</div>
                <Show when={canDismiss()}>
                  <button class="a-dialog-close" aria-label="Close" onClick={() => props.onClose()}>
                    ✕
                  </button>
                </Show>
              </header>
            </Show>
            <div class="a-dialog-body">{props.children}</div>
            <Show when={props.footer}>
              <footer class="a-dialog-footer">{props.footer}</footer>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
