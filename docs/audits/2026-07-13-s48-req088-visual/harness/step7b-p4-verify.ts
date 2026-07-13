// P4 补验:上游 dialog 在点选后自关(41-p4-after-pick),重开核验 data-selected 已移动到
// scripted:scripted-1(model.set 真走到)。
import { connect, sleep, saveJson, pressMeta } from "./lib"
const cdp = await connect()
await pressMeta(cdp, "'", "Quote")
await sleep(1500)
const st = await cdp.evalJs(`(() => ({
  alphaPicker: !!document.querySelector("[role=dialog] [data-alpha-picker]"),
  rows: [...document.querySelectorAll("[data-slot=list-item][data-key]")].map(r => ({ key: r.getAttribute("data-key"), selected: r.getAttribute("data-selected") })),
  homeAnchor: !!document.querySelector("[data-alpha-home-anchor]"),
}))()`)
console.log(JSON.stringify(st, null, 2))
await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape" })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
await sleep(600)
const closed = await cdp.evalJs(`!document.querySelector("[role=dialog] [data-alpha-picker]")`)
console.log("closed:", closed)
await saveJson("42-p4-selection-verify", { reopened: st, closed })
cdp.close()
