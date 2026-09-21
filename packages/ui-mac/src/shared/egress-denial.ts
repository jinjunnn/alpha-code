// 出网围栏拒绝正文的**唯一**格式定义 —— 写的人(main 的策略代理)与读的人(renderer 的时间线)
// 共用这一个模块。
//
// 背景(`#1382`):`network-egress-proxy.ts` 拒绝一条 CONNECT 时,403 的正文已经说得出原因;
// 而在此之前**那句话没有任何读者** —— 界面把它当成一次普通的调用失败,于是 `#1379`(自带 Key
// 直连被围栏整类拒掉)在线上活了九天没人发现:用户会重试、会查自己的 Key、会怀疑供应商,
// 唯独不会想到是这台电脑上的策略拦的。
//
// 两条纪律写在这里,因为它们决定了本模块的形状:
//
// 1. **格式只有一份。** 拒绝行由 `egressDenialLine()` 拼、由 `egressPolicyDenialOf()` 认。
//    分成两处字面量(代理一份模板、渲染层一份正则)就会无声漂移 —— 那时界面只会退回
//    「普通调用失败」,而**没有任何东西会变红**,正是本票要消灭的那种静默。
// 2. **只认「策略说不」那一格。** 代理有四种失败形态(见 network-egress-proxy.ts 头注),
//    四种的正文都带同一个前缀:
//      403 unregistered       ← 策略拒绝,**只有它**能说成「被本机网络策略拦下」
//      400 bad-authority      ← CONNECT 行不合法
//      405 method-not-connect ← 非 CONNECT
//      502 dial-failed        ← **登记了但拨不通**,这是真的网络故障,不是策略
//    只按前缀匹配 ⇒ 会把 `dial-failed` 说成「被策略拦下」,把人引到查放行名单上去,
//    而真因是那台服务器连不上。归因说错比不归因更坏,所以判据必须细到 reason 这一格。

/** 拒绝正文的可识别前缀。bun 的 fetch 会把代理的 403 当目标响应返回,正文是应用侧唯一的归因线索。 */
export const EGRESS_DENIED_BODY_PREFIX = "alpha egress policy: "

/** 「策略说不」的那一个 reason。其余 reason 一律不按围栏拒绝呈现(见上文第 2 条)。 */
export const EGRESS_POLICY_DENIED_REASON = "unregistered"

/**
 * 拒绝正文的唯一拼法。`reason` 取 network-egress-proxy.ts 的 `EgressDenyReason`
 * (本模块不 import 它 —— 那会把 node:net 拖进 renderer 的打包图)。
 */
export function egressDenialLine(authority: string, reason: string, why: string): string {
  return `${EGRESS_DENIED_BODY_PREFIX}${authority} denied (reason=${reason}) — ${why}\n`
}

/** CONNECT authority 的形状:`host:port` 或 `[v6]:port`。代理在放行判定**之前**已按 RFC 9110
 *  §7.1 解析过,所以 `unregistered` 那一格的 authority 必然合法;形状对不上 ⇒ 不是我们写的那行,
 *  fail-closed 地不认(宁可退回普通失败文案,也不对一个认不出的串下归因)。 */
const AUTHORITY_SHAPE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\]):[0-9]{1,5}$/
const AUTHORITY_MAX_CHARS = 260

/**
 * 在一段错误文本里认出**本机出网策略的拒绝**,并取出被拒的目的地。
 *
 * 文本可能是引擎给出的 `message`(实测形如 `Forbidden: alpha egress policy: …`,前缀不在首位)
 * 或原始 `responseBody`(前缀在首位),所以按**包含**匹配而不是 `startsWith`。
 *
 * 认不出 ⇒ `undefined`,调用方保持原文案不变。
 */
export function egressPolicyDenialOf(text: string | undefined | null): { authority: string } | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined
  const prefixAt = text.indexOf(EGRESS_DENIED_BODY_PREFIX)
  if (prefixAt < 0) return undefined
  const authorityAt = prefixAt + EGRESS_DENIED_BODY_PREFIX.length
  const marker = ` denied (reason=${EGRESS_POLICY_DENIED_REASON})`
  const markerAt = text.indexOf(marker, authorityAt)
  if (markerAt < 0) return undefined
  const authority = text.slice(authorityAt, markerAt)
  if (authority.length === 0 || authority.length > AUTHORITY_MAX_CHARS) return undefined
  if (!AUTHORITY_SHAPE.test(authority)) return undefined
  return { authority }
}
