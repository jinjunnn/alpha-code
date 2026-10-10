import { children as resolveChildren, createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import "./tooltip.css"

/**
 * alpha-ui Tooltip — the ONLY hover/focus hint in alpha-ui(`#1476`,REQ-230 AC2)。
 *
 * - 悬停**或键盘聚焦** 0.4 秒后出现;离开 / 失焦 / Esc 立即收起。
 * - 反色小签、6px 圆角、无箭头;Portal 到 body + fixed 定位,不会被时间线 / 输入框的
 *   `overflow: hidden` 裁掉。
 * - 只放**补充说明**。解释「为什么不能点」的原因不得藏进这里 —— 那要写成控件旁可见的文字。
 * - 无障碍:说明文字放在一个视觉隐藏节点里,经 `aria-describedby` 挂到触发控件上;
 *   与触发控件的 `aria-label` 相同时不挂(否则读屏会把同一句话念两遍)。
 *
 * 不包外壳元素:监听直接挂在唯一的子元素(触发控件)上,DOM 结构与不加提示时完全一致
 * (`[data-kind] > button` 这类结构选择器、flex 布局都不受影响)。
 * `open` 让调用方临时强制显示(如复制后的「已复制」)。
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
  const resolved = resolveChildren(() => props.children)
  const [shown, setShown] = createSignal(false)
  const [rect, setRect] = createSignal<DOMRect | undefined>()
  const [describes, setDescribes] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const trigger = () => {
    const node = resolved.toArray().find((item) => item instanceof Element)
    return node instanceof Element ? node : undefined
  }
  const measure = () => {
    const el = trigger()
    if (el) setRect(el.getBoundingClientRect())
  }
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
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") hide()
  }
  const visible = () => shown() || !!props.open

  onMount(() => {
    const el = trigger()
    if (!el) return
    el.addEventListener("pointerenter", show)
    el.addEventListener("pointerleave", hide)
    el.addEventListener("focusin", show)
    el.addEventListener("focusout", hide)
    el.addEventListener("keydown", onKey)
    if (el.getAttribute("aria-label") !== props.label) {
      const prev = el.getAttribute("aria-describedby")
      el.setAttribute("aria-describedby", prev ? `${prev} ${id}` : id)
      setDescribes(true)
    }
    window.addEventListener("resize", measure)
    onCleanup(() => {
      el.removeEventListener("pointerenter", show)
      el.removeEventListener("pointerleave", hide)
      el.removeEventListener("focusin", show)
      el.removeEventListener("focusout", hide)
      el.removeEventListener("keydown", onKey)
    })
  })
  onCleanup(() => {
    clearTimeout(timer)
    window.removeEventListener("resize", measure)
  })

  const style = (): JSX.CSSProperties => {
    const r = rect() ?? trigger()?.getBoundingClientRect()
    if (!r) return {}
    const center = Math.round(r.left + r.width / 2)
    const left = `${Math.min(Math.max(8, center), Math.max(8, window.innerWidth - 8))}px`
    return props.placement === "bottom"
      ? { position: "fixed", top: `${Math.round(r.bottom + 6)}px`, left }
      : { position: "fixed", bottom: `${Math.round(window.innerHeight - r.top + 6)}px`, left }
  }

  return (
    <>
      {resolved()}
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
    </>
  )
}
