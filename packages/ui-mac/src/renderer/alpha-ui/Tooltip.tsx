import { children as resolveChildren, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import "./tooltip.css"

/**
 * alpha-ui Tooltip —— 时间线与输入框一带唯一的悬停提示(REQ-230 AC2,#1476)。
 *
 * 取代浏览器原生 `title=`:原生提示键盘用户永远看不到,慢一点的鼠标也常常等不到。规则:
 * - 悬停**或键盘聚焦** 0.4 秒后出现;移开 / 失焦 / 按下鼠标 / Esc 即收。
 * - 反色小签、6px 圆角、不带箭头;Portal 到 body、fixed 定位,不会被时间线的 overflow 裁掉。
 * - 只放**补充说明**。解释「为什么不能点」的一律写成控件旁可见文字,不藏进提示。
 *
 * 包一个可交互的触发元素(第一个子元素)。读屏经 `aria-describedby` 读到同一段文字 —— 描述节点常驻
 * DOM(视觉隐藏、绝对定位、不占排版),不依赖浮签是否正在显示。触发元素本身不可聚焦时传
 * `focusable`,补上 tabindex=0。**不加包裹元素**:触发元素仍是原父节点的直接子元素,
 * 既有的 `父 > button` 选择器与 flex 排版都不受影响。
 */
export const TOOLTIP_DELAY_MS = 400

let tipSeq = 0

export function Tooltip(props: {
  label: string
  placement?: "top" | "bottom"
  /** 触发元素原生不可聚焦(span 等)时补 tabindex=0,保证键盘可达。 */
  focusable?: boolean
  /** 外部强制显示(例如复制后的「已复制」反馈),不等 0.4 秒。 */
  forceOpen?: () => boolean
  children: JSX.Element
}) {
  const id = `a-tip-${++tipSeq}`
  const [hovered, setHovered] = createSignal(false)
  const [rect, setRect] = createSignal<DOMRect | null>(null)
  const resolved = resolveChildren(() => props.children)
  let trigger: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const measure = () => {
    if (trigger?.isConnected) setRect(trigger.getBoundingClientRect())
  }
  const show = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      measure()
      setHovered(true)
    }, TOOLTIP_DELAY_MS)
  }
  const hide = () => {
    clearTimeout(timer)
    setHovered(false)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") hide()
  }
  const open = () => !!props.label && (hovered() || !!props.forceOpen?.())

  onMount(() => {
    trigger = (resolved.toArray().find((node) => node instanceof HTMLElement) as HTMLElement | undefined) ?? null
    if (!trigger) return
    const describedBy = trigger.getAttribute("aria-describedby")
    trigger.setAttribute("aria-describedby", describedBy ? `${describedBy} ${id}` : id)
    if (props.focusable && trigger.tabIndex < 0) trigger.tabIndex = 0
    trigger.addEventListener("pointerenter", show)
    trigger.addEventListener("pointerleave", hide)
    trigger.addEventListener("pointerdown", hide)
    trigger.addEventListener("focus", show)
    trigger.addEventListener("blur", hide)
    trigger.addEventListener("keydown", onKey)
  })
  onCleanup(() => {
    clearTimeout(timer)
    if (!trigger) return
    trigger.removeEventListener("pointerenter", show)
    trigger.removeEventListener("pointerleave", hide)
    trigger.removeEventListener("pointerdown", hide)
    trigger.removeEventListener("focus", show)
    trigger.removeEventListener("blur", hide)
    trigger.removeEventListener("keydown", onKey)
  })

  const style = (): JSX.CSSProperties => {
    // 强制显示时没走 show() 的测量,这里直接读一次(不写回 signal,避免读写自激)。
    const r = !hovered() && props.forceOpen?.() && trigger?.isConnected ? trigger.getBoundingClientRect() : rect()
    if (!r) return { visibility: "hidden" }
    const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 8), window.innerWidth - 8))
    return props.placement === "bottom"
      ? { left: `${x}px`, top: `${Math.round(r.bottom + 6)}px` }
      : { left: `${x}px`, bottom: `${Math.round(window.innerHeight - r.top + 6)}px` }
  }

  return (
    <>
      {resolved()}
      <span id={id} class="a-tip-desc" role="tooltip">
        {props.label}
      </span>
      <Show when={open()}>
        <Portal>
          <span class="a-ui a-tip" aria-hidden="true" data-placement={props.placement ?? "top"} style={style()}>
            {props.label}
          </span>
        </Portal>
      </Show>
    </>
  )
}
