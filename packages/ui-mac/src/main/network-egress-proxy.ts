// REQ-137 (`#1336`) —— 本地 loopback CONNECT 策略代理:目的地闸门的**咽喉点**。
//
// 强制层(seatbelt `(deny network*)` + 只放行本代理端口,`#1337`)把 sidecar 那棵树的全部出网逼到这里;
// 本文件做策略:对每条 `CONNECT host:port` 只问一句「授权了吗」—— 授权 ⇒ 建隧道(TLS 端到端,不看隧道
// 内容、不注入任何证书,老勘破 §4.2),没授权 ⇒ 403 + 结构化记录。
// 问的那一句是 `isEgressAuthorizedForSidecar`(network-egress-derived.ts)= **静态半场**
// (network-egress-registry.ts 的冻结常量表)∪ **动态半场**(`#1379`:由用户有效配置里的 BYOK baseURL
// 派生,每次 fork 前整份替换)∪ **用户批准的半场**(`#1412`,network-egress-grants.ts)。
// 本文件不自己判任何一格,也不持有第二份清单。
//
// ── 判出「没授权」之后还有一步(`#1412`)─────────────────────────────────────────────
// `webfetch` 的 URL 与 `bash` 里命令自带的目的地由模型在调用那一刻产生,没有任何配置来源可登记
// (`#1414` §3),于是它们整类撞在这道 403 上。所以拒绝之前多一问:`requestGrant` —— 把这个
// **目的地**交给用户裁决(main 的原生对话框,围栏之外)。答「允许」才建隧道,答别的、没人答、
// 没接通道 ⇒ 仍然是下面那条 403 unregistered,字节逐字不变。顺序仍是「解析 → 查表 → (问) → 才拨号」:
// 未获批的名字一次 DNS 都不发。
//
// ── DNS 在这里、而且只在这里发生 ─────────────────────────────────────────────────────
// 围栏刻意不放行 mDNSResponder(`#1334` Q3:走代理的客户端由代理解析,想直连的死在解析这一步)。所以
// 本进程(Electron main,不在围栏内)按 CONNECT 行里的**名字**去 `net.connect` —— getaddrinfo 在这一侧跑。
// 顺序是 解析 authority → 查注册表 → 才拨号:未登记的名字**一次 DNS 都不发**(否定用例里 dial 零调用)。
//
// ── 失败形态各自可辨 ──────────────────────────────────────────────────────────────────
//   403 unregistered      策略拒绝(唯一的「闸门说不」)
//   400 bad-authority     CONNECT 行不是 `host:port`(缺端口 / 越界 / 带路径 …)—— 不猜默认端口
//   405 method-not-connect 非 CONNECT 请求(绝对 URI 的明文 HTTP)—— 本代理只做隧道,不做明文转发
//   502 dial-failed       登记了但拨不通(ENOTFOUND / ECONNREFUSED / 超时)—— 这**不是**策略拒绝,别混
// 拒绝体带可识别前缀:bun 的 fetch 会把代理的 403 当目标响应返回(§4.2),正文是应用侧唯一的归因线索。
//
// electron-free:日志、授权、拨号都可注入,默认值才是生产接线(authorize = 注册表,dial = net.connect)。
// 这样 network-egress-proxy.test.ts 能在 bun 里对真 TCP 靶站跑正反两臂,并证明「换成恒答允许的替身,判据会红」。

import * as http from "node:http"
import * as net from "node:net"
import { egressDenialLine } from "../shared/egress-denial"
import { isEgressAuthorizedForSidecar } from "./network-egress-derived"
import { requestUserEgressGrant, type EgressGrantOutcome } from "./network-egress-grants"

// 拒绝正文的格式住在 `shared/egress-denial.ts`,因为 `#1382` 起它**有读者**了(renderer 的
// 时间线要据此说「是这台电脑上的网络策略拦的」)。写的人和读的人共用同一个拼串函数,
// 两处字面量无声漂移那一类就不存在;漂移了界面只会退回普通失败文案,没有任何东西会变红。
export { EGRESS_DENIED_BODY_PREFIX } from "../shared/egress-denial"

export type EgressDenyReason = "unregistered" | "bad-authority" | "method-not-connect" | "dial-failed"

export type EgressLogRecord =
  | {
      /**
       * `#1412`:一条未登记的目的地被交给用户裁决之后的结局。它与 `egress.connect` 分开记,
       * 因为它回答的是另一个问题 ——「这一代里,用户放行过哪些原本不在名单上的地址」。
       */
      event: "egress.grant"
      id: number
      at: string
      host: string
      port: number
      decision: "granted" | "refused"
    }
  | {
      event: "egress.connect"
      id: number
      at: string
      method: string
      /** 请求行里的原文(CONNECT 的 authority,或非 CONNECT 的 url)。 */
      authority: string
      host?: string
      port?: number
      verdict: "allow" | "deny"
      reason?: EgressDenyReason
      /** 回给客户端的状态码:200 隧道 / 403 / 400 / 405 / 502。 */
      status: number
      /** dial-failed 的错误码(ENOTFOUND / ECONNREFUSED / ETIMEDOUT …)。 */
      detail?: string
    }
  | {
      event: "egress.tunnel-closed"
      id: number
      at: string
      host: string
      port: number
      bytesUp: number
      bytesDown: number
    }

export type EgressProxyDeps = {
  /** 结构化记录的出口。生产接线把它写进 main 的日志;测试收进数组。 */
  log: (record: EgressLogRecord) => void
  /** 默认 = 静态表 ∪ 本代派生的动态半场。**只有测试**该传这个 —— 生产传别的东西就等于绕开 AC2。 */
  authorize?: (host: string, port: number) => boolean
  /** 默认 = `net.connect({ host, port })`(DNS 在本进程)。测试用它做零拨号断言。 */
  dial?: (host: string, port: number) => net.Socket
  /**
   * `#1412` —— 未登记目的地的**唯一出口**:问用户。默认 = network-egress-grants.ts 的编排,
   * 而它在**没有接上询问通道时恒答 `not-asked`** ⇒ 不接线的行为与本票之前逐字相同(403 unregistered,零额外记录)。
   * 本代理自己不判任何一格,也不持第二份清单:它只是在拒绝之前多问一句,然后照答复办。
   */
  requestGrant?: (host: string, port: number) => Promise<EgressGrantOutcome>
  /** 拨号超时(默认 10 s):登记了但黑洞的目的地要快速、可读地失败,不能挂到客户端超时。 */
  dialTimeoutMs?: number
}

export type EgressProxyHandle = {
  host: "127.0.0.1"
  port: number
  /** 关掉监听并切断在途隧道;resolve 时端口已释放。 */
  close: () => Promise<void>
}

const REGISTRY_PATH = "packages/ui-mac/src/main/network-egress-registry.ts"

const PORT_SHAPE = /^[0-9]{1,5}$/
const NAME_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const V6_SHAPE = /^[0-9a-f:.]+$/

/**
 * CONNECT 的 authority 形式(RFC 9110 §7.1):`host:port`,端口**必填**。host 小写化;`[v6]` 去括号。
 * 认不出 ⇒ undefined(调用方回 400),不猜默认端口 —— 猜出来的端口不是客户端要的,也不是注册表登记的。
 */
export function parseConnectAuthority(authority: string | undefined): { host: string; port: number } | undefined {
  if (typeof authority !== "string" || authority.length === 0 || /[\s/?#@\\]/.test(authority)) return undefined
  let hostPart: string
  let portPart: string
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]")
    if (close < 0 || authority[close + 1] !== ":") return undefined
    hostPart = authority.slice(1, close).toLowerCase()
    portPart = authority.slice(close + 2)
    if (!V6_SHAPE.test(hostPart) || !hostPart.includes(":")) return undefined
  } else {
    const colon = authority.lastIndexOf(":")
    if (colon <= 0) return undefined
    hostPart = authority.slice(0, colon).toLowerCase()
    portPart = authority.slice(colon + 1)
    if (!NAME_SHAPE.test(hostPart)) return undefined
  }
  if (!PORT_SHAPE.test(portPart)) return undefined
  const port = Number(portPart)
  if (port < 1 || port > 65535) return undefined
  return { host: hostPart, port }
}

function defaultDial(host: string, port: number): net.Socket {
  // autoSelectFamily(Happy Eyeballs):`localhost` 在 macOS 上先解到 ::1;靶站只听 v4 时不能停在第一个地址。
  return net.connect({ host, port, autoSelectFamily: true })
}

function denialBody(reason: EgressDenyReason, authority: string, detail?: string): string {
  const why =
    reason === "unregistered"
      ? // `#1379`:拒绝理由要说得出**为什么**,否则用户只看到一个泛化的网络错误。两个半场各说一句。
        // 措辞刻意窄:动态半场只认**目录里自带、且这台机器握着密钥**的那些供应商 —— 写在配置文件里的
        // 自建节点不算(`#1380` R1 Blocker:那些文件在围栏的可写集里)。说宽了就是把披露做成假话。
        `blocked by this app's local egress policy — the destination is neither a registered app endpoint (${REGISTRY_PATH}) nor one of the built-in model providers this machine holds a key for`
      : reason === "bad-authority"
        ? "CONNECT authority must be host:port"
        : reason === "method-not-connect"
          ? "this proxy only serves CONNECT tunnels"
          : `registered destination could not be reached${detail ? ` (${detail})` : ""}`
  return egressDenialLine(authority, reason, why)
}

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 405: "Method Not Allowed", 502: "Bad Gateway" }

function writeDenial(socket: net.Socket, status: number, body: string): void {
  const head = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "Proxy-Agent: alpha-egress-policy",
    "",
    "",
  ].join("\r\n")
  socket.end(head + body)
}

export async function startEgressPolicyProxy(deps: EgressProxyDeps): Promise<EgressProxyHandle> {
  const authorize = deps.authorize ?? isEgressAuthorizedForSidecar
  const requestGrant = deps.requestGrant ?? requestUserEgressGrant
  const dial = deps.dial ?? defaultDial
  const dialTimeoutMs = deps.dialTimeoutMs ?? 10_000
  const log = deps.log
  let seq = 0
  const live = new Set<net.Socket>()
  const track = (s: net.Socket) => {
    live.add(s)
    s.once("close", () => live.delete(s))
  }

  const server = http.createServer((req, res) => {
    // 明文 HTTP 的绝对 URI 形式(`GET http://host/ …`)—— 本代理不做明文转发,fail-closed。
    log({ event: "egress.connect", id: ++seq, at: new Date().toISOString(), method: req.method ?? "", authority: req.url ?? "", verdict: "deny", reason: "method-not-connect", status: 405 })
    const body = denialBody("method-not-connect", `${req.method ?? ""} ${req.url ?? ""}`)
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body), Connection: "close", Allow: "CONNECT", "Proxy-Agent": "alpha-egress-policy" })
    // `Connection: close` 是给客户端看的;实际把连接收掉这件事不交给运行时的 keep-alive 策略(bun 实测不关)。
    res.end(body, () => res.socket?.end())
  })

  server.on("connect", (req, duplex, head) => {
    const id = ++seq
    const authority = req.url ?? ""
    // @types/node 把它标成 Duplex;运行时是 net.Socket(http.Server 的连接就是 TCP socket)。
    const clientSocket = duplex as net.Socket
    track(clientSocket)
    clientSocket.on("error", () => {})
    const deny = (status: number, reason: EgressDenyReason, parsed?: { host: string; port: number }, detail?: string) => {
      log({ event: "egress.connect", id, at: new Date().toISOString(), method: "CONNECT", authority, host: parsed?.host, port: parsed?.port, verdict: "deny", reason, status, detail })
      writeDenial(clientSocket, status, denialBody(reason, authority, detail))
    }

    const parsed = parseConnectAuthority(authority)
    if (!parsed) return deny(400, "bad-authority")
    if (authorize(parsed.host, parsed.port)) return openTunnel(parsed)

    // `#1412` —— 未登记 ⇒ 在拒绝之前走唯一的出口:问用户。答复到达之前**一次 DNS 都不发、
    // 一次拨号都不做**(与原来的顺序逐字相同);没接询问通道时 requestGrant 恒答 `not-asked`(三态里的那一支,
    // 于是这一整段的行为就是原来那一行 `return deny(403, "unregistered", parsed)`(连记录都不多一条)。
    // **尽力而为,不是保证**:CONNECT 的 socket 从 http 服务器上摘下来之后没有人在读它,
    // 于是对端 RST 在本进程里观察不到 —— 实测(bun 1.3.14):客户端 `destroy()` 200 ms 后
    // 服务端这一侧仍然 `destroyed=false writable=true`,`close` 一次都没发。要观察到它只能
    // `resume()`,而那会吞掉客户端在 200 之前抢跑的字节(TLS ClientHello),比它治的病更坏。
    // 所以这个判断只在优雅关闭时命中;没命中的代价是对着一个死 socket 建一次隧道,它下一拍就自己收掉。
    let clientGone = false
    clientSocket.once("close", () => (clientGone = true))
    void requestGrant(parsed.host, parsed.port).then(
      (outcome) => {
        // `not-asked`(没接通道 / 准入不过 / 超并发 / 记忆期内)不写记录:那一行会假装有人裁决过。
        if (outcome !== "not-asked") log({ event: "egress.grant", id, at: new Date().toISOString(), host: parsed.host, port: parsed.port, decision: outcome })
        if (outcome !== "granted") return deny(403, "unregistered", parsed)
        // 人答得比客户端的超时慢是常态(`webfetch` 30 s)。批准已经落账,这条连接却已经走了 ——
        // 不要对着一个死 socket 拨号,让调用方重试即可(方案基线 I7)。
        if (clientGone || clientSocket.destroyed) return
        openTunnel(parsed)
      },
      // 询问通道自己坏了也只能是拒:降级方向永远朝 fail-closed。
      () => deny(403, "unregistered", parsed),
    )
    return

    function openTunnel(parsed: { host: string; port: number }): void {
      const upstream = dial(parsed.host, parsed.port)
      track(upstream)
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) upstream.destroy(Object.assign(new Error("dial timeout"), { code: "ETIMEDOUT" }))
      }, dialTimeoutMs)

      upstream.once("connect", () => {
        settled = true
        clearTimeout(timer)
        log({ event: "egress.connect", id, at: new Date().toISOString(), method: "CONNECT", authority, host: parsed.host, port: parsed.port, verdict: "allow", status: 200 })
        clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: alpha-egress-policy\r\n\r\n")
        // 字节计数自己数(bun 的 http 连接 socket 上 bytesRead/bytesWritten 实测恒 0)。
        let bytesUp = head.length
        let bytesDown = 0
        clientSocket.on("data", (chunk: Buffer) => (bytesUp += chunk.length))
        upstream.on("data", (chunk: Buffer) => (bytesDown += chunk.length))
        if (head.length > 0) upstream.write(head)
        clientSocket.pipe(upstream)
        upstream.pipe(clientSocket)
        let closed = false
        const onClose = () => {
          if (closed) return
          closed = true
          log({ event: "egress.tunnel-closed", id, at: new Date().toISOString(), host: parsed.host, port: parsed.port, bytesUp, bytesDown })
          clientSocket.destroy()
          upstream.destroy()
        }
        clientSocket.once("close", onClose)
        upstream.once("close", onClose)
      })
      upstream.once("error", (err: NodeJS.ErrnoException) => {
        if (settled) return clientSocket.destroy()
        settled = true
        clearTimeout(timer)
        deny(502, "dial-failed", parsed, err.code ?? err.message)
      })
      clientSocket.once("close", () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          upstream.destroy()
        }
      })
    }
  })

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
    else socket.destroy()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("egress proxy: listen() gave no TCP address")

  return {
    host: "127.0.0.1",
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy()
        live.clear()
        server.close(() => resolve())
      }),
  }
}
