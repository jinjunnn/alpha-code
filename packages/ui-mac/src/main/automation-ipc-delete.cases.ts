// [#963] 删自动化的云端幂等容忍 —— 用户可观察判据(不断言 deleteCloudSchedule 返回值)。
//
// 链条:automations-delete(automation-ipc.ts)→ deleteCloudSchedule(alpha-cloud-schedules.ts,
// 真模块)→ 本地 authed() → fetch。alpha-automations 也是真模块(alpha-installs 钉到临时目录),
// 「本地那条真的没了 / 还在」按磁盘文件判,不走被测模块自己的读取器。
//
// 四条判据(同一判据的不同用例用不同字面量,防「恰好等于可硬编码常量」):
//   ① 云端已无该定时任务(404 无码)⇒ app 删自动化成功,本地那条真的没了;
//   ② 平台给 404 补上分类码 ⇒ 仍然删得掉 —— 本票存在的理由:幂等不再寄生在错误字符串上。
//      把 deleteCloudSchedule 改回比字符串(`r.error !== "http-404"`),这一条当场红;
//   ③ 403(带码)⇒ 不删本地(否则离线幽灵触发,automation-ipc.ts 注释点名要防);
//   ④ 503(无码)⇒ 不删本地,呈现保持 http-503 fail-closed(不猜码)。
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

// electron 的 mock 必须先于任何会牵出它的 import(CLAUDE.md《本机验证陷阱》)。
const ipc = await import("./automation-ipc")
const auto = await import("./alpha-automations")
ipc.registerAutomationIpcHandlers()

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...args)
}

function seed(id: string, cloudScheduleId: string): void {
  const task: AutomationTask = {
    id,
    name: "Daily research",
    nlText: "daily",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    target: { projectDir: ROOT, agent: "alpha-automation" },
    prompt: "Research release notes",
    execution: "cloud",
    cloudScheduleId,
    permissionProfile: "readonly",
    budget: { maxDurationMin: 15 },
    overlapPolicy: "skip",
    catchUpPolicy: "skip",
    notify: { system: true },
    enabled: true,
    createdAt: "2026-07-22T00:00:00.000Z",
  }
  const w = auto.saveAutomation(task)
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

test("云端删除因别的原因失败(403 带码)⇒ 不删本地,不留离线幽灵触发", async () => {
  wire.length = 0
  seed("auto-keep-403", "sched_live_3")
  responses.push({ status: 403, body: JSON.stringify({ error: "tenant mismatch for this schedule", code: "tenant_forbidden" }) })

  expect(await invoke("automations-delete", "auto-keep-403")).toEqual({ ok: false, reason: "云端删除失败:tenant_forbidden" })
  expect(onDisk("auto-keep-403")).toBe(true)
})

test("云端删除 503(无码)⇒ 不删本地,呈现保持 http-503(fail-closed 不猜码)", async () => {
  wire.length = 0
  seed("auto-keep-503", "sched_live_4")
  responses.push({ status: 503, body: JSON.stringify({ error: "upstream unavailable" }) })

  expect(await invoke("automations-delete", "auto-keep-503")).toEqual({ ok: false, reason: "云端删除失败:http-503" })
  expect(onDisk("auto-keep-503")).toBe(true)
})
