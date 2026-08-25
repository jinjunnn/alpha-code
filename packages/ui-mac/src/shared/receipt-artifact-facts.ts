// receipt-artifact-facts — REQ-105(#319)。
//
// 一张 receipt 上有两个不同的事实,详情页必须把它们分开说:
//   · `version` —— catalog **卡片**的版本(`mcp:alpha-excel` 是 `1.0.0`)。它命名连接器,
//     **不命名它执行的字节**。2026-07-14 逐需求审计记下的正是这个形态:
//     「receipt 记录条目版 1.0.0 而实际执行 0.1.8 且无包 digest 字段」。
//   · `payloadDigest` —— 安装时记录的**执行物内容地址**(`sha256:<64 hex>`)。
//
// 本模块只做一件事:把 receipt 上的这两个字段变成可呈现的事实,并且在 digest 不可信时
// **拒绝把它当 digest 呈现**(AC5:不得把未知或未验证 digest 表示为已审计)。缺省与格式非法
// 都归为同一个诚实结论 `digest: null` —— 呈现层据此说「未记录」,而不是显示半截字符串。
// 纯模块:无 node、无 solid、无 i18n(文案由调用方按 locale 取)。

/** 与 `ext-receipt-v2.ts` / `alpha-installs.ts` 落盘校验同一形状。此处独立成字面量而不是从 main
 *  import,是因为呈现层必须能独立判定「这串东西看起来像不像一个 digest」。 */
export const RECEIPT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/

/** 短展示形态保留的十六进制位数。够人眼比对 catalog/lock 上的同一个值,又不撑爆头部元信息行。 */
const SHORT_HEX_CHARS = 12

export type ReceiptArtifactFacts = {
  /** 账本记着的卡片版本;账本没有就是 undefined(不编造,不回退 catalog)。 */
  version: string | undefined
  /** 完整内容地址;缺省或格式非法一律 null。 */
  digest: string | null
  /** 头部元信息行用的短形态;当且仅当 digest 为 null 时为 null。 */
  digestShort: string | null
}

/** 从(可能不存在的)receipt 派生可呈现事实。输入取最小结构面,便于合成 receipt 同样过闸。 */
export function receiptArtifactFacts(
  receipt: { version?: string; payloadDigest?: string } | undefined | null,
): ReceiptArtifactFacts {
  const version = typeof receipt?.version === "string" && receipt.version.length > 0 ? receipt.version : undefined
  const raw = receipt?.payloadDigest
  if (typeof raw !== "string" || !RECEIPT_DIGEST_RE.test(raw)) return { version, digest: null, digestShort: null }
  return { version, digest: raw, digestShort: `sha256:${raw.slice("sha256:".length, "sha256:".length + SHORT_HEX_CHARS)}…` }
}
