// O1 深挖:data-alpha-home-anchor 打在哪个节点、--a-pick-tf 是否生效、弹层实际位置 vs 期望
// (期望 = 钉在可见 .a-chip-model 上方 8px;model-picker-inject.tsx:163-178)。
import { connect, sleep, saveJson, pressMeta } from "./lib"
const cdp = await connect()
await pressMeta(cdp, "'", "Quote")
await sleep(1500)
const st = await cdp.evalJs(`(() => {
  const anchored = document.querySelector("[data-alpha-home-anchor]")
  const dlg = document.querySelector("[role=dialog]")
  const picker = document.querySelector("[data-alpha-picker]")
  const chip = [...document.querySelectorAll(".a-chip-model")].filter(c => c.offsetParent !== null).map(c => c.getBoundingClientRect().toJSON())
  const info = (el) => el ? {
    tag: el.tagName, comp: el.getAttribute("data-component") ?? undefined,
    isPopper: el.hasAttribute("data-popper-positioner"),
    rect: el.getBoundingClientRect().toJSON(),
    styleTf: el.style?.transform ?? null,
    varTf: el.style?.getPropertyValue?.("--a-pick-tf") || null,
    computedTf: getComputedStyle(el).transform,
  } : null
  return {
    anchored: info(anchored),
    anchoredIsDlgParent: anchored === dlg?.parentElement,
    dlgParent: info(dlg?.parentElement ?? null),
    popperPositioners: [...document.querySelectorAll("[data-popper-positioner]")].length,
    pickerRect: picker?.getBoundingClientRect().toJSON() ?? null,
    dlgRect: dlg?.getBoundingClientRect().toJSON() ?? null,
    visibleChips: chip,
    innerH: window.innerHeight,
  }
})()`)
console.log(JSON.stringify(st, null, 2))
await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape" })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
await sleep(500)
await saveJson("43-o1-anchor-forensics", st)
cdp.close()
