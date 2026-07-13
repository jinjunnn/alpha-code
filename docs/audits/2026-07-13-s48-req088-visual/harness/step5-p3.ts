// P3(T6 §5):TimelineInject 装饰断言(adapter)+ O2 取证(/probe 经 alpha composer 发送后
// .a-cmd-chip 是否 +1)。目录 read 的 dirgrid 依赖 tool-output 在 DOM —— 先展开 context group。
import { connect, sleep, saveJson, typeAndSend, P3_EXPR } from "./lib"
const cdp = await connect()

// 1) 展开 context group(真实 UI 点击),使 read 轮次内容进 DOM
const expand = await cdp.evalJs(`(() => {
  const g = document.querySelector("[data-component='context-tool-group-trigger']")
  if (!g) return { ok: false }
  g.click(); return { ok: true }
})()`)
console.log("expand ctx group:", JSON.stringify(expand))
await sleep(1500)
const afterExpand = await cdp.evalJs(P3_EXPR)
console.log("P3 counts (ctx expanded):", JSON.stringify(afterExpand, null, 2))
// read 轮次的 tool-output 内容取证(上游 read 渲染器是否给出 <entries>)
const readDom = await cdp.evalJs(`(() => {
  const outs = [...document.querySelectorAll("[data-component='tool-output']")]
  return {
    toolOutputs: outs.length,
    outputsWithEntries: outs.filter(o => o.querySelector("entries")).length,
    firstOutputText: outs[0]?.textContent?.slice(0, 200) ?? null,
    readToolDom: document.querySelector("[data-component='tool-part-wrapper']") ? true : false,
    ctxGroupInner: (document.querySelector("[data-component='context-tool-group-trigger']")?.closest("[data-component]")?.parentElement?.textContent ?? "").slice(0, 150),
  }
})()`)
console.log("read DOM forensics:", JSON.stringify(readDom, null, 2))
// 2) 展开 bash tool 卡(触发器点开与否不影响 a-exit,但留证)
await cdp.shot("30-p3-decorations")

// 3) O2:/probe 经 alpha composer 发送(真实 slash 命令,session.command 路径)
const chipsBefore = await cdp.evalJs(`document.querySelectorAll(".a-cmd-chip").length`)
const userBefore = await cdp.evalJs(`document.querySelectorAll("[data-component=user-message]").length`)
const r = await cdp.evalJs(typeAndSend("/probe hello-o2-args"))
console.log("o2 send:", JSON.stringify(r))
let userAfter = userBefore
for (let i = 0; i < 30 && userAfter <= userBefore; i++) {
  await sleep(1000)
  userAfter = await cdp.evalJs(`document.querySelectorAll("[data-component=user-message]").length`)
}
await sleep(2500) // scanCommands 8s 窗口内的稳定期
const chipsAfter = await cdp.evalJs(`document.querySelectorAll(".a-cmd-chip").length`)
const lastUserText = await cdp.evalJs(`(() => {
  const us = [...document.querySelectorAll("[data-component=user-message]")]
  return us[us.length - 1]?.textContent?.slice(0, 200) ?? null
})()`)
const o2 = { chipsBefore, chipsAfter, userBefore, userAfter, lastUserText, chipDelta: chipsAfter - chipsBefore }
console.log("O2:", JSON.stringify(o2, null, 2))
const final = await cdp.evalJs(P3_EXPR)
console.log("P3 final counts:", JSON.stringify(final, null, 2))
await saveJson("30-p3-adapter", { afterExpand, readDom, o2, final })
await cdp.shot("31-p3-after-o2")
cdp.close()
