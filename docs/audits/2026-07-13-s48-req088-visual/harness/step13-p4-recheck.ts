// P4 同环境复检(adapter,auth 已还原):关掉/打开闸引起的 provider 面差异排除后,
// 与 legacy 半边同一 native 行数口径对照。结束后闸复位为关(清理态)。
import { connect, sleep, saveJson, pressMeta, P1_EXPR } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
let cdp = await connect()
await cdp.evalJs(`localStorage.setItem("ALPHA_SESSION_SPIKE", "1")`)
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
cdp.close()
cdp = await connect()
await cdp.evalJs(`(() => {
  const row = [...document.querySelectorAll(".alpha-project-row")].find(r => r.textContent?.includes("req088-visual"))
  if (row && !row.closest(".alpha-project")?.hasAttribute("data-expanded")) row.click()
  return !!row
})()`)
await sleep(1500)
await cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionA}"))
  a?.click(); return !!a
})()`)
await sleep(5000)
const ws = await cdp.evalJs(`!!document.querySelector("[data-alpha-session-workspace]")`)
const p1 = await cdp.evalJs(P1_EXPR)
await pressMeta(cdp, "'", "Quote")
await sleep(1500)
const p4 = await cdp.evalJs(`(() => ({
  alphaPicker: !!document.querySelector("[role=dialog] [data-alpha-picker]"),
  rowCount: document.querySelectorAll("[data-slot=list-item][data-key]").length,
  selected: document.querySelector("[data-slot=list-item][data-selected=true]")?.getAttribute("data-key") ?? null,
  homeAnchor: !!document.querySelector("[data-alpha-home-anchor]"),
  popperPositioners: [...document.querySelectorAll("[data-popper-positioner]")].length,
}))()`)
console.log("adapter recheck:", JSON.stringify({ ws, p1, p4 }, null, 2))
await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape" })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
await sleep(800)
await saveJson("44-p4-adapter-recheck-samenv", { ws, p1, p4 })
cdp.close()
