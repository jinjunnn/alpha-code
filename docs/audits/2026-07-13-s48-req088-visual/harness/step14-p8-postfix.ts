// P8 修复态验收正本(af894fc8 .a-swk-root 宽度契约修复后):
// 全区量测(侧栏/workspace/叶/审查面板/死区)+ 审查面板结构(P7 同根复检)+ 全窗截图。
import { connect, sleep, saveJson, P1_EXPR } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
let cdp = await connect()
// HMR 后保险:整页 reload 一次,重进会话 A
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
cdp.close()
cdp = await connect()
const gate = await cdp.evalJs(`(async () => ({
  spike: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  mode: (await window.api.surfaces.resolve()).session,
}))()`)
console.log("gate:", JSON.stringify(gate))
await cdp.evalJs(`(() => {
  const row = [...document.querySelectorAll(".alpha-project-row")].find(r => r.textContent?.includes("req088-visual"))
  if (row && !row.closest(".alpha-project")?.hasAttribute("data-expanded")) row.click()
  return !!row
})()`)
await sleep(1500)
await cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionA}"))
  a?.click(); return !!a
})()`)
await sleep(5000)
const m = await cdp.evalJs(`(() => {
  const r = (el) => el ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(el.getBoundingClientRect()) : null
  const sidebarVisible = (() => {
    const el = [...document.querySelectorAll("[data-alpha-chrome] *")].find(e => (e.textContent ?? "").includes("新对话"))
    return el ? el.getBoundingClientRect().width > 0 : false
  })()
  const ws = document.querySelector("[data-alpha-session-workspace]")
  const leaf = document.querySelector("[data-alpha-session-workspace-leaf]")
  const panel = document.querySelector("#review-panel")
  const main = document.querySelector("main")
  const panelHeader = panel ? [...panel.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean).slice(0, 8) : null
  const panelEmptyState = panel ? /uncommitted|changes yet/i.test(panel.textContent ?? "") : null
  const panelHasDiffBody = /REQ-088 visual probe line/.test(document.querySelector("aside")?.parentElement?.textContent ?? "") ||
    [...document.querySelectorAll("aside")].some(a => /REQ-088 visual probe/.test(a.textContent ?? ""))
  const rightmost = Math.max(...[ws, panel].filter(Boolean).map(e => e.getBoundingClientRect().right), 0)
  return {
    window: { w: window.innerWidth, h: window.innerHeight },
    sidebarVisible,
    main: r(main),
    workspace: r(ws),
    workspaceCss: ws ? { width: getComputedStyle(ws).width, minWidth: getComputedStyle(ws).minWidth, position: getComputedStyle(ws).position, overflow: getComputedStyle(ws).overflow } : null,
    leaf: r(leaf),
    reviewPanel: r(panel),
    panelHeader, panelEmptyState, panelHasDiffBody,
    deadZoneRight: Math.round(window.innerWidth - rightmost),
  }
})()`)
console.log("P8 post-fix measure:", JSON.stringify(m, null, 2))
const p1 = await cdp.evalJs(P1_EXPR)
console.log("P1 post-fix:", JSON.stringify(p1))
await cdp.shot("86-p8-postfix-fullwindow")
await saveJson("86-p8-postfix", { fixCommit: "af894fc8", gate, measure: m, p1 })
cdp.close()
