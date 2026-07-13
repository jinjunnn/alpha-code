import { connect, sidecarInfo, engineApi, probe, sleep, saveJson } from "./lib"
const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"
const setup = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
const PROJ_B = setup.projA.replace(/proj-a$/, "proj-b")
const cdp = await connect()
const info = await sidecarInfo(cdp)

// seed proj-b: one session + 2 shell turns (registers the project on the engine)
const apiB = engineApi(info.url, info.auth, PROJ_B)
const c = await apiB("/session", { method: "POST", body: JSON.stringify({ title: "C4 session C (proj-b)" }) })
for (let i = 0; i < 2; i++) await apiB(`/session/${c.id}/shell`, { method: "POST", body: JSON.stringify({ agent: "build", command: `echo c4-charlie-${i}` }) })
console.log("proj-b session:", c.id)
const s = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
s.projB = PROJ_B; s.sessionC = c.id
await Bun.write(`${AUDIT}/00-setup-sessions.json`, JSON.stringify(s, null, 2))
await sleep(3000) // let the sidebar pick up the new project via SSE/poll

const before = await probe(cdp, info, setup.projA)
console.log("S4 before:", JSON.stringify({ summary: before.spike.summary, pty: before.ptyCount, tcp: before.tcpEstablished, samples: before.spike.count }))

const expandProj = (name: string) => cdp.evalJs(`(() => {
  const t = [...document.querySelectorAll(".alpha-project")].find(p => p.querySelector(".alpha-project-name")?.textContent === "${name}")
  if (!t) return { found: false }
  if (!t.hasAttribute("data-expanded")) { t.querySelector(".alpha-project-row").click(); return { found: true, expanded: "now" } }
  return { found: true, expanded: "already" }
})()`)
const clickSession = (id: string) => cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session-row a")].find(l => l.getAttribute("href")?.endsWith("${id}"))
  if (!a) return false
  a.click(); return true
})()`)

console.log("expand proj-b:", JSON.stringify(await expandProj("proj-b")))
await sleep(2500)
// directory alternation x3: A-session -> C(proj-b) -> A -> C -> A -> C, 800ms apart
const seq = [s.sessionC, setup.sessionA, s.sessionC, setup.sessionA, s.sessionC, setup.sessionA]
for (const id of seq) {
  const ok = await clickSession(id)
  if (!ok) console.log("  MISSING link for", id.slice(-8))
  await sleep(800)
}
await sleep(3000)
const after = await probe(cdp, info, setup.projA)
console.log("S4 after:", JSON.stringify({ summary: after.spike.summary, pty: after.ptyCount, tcp: after.tcpEstablished, samples: after.spike.count }))
const samples = await cdp.evalJs(`window.__req087Spike.samples()`)
await saveJson("40-s4-directory-switch", { projB: PROJ_B, sessionC: c.id, before: { summary: before.spike.summary, pty: before.ptyCount, ptys: before.ptys, tcp: before.tcpEstablished, sampleCount: before.spike.count }, after: { summary: after.spike.summary, pty: after.ptyCount, ptys: after.ptys, tcp: after.tcpEstablished, sampleCount: after.spike.count }, samples })
await cdp.shot("41-s4-after-directory-switch")
for (const smp of samples.slice(before.spike.count)) console.log("  ", JSON.stringify({ path: smp.pathname.slice(-46), sid: smp.sessionID?.slice(-8), panels: smp.terminalPanels, cmd: smp.commandOptions, cvis: smp.composersVisible, ctot: smp.composersTotal }))
cdp.close()
