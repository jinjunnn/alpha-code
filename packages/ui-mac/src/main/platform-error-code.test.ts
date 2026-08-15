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

  // ── [ac#962] 第二种信封形状:嵌套 `{ error: { message, code } }`(gateway wire) ──────────
  // 三个期望码都是**测试内的独立字面量**,不从生产 import、也不从 alpha-platform import ——
  // 比较基准与被测对象同源就是自指等价链,一起改错就一起自洽。
  test("[ac#962] 嵌套信封 {error:{message,code}} 的码同样被取出来,不再压成 http-<status>", async () => {
    // alpha-platform packages/gateway/src/worker.ts 的 rateLimitRequest(429)。
    expect(
      await httpErrorCode(
        res(429, JSON.stringify({ error: { message: "rate limited: too many requests from this IP", code: "rate_limited" } })),
      ),
    ).toBe("rate_limited")
    // 同文件 envIdentityServeGate(500)。
    expect(
      await httpErrorCode(
        res(
          500,
          JSON.stringify({ error: { message: "refusing to serve: PLATFORM_ENV=dev …", code: "dev_semantics_on_production_target" } }),
        ),
      ),
    ).toBe("dev_semantics_on_production_target")
    // anthropic-wire 变体:多一个 `type` 兄弟键与 `missing` 数组。码值取自 gateway readiness.ts
    // 的 BILLING_UNREADY_CODE(**注意**是 `billing_dependencies_unready`;本文件上面那条
    // `billing_unready` 是合成字面量,不对应任何真实平台码)。
    expect(
      await httpErrorCode(
        res(
          503,
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "m", code: "billing_dependencies_unready", missing: ["account_url"] },
          }),
        ),
      ),
    ).toBe("billing_dependencies_unready")
  })

  test("[ac#962] 嵌套形状的 fail-closed 半场不松;两槽都有码时**顶层赢**;嵌套 message 仍不透出", async () => {
    // 无码 —— 负向夹具刻意不用「空 body / 无 error 键」这种最退化形状。
    expect(await httpErrorCode(res(500, JSON.stringify({ error: { message: "boom" } })))).toBe("http-500")
    // 有码但违文法 / 越 64 界 —— 加嵌套时最容易漏套的就是这道正则。
    expect(await httpErrorCode(res(400, JSON.stringify({ error: { message: "m", code: "NOT_A_CODE" } })))).toBe("http-400")
    expect(await httpErrorCode(res(400, JSON.stringify({ error: { message: "m", code: "has space" } })))).toBe("http-400")
    expect(await httpErrorCode(res(400, JSON.stringify({ error: { code: `a${"b".repeat(64)}` } })))).toBe("http-400")
    // `error` 是数组 / `code` 是对象 / `error` 是 null —— 都是**正常形状**,不许靠外层 catch 兜。
    expect(await httpErrorCode(res(400, JSON.stringify({ error: [{ code: "sneaky_code" }] })))).toBe("http-400")
    expect(await httpErrorCode(res(400, JSON.stringify({ error: { code: { deeper: "x" } } })))).toBe("http-400")
    expect(await httpErrorCode(res(400, JSON.stringify({ error: null })))).toBe("http-400")
    // 优先级:两个槽都有合法码时顶层赢(cloud 面今天靠顶层码工作,不许被静默改掉)。
    expect(await httpErrorCode(res(400, JSON.stringify({ code: "top_level_wins", error: { code: "nested_loses" } })))).toBe(
      "top_level_wins",
    )
    // #940 的「`error` 是散文槽」纪律扩到嵌套:无码时**不得**回落到 error.message。
    const leaky = await httpErrorCode(res(400, JSON.stringify({ error: { message: "/Users/someone/secret-project rejected" } })))
    expect(leaky).toBe("http-400")
    expect(leaky).not.toContain("secret-project")
  })
})
