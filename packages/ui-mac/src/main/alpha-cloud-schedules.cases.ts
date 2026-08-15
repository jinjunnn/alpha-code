// [#940] 云档 schedule 客户端的错误呈现判据 —— 本票把它从「透出 B 的 `error` 散文」切到
// platform-error-code 咽喉(分类码优先,无码 http-<status>,散文不进 UI)。
// 这是一个行为变化,三条判据把它钉死:
//   ① B 给稳定分类码(429 rate_limited)⇒ 用户看到 code;
//   ~~② B 只给散文(限额提示)⇒ http-400,且散文一个字都不落进 reason(散文可携带路径/租户);~~
//   ③ 删除的 404 容忍(schedule not found 无 code,实读 ap gateway routes/cloud-schedules.ts)
//      在咽喉切换后仍成立 —— 已删即成功。
//
// ── 订正块(2026-08-14,[#969])───────────────────────────────────────────────
// 上面的 ② **原口径作废**。它锚的散文是 `schedule limit reached (10 per tenant) — delete one
// first`(当时逐字取自 ap gateway routes/cloud-schedules.ts:94)。`ap#329` 之后,平台**同一条
// 拒绝**带上了 `code: SCHEDULE_REFUSAL_CODES.limitReached`(今天在 routes/cloud-schedules.ts:107),
// 于是这条用例断言的 `http-400` 在真 wire 上已不存在 —— 而夹具是自建的无码 400,所以它**永远
// 绿**:一颗哑弹,把一个已经被修好的旧形状钉在原地。
// 仍然成立的是它想守的那条纪律(**散文一个字不进 UI**),所以纪律留下、锚点换成平台**今天仍然
// 产出且桌面到得了**的无码拒绝:`schedules unavailable: SCHEDULES_DB not bound` @503
// (routes/cloud-schedules.ts:62)。它的散文里带 binding 名 —— 正是「散文可携带基础设施细节」
// 要挡的东西。原来那条 limit-reached 改为断言它**今天真实的样子**(带 code)。
// 刻意没有换成 `envelope validation failed` @400:那一条只在 `CloudJobRequestV1Schema.safeParse`
// 失败时产出,而桌面的 `cloudScheduleRegistrationFor` 恒定产出同一份合法信封 ⇒ 走我们自己的
// 代码收不到它,拿它当锚点等于把哑弹换个形状再放一颗。
//
// [#969] 另加两条:注册/删除的拒绝都必须带**结构槽** `code`(呈现层据它选文案,不解析
// `reason` 的中文前缀),以及桌面自己的早返(云档发不出的周期)也要带一个自铸的本地码。
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

  expect(await schedules.upsertCloudSchedule(TASK)).toEqual({
    ok: false,
    reason: "云端注册失败:rate_limited",
    code: "rate_limited",
  })
  expect(wire).toEqual([{ method: "POST", path: "/v1/cloud/schedules" }])
})

// [#969] 替掉抬头订正块里那颗哑弹。锚点是平台**今天仍然产出**的无码拒绝(503,散文里带
// binding 名 SCHEDULES_DB),桌面走 POST/PATCH 都到得了(schedAuth 在 D1 未绑定时返回它)。
test("B 只给散文(503 未绑定库)⇒ http-503,散文与基础设施细节一个字都不进 reason", async () => {
  wire.length = 0
  // 独立字面量锚点(不从实现或 B 源码 import)—— ap gateway routes/cloud-schedules.ts:62 的原文。
  const PROSE = "schedules unavailable: SCHEDULES_DB not bound"
  responses.push({ status: 503, body: JSON.stringify({ error: PROSE }) })

  const r = await schedules.upsertCloudSchedule(TASK)
  expect(r).toEqual({ ok: false, reason: "云端注册失败:http-503", code: "http-503" })
  expect(JSON.stringify(r)).not.toContain("SCHEDULES_DB")
  expect(JSON.stringify(r)).not.toContain("unavailable")
})

// [#969] 同一条拒绝**今天真实的样子**:散文一字未改,但顶层多了 code。呈现槽必须拿到 code
// 本身(而不是整串 reason),否则 renderer 只能去解析「云端注册失败:」这个前缀。
test("每租户上限(ap#329 之后带 code)⇒ 结构槽是裸的分类码,散文仍然一个字不进", async () => {
  wire.length = 0
  const PROSE = "schedule limit reached (10 per tenant) — delete one first"
  responses.push({ status: 400, body: JSON.stringify({ error: PROSE, code: "schedule_limit_reached" }) })

  const r = await schedules.upsertCloudSchedule(TASK)
  expect(r).toEqual({
    ok: false,
    reason: "云端注册失败:schedule_limit_reached",
    code: "schedule_limit_reached",
  })
  expect(JSON.stringify(r)).not.toContain("limit reached (")
})

// [#969] 桌面自己的早返(平台侧刻意无码:请求根本发不出去)。它今天是一句硬编码中文,
// 会原样出现在 16 个语种的界面上 —— 所以它也得带一个码,交给 renderer 的 i18n 那一层。
// 驱动输入取**面板真的构造得出**的那一种:`{kind:"once"}` 在 shared/automation-types.ts 里
// 写着「A1 UI 不产,实体预留」,automation-panel.tsx 的 fromForm 没有 once 分支 ⇒ 拿它当夹具
// 等于锚在走我们自己的代码到不了的形状上。间隔输入框只有 min=5、没有上界,fromForm 也只判
// 下界 ⇒ 90 分钟直达这条早返(scheduleToCron 对非整点超长间隔返回 null)。
test("云档发不出的周期(90 分钟间隔)⇒ 桌面自铸本地码,且一次网络请求都不发", async () => {
  wire.length = 0
  const r = await schedules.upsertCloudSchedule({ ...TASK, schedule: { kind: "interval", everyMinutes: 90 } })

  expect(r.ok).toBe(false)
  // 本地码是 kebab —— 与平台分类码的文法 /^[a-z][a-z0-9_]{2,63}$/ 结构上不相交。
  expect((r as { code: string }).code).toBe("cloud-schedule-form-unsupported")
  expect(wire).toEqual([])
})

test("删除的 404 容忍在咽喉切换后仍成立:schedule not found(无 code)⇒ 已删即成功", async () => {
  wire.length = 0
  responses.push({ status: 404, body: JSON.stringify({ error: "schedule not found" }) })

  expect(await schedules.deleteCloudSchedule("sched_0001")).toEqual({ ok: true })
  expect(wire).toEqual([{ method: "DELETE", path: "/v1/cloud/schedules/sched_0001" }])
})

// [#969] 删除腿也带 code:`automations-save` 在「云档改本地」那一跳调它,失败原因落到面板
// **同一行** `.alpha-auto-err`(automation-ipc.ts)。少这个槽,那条路径的用户就只剩裸码。
// 夹具形状取自平台**今天真实产出**的那一条:schedule 面的 403 是 `{error:"forbidden"}`,
// **无 code**(ap gateway routes/cloud-schedules.ts:53;lib/schedules.ts 抬头写明传输层
// 401/403/404 有意无码)⇒ 咽喉铸 `http-403`。不要在夹具里编一个平台不产出的分类码:下一个
// 人按「读用例反推平台契约」做勘破时会拿到一份假的地面真相。
test("删除因别的原因失败(403 无码)⇒ 结构槽透出咽喉铸的 http-403,供呈现层换人话", async () => {
  wire.length = 0
  responses.push({ status: 403, body: JSON.stringify({ error: "forbidden" }) })

  expect(await schedules.deleteCloudSchedule("sched_0002")).toEqual({
    ok: false,
    reason: "云端删除失败:http-403",
    code: "http-403",
  })
})
