import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { ChipPopover, closeChips, PermChip } from "./alpha-composer"
import { AddProvider } from "./model-picker-add"
import { claimOverlay, overlayOwner, releaseOverlay } from "./overlay-stack"
import { CopyButton } from "./CopyButton"
import { dismissToast, pushToast, ToastViewport, TOAST_DEFAULT_MS } from "./Toast"
import { Tooltip, TOOLTIP_DELAY_MS } from "./Tooltip"
import { COPIED_FEEDBACK_MS } from "./CopyButton"

export { render }
export { claimOverlay, overlayOwner, releaseOverlay }
export { dismissToast, pushToast, TOAST_DEFAULT_MS, TOOLTIP_DELAY_MS, COPIED_FEEDBACK_MS }

export function PermChipHarness() {
  return <PermChip />
}

/** 两个芯片并排:验证「同时只开一个」。 */
export function TwoChipsHarness() {
  return (
    <>
      <span data-chip="a">
        <PermChip />
      </span>
      <span data-chip="b">
        <PermChip />
      </span>
    </>
  )
}

/** 菜单容器里装二级页(添加供应商):验证 Esc 先退一级。 */
export function SubPageHarness(props: { onClosed: () => void }) {
  const [open, setOpen] = createSignal(true)
  const [sub, setSub] = createSignal(true)
  let anchor: HTMLButtonElement | undefined
  return (
    <>
      <button ref={anchor} data-anchor="sub" onClick={() => setOpen(true)}>
        open
      </button>
      <Show when={open() && anchor}>
        <ChipPopover anchor={anchor} onEscape={() => (setOpen(false), props.onClosed())}>
          <button class="a-pop-item" data-row="list">
            row
          </button>
          <Show when={sub()}>
            <AddProvider catalog={null} onClose={() => setSub(false)} />
          </Show>
        </ChipPopover>
      </Show>
    </>
  )
}

export function ToastHarness() {
  return <ToastViewport />
}

export function TooltipHarness() {
  return (
    <Tooltip label="缓存命中 82%">
      <button type="button" data-tip-trigger>
        高
      </button>
    </Tooltip>
  )
}

export function CopyButtonHarness(props: { text: string }) {
  return <CopyButton label="复制回复" text={() => props.text} />
}

// combobox(textarea ↔ autocomplete Menu)的无障碍证据**不在这里**:harness 自建的 textarea
// 会复刻一份绑定,生产绑定被删掉它照样绿(C21 R3 F9)。那条断言真实挂载生产
// `AlphaComposerRuntime`,见 test-component 下的组件用例
// 「AlphaComposer 生产 combobox 无障碍绑定」。

export function resetComposerA11yHarness() {
  closeChips()
  const owner = overlayOwner()
  if (owner) releaseOverlay(owner)
}
