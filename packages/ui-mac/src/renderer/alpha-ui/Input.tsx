import { splitProps, Show, type JSX } from "solid-js"
import "./input.css"

/**
 * alpha-ui Input — the canonical single-line field. Optional leading icon slot (for search etc.).
 * Consumes only --a-* tokens. Wrap reasons: consistent height/radius/focus-ring everywhere.
 */
export function Input(
  props: JSX.InputHTMLAttributes<HTMLInputElement> & {
    size?: "sm" | "md"
    icon?: JSX.Element
    block?: boolean
  },
) {
  const [local, rest] = splitProps(props, ["size", "icon", "block", "class"])
  return (
    <div
      class={`a-field${local.class ? ` ${local.class}` : ""}`}
      data-size={local.size ?? "md"}
      data-block={local.block ? "" : undefined}
      data-has-icon={local.icon ? "" : undefined}
    >
      <Show when={local.icon}>
        <span class="a-field-icon" aria-hidden="true">
          {local.icon}
        </span>
      </Show>
      <input {...rest} class="a-field-input" />
    </div>
  )
}
