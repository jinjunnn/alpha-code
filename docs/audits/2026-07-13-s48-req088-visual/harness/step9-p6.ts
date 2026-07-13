// P6(仅 adapter):A↔B 快切 ×3 + reload 后重跑 P1;__req087Spike.summary() violations
// 不随操作增长(pendingSamples 新口径:pending 不计违规/不进累积)。
import { connect, sleep, saveJson, P1_EXPR, PROBE_EXPR } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
let cdp = await connect()

const go = (id: string) =>
  cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${"$"}{id}"))
  if (!a) return false
  a.click(); return true
})()`.replace("${id}", id))

const before = await cdp.evalJs(PROBE_EXPR)
console.log("probe before:", JSON.stringify(before.summary))

// A↔B 快切 ×3(6 次点击,~400ms 间隔),终点回 A
for (let i = 0; i < 6; i++) {
  const target = i % 2 === 0 ? setup.sessionB : setup.sessionA
  const ok = await go(target)
  if (!ok) console.log(`switch ${i} LINK NOT FOUND`)
  await sleep(400)
}
await go(setup.sessionA)
await sleep(3000)
const afterSwitch = await cdp.evalJs(PROBE_EXPR)
const p1AfterSwitch = await cdp.evalJs(P1_EXPR)
console.log("after fast-switch:", JSON.stringify(afterSwitch.summary), JSON.stringify(p1AfterSwitch))
await cdp.shot("60-p6-after-fastswitch")

// reload(渲染器重载;fresh probe window)
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(8000)
cdp.close()
cdp = await connect()
// reload 后回到 home(MemoryRouter),经侧栏重新进 A(先展开项目)
await cdp.evalJs(`(() => {
  const row = [...document.querySelectorAll(".alpha-project-row")].find(r => r.textContent?.includes("req088-visual"))
  row?.click(); return !!row
})()`)
await sleep(1500)
const back = await go(setup.sessionA)
console.log("re-entered A after reload:", back)
await sleep(5000)
const p1AfterReload = await cdp.evalJs(P1_EXPR)
const probeAfterReload = await cdp.evalJs(PROBE_EXPR)
console.log("P1 after reload:", JSON.stringify(p1AfterReload))
console.log("probe after reload:", JSON.stringify(probeAfterReload.summary))
const p1ok = (p: any) => p.takeoverFlag && p.visibleHosts === 1 && p.upstreamComposerDisplay === "none" && p.alphaComposerInHost
const verdict = {
  switchDeltaViolations: afterSwitch.summary.singleMountViolations - before.summary.singleMountViolations,
  switchAccFlags: { cmd: afterSwitch.summary.commandAccumulation, panel: afterSwitch.summary.terminalPanelAccumulation },
  p1AfterSwitchPass: p1ok(p1AfterSwitch),
  p1AfterReloadPass: p1ok(p1AfterReload),
  reloadWindowSummary: probeAfterReload.summary,
}
console.log("P6 verdict:", JSON.stringify(verdict, null, 2))
await saveJson("60-p6-stability", { before: before.summary, afterSwitch: afterSwitch.summary, p1AfterSwitch, p1AfterReload, probeAfterReload: probeAfterReload.summary, verdict })
await cdp.shot("61-p6-after-reload")
cdp.close()
