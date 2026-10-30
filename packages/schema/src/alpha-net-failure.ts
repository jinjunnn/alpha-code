// alpha 自有文件(basename `alpha-*` 即 north-star 谓词因子②;ADR-043)。
//
// REQ-236 T20 `#1572` —— 联网失败**卡在哪一层**的唯一分类(方案 docs/design/req236-network-diagnosis.md §2.2 N1)。
// 三处产出都调它:本机出网代理(拨号失败按层选状态码)、引擎结算点(session/processor.ts、mcp/index.ts)、
// main 的请求出口。界面文案在 renderer 的 alpha-ui/net-failure-copy.ts,按这里给出的层选句子。
//
// 放在 schema 包而不是方案原写的 plugin 包:plugin 包的 exports 要改上游 package.json,north-star 守卫判红;
// schema 包的 `./*` 通配导出让本文件零上游改动可被 import(同包先例 alpha-tool-policy.ts)。
// 本文件只有纯数据与纯函数:不 import 任何 node 模块、不读进程环境(环境由调用方传入),renderer 可原样 import。
//
// 三条纪律(方案 §3):
//  · I3 分类不泄密 —— 输出只有层名与错误码(`ENOTFOUND`、`UND_ERR_CONNECT_TIMEOUT`、`503`…),从不含 URL、头或正文;
//  · I4 认不出就不归因 —— 返回 undefined,调用方保持原文案;
//  · I6 没有阶段证据就不声称阶段 —— 只有「经出网代理 ∧ 超时的尝试地址是目标而不是代理」才说握手无回应。

export type NetFailureLayer =
  | "policy"
  | "dns"
  | "tcp"
  | "connect-timeout"
  | "tls-silent"
  | "tls-failed"
  | "tls-cert"
  | "http"
  | "timeout"

export type NetFailurePath = { via: "egress-proxy"; proxyOrigin: string } | { via: "other" }

export type NetFailure = { layer: NetFailureLayer; code: string }

/**
 * 本机出网代理拨号失败按层用的状态码。undici 把 CONNECT 的非 200 应答正文丢掉、只留状态码
 * (`Proxy response (NNN) !== 200 when HTTP Tunneling`),所以**状态码本身**就得把层分开。
 * 策略拒绝仍是 403(不在此表,由代理的放行判定给出)。
 */
export const EGRESS_DIAL_FAILURE_STATUS = { dns: 503, tcp: 502, timeout: 504 } as const

const PROXY_STATUS_LAYER: Record<string, NetFailureLayer | undefined> = {
  "403": "policy",
  "503": "dns",
  "502": "tcp",
  "504": "tcp",
}
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"])
const TCP_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"])
const CERT_CODES = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])
const PROXY_RESPONSE = /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/
const ATTEMPTED = /attempted address(?:es)?: ([^)]*?), timeout:/
const MCP_TIMEOUT = /^Operation timed out after \d+ms$/
const MAX_DEPTH = 5

/**
 * 认出一次联网失败卡在哪一层。沿 `cause` 链(含 Effect HTTP 的 `reason.cause`)由外向内最多走 5 层,
 * 第一个认得出的节点给出答案;只读 `name`、`message`、`code`、HTTP 状态与 undici 原文里的状态码 / 尝试地址。
 */
export function classifyNetFailure(error: unknown, path: NetFailurePath): NetFailure | undefined {
  const seen = new Set<unknown>()
  let level: unknown[] = [error]
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = []
    for (const node of level) {
      if (typeof node !== "object" || node === null || seen.has(node)) continue
      seen.add(node)
      const found = classifyNode(node as ErrorNode, path)
      if (found) return found
      next.push((node as ErrorNode).cause, (node as ErrorNode).reason?.cause)
    }
    level = next
  }
  return undefined
}

type ErrorNode = {
  name?: unknown
  message?: unknown
  code?: unknown
  status?: unknown
  statusCode?: unknown
  response?: { status?: unknown }
  reason?: { cause?: unknown }
  cause?: unknown
}

function classifyNode(node: ErrorNode, path: NetFailurePath): NetFailure | undefined {
  const message = typeof node.message === "string" ? node.message : ""
  const code = typeof node.code === "string" ? node.code : ""

  const proxy = PROXY_RESPONSE.exec(message)
  if (proxy) {
    const layer = PROXY_STATUS_LAYER[proxy[1]]
    // 403 只有在我们自己的出网代理上才是「本机策略」;别处的代理回 403 不下归因(I4)。
    if (!layer || (layer === "policy" && path.via !== "egress-proxy")) return undefined
    return { layer, code: proxy[1] }
  }
  if (DNS_CODES.has(code)) return { layer: "dns", code }
  if (TCP_CODES.has(code)) return { layer: "tcp", code }
  if (code === "UND_ERR_CONNECT_TIMEOUT") return { layer: connectTimeoutLayer(message, path), code }
  if (code.startsWith("ERR_SSL_")) return { layer: "tls-failed", code }
  if (code === "ECONNRESET" && message.includes("before secure TLS connection")) return { layer: "tls-failed", code }
  if (code.startsWith("CERT_") || code.includes("SELF_SIGNED") || CERT_CODES.has(code)) return { layer: "tls-cert", code }
  const status = httpStatusOf(node)
  if (status !== undefined) return { layer: "http", code: String(status) }
  if (node.name === "TimeoutError") return { layer: "timeout", code: "TimeoutError" }
  if (MCP_TIMEOUT.test(message)) return { layer: "timeout", code: "timeout" }
  return undefined
}

/**
 * undici 的连接计时器在直连时同时覆盖 TCP 与 TLS,经代理时目标 TLS connector 只在 CONNECT 200 之后才启动
 * (方案 §1.4)。所以只有「经出网代理 ∧ 尝试地址里没有代理自己」才是握手无回应;尝试地址读不出来也不声称阶段(I6)。
 */
function connectTimeoutLayer(message: string, path: NetFailurePath): NetFailureLayer {
  if (path.via !== "egress-proxy") return "connect-timeout"
  const attempted = ATTEMPTED.exec(message)?.[1]
  if (!attempted || !URL.canParse(path.proxyOrigin)) return "connect-timeout"
  const proxy = new URL(path.proxyOrigin)
  const proxyAuthority = `${proxy.hostname}:${proxy.port || (proxy.protocol === "https:" ? "443" : "80")}`
  const addresses = attempted.split(",").map((item) => item.trim())
  return addresses.includes(proxyAuthority) ? "connect-timeout" : "tls-silent"
}

/** HTTP 应答的状态:APICallError 的 `statusCode`、Effect HTTP 的 `response.status`、MCP SDK HTTP 错误的数字 `code`。 */
function httpStatusOf(node: ErrorNode): number | undefined {
  const candidates = [node.statusCode, node.status, node.response?.status, node.code]
  return candidates.find((value): value is number => typeof value === "number" && value >= 100 && value <= 599)
}

/**
 * 引擎的请求走不走本机出网代理。引擎(sidecar)的代理变量恒被整份改写为出网代理(ui-mac sidecar-env.ts 的
 * sidecarEgressProxyEnv),NO_PROXY 里的名字直连。这里读的就是 sidecar 写进来的那两份值,不另持一份清单;
 * NO_PROXY 只按逐项精确名字匹配 —— 那是 sidecar 写的唯一形状。main 侧的请求一律按 `{ via: "other" }`。
 */
export function engineNetFailurePath(target: string | URL | undefined, env: Record<string, string | undefined>): NetFailurePath {
  const url = typeof target === "string" ? (URL.canParse(target) ? new URL(target) : undefined) : target
  if (!url) return { via: "other" }
  const proxy = url.protocol === "https:" ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy)
  if (!proxy || !URL.canParse(proxy)) return { via: "other" }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase()
  const bypass = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((item) => item.trim().toLowerCase())
  if (bypass.includes(host)) return { via: "other" }
  return { via: "egress-proxy", proxyOrigin: new URL(proxy).origin }
}
