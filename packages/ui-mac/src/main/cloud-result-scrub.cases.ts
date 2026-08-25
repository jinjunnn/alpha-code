// #1113(REQ-092 AC1 桌面消费侧)—— status/artifact-list 开放 `result` 的清洗接线闸。
//
// 缺陷形态(alpha-code#402 取证矩阵格 1,docs/verification/2026-08-25-req092-402-artifact-transfer/):
// 钉住 schema 里 `CloudJobStatusV1.result` 是无约束 `{}`(ArtifactListV1 为 anyOf[{},null]),
// 平台塞内联内容时 alpha-code 原样透传给 renderer;声明的防线 scrubInlineContent 全仓零调用点。
// 「代码在,但没有被执行」—— 所以这道闸**驱动真的生产链**,不断言那个纯函数本身:
//   registerCloudIpcHandlers() 注册的 cloud-status / cloud-artifacts handler
//   → 真 alpha-cloud-jobs(不 mock)→ 真 decodeJsonContract → scrubInlineContent 接线
//   → 对着本进程起的真 HTTP origin。替身只有宿主级三件:electron / logging / alpha-auth。
// 把 alpha-cloud-jobs.ts 里那两处 scrubInlineContent(...) 摘掉,本文件必须红(#1113 PR 有摘线实测)。
//
// 判据三面(单断言布尔可被错误实现满足,见 #402 README §「断言的粒度」):
//   ① renderer 可见返回值整棵树扫描零发现(扫描器先用已知的坏标定,标不出坏则本轮作废);
//   ② 剥键是**移除**不是置空替换:content-bearing 键连值一起消失;data URL 整串换成占位符
//      (占位符是独立字面量,不 import 生产常量 —— 锚点在被测对象之外);
//   ③ 清洗不是删除:非内容数据(summary / job_id / descriptor 全字段)逐字存活。
//
// 生产清洗是 blocklist(剥六个内容承载键 + 替换 data URL 字符串),对「无害键名下的裸 base64」
// **不设防** —— 对抗载荷因此只用防线规格内的形态;裸 base64 形态只用于标定扫描器能力
// (证明「零发现」不是扫描器瞎)。结构性关死 `result` 属于跨仓契约变更(alpha-platform#51)。
//
// mock.module 会污染同进程其它测试文件 ⇒ 子进程跑(cloud-ipc.test.ts 同款),
// 宿主 = cloud-result-scrub.test.ts。
import { afterAll, expect, mock, test } from "bun:test"

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

mock.module("electron", () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}))
mock.module("./alpha-auth", () => ({
  getAccessToken: () => "tok.gate1113",
  getAccessTokenIdentity: () => ({ ok: true, token: "tok.gate1113", tenantId: "t_gate", subject: "u_gate" }),
}))

// ---- 真 HTTP origin(canned JSON;本闸只判 JSON 决策面,流式/框定语义归 #402 格 2–6)----
const canned = new Map<string, string>()
const origin = Bun.serve({
  port: 0,
  fetch(req) {
    const body = canned.get(new URL(req.url).pathname)
    if (!body) return new Response(JSON.stringify({ error: "not-found" }), { status: 404 })
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  },
})
process.env.ALPHA_CLOUD_URL = `http://127.0.0.1:${origin.port}`
afterAll(() => origin.stop(true))

const { registerCloudIpcHandlers } = await import("./cloud-ipc")
registerCloudIpcHandlers()

// ---- 扫描器 ----
// 内容前像:一段仅存在于本文件的 marker 字节的 base64 —— 命中即「产物内容抵达了公共视图」。
const MARKER_B64 = Buffer.from("ALPHA-1113-artifact-content-marker: these bytes must never reach the renderer").toString("base64")
/** 与生产 STRIP_KEYS 同名单,但刻意**独立誊写**:被测对象改错名单时这里不跟着错。 */
const CONTENT_KEYS = ["base64", "b64", "dataUrl", "data_url", "r2Key", "downloadPath"]
/** 占位符独立字面量(不 import DATA_URL_PLACEHOLDER):锚点在被测对象之外。 */
const PLACEHOLDER = "[removed: data URL stripped per REQ-092]"

type Finding = { at: string; kind: string }
function scan(value: unknown, at = "$", out: Finding[] = []): Finding[] {
  if (typeof value === "string") {
    if (/^data:/i.test(value)) out.push({ at, kind: "data-url" })
    if (value.includes(MARKER_B64)) out.push({ at, kind: "content-base64" })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${at}[${i}]`, out))
    return out
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CONTENT_KEYS.includes(k)) out.push({ at: `${at}.${k}`, kind: "content-bearing-key" })
      scan(v, `${at}.${k}`, out)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 0. 扫描器标定:测不出已知的坏 ⇒ 后面每条「零发现」都是假绿。
// ---------------------------------------------------------------------------
test("scanner calibration: every axis fires on a known-bad payload", () => {
  const poisoned = {
    preview: `data:image/png;base64,${MARKER_B64}`,
    report: { base64: MARKER_B64, b64: "x", dataUrl: "x", data_url: "x", r2Key: "x", downloadPath: "x" },
    nested: [{ blob: MARKER_B64 }],
  }
  const findings = scan(poisoned)
  expect(new Set(findings.map((f) => f.kind))).toEqual(new Set(["data-url", "content-base64", "content-bearing-key"]))
  // 六个内容承载键逐个被点名(少一个 = 扫描器名单被削,后面的零发现作废)。
  expect(findings.filter((f) => f.kind === "content-bearing-key").map((f) => f.at).sort()).toEqual([
    "$.report.b64",
    "$.report.base64",
    "$.report.dataUrl",
    "$.report.data_url",
    "$.report.downloadPath",
    "$.report.r2Key",
  ])
  // 无害键名下的裸 base64 也测得出 —— 这是扫描器的能力下限,不是生产清洗的承诺(见抬头)。
  expect(findings.some((f) => f.at === "$.nested[0].blob" && f.kind === "content-base64")).toBe(true)
})

// ---------------------------------------------------------------------------
// 1. cloud-status:平台把内联内容塞进开放的 result ⇒ 真 handler 返回给 renderer 的
//    必须是清洗后的形状 —— #402 格 1 result_arm 当时的四条命中,现在必须为零。
// ---------------------------------------------------------------------------
const JOB_STATUS = "job_scrub1113a"
test("cloud-status: inline content smuggled via the open result field never reaches the renderer", async () => {
  canned.set(
    `/v1/cloud/jobs/${JOB_STATUS}`,
    JSON.stringify({
      schema_version: 1,
      job_id: JOB_STATUS,
      status: "completed",
      autonomy: "pipeline",
      progress: { phase: "completed" },
      artifact_ids: [],
      result: {
        summary: "quarterly report ready",
        report: { base64: MARKER_B64, r2Key: "tenants/t_gate/report.xlsx" },
        preview: `data:image/png;base64,${MARKER_B64}`,
      },
      error: null,
    }),
  )
  const status = (await handlers.get("cloud-status")!({} as never, JOB_STATUS)) as {
    job_id?: string
    result?: { summary?: unknown; report?: unknown; preview?: unknown }
    error?: unknown
  }
  // ① renderer 可见面零发现(不是 { error } 信封 —— 清洗不许把合法 status 变成拒绝)。
  expect(status.job_id).toBe(JOB_STATUS)
  expect(scan(status)).toEqual([])
  // ② 剥键是移除:report 下两个内容承载键连值一起消失;data URL 整串换占位符。
  expect(status.result?.report).toEqual({})
  expect(status.result?.preview).toBe(PLACEHOLDER)
  // ③ 清洗不是删除:非内容数据逐字存活。
  expect(status.result?.summary).toBe("quarterly report ready")
})

// ---------------------------------------------------------------------------
// 2. cloud-artifacts:list 的 result(anyOf[{},null] 同样无约束)是字符串形态的 data URL
//    ⇒ 换占位符;同一响应里的合法 descriptor 必须逐字段无损通过(清洗不误伤契约面)。
// ---------------------------------------------------------------------------
const JOB_LIST = "job_scrub1113b"
const SHA = "0123456789abcdef".repeat(4)
const DESCRIPTOR = {
  schemaVersion: 1,
  id: "art_job_scrub1113b_0_ab12cd34",
  source: "cloud",
  name: "report.bin",
  size: 3145728,
  sha256: SHA,
  claimedMime: "application/octet-stream",
  trust: "sandboxed",
  role: "primary",
  contentRef: { kind: "http-stream", url: "/v1/cloud/artifacts/art_job_scrub1113b_0_ab12cd34/content", auth: "bearer" },
  verification: { status: "verified", verifiedAt: "2026-08-25T00:00:00.000Z" },
  provenance: { producer: "pipeline", jobId: JOB_LIST, kind: "office-report", step: "run-sandbox", createdAt: "2026-08-25T00:00:00.000Z" },
}
test("cloud-artifacts: a data-URL result is replaced while the descriptor face survives verbatim", async () => {
  canned.set(
    `/v1/cloud/jobs/${JOB_LIST}/artifacts`,
    JSON.stringify({
      schema_version: 1,
      job_id: JOB_LIST,
      status: "completed",
      artifacts: [DESCRIPTOR],
      artifact_ids: [DESCRIPTOR.id],
      result: `data:application/octet-stream;base64,${MARKER_B64}`,
    }),
  )
  const list = (await handlers.get("cloud-artifacts")!({} as never, JOB_LIST)) as {
    job_id?: string
    result?: unknown
    artifacts?: Array<Record<string, unknown>>
  }
  expect(list.job_id).toBe(JOB_LIST)
  expect(scan(list)).toEqual([])
  expect(list.result).toBe(PLACEHOLDER)
  // descriptor 全字段逐字无损(深比较到独立誊写的期望对象,不是长度计数)。
  expect(list.artifacts).toEqual([DESCRIPTOR])
})
