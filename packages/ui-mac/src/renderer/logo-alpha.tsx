import { type ComponentProps } from "solid-js"
import { BRAND } from "./brand"

// alpha-code's own splash mark: the Greek α from the app icon, in brand orange.
// Drop-in API match for @opencode-ai/ui/logo (same Splash/Mark signatures and
// viewBoxes) so it slots straight into renderer/index.tsx without layout changes.
// (opencode's app-internal splash — health-check / connection-error — still
// renders the upstream block logo; that lives inside @opencode-ai/app and is
// intentionally left untouched per the "only-add, never edit upstream" rule.)

const ALPHA_FONT = `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif`

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="alpha-splash-grad" x1="40" y1="14" x2="40" y2="86" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color={BRAND.orangeLight} />
          <stop offset="1" stop-color={BRAND.orangeDeep} />
        </linearGradient>
      </defs>
      <text
        x="40"
        y="52"
        text-anchor="middle"
        dominant-baseline="central"
        font-family={ALPHA_FONT}
        font-style="italic"
        font-size="88"
        fill="url(#alpha-splash-grad)"
      >
        α
      </text>
    </svg>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="8"
        y="10.5"
        text-anchor="middle"
        dominant-baseline="central"
        font-family={ALPHA_FONT}
        font-style="italic"
        font-size="17"
        fill={BRAND.orange}
      >
        α
      </text>
    </svg>
  )
}
