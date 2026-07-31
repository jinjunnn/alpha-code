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
/** 每次出网请求的 (path, bearer)。 */
const wire: Array<{ path: string; bearer: string }> = []

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
      ? JSON.stringify({ job_id: JOB, status: "cancelled" })
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
  wire.push({ path, bearer })
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

  expect(await jobs.cancelCloudJob(JOB)).toEqual({ job_id: JOB, status: "cancelled" })
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
