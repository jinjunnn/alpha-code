// P7(主会话增补):审查面板「body 空白」复现块。
//   a) 经 timeline「在面板打开」pill 打开审查面板 → dump #review-panel 骨架 + 截图;
//   b) 点击 per-file 折叠行("+1 −1")→ 是否展开 diff → 截图;
//   c) 全程收集 console error/warning 与未捕获异常(Runtime domain)。
// 判定三分法:adapter 回归 / 双模式同现上游行为(legacy 半边在 step10 重跑)/ 环境因素。
import { connect, sleep, saveJson } from "./lib"

const cdp = await connect()
// console 收集
const consoleEvents: any[] = []
await cdp.send("Runtime.enable")
// 注:lib 的 send 只路由带 id 的响应;事件监听要另开一条 ws?—— 这里直接复用底层:重连一条带事件面的连接。
cdp.close()

const targets = await (await fetch("http://127.0.0.1:9222/json")).json()
const page = targets.find((t: any) => t.type === "page")
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result)
    return
  }
  if (msg.method === "Runtime.exceptionThrown") consoleEvents.push({ kind: "exception", detail: msg.params?.exceptionDetails?.text, desc: msg.params?.exceptionDetails?.exception?.description?.slice(0, 300) })
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(msg.params?.type))
    consoleEvents.push({ kind: msg.params.type, args: (msg.params.args ?? []).map((a: any) => a.value ?? a.description?.slice(0, 200)) })
}
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

const dumpPanel = `(() => {
  const panel = document.querySelector("#review-panel")
  if (!panel) return { panel: false }
  const walk = (el, depth) => {
    if (depth > 4) return null
    const kids = [...el.children].map(c => walk(c, depth + 1)).filter(Boolean)
    const r = el.getBoundingClientRect()
    return { tag: el.tagName.toLowerCase(), comp: el.getAttribute("data-component") ?? el.getAttribute("data-slot") ?? undefined,
      cls: (el.className && typeof el.className === "string") ? el.className.split(" ").slice(0,3).join(" ") : undefined,
      h: Math.round(r.height), w: Math.round(r.width), kids: kids.length ? kids : undefined }
  }
  const fileRows = [...panel.querySelectorAll("[data-component='session-review-file'], [data-slot='session-review-file'], button, [role=button]")].slice(0, 12)
    .map(b => ({ tag: b.tagName, comp: b.getAttribute("data-component") ?? b.getAttribute("data-slot"), text: b.textContent?.slice(0, 60), h: Math.round(b.getBoundingClientRect().height) }))
  const diffEls = [...panel.querySelectorAll("[data-component*='diff'], [class*='diff']")].slice(0, 8)
    .map(d => ({ comp: d.getAttribute("data-component") ?? d.className?.toString?.().slice(0, 40), h: Math.round(d.getBoundingClientRect().height) }))
  return { panel: true, rect: panel.getBoundingClientRect().toJSON(), skeleton: walk(panel, 0), fileRows, diffEls,
    reviewTabText: document.querySelector("[aria-controls='review-panel']")?.textContent ?? null,
    ariaExpanded: document.querySelector("[aria-controls='review-panel']")?.getAttribute("aria-expanded") ?? null }
})()`

// a) 面板当前态(此前截图显示右栏已开)——先取骨架,再经 pill 确认开面板动线
const pre = await evalJs(dumpPanel)
console.log("panel pre:", JSON.stringify({ panel: pre.panel, ariaExpanded: pre.ariaExpanded, reviewTab: pre.reviewTabText?.slice(0, 20) }))
const pill = await evalJs(`(() => {
  const p = document.querySelector(".a-openp")
  if (!p) return { ok: false }
  p.click(); return { ok: true }
})()`)
console.log("pill click:", JSON.stringify(pill))
await sleep(2000)
const stateA = await evalJs(dumpPanel)
console.log("panel after pill:", JSON.stringify(stateA, null, 2).slice(0, 3000))
await shot("50-p7-review-panel-collapsed")

// b) 点击 per-file 折叠行(accordion header)
const rowClick = await evalJs(`(() => {
  const panel = document.querySelector("#review-panel")
  if (!panel) return { ok: false, reason: "no panel" }
  // per-file 行 = 面板内首个可点的 accordion/collapsible header(带 +N −N 徽标文本)
  const candidates = [...panel.querySelectorAll("button, [role=button], [data-component='collapsible-trigger'], [aria-expanded]")]
  const row = candidates.find(b => /\\+\\d+/.test(b.textContent ?? "") || /notes\\.txt/.test(b.textContent ?? ""))
  if (!row) return { ok: false, reason: "no file row", candidates: candidates.slice(0,8).map(c => c.textContent?.slice(0,40)) }
  row.click()
  return { ok: true, rowText: row.textContent?.slice(0, 60) }
})()`)
console.log("file row click:", JSON.stringify(rowClick))
await sleep(2500)
const stateB = await evalJs(dumpPanel)
console.log("panel after row click:", JSON.stringify(stateB, null, 2).slice(0, 3000))
const diffVisible = await evalJs(`(() => {
  const panel = document.querySelector("#review-panel")
  if (!panel) return { visible: false }
  const tall = [...panel.querySelectorAll("*")].filter(e => e.getBoundingClientRect().height > 120)
  const text = panel.textContent ?? ""
  return { visible: /REQ-088 visual probe line/.test(text), tallEls: tall.length, panelTextSample: text.slice(0, 300) }
})()`)
console.log("diff visible:", JSON.stringify(diffVisible, null, 2))
await shot("51-p7-review-panel-expanded")

await saveJson("50-p7-review-adapter", { pre, pill, stateA, rowClick, stateB, diffVisible, consoleEvents })
console.log("console events:", JSON.stringify(consoleEvents, null, 2))
ws.close()
