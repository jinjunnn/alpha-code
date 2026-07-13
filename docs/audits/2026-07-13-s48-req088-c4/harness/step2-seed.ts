import { connect, sidecarInfo, engineApi, encodeDir, sleep, saveJson } from "./lib"
const PROJ_A = "/private/tmp/claude-501/-Users-tide-app-alpha-work/e445f21a-e7b5-4daa-8e51-cbb67d7d0f40/scratchpad/c4/proj-a"
const cdp = await connect()
const info = await sidecarInfo(cdp)
const api = engineApi(info.url, info.auth, PROJ_A)
const a = await api("/session", { method: "POST", body: JSON.stringify({ title: "C4 session A" }) })
const b = await api("/session", { method: "POST", body: JSON.stringify({ title: "C4 session B" }) })
console.log("sessions:", a.id, b.id)
for (const [s, label] of [[a, "alpha"], [b, "bravo"]] as const) {
  for (let i = 0; i < 3; i++)
    await api(`/session/${s.id}/shell`, { method: "POST", body: JSON.stringify({ agent: "build", command: `echo c4-${label}-${i}` }) })
}
console.log("seeded 3 shell turns each")
await saveJson("00-setup-sessions", { projA: PROJ_A, sessionA: a.id, sessionB: b.id, sidecar: info.url })
// enter session A (initial project entry = URL open; all later switching is real UI clicks)
await cdp.evalJs(`location.assign("http://localhost:5173/${encodeDir(PROJ_A)}/session/${a.id}")`).catch(() => {})
await sleep(7000)
const st = await cdp.evalJs(`(() => ({
  path: location.pathname,
  probe: !!window.__req087Spike,
  frame: !!document.querySelector("[data-alpha-session-spike-frame]"),
  frameHeader: document.querySelector("[data-alpha-session-spike-frame-header]")?.textContent ?? null,
  overlay: document.querySelector("[data-alpha-session-spike-overlay]")?.textContent ?? null,
  timelineRows: document.querySelectorAll("[data-timeline-row]").length,
  composers: document.querySelectorAll("[data-component=session-composer]").length,
  terminalPanels: document.querySelectorAll("#terminal-panel").length,
}))()`)
console.log(JSON.stringify(st, null, 2))
cdp.close()
