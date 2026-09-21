// REQ-137 · `#1379` —— 授权目的地的**动态半场**:自带 Key(BYOK)直连的目的地,由用户的有效配置派生。
//
// ── 为什么静态表装不下 ─────────────────────────────────────────────────────────────────
// network-egress-registry.ts 登记的是「这个应用自己总会去连的那些地址」:常量、冻结、评审逐行可读。
// BYOK 直连不是这种东西 —— 引擎会去连哪一家,由**用户配置了谁**决定(今天 DeepSeek,明天智谱,后天一家
// 我们没听说过的)。注册表抬头「刻意不在表里的」第一条写的正是这件事,而 0.1.13 把那张静态表发出去之后,
// 这一整类被拒掉:`#1379` 现场日志里 `api.deepseek.com:443` / `open.bigmodel.cn:443` → `verdict:"deny"
// reason:"unregistered"`,同一次启动 `alpha-cloud.tidelabs.click:443` → allow、`DEEPSEEK_API_KEY` /
// `ZHIPU_API_KEY` 的密钥文件也都写进去了。即:自带 Key 的模型一条消息都发不出,而拦它的是我们自己。
//
// ── 为什么不是「往表里补几个域名」──────────────────────────────────────────────────────
// 补 DeepSeek 和智谱,下一个供应商照样 403;而「下一个供应商」恰恰是这条路的卖点。手写清单与缺陷同形。
// 放行集合从**引擎真正会去连的那个值**派生 —— 有效配置里 `provider.<id>.options.baseURL`(回退字段
// `api`;alpha-config-injection.ts:457-462 的 v2 桥读的就是这两个,判据与顺序也逐字照它)。
//   谁写这个值:目录 BYOK 节点 = alpha-models.json 的 `baseURL`(编译进包的常量),且**只在密钥文件在场时**
//               才注入(alpha-models.ts:68-99 —— 「用户配置过这一家」在这里就是一个文件在不在的问题)。
//   谁读这个值:引擎(AI SDK)照它发请求 ⇒ 策略代理看到的那条 CONNECT authority 就是它的 `host:port`。
// 同一个值两边读,结构上不可能分叉 —— 这是「不再手写清单」的全部意义,也是评审该盯的那一点。
//
// ── 唯一的输入是注入面,**配置文件不算数**(`#1380` R1 Blocker)────────────────────────
// 动态半场只吃 `buildAlphaModelConfig(userDataPath).provider`。配置文件里的 provider 块(alpha.jsonc /
// `<XDG_CONFIG_HOME>/opencode` / `~/.opencode`)**刻意不读** —— 那三条路径全在 seatbelt 的可写集里
// (process-fence-profile.ts 的 W2 / W6 / W16),而可写集里的东西正是**被围栏的引擎树自己能写的**。
// 读它 = 引擎树里任意一段代码(bash 工具、仓库自带 plugin、MCP stdio 子进程)写一行
//   {"provider":{"x":{"options":{"baseURL":"https://exfil.example"}}}}
// 就给自己铸出一条出网通道,下一次 fork 后代理照放 —— 教科书式的 confused deputy,围栏对任意目的地开口。
// 「有效配置」这个词在这里必须窄读成**围栏外的那一半**:catalog 是编译进包的常量,密钥文件由 main 在
// fork 前 syncSecretFiles 收敛(不在 wanted 集合里的遗留文件当场扫掉),两者都不在引擎的可写集里。
// **代价是如实的**:用户手工添加的自定义节点(其 baseURL 只住在那个可写文件里)仍然被拒。要支持它,
// 得先给自定义节点的 baseURL 找一个围栏外的真源 —— 那是另一件事,不是在这里多读一个文件。
//
// ── 收进来的条件(fail-closed:四条全中才登记)─────────────────────────────────────────
//   1. `new URL()` 解析得出(解析不出 ⇒ 不猜);
//   2. scheme = `https:` —— 明文出网不因本机制被放行;
//   3. host 不是 loopback —— owner 2026-09-10 裁决:本机模型(ollama 一类)要单独设计「本机目的地怎么走」。
//      围栏只放行代理端口那一个 loopback 目的地,且 sidecar 的 NO_PROXY 含 `127.0.0.1,localhost,::1`
//      ⇒ 这类目的地根本不经代理;放行它不会让它可达,只会让登记簿说假话(注册表抬头同条);
//   4. host 过**静态表同一个**形状判据(`isEgressHostShape`:DNS 名或 IPv4 字面量)—— 是同一个函数,
//      不是抄一份正则。IPv6 字面量(`new URL().hostname` 给的是带括号的 `[::1]` 形)因此一条都产不出来。
// 产物仍然是**精确 `host:port`**:不做通配、不做后缀、不做 IP↔名字等价(理由同注册表抬头 §匹配语义)。
// 端口取 URL 里的显式端口,没有写就按 https 取 443 —— 与代理侧「端口是键的一部分」同一口径。
//
// ── 生命周期:整份替换,每代一次 ───────────────────────────────────────────────────────
// server.ts 在**每次 fork 之前**重算并整份替换(不是追加)。配置结构性变化本来就会
// `respawning sidecar { reason: 'structural' }`,所以「配置变了 ⇒ 放行集合跟着变」有现成的时机;
// 用户删掉一家 provider,下一代就不再放行它。代理是跨 respawn 复用的单例,但它每条 CONNECT 都现问
// `isEgressAuthorizedForSidecar` ⇒ 换代即生效,不必重启代理。
// 进程内单例是刻意的:代理与 main 同进程,而放行集合与「这一代 sidecar 拿到的那份配置」一一对应。

import { isEgressAuthorized, isEgressHostShape } from "./network-egress-registry"

export type ConfiguredEgressDestination = {
  /** 小写 DNS 名或 IPv4 字面量;不带 scheme / path / 通配。 */
  host: string
  port: number
  /** 派生出处 ①:有效配置里的 provider id。 */
  providerId: string
  /**
   * 派生出处 ②:那一行 baseURL,**已归一**为 `origin + pathname` —— userinfo / query / hash 一律丢掉。
   * 不留原文是因为 `https://user:pw@host/v1` 是合法 URL,而这个结构会被日志与诊断顺手打印出来;
   * 出处坐标不需要凭据部分。评审与日志据此判「这一条凭什么在」。
   */
  baseURL: string
}

/** 本机目的地(REQ-137 owner 2026-09-10 裁决:另行设计,绝不进任何放行集合)。 */
const LOOPBACK_NAMES = new Set(["localhost", "0.0.0.0", "::1", "[::1]", "::", "[::]"])
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return LOOPBACK_NAMES.has(h) || h === "localhost." || h.endsWith(".localhost") || LOOPBACK_V4.test(h)
}

/** 一条 baseURL → 一个精确目的地,或 undefined(四条准入有一条不过就是 undefined —— 不猜、不修补)。 */
export function egressDestinationFromBaseUrl(baseURL: unknown, providerId: string): ConfiguredEgressDestination | undefined {
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) return undefined
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:") return undefined
  const host = url.hostname.toLowerCase()
  if (isLoopbackHost(host)) return undefined
  if (!isEgressHostShape(host)) return undefined
  const port = url.port ? Number(url.port) : 443
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port, providerId, baseURL: `${url.origin}${url.pathname}` }
}

/**
 * 从一份有效配置的 `provider` 表派生目的地。字段选择与 alpha-config-injection.ts 的 v2 桥
 * (`typeof options.baseURL === "string" ? … : typeof api === "string" ? … : undefined`)**逐字同源**:
 * `options.baseURL` **是字符串就赢**,回退到 `api` 的条件是它不是字符串,而**不是**「它派生失败」。
 * 这个区别有后果:`options.baseURL = "https://[::1]/v1"` 时 v2 桥选的是那个 v6 地址(引擎去连它),
 * 若这里回退去读 `api`,放行的就是一个引擎根本不会连的 host —— 两边分叉正是本模块要杜绝的东西。
 * 认不出的 block 静默跳过:它只是产不出目的地(⇒ 仍被拒),不影响别的 provider。
 */
export function deriveEgressDestinations(providers: unknown): ConfiguredEgressDestination[] {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return []
  const out: ConfiguredEgressDestination[] = []
  for (const [providerId, block] of Object.entries(providers as Record<string, unknown>)) {
    if (!block || typeof block !== "object") continue
    const options = (block as { options?: unknown }).options
    const fromOptions = options && typeof options === "object" && !Array.isArray(options) ? (options as { baseURL?: unknown }).baseURL : undefined
    const chosen = typeof fromOptions === "string" ? fromOptions : (block as { api?: unknown }).api
    const destination = egressDestinationFromBaseUrl(chosen, providerId)
    if (destination) out.push(destination)
  }
  return out
}

const key = (host: string, port: number): string => `${host.toLowerCase()}:${port}`

let configured: ReadonlyMap<string, ConfiguredEgressDestination> = new Map()

/**
 * 整份替换本代的动态半场,返回**真正被接受**的那些(去重后)。
 *
 * 准入在这里再判一次,而不是信调用方:派生函数是这个模块的正常入口,但它不是唯一入口 —— 谁要是
 * 绕过它直接塞一条 loopback 或一个畸形 host 进来,这里当场丢掉。「登记簿只登记得下它说得出口的东西」。
 */
export function setConfiguredEgressDestinations(destinations: readonly ConfiguredEgressDestination[]): ConfiguredEgressDestination[] {
  const next = new Map<string, ConfiguredEgressDestination>()
  for (const d of destinations) {
    if (typeof d?.host !== "string" || d.host.length === 0) continue
    const host = d.host.toLowerCase()
    if (isLoopbackHost(host) || !isEgressHostShape(host)) continue
    if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) continue
    const k = key(host, d.port)
    if (!next.has(k)) next.set(k, { ...d, host })
  }
  configured = next
  return [...next.values()]
}

/** 本代动态半场的内容(日志 / 测试用;调用方拿到的是拷贝)。 */
export function getConfiguredEgressDestinations(): ConfiguredEgressDestination[] {
  return [...configured.values()]
}

/** 动态半场的成员判定。语义与静态表逐字相同:精确 `host:port`,大小写归一,端口是键的一部分。 */
export function isConfiguredEgressDestination(host: string, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  return configured.has(key(host, port))
}

/**
 * 策略代理的生产判据 = 静态表 ∪ 本代由用户配置派生的动态半场。
 * 两个半场都是精确匹配、都 fail-closed;不在任何一边 ⇒ 403 unregistered(代理侧唯一的「闸门说不」)。
 */
export function isEgressAuthorizedForSidecar(host: string, port: number): boolean {
  return isEgressAuthorized(host, port) || isConfiguredEgressDestination(host, port)
}
