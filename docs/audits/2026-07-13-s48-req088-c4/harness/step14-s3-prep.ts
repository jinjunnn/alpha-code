import { connect, sidecarInfo, engineApi, sleep, saveJson } from "./lib"
const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"
const setup = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
let cdp = await connect()
// re-open the localStorage gate and reload (this is S3 reload #1)
await cdp.evalJs(`localStorage.setItem("ALPHA_SESSION_SPIKE", "1")`)
const info = await sidecarInfo(cdp)
// create a fresh session for S3 (previous test sessions were already deleted)
const api = engineApi(info.url, info.auth, setup.projA)
const r = await api("/session", { method: "POST", body: JSON.stringify({ title: "C4 session R (S3 reload)" }) })
for (let i = 0; i < 2; i++) await api(`/session/${r.id}/shell`, { method: "POST", body: JSON.stringify({ agent: "build", command: `echo c4-reload-${i}` }) })
console.log("session R:", r.id)
const s = setup; s.sessionR = r.id
await Bun.write(`${AUDIT}/00-setup-sessions.json`, JSON.stringify(s, null, 2))
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
cdp.close()
cdp = await connect()
const gates = await cdp.evalJs(`(async () => ({
  surfaces: (await window.api.surfaces.resolve()).session,
  spikeFlag: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  probe: !!window.__req087Spike,
}))()`)
console.log("gates after reload#1:", JSON.stringify(gates))
cdp.close()
