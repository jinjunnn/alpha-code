// B3 cloud-run watcher 纯解析核 —— 命中/忽略矩阵与 output 容错。
// #934:命中准入 = 持久化 identity (mcp, "cloud")(与时间线产物行同一枚铸币),
// `cloud_` 别名前缀不再参与;夹具默认带第一方 facade 快照(与真实事件同形状)。

import { describe, expect, test } from "bun:test"
import { extractCloudRunHit, parseAcceptedDispatch, parseRunFromOutput, runStateToast } from "./cloud-run-core"
import { dict as zh } from "../i18n/zh"
import type { CloudRunState } from "../../preload/types"

/** 第一方 cloud facade 的持久化快照(引擎 mcp/index.ts 以 clientName="cloud" 为 origin)。 */
const facadeDisplay = (name = "cloud_await") => ({
  identity: { source: "mcp", origin: "codepuppy", name },
  technicalId: `cloud_${name}`,
  authority: { kind: "not-asserted" },
})

const partEvent = (over: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  directory: "/Users/me/proj",
  payload: {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_await",
        sessionID: "ses_a",
        messageID: "msg_a",
        type: "tool",
        tool: "cloud_await",
        display: facadeDisplay(),
        state: { status: "completed", output: JSON.stringify({ job_id: "job-9", status: "completed" }) },
        ...over,
      },
    },
  },
  ...envelope,
})

describe("extractCloudRunHit", () => {
  test("终态 cloud tool part → 命中(source status:只触发交付)", () => {
    expect(extractCloudRunHit(partEvent())).toEqual({
      directory: "/Users/me/proj",
      runId: "job-9",
      source: "status",
      sessionID: "ses_a",
      messageID: "msg_a",
      partID: "prt_await",
    })
  })

  test("failed/cancelled 也是终态", () => {
    for (const s of ["failed", "cancelled"] as const) {
      const e = partEvent({ state: { status: "completed", output: JSON.stringify({ job_id: "j", status: s }) } })
      expect(extractCloudRunHit(e)).toMatchObject({ runId: "j", source: "status" })
    }
  })

  test("dispatch 帧(queued/running)不命中", () => {
    const e = partEvent({ state: { status: "completed", output: JSON.stringify({ job_id: "j", status: "running" }) } })
    expect(extractCloudRunHit(e)).toBeNull()
  })

  test("非 cloud 工具 / 非 tool part / 流式未完成帧 / 错误帧 均不命中", () => {
    expect(extractCloudRunHit(partEvent({ tool: "bash", display: undefined }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ type: "text" }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ state: { status: "running" } }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ state: { status: "error", error: "x" } }))).toBeNull()
  })

  test("#934 冒名 cloud_* 不命中:准入是 identity,不是别名前缀(负向夹具与真实终态帧同形)", () => {
    const spoofOutput = JSON.stringify({ job_id: "run_spoof_41", status: "completed" })
    // plugin 命名空间 `cloud`(工具 id cloud_x → 别名恰为 cloud_x)。
    const pluginSpoof = partEvent({
      tool: "cloud_x",
      display: { identity: { source: "plugin", origin: "codepuppy", name: "x" }, technicalId: "cloud_x", authority: { kind: "not-asserted" } },
      state: { status: "completed", output: spoofOutput },
    })
    expect(extractCloudRunHit(pluginSpoof)).toBeNull()
    // MCP 配置键 `cloud.x` sanitize 撞前缀(别名 cloud_x_await)。
    const mcpSpoof = partEvent({
      tool: "cloud_x_await",
      display: { identity: { source: "mcp", origin: "cloud.x", name: "await" }, technicalId: "cloud_x_await", authority: { kind: "not-asserted" } },
      state: { status: "completed", output: JSON.stringify({ job_id: "run_spoof_52", status: "failed" }) },
    })
    expect(extractCloudRunHit(mcpSpoof)).toBeNull()
    // 快照缺失(fail-closed):裸别名 cloud_await 不再是准入。
    expect(extractCloudRunHit(partEvent({ display: undefined }))).toBeNull()
    // 快照形状非法(identity 不是对象):同样不命中。
    expect(extractCloudRunHit(partEvent({ display: { identity: "mcp:cloud:await" } }))).toBeNull()
  })

  test("#934 对照(杀「一律不命中」的错误实现):facade identity 下别名叫什么都命中", () => {
    const hit = extractCloudRunHit(
      partEvent({
        tool: "codepuppy_status",
        display: facadeDisplay("status"),
        state: { status: "completed", output: JSON.stringify({ job_id: "run_real_87", status: "cancelled" }) },
      }),
    )
    expect(hit).toMatchObject({ directory: "/Users/me/proj", runId: "run_real_87", source: "status" })
  })

  test("其它事件类型 / 缺 directory 不命中", () => {
    expect(extractCloudRunHit({ directory: "/p", payload: { type: "session.idle", properties: {} } })).toBeNull()
    expect(extractCloudRunHit(partEvent({}, { directory: "" }))).toBeNull()
    expect(extractCloudRunHit(null)).toBeNull()
  })
})

// REQ-236 #1551 AC1/AC4:已受理的第一方 dispatch 一完成就交给宿主,并带上发起它的会话;
// 回执形状取自平台契约 producer 夹具 cloud-job-accepted.json。
const ACCEPTED = {
  schema_version: 1,
  job_id: "job_fixture1",
  status: "queued",
  autonomy: "pipeline",
  kind: "image-generation",
  urls: {
    status: "https://alpha-cloud.example.dev/v1/cloud/jobs/job_fixture1",
    events: "https://alpha-cloud.example.dev/v1/cloud/jobs/job_fixture1/events",
    result: "https://alpha-cloud.example.dev/v1/cloud/jobs/job_fixture1/artifacts",
  },
}
const dispatchEvent = (over: Record<string, unknown> = {}) =>
  partEvent({
    id: "prt_dispatch",
    tool: "codepuppy_dispatch",
    display: facadeDisplay("dispatch"),
    state: { status: "completed", output: JSON.stringify(ACCEPTED) },
    ...over,
  })

describe("#1551 accepted dispatch hits", () => {
  test("已受理的第一方 dispatch → source dispatch,带会话 / 消息 / 调用标识", () => {
    expect(extractCloudRunHit(dispatchEvent())).toEqual({
      directory: "/Users/me/proj",
      runId: "job_fixture1",
      source: "dispatch",
      sessionID: "ses_a",
      messageID: "msg_a",
      partID: "prt_dispatch",
    })
  })

  test("接纳前被拒(error part)/ 还在提交(running)/ 输出不是受理回执 → 不命中", () => {
    expect(extractCloudRunHit(dispatchEvent({ state: { status: "error", error: "allowance_exhausted" } }))).toBeNull()
    expect(extractCloudRunHit(dispatchEvent({ state: { status: "running" } }))).toBeNull()
    expect(extractCloudRunHit(dispatchEvent({ state: { status: "completed", output: JSON.stringify({ error: "x", code: "envelope_invalid" }) } }))).toBeNull()
  })

  test("冒名 dispatch(非第一方 identity)不命中 —— 归属不能由第三方工具写入", () => {
    const spoof = dispatchEvent({
      display: { identity: { source: "plugin", origin: "codepuppy", name: "dispatch" }, technicalId: "cloud_dispatch", authority: { kind: "not-asserted" } },
    })
    expect(extractCloudRunHit(spoof)).toBeNull()
  })

  test("终态查询的输出里出现 queued 回执形状也不算 dispatch(只有 cloud_dispatch 能建立归属)", () => {
    const status = partEvent({ display: facadeDisplay("status"), state: { status: "completed", output: JSON.stringify(ACCEPTED) } })
    expect(extractCloudRunHit(status)).toBeNull()
  })

  test("parseAcceptedDispatch 只认 CloudJobAcceptedV1 形状", () => {
    expect(parseAcceptedDispatch(JSON.stringify(ACCEPTED))).toBe("job_fixture1")
    expect(parseAcceptedDispatch(JSON.stringify({ ...ACCEPTED, status: "running" }))).toBeNull()
    expect(parseAcceptedDispatch(JSON.stringify({ ...ACCEPTED, schema_version: 2 }))).toBeNull()
    expect(parseAcceptedDispatch("Job accepted")).toBeNull()
  })
})

// REQ-236 #1551 AC2:watcher 的提示只由宿主广播的交付状态决定;交付失败时任何提示都不说「已回流 / 已保存」。
describe("#1551 runStateToast", () => {
  const state = (delivery: CloudRunState["delivery"], job: CloudRunState["job"] = { status: "completed" }): CloudRunState => ({
    directory: "/p",
    runId: "job_fixture1",
    sessionID: "ses_a",
    job,
    delivery,
  })

  test("失败不弹已回流:交付失败 → 错误提示,文案与 detail 都不含「已回流 / 已保存」", () => {
    const toast = runStateToast(state({ status: "failed", failure: { scope: "download", artifactId: "art_1", code: "network" } }))
    expect(toast).toMatchObject({ kind: "error", key: "alpha.cloud.runSaveFailed" })
    const text = `${zh[toast!.key]} ${toast!.detail}`
    expect(text).not.toContain("已回流")
    expect(text).not.toContain("已保存")
    expect(toast!.detail).toContain("network")
  })

  test("saved 才说已回流;任务失败但记录已落盘 → 说结束而非成功;交付未落定不弹", () => {
    expect(runStateToast(state({ status: "saved" }))).toMatchObject({ kind: "success", key: "alpha.cloud.runSaved" })
    // #1591:界面文字不写目录名,路径由程序给出。
    expect(`${zh["alpha.cloud.runSaved"]} ${runStateToast(state({ status: "saved" }))!.detail}`).not.toContain(".code-puppy")
    expect(runStateToast(state({ status: "saved" }, { status: "failed" }))).toMatchObject({ kind: "info", key: "alpha.cloud.runEnded" })
    expect(runStateToast(state({ status: "pending" }))).toBeNull()
    expect(runStateToast(state({ status: "downloading" }))).toBeNull()
  })
})

describe("parseRunFromOutput", () => {
  test("纯 JSON", () => {
    expect(parseRunFromOutput('{"job_id":"a","status":"completed"}')).toEqual({ runId: "a", terminal: "completed" })
  })
  test("包裹文本回退正则", () => {
    const wrapped = 'Job finished.\n```json\n{"job_id": "b-2", "status": "failed", "error": "boom"}\n```'
    expect(parseRunFromOutput(wrapped)).toEqual({ runId: "b-2", terminal: "failed" })
  })
  test("非终态/缺 job_id → null", () => {
    expect(parseRunFromOutput('{"job_id":"c","status":"running"}')).toBeNull()
    expect(parseRunFromOutput('{"status":"completed"}')).toBeNull()
    expect(parseRunFromOutput("plain text")).toBeNull()
  })
})
