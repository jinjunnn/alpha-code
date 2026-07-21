import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"
import { useDialogHost } from "../context/dialog"
import { Dynamic } from "solid-js/web"

export interface ImagePreviewProps {
  src: string
  alt?: string
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const host = useDialogHost()
  if (host) {
    return (
      <Dynamic
        component={host.component}
        open={host.open()}
        onClose={host.close}
        title={props.alt ?? i18n.t("ui.imagePreview.alt")}
        size="large"
      >
        <div data-component="image-preview" data-alpha-hosted="">
          <div data-slot="image-preview-body">
            <img src={props.src} alt={props.alt ?? i18n.t("ui.imagePreview.alt")} data-slot="image-preview-image" />
          </div>
        </div>
      </Dynamic>
    )
  }
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body">
            <img src={props.src} alt={props.alt ?? i18n.t("ui.imagePreview.alt")} data-slot="image-preview-image" />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
