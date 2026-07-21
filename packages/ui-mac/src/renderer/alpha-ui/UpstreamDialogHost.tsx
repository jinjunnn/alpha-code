import type { DialogHostProps } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "./Dialog"
import "./upstream-dialog-host.css"

/** Selected upstream consumers render inside the one canonical Alpha Dialog mount. */
export function UpstreamDialogHost(props: DialogHostProps) {
  const title = () => (typeof props.title === "string" && props.title.trim() ? props.title : "Dialog")
  const size = () => (props.size === "large" || props.size === "x-large" ? "lg" : "md")
  const classes = () =>
    [
      "a-upstream-dialog-body",
      props.class,
      ...Object.entries(props.classList ?? {})
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
    ]
      .filter(Boolean)
      .join(" ")

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={title()}
      description={props.description}
      size={size()}
      besideSidebar
    >
      <div class={classes()} data-alpha-upstream-dialog-body="">
        {props.action}
        {props.children}
      </div>
    </Dialog>
  )
}
