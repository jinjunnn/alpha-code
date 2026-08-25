// alpha-code#402 —— 取证用**裸 socket** HTTP/1.1 origin(独立进程)。
//
// 为什么不用 Bun.serve(第一版就是,已被实测推翻):
//   · 给 ReadableStream 响应手写 `content-length` 时,Bun **不照发** —— 实测客户端侧收到的是
//     `declared unknown`,也就是「超大 Content-Length」这个条件**根本没被造出来**,
//     而那一格当时看起来是绿的(它走的是 chunked 越界 abort 那条分支);
//   · 响应流的 `cancel()` 在客户端断读时不必然触发 ⇒ 「上游有没有被 cancel」这个观测量恒为 0;
//   · 客户端停读之后 Bun 仍把剩下的字节灌完 ⇒ 「abort 之后 origin 还发了多少」量不出来。
// 三条都属于「观测手段自己是坏的」。裸 socket 把这三件事变成可直接读的事实:
// 头部逐字节由本文件写出、`socket.bytesWritten` 是真的出口字节、客户端断开会给出 close/error。
//
// 启动:bun origin-raw.ts <fixtureDir>  → stdout 一行 {"port":N}
// 内容路由:GET /v1/cloud/artifacts/<k_v--k_v...>/content   (平台契约不允许 query,故参数走路径段)
//   file=<name> mode=normal|chunked|declare|reset|stall|slice status=<n>
//   declare=<n>  写进 Content-Length 的**声明**值(可与实际字节数不符 —— 撒谎臂)
//   total=<n>    实际发送的字节数(循环读 fixture)
//   actual=<n>   只发前 n 字节
//   after=<n>    reset/stall:发够 n 字节后重置连接 / 永久静默
//   chunk=<n>    每次 write 的字节数   delayMs=<n> 每块之间的间隔
//   etag/digest  原样写进响应头(值里的 `~` 会被还原成 `"`)
// 控制面:GET /__stats?probe=<id> · POST /__canned {path,status,body} · POST /__reset
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

const fixtureDir = process.argv[2]
if (!fixtureDir) throw new Error("usage: bun origin-raw.ts <fixtureDir>")

type Stat = {
  requests: number
  /** 真正写进 socket 并被内核收下的字节(不是「打算发多少」)。 */
  written: number
  /** 本次响应的 body 还没写完,客户端就把连接断了 —— 这就是「上游被 cancel」的可观测形态。 */
  clientAbortedEarly: number
  /** 客户端断开时,body 已经写出去多少字节。 */
  writtenAtAbort: number[]
  authorizations: string[]
  ranges: (string | null)[]
  statuses: number[]
  declaredContentLength: (string | null)[]
}
const stats = new Map<string, Stat>()
const stat = (id: string): Stat => {
  let s = stats.get(id)
  if (!s) {
    s = {
      requests: 0, written: 0, clientAbortedEarly: 0, writtenAtAbort: [],
      authorizations: [], ranges: [], statuses: [], declaredContentLength: [],
    }
    stats.set(id, s)
  }
  return s
}
const canned = new Map<string, { status: number; body: string }>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function writeAsync(sock: net.Socket, buf: Buffer | string): Promise<boolean> {
  return new Promise((resolve) => {
    if (sock.destroyed) return resolve(false)
    const ok = sock.write(buf, (err) => {
      if (err) resolve(false)
    })
    if (ok) return resolve(true)
    const onDrain = () => { cleanup(); resolve(true) }
    const onClose = () => { cleanup(); resolve(false) }
    const cleanup = () => {
      sock.off("drain", onDrain)
      sock.off("close", onClose)
      sock.off("error", onClose)
    }
    sock.on("drain", onDrain)
    sock.once("close", onClose)
    sock.once("error", onClose)
  })
}

type Req = { method: string; target: string; headers: Record<string, string> }

function parseRequest(text: string): Req | null {
  const [head, ...rest] = text.split("\r\n")
  const m = /^(\w+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(head ?? "")
  if (!m) return null
  const headers: Record<string, string> = {}
  for (const line of rest) {
    if (!line) break
    const i = line.indexOf(":")
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { method: m[1], target: m[2], headers }
}

function paramsOf(target: string): { pathname: string; q: URLSearchParams } {
  const u = new URL(target, "http://x")
  const q = new URLSearchParams(u.searchParams)
  const seg = u.pathname.split("/")
  const encoded = seg.length >= 6 && seg[5] === "content" ? seg[4] : ""
  if (encoded.includes("_")) {
    for (const pair of encoded.split("--")) {
      const i = pair.indexOf("_")
      if (i > 0) q.set(pair.slice(0, i), pair.slice(i + 1))
    }
  }
  return { pathname: u.pathname, q }
}

async function respondJson(sock: net.Socket, status: number, body: string) {
  const buf = Buffer.from(body, "utf8")
  await writeAsync(
    sock,
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\ncontent-type: application/json\r\ncontent-length: ${buf.byteLength}\r\nconnection: close\r\n\r\n`,
  )
  await writeAsync(sock, buf)
  sock.end()
}

async function handle(sock: net.Socket, req: Req, bodyText: string) {
  const { pathname, q } = paramsOf(req.target)

  if (pathname === "/__stats") {
    const id = new URL(req.target, "http://x").searchParams.get("probe") ?? "default"
    return respondJson(sock, 200, JSON.stringify(stat(id)))
  }
  if (pathname === "/__reset") {
    stats.clear()
    canned.clear()
    return respondJson(sock, 200, JSON.stringify({ ok: true }))
  }
  if (pathname === "/__canned" && req.method === "POST") {
    const spec = JSON.parse(bodyText) as { path: string; status: number; body: string }
    canned.set(spec.path, { status: spec.status, body: spec.body })
    return respondJson(sock, 200, JSON.stringify({ ok: true }))
  }
  const hit = canned.get(pathname)
  if (hit) {
    const s = stat("control")
    s.requests++
    s.authorizations.push(req.headers["authorization"] ?? "")
    s.statuses.push(hit.status)
    return respondJson(sock, hit.status, hit.body)
  }
  if (!pathname.startsWith("/v1/cloud/artifacts/")) return respondJson(sock, 404, `{"error":"no route"}`)

  const id = q.get("probe") ?? "default"
  const s = stat(id)
  s.requests++
  s.authorizations.push(req.headers["authorization"] ?? "")
  s.ranges.push(req.headers["range"] ?? null)

  const forced = Number(q.get("status") ?? "0")
  if (forced) {
    s.statuses.push(forced)
    s.declaredContentLength.push(null)
    return respondJson(sock, forced, `{"error":"forced ${forced}"}`)
  }

  const file = q.get("file")
  if (!file) return respondJson(sock, 400, `{"error":"missing file"}`)
  const full = path.join(fixtureDir, path.basename(file))
  const fileSize = fs.statSync(full).size
  const mode = q.get("mode") ?? "normal"
  const chunk = Number(q.get("chunk") ?? 65536)
  const delayMs = Number(q.get("delayMs") ?? 0)
  const after = q.get("after") != null ? Number(q.get("after")) : undefined
  const total = q.get("total") != null ? Number(q.get("total")) : undefined
  const actual = q.get("actual") != null ? Number(q.get("actual")) : undefined

  // Range(mode=slice 时支持;其余模式明确忽略 Range 并回 200 全量)
  let start = 0
  let end = fileSize - 1
  let partial = false
  const rangeHeader = req.headers["range"]
  if (mode === "slice" && rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
    if (m) {
      start = Number(m[1])
      end = m[2] ? Number(m[2]) : fileSize - 1
      partial = true
    }
  }

  const bodyBytes = total ?? (actual !== undefined ? Math.min(actual, end - start + 1) : end - start + 1)
  const declared = mode === "declare" ? Number(q.get("declare")) : partial ? end - start + 1 : bodyBytes
  const status = partial ? 206 : 200
  s.statuses.push(status)

  const lines = [`HTTP/1.1 ${status} ${partial ? "Partial Content" : "OK"}`, "content-type: application/octet-stream", "connection: close"]
  const unquote = (v: string) => v.replace(/~/g, '"')
  if (q.get("etag")) lines.push(`etag: ${unquote(q.get("etag")!)}`)
  if (q.get("digest")) lines.push(`digest: ${unquote(q.get("digest")!)}`)
  if (partial) lines.push(`content-range: bytes ${start}-${end}/${fileSize}`)
  if (mode === "chunked") {
    lines.push("transfer-encoding: chunked")
    s.declaredContentLength.push(null)
  } else {
    lines.push(`content-length: ${declared}`)
    s.declaredContentLength.push(String(declared))
  }
  await writeAsync(sock, `${lines.join("\r\n")}\r\n\r\n`)

  const fd = fs.openSync(full, "r")
  const buf = Buffer.allocUnsafe(chunk)
  let offset = start
  let sent = 0
  let aborted = false
  let bodyDone = false
  // 「客户端把连接掐了」必须在 socket 关闭的**那一刻**记账。放在 finally 里记 = 依赖 handler
  // 能跑完,而 handler 恰恰可能正卡在一个永远不会 drain 的 write 上(实测:k5 那条从未走到 finally)。
  sock.once("close", () => {
    if (bodyDone) return
    s.clientAbortedEarly++
    s.writtenAtAbort.push(sent)
    bodyDone = true
  })
  try {
    while (sent < bodyBytes) {
      if (sock.destroyed) { aborted = true; break }
      if (mode === "reset" && after !== undefined && sent >= after) {
        sock.destroy() // 真的把连接掐掉 —— 客户端会看到一个断流,不是一个干净的 EOF
        return
      }
      if (mode === "stall" && after !== undefined && sent >= after) {
        await sleep(3_600_000)
        return
      }
      if (offset >= fileSize) offset = 0
      const want = Math.min(chunk, bodyBytes - sent, fileSize - offset)
      const n = fs.readSync(fd, buf, 0, want, offset)
      if (n <= 0) break
      offset += n
      const piece = buf.subarray(0, n)
      const payload =
        mode === "chunked" ? Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), piece, Buffer.from("\r\n")]) : piece
      const ok = await writeAsync(sock, payload)
      if (!ok) { aborted = true; break }
      sent += n
      s.written += n
      if (delayMs) await sleep(delayMs)
    }
    if (!aborted && mode === "chunked") await writeAsync(sock, "0\r\n\r\n")
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
    if (!bodyDone && (aborted || sent < bodyBytes)) {
      s.clientAbortedEarly++
      s.writtenAtAbort.push(sent)
    }
    bodyDone = true
    if (process.env.ALPHA_402_ORIGIN_DEBUG)
      process.stderr.write(`[origin] probe=${id} sent=${sent}/${bodyBytes} aborted=${aborted} destroyed=${sock.destroyed}\n`)
    sock.end()
  }
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true)
  let buffer = Buffer.alloc(0)
  let handled = false
  sock.on("error", () => { /* 客户端断开是本探针的正常观测量 */ })
  sock.on("data", (d) => {
    if (handled) return
    buffer = Buffer.concat([buffer, d])
    const i = buffer.indexOf("\r\n\r\n")
    if (i < 0) return
    const head = buffer.subarray(0, i).toString("utf8")
    const req = parseRequest(head)
    if (!req) { sock.destroy(); return }
    const contentLength = Number(req.headers["content-length"] ?? "0")
    const bodyStart = i + 4
    if (buffer.byteLength - bodyStart < contentLength) return // 等 body 收全
    handled = true
    const bodyText = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8")
    void handle(sock, req, bodyText).catch(() => sock.destroy())
  })
})

server.listen(0, "127.0.0.1", () => {
  const addr = server.address() as net.AddressInfo
  process.stdout.write(`${JSON.stringify({ port: addr.port })}\n`)
})
