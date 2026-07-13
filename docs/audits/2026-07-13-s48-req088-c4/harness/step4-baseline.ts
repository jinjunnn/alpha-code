import { connect, sidecarInfo, probe, sleep, saveJson } from "./lib"
const setup = JSON.parse(await Bun.file("/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4/00-setup-sessions.json").text())
const cdp = await connect()
const info = await sidecarInfo(cdp)
const click = await cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session-row a")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionA}"))
  if (!a) return false
  a.click(); return true
})()`)
console.log("clicked session A:", click)
await sleep(4500)
const st = await cdp.evalJs(`(() => ({
  frame: !!document.querySelector("[data-alpha-session-spike-frame]"),
  frameHeader: document.querySelector("[data-alpha-session-spike-frame-header]")?.textContent ?? null,
  overlay: document.querySelector("[data-alpha-session-spike-overlay]")?.textContent ?? null,
  timelineRows: document.querySelectorAll("[data-timeline-row]").length,
  composersTotal: document.querySelectorAll("[data-component=session-composer]").length,
  terminalPanels: document.querySelectorAll("#terminal-panel").length,
}))()`)
console.log(JSON.stringify(st, null, 2))
const base = await probe(cdp, info, setup.projA)
console.log("baseline probe:", JSON.stringify({ summary: base.spike.summary, latest: base.spike.latest, pty: base.ptyCount, tcp: base.tcpEstablished }, null, 2))
await saveJson("10-s0-baseline", { state: st, probe: base })
await cdp.shot("10-s0-baseline-session-a")
cdp.close()
