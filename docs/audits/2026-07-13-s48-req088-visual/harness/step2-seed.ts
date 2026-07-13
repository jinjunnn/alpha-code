// 种子:长名项目下建会话 A(P2/P3 live 轮次目标)与 B(P6 切换对手),B 经引擎公开
// /session/:id/shell 种 2 条真实 bash 轮次(C4 同款方式)。随后经初始 URL 进入会话 A。
import { connect, sidecarInfo, engineApi, encodeDir, sleep, saveJson, PROJ } from "./lib"
const cdp = await connect()
const info = await sidecarInfo(cdp)
const api = engineApi(info.url, info.auth, PROJ)
const a = await api("/session", { method: "POST", body: JSON.stringify({ title: "REQ-088 visual probe A" }) })
const b = await api("/session", { method: "POST", body: JSON.stringify({ title: "REQ-088 visual probe B" }) })
console.log("sessions:", a.id, b.id)
for (let i = 0; i < 2; i++)
  await api(`/session/${b.id}/shell`, {
    method: "POST",
    body: JSON.stringify({ agent: "build", command: `echo req088-b-${i}` }),
  })
console.log("seeded 2 shell turns into B")
const cmds = await api(`/command`)
console.log("commands:", Array.isArray(cmds) ? cmds.map((c: any) => c.name).join(",") : cmds)
await saveJson("00-setup", { proj: PROJ, sessionA: a.id, sessionB: b.id, sidecar: info.url, commands: Array.isArray(cmds) ? cmds.map((c: any) => c.name) : cmds })
await cdp.evalJs(`location.assign("http://localhost:5173/${encodeDir(PROJ)}/session/${a.id}")`).catch(() => {})
await sleep(8000)
const st = await cdp.evalJs(`(() => ({
  workspace: !!document.querySelector("[data-alpha-session-workspace]"),
  chrome: document.querySelector("[data-alpha-session-workspace-chrome]")?.textContent ?? null,
  overlay: document.querySelector("[data-alpha-session-spike-overlay]")?.textContent ?? null,
  composers: document.querySelectorAll("[data-component=session-composer]").length,
  alphaComposer: !!document.querySelector("[data-alpha-composer=session]"),
}))()`)
console.log(JSON.stringify(st, null, 2))
cdp.close()
