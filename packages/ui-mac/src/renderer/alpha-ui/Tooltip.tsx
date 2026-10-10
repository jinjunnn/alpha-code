import { createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import "./tooltip.css"

/**
 * alpha-ui Tooltip — the ONLY hover/focus hint in alpha-ui(`#1476`,REQ-230 AC2)。
 *
 * - 悬停**或键盘聚焦** 0.4 秒后出现;离开 / 失焦 / Esc 立即收起。
 * - 反色小签、6px 圆角、无箭头;Portal 到 body + fixed 定位,不会被时间线 / 输入框的
 *   `overflow: hidden` 裁掉。
 * - 只放**补充说明**。解释「为什么不能点」的原因不得藏进这里 —— 那要写成控件旁可见的文字。
 * - 无障碍:说明文字常驻在一个视觉隐藏节点里,并经 `aria-describedby` 挂到触发控件上;
 *   与触发控件的 `aria-label` 相同时不挂(否则读屏会把同一句话念两遍)。
 *
 * 包一个可交互触发控件(第一个元素子节点)。`open` 让调用方临时强制显示(如复制后的「已复制」)。
 */
export const TOOLTIP_DELAY_MS = 400

export function Tooltip(props: {
  label: string
  placement?: "top" | "bottom"
  /** 强制显示(不等延迟),例如复制按钮点完后的确认。 */
  open?: boolean
  children: JSX.Element
}) {
  const id = `a-tip-${createUniqueId()}`
  const [shown, setShown] = createSignal(false)
  const [rect, setRect] = createSignal<DOMRect | undefined>()
  let wrap: HTMLSpanElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const measure = () => wrap && setRect(wrap.getBoundingClientRect())
  const show = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      measure()
      setShown(true)
    }, TOOLTIP_DELAY_MS)
  }
  const hide = () => {
    clearTimeout(timer)
    setShown(false)
  }
  const visible = () => shown() || !!props.open

  const [describes, setDescribes] = createSignal(false)
  onMount(() => {
    const trigger = wrap?.firstElementChild
    if (trigger && trigger.getAttribute("aria-label") !== props.label) {
      const prev = trigger.getAttribute("aria-describedby")
      trigger.setAttribute("aria-describedby", prev ? `${prev} ${id}` : id)
      setDescribes(true)
    }
    window.addEventListener("resize", measure)
  })
  onCleanup(() => {
    clearTimeout(timer)
    window.removeEventListener("resize", measure)
  })

  const style = (): JSX.CSSProperties => {
    const r = rect() ?? wrap?.getBoundingClientRect()
    if (!r) return {}
    const center = Math.round(r.left + r.width / 2)
    const left = `${Math.min(Math.max(8, center), Math.max(8, window.innerWidth - 8))}px`
    return props.placement === "bottom"
      ? { position: "fixed", top: `${Math.round(r.bottom + 6)}px`, left }
      : { position: "fixed", bottom: `${Math.round(window.innerHeight - r.top + 6)}px`, left }
  }

  return (
    <span
      ref={wrap}
      class="a-tip-wrap"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusIn={show}
      onFocusOut={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape" && visible()) hide()
      }}
    >
      {props.children}
      <Show when={describes()}>
        <span id={id} class="a-tip-desc">
          {props.label}
        </span>
      </Show>
      <Show when={visible()}>
        <Portal>
          <span class="a-ui a-tip" role="tooltip" data-placement={props.placement ?? "top"} style={style()}>
            {props.label}
          </span>
        </Portal>
      </Show>
    </span>
  )
}
