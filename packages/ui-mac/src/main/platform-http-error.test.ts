// #940 —— 分类码咽喉自身的形状域判据。
//
// 输入形状域按**平台真实产出**枚举(实读 alpha-platform@0883b28,两种信封 + 各种坏形状),
// 不是按实现里的分支枚举;负向夹具刻意避开最退化形状(不是只测空 body)。
// 各用例的 code/status 字面量互不相同 —— 期望值恰好等于一个可硬编码常量的判据杀不掉写死。

import { expect, test } from "bun:test"
import { CLASSIFICATION_CODE, httpErrorCode, httpStatusFallback, platformErrorParts } from "./platform-http-error"

const res = (status: number, body: string) => new Response(body, { status })

test("cloud 形状(顶层 code + 散文 error):code 进,散文只进 prose 槽", async () => {
  const parts = await platformErrorParts(
    res(429, JSON.stringify({ error: "rate limited: too many requests from this IP", code: "rate_limited" })),
  )
  expect(parts).toEqual({
    code: "rate_limited",
    prose: "rate limited: too many requests from this IP",
    fallback: "http-429",
  })
  expect(await httpErrorCode(res(429, JSON.stringify({ error: "…", code: "rate_limited" })))).toBe("rate_limited")
})

test("models/account 嵌套形状({ error: { message, code } }):嵌套 code 一样被认出 —— #918 只认顶层,这条在它手里是 http-403", async () => {
  const body = JSON.stringify({ error: { message: "forbidden: api key lacks scope 'models'", code: "scope_forbidden" } })
  expect(await httpErrorCode(res(403, body))).toBe("scope_forbidden")
  const parts = await platformErrorParts(res(403, body))
  expect(parts.prose).toBe("forbidden: api key lacks scope 'models'")
})

test("fail-closed:无 code 的散文体保持 http-<status>,不拿散文冒充分类码", async () => {
  expect(await httpErrorCode(res(404, JSON.stringify({ error: "schedule not found" })))).toBe("http-404")
  const parts = await platformErrorParts(res(404, JSON.stringify({ error: "schedule not found" })))
  expect(parts.code).toBeUndefined()
  expect(parts.prose).toBe("schedule not found")
})

test("fail-closed:非 JSON / 空 body / JSON 非对象,一律回退,不抛不猜", async () => {
  expect(await httpErrorCode(res(502, "<html>Bad Gateway</html>"))).toBe("http-502")
  expect(await httpErrorCode(res(504, ""))).toBe("http-504")
  expect(await httpErrorCode(res(410, JSON.stringify(["upload_reserved_input"])))).toBe("http-410")
})

test("fail-closed:code 槽在但不合分类码文法(大写 / 太短 / 非字符串 / 带空格)⇒ 回退", async () => {
  expect(await httpErrorCode(res(422, JSON.stringify({ code: "Upload_Reserved" })))).toBe("http-422")
  expect(await httpErrorCode(res(451, JSON.stringify({ code: "ab" })))).toBe("http-451")
  expect(await httpErrorCode(res(409, JSON.stringify({ code: 409 })))).toBe("http-409")
  expect(await httpErrorCode(res(400, JSON.stringify({ error: { code: "not a code" } })))).toBe("http-400")
})

test("顶层 code 优先于嵌套 code(两个都合法时取顶层 —— cloud 形状是钉了出处的主形状)", async () => {
  const body = JSON.stringify({ code: "billing_unready", error: { message: "x", code: "job_ledger_unavailable" } })
  expect(await httpErrorCode(res(503, body))).toBe("billing_unready")
})

test("文法闸与回退构造器:分类码文法拒大写/短串,httpStatusFallback 是 http- 的唯一出口形状", () => {
  expect(CLASSIFICATION_CODE.test("upload_purpose_rejected")).toBe(true)
  expect(CLASSIFICATION_CODE.test("HTTP400")).toBe(false)
  expect(httpStatusFallback(418)).toBe("http-418")
})
