// B. 视觉验收(T2 §4 清单,adapter 模式):
//   V1 chrome 亮/暗两态截图(prefers-color-scheme 模拟;root 未钉 data-color-scheme=dark 时生效,
//      否则临时切 root 属性并复原);
//   V2 超长项目名截断(视口收窄至 900px 截图后复原);
//   V3 无 id 过渡态「新会话」(侧栏「新对话」→ /dir/session 草稿路由);
//   V4 CrossServerGuard 引导卡(先访 B → 引擎侧 DELETE B → topbar 后退回 B 路由 → 叶抛
//      Session not found → 引导卡;与 C4 S5 跨 server 同一错误族,T3 live 已证等价);
//   V5 探针 overlay 与 chrome 同屏(几何取证:两者 rect 是否相交)。
import { connect, sidecarInfo, engineApi, sleep, saveJson, PROBE_EXPR, PROJ } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
const cdp = await connect()
const info = await sidecarInfo(cdp)

const go = (id: string) =>
  cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session")].find(l => l.getAttribute("href")?.endsWith("${"$"}{id}"))
  if (!a) return false
  a.click(); return true
})()`.replace("${id}", id))

// —— 回 A(取证基准屏)
console.log("goto A:", await go(setup.sessionA))
await sleep(4000)

// V5 overlay×chrome 几何
const geo = await cdp.evalJs(`(() => {
  const chrome = document.querySelector("[data-alpha-session-workspace-chrome]")?.getBoundingClientRect().toJSON() ?? null
  const overlay = document.querySelector("[data-alpha-session-spike-overlay]")?.getBoundingClientRect().toJSON() ?? null
  const intersect = chrome && overlay
    ? !(overlay.left > chrome.right || overlay.right < chrome.left || overlay.top > chrome.bottom || overlay.bottom < chrome.top)
    : null
  return { chrome, overlay, intersect }
})()`)
console.log("V5 overlay×chrome:", JSON.stringify(geo))
await cdp.shot("70-v5-overlay-with-chrome")

// V1 亮态(当前)
const scheme = await cdp.evalJs(`document.documentElement.getAttribute("data-color-scheme")`)
console.log("root data-color-scheme:", scheme)
await cdp.shot("71-v1-chrome-light")
// 暗态:emulate 优先,若 root 钉了 light 则临时切属性
let darkVia = "emulation"
await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] })
await sleep(1200)
let isDark = await cdp.evalJs(`getComputedStyle(document.body).backgroundColor`)
const darkApplied = await cdp.evalJs(`(() => {
  const c = document.querySelector("[data-alpha-session-workspace-chrome]")
  return c ? getComputedStyle(c).backgroundColor : null
})()`)
console.log("dark bg after emulation:", isDark, darkApplied)
if (scheme === "light") {
  darkVia = "root-attr"
  await cdp.evalJs(`document.documentElement.setAttribute("data-color-scheme", "dark")`)
  await sleep(1200)
}
const chromeDark = await cdp.evalJs(`(() => {
  const c = document.querySelector("[data-alpha-session-workspace-chrome]")
  return c ? { bg: getComputedStyle(c).backgroundColor, fg: getComputedStyle(c).color } : null
})()`)
console.log("chrome dark colors:", JSON.stringify(chromeDark), "via", darkVia)
await cdp.shot("72-v1-chrome-dark")
// 复原
if (darkVia === "root-attr") await cdp.evalJs(`document.documentElement.setAttribute("data-color-scheme", ${JSON.stringify(scheme)})`)
await cdp.send("Emulation.setEmulatedMedia", { features: [] })
await sleep(800)

// V2 收窄视口 → 截断
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 0, mobile: false })
await sleep(1200)
const trunc = await cdp.evalJs(`(() => {
  const p = document.querySelector(".a-swk-project")
  return p ? { scrollW: p.scrollWidth, clientW: p.clientWidth, truncated: p.scrollWidth > p.clientWidth, text: p.textContent } : null
})()`)
console.log("V2 truncation:", JSON.stringify(trunc))
await cdp.shot("73-v2-long-name-truncation-900px")
await cdp.send("Emulation.clearDeviceMetricsOverride")
await sleep(800)

// V3 「新会话」无 id 过渡态:侧栏「新对话」
const newChat = await cdp.evalJs(`(() => {
  const btn = [...document.querySelectorAll("button, a")].find(b => (b.textContent ?? "").trim() === "新对话")
  if (!btn) return false
  btn.click(); return true
})()`)
console.log("V3 新对话 clicked:", newChat)
await sleep(3500)
const v3 = await cdp.evalJs(`(() => ({
  chrome: document.querySelector("[data-alpha-session-workspace-chrome]")?.textContent ?? null,
  sessionSpan: document.querySelector(".a-swk-session")?.textContent ?? null,
  workspace: !!document.querySelector("[data-alpha-session-workspace]"),
}))()`)
console.log("V3 state:", JSON.stringify(v3))
await cdp.shot("74-v3-draft-new-session")

// V4 CrossServerGuard:回 A → 删 B → 后退到 B 路由(此刻 B 已不存在)
console.log("goto B first:", await go(setup.sessionB))
await sleep(2500)
console.log("goto A:", await go(setup.sessionA))
await sleep(2500)
const api = engineApi(info.url, info.auth, PROJ)
await api(`/session/${setup.sessionB}`, { method: "DELETE" })
console.log("session B deleted server-side")
await sleep(1500)
const back = await cdp.evalJs(`(() => {
  const btn = [...document.querySelectorAll(".alpha-topbar-btn")].find(b => b.getAttribute("aria-label")?.includes("后退") || b.title?.includes("后退"))
  if (!btn) return false
  btn.click(); return true
})()`)
console.log("topbar back clicked:", back)
await sleep(4000)
const v4 = await cdp.evalJs(`(() => ({
  guard: !!document.querySelector("[data-alpha-session-workspace-guard]"),
  guardTitle: document.querySelector(".a-swk-guard-title")?.textContent ?? null,
  guardButtons: [...document.querySelectorAll(".a-swk-guard-actions button")].map(b => b.textContent?.trim()),
  fallback: !!document.querySelector("[data-alpha-surface-fallback]"),
  bodyHas: (document.body.innerText.match(/此会话不属于当前连接的服务器/) ?? []).length,
  workspace: !!document.querySelector("[data-alpha-session-workspace]"),
}))()`)
console.log("V4 guard:", JSON.stringify(v4, null, 2))
await cdp.shot("75-v4-cross-server-guard")
// 经引导卡「返回首页」离开(真实动线)
const home = await cdp.evalJs(`(() => {
  const b = [...document.querySelectorAll(".a-swk-guard-actions button")].find(x => x.textContent?.includes("返回首页"))
  if (!b) return false
  b.click(); return true
})()`)
console.log("guard 返回首页 clicked:", home)
await sleep(2500)
const probe = await cdp.evalJs(PROBE_EXPR)
await saveJson("70-visual-adapter", { geo, scheme, darkVia, chromeDark, trunc, v3, v4, probeAfter: probe.summary })
cdp.close()
