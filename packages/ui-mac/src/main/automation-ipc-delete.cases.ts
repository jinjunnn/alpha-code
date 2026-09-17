// [#963] 自动化 IPC 的云端腿 —— 走**生产 handler** 的用户可观察判据。
//
// 链条:automations-delete / automations-save(automation-ipc.ts 里由 `ipcMain.handle` 真实注册的
// 那两个 handler)→ upsert/deleteCloudSchedule(alpha-cloud-schedules.ts,真模块)→ 本地 authed()
// → fetch。alpha-automations 也是真模块(alpha-installs 钉到临时目录),「本地那条真的没了 / 还在」
// 按磁盘文件判,不走被测模块自己的读取器。
//
// 六条判据(同一判据的不同用例用不同字面量,防「恰好等于可硬编码常量」):
//   ① 云端已无该定时任务(404 无码)⇒ app 删自动化成功,本地那条真的没了;
//   ② 平台给 404 补上分类码 ⇒ 仍然删得掉 —— `#963` 存在的理由:幂等不再寄生在错误字符串上。
//      把 deleteCloudSchedule 改回比字符串(`r.error !== "http-404"`),这一条当场红;
//   ③ 403(带码)⇒ 不删本地(否则离线幽灵触发,automation-ipc.ts 注释点名要防);
//   ④ 503(无码)⇒ 不删本地,呈现保持 http-503 fail-closed(不猜码)。
//   [#969] 新增两条,守的是**从 main 到 renderer 之间那一跳**:
//   ⑤ 云档保存被平台拒绝 ⇒ `automations-save` 的返回对象必须带**结构槽** `code`;
//   ⑥ 云档改本地、云端删除被拒 ⇒ 同一个 `automations-save` 的返回对象也必须带 `code`。
//      这两条落在真 handler 上是**故意的**:renderer 侧的组件闸门在 preload 边界桩掉
//      `window.api.automations.save`,结构上加载不到这个文件;只断 upsert/delete 函数本身
//      又绕开了 handler。漏改 automation-ipc.ts 的透传 ⇒ `r.code` 恒 undefined、面板永远走
//      回落、用户照旧读到裸码,而两端的判据都能全绿 —— 这一跳是那条链上唯一无判据的一环。
//
//   [#994] 新增一条,守开关那一跳:
//   ⑦ 开关时云端状态更新被拒 ⇒ `automations-toggle` 的返回对象带 `code`,本地开关态不变;
//      ③④ 两条同时改断「`automations-delete` 的返回带 code」。
//   [#1001] 新增两条,守保存时**本机**失败的那一跳(过去这两条原样把英文串 / 半英半中拼接交给面板):
//   ⑧ 本地档保存、本机校验不过 ⇒ `automations-save` 返回本地结构码;
//   ⑨ 云端注册成功但本机保存失败 ⇒ 同样返回本地结构码,补偿删除照发。
//
// mock.module 会污染同进程其它测试文件 ⇒ 真断言放这里,由 automation-ipc-delete.test.ts
// 在隔离子进程里跑(alpha-cloud-schedules.cases.ts 同款)。
import { expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import { join } from "node:path"
import type { AutomationTask } from "../shared/automation-types"

const BASE = "https://cloud.invalid"
const ROOT = fs.mkdtempSync(join(os.tmpdir(), "alpha-963-"))

const handlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module("electron", () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}))
mock.module("./logging", () => ({ getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }) }))
// 真 alpha-automations,存储根钉到本测试的临时目录 —— 「本地删没删」是真实文件系统事实。
mock.module("./alpha-installs", () => ({ alphaGlobalRoot: () => ROOT }))
mock.module("./alpha-user-workspace", () => ({ ensureUserWorkspaceDir: () => {}, mirrorRunArtifacts: () => {} }))
mock.module("./automation-scheduler", () => ({
  getPlannedFireAt: () => null,
  isAutomationRunning: () => false,
  rearmAutomations: () => {},
  runAutomationNow: () => ({ ok: false, reason: "unused" }),
}))
mock.module("./automation-llm", () => ({ llmParseAutomation: async () => ({ ok: false, reason: "unused" }) }))
mock.module("./alpha-auth", () => ({ getAccessToken: () => "tok.cloud.dispatch" }))
mock.module("./alpha-endpoints", () => ({ resolveEndpoints: () => ({ cloud: BASE }) }))
mock.module("./store", () => ({ getStore: () => ({ get: () => 0, set: () => {} }) }))
mock.module("./alpha-workdir", () => ({ saveCloudRun: async () => ({ ok: false, reason: "unused" }) }))
mock.module("./artifact-service", () => ({ finalizeArtifactWithQuota: () => ({ ok: true }), registerDownloadedArtifact: () => {}, registeredArtifactNameOwner: () => undefined }))
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

// electron 的 mock 必须先于任何会牵出它的 import(CLAUDE.md《本机验证陷阱》)。
const ipc = await import("./automation-ipc")
const auto = await import("./alpha-automations")
ipc.registerAutomationIpcHandlers()

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...args)
}

function taskOf(id: string, overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id,
    name: "Daily research",
    nlText: "daily",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    target: { projectDir: ROOT, agent: "alpha-automation" },
    prompt: "Research release notes",
    execution: "cloud",
    permissionProfile: "readonly",
    budget: { maxDurationMin: 15 },
    overlapPolicy: "skip",
    catchUpPolicy: "skip",
    notify: { system: true },
    enabled: true,
    createdAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  }
}

function seed(id: string, cloudScheduleId: string): void {
  const w = auto.saveAutomation(taskOf(id, { cloudScheduleId }))
  if (!w.ok) throw new Error(`seed failed: ${w.reason}`)
}

const onDisk = (id: string): boolean => fs.existsSync(join(ROOT, "automations", `${id}.json`))

test("云端已无该定时任务(404 无码)⇒ app 里删自动化成功,本地那条真的没了", async () => {
  wire.length = 0
  seed("auto-del-nocode", "sched_gone_1")
  responses.push({ status: 404, body: JSON.stringify({ error: "schedule not found" }) })

  expect(await invoke("automations-delete", "auto-del-nocode")).toEqual({ ok: true })
  expect(onDisk("auto-del-nocode")).toBe(false)
  expect(wire).toEqual([{ method: "DELETE", path: "/v1/cloud/schedules/sched_gone_1" }])
})

test("平台给 404 补上分类码 ⇒ 仍然删得掉(#963 存在的理由:幂等不再比错误字符串)", async () => {
  wire.length = 0
  seed("auto-del-coded", "sched_gone_2")
  responses.push({ status: 404, body: JSON.stringify({ error: "no such schedule row", code: "schedule_not_found" }) })

  expect(await invoke("automations-delete", "auto-del-coded")).toEqual({ ok: true })
  expect(onDisk("auto-del-coded")).toBe(false)
  expect(wire).toEqual([{ method: "DELETE", path: "/v1/cloud/schedules/sched_gone_2" }])
})

// [#969] 注意:`tenant_forbidden` 是**合成夹具码,平台不产出** —— schedule 面的 403 今天是
// `{error:"forbidden"}` 无码(ap routes/cloud-schedules.ts:53)。这条用例守的是「带码的 403
// 也不删本地」这条与码的字面量无关的性质,故 `#963` 的原夹具保留;别拿这一行反推平台契约。
test("云端删除因别的原因失败(403 带码)⇒ 不删本地,不留离线幽灵触发", async () => {
  wire.length = 0
  seed("auto-keep-403", "sched_live_3")
  responses.push({ status: 403, body: JSON.stringify({ error: "tenant mismatch for this schedule", code: "tenant_forbidden" }) })

  // [#994] 返回必须带结构槽 code —— 面板据它给删除失败的提示选人话。
  expect(await invoke("automations-delete", "auto-keep-403")).toEqual({
    ok: false,
    reason: "云端删除失败:tenant_forbidden",
    code: "tenant_forbidden",
  })
  expect(onDisk("auto-keep-403")).toBe(true)
})

test("云端删除 503(无码)⇒ 不删本地,呈现保持 http-503(fail-closed 不猜码)", async () => {
  wire.length = 0
  seed("auto-keep-503", "sched_live_4")
  responses.push({ status: 503, body: JSON.stringify({ error: "upstream unavailable" }) })

  // [#994] 面板的 `remove()` 现在读返回值、据 code 弹出删除失败的提示 ⇒ 这条腿必须带 code。
  expect(await invoke("automations-delete", "auto-keep-503")).toEqual({
    ok: false,
    reason: "云端删除失败:http-503",
    code: "http-503",
  })
  expect(onDisk("auto-keep-503")).toBe(true)
})

// ── [#969] 从 main 到 renderer 之间那一跳(automations-save 的两条云端腿)────────────────

test("[#969] 云档保存被平台按分类码拒绝 ⇒ automations-save 的返回带结构槽 code,本地未落盘", async () => {
  wire.length = 0
  // 平台今天真实的 wire body(ap#329 之后):散文一字未改,顶层多了 code。
  responses.push({
    status: 400,
    body: JSON.stringify({
      error: "schedule limit reached (10 per tenant) — delete one first",
      code: "schedule_limit_reached",
    }),
  })

  expect(await invoke("automations-save", taskOf("auto-save-limit"))).toEqual({
    ok: false,
    reason: "云端注册失败:schedule_limit_reached",
    code: "schedule_limit_reached",
  })
  // 云端没接住 ⇒ 不落盘(automation-ipc.ts 的 loud 语义),且确实走了注册那条 wire。
  expect(onDisk("auto-save-limit")).toBe(false)
  expect(wire).toEqual([{ method: "POST", path: "/v1/cloud/schedules" }])
})

// 夹具形状取自平台**今天真实产出**的那一条:schedule 面的 403 是 `{error:"forbidden"}`,
// **无 code**(ap gateway routes/cloud-schedules.ts:53)⇒ 咽喉铸 `http-403`。透传丢了 `code`
// 这一条照样红(toEqual 精确比对),而夹具不再教下一个人一个平台不产出的码。
test("[#969] 云档改本地、云端删除被拒 ⇒ 同一个 automations-save 的返回也带 code", async () => {
  wire.length = 0
  seed("auto-save-tolocal", "sched_live_5")
  responses.push({ status: 403, body: JSON.stringify({ error: "forbidden" }) })

  expect(await invoke("automations-save", taskOf("auto-save-tolocal", { execution: "local" }))).toEqual({
    ok: false,
    reason: "云端删除失败:http-403",
    code: "http-403",
  })
  // 云侧还在 ⇒ 本地那条保持云档(不能悄悄改成本地,否则云端幽灵触发且本地不可管)。
  expect(auto.getAutomation("auto-save-tolocal")?.cloudScheduleId).toBe("sched_live_5")
  expect(wire).toEqual([{ method: "DELETE", path: "/v1/cloud/schedules/sched_live_5" }])
})

// ── [#994] 开关那一跳(automations-toggle)────────────────────────────────────────────
// 夹具取 PATCH 腿今天真到得了的形状:503 无码(SCHEDULES_DB 未绑定,ap routes/cloud-schedules.ts 的
// schedAuth)⇒ 咽喉铸 `http-503`。
test("[#994] 开关时云端状态更新被拒 ⇒ automations-toggle 的返回带 code,本地开关态不变", async () => {
  wire.length = 0
  seed("auto-toggle-503", "sched_live_7")
  responses.push({ status: 503, body: JSON.stringify({ error: "schedules unavailable: SCHEDULES_DB not bound" }) })

  expect(await invoke("automations-toggle", "auto-toggle-503", false)).toEqual({
    ok: false,
    reason: "云端状态更新失败:http-503",
    code: "http-503",
  })
  // 云端没停掉 ⇒ 本地也不能显示成已停(否则用户以为关掉了,云端照跑照花钱)。按磁盘文件判。
  const onDiskTask = JSON.parse(fs.readFileSync(join(ROOT, "automations", "auto-toggle-503.json"), "utf8")) as AutomationTask
  expect(onDiskTask.enabled).toBe(true)
  expect(wire).toEqual([{ method: "PATCH", path: "/v1/cloud/schedules/sched_live_7" }])
})

// ── [#1001] 保存时本机失败的那一跳(本地结构码)──────────────────────────────────────────
// 两条用不同的校验失败(时长越界 / 目录不存在),防「恰好等于可硬编码常量」。

test("[#1001] 本地档保存、本机校验不过 ⇒ automations-save 返回本地结构码,未落盘、未出网", async () => {
  wire.length = 0
  const task = taskOf("auto-1001-local", { execution: "local", budget: { maxDurationMin: 500 } })

  expect(await invoke("automations-save", task)).toEqual({
    ok: false,
    reason: "maxDurationMin must be 1-120",
    code: "automation-duration-invalid",
  })
  expect(onDisk("auto-1001-local")).toBe(false)
  expect(wire).toEqual([])
})

test("[#1001] 云端注册成功但本机保存失败 ⇒ 返回本地结构码,补偿删除照发", async () => {
  wire.length = 0
  const task = taskOf("auto-1001-cloud", { target: { projectDir: join(ROOT, "gone-1001"), agent: "alpha-automation" } })
  responses.push({
    status: 200,
    body: JSON.stringify({
      id: "sched_new_1001",
      name: task.name,
      cron: "0 9 * * *",
      enabled: true,
      next_fire_at: 0,
      last_job_id: null,
      consecutive_failures: 0,
      disabled_reason: null,
    }),
  })
  responses.push({ status: 200, body: JSON.stringify({ deleted: "sched_new_1001" }) })

  const res = await invoke("automations-save", task)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(res).toEqual({
    ok: false,
    reason: "projectDir not found(云端注册已回滚)",
    code: "automation-project-dir-invalid",
  })
  expect(onDisk("auto-1001-cloud")).toBe(false)
  expect(wire).toEqual([
    { method: "POST", path: "/v1/cloud/schedules" },
    { method: "DELETE", path: "/v1/cloud/schedules/sched_new_1001" },
  ])
})
