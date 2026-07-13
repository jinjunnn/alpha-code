// legacy 半边(闸关):P8 量测对照 + P5(P1/P3/P4 重跑)+ P7 legacy(审查面板)。
// 同一窗口尺寸(不动窗口),仅移除 localStorage 闸 + reload。
import { connect, sleep, saveJson, P1_EXPR, P3_EXPR, pressMeta } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())

// —— 带 console 事件面的连接(P7c 口径)
const targets = await (await fetch("http://127.0.0.1:9222/json")).json()
const page = targets.find((t: any) => t.type === "page")
const consoleEvents: any[] = []
let ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
const wire = (sock: WebSocket) => {
  sock.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === "Runtime.exceptionThrown")
      consoleEvents.push({ kind: "exception", detail: msg.params?.exceptionDetails?.text, desc: msg.params?.exceptionDetails?.exception?.description?.slice(0, 300) })
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(msg.params?.type))
      consoleEvents.push({ kind: msg.params.type, args: (msg.params.args ?? []).map((a: any) => a.value ?? a.description?.slice(0, 200)) })
  }
}
wire(ws)
const send = (method: string, params: any = {}) =>
  new Promise<any>((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await new Promise((r) => (ws.onopen = r))
const evalJs = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const shot = async (name: string) => {
  const s = await send("Page.captureScreenshot", { format: "png" })
  if (s?.data) await Bun.write(`/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-visual/${name}.png`, Buffer.from(s.data, "base64"))
  console.log(`  [shot] ${name}.png`)
}
await send("Runtime.enable")

// 1) 闸关 → reload
await evalJs(`localStorage.removeItem("ALPHA_SESSION_SPIKE")`)
await evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
const gate = await evalJs(`(async () => ({
  spike: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  mode: (await window.api.surfaces.resolve()).session,
  probe: !!window.__req087Spike,
}))()`)
console.log("legacy gate:", JSON.stringify(gate))

// 2) 进会话 A
await evalJs(`(() => {
  const row = [...document.querySelectorAll(".alpha-project-row")].find(r => r.textContent?.includes("req088-visual"))
  if (row && !row.closest(".alpha-project")?.hasAttribute("data-expanded")) row.click()
  return !!row
})()`)
await sleep(1500)
const entered = await evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${setup.sessionA}"))
  if (!a) return false
  a.click(); return true
})()`)
console.log("entered A (legacy):", entered)
await sleep(5000)

// 3) P8 量测(与 adapter 半边同一表达式)
const MEASURE = `(() => {
  const r = (el) => el ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(el.getBoundingClientRect()) : null
  const sidebar = document.querySelector("[data-alpha-chrome]")
  const sidebarVisible = (() => {
    const el = [...document.querySelectorAll("[data-alpha-chrome] *")].find(e => (e.textContent ?? "").includes("新对话"))
    return el ? el.getBoundingClientRect().width > 0 : false
  })()
  const ws2 = document.querySelector("[data-alpha-session-workspace]")
  const panel = document.querySelector("#review-panel")
  const main = document.querySelector("main")
  const composer = document.querySelector("[data-alpha-composer=session]")
  const panelHeader = panel ? [...panel.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean) : null
  const panelEmptyState = panel ? /uncommitted|无.*变更|changes yet/i.test(panel.textContent ?? "") : null
  const mainKids = main ? [...main.children].map(k => ({ tag: k.tagName.toLowerCase(),
    cls: typeof k.className === "string" ? k.className.split(" ").slice(0,4).join(" ") : undefined,
    rect: (({x,width}) => ({x:Math.round(x),w:Math.round(width)}))(k.getBoundingClientRect()),
    flex: getComputedStyle(k).flex })) : null
  const rightmost = Math.max(...[ws2, panel, main].filter(Boolean).map(e => e.getBoundingClientRect().right), 0)
  return {
    window: { w: window.innerWidth, h: window.innerHeight },
    sidebarVisible,
    workspacePresent: !!ws2,
    main: r(main), mainKids,
    reviewPanel: r(panel),
    panelHeader, panelEmptyState,
    composer: r(composer),
    deadZoneRight: Math.round(window.innerWidth - rightmost),
  }
})()`
const m = await evalJs(MEASURE)
console.log("P8 legacy measure:", JSON.stringify(m, null, 2))
await shot("81-p8-legacy-fullwindow")

// 4) P5:P1 四断言
const p1 = await evalJs(P1_EXPR)
console.log("P1 legacy:", JSON.stringify(p1))

// 5) P5:P3 —— 复刻 adapter 侧同一暴露步骤(展开 Shell 卡 + 两个 context group)后计数
await evalJs(`(() => {
  const t = [...document.querySelectorAll("[data-component=tool-trigger]")].find(x => /Shell|req088 probe bash/.test(x.textContent ?? ""))
  t?.click(); return !!t
})()`)
await sleep(1200)
await evalJs(`(() => {
  const gs = [...document.querySelectorAll("[data-component=context-tool-group-trigger]")]
  gs.forEach(g => g.click()); return gs.length
})()`)
await sleep(1500)
const p3 = await evalJs(P3_EXPR)
console.log("P3 legacy:", JSON.stringify(p3))
await shot("82-p5-legacy-decorations")

// 6) P5:P4 native picker(mod+')
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "'", code: "Quote", modifiers: 4 })
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "'", code: "Quote", modifiers: 4 })
await sleep(1500)
const p4open = await evalJs(`(() => ({
  alphaPicker: !!document.querySelector("[role=dialog] [data-alpha-picker]"),
  rows: [...document.querySelectorAll("[data-slot=list-item][data-key]")].map(r => ({ key: r.getAttribute("data-key"), selected: r.getAttribute("data-selected") })),
  homeAnchor: !!document.querySelector("[data-alpha-home-anchor]"),
  popperPositioners: [...document.querySelectorAll("[data-popper-positioner]")].length,
}))()`)
console.log("P4 legacy open:", JSON.stringify(p4open, null, 2))
await shot("83-p5-legacy-picker")
const p4pick = await evalJs(`(() => {
  const selectedBefore = document.querySelector("[data-slot=list-item][data-selected=true]")?.getAttribute("data-key") ?? null
  const rows = [...document.querySelectorAll(".a-mp2-row")]
  const target = rows.find(r => !r.className.includes("locked") && !r.className.includes("sel"))
  if (!target) return { ok: false, selectedBefore }
  const label = target.textContent?.slice(0, 40)
  target.click()
  return { ok: true, selectedBefore, clicked: label }
})()`)
await sleep(1500)
// 上游点选后自关 → 重开验证 data-selected 移动(与 adapter 同口径)
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "'", code: "Quote", modifiers: 4 })
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "'", code: "Quote", modifiers: 4 })
await sleep(1500)
const p4after = await evalJs(`(() => ({
  rows: [...document.querySelectorAll("[data-slot=list-item][data-key]")].map(r => ({ key: r.getAttribute("data-key"), selected: r.getAttribute("data-selected") })),
}))()`)
console.log("P4 legacy pick:", JSON.stringify(p4pick), "after reopen:", JSON.stringify(p4after))
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape" })
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
await sleep(800)

// 7) P7 legacy:审查面板(pill 开面板 → 骨架 → 点文件行 → diff 是否渲染)
const pill = await evalJs(`(() => {
  const p = document.querySelector(".a-openp")
  if (!p) return { ok: false }
  p.click(); return { ok: true }
})()`)
console.log("pill:", JSON.stringify(pill))
await sleep(2000)
const panelDump = `(() => {
  const panel = document.querySelector("#review-panel")
  if (!panel) return { panel: false }
  const fileRows = [...panel.querySelectorAll("button")].map(b => ({ comp: b.getAttribute("data-component"), text: b.textContent?.slice(0, 50), h: Math.round(b.getBoundingClientRect().height) }))
  return { panel: true, rect: (({x,width,height}) => ({x:Math.round(x),w:Math.round(width),h:Math.round(height)}))(panel.getBoundingClientRect()), fileRows,
    text35: (panel.textContent ?? "").slice(0, 80) }
})()`
const before7 = await evalJs(panelDump)
console.log("P7 legacy panel:", JSON.stringify(before7, null, 2))
await shot("84-p7-legacy-panel-collapsed")
const rowClick = await evalJs(`(() => {
  const panel = document.querySelector("#review-panel")
  if (!panel) return { ok: false }
  const row = [...panel.querySelectorAll("button")].find(b => /notes\\.txt/.test(b.textContent ?? ""))
  if (!row) return { ok: false, reason: "no file row" }
  row.click(); return { ok: true, rowText: row.textContent?.slice(0, 50) }
})()`)
console.log("file row click:", JSON.stringify(rowClick))
await sleep(2500)
const diffCheck = await evalJs(`(() => {
  const asides = [...document.querySelectorAll("aside")].map(a => ({ w: Math.round(a.getBoundingClientRect().width), hasDiff: /REQ-088 visual probe/.test(a.textContent ?? "") }))
  return { asides, anyDiff: asides.some(a => a.hasDiff) }
})()`)
console.log("P7 legacy diff:", JSON.stringify(diffCheck))
await shot("85-p7-legacy-panel-expanded")

await saveJson("81-p8-p5-p7-legacy", { gate, m, p1, p3, p4open, p4pick, p4after, review: { before7, rowClick, diffCheck }, consoleEvents })
console.log("console events (legacy run):", JSON.stringify(consoleEvents.slice(0, 10), null, 2))
ws.close()
