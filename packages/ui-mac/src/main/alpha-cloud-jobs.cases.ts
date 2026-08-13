// #727 —— Cloud job 客户端的 action 选择闸门。
//
// 为什么这是闸门而不是文本断言:alpha-web 按 purpose **分别**签发 token
// (alpha-auth.ts `platform_access_tokens`,五个 purpose 缺一不可),alpha-platform 再按
// `claims.purpose !== request.action → 403`(gateway lib/action-authorization.ts)判权。
// 所以「客户端选错 action」不是风格问题:有效登录用户会在该端点结构性吃 403。
// 下面的假服务端施行的正是同一条规则,断言落在**可观察结果**上(拿到列表 / 吃 403),
// 不是落在源码里出现过哪个字符串。
//
// mock.module 会污染同进程其它测试文件 ⇒ 真断言放这里,由 alpha-cloud-jobs.test.ts
// 在隔离子进程里跑(cloud-ipc.test.ts 同款)。

import { expect, mock, test } from "bun:test"
import type { RoutePurpose } from "@alpha-code/contracts-consumer"

const BASE = "https://cloud.invalid"
const JOB = "job_test_0001"

// 假 token 把 purpose 编进字符串,让假服务端能施行 claims.purpose === action。
const tokenFor = (purpose: RoutePurpose) => `tok.${purpose}`
const purposeOf = (bearer: string): string => bearer.replace(/^Bearer tok\./, "")

/** 每次 getAccessToken 请求的 purpose(按调用序)。用于判「有没有多要 / 要了通配」。 */
const requested: RoutePurpose[] = []
/** 每次出网请求的 (path, bearer, body)。body 用于断言重试的每一发带的是**同一个**幂等键。 */
const wire: Array<{ path: string; bearer: string; body?: string }> = []
/** #400 注入的瞬态失败队列:每元素消费一次 —— "network" 抛(超时/断连形态),数字回该 HTTP 状态,
 *  对象回该状态 + 指定 body(#940:平台分类拒绝形态 `{ error, code }`)。 */
const transientFailures: Array<"network" | number | { status: number; body: string }> = []
/** #400 cancel 端点响应体(测试可换,验证 decode 闸真的在跑)。默认 = platform#255 契约形状。 */
const CANCEL_OK = { schema_version: 1, job_id: JOB, status: "cancelling", accepted: true }
let cancelBody = JSON.stringify(CANCEL_OK)

mock.module("./alpha-auth", () => ({
  getAccessToken: (purpose: RoutePurpose) => {
    requested.push(purpose)
    return tokenFor(purpose)
  },
}))
mock.module("./alpha-endpoints", () => ({
  resolveEndpoints: () => ({ cloud: BASE }),
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}))
mock.module("./alpha-contract-health", () => ({
  reportContractFailure: () => {},
}))

/** artifact 内容下载走独立传输契约(alpha-artifact-download),不经 authed。 */
const downloads: Array<{ token: string; base: string }> = []
mock.module("./alpha-artifact-download", () => ({
  downloadArtifactToFile: async (_req: unknown, opts: { token: string; base: string }) => {
    downloads.push({ token: opts.token, base: opts.base })
    return { ok: true, path: "/tmp/unused", bytes: 0 }
  },
}))

// alpha-platform gateway 的 action 要求(packages/gateway/src/routes/cloud-jobs.ts):
//   POST   /v1/cloud/jobs               → cloud.dispatch
//   GET    /v1/cloud/jobs/:id           → cloud.read
//   POST   /v1/cloud/jobs/:id/cancel    → cloud.dispatch
//   GET    /v1/cloud/jobs/:id/artifacts → artifact.read
const REQUIRED_ACTION: Array<[RegExp, RoutePurpose]> = [
  [/^\/v1\/cloud\/jobs\/[^/]+\/artifacts$/, "artifact.read"],
  [/^\/v1\/cloud\/jobs\/[^/]+\/cancel$/, "cloud.dispatch"],
  [/^\/v1\/cloud\/jobs\/[^/]+$/, "cloud.read"],
  [/^\/v1\/cloud\/jobs$/, "cloud.dispatch"],
]

const artifactListBody = JSON.stringify({
  schema_version: 1,
  job_id: JOB,
  status: "completed",
  artifacts: [],
  artifact_ids: [],
  result: null,
})

const bodyFor = (path: string): string =>
  path.endsWith("/artifacts")
    ? artifactListBody
    : path.endsWith("/cancel")
      ? cancelBody
      : path === "/v1/cloud/jobs"
        ? JSON.stringify({
            schema_version: 1,
            job_id: JOB,
            status: "queued",
            autonomy: "pipeline",
            kind: "code-review",
            urls: {
              status: `${BASE}/v1/cloud/jobs/${JOB}`,
              events: `${BASE}/v1/cloud/jobs/${JOB}/events`,
              result: `${BASE}/v1/cloud/jobs/${JOB}/artifacts`,
            },
          })
        : JSON.stringify({
            schema_version: 1,
            job_id: JOB,
            status: "completed",
            autonomy: "pipeline",
            progress: { phase: "completed" },
            artifact_ids: [],
            error: null,
          })

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input.toString())
  const path = url.pathname
  const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "")
  wire.push({ path, bearer, ...(typeof init?.body === "string" ? { body: init.body } : {}) })
  const injected = transientFailures.shift()
  if (injected === "network") throw new TypeError("fetch failed (injected transient)")
  if (typeof injected === "number") return new Response(JSON.stringify({ error: "injected" }), { status: injected })
  if (typeof injected === "object" && injected !== null) return new Response(injected.body, { status: injected.status })
  const required = REQUIRED_ACTION.find(([re]) => re.test(path))?.[1]
  if (!required) return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
  if (!bearer.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
  // 服务端判权的全部内容:token 的 purpose 必须**等于**该端点的 action。通配不存在。
  if (purposeOf(bearer) !== required) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
  return new Response(bodyFor(path), { status: 200 })
}) as typeof fetch

const jobs = await import("./alpha-cloud-jobs")

const lastWire = () => wire[wire.length - 1]!

test("artifact list is authorized with artifact.read and returns the list instead of a 403", async () => {
  requested.length = 0
  wire.length = 0

  const result = await jobs.listCloudArtifacts(JOB)

  // ① 可观察结果:拿到列表,而不是客户端选错 action 造成的结构性 403。
  //    退回 "cloud.read" ⇒ 假服务端 403 ⇒ 这里变成 { error: "http-403" }。
  expect(result).toEqual({
    schema_version: 1,
    job_id: JOB,
    status: "completed",
    artifacts: [],
    artifact_ids: [],
    result: null,
  })
  // ② 线上真正携带的是 artifact.read 那张 token。
  expect(lastWire().path).toBe(`/v1/cloud/jobs/${JOB}/artifacts`)
  expect(lastWire().bearer).toBe(`Bearer ${tokenFor("artifact.read")}`)
  // ③ 最小权限:只取了这一个 purpose —— 没有 fallback 重试、没有额外多要一张。
  expect(requested).toEqual(["artifact.read"])
})

test("artifact.read stays scoped: status and cancel keep their own approved actions", async () => {
  requested.length = 0
  wire.length = 0

  // 「把 artifact list 修对」不得靠把所有 Cloud 调用一起升成 artifact.read /通配。
  expect(await jobs.getCloudJobStatus(JOB)).toMatchObject({ job_id: JOB })
  expect(lastWire().bearer).toBe(`Bearer ${tokenFor("cloud.read")}`)

  expect(await jobs.cancelCloudJob(JOB)).toEqual(CANCEL_OK)
  expect(lastWire().bearer).toBe(`Bearer ${tokenFor("cloud.dispatch")}`)

  expect(requested).toEqual(["cloud.read", "cloud.dispatch"])
})

test("artifact bytes keep their separate transport contract, still on artifact.read", async () => {
  requested.length = 0
  wire.length = 0
  downloads.length = 0

  const outcome = await jobs.downloadCloudArtifactTo(
    { jobId: JOB, artifactId: "art_job_test_0001_1_0000abcd" } as never,
    (() => ({ ok: true })) as never,
  )

  expect(outcome).toMatchObject({ ok: true })
  // 内容下载不经 authed 的 JSON 通道(零 wire 记录),但同样只用 artifact.read。
  expect(wire).toEqual([])
  expect(requested).toEqual(["artifact.read"])
  expect(downloads).toEqual([{ token: tokenFor("artifact.read"), base: BASE }])
})

// ---- #400(REQ-109 / platform#255):取消是服务端可判定结果,不是本地乐观覆盖 ----

test("cancel fails closed on the pre-#255 unversioned body — an unversioned blob is not a cancel fact", async () => {
  wire.length = 0
  cancelBody = JSON.stringify({ job_id: JOB, status: "cancelled" })
  try {
    // 错误实现(裸 JSON.parse)在这里会把「任务已停」报给用户;decode 闸把它变成分类错误。
    expect(await jobs.cancelCloudJob(JOB)).toEqual({ error: "contract-incompatible" })
  } finally {
    cancelBody = JSON.stringify(CANCEL_OK)
  }
})

// ---- #400(REQ-109 AC1/AC5 桌面半场):有界重试 × 结构性稳定的幂等键 ----

const DISPATCH_ENVELOPE = { autonomy: "pipeline", kind: "code-review", input: { diff: "+const x = 1" } } as const
const dispatchKeys = () =>
  wire
    .filter((w) => w.path === "/v1/cloud/jobs" && w.body)
    .map((w) => (JSON.parse(w.body!) as { idempotency_key: string }).idempotency_key)

test("transient failures: dispatch retries bounded, and every retry of ONE intent carries the SAME key", async () => {
  wire.length = 0
  transientFailures.push("network", 503)

  const result = await jobs.dispatchCloudJob(DISPATCH_ENVELOPE)

  expect(result).toMatchObject({ job_id: JOB, status: "queued" })
  const keys = dispatchKeys()
  // 三次真实出网(1 发 + 2 重试),第 N 次重试的键与第一发逐字相同 —— 服务端才可能按键判重。
  expect(keys.length).toBe(3)
  expect(keys[0]).toMatch(/^[A-Za-z0-9._-]{8,128}$/)
  expect(new Set(keys).size).toBe(1)
})

test("the retry ceiling is hard: persistent 503 stops at exactly 3 attempts with a classified error", async () => {
  wire.length = 0
  transientFailures.push(503, 503, 503)

  expect(await jobs.dispatchCloudJob(DISPATCH_ENVELOPE)).toEqual({ error: "http-503" })
  expect(dispatchKeys().length).toBe(3)
})

test("non-transient answers are not retried: a 400 comes back after exactly one attempt", async () => {
  wire.length = 0
  transientFailures.push(400)

  expect(await jobs.dispatchCloudJob(DISPATCH_ENVELOPE)).toEqual({ error: "http-400" })
  expect(dispatchKeys().length).toBe(1)
})

test("a NEW intent mints a NEW key: two independent dispatches never share identity", async () => {
  wire.length = 0

  expect(await jobs.dispatchCloudJob(DISPATCH_ENVELOPE)).toMatchObject({ job_id: JOB })
  expect(await jobs.dispatchCloudJob(DISPATCH_ENVELOPE)).toMatchObject({ job_id: JOB })

  const keys = dispatchKeys()
  expect(keys.length).toBe(2)
  expect(keys[0]).not.toBe(keys[1])
})

// ---- #940(#918 的同类第二实例):显式上传派发不得把平台的分类拒绝压成裸数字 ----

const UPLOAD_INPUT = {
  accessToken: "tok.cloud.dispatch",
  body: { autonomy: "pipeline", kind: "code-review", idempotency_key: "upload.key.0001", input: {} } as never,
  uploadConsent: "consent.jws.stub",
}

test("上传派发撞上分类拒绝 ⇒ 用户拿到的是平台的 code,不是 http-400", async () => {
  wire.length = 0
  transientFailures.push({ status: 400, body: JSON.stringify({ error: "upload rejected", code: "upload_reserved_input" }) })

  // 错误实现(#940 之前的裸拼)在这里给出 { error: "http-400" } —— 一个用户无从下手的数字。
  expect(await jobs.dispatchExplicitCloudUpload(UPLOAD_INPUT)).toEqual({ error: "upload_reserved_input" })
  // 400 是判权/契约回答,不重试:恰好一次出网。
  expect(wire.length).toBe(1)
})

test("对照臂:平台 400 无 code(或形状不认识)⇒ 保持 http-400,不猜", async () => {
  wire.length = 0
  transientFailures.push({ status: 400, body: JSON.stringify({ error: "invalid request body" }) })

  expect(await jobs.dispatchExplicitCloudUpload(UPLOAD_INPUT)).toEqual({ error: "http-400" })
  expect(wire.length).toBe(1)
})
