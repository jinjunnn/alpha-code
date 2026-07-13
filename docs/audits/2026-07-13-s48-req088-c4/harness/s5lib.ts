import { type Cdp, sleep } from "./lib"
export const switchServer = async (cdp: Cdp, label: string) => {
  // open palette via the alpha sidebar 搜索 button (real UI)
  const open = await cdp.evalJs(`(() => {
    const els = [...document.querySelectorAll(".alpha-sidebar button, .alpha-sidebar a")].filter(e => e.offsetParent !== null)
    const t = els.find(e => e.textContent?.trim() === "搜索")
    if (!t) return false
    t.click(); return true
  })()`)
  if (!open) return { step: "palette-btn", ok: false }
  await sleep(1000)
  const focus = await cdp.evalJs(`(() => {
    const inp = [...document.querySelectorAll("input")].find(i => i.placeholder.includes("搜索文件、命令和会话") && i.offsetParent !== null)
    if (!inp) return false
    inp.focus(); return true
  })()`)
  if (!focus) return { step: "palette-input", ok: false }
  await cdp.send("Input.insertText", { text: "服务器" })
  await sleep(800)
  const cmd = await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll("button")].find(el => el.offsetParent !== null && el.textContent?.trim() === "切换服务器")
    if (!b) return false
    b.click(); return true
  })()`)
  if (!cmd) return { step: "command", ok: false }
  await sleep(1200)
  const dialog = await cdp.evalJs(`[...document.querySelectorAll("input")].some(i => i.placeholder === "搜索服务器" && i.offsetParent !== null)`)
  if (!dialog) return { step: "dialog", ok: false }
  const row = await cdp.evalJs(`(() => {
    const rows = [...document.querySelectorAll("button")].filter(el => el.offsetParent !== null && el.textContent?.includes("${label}") && !el.textContent.includes("添加"))
    if (!rows.length) return false
    rows[0].click(); return true
  })()`)
  if (!row) return { step: "row", ok: false }
  await sleep(2500)
  return { step: "done", ok: true }
}
export const clickSession = (cdp: Cdp, id: string) => cdp.evalJs(`(() => {
  const a = [...document.querySelectorAll(".alpha-session-row a")].find(l => l.getAttribute("href")?.endsWith("${id}"))
  if (!a) return false
  a.click(); return true
})()`)
export const expandProj = (cdp: Cdp, name: string) => cdp.evalJs(`(() => {
  const t = [...document.querySelectorAll(".alpha-project")].find(p => p.querySelector(".alpha-project-name")?.textContent === "${name}")
  if (!t) return false
  if (!t.hasAttribute("data-expanded")) t.querySelector(".alpha-project-row").click()
  return true
})()`)
export const tcp14790 = () => Number(Bun.spawnSync(["sh", "-c", "lsof -nP -iTCP:14790 -sTCP:ESTABLISHED 2>/dev/null | grep -c Electron"]).stdout.toString().trim()) || 0
