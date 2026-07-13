import { connect, sidecarInfo, engineApi } from "./lib"
const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"
const setup = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
const cdp = await connect()
const info = await sidecarInfo(cdp)
const api = engineApi(info.url, info.auth, setup.projA)
try { await api(`/session/${setup.sessionR}`, { method: "DELETE" }); console.log("session R deleted") } catch (e) { console.log("del R:", String(e).slice(0,100)) }
// engine paths + project registry snapshot (for engine-side residue check)
const app = await api("/app").catch(e => ({ error: String(e) }))
console.log("app info:", JSON.stringify(app).slice(0, 600))
const projects = await api("/project").catch(e => ({ error: String(e) }))
console.log("projects:", JSON.stringify(Array.isArray(projects) ? projects.map((p: any) => p.worktree ?? p.id ?? p) : projects).slice(0, 800))
// remaining sessions in proj-a / proj-b (must be empty)
for (const proj of [setup.projA, setup.projB]) {
  const a = engineApi(info.url, info.auth, proj)
  const ss = await a("/session").catch(() => [])
  console.log("sessions in", proj.split("/").pop(), ":", Array.isArray(ss) ? ss.length : ss)
}
// remove localStorage flag (final) and verify
const flag = await cdp.evalJs(`(() => { localStorage.removeItem("ALPHA_SESSION_SPIKE"); return localStorage.getItem("ALPHA_SESSION_SPIKE") })()`)
console.log("spike flag after removal:", flag)
cdp.close()
