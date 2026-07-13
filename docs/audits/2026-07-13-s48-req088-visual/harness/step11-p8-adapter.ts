// P8(主会话最高优先):整页布局同构对照 —— adapter 半边。
// 正常窗口(osascript 已置满屏,非 Emulation),进入会话 A,量测 shell 各区:
// 侧栏在场性、body/workspace/叶/timeline 列/#review-panel 宽度、死区。
import { connect, sleep, saveJson, PROBE_EXPR } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
const cdp = await connect()

// 闸核验(reload 后 localStorage 闸仍在)
const gate = await cdp.evalJs(`(async () => ({
  spike: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  mode: (await window.api.surfaces.resolve()).session,
}))()`)
console.log("gate:", JSON.stringify(gate))
if (gate.spike !== "1") {
  await cdp.evalJs(`localStorage.setItem("ALPHA_SESSION_SPIKE", "1")`)
  await cdp.evalJs(`location.reload()`).catch(() => {})
  await sleep(8000)
  console.log("gate re-armed + reloaded")
}

// 展开项目并进入会话 A(真实 UI)
await cdp.evalJs(`(() => {
  const row = [...document.querySelectorAll(".alpha-project-row")].find(r => r.textContent?.includes("req088-visual"))
  if (row && !row.closest(".alpha-project")?.hasAttribute("data-expanded")) row.click()
  return !!row
})()`)
await sleep(1500)
const entered = await cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionA}"))
  if (!a) return false
  a.click(); return true
})()`)
console.log("entered A:", entered)
await sleep(5000)

export const MEASURE = `(() => {
  const r = (el) => el ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(el.getBoundingClientRect()) : null
  const sidebar = document.querySelector("[data-alpha-chrome]")
  const sidebarVisible = (() => {
    const el = [...document.querySelectorAll("[data-alpha-chrome] *")].find(e => (e.textContent ?? "").includes("新对话"))
    return el ? el.getBoundingClientRect().width > 0 : false
  })()
  const ws = document.querySelector("[data-alpha-session-workspace]")
  const leaf = document.querySelector("[data-alpha-session-workspace-leaf]")
  const chrome = document.querySelector("[data-alpha-session-workspace-chrome]")
  const panel = document.querySelector("#review-panel")
  const timeline = document.querySelector("[data-component='session-turn']")?.closest("main, [data-component]")
  const composer = document.querySelector("[data-alpha-composer=session]")
  // workspace 的父链(向上 4 层)宽度 —— 找宽度坍缩点
  const chain = []
  let cur = ws?.parentElement ?? null
  for (let i = 0; i < 6 && cur; i++) {
    chain.push({ tag: cur.tagName.toLowerCase(), comp: cur.getAttribute("data-component") ?? cur.getAttribute("data-slot") ?? undefined,
      cls: typeof cur.className === "string" ? cur.className.split(" ").slice(0,4).join(" ") : undefined,
      rect: r(cur), display: getComputedStyle(cur).display, flex: getComputedStyle(cur).flex, width: getComputedStyle(cur).width })
    cur = cur.parentElement
  }
  const panelHeader = panel ? [...panel.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean) : null
  const panelEmptyState = panel ? /uncommitted|无.*变更|changes yet/i.test(panel.textContent ?? "") : null
  const deadZoneRight = (() => {
    const w = window.innerWidth
    const rects = [ws, panel, sidebar].filter(Boolean).map(e => e.getBoundingClientRect().right)
    const rightmost = Math.max(...rects, 0)
    return Math.round(w - rightmost)
  })()
  return {
    window: { w: window.innerWidth, h: window.innerHeight },
    sidebarVisible,
    body: r(document.body),
    workspace: r(ws), workspaceCss: ws ? { display: getComputedStyle(ws).display, flex: getComputedStyle(ws).flex, width: getComputedStyle(ws).width } : null,
    leaf: r(leaf),
    chrome: r(chrome),
    reviewPanel: r(panel),
    panelHeader, panelEmptyState,
    composer: r(composer),
    parentChain: chain,
    deadZoneRight,
  }
})()`

const m = await cdp.evalJs(MEASURE)
console.log(JSON.stringify(m, null, 2))
await saveJson("80-p8-adapter-measure", { gate, measure: m })
await cdp.shot("80-p8-adapter-fullwindow")
cdp.close()
