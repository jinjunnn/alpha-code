import { connect, sidecarInfo, engineApi, sleep } from "./lib"
const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"
const setup = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
const cdp = await connect()
const info = await sidecarInfo(cdp)

// 1) delete test sessions from the real Local sidecar
const delSession = async (proj: string, id: string) => {
  const api = engineApi(info.url, info.auth, proj)
  try { await api(`/session/${id}`, { method: "DELETE" }); return "deleted" } catch (e) { return String(e).slice(0,80) }
}
console.log("del A:", await delSession(setup.projA, setup.sessionA))
console.log("del B:", await delSession(setup.projA, setup.sessionB))
if (setup.sessionC) console.log("del C:", await delSession(setup.projB, setup.sessionC))

// 2) remove the added server2 from the app's persisted server list + remove spike flag + reset active to local
const cleaned = await cdp.evalJs(`(() => {
  const out = {}
  // remove spike flag
  out.spikeFlagBefore = localStorage.getItem("ALPHA_SESSION_SPIKE")
  localStorage.removeItem("ALPHA_SESSION_SPIKE")
  // find + scrub the persisted server store (contains 14790)
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    const v = localStorage.getItem(k)
    if (v && v.includes("14790")) {
      out.serverKey = k
      out.serverBefore = v.slice(0, 300)
      try {
        const parsed = JSON.parse(v)
        // remove any list entries referencing 14790
        const scrub = (obj) => {
          if (Array.isArray(obj)) return obj.filter(e => !JSON.stringify(e).includes("14790"))
          return obj
        }
        if (parsed.list) parsed.list = scrub(parsed.list)
        if (parsed.active && String(parsed.active).includes("14790")) delete parsed.active
        localStorage.setItem(k, JSON.stringify(parsed))
        out.serverAfter = localStorage.getItem(k).slice(0, 300)
      } catch (e) { out.scrubError = String(e) }
    }
  }
  return out
})()`)
console.log("localStorage cleanup:", JSON.stringify(cleaned, null, 2))
cdp.close()
