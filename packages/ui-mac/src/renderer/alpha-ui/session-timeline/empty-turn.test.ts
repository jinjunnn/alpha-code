// REQ-160 AC3(`#1318` / `#1325`)—— 空回合判据。
//
// 四条**同时**成立才算。这张票最容易做假的地方就是「少一条也触发」——那会把正常回复标成异常。
// 所以每一条都有一个**只差它一条**的反例。
import { describe, expect, test } from "bun:test"
import { isEmptyUnknownTurn } from "./timeline-model"

type A = Parameters<typeof isEmptyUnknownTurn>[0]
const turn = (over: Record<string, unknown> = {}): A =>
  ({ id: "msg_1", role: "assistant", finish: "unknown", tokens: { input: 0, output: 0, reasoning: 0 }, ...over }) as unknown as A

describe("REQ-160 AC3 空回合判据:四条同时成立才算", () => {
  test("正样本:回合结束 + finish=unknown + 零可见正文 + tokens.output=0", () => {
    expect(isEmptyUnknownTurn(turn(), 0)).toBe(true)
  })

  test("反例①:有可见正文 ⇒ 不算(票面 Non-goals:finish=unknown 但有正文的不是这一类)", () => {
    expect(isEmptyUnknownTurn(turn(), 1)).toBe(false)
  })

  test("反例②:finish 不是 unknown ⇒ 不算(stop + 明确拒答文本是另一回事)", () => {
    for (const finish of ["stop", "length", "tool-calls", undefined]) {
      expect(isEmptyUnknownTurn(turn({ finish }), 0)).toBe(false)
    }
  })

  test("反例③:tokens.output 非 0 ⇒ 不算(模型确实产出了,只是没落成可见正文)", () => {
    expect(isEmptyUnknownTurn(turn({ tokens: { input: 12, output: 7, reasoning: 0 } }), 0)).toBe(false)
  })

  test("反例④:被用户中止 ⇒ 不算,那是中断行的辖区(两行不得同时出现)", () => {
    expect(isEmptyUnknownTurn(turn({ error: { name: "MessageAbortedError" } }), 0)).toBe(false)
  })

  test("反例⑤:tokens 缺席或形状不对 ⇒ 不算(拿不准就不标,不猜)", () => {
    for (const tokens of [undefined, null, 0, "0", {}]) {
      expect(isEmptyUnknownTurn(turn({ tokens }), 0)).toBe(false)
    }
  })

  test("控制臂:恒答 true 的替身会把上面每一个反例都标成空回合", () => {
    const alwaysTrue = () => true
    const counterExamples: [A, number][] = [
      [turn(), 1],
      [turn({ finish: "stop" }), 0],
      [turn({ tokens: { input: 0, output: 7, reasoning: 0 } }), 0],
      [turn({ error: { name: "MessageAbortedError" } }), 0],
    ]
    for (const [a, emitted] of counterExamples) {
      expect(isEmptyUnknownTurn(a, emitted)).toBe(false)
      expect(alwaysTrue()).toBe(true) // 替身放行 —— 这正是上面那些断言要抓的形态
    }
  })
})
