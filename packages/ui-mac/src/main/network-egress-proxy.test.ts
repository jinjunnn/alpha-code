// REQ-137 (`#1336`) · AC2 全部 + AC1 策略半场 —— 真代理(生产 startEgressPolicyProxy)+ 真 TCP 靶站。
//
// 正臂:授权目的地经 CONNECT 建隧道,字节双向到达,名字由代理这一侧解析(`localhost` → 靶站)。
// 反臂(AC2 的判据本体,生产注册表、默认接线):CONNECT 到**未登记**的 loopback 靶站 ⇒ 403 + 可识别正文 +
// 结构化记录 reason=unregistered,靶站 0 连接;而「代理确实收到了请求」由那条记录自证(空输出 ≠ 拦住)。
// 控制臂:把注册表换成恒答「允许」的替身,**同一个判据函数**必须当场判红并说出为什么 —— 否则它不是闸门。
// 其余:未登记的名字一次 DNS 都不发;非 CONNECT 405;坏 authority 400;登记了但拨不通 502(与 403 可辨)。

import { afterEach, describe, expect, test } from "bun:test"
import * as net from "node:net"
import { egressPolicyDenialOf } from "../shared/egress-denial"
import { EGRESS_DENIED_BODY_PREFIX, parseConnectAuthority, startEgressPolicyProxy, type EgressLogRecord, type EgressProxyHandle } from "./network-egress-proxy"

type Target = { port: number; connections: number; closedSockets: number; close: () => Promise<void> }

/** loopback 靶站:数连接、回显 `echo:<data>`。只听 127.0.0.1 —— 于是 `localhost` 那条正臂必须走 Happy Eyeballs 才通。 */
async function startTarget(): Promise<Target> {
  const state = { port: 0, connections: 0, closedSockets: 0 }
  const server = net.createServer((socket) => {
    state.connections += 1
    socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`))
    socket.on("close", () => (state.closedSockets += 1))
    socket.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  state.port = (server.address() as net.AddressInfo).port
  return {
    get port() {
      return state.port
    },
    get connections() {
      return state.connections
    },
    get closedSockets() {
      return state.closedSockets
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 一个已经关掉的端口:先听再关,拿到的号码短时间内没人会再用。 */
async function closedPort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

type RawResponse = { status: number; head: string; body: string }

/**
 * 发一段原始请求。拒绝路径带 Content-Length,读满即返;200(隧道建立)时**立刻**返回并由调用方挂断 ——
 * 否则控制臂里那条被替身放行的隧道会一直开着,判据就挂在「等对端关闭」上而不是在说「它放行了」。
 */
function rawRequest(port: number, request: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let text = ""
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const sep = text.indexOf("\r\n\r\n")
      const head = sep >= 0 ? text.slice(0, sep) : text
      resolve({ status: Number(head.split(" ")[1] ?? 0), head, body: sep >= 0 ? text.slice(sep + 4) : "" })
      socket.destroy()
    }
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request))
    socket.on("data", (c) => {
      text += c.toString()
      const sep = text.indexOf("\r\n\r\n")
      if (sep < 0) return
      const head = text.slice(0, sep)
      if (head.startsWith("HTTP/1.1 200")) return finish()
      const length = /content-length:\s*(\d+)/i.exec(head)
      if (length && Buffer.byteLength(text.slice(sep + 4)) >= Number(length[1])) finish()
    })
    socket.on("error", (e) => (done ? undefined : reject(e)))
    socket.on("close", finish)
  })
}

/** CONNECT 并等到响应头;成功时把 socket 交回给调用方继续在隧道里说话。 */
function connectThrough(port: number, authority: string): Promise<{ status: number; head: string; socket: net.Socket; rest: string }> {
  return new Promise((resolve, reject) => {
    let text = ""
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    const onData = (c: Buffer) => {
      text += c.toString()
      const sep = text.indexOf("\r\n\r\n")
      if (sep < 0) return
      socket.off("data", onData)
      const head = text.slice(0, sep)
      resolve({ status: Number(head.split(" ")[1] ?? 0), head, socket, rest: text.slice(sep + 4) })
    }
    socket.on("data", onData)
    socket.once("error", reject)
  })
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function startProxy(opts: Omit<Parameters<typeof startEgressPolicyProxy>[0], "log"> = {}): Promise<{ proxy: EgressProxyHandle; logs: EgressLogRecord[] }> {
  const logs: EgressLogRecord[] = []
  const proxy = await startEgressPolicyProxy({ ...opts, log: (r) => logs.push(r) })
  cleanups.push(proxy.close)
  return { proxy, logs }
}

async function withTarget(): Promise<Target> {
  const target = await startTarget()
  cleanups.push(target.close)
  return target
}

/**
 * AC2 的判据本体,做成函数是为了让控制臂用**同一份**判据:未登记的 loopback 靶站必须 403、正文可识别、
 * 记录 reason=unregistered、靶站 0 连接。任何一项不成立都返回 ok:false 并说清楚(而不是抛),
 * 于是「替身注册表被判据拒掉」这件事本身可以被断言。
 */
async function judgeUnregisteredDenied(proxy: EgressProxyHandle, logs: EgressLogRecord[], target: Target): Promise<{ ok: boolean; detail: string }> {
  const authority = `127.0.0.1:${target.port}`
  const before = target.connections
  const res = await rawRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
  await tick()
  const record = logs.find((r) => r.event === "egress.connect" && r.authority === authority)
  const problems: string[] = []
  if (!record) problems.push("proxy left no egress.connect record for the request (cannot prove it was even received)")
  else if (record.verdict !== "deny" || record.reason !== "unregistered") problems.push(`record verdict=${record.verdict} reason=${record.reason ?? "-"} status=${record.status} (expected deny/unregistered)`)
  if (res.status !== 403) problems.push(`status ${res.status} (expected 403)`)
  if (!res.body.startsWith(EGRESS_DENIED_BODY_PREFIX) || !res.body.includes("reason=unregistered")) problems.push(`body not identifiable: ${JSON.stringify(res.body)}`)
  if (target.connections !== before) problems.push(`target saw ${target.connections - before} connection(s) — the stand-in tunnelled to an unregistered destination`)
  const detail = problems.length ? problems.join("; ") : `403 ${JSON.stringify(res.body.trim())} record=${JSON.stringify(record)} target.connections=${target.connections}`
  return { ok: problems.length === 0, detail }
}

describe("parseConnectAuthority", () => {
  test("认 host:port(小写化)、[v6]:port;拒 缺端口 / 端口越界 / 路径 / userinfo / 空白 / scheme", () => {
    expect(parseConnectAuthority("registry.npmjs.org:443")).toEqual({ host: "registry.npmjs.org", port: 443 })
    expect(parseConnectAuthority("REGISTRY.NPMJS.ORG:443")).toEqual({ host: "registry.npmjs.org", port: 443 })
    expect(parseConnectAuthority("127.0.0.1:11434")).toEqual({ host: "127.0.0.1", port: 11434 })
    expect(parseConnectAuthority("[::1]:443")).toEqual({ host: "::1", port: 443 })
    for (const bad of ["registry.npmjs.org", ":443", "registry.npmjs.org:0", "registry.npmjs.org:65536", "registry.npmjs.org:4a3", "registry.npmjs.org:443/x", "user@registry.npmjs.org:443", "registry.npmjs.org :443", "https://registry.npmjs.org:443", "[::1]", "[::1]443", "[zz]:443", "", undefined]) {
      expect(parseConnectAuthority(bad), String(bad)).toBeUndefined()
    }
  })
})

describe("AC1 策略半场:授权目的地经隧道转发", () => {
  test("CONNECT localhost:<靶站> 在夹具注册表里 ⇒ 200 隧道,字节双向到达,名字由代理解析;客户端挂断 ⇒ 上游被切断", async () => {
    const target = await withTarget()
    const { proxy, logs } = await startProxy({ authorize: (h, p) => h === "localhost" && p === target.port })
    const { status, socket, rest } = await connectThrough(proxy.port, `localhost:${target.port}`)
    expect(status).toBe(200)
    expect(rest).toBe("")
    expect(target.connections).toBe(1)

    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (c) => resolve(c.toString()))
      socket.write("hello-through-tunnel")
    })
    expect(echoed).toBe("echo:hello-through-tunnel")

    const allow = logs.find((r) => r.event === "egress.connect")
    expect(allow).toMatchObject({ event: "egress.connect", method: "CONNECT", authority: `localhost:${target.port}`, host: "localhost", port: target.port, verdict: "allow", status: 200 })

    socket.end()
    await tick(80)
    expect(target.closedSockets, "upstream must be torn down when the client hangs up").toBe(1)
    const closed = logs.find((r) => r.event === "egress.tunnel-closed")
    expect(closed).toMatchObject({ event: "egress.tunnel-closed", host: "localhost", port: target.port, bytesUp: "hello-through-tunnel".length, bytesDown: "echo:hello-through-tunnel".length })
  })

  test("默认 authorize 就是注册表:不传 authorize 时 github.com:443(登记在案)走到拨号,同 host 别的端口走不到", async () => {
    const dialed: string[] = []
    const { proxy, logs } = await startProxy({
      dial: (h, p) => {
        dialed.push(`${h}:${p}`)
        const s = new net.Socket()
        queueMicrotask(() => s.destroy(Object.assign(new Error("fixture"), { code: "ECONNREFUSED" })))
        return s
      },
    })
    const registered = await rawRequest(proxy.port, "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
    const unregistered = await rawRequest(proxy.port, "CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22\r\n\r\n")
    expect(dialed).toEqual(["github.com:443"])
    expect(registered.status).toBe(502)
    expect(unregistered.status).toBe(403)
    expect(logs.map((r) => (r.event === "egress.connect" ? `${r.authority}:${r.verdict}:${r.reason ?? "-"}` : r.event))).toEqual(["github.com:443:deny:dial-failed", "github.com:22:deny:unregistered"])
  })
})

describe("AC2 反向用例:未登记目的地必须被拒且可观察(生产注册表,默认接线)", () => {
  test("CONNECT 到未登记的 loopback 靶站 ⇒ 403 + 可识别正文 + 结构化记录 reason=unregistered,靶站 0 连接", async () => {
    const target = await withTarget()
    const { proxy, logs } = await startProxy()
    const verdict = await judgeUnregisteredDenied(proxy, logs, target)
    console.log(`[ac1336 AC2 反向 · 生产注册表] ${verdict.detail}`)
    expect(verdict.ok, verdict.detail).toBe(true)
    const record = logs[0]
    expect(record).toMatchObject({ event: "egress.connect", method: "CONNECT", host: "127.0.0.1", port: target.port, verdict: "deny", reason: "unregistered", status: 403 })
    expect(typeof (record as { at: string }).at).toBe("string")
    expect(Number.isNaN(Date.parse((record as { at: string }).at))).toBe(false)
  })

  test("未登记的公网名 ⇒ 403,且**一次 DNS / 拨号都不发**(拒绝先于解析)", async () => {
    const dialed: string[] = []
    const { proxy, logs } = await startProxy({
      dial: (h, p) => {
        dialed.push(`${h}:${p}`)
        return new net.Socket()
      },
    })
    const res = await rawRequest(proxy.port, "CONNECT ac1336-unregistered.invalid:443 HTTP/1.1\r\nHost: ac1336-unregistered.invalid:443\r\n\r\n")
    expect(res.status).toBe(403)
    expect(res.body.startsWith(EGRESS_DENIED_BODY_PREFIX)).toBe(true)
    expect(res.body).toContain("ac1336-unregistered.invalid:443 denied (reason=unregistered)")
    expect(dialed).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ verdict: "deny", reason: "unregistered", host: "ac1336-unregistered.invalid", port: 443, status: 403 })
  })

  test("控制臂:注册表换成恒答「允许」的替身 ⇒ 同一判据必须当场红并说出替身把请求放到了靶站", async () => {
    const target = await withTarget()
    const { proxy, logs } = await startProxy({ authorize: () => true })
    const verdict = await judgeUnregisteredDenied(proxy, logs, target)
    console.log(`[ac1336 AC2 控制臂 · 恒答允许的替身] ok=${verdict.ok} — ${verdict.detail}`)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain("status 200 (expected 403)")
    expect(verdict.detail).toContain("target saw 1 connection(s)")
    expect(verdict.detail).toContain("record verdict=allow")
  })
})

describe("其它失败形态各自可辨,且都不转发", () => {
  test("非 CONNECT(绝对 URI 的明文 HTTP)⇒ 405 reason=method-not-connect,靶站 0 连接", async () => {
    const target = await withTarget()
    const { proxy, logs } = await startProxy({ authorize: () => true })
    const res = await rawRequest(proxy.port, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`)
    expect(res.status).toBe(405)
    expect(res.head).toContain("Allow: CONNECT")
    expect(res.body).toContain("reason=method-not-connect")
    expect(target.connections).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ event: "egress.connect", method: "GET", verdict: "deny", reason: "method-not-connect", status: 405 })
  })

  test("坏 authority(缺端口 / 越界 / 带路径)⇒ 400 reason=bad-authority,不查注册表、不拨号", async () => {
    const asked: string[] = []
    const dialed: string[] = []
    const { proxy, logs } = await startProxy({
      authorize: (h, p) => {
        asked.push(`${h}:${p}`)
        return true
      },
      dial: (h, p) => {
        dialed.push(`${h}:${p}`)
        return new net.Socket()
      },
    })
    for (const authority of ["registry.npmjs.org", "registry.npmjs.org:99999", "registry.npmjs.org:443/path"]) {
      const res = await rawRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
      expect(res.status, authority).toBe(400)
      expect(res.body, authority).toContain("reason=bad-authority")
    }
    expect(asked).toEqual([])
    expect(dialed).toEqual([])
    expect(logs.map((r) => (r.event === "egress.connect" ? `${r.status}:${r.reason}:${r.authority}` : r.event))).toEqual([
      "400:bad-authority:registry.npmjs.org",
      "400:bad-authority:registry.npmjs.org:99999",
      "400:bad-authority:registry.npmjs.org:443/path",
    ])
  })

  test("登记了但拨不通(ECONNREFUSED)⇒ 502 reason=dial-failed detail=ECONNREFUSED —— 与 403 策略拒绝可辨", async () => {
    const port = await closedPort()
    const { proxy, logs } = await startProxy({ authorize: (h, p) => h === "127.0.0.1" && p === port })
    const res = await rawRequest(proxy.port, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    expect(res.status).toBe(502)
    expect(res.body).toContain("reason=dial-failed")
    expect(res.body).toContain("ECONNREFUSED")
    expect(logs[0]).toMatchObject({ verdict: "deny", reason: "dial-failed", status: 502, detail: "ECONNREFUSED", host: "127.0.0.1", port })
  })

  test("登记了但解析不了(.invalid)⇒ 502 dial-failed ENOTFOUND:DNS 在代理进程里发生,失败也在这里可读", async () => {
    const { proxy, logs } = await startProxy({ authorize: (h) => h === "ac1336-nxdomain.invalid" })
    const res = await rawRequest(proxy.port, "CONNECT ac1336-nxdomain.invalid:443 HTTP/1.1\r\nHost: ac1336-nxdomain.invalid:443\r\n\r\n")
    expect(res.status).toBe(502)
    expect(res.body).toContain("reason=dial-failed")
    expect(logs[0]).toMatchObject({ verdict: "deny", reason: "dial-failed", status: 502, host: "ac1336-nxdomain.invalid", port: 443 })
    expect((logs[0] as { detail?: string }).detail).toMatch(/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/)
  })

  test("登记了但黑洞(拨号既不通也不拒)⇒ 在 dialTimeoutMs 内以 502 ETIMEDOUT 收尾,不挂到客户端超时", async () => {
    const { proxy, logs } = await startProxy({ authorize: () => true, dialTimeoutMs: 50, dial: () => new net.Socket() })
    const res = await rawRequest(proxy.port, "CONNECT blackhole.example:443 HTTP/1.1\r\nHost: blackhole.example:443\r\n\r\n")
    expect(res.status).toBe(502)
    expect(logs[0]).toMatchObject({ verdict: "deny", reason: "dial-failed", status: 502, detail: "ETIMEDOUT" })
  })
})

// `#1382` —— 拒绝正文从此**有读者**(renderer 的回合级错误卡据此说「是这台电脑上的网络策略拦的」)。
// 渲染层的语料是手写字面量(src/shared/egress-denial.test.ts),独立锚点;这里补上另一条轴:
// **真代理真的写出来的那几行**,必须被同一个识别器判成它们各自该有的样子。少了这一条,
// 「代理改了拼法」只会让界面悄悄退回普通失败文案,而没有任何东西会红 —— 正是本票要消灭的静默。
describe("拒绝正文的消费端契约(生产者 ↔ 渲染层识别器)", () => {
  test("403 unregistered 的真实正文 ⇒ 识别器判为策略拒绝并取出目的地;502 dial-failed 的真实正文 ⇒ 不归因", async () => {
    const denied = await startProxy({ authorize: () => false })
    const deniedRes = await rawRequest(denied.proxy.port, "CONNECT ac1382-consumer.invalid:8443 HTTP/1.1\r\nHost: ac1382-consumer.invalid:8443\r\n\r\n")
    expect(deniedRes.status).toBe(403)
    const recognised = egressPolicyDenialOf(deniedRes.body)
    console.log(`[#1382 生产者↔消费端] 403 body=${JSON.stringify(deniedRes.body.trim())} ⇒ ${JSON.stringify(recognised)}`)
    expect(recognised).toEqual({ authority: "ac1382-consumer.invalid:8443" })

    const unreachable = await startProxy({
      authorize: () => true,
      dial: () => {
        const s = new net.Socket()
        queueMicrotask(() => s.destroy(Object.assign(new Error("fixture"), { code: "ECONNREFUSED" })))
        return s
      },
    })
    const dialRes = await rawRequest(unreachable.proxy.port, "CONNECT ac1382-consumer.invalid:8443 HTTP/1.1\r\nHost: ac1382-consumer.invalid:8443\r\n\r\n")
    expect(dialRes.status).toBe(502)
    expect(dialRes.body.startsWith(EGRESS_DENIED_BODY_PREFIX)).toBe(true) // 同一个前缀 —— 只看前缀就会在这里说错
    console.log(`[#1382 生产者↔消费端] 502 body=${JSON.stringify(dialRes.body.trim())} ⇒ ${JSON.stringify(egressPolicyDenialOf(dialRes.body))}`)
    expect(egressPolicyDenialOf(dialRes.body)).toBeUndefined()
  })
})

describe("生命周期", () => {
  test("close():关掉监听、切断在途隧道;之后再连该端口被拒", async () => {
    const target = await withTarget()
    const logs: EgressLogRecord[] = []
    const proxy = await startEgressPolicyProxy({ log: (r) => logs.push(r), authorize: () => true })
    const { status, socket } = await connectThrough(proxy.port, `127.0.0.1:${target.port}`)
    expect(status).toBe(200)
    const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    await proxy.close()
    await clientClosed
    await tick(50)
    expect(target.closedSockets).toBe(1)
    const refused = await new Promise<string>((resolve) => {
      const s = net.connect(proxy.port, "127.0.0.1", () => resolve("connected"))
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"))
    })
    expect(refused).toBe("ECONNREFUSED")
  })
})

// ── `#1412`:未登记之后的那一步 —— 把目的地交给用户裁决 ──────────────────────────────
//
// 方案基线 docs/design/2026-09-23-model-chosen-egress-baseline.md 的 I2 / I7 / K6。判据都对着**真代理**:
//   · 没接询问通道(生产默认)⇒ 403,且**不写** egress.grant 记录 —— 「没问过」不许长得像「有人拒过」;
//   · 拒绝 ⇒ 403 + 记录 refused + 靶站 0 连接 + **零拨号**(未获批的名字一次 DNS 都不发,与原顺序同);
//   · 批准 ⇒ 200 隧道、字节双向到达、grant 记录在 connect allow 之前;
//   · 客户端等不及先挂断 ⇒ 这一条不拨号,但答案照样落账,**下一次**同一目的地直接通。
describe("`#1412` 未登记目的地的出口:问用户", () => {
  test("没接询问通道(生产默认 requestGrant)⇒ 仍是 403 unregistered,且没有任何 egress.grant 记录", async () => {
    const target = await withTarget()
    const { proxy, logs } = await startProxy({ authorize: () => false })
    const authority = `127.0.0.1:${target.port}`
    const res = await rawRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    await tick()
    expect(res.status).toBe(403)
    expect(logs.filter((r) => r.event === "egress.grant")).toEqual([])
    expect(target.connections).toBe(0)
  })

  test("用户拒绝 ⇒ 403 + 记录 refused + 靶站 0 连接 + 零拨号", async () => {
    const target = await withTarget()
    const dialed: string[] = []
    const asked: string[] = []
    const { proxy, logs } = await startProxy({
      authorize: () => false,
      dial: (h, p) => {
        dialed.push(`${h}:${p}`)
        return net.connect(p, h)
      },
      requestGrant: async (h, p) => {
        asked.push(`${h}:${p}`)
        return "refused"
      },
    })
    const authority = `127.0.0.1:${target.port}`
    const res = await rawRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    await tick()
    expect(res.status).toBe(403)
    expect(res.body.startsWith(EGRESS_DENIED_BODY_PREFIX)).toBe(true)
    expect(asked).toEqual([authority])
    expect(dialed).toEqual([])
    expect(target.connections).toBe(0)
    expect(logs.filter((r) => r.event === "egress.grant")).toEqual([
      { event: "egress.grant", id: 1, at: expect.any(String), host: "127.0.0.1", port: target.port, decision: "refused" } as never,
    ])
    expect(logs.some((r) => r.event === "egress.connect" && r.verdict === "deny" && r.reason === "unregistered")).toBe(true)
  })

  test("用户批准 ⇒ 200 隧道,字节双向到达,grant 记录排在 connect allow 之前", async () => {
    const target = await withTarget()
    const { proxy, logs } = await startProxy({ authorize: () => false, requestGrant: async () => "granted" })
    const authority = `127.0.0.1:${target.port}`
    const { status, socket } = await connectThrough(proxy.port, authority)
    expect(status).toBe(200)
    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (c: Buffer) => resolve(c.toString()))
      socket.write("hello-1412")
    })
    expect(echoed).toBe("echo:hello-1412")
    socket.destroy()
    await tick()
    const events = logs.map((r) => (r.event === "egress.grant" ? `grant:${r.decision}` : r.event === "egress.connect" ? `connect:${r.verdict}` : r.event))
    expect(events.slice(0, 2)).toEqual(["grant:granted", "connect:allow"])
    expect(target.connections).toBe(1)
  })

  test("I7 客户端先挂断:那一问不取消,答复落账后下一条直接通(不必再问)", async () => {
    const target = await withTarget()
    const dialed: string[] = []
    let release: (() => void) | undefined
    let asks = 0
    let approved = false
    const { proxy } = await startProxy({
      authorize: (h, p) => approved && `${h}:${p}` === `127.0.0.1:${target.port}`,
      dial: (h, p) => {
        dialed.push(`${h}:${p}`)
        return net.connect(p, h)
      },
      requestGrant: () =>
        new Promise((resolve) => {
          asks += 1
          release = () => {
            approved = true // 答复到达 = 放行集合里多了一条(生产里这一步在 grants 模块里做)
            resolve("granted")
          }
        }),
    })
    const authority = `127.0.0.1:${target.port}`
    // 客户端等不到答复就走了(`webfetch` 30 s 超时短于人类反应时间)
    const impatient = net.connect(proxy.port, "127.0.0.1", () => impatient.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    impatient.on("error", () => {})
    await tick()
    expect(asks).toBe(1)
    impatient.destroy()
    await tick()
    release!()
    await tick()
    // 下一次重试:授权集合里已经有它了,连问都不问 —— 这就是 I7 的用户可见结果
    //(「第一次失败、再问一次就好」)。注意**不**断言这一条死连接零拨号:CONNECT socket
    // 从 http 服务器摘下来后没人读它,对端 RST 在本进程观察不到(实测见 network-egress-proxy.ts
    // 那段注释),所以「客户端走了」只能尽力而为。
    const dialsBefore = dialed.length
    const { status, socket } = await connectThrough(proxy.port, authority)
    expect(status).toBe(200)
    expect(asks).toBe(1)
    socket.destroy()
    await tick()
    expect(dialed.length).toBe(dialsBefore + 1)
    expect(dialed.at(-1)).toBe(authority)
  })
})
