import { render } from "solid-js/web"
import { closeChips, PermChip } from "./alpha-composer"

export { render }

export function PermChipHarness() {
  return <PermChip />
}

// combobox(textarea ↔ autocomplete Menu)的无障碍证据**不在这里**:harness 自建的 textarea
// 会复刻一份绑定,生产绑定被删掉它照样绿(C21 R3 F9)。那条断言真实挂载生产
// `AlphaComposerRuntime`,见 test-component 下的组件用例
// 「AlphaComposer 生产 combobox 无障碍绑定」。

export function resetComposerA11yHarness() {
  closeChips()
}
