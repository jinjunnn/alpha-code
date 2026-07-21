import { Dialog } from "@opencode-ai/ui/dialog"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { UpstreamDialogHost } from "./UpstreamDialogHost"

function Consumer() {
  const dialog = useDialog()
  return (
    <button
      type="button"
      data-test-open-dialog
      onClick={() =>
        dialog.show(
          () => (
            <Dialog title="Delete session">
              <button type="button">Confirm</button>
            </Dialog>
          ),
          undefined,
          { host: true },
        )
      }
    >
      Open
    </button>
  )
}

export function UpstreamDialogHarness() {
  return (
    <DialogProvider host={UpstreamDialogHost}>
      <Consumer />
    </DialogProvider>
  )
}

export { createComponent } from "solid-js"
export { render } from "solid-js/web"
