import { connect, sleep } from "./lib"
const cdp = await connect()
for (const name of ["proj-a", "proj-b"]) {
  const menu = await cdp.evalJs(`(() => {
    const t = [...document.querySelectorAll(".alpha-project")].find(p => p.querySelector(".alpha-project-name")?.textContent === "${name}")
    if (!t) return { found: false }
    const btn = t.querySelector(".alpha-project-action")
    if (!btn) return { found: true, action: false }
    btn.click(); return { found: true, action: true }
  })()`)
  console.log(name, "menu:", JSON.stringify(menu))
  await sleep(1000)
  const arch = await cdp.evalJs(`(() => {
    const items = [...document.querySelectorAll("button, [role=menuitem]")].filter(e => e.offsetParent !== null && e.textContent?.trim() === "归档")
    if (!items.length) return false
    items[0].click(); return true
  })()`)
  console.log(name, "archive clicked:", arch)
  await sleep(1500)
}
const left = await cdp.evalJs(`[...document.querySelectorAll(".alpha-project .alpha-project-name")].map(e => e.textContent)`)
console.log("sidebar projects now:", JSON.stringify(left))
cdp.close()
