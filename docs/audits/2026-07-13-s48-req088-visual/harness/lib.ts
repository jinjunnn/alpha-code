// REQ-088 S48 收官取证(T6 探针矩阵 P1–P6 + T2 §4 视觉验收)CDP driver 库。
// 沿用 C4 harness(docs/audits/2026-07-13-s48-req088-c4/harness/lib.ts)的裸 WebSocket CDP 形态,
// 增补:Input.dispatchKeyEvent(P4 mod+')、alpha composer 输入/发送、探针快照适配 pendingSamples
// 新口径(T2 §2.1)。只取证不改产品代码。
export const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-visual"

export interface Cdp {
  send: (method: string, params?: any) => Promise<any>
  evalJs: (expression: string) => Promise<any>
  shot: (name: string) => Promise<void>
  close: () => void
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function connect(): Promise<Cdp> {
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json()
  const page = targets.find((t: any) => t.type === "page")
  if (!page) throw new Error("no CDP page target — is the dev app running?")
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
    }
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
    if (r?.exceptionDetails)
      throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r?.result?.value
  }
  const shot = async (name: string) => {
    const s = await send("Page.captureScreenshot", { format: "png" })
    if (s?.data) await Bun.write(`${AUDIT}/${name}.png`, Buffer.from(s.data, "base64"))
    console.log(`  [shot] ${name}.png`)
  }
  return { send, evalJs, shot, close: () => ws.close() }
}

/** mod+'(model.choose)—— 经 CDP Input 发真实键事件(上游 keybind 面)。 */
export async function pressMeta(cdp: Cdp, key: string, code: string) {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers: 4 })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: 4 })
}

/** Sidecar(内嵌本地引擎)base url + Basic auth,从 renderer 读取。 */
export async function sidecarInfo(cdp: Cdp): Promise<{ url: string; auth: string }> {
  const info = await cdp.evalJs(`window.api.awaitInitialization()`)
  const cred = btoa(`${info.username ?? ""}:${info.password ?? ""}`)
  return { url: info.url, auth: `Basic ${cred}` }
}

export function engineApi(base: string, auth: string | undefined, directory: string) {
  return async (path: string, init?: RequestInit) => {
    const sep = path.includes("?") ? "&" : "?"
    const res = await fetch(`${base}${path}${sep}directory=${encodeURIComponent(directory)}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
        ...(init?.headers ?? {}),
      },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

/** P1 四断言(T6 §5)——两模式共用同一取数口径。 */
export const P1_EXPR = `(() => ({
  takeoverFlag: document.body.hasAttribute("data-alpha-composer-takeover"),
  visibleHosts: [...document.querySelectorAll("[data-alpha-composer-host]")].filter(h => h.offsetParent !== null).length,
  upstreamComposerDisplay: (() => { const c = document.querySelector("[data-component=session-composer]"); return c ? getComputedStyle(c).display : null })(),
  alphaComposerInHost: !!document.querySelector("[data-alpha-composer-host] [data-alpha-composer=session]"),
}))()`

/** P3 装饰计数(T6 §5)。 */
export const P3_EXPR = `(() => ({
  tcIco: document.querySelectorAll("[data-alpha-tc-ico]").length,
  aExitOk: document.querySelectorAll(".a-exit[data-ok]").length,
  turnDiv: document.querySelectorAll(".a-turn-div").length,
  userMessages: document.querySelectorAll("[data-component=user-message]").length,
  sessionTurns: document.querySelectorAll("[data-component='session-turn']").length,
  dirgrid: !!document.querySelector("[data-alpha-dirgrid]"),
  cmdChips: document.querySelectorAll(".a-cmd-chip").length,
  toolOutputs: document.querySelectorAll("[data-component='tool-output']").length,
}))()`

/** 探针快照(pendingSamples 新口径,T2 §2.1)。 */
export const PROBE_EXPR = `(() => {
  const p = window.__req087Spike
  if (!p) return { present: false }
  const samples = p.samples()
  return { present: true, summary: p.summary(), latest: samples[samples.length - 1], count: samples.length }
})()`

/** 经 AlphaComposer 输入并回车发送(Solid 委托事件,合成事件即可触达)。 */
export const typeAndSend = (text: string) => `(() => {
  const ta = document.querySelector("[data-alpha-composer=session] textarea.a-comp-input")
  if (!ta) return { ok: false, reason: "alpha composer textarea not found" }
  ta.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set
  setter.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new InputEvent("input", { bubbles: true }))
  setTimeout(() => {
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  }, 120)
  return { ok: true }
})()`

export const encodeDir = (d: string) => {
  const bytes = new TextEncoder().encode(d)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export async function saveJson(name: string, data: unknown) {
  await Bun.write(`${AUDIT}/${name}.json`, JSON.stringify(data, null, 2))
  console.log(`  [json] ${name}.json`)
}

// 注:首版无 .git 的目录被引擎归入 "global" 项目(project.list 不含之,侧栏不显示)——
// 换 git 初始化过的同长度目录重种,首版两条会话已删(见 00-setup.json.discarded)。
export const PROJ =
  "/private/tmp/claude-501/-Users-tide-app-alpha-work/086589b3-5d06-4913-986d-f9aa383e393a/scratchpad/visual/req088-visual-project-with-extremely-long-basename-for-chrome-truncation-check-part-two"
