import { splitProps, type JSX } from "solid-js"
import "./button.css"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

/**
 * alpha-ui Button — the canonical action control. Consumes only --a-* tokens.
 * variant: primary (indigo) · secondary (bordered) · ghost (text) · danger.
 */
export function Button(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    size?: ButtonSize
    loading?: boolean
    block?: boolean
  },
) {
  const [local, rest] = splitProps(props, ["variant", "size", "loading", "block", "class", "children"])
  return (
    <button
      {...rest}
      class={`a-btn${local.class ? ` ${local.class}` : ""}`}
      data-variant={local.variant ?? "secondary"}
      data-size={local.size ?? "md"}
      data-loading={local.loading ? "" : undefined}
      data-block={local.block ? "" : undefined}
      disabled={rest.disabled || local.loading}
      aria-busy={local.loading ? "true" : undefined}
    >
      {local.children}
    </button>
  )
}
