// [#940] 云档 schedule 客户端的错误呈现判据 —— 本票把它从「透出 B 的 `error` 散文」切到
// platform-error-code 咽喉(分类码优先,无码 http-<status>,散文不进 UI)。
// 这是一个行为变化,三条判据把它钉死:
//   ① B 给稳定分类码(429 rate_limited)⇒ 用户看到 code;
//   ② B 只给散文(限额提示)⇒ http-400,且散文一个字都不落进 reason(散文可携带路径/租户);
//   ③ 删除的 404 容忍(schedule not found 无 code,实读 ap gateway routes/cloud-schedules.ts)
//      在咽喉切换后仍成立 —— 已删即成功。
//
// mock.module 会污染同进程其它测试文件 ⇒ 真断言放这里,由 alpha-cloud-schedules.test.ts
// 在隔离子进程里跑(alpha-cloud-jobs.cases.ts 同款)。
import { expect, mock, test } from "bun:test"
import type { AutomationTask } from "../shared/automation-types"

const BASE = "https://cloud.invalid"

mock.module("./alpha-auth", () => ({ getAccessToken: () => "tok.cloud.dispatch" }))
mock.module("./alpha-endpoints", () => ({ resolveEndpoints: () => ({ cloud: BASE }) }))
mock.module("./logging", () => ({ getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }) }))
mock.module("./store", () => ({ getStore: () => ({ get: () => 0, set: () => {} }) }))
mock.module("./alpha-automations", () => ({ getAutomation: () => null, listAutomations: () => [], saveAutomation: () => ({ ok: true }) }))
mock.module("./alpha-workdir", () => ({ saveCloudRun: async () => ({ ok: false, reason: "unused" }) }))
mock.module("./alpha-user-workspace", () => ({ mirrorRunArtifacts: () => {} }))
mock.module("./artifact-service", () => ({ finalizeArtifactWithQuota: () => ({ ok: true }), registerDownloadedArtifact: () => {} }))
mock.module("./alpha-cloud-jobs", () => ({
  downloadCloudArtifactTo: async () => ({ ok: false, error: "unused" }),
  getCloudJobStatus: async () => ({ error: "unused" }),
  listCloudArtifacts: async () => ({ error: "unused" }),
}))

/** 每次出网的 (method, path);响应从队列取,空队列 = 500 兜底(测试必须显式排响应)。 */
const wire: Array<{ method: string; path: string }> = []
const responses: Array<{ status: number; body: string }> = []

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  wire.push({ method: init?.method ?? "GET", path: new URL(typeof input === "string" ? input : input.toString()).pathname })
  const next = responses.shift() ?? { status: 500, body: JSON.stringify({ error: "unqueued response" }) }
  return new Response(next.body, { status: next.status })
}) as typeof fetch

const schedules = await import("./alpha-cloud-schedules")

const TASK: AutomationTask = {
  id: "task-940",
  name: "Daily research",
  nlText: "daily",
  schedule: { kind: "cron", expr: "0 9 * * *" },
  target: { projectDir: "/project", agent: "alpha-automation" },
  prompt: "Research release notes",
  execution: "cloud",
  permissionProfile: "readonly",
  budget: { maxDurationMin: 15 },
  overlapPolicy: "skip",
  catchUpPolicy: "skip",
  notify: { system: true },
  enabled: true,
  createdAt: "2026-07-22T00:00:00.000Z",
}

test("B 的分类拒绝(429 rate_limited)⇒ 用户看到 code,不是数字也不是散文", async () => {
  wire.length = 0
  responses.push({ status: 429, body: JSON.stringify({ error: "rate limited: too many requests from this IP", code: "rate_limited" }) })

  expect(await schedules.upsertCloudSchedule(TASK)).toEqual({ ok: false, reason: "云端注册失败:rate_limited" })
  expect(wire).toEqual([{ method: "POST", path: "/v1/cloud/schedules" }])
})

test("B 只给散文(限额提示)⇒ http-400,散文一个字都不进 reason", async () => {
  wire.length = 0
  // 独立字面量锚点(不从实现或 B 源码 import)—— ap gateway routes/cloud-schedules.ts:94 的原文。
  const PROSE = "schedule limit reached (10 per tenant) — delete one first"
  responses.push({ status: 400, body: JSON.stringify({ error: PROSE }) })

  const r = await schedules.upsertCloudSchedule(TASK)
  expect(r).toEqual({ ok: false, reason: "云端注册失败:http-400" })
  expect(JSON.stringify(r)).not.toContain("limit reached")
})

test("删除的 404 容忍在咽喉切换后仍成立:schedule not found(无 code)⇒ 已删即成功", async () => {
  wire.length = 0
  responses.push({ status: 404, body: JSON.stringify({ error: "schedule not found" }) })

  expect(await schedules.deleteCloudSchedule("sched_0001")).toEqual({ ok: true })
  expect(wire).toEqual([{ method: "DELETE", path: "/v1/cloud/schedules/sched_0001" }])
})
