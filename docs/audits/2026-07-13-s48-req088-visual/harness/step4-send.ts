// P2(发送链路)+ P3 前置(种 bash/read/edit live 轮次,经 scripted fixture 的真实引擎工具执行)。
// 全部经 AlphaComposer 真实输入面;权限先经 PermChip 切「完全访问」(引擎 autoaccept)。
import { connect, sleep, saveJson, typeAndSend, PROJ } from "./lib"
const cdp = await connect()

// 0) 权限:PermChip → 完全访问(真实 UI 点击;触发上游 permissions.autoaccept.enable)
const perm = await cdp.evalJs(`(() => {
  const chip = document.querySelector("[data-alpha-composer=session] .a-chip-perm")
  if (!chip) return { ok: false, reason: "perm chip missing" }
  chip.click()
  return { ok: true, mode: chip.getAttribute("data-mode") }
})()`)
console.log("perm chip open:", JSON.stringify(perm))
await sleep(600)
const pick = await cdp.evalJs(`(() => {
  const item = [...document.querySelectorAll(".a-pop-item")].find(b => b.textContent?.includes("完全访问"))
  if (!item) return { ok: false }
  item.click(); return { ok: true }
})()`)
console.log("perm -> full:", JSON.stringify(pick))
await sleep(800)
const permAfter = await cdp.evalJs(
  `document.querySelector("[data-alpha-composer=session] .a-chip-perm")?.getAttribute("data-mode")`,
)
console.log("perm mode now:", permAfter)
const model = await cdp.evalJs(
  `document.querySelector("[data-alpha-composer=session] .a-chip-model .a-chip-label")?.textContent`,
)
console.log("composer model:", model)
if (!/scripted/.test(String(model))) throw new Error("composer model is NOT scripted — abort before any real send")

const counts = () =>
  cdp.evalJs(`(() => ({
    userMsgs: document.querySelectorAll("[data-component=user-message]").length,
    toolTriggers: document.querySelectorAll("[data-component='tool-trigger']").length,
    ctxGroups: document.querySelectorAll("[data-component='context-tool-group-trigger']").length,
    busy: !!document.querySelector("[data-alpha-composer=session] .a-comp-stop"),
  }))()`)

async function sendAndSettle(text: string, label: string) {
  const before = await counts()
  const r = await cdp.evalJs(typeAndSend(text))
  if (!r.ok) throw new Error(`${label}: ${r.reason}`)
  await sleep(1200)
  const focusAfterSend = await cdp.evalJs(
    `document.activeElement?.classList?.contains("a-comp-input") ?? false`,
  )
  // 等引擎收敛(忙态消失且 user-message 增加),上限 30s
  let after = await counts()
  for (let i = 0; i < 30 && (after.busy || after.userMsgs <= before.userMsgs); i++) {
    await sleep(1000)
    after = await counts()
  }
  const out = { label, before, after, focusAfterSend, deltaUser: after.userMsgs - before.userMsgs }
  console.log(JSON.stringify(out))
  return out
}

const s1 = await sendAndSettle("SCRIPT:tool-bash:echo req088-visual-probe", "send1-bash")
await sleep(2000)
const s2 = await sendAndSettle(`看看目录 SCRIPT:tool-read:${PROJ}/docs-dir`, "send2-read-dir")
await sleep(2000)
const s3 = await sendAndSettle(
  `SCRIPT:tool-edit:${PROJ}/notes.txt|REQ-088 visual probe line|REQ-088 visual probe line (edited)`,
  "send3-edit",
)
await sleep(2000)
const notes = await Bun.file(`${PROJ}/notes.txt`).text()
console.log("notes.txt after edit:", JSON.stringify(notes))
await saveJson("20-p2-sends", { sends: [s1, s2, s3], notesAfterEdit: notes })
await cdp.shot("20-p2-after-sends")
cdp.close()
