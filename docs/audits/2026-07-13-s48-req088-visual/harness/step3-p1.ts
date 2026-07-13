// P1(T6 §5):ComposerTakeover 生效四断言(adapter 模式,session 路由)+ 基线截图。
// 导航走真实 UI(alpha 侧栏会话行,MemoryRouter 纪律)。
import { connect, sleep, saveJson, P1_EXPR, PROBE_EXPR } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
const cdp = await connect()
const clicked = await cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionA}"))
  if (!a) return false
  a.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })) // hover 预热(C4 携带项③)
  a.click(); return true
})()`)
console.log("clicked session A:", clicked)
await sleep(5000)
const frame = await cdp.evalJs(`(() => ({
  workspace: !!document.querySelector("[data-alpha-session-workspace]"),
  chrome: document.querySelector("[data-alpha-session-workspace-chrome]")?.textContent ?? null,
  chromeH: document.querySelector("[data-alpha-session-workspace-chrome]")?.getBoundingClientRect().height ?? 0,
  overlay: (document.querySelector("[data-alpha-session-spike-overlay]")?.textContent ?? "").slice(0, 160),
}))()`)
const p1 = await cdp.evalJs(P1_EXPR)
const state = { ...frame, p1 }
console.log(JSON.stringify(state, null, 2))
const probe = await cdp.evalJs(PROBE_EXPR)
console.log("probe:", JSON.stringify(probe))
const pass =
  state.workspace &&
  state.p1.takeoverFlag === true &&
  state.p1.visibleHosts === 1 &&
  state.p1.upstreamComposerDisplay === "none" &&
  state.p1.alphaComposerInHost === true
console.log("P1 adapter:", pass ? "PASS" : "FAIL")
await saveJson("10-p1-adapter", { state, probe, pass })
await cdp.shot("10-p1-adapter-session-a")
cdp.close()
