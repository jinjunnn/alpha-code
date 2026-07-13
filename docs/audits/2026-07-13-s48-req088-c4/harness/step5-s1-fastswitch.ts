import { connect, sidecarInfo, probe, sleep, saveJson } from "./lib"
const setup = JSON.parse(await Bun.file("/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4/00-setup-sessions.json").text())
const cdp = await connect()
const info = await sidecarInfo(cdp)

// open the terminal in session A via the alpha topbar terminal toggle (real UI; triggers terminal.toggle)
const term = await cdp.evalJs(`(() => {
  const btn = [...document.querySelectorAll(".alpha-topbar-right .alpha-topbar-btn")][0]
  if (!btn) return false
  btn.click(); return true
})()`)
console.log("terminal toggle clicked:", term)
await sleep(2500)
const termState = await cdp.evalJs(`(() => ({
  panel: document.querySelectorAll("#terminal-panel").length,
  xterm: document.querySelectorAll("#terminal-panel .xterm, #terminal-panel canvas").length,
}))()`)
console.log("terminal state:", JSON.stringify(termState))
const before = await probe(cdp, info, setup.projA)
console.log("S1 before:", JSON.stringify({ summary: before.spike.summary, pty: before.ptyCount, tcp: before.tcpEstablished }))
await cdp.shot("20-s1-terminal-open-before")

const clickSession = (id: string) => cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session-row a")].find(l => l.getAttribute("href")?.endsWith("${id}"))
  if (!a) return false
  a.click(); return true
})()`.replace("${id}", id))

// fast switch A->B->A->B->A->B->A (6 switches, ends on A), ~350ms apart
for (let i = 0; i < 6; i++) {
  const target = i % 2 === 0 ? setup.sessionB : setup.sessionA
  const ok = await clickSession(target)
  if (!ok) console.log(`  switch ${i} -> ${target.slice(-8)}: LINK NOT FOUND`)
  await sleep(350)
}
// land back on A explicitly, settle
await clickSession(setup.sessionA)
await sleep(3000)

const after = await probe(cdp, info, setup.projA)
console.log("S1 after:", JSON.stringify({ summary: after.spike.summary, pty: after.ptyCount, tcp: after.tcpEstablished }))
const samples = await cdp.evalJs(`window.__req087Spike.samples()`)
await saveJson("20-s1-fast-switch", { before: { summary: before.spike.summary, pty: before.ptyCount, ptys: before.ptys, tcp: before.tcpEstablished }, after: { summary: after.spike.summary, pty: after.ptyCount, ptys: after.ptys, tcp: after.tcpEstablished }, samples })
await cdp.shot("21-s1-after-fast-switch")
cdp.close()
