import { connect, sidecarInfo, sleep } from "./lib"
const cdp = await connect()
const info = await sidecarInfo(cdp)
console.log("sidecar:", info.url)
const state = await cdp.evalJs(`(() => ({
  href: location.href,
  spikeFlag: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  probe: !!window.__req087Spike,
  frame: !!document.querySelector("[data-alpha-session-spike-frame]"),
}))()`)
console.log("before:", JSON.stringify(state))
if (state.spikeFlag !== "1") {
  await cdp.evalJs(`localStorage.setItem("ALPHA_SESSION_SPIKE", "1")`)
  console.log("spike flag set; reloading")
  await cdp.evalJs(`location.reload()`).catch(() => {})
  await sleep(6000)
}
const after = await cdp.evalJs(`(() => ({
  href: location.href,
  spikeFlag: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  probe: !!window.__req087Spike,
  frame: !!document.querySelector("[data-alpha-session-spike-frame]"),
  overlay: !!document.querySelector("[data-alpha-session-spike-overlay]"),
}))()`)
console.log("after:", JSON.stringify(after))
cdp.close()
