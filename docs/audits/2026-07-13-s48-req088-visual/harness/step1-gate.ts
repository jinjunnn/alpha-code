// 双闸核验:env ALPHA_SURFACE_SESSION=alpha(main 侧 resolve)+ localStorage ALPHA_SESSION_SPIKE=1。
import { connect, sidecarInfo, sleep, saveJson } from "./lib"
const cdp = await connect()
const info = await sidecarInfo(cdp)
console.log("sidecar:", info.url)
const before = await cdp.evalJs(`(async () => ({
  href: location.href,
  spikeFlag: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  surfaces: await window.api.surfaces.resolve(),
  probe: !!window.__req087Spike,
  workspace: !!document.querySelector("[data-alpha-session-workspace]"),
  colorScheme: document.documentElement.getAttribute("data-color-scheme"),
  composerModelLs: localStorage.getItem("alpha.composer.model"),
}))()`)
console.log("before:", JSON.stringify(before))
if (before.spikeFlag !== "1") {
  await cdp.evalJs(`localStorage.setItem("ALPHA_SESSION_SPIKE", "1")`)
  console.log("spike flag set; reloading")
  await cdp.evalJs(`location.reload()`).catch(() => {})
  await sleep(7000)
}
const after = await cdp.evalJs(`(async () => ({
  href: location.href,
  spikeFlag: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  surfaces: await window.api.surfaces.resolve(),
  probe: !!window.__req087Spike,
}))()`)
console.log("after:", JSON.stringify(after))
await saveJson("01-gates", { sidecar: info.url, before, after })
cdp.close()
