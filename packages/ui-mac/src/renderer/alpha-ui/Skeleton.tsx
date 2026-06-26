import { splitProps, type JSX } from "solid-js"
import "./skeleton.css"

/**
 * alpha-ui Skeleton — shimmer placeholder for loading states (account card, sidebar,
 * model list…). Consumes only --a-* tokens. Pass width/height (CSS strings) or circle.
 */
export function Skeleton(
  props: JSX.HTMLAttributes<HTMLDivElement> & {
    width?: string
    height?: string
    radius?: string
    circle?: boolean
  },
) {
  const [local, rest] = splitProps(props, ["width", "height", "radius", "circle", "class", "style"])
  return (
    <div
      {...rest}
      class={`a-skeleton${local.class ? ` ${local.class}` : ""}`}
      data-circle={local.circle ? "" : undefined}
      style={{
        ...(local.width ? { width: local.width } : {}),
        ...(local.height ? { height: local.height } : {}),
        ...(local.radius ? { "border-radius": local.radius } : {}),
      }}
    />
  )
}
