import { connect, sidecarInfo, probe, sleep, saveJson } from "./lib"
const setup = JSON.parse(await Bun.file("/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4/00-setup-sessions.json").text())
const cdp = await connect()
const info = await sidecarInfo(cdp)
const before = await probe(cdp, info, setup.projA)
const beforeCount = before.spike.count
console.log("S2 before:", JSON.stringify({ summary: before.spike.summary, pty: before.ptyCount, tcp: before.tcpEstablished, samples: beforeCount }))

const nav = async (idx: number) => {
  const r = await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll(".alpha-topbar .alpha-topbar-btn")]
    const b = btns[${idx}]
    if (!b) return { ok: false, n: btns.length }
    b.click(); return { ok: true, label: b.getAttribute("aria-label") }
  })()`)
  return r
}
for (let i = 0; i < 3; i++) { console.log("back:", JSON.stringify(await nav(1))); await sleep(600) }
await sleep(1000)
const mid = await cdp.evalJs(`(() => { const s = window.__req087Spike.samples(); return s[s.length-1].pathname })()`)
console.log("path after back x3:", mid.slice(0, 40))
await cdp.shot("30-s2-after-back-x3")
for (let i = 0; i < 3; i++) { console.log("fwd:", JSON.stringify(await nav(2))); await sleep(600) }
await sleep(2500)
const after = await probe(cdp, info, setup.projA)
console.log("S2 after:", JSON.stringify({ summary: after.spike.summary, pty: after.ptyCount, tcp: after.tcpEstablished, samples: after.spike.count }))
const samples = await cdp.evalJs(`window.__req087Spike.samples()`)
await saveJson("30-s2-back-forward", { before: { summary: before.spike.summary, pty: before.ptyCount, tcp: before.tcpEstablished, sampleCount: beforeCount }, after: { summary: after.spike.summary, pty: after.ptyCount, tcp: after.tcpEstablished, sampleCount: after.spike.count }, samples })
await cdp.shot("31-s2-after-forward-x3")
for (const s of samples.slice(beforeCount)) console.log("  ", JSON.stringify({ path: s.pathname.slice(-46), sid: s.sessionID?.slice(-8), panels: s.terminalPanels, cmd: s.commandOptions, cvis: s.composersVisible, ctot: s.composersTotal }))
cdp.close()
