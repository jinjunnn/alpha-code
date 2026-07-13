// 残留清理(app 存活期内):删测试会话(引擎 API)→ localStorage 审计/清闸 → reload 复核 legacy 缺省。
import { connect, sidecarInfo, engineApi, sleep, saveJson, PROJ } from "./lib"
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
let cdp = await connect()
const info = await sidecarInfo(cdp)
const api = engineApi(info.url, info.auth, PROJ)

// 1) 删测试会话(B 已在 V4 流程删除)
const results: Record<string, string> = {}
for (const id of [setup.sessionA, "ses_0a4f30807ffeccsAc29JUhCIEY"]) {
  try {
    await api(`/session/${id}`, { method: "DELETE" })
    results[id] = "deleted"
  } catch (e) {
    results[id] = String(e).slice(0, 100)
  }
}
const remaining = await api("/session")
console.log("session deletes:", JSON.stringify(results), "remaining:", remaining.length)

// 2) localStorage 审计 + 清理
const ls = await cdp.evalJs(`(() => {
  const out = { removed: [], modelV1Hits: [], composerModel: localStorage.getItem("alpha.composer.model"), keys: [] }
  const toRemove = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    const v = localStorage.getItem(k) ?? ""
    if (k === "ALPHA_SESSION_SPIKE") toRemove.push(k)
    if (k.startsWith("alpha-cmd:")) toRemove.push(k)
    if (v.includes("scripted")) out.modelV1Hits.push({ key: k, sample: v.slice(0, 200) })
  }
  for (const k of toRemove) { localStorage.removeItem(k); out.removed.push(k) }
  return out
})()`)
console.log("localStorage audit:", JSON.stringify(ls, null, 2))

// 3) model.v1 scripted 残留:从 recent/user 数组剔除 scripted 条目(保持其余原样)
const scrub = await cdp.evalJs(`(() => {
  const out = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    const v = localStorage.getItem(k) ?? ""
    if (!v.includes("scripted") || !k.includes("model")) continue
    try {
      const parsed = JSON.parse(v)
      const scrubArr = (a) => Array.isArray(a) ? a.filter(x => !JSON.stringify(x).includes("scripted")) : a
      if (parsed.user) parsed.user = scrubArr(parsed.user)
      if (parsed.recent) parsed.recent = scrubArr(parsed.recent)
      localStorage.setItem(k, JSON.stringify(parsed))
      out.push({ key: k, after: localStorage.getItem(k)?.slice(0, 150) })
    } catch { out.push({ key: k, error: "not json" }) }
  }
  return out
})()`)
console.log("model.v1 scrub:", JSON.stringify(scrub, null, 2))

// 4) reload → 复核缺省态(闸关 ⇒ legacy 叶,无探针,无 workspace)
await cdp.evalJs(`location.reload()`).catch(() => {})
await sleep(9000)
cdp.close()
cdp = await connect()
const final = await cdp.evalJs(`(async () => ({
  spike: localStorage.getItem("ALPHA_SESSION_SPIKE"),
  probe: !!window.__req087Spike,
  workspace: !!document.querySelector("[data-alpha-session-workspace]"),
  mode: (await window.api.surfaces.resolve()).session,
  scriptedResidue: (() => { let n = 0; for (let i = 0; i < localStorage.length; i++) { if ((localStorage.getItem(localStorage.key(i)) ?? "").includes("scripted")) n++ } return n })(),
  composerModel: localStorage.getItem("alpha.composer.model")?.slice(0, 80),
}))()`)
console.log("final state:", JSON.stringify(final, null, 2))
await saveJson("90-cleanup", { sessionDeletes: results, remainingSessions: remaining.length, ls, scrub, final })
cdp.close()
