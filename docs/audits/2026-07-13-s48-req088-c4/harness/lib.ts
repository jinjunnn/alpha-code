// REQ-088 C4 forensic CDP driver library (bare WebSocket CDP, following
// packages/ui-mac/scripts/verify-picker-respawn.ts's established form).
export const AUDIT = "/Users/tide/app/alpha-code-s48/docs/audits/2026-07-13-s48-req088-c4"

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

/** Sidecar (embedded local engine) base url + Basic auth header, read from the renderer. */
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

/** Probe snapshot: spike summary + latest sample + PTY count + established TCP conns to sidecar. */
export async function probe(cdp: Cdp, sidecar: { url: string; auth: string }, dirForApi: string) {
  const spike = await cdp.evalJs(`(() => {
    const p = window.__req087Spike
    if (!p) return { present: false }
    const samples = p.samples()
    return { present: true, summary: p.summary(), latest: samples[samples.length - 1], count: samples.length }
  })()`)
  const api = engineApi(sidecar.url, sidecar.auth, dirForApi)
  let ptys: any[] = []
  try {
    ptys = (await api("/pty")) as any[]
  } catch (e) {
    ptys = [{ error: String(e) }]
  }
  const port = new URL(sidecar.url).port
  const conns = Bun.spawnSync(["sh", "-c", `lsof -nP -iTCP:${port} -sTCP:ESTABLISHED 2>/dev/null | grep -c ''`])
  const tcp = Number(conns.stdout.toString().trim()) || 0
  return { spike, ptyCount: Array.isArray(ptys) ? ptys.length : -1, ptys, tcpEstablished: tcp }
}

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
