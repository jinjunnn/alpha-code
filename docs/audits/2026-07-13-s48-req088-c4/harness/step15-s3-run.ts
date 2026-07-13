import { connect, sidecarInfo, engineApi, probe, sleep, saveJson, type Cdp } from "./lib"
const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"
const setup = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
const raise = () => Bun.spawnSync(["sh","/private/tmp/claude-501/-Users-tide-app-alpha-work/e445f21a-e7b5-4daa-8e51-cbb67d7d0f40/scratchpad/c4/raise.sh"])
const enterR = async (cdp: Cdp) => {
  await cdp.evalJs(`(() => {
    const t = [...document.querySelectorAll(".alpha-project")].find(p => p.querySelector(".alpha-project-name")?.textContent === "proj-a")
    if (t && !t.hasAttribute("data-expanded")) t.querySelector(".alpha-project-row").click()
  })()`)
  await sleep(2000)
  const ok = await cdp.evalJs(`(() => {
    const a = [...document.querySelectorAll(".alpha-session-row a")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionR}"))
    if (!a) return false
    a.click(); return true
  })()`)
  await sleep(4500)
  return ok
}
const snap = async (cdp: Cdp, info: any, tag: string) => {
  const p = await probe(cdp, info, setup.projA)
  const dom = await cdp.evalJs(`(() => ({
    frame: !!document.querySelector("[data-alpha-session-spike-frame]"),
    rows: document.querySelectorAll("[data-timeline-row]").length,
    panels: document.querySelectorAll("#terminal-panel").length,
    composers: document.querySelectorAll("[data-component=session-composer]").length,
  }))()`)
  console.log(`[${tag}]`, JSON.stringify({ dom, summary: p.spike.summary, latest: p.spike.latest, pty: p.ptyCount, tcp: p.tcpEstablished }))
  return { dom, summary: p.spike.summary, latest: p.spike.latest, pty: p.ptyCount, ptys: p.ptys, tcp: p.tcpEstablished }
}

let cdp = await connect()
const info = await sidecarInfo(cdp)
console.log("enter R:", await enterR(cdp))
// open terminal so a PTY exists across reloads
await cdp.evalJs(`[...document.querySelectorAll(".alpha-topbar-right .alpha-topbar-btn")][0]?.click()`)
await sleep(2500)
const before = await snap(cdp, info, "S3 before reload#2 (on R, terminal open)")
raise(); await cdp.shot("70-s3-before-reload")

// reload #2
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
cdp.close(); cdp = await connect()
console.log("re-enter R:", await enterR(cdp))
const after1 = await snap(cdp, info, "S3 after reload#2 (re-entered R)")
raise(); await cdp.shot("71-s3-after-reload2")

// reload #3
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
cdp.close(); cdp = await connect()
console.log("re-enter R:", await enterR(cdp))
const after2 = await snap(cdp, info, "S3 after reload#3 (re-entered R)")
raise(); await cdp.shot("72-s3-after-reload3")
const samples = await cdp.evalJs(`window.__req087Spike.samples()`)
await saveJson("70-s3-reload", { sessionR: setup.sessionR, before, afterReload2: after1, afterReload3: after2, samplesFinalWindow: samples })
cdp.close()
