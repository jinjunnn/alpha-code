// [#940] 咽喉本体的行为判据。每条断言先问过「一个错误实现能不能满足它?」——
// 把咽喉改回 `http-${res.status}`(#918 之前的形态)⇒ 第一条当场红;
// 把咽喉改成「无码时猜/透出散文」⇒ 对照臂红。
import { describe, expect, test } from "bun:test"
import { httpErrorCode } from "./platform-error-code"

const res = (status: number, body: string) => new Response(body, { status })

describe("httpErrorCode — 平台拒绝的唯一出口", () => {
  test("400 + 稳定分类码 ⇒ 用户拿到的是那个 code,不是数字", async () => {
    expect(await httpErrorCode(res(400, JSON.stringify({ error: "upload rejected", code: "upload_reserved_input" })))).toBe(
      "upload_reserved_input",
    )
    expect(
      await httpErrorCode(
        res(400, JSON.stringify({ error: "denied_paths cannot be enforced…", code: "denied_paths_unenforceable_for_execution_form" })),
      ),
    ).toBe("denied_paths_unenforceable_for_execution_form")
    expect(await httpErrorCode(res(503, JSON.stringify({ error: "billing not ready", code: "billing_unready" })))).toBe("billing_unready")
  })

  test("对照臂:无 code(或形状不认识)⇒ 保持 http-<status>,不猜", async () => {
    expect(await httpErrorCode(res(400, JSON.stringify({ error: "invalid request body" })))).toBe("http-400")
    expect(await httpErrorCode(res(500, "not json at all"))).toBe("http-500")
    expect(await httpErrorCode(res(404, ""))).toBe("http-404")
  })

  test("code 槽形状闸:非 snake_case / 非字符串 / 超长一律回退,不把垃圾贴进错误行", async () => {
    expect(await httpErrorCode(res(400, JSON.stringify({ code: "NOT_A_CODE" })))).toBe("http-400")
    expect(await httpErrorCode(res(400, JSON.stringify({ code: 123 })))).toBe("http-400")
    expect(await httpErrorCode(res(400, JSON.stringify({ code: "ab" })))).toBe("http-400") // 短于 3
    expect(await httpErrorCode(res(400, JSON.stringify({ code: `a${"b".repeat(64)}` })))).toBe("http-400") // 长于 64
    expect(await httpErrorCode(res(400, JSON.stringify({ code: "has space" })))).toBe("http-400")
  })

  test("`error` 是散文槽,绝不透出(可能携带路径/租户)", async () => {
    const out = await httpErrorCode(res(400, JSON.stringify({ error: "/Users/someone/secret-project rejected" })))
    expect(out).toBe("http-400")
    expect(out).not.toContain("secret-project")
  })
})
