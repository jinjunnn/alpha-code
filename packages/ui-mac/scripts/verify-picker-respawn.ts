// REQ-083 模型选择框 respawn 竞态 —— 可重复真机验收 harness(2026-07-12 从会话 scratchpad 固化进仓)。
//
// 为什么在仓库里:真机验证 PASS 只对当天有效;脚本进仓 + 断言硬失败,后续任何改动(上游 sync /
// renderer 重构)都能低成本复跑,不再依赖某次会话的临时产物(S39 复盘病灶 1)。
//
// 用法:
//   1. `bun run --cwd packages/ui-mac dev` 起 dev 实例(CDP 9222 默认开),登录态 + 至少一个已配置 BYOK
//   2. `bun packages/ui-mac/scripts/verify-picker-respawn.ts [截图输出目录]`
//   任一断言 FAIL → 退出码 1。会真杀/重启 sidecar,勿在别人正用的实例上跑(破坏性测试先告知,病灶 5)。
//
// 阶段(异步取数四态全覆盖:成功 / 失败 / 悬挂 / 恢复):
//   0 基线健康 → 1 注入 reject(Failed to fetch)→ 2 故障态点灰行零 respawn/reload →
//   3 解除 → 同一弹窗自愈 → 4 注入「悬挂」(响应永不来,尊重 abort signal)→ 超时转 stalled
//   note → 解除 → 自愈 → 5 真杀 sidecar 重复 1+2 → 6 retrySidecar 恢复 → 收敛回基线(轮询,非定时快照)。

const AUDIT = process.argv[2] ?? `/tmp/req083-verify-${Date.now()}`
await Bun.$`mkdir -p ${AUDIT}`.quiet()
let failures = 0
const assert = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`  assert ${name}: ${ok ? "PASS" : "FAIL"}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`)
  if (!ok) failures++
}

const targets = await (await fetch("http://127.0.0.1:9222/json")).json()
const page = targets.find((t: any) => t.type === "page")
if (!page) throw new Error("no CDP page target — is the dev app running?")
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map<number, (v: any) => void>()
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result)
    pending.delete(msg.id)
  }
}
const send = (method: string, params: any = {}) =>
  new Promise<any>((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await new Promise((r) => (ws.onopen = r))
const evalJs = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r?.result?.value
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shot = async (name: string) => {
  const s = await send("Page.captureScreenshot", { format: "png" })
  if (s?.data) await Bun.write(`${AUDIT}/${name}.png`, Buffer.from(s.data, "base64"))
  console.log(`  📸 ${name}.png`)
}
const openPicker = async () => {
  await evalJs(`document.querySelector(".a-mpp") || document.querySelector(".a-chip-model")?.click()`)
  await sleep(600)
}
const closePicker = async () => {
  await evalJs(`document.querySelector(".a-mpp") && document.querySelector(".a-chip-model")?.click()`)
  await sleep(300)
}
const pickerState = () =>
  evalJs(`(() => {
    const pop = document.querySelector(".a-mpp")
    if (!pop) return { open: false }
    const items = Array.from(pop.querySelectorAll(".a-pop-item"))
    return {
      open: true,
      note: Array.from(pop.querySelectorAll(".a-pop-note")).map((n) => n.textContent.trim().slice(0, 30)),
      locked: items.filter((el) => el.className.includes("locked")).length,
      unlocked: items.filter((el) => el.className.includes("a-mpp-row") && !el.className.includes("locked") && !el.className.includes("needkey") && !el.className.includes("pending") && !el.className.includes("addrow")).length,
      pendingRows: items.filter((el) => el.className.includes("a-mpp-pending")).length,
      byokModels: items.filter((el) => /deepseek-|glm-/.test(el.textContent) && (el.textContent.includes("DeepSeek") || el.textContent.includes("智谱"))).length,
    }
  })()`)
const waitFor = async (pred: (st: any) => boolean, seconds: number) => {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000)
    const st = await pickerState()
    if (pred(st)) return st
  }
  return await pickerState()
}
// 故障注入器:mode = "off" | "reject" | "hang"。hang 尊重 abort signal(如实模拟真 fetch 被
// AbortSignal.timeout 中止),否则测不到「超时转可重试失败」这条链。
const installInjector = () =>
  evalJs(`(() => {
    if (window.__req083_mode !== undefined) return "already"
    const of = window.fetch.bind(window)
    window.__req083_mode = "off"
    window.fetch = (...a) => {
      const u = String(a[0] instanceof Request ? a[0].url : a[0])
      if (u.includes("/config/providers")) {
        if (window.__req083_mode === "reject") return Promise.reject(new TypeError("Failed to fetch (staged outage)"))
        if (window.__req083_mode === "hang")
          return new Promise((_, rej) => {
            const s = a[1]?.signal ?? (a[0] instanceof Request ? a[0].signal : undefined)
            if (s) s.addEventListener("abort", () => rej(s.reason ?? new DOMException("aborted", "AbortError")), { once: true })
          })
      }
      return of(...a)
    }
    return "installed"
  })()`)
const setMode = (m: string) => evalJs(`(window.__req083_mode = "${m}")`)

console.log("== stage 0: baseline (healthy engine) ==")
// app 冷启动:等 composer(.a-chip-model)挂载完再开测,否则首次 openPicker 点空
for (let i = 0; i < 30; i++) {
  if (await evalJs(`!!document.querySelector(".a-chip-model")`)) break
  await sleep(1000)
}
await evalJs(`window.__req083_marker = "alive"`)
await installInjector()
await openPicker()
let st = await waitFor((s) => s.open && s.unlocked > 0 && s.byokModels > 0, 15)
console.log(JSON.stringify(st))
assert("baseline: rows selectable + BYOK visible + no note", st.open && st.unlocked > 0 && st.byokModels > 0 && st.note.length === 0, st)
await shot("01-baseline")

console.log("== stage 1: staged reject outage ==")
await closePicker()
await setMode("reject")
await openPicker()
st = await waitFor((s) => s.note?.length > 0, 8)
assert("reject: honest note", st.note.length > 0, st.note)
assert("reject: configured-BYOK placeholder rows", st.pendingRows >= 2, st.pendingRows)
assert("reject: proxy rows locked", st.locked > 0, st.locked)
await shot("02-reject-outage")

console.log("== stage 2: click locked row during outage — zero respawn/reload ==")
await evalJs(`document.querySelector(".a-mpp .a-mpp-row.locked")?.click()`)
await sleep(3000)
assert("locked click: page not reloaded", (await evalJs(`window.__req083_marker`)) === "alive")
assert("locked click: popup still open", (await pickerState()).open)

console.log("== stage 3: lift reject — same-popup self-heal ==")
await setMode("off")
st = await waitFor((s) => s.open && s.byokModels > 0 && s.note.length === 0, 12)
assert("self-heal without reopening", st.open && st.byokModels > 0 && st.note.length === 0, st)
await shot("03-self-healed")

console.log("== stage 4: HANG outage (2026-07-12 blind spot) — timeout must convert to stalled+retry ==")
await closePicker()
await setMode("hang")
await openPicker()
// ENGINE_FETCH_TIMEOUT_MS(10s)+ 首个退避 1s + 余量:note 必须在 ~15s 内出现
st = await waitFor((s) => s.note?.length > 0, 16)
assert("hang: honest note appears after timeout (not silent-gray)", st.note.length > 0, st)
assert("hang: configured-BYOK placeholder rows", st.pendingRows >= 2, st.pendingRows)
await shot("04-hang-outage-honest")
await setMode("off")
st = await waitFor((s) => s.open && s.byokModels > 0 && s.note.length === 0, 25)
assert("hang lifted: same-popup self-heal", st.open && st.byokModels > 0 && st.note.length === 0, st)
await shot("05-hang-self-healed")

console.log("== stage 5: real dead server (killSidecar) ==")
await closePicker()
await evalJs(`window.api.killSidecar()`)
await sleep(1500)
await openPicker()
st = await waitFor((s) => s.note?.length > 0, 16)
assert("real outage: honest note + placeholders", st.note.length > 0 && st.pendingRows >= 2, st)
await evalJs(`document.querySelector(".a-mpp .a-mpp-row.locked")?.click()`)
await sleep(3000)
assert("real outage: locked click did not respawn/reload", (await evalJs(`window.__req083_marker`)) === "alive")
await shot("06-real-outage-honest")

console.log("== stage 6: restore (retrySidecar → respawn+reload expected) — converge to baseline ==")
await evalJs(`window.api.retrySidecar()`)
await sleep(9000) // respawn + renderer reload(injector/marker 随 reload 消失,属预期)
await evalJs(`document.querySelector(".a-chip-model")?.click()`)
// 收敛轮询而非定时快照:respawn 后引擎暖机时长不定(2026-07-12 复盘:定时快照会把暖机误判为回归)
st = await waitFor((s) => s.open && s.unlocked > 0 && s.byokModels > 0 && s.note.length === 0, 45)
assert("restored baseline (rows selectable + BYOK back)", st.open && st.unlocked > 0 && st.byokModels > 0 && st.note.length === 0, st)
await shot("07-restored-baseline")

ws.close()
console.log(failures === 0 ? "\n✅ all assertions PASS" : `\n❌ ${failures} assertion(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
