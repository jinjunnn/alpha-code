// opencode's native settings dialog has NO close/back control. Once we render it full-window the
// user would be trapped — so inject a "← 返回应用" button at the top of its nav. Clicking it
// dispatches Escape, which (verified) closes the settings dialog. A MutationObserver re-injects on
// every open. Styling lives in settings-reskin.css (.alpha-settings-back).

function escClose(): void {
  const ev = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true } as KeyboardEventInit)
  document.dispatchEvent(ev())
  window.dispatchEvent(ev())
  ;(document.activeElement as HTMLElement | null)?.dispatchEvent(ev())
}

function inject(): void {
  const dlg = document.querySelector<HTMLElement>(".settings-v2-dialog")
  if (!dlg || dlg.querySelector(".alpha-settings-back")) return
  const nav = dlg.querySelector<HTMLElement>('[data-slot="tabs-v2-list"]') ?? dlg
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "alpha-settings-back"
  const arrow = document.createElement("span")
  arrow.className = "alpha-settings-back-arrow"
  arrow.setAttribute("aria-hidden", "true")
  arrow.textContent = "←"
  const label = document.createElement("span")
  label.textContent = "返回应用"
  btn.append(arrow, label)
  btn.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    escClose()
  })
  nav.insertBefore(btn, nav.firstChild)
}

export function setupSettingsBackButton(): void {
  const observer = new MutationObserver(() => inject())
  observer.observe(document.body, { childList: true, subtree: true })
  inject()
}
