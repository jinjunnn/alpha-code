import { render } from "solid-js/web"
import { closeChips, PermChip } from "./alpha-composer"
import { claimOverlay, resetOverlayRegistry } from "./overlay-menu"
import { dismissToast, pushToast, ToastViewport } from "./Toast"
import { Tooltip } from "./Tooltip"
import { CopyButton } from "./CopyButton"

export { render, claimOverlay, pushToast, dismissToast }

export function PermChipHarness() {
  return <PermChip />
}

/** REQ-230 AC3:真实的通知视口(Portal 到 body)。 */
export function ToastHarness() {
  return <ToastViewport />
}

/** REQ-230 AC2:一个原生可聚焦的触发器 + 一个需要补 tabindex 的 span 触发器。 */
export function TooltipHarness() {
  return (
    <div>
      <Tooltip label="发送">
        <button type="button" class="tip-button" aria-label="发送">
          ↑
        </button>
      </Tooltip>
      <Tooltip label="缓存命中 75%" focusable>
        <span class="tip-span">高</span>
      </Tooltip>
    </div>
  )
}

export function CopyButtonHarness(props: { text: string }) {
  return <CopyButton label="复制消息" text={() => props.text} />
}

// combobox(textarea ↔ autocomplete Menu)的无障碍证据**不在这里**:harness 自建的 textarea
// 会复刻一份绑定,生产绑定被删掉它照样绿(C21 R3 F9)。那条断言真实挂载生产
// `AlphaComposerRuntime`,见 test-component 下的组件用例
// 「AlphaComposer 生产 combobox 无障碍绑定」。

export function resetComposerA11yHarness() {
  closeChips()
  resetOverlayRegistry()
}
