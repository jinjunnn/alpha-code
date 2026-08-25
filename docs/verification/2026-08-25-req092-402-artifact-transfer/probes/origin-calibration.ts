// alpha-code#402 —— **先标定 origin,再用它判产品**。
//
// 第一版 origin(Bun.serve)在这一步被推翻:它声称在发「超大 Content-Length」,
// 客户端实际收到的却是 `transfer-encoding: chunked`,于是「读 body 前拒绝」那一格
// 走的是**另一条分支**,而它看上去是绿的。本文件用一个与被测代码无关的朴素客户端,
// 逐条确认每个模式真的被造了出来。标定不过 ⇒ 本轮所有基于 origin 的判定作废。
import * as path from "node:path"
import { startOrigin } from "./harness"

const FIXTURES = process.env.ALPHA_402_FIXTURES!
const origin = await startOrigin(path.join(import.meta.dir, "origin-raw.ts"), FIXTURES)
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"

const seg = (p: Record<string, string | number>) =>
  `${origin.base}/v1/cloud/artifacts/${Object.entries(p).map(([k, v]) => `${k}_${v}`).join("--")}/content`

async function probe(label: string, url: string, opts: { readAll?: boolean; readBytes?: number; head?: boolean } = {}) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })
  const headers = Object.fromEntries([...res.headers.entries()])
  let read = 0
  let error: string | null = null
  if (opts.readAll || opts.readBytes) {
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        read += r.value.byteLength
        if (opts.readBytes && read >= opts.readBytes) {
          await reader.cancel()
          break
        }
      }
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  } else {
    try { await res.body?.cancel() } catch { /* nothing to cancel */ }
  }
  return { label, status: res.status, headers, read, error }
}

const stats = async (id: string) => (await (await fetch(`${origin.base}/__stats?probe=${id}`)).json()) as Record<string, unknown>

const out: Record<string, unknown> = {}

// ① 撒谎的 Content-Length 真的到得了客户端头上吗?
out.declaredLie = await probe("declare 200MiB, send 1MiB", seg({ file: "small.bin", probe: "k1", mode: "declare", declare: 209715200, total: 1048576 }))
// ② chunked 真的是 chunked 吗(客户端看不到 content-length)?
out.chunked = await probe("chunked", seg({ file: "small.bin", probe: "k2", mode: "chunked", total: 1048576 }), { readAll: true })
// ③ 正常 identity 传输,长度正确
out.normal = await probe("normal 3MiB", seg({ file: "small.bin", probe: "k3" }), { readAll: true })
// ④ 中途重置连接:客户端必须**抛错**,而不是拿到一个干净的 EOF
out.reset = await probe("reset after 512KiB", seg({ file: "big100.bin", probe: "k4", mode: "reset", after: 524288, total: 8388608 }), { readAll: true })
// ⑤ 客户端**真的断开连接** ⇒ origin 必须观测到 clientAbortedEarly。
//    这里刻意用裸 socket 客户端,不用 fetch:实测 bun 的 fetch 在 reader.cancel() 之后
//    仍会把整条响应吸完(origin 侧 written = 全量、abort 计数 0)——
//    也就是说「客户端停读」这件事,用 fetch 当标定客户端是**测不出来**的。
out.earlyStop = await (async () => {
  const url = new URL(seg({ file: "big100.bin", probe: "k5", total: 104857600, chunk: 65536 }))
  return new Promise<{ read: number; destroyed: boolean }>((resolve) => {
    const net = require("node:net") as typeof import("node:net")
    const sock = net.connect(Number(url.port), url.hostname, () => {
      sock.write(`GET ${url.pathname} HTTP/1.1\r\nhost: ${url.host}\r\nauthorization: Bearer ${TOKEN}\r\nconnection: close\r\n\r\n`)
    })
    let read = 0
    sock.on("data", (d: Buffer) => {
      read += d.byteLength
      if (read >= 1048576) {
        sock.destroy()
        resolve({ read, destroyed: true })
      }
    })
    sock.on("error", () => resolve({ read, destroyed: true }))
    sock.on("close", () => resolve({ read, destroyed: false }))
  })
})()
await new Promise((r) => setTimeout(r, 1500))
out.earlyStopStats = await stats("k5")
out.declaredLieStats = await stats("k1")
out.resetStats = await stats("k4")
// ⑥ Range 支持(mode=slice)
out.range = await (async () => {
  const res = await fetch(seg({ file: "small.bin", probe: "k6", mode: "slice" }), {
    headers: { authorization: `Bearer ${TOKEN}`, range: "bytes=0-1023" },
  })
  const headers = Object.fromEntries([...res.headers.entries()])
  const body = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, headers, bytes: body.byteLength }
})()
// ⑦ 413
out.forced413 = await probe("forced 413", seg({ file: "small.bin", probe: "k7", status: 413 }))

origin.stop()

const checks = {
  "declare-lie reaches the client as content-length: 209715200":
    (out.declaredLie as { headers: Record<string, string> }).headers["content-length"] === "209715200",
  "chunked has no content-length":
    (out.chunked as { headers: Record<string, string> }).headers["content-length"] === undefined,
  "chunked body decodes to exactly 1 MiB": (out.chunked as { read: number }).read === 1048576,
  "normal transfers 3 MiB with correct content-length":
    (out.normal as { read: number }).read === 3145728 &&
    (out.normal as { headers: Record<string, string> }).headers["content-length"] === "3145728",
  "mid-stream reset surfaces as a client-side error, not a clean EOF":
    (out.reset as { error: string | null }).error !== null,
  // 「客户端停读」的可靠观测量是 **written**(origin 实际推出去多少),不是 abort 计数:
  // 客户端 destroy 之后 origin 只是卡在一个永远不 drain 的 write 上,socket 的 close/error
  // 不保证在观测窗口内到达(实测 k5 恒 0,而 k4 的 mode=reset 恒 1)。用 abort 计数当判据
  // 就会得到一个恒假的信号 —— 这正是本文件要挡住的那类盲区。
  "client stopping early shows up as the origin ceasing to push (<< the full 100 MiB)":
    ((out.earlyStopStats as { written: number }).written ?? Infinity) < 32 * 1024 * 1024,
  "a server-side reset is recorded as clientAbortedEarly (abort 计数在这一支是有效的)":
    ((out.resetStats as { clientAbortedEarly: number }).clientAbortedEarly ?? 0) >= 1,
  "range returns 206 with content-range and exactly 1024 bytes":
    (out.range as { status: number; bytes: number; headers: Record<string, string> }).status === 206 &&
    (out.range as { bytes: number }).bytes === 1024 &&
    !!(out.range as { headers: Record<string, string> }).headers["content-range"],
  "forced 413 arrives as 413": (out.forced413 as { status: number }).status === 413,
}

console.log(JSON.stringify({ checks, detail: out }, null, 2))
const failed = Object.entries(checks).filter(([, v]) => !v)
if (failed.length) {
  console.error(`\nORIGIN CALIBRATION FAILED: ${failed.map(([k]) => k).join(" | ")}`)
  process.exit(1)
}
console.error("\nORIGIN CALIBRATION PASSED")
