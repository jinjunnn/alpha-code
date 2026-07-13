// P4(T6 §5):ModelPickerInject 生效 —— 会话内 mod+' 开 native picker,alpha 覆盖层在位、
// native 行仍在且被盖、经 alpha 行点选未锁模型 → 上游 model.set 真走到(data-selected 变化)。
// O1 取证:data-alpha-home-anchor 存在性 + 弹层位置截图(会话内 alpha composer 渲染 .a-chip-model,
// 锚定分支是否命中、位置是否合理)。
import { connect, sleep, saveJson, pressMeta } from "./lib"
const cdp = await connect()

await pressMeta(cdp, "'", "Quote")
await sleep(1500)
const state1 = await cdp.evalJs(`(() => {
  const dlg = document.querySelector("[role=dialog]")
  const alphaPicker = !!document.querySelector("[role=dialog] [data-alpha-picker]")
  const rows = [...document.querySelectorAll("[data-slot=list-item][data-key]")]
  const positioner = document.querySelector("[data-popper-positioner]")
  const anchor = !!document.querySelector("[data-alpha-home-anchor]")
  const chip = [...document.querySelectorAll(".a-chip-model")].find(c => c.offsetParent !== null)
  const pickerEl = document.querySelector("[data-alpha-picker]")
  return {
    dialog: !!dlg,
    alphaPicker,
    nativeRows: rows.map(r => ({ key: r.getAttribute("data-key"), selected: r.getAttribute("data-selected") })),
    nativeRowCount: rows.length,
    nativeListVisible: rows.length ? rows.some(r => r.offsetParent !== null && r.getBoundingClientRect().width > 0) : null,
    homeAnchor: anchor,
    anchorTf: positioner ? getComputedStyle(positioner).getPropertyValue("--a-pick-tf") : null,
    pickerRect: pickerEl ? pickerEl.getBoundingClientRect().toJSON() : null,
    chipRect: chip ? chip.getBoundingClientRect().toJSON() : null,
  }
})()`)
console.log("picker open:", JSON.stringify(state1, null, 2))
await cdp.shot("40-p4-native-picker-o1")

// 经 alpha 覆盖层点选一个未锁、且非当前选中的模型行
const pickResult = await cdp.evalJs(`(() => {
  const selectedBefore = document.querySelector("[data-slot=list-item][data-selected=true]")?.getAttribute("data-key") ?? null
  const rows = [...document.querySelectorAll(".a-mp2-row")]
  const target = rows.find(r => !r.className.includes("locked") && !r.className.includes("sel"))
  if (!target) return { ok: false, selectedBefore, rows: rows.map(r => ({ cls: r.className, txt: r.textContent?.slice(0, 40) })) }
  const label = target.textContent?.slice(0, 60)
  target.click()
  return { ok: true, selectedBefore, clicked: label }
})()`)
console.log("pick via alpha row:", JSON.stringify(pickResult, null, 2))
await sleep(1500)
const state2 = await cdp.evalJs(`(() => ({
  selectedAfter: document.querySelector("[data-slot=list-item][data-selected=true]")?.getAttribute("data-key") ?? null,
  dialogStillOpen: !!document.querySelector("[role=dialog] [data-alpha-picker]"),
}))()`)
console.log("after pick:", JSON.stringify(state2))
await cdp.shot("41-p4-after-pick")
// 关闭弹层(Escape)
await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape" })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
await sleep(800)
const closed = await cdp.evalJs(`!document.querySelector("[role=dialog] [data-alpha-picker]")`)
console.log("picker closed:", closed)
await saveJson("40-p4-adapter", { open: state1, pick: pickResult, after: state2, closed })
cdp.close()
