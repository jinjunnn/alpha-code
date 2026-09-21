// `#1382` —— 归因判据本体。AC2 比 AC1 重要:**把所有网络错误都说成围栏拦的,比不归因更坏**,
// 它会把人从「那台服务器连不上」引到「去查放行名单」。所以本文件的主角不是那条正向断言,
// 而是**控制臂**:先证明这份语料能判出两种坏实现,再用它判真实现。
//
// 语料是**手写字面量**,不经 `egressDenialLine()` 生成 —— 锚点与被测对象同源就成了自指等价链
// (本仓已栽过:期望值 import 生产常量,改错它 15/15 仍绿)。正向那两条逐字抄自实测采样:
// 真代理 + bun fetch + @ai-sdk/openai / @ai-sdk/anthropic 打到未登记目的地,
// `APICallError.responseBody` 与 `ProviderError.parseAPICallError().message` 的原文。
// 生产拼串与本判据的一致性另有一条闸(network-egress-proxy.test.ts:真代理的 403 正文喂给本函数)。
import { describe, expect, test } from "bun:test"
import { EGRESS_DENIED_BODY_PREFIX, egressPolicyDenialOf } from "./egress-denial"

type Detector = (text: string | undefined | null) => { authority: string } | undefined

/** 必须被归因成「本机出网策略拒绝」的样本,以及必须取出的目的地。 */
const ATTRIBUTED = [
  {
    id: "responseBody-逐字(实测,@ai-sdk/openai)",
    text: "alpha egress policy: api.probe-1382.invalid:443 denied (reason=unregistered) — blocked by this app's local egress policy — the destination is neither a registered app endpoint (packages/ui-mac/src/main/network-egress-registry.ts) nor one of the built-in model providers this machine holds a key for\n",
    authority: "api.probe-1382.invalid:443",
  },
  {
    id: "message-逐字(实测,前缀不在首位:上游把状态短语接在前面)",
    text: "Forbidden: alpha egress policy: api.openai.com:443 denied (reason=unregistered) — blocked by this app's local egress policy — the destination is neither a registered app endpoint (packages/ui-mac/src/main/network-egress-registry.ts) nor one of the built-in model providers this machine holds a key for",
    authority: "api.openai.com:443",
  },
  {
    id: "IPv6 字面量目的地",
    text: "alpha egress policy: [2001:db8::1]:443 denied (reason=unregistered) — blocked by this app's local egress policy",
    authority: "[2001:db8::1]:443",
  },
  {
    id: "loopback + 非 443 端口(自建节点的常见形状)",
    text: "Forbidden: alpha egress policy: 127.0.0.1:11434 denied (reason=unregistered) — blocked by this app's local egress policy",
    authority: "127.0.0.1:11434",
  },
] as const

/** 必须**不**被归因成围栏拒绝的样本。前六条是真实的非围栏失败,后四条是围栏自己的其它形态 —— * 它们带同一个前缀,却各有各的真因。 */
const NOT_ATTRIBUTED = [
  {
    id: "连不上(实测:无代理、目标端口无人监听)",
    text: "Failed after 3 attempts. Last error: Cannot connect to API: Unable to connect. Is the computer able to access the url?",
  },
  {
    id: "登记了但拨不通(实测:代理 502 之后上游重试耗尽的形态)",
    text: "Failed after 3 attempts. Last error: Bad Gateway",
  },
  { id: "读超时", text: "Provider response headers timed out after 60000ms" },
  { id: "限流", text: "Rate limit reached for gpt-4o in organization org-x on tokens per min" },
  { id: "鉴权失败", text: "Unauthorized: incorrect API key provided" },
  { id: "空文本", text: "" },
  {
    id: "围栏的 dial-failed:登记在案、真的连不上 —— 说成「策略拦的」会把人引去查放行名单",
    text: "alpha egress policy: github.com:443 denied (reason=dial-failed) — registered destination could not be reached (ETIMEDOUT)\n",
  },
  {
    id: "围栏的 bad-authority:CONNECT 行本身不合法,不是目的地被拒",
    text: "alpha egress policy: github.com denied (reason=bad-authority) — CONNECT authority must be host:port\n",
  },
  {
    id: "围栏的 method-not-connect:明文 HTTP,不是目的地被拒",
    text: "alpha egress policy: GET http://example.com/ denied (reason=method-not-connect) — this proxy only serves CONNECT tunnels\n",
  },
  {
    id: "别人的网关用了相似措辞,但没有我们的前缀",
    text: "the request was denied (reason=unregistered) by the upstream gateway",
  },
  {
    id: "前缀在,但目的地不是 host:port —— 认不出就不下归因",
    text: "alpha egress policy: not a real authority denied (reason=unregistered) — blocked by this app's local egress policy",
  },
] as const

/**
 * 判据本体做成函数,是为了让控制臂用**同一份**判据跑一遍:任何一格不成立都收进 problems
 * 并说清是哪一条样本(而不是抛),于是「坏实现被判据抓住」这件事本身可以被断言。
 */
function judgeAttribution(detect: Detector): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  for (const sample of ATTRIBUTED) {
    const verdict = detect(sample.text)
    if (!verdict) problems.push(`漏判(该归因却没归因):${sample.id}`)
    else if (verdict.authority !== sample.authority)
      problems.push(`目的地取错:${sample.id} —— 取到 ${JSON.stringify(verdict.authority)},应为 ${JSON.stringify(sample.authority)}`)
  }
  for (const sample of NOT_ATTRIBUTED) {
    const verdict = detect(sample.text)
    if (verdict) problems.push(`误判(不该归因却归因了,目的地=${JSON.stringify(verdict.authority)}):${sample.id}`)
  }
  if (detect(undefined)) problems.push("误判:undefined 也被说成围栏拦的")
  return { ok: problems.length === 0, problems }
}

describe("#1382 AC2 控制臂:先证明这份语料能判出已知的坏实现", () => {
  test("坏实现①「一律归因」—— 把普通超时/连不上也说成围栏拦的 ⇒ 判据必须当场红并逐条点名", () => {
    const alwaysFence: Detector = () => ({ authority: "the network" })
    const verdict = judgeAttribution(alwaysFence)
    console.log(`[#1382 AC2 控制臂① 一律归因] ok=${verdict.ok} problems=${verdict.problems.length}\n  ${verdict.problems.join("\n  ")}`)
    expect(verdict.ok).toBe(false)
    // 逐条点名,而不是只断一个布尔:布尔为假可以由任何一条引起,包括正向那格写错。
    expect(verdict.problems.join("\n")).toContain("连不上(实测")
    expect(verdict.problems.join("\n")).toContain("读超时")
    expect(verdict.problems.join("\n")).toContain("限流")
    expect(verdict.problems.join("\n")).toContain("undefined 也被说成围栏拦的")
    // 负侧每一条 + undefined 那一格,一条不漏。
    expect(verdict.problems.filter((p) => p.startsWith("误判"))).toHaveLength(NOT_ATTRIBUTED.length + 1)
  })

  test("坏实现②「只看前缀」—— 围栏的其它三种失败形态同样带前缀 ⇒ 判据必须红在那三条上", () => {
    const prefixOnly: Detector = (text) => {
      if (typeof text !== "string") return undefined
      const at = text.indexOf(EGRESS_DENIED_BODY_PREFIX)
      if (at < 0) return undefined
      const rest = text.slice(at + EGRESS_DENIED_BODY_PREFIX.length)
      const end = rest.indexOf(" denied (")
      return { authority: end < 0 ? rest.trim() : rest.slice(0, end) }
    }
    const verdict = judgeAttribution(prefixOnly)
    console.log(`[#1382 AC2 控制臂② 只看前缀] ok=${verdict.ok} problems=${verdict.problems.length}\n  ${verdict.problems.join("\n  ")}`)
    expect(verdict.ok).toBe(false)
    const joined = verdict.problems.join("\n")
    expect(joined).toContain("dial-failed")
    expect(joined).toContain("bad-authority")
    expect(joined).toContain("method-not-connect")
    // 只看前缀的实现在**普通网络错误**上是对的 —— 所以它正是那种「两轮全绿」的坏实现:
    // 少了 dial-failed 这条语料,控制臂①之外的这一类就一条都抓不到。
    expect(joined).not.toContain("读超时")
    expect(verdict.problems.filter((p) => p.startsWith("误判"))).toHaveLength(4)
  })

  test("坏实现③「不取目的地」—— 归因对了但地址恒空 ⇒ AC1 的「带上被拒的地址」必须红", () => {
    const noAuthority: Detector = (text) =>
      typeof text === "string" && text.includes("denied (reason=unregistered)") ? { authority: "" } : undefined
    const verdict = judgeAttribution(noAuthority)
    console.log(`[#1382 AC2 控制臂③ 不取目的地] ok=${verdict.ok} problems=${verdict.problems.length}`)
    expect(verdict.ok).toBe(false)
    expect(verdict.problems.filter((p) => p.startsWith("目的地取错"))).toHaveLength(ATTRIBUTED.length)
  })
})

describe("#1382 AC1/AC2 真实现:同一份判据全绿", () => {
  test("生产识别器判完整语料 0 problem", () => {
    const verdict = judgeAttribution(egressPolicyDenialOf)
    console.log(`[#1382 真实现] ok=${verdict.ok} problems=${JSON.stringify(verdict.problems)}`)
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  test("语料本身不退化:正负两侧都非空,且负侧真的包含带前缀的其它形态", () => {
    expect(ATTRIBUTED.length).toBeGreaterThanOrEqual(4)
    expect(NOT_ATTRIBUTED.length).toBeGreaterThanOrEqual(10)
    // 带前缀却不该归因的四条(dial-failed / bad-authority / method-not-connect / 目的地认不出)——
    // 少了它们,「只看前缀」那种坏实现在本语料上会全绿。
    expect(NOT_ATTRIBUTED.filter((s) => s.text.includes(EGRESS_DENIED_BODY_PREFIX))).toHaveLength(4)
  })
})
