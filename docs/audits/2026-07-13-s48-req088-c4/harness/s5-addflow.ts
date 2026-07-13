import { connect, sidecarInfo, engineApi, probe, sleep, saveJson } from "./lib"
const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"
const setup = JSON.parse(await Bun.file(`${AUDIT}/00-setup-sessions.json`).text())
const cdp = await connect()
const info = await sidecarInfo(cdp)
const raise = () => Bun.spawnSync(["sh","/private/tmp/claude-501/-Users-tide-app-alpha-work/e445f21a-e7b5-4daa-8e51-cbb67d7d0f40/scratchpad/c4/raise.sh"])
const localApi = engineApi(info.url, info.auth, setup.projA)
const tcp = (p: string) => Number(Bun.spawnSync(["sh","-c",`lsof -nP -iTCP:${p} -sTCP:ESTABLISHED 2>/dev/null | grep -c Electron`]).stdout.toString().trim())||0
const sidePort = new URL(info.url).port
const localPty = async () => { const r = await localApi("/pty").catch(()=>[]); return Array.isArray(r) ? r.length : -1 }

// baseline on session A (Local)
const b = await probe(cdp, info, setup.projA)
console.log("baseline on A (Local): localPTY=" + await localPty() + " tcpSidecar=" + tcp(sidePort) + " tcp14790=" + tcp("14790") + " summary=" + JSON.stringify(b.spike.summary))

// open add-server form: sidebar 搜索 -> 切换服务器 -> 添加服务器
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
await sleep(400)
await cdp.evalJs(`[...document.querySelectorAll(".alpha-sidebar button, .alpha-sidebar a")].find(e => e.offsetParent !== null && e.textContent?.trim() === "搜索")?.click()`)
await sleep(900)
await cdp.evalJs(`[...document.querySelectorAll("input")].find(i => i.placeholder.includes("搜索文件、命令和会话") && i.offsetParent !== null)?.focus()`)
await cdp.send("Input.insertText", { text: "切换服务器" })
await sleep(700)
await cdp.evalJs(`[...document.querySelectorAll("button")].find(e => e.offsetParent !== null && e.textContent?.trim() === "切换服务器")?.click()`)
await sleep(1200)
await cdp.evalJs(`[...document.querySelectorAll("button")].find(e => e.offsetParent !== null && e.textContent?.trim() === "添加服务器")?.click()`)
await sleep(1000)
const filled = await cdp.evalJs(`(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
  const fire = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })) }
  const url = [...document.querySelectorAll("input")].find(i => i.placeholder === "http://localhost:4096" && i.offsetParent !== null)
  if (!url) return false
  url.focus(); fire(url, "http://127.0.0.1:14790")
  return url.value
})()`)
console.log("url filled:", filled)
await sleep(500)
await cdp.evalJs(`(() => { const u = [...document.querySelectorAll("input")].find(i => i.placeholder === "http://localhost:4096" && i.offsetParent !== null); u?.focus(); u?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })()`)
await sleep(5000)
const afterBody = await cdp.evalJs(`document.body.innerText.slice(0,50).replace(/\\n/g," | ")`)
console.log("after add-flow switch, body:", afterBody)
const afterPath = await cdp.evalJs(`(window.__req087Spike?.samples()?.slice(-1)[0]?.pathname ?? location.pathname).slice(-20)`)
console.log("after add-flow: path=" + afterPath + " localPTY=" + await localPty() + " tcpSidecar=" + tcp(sidePort) + " tcp14790=" + tcp("14790"))
const s2probe = await probe(cdp, info, setup.projA)
console.log("spike summary on server2 home:", JSON.stringify(s2probe.spike.summary))
raise(); await cdp.shot("65-s5-server2-home-after-switch")
await saveJson("52-s5-addflow-switch", {
  note: "server switch driven via add-server flow (new-layout gates existing-server re-select; select() onSelect is no-op when newLayoutDesigns). Add-flow: server.add + navigate('/'). Local sidecar PTY/socket observed for leak.",
  baseline: { localPTY: b.ptyCount, tcpSidecar: tcp(sidePort), summary: b.spike.summary },
  afterSwitchServer2: { path: afterPath, localPTY: await localPty(), spikeSummary: s2probe.spike.summary },
})
cdp.close()
