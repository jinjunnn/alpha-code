import { type JSX } from "solid-js"
import "./tooltip.css"

/**
 * alpha-ui Tooltip — CSS-only hover/focus label. Wrap a single interactive trigger;
 * the label appears on hover or keyboard focus. Consumes only --a-* tokens.
 */
export function Tooltip(props: {
  label: string
  placement?: "top" | "bottom" | "left" | "right"
  children: JSX.Element
}) {
  return (
    <span class="a-tip-wrap">
      {props.children}
      <span class="a-tip" role="tooltip" data-placement={props.placement ?? "top"}>
        {props.label}
      </span>
    </span>
  )
}
