// `#1572` AC3 + AC6 —— 分类映射表(方案 docs/design/req236-network-diagnosis.md §2.2 N1)逐行、两列(经出网代理 / 其它路径)。
//
// 错误形状的来源(不是手写别人的文法):
//  · `Proxy response (NNN) !== 200 when HTTP Tunneling` 与它外面那两层(`TypeError: fetch failed` ← `Error: Request was
//    cancelled.`)逐字取自打包版实测 docs/verification/2026-09-10-req159-1334-packaged-network-fence/results/choke.json:1013
//    与 docs/architecture/2026-09-23-webfetch-egress-decision-chain.md:153(`AbortError UND_ERR_ABORTED`);
//  · `Connect Timeout Error (attempted address: …, timeout: 10000ms)` 逐字取自 owner 本机 opencode.log(方案 §1.5(d));
//  · ENOTFOUND / ECONNREFUSED 由本文件当场在本机制造(真 dns.lookup / 真 net.connect),不抄字面量;
//  · Effect HTTP 的包法用装着的 effect 版本真构造 HttpClientError(原错误挂在 `cause` 与 `reason.cause`)。
// 真运行时(Electron 内嵌 Node + 真出网代理 + 真 webfetch)的端到端形状由
// packages/ui-mac/src/main/net-failure-real-stack.test.ts 钉住;本文件钉映射表本身。

import { describe, expect, test } from "bun:test"
import { lookup } from "node:dns/promises"
import { connect, createServer, type AddressInfo } from "node:net"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { classifyNetFailure, EGRESS_DIAL_FAILURE_STATUS, engineNetFailurePath, isNetFailureLayer, type NetFailurePath } from "../src/alpha-net-failure"

const PROXY: NetFailurePath = { via: "egress-proxy", proxyOrigin: "http://127.0.0.1:61234" }
const OTHER: NetFailurePath = { via: "other" }

/** 打包版实测的三层包法:`TypeError: fetch failed` ← `Error: Request was cancelled.` ← undici 的 AbortError。 */
function proxyTunnelFailure(status: number) {
  const inner = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { name: "AbortError", code: "UND_ERR_ABORTED" })
  return new TypeError("fetch failed", { cause: new Error("Request was cancelled.", { cause: inner }) })
}

function connectTimeout(attempted: string) {
  const inner = Object.assign(new Error(`Connect Timeout Error (attempted address: ${attempted}, timeout: 10000ms)`), {
    name: "ConnectTimeoutError",
    code: "UND_ERR_CONNECT_TIMEOUT",
  })
  return new TypeError("fetch failed", { cause: inner })
}

/** Effect FetchHttpClient 的包法(装着的 effect 版本):message 只剩 `Transport error (GET <url>)`,原错误在 cause。 */
function effectTransport(cause: unknown, url = "https://example.test/path?token=SECRET-NEEDLE-7f3a") {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request: HttpClientRequest.get(url), cause }),
  })
}

async function realDnsFailure(): Promise<unknown> {
  return lookup("ac1572-nx.invalid").then(
    () => {
      throw new Error("ac1572-nx.invalid resolved — the DNS fixture is not a failure on this machine (本次测量作废)")
    },
    (error: unknown) => error,
  )
}

async function realRefused(): Promise<unknown> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return new Promise((resolve) => connect(port, "127.0.0.1").once("error", resolve))
}

describe("AC3 映射表:经出网代理 / 其它路径两列", () => {
  test("Proxy response (403) ⇒ 经出网代理 policy;别处的代理回 403 不归因", () => {
    expect(classifyNetFailure(proxyTunnelFailure(403), PROXY)).toEqual({ layer: "policy", code: "403" })
    expect(classifyNetFailure(proxyTunnelFailure(403), OTHER)).toBeUndefined()
  })

  test("Proxy response (503) 与 ENOTFOUND / EAI_AGAIN / EAI_NONAME ⇒ dns(两列相同)", async () => {
    const dns = await realDnsFailure()
    const code = (dns as { code?: string }).code
    expect(code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME").toBe(true)
    for (const path of [PROXY, OTHER]) {
      expect(classifyNetFailure(proxyTunnelFailure(EGRESS_DIAL_FAILURE_STATUS.dns), path)).toEqual({ layer: "dns", code: "503" })
      expect(classifyNetFailure(new TypeError("fetch failed", { cause: dns }), path)).toEqual({ layer: "dns", code: code! })
      for (const literal of ["EAI_AGAIN", "EAI_NONAME"])
        expect(classifyNetFailure(Object.assign(new Error("getaddrinfo"), { code: literal }), path)).toEqual({ layer: "dns", code: literal })
    }
  })

  test("Proxy response (502) / (504) 与 ECONNREFUSED / EHOSTUNREACH / ENETUNREACH ⇒ tcp(两列相同)", async () => {
    const refused = await realRefused()
    expect((refused as { code?: string }).code).toBe("ECONNREFUSED")
    for (const path of [PROXY, OTHER]) {
      expect(classifyNetFailure(proxyTunnelFailure(EGRESS_DIAL_FAILURE_STATUS.tcp), path)).toEqual({ layer: "tcp", code: "502" })
      expect(classifyNetFailure(proxyTunnelFailure(EGRESS_DIAL_FAILURE_STATUS.timeout), path)).toEqual({ layer: "tcp", code: "504" })
      expect(classifyNetFailure(refused, path)).toEqual({ layer: "tcp", code: "ECONNREFUSED" })
      for (const literal of ["EHOSTUNREACH", "ENETUNREACH"])
        expect(classifyNetFailure(Object.assign(new Error("connect"), { code: literal }), path)).toEqual({ layer: "tcp", code: literal })
    }
  })

  test("UND_ERR_CONNECT_TIMEOUT:经出网代理且尝试地址是目标 ⇒ tls-silent;其它路径 ⇒ connect-timeout", () => {
    const target = connectTimeout("alpha-cloud.tidelabs.click:443")
    expect(classifyNetFailure(target, PROXY)).toEqual({ layer: "tls-silent", code: "UND_ERR_CONNECT_TIMEOUT" })
    expect(classifyNetFailure(target, OTHER)).toEqual({ layer: "connect-timeout", code: "UND_ERR_CONNECT_TIMEOUT" })
  })

  test("UND_ERR_CONNECT_TIMEOUT:尝试地址是代理本身 ⇒ connect-timeout;读不出尝试地址也不声称握手(I6)", () => {
    expect(classifyNetFailure(connectTimeout("127.0.0.1:61234"), PROXY)).toEqual({ layer: "connect-timeout", code: "UND_ERR_CONNECT_TIMEOUT" })
    const bare = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })
    expect(classifyNetFailure(bare, PROXY)).toEqual({ layer: "connect-timeout", code: "UND_ERR_CONNECT_TIMEOUT" })
  })

  test("ECONNRESET 且握手前断开、ERR_SSL_* ⇒ tls-failed;别的 ECONNRESET 不归因", () => {
    const reset = Object.assign(new Error("Client network socket disconnected before secure TLS connection was established"), { code: "ECONNRESET" })
    const ssl = Object.assign(new Error("ssl3_get_record:wrong version number"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" })
    for (const path of [PROXY, OTHER]) {
      expect(classifyNetFailure(reset, path)).toEqual({ layer: "tls-failed", code: "ECONNRESET" })
      expect(classifyNetFailure(ssl, path)).toEqual({ layer: "tls-failed", code: "ERR_SSL_WRONG_VERSION_NUMBER" })
      expect(classifyNetFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), path)).toBeUndefined()
    }
  })

  test("CERT_* / ERR_TLS_CERT_ALTNAME_INVALID / UNABLE_TO_VERIFY_LEAF_SIGNATURE / *SELF_SIGNED* ⇒ tls-cert", () => {
    for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"])
      for (const path of [PROXY, OTHER])
        expect(classifyNetFailure(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }), path)).toEqual({ layer: "tls-cert", code })
  })

  test("有 HTTP 状态的应答 ⇒ http(Effect StatusCode 的 response.status、APICallError 的 statusCode、MCP SDK 的数字 code)", () => {
    for (const path of [PROXY, OTHER]) {
      expect(classifyNetFailure({ name: "AI_APICallError", message: "Bad Request", statusCode: 400 }, path)).toEqual({ layer: "http", code: "400" })
      expect(classifyNetFailure(Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint (HTTP 404)"), { code: 404 }), path)).toEqual({ layer: "http", code: "404" })
      expect(classifyNetFailure({ message: "StatusCode: 503", response: { status: 503 } }, path)).toEqual({ layer: "http", code: "503" })
      // JSON-RPC 的负数错误码不是 HTTP 状态
      expect(classifyNetFailure(Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 }), path)).toBeUndefined()
    }
  })

  test("整体预算耗尽 ⇒ timeout:AbortSignal.timeout 的 TimeoutError、MCP 的 Operation timed out after Nms", async () => {
    const aborted = await fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(0) }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((aborted as { name?: string }).name).toBe("TimeoutError")
    for (const path of [PROXY, OTHER]) {
      expect(classifyNetFailure(aborted, path)).toEqual({ layer: "timeout", code: "TimeoutError" })
      expect(classifyNetFailure(new Error("Operation timed out after 30000ms"), path)).toEqual({ layer: "timeout", code: "timeout" })
    }
  })

  test("认不出 ⇒ undefined(I4)", () => {
    for (const value of [new Error("boom"), new TypeError("fetch failed"), new Error("Request was cancelled."), "fetch failed", undefined, null, 42, { code: "EPIPE" }])
      for (const path of [PROXY, OTHER]) expect(classifyNetFailure(value, path)).toBeUndefined()
  })

  test("Effect HTTP 包法:原错误挂在 cause / reason.cause,分类照样认得出;5 层之外不再走", () => {
    expect(classifyNetFailure(effectTransport(proxyTunnelFailure(503)), PROXY)).toEqual({ layer: "dns", code: "503" })
    expect(classifyNetFailure(effectTransport(connectTimeout("example.test:443")), PROXY)).toEqual({ layer: "tls-silent", code: "UND_ERR_CONNECT_TIMEOUT" })
    const deep = [1, 2, 3, 4, 5].reduce<unknown>((cause) => new Error("wrap", { cause }), Object.assign(new Error("x"), { code: "ENOTFOUND" }))
    expect(classifyNetFailure(deep, PROXY)).toBeUndefined()
    const cycle: { message: string; cause?: unknown } = { message: "loop" }
    cycle.cause = cycle
    expect(classifyNetFailure(cycle, PROXY)).toBeUndefined()
  })
})

describe("AC6 分类不泄密:输出只有层名与错误码", () => {
  test("URL 查询、authorization、令牌都不进输出(以一根必在的针自证扫描有效)", () => {
    const secret = "SECRET-NEEDLE-7f3a"
    const inputs = [
      effectTransport(proxyTunnelFailure(403), `https://example.test/?token=${secret}`),
      effectTransport(connectTimeout("example.test:443"), `https://example.test/?q=${secret}`),
      Object.assign(new Error(`authorization: Bearer ${secret}`), { code: "ENOTFOUND" }),
      { message: `Bad Request ${secret}`, statusCode: 401, responseBody: `{"token":"${secret}"}` },
    ]
    // 针必在:输入本身的文本里带着它,否则「输出里没有」什么都证明不了。
    const haystack = inputs.map((input) => `${(input as { message?: string }).message} ${JSON.stringify(input)}`).join(" ")
    expect(haystack).toContain(secret)
    for (const input of inputs) {
      const out = classifyNetFailure(input, PROXY)
      expect(out).toBeDefined()
      expect(Object.keys(out!).sort()).toEqual(["code", "layer"])
      const text = JSON.stringify(out)
      expect(text).not.toContain(secret)
      expect(text.toLowerCase()).not.toContain("authorization")
      expect(text).not.toContain("?")
    }
  })
})

describe("engineNetFailurePath:引擎请求走不走本机出网代理", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:61234", HTTP_PROXY: "http://127.0.0.1:61234", NO_PROXY: "127.0.0.1,localhost,::1" }

  test("代理变量在场、目标不在 NO_PROXY ⇒ egress-proxy,proxyOrigin 取自代理变量", () => {
    expect(engineNetFailurePath("https://mcp.exa.ai/mcp", env)).toEqual({ via: "egress-proxy", proxyOrigin: "http://127.0.0.1:61234" })
    expect(engineNetFailurePath(new URL("http://example.test/"), env)).toEqual({ via: "egress-proxy", proxyOrigin: "http://127.0.0.1:61234" })
  })

  test("NO_PROXY 里的名字(含 [::1])、没有代理变量、URL 不合法 ⇒ other", () => {
    for (const target of ["http://127.0.0.1:4096/x", "https://localhost/", "http://[::1]:8080/"]) expect(engineNetFailurePath(target, env)).toEqual({ via: "other" })
    expect(engineNetFailurePath("https://mcp.exa.ai/", {})).toEqual({ via: "other" })
    expect(engineNetFailurePath("not a url", env)).toEqual({ via: "other" })
    expect(engineNetFailurePath(undefined, env)).toEqual({ via: "other" })
  })
})

describe("isNetFailureLayer:读回来的层名只认九个", () => {
  test("九个层名认,别的字符串 / 非字符串 / 原型链上的名字一律不认", () => {
    for (const layer of ["policy", "dns", "tcp", "connect-timeout", "tls-silent", "tls-failed", "tls-cert", "http", "timeout"]) expect(isNetFailureLayer(layer)).toBe(true)
    for (const value of ["transport", "unattributed", "toString", "constructor", "", 1, null, undefined, {}]) expect(isNetFailureLayer(value)).toBe(false)
  })
})
