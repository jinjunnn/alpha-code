// alpha-code#402 —— 格 1(AC1 descriptor-only)+ 格 7(AC5 凭据/字节不外泄)。
//
// 走**真的生产 IPC handler**:registerCloudIpcHandlers() 注册的 cloud-status /
// cloud-artifacts / cloud-artifact-download / cloud-save-run 全部真跑,对着一个**真 HTTP origin**
// (独立进程)。只替身 electron、logging、alpha-auth —— 前两个是宿主,第三个是凭据来源
// (必须替身才能给出一个可扫描的 marker token)。
//
// 判据的粒度:不是「返回值里没有 base64 字段」这种可被错误实现满足的布尔,而是
//   ①渲染进程可见的每一个值(invoke 返回 + 每一条 wc.send)整棵树扫描;
//   ②日志行、盘上 manifest、盘上文件名同样扫描;
//   ③扫描器先用**已知的坏**标定(见 test "scanner calibration")—— 标不出坏就整轮作废。
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { electronStub, handlers, makeWebContents, sent } from "./electron-stub"
import { contentProbe, scanValue, startOrigin, shasumOf, type Finding } from "./harness"

const REPO = path.resolve(import.meta.dir, "../../../..")
const MAIN = path.join(REPO, "packages/ui-mac/src/main")
const FIXTURES = process.env.ALPHA_402_FIXTURES!
const OUT = process.env.ALPHA_402_OUT!

/** 可扫描的 marker:任何一处把它写进 renderer 可见面/日志/盘,扫描器必红。 */
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"

const logLines: unknown[][] = []
const fakeLogger = {
  log: (...a: unknown[]) => logLines.push(a),
  warn: (...a: unknown[]) => logLines.push(a),
  error: (...a: unknown[]) => logLines.push(a),
  info: (...a: unknown[]) => logLines.push(a),
  debug: (...a: unknown[]) => logLines.push(a),
}

mock.module("electron", () => electronStub)
mock.module(`${MAIN}/logging`, () => ({ getLogger: () => fakeLogger }))
mock.module(`${MAIN}/alpha-auth`, () => ({
  getAccessToken: () => TOKEN,
  getAccessTokenIdentity: () => ({ ok: true, token: TOKEN, tenantId: "t_probe", subject: "u_probe" }),
}))

let origin: Awaited<ReturnType<typeof startOrigin>>
let project: string
const results: Record<string, unknown> = {}

const SMALL = "small.bin"
const SMALL_BYTES = 3145728
let SMALL_SHA = ""

const JOB = "job_probe402a"
const ART_ID = "art_job_probe402a_0_ab12cd34"

/** contentRef.url 必须逐字满足平台契约的 `^/v1/cloud/artifacts/[^/]+/content$`(无 query)。 */
function contentUrl(params: Record<string, string>): string {
  const seg = Object.entries(params).map(([k, v]) => `${k}_${v}`).join("--")
  return `/v1/cloud/artifacts/${seg}/content`
}

function descriptorFor(probe: string) {
  return {
    schemaVersion: 1,
    id: ART_ID,
    source: "cloud",
    name: "report.bin",
    size: SMALL_BYTES,
    sha256: SMALL_SHA,
    claimedMime: "application/octet-stream",
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: contentUrl({ file: SMALL, probe }), auth: "bearer" },
    verification: { status: "verified", verifiedAt: "2026-08-25T00:00:00.000Z" },
    provenance: { producer: "pipeline", jobId: JOB, kind: "office-report", step: "run-sandbox", createdAt: "2026-08-25T00:00:00.000Z" },
  }
}

let secrets: Parameters<typeof scanValue>[1]

beforeAll(async () => {
  SMALL_SHA = shasumOf(path.join(FIXTURES, SMALL))
  const head = Buffer.alloc(64)
  const fd = fs.openSync(path.join(FIXTURES, SMALL), "r")
  fs.readSync(fd, head, 0, 64, 0)
  fs.closeSync(fd)
  secrets = { token: TOKEN, contentProbes: [contentProbe("small-head64", head)] }

  origin = await startOrigin(path.join(import.meta.dir, "origin-raw.ts"), FIXTURES)
  process.env.ALPHA_CLOUD_URL = origin.base
  project = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-402-proj-"))

  // 生产 main 在 boot 时做的同一件事(src/main/index.ts:690)。不做 ⇒ 配额准入拒绝一切 rename。
  const svc = await import(`${MAIN}/artifact-service`)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-402-userdata-"))
  const initialized = await svc.initializeArtifactQuotaEnvironment(userData)
  if (!initialized.ok) throw new Error(`quota env init failed: ${JSON.stringify(initialized)}`)

  const mod = await import(`${MAIN}/cloud-ipc`)
  mod.registerCloudIpcHandlers()
})

afterAll(() => {
  origin?.stop()
  fs.writeFileSync(path.join(OUT, "cell1-cell7.json"), `${JSON.stringify(results, null, 2)}\n`)
  fs.rmSync(project, { recursive: true, force: true })
})

async function canned(pathname: string, status: number, body: unknown) {
  await fetch(`${origin.base}/__canned`, {
    method: "POST",
    body: JSON.stringify({ path: pathname, status, body: typeof body === "string" ? body : JSON.stringify(body) }),
  })
}

// ---------------------------------------------------------------------------
// 0. 先证明扫描器**测得出已知的坏**。测不出 ⇒ 后面所有「无发现」都是假绿。
// ---------------------------------------------------------------------------
test("scanner calibration: every detector fires on a known-bad payload", () => {
  const head = Buffer.alloc(64)
  const fd = fs.openSync(path.join(FIXTURES, SMALL), "r")
  fs.readSync(fd, head, 0, 64, 0)
  fs.closeSync(fd)
  const poisoned = {
    authorization: `Bearer ${TOKEN}`,
    plainToken: TOKEN,
    preview: `data:image/png;base64,${head.toString("base64")}`,
    result: { base64: head.toString("base64") },
    inline: { bytes: new Uint8Array(head) },
    blobText: Buffer.alloc(300, 0x41).toString("base64"),
    hexEcho: head.toString("hex"),
    jsonBuffer: { type: "Buffer", data: [...head] },
  }
  const kinds = new Set(scanValue(poisoned, secrets).map((f) => f.kind))
  results.calibration = [...kinds].sort()
  for (const required of [
    "token-plaintext",
    "bearer-wordform",
    "data-url",
    "long-base64",
    "content-base64:small-head64",
    "content-hex:small-head64",
    "binary-object",
    "content-bearing-key",
    "byte-array",
  ]) {
    expect(kinds.has(required)).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// 1. cloud-status / cloud-artifacts:平台按契约发 descriptor-only ⇒ renderer 面干净
// ---------------------------------------------------------------------------
test("cell1: status + artifact list carrying real binary artifacts reach the renderer as descriptors only", async () => {
  const d = descriptorFor("A1")
  await canned(`/v1/cloud/jobs/${JOB}`, 200, {
    schema_version: 1,
    job_id: JOB,
    status: "completed",
    autonomy: "pipeline",
    kind: "office-report",
    progress: { phase: "completed", completed_steps: 3, total_steps: 3 },
    counters: { model_calls: 2, tokens_in: 10, tokens_out: 20, cost_usd: 0.01 },
    artifact_ids: [ART_ID],
    artifacts: [d],
    result: { summary: "3 MiB report produced", artifact_ids: [ART_ID] },
    error: null,
  })
  await canned(`/v1/cloud/jobs/${JOB}/artifacts`, 200, {
    schema_version: 1,
    job_id: JOB,
    status: "completed",
    artifacts: [d],
    artifact_ids: [ART_ID],
    result: null,
  })

  const status = await handlers.get("cloud-status")!({} as never, JOB)
  const list = await handlers.get("cloud-artifacts")!({} as never, JOB)

  const statusFindings = scanValue(status, secrets, "cloud-status")
  const listFindings = scanValue(list, secrets, "cloud-artifacts")
  results.cell1_status = { value: status, findings: statusFindings }
  results.cell1_list = { value: list, findings: listFindings }

  // 形状判据(不是布尔):status 里必须**有** descriptor 且它的 contentRef 是取回方式,不是内容。
  const artifacts = (status as { artifacts?: unknown[] }).artifacts ?? []
  expect(artifacts.length).toBe(1)
  expect((artifacts[0] as { contentRef: { kind: string } }).contentRef.kind).toBe("http-stream")
  expect(statusFindings).toEqual([])
  expect(listFindings).toEqual([])
})

// ---------------------------------------------------------------------------
// 1b. 反向:平台**违约**塞内联内容时,alpha-code 这一侧到底挡不挡?
//     (这一格记录的是事实,不是期望——挡不住就如实记 FAIL/GAP。)
// ---------------------------------------------------------------------------
test("cell1 adversarial: platform tries to smuggle inline bytes back in", async () => {
  const d = descriptorFor("A2") as Record<string, unknown>
  const head = Buffer.alloc(64)
  const fd = fs.openSync(path.join(FIXTURES, SMALL), "r")
  fs.readSync(fd, head, 0, 64, 0)
  fs.closeSync(fd)

  // (a) 内联字段挂在 descriptor 上
  const jobA = "job_probe402b"
  await canned(`/v1/cloud/jobs/${jobA}`, 200, {
    schema_version: 1, job_id: jobA, status: "completed", autonomy: "pipeline",
    progress: { phase: "completed" }, artifact_ids: [],
    artifacts: [{ ...d, base64: head.toString("base64") }],
    error: null,
  })
  const inDescriptor = await handlers.get("cloud-status")!({} as never, jobA)

  // (b) 内联字段挂在**开放的** result 上(schema 里 result 是 `{}` —— 无约束)
  const jobB = "job_probe402c"
  await canned(`/v1/cloud/jobs/${jobB}`, 200, {
    schema_version: 1, job_id: jobB, status: "completed", autonomy: "pipeline",
    progress: { phase: "completed" }, artifact_ids: [],
    result: {
      report: { base64: head.toString("base64") },
      preview: `data:image/png;base64,${head.toString("base64")}`,
    },
    error: null,
  })
  const inResult = await handlers.get("cloud-status")!({} as never, jobB)

  const fa = scanValue(inDescriptor, secrets, "descriptor-smuggle")
  const fb = scanValue(inResult, secrets, "result-smuggle")
  results.cell1_adversarial = {
    descriptor_arm: { value: inDescriptor, findings: fa },
    result_arm: { value: inResult, findings: fb },
  }

  // descriptor 是闭合 schema(additionalProperties:false)⇒ 必须 fail closed
  expect(inDescriptor).toEqual({ error: "contract-incompatible" })
  expect(fa).toEqual([])
})

// ---------------------------------------------------------------------------
// 7. 真下载一遍:renderer 可见面 / 进度事件 / 日志 / manifest / 文件名全扫
// ---------------------------------------------------------------------------
test("cell7: a real 3 MiB download leaks no bearer, no Buffer and no content bytes to any observable surface", async () => {
  sent.length = 0
  logLines.length = 0
  const wc = makeWebContents(11)
  const event = { sender: wc } as never
  const d = descriptorFor("A3")

  const outcome = await handlers.get("cloud-artifact-download")!(event, project, JOB, d)
  const artifactsDir = path.join(project, ".alpha", "runs", JOB, "artifacts")
  const onDisk = fs.readdirSync(artifactsDir)
  const manifestPath = path.join(project, ".alpha", "runs", JOB, "artifacts.json")
  const manifestText = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : ""

  const finalFile = path.join(artifactsDir, onDisk.find((f) => !f.endsWith(".part"))!)
  const diskSha = shasumOf(finalFile)

  const surfaces: Record<string, Finding[]> = {
    invokeReturn: scanValue(outcome, secrets, "cloud-artifact-download:return"),
    progressEvents: scanValue(sent, secrets, "wc.send"),
    logs: scanValue(logLines, secrets, "logger"),
    manifest: scanValue(manifestText, secrets, "artifacts.json"),
    fileNames: scanValue(onDisk, secrets, "artifacts/*"),
  }
  results.cell7 = {
    outcome,
    onDisk,
    diskSha,
    expectedSha: SMALL_SHA,
    progressEventCount: sent.length,
    progressChannels: [...new Set(sent.map((s) => s.channel))],
    logLineCount: logLines.length,
    manifestBytes: manifestText.length,
    findings: surfaces,
  }

  expect((outcome as { ok: boolean }).ok).toBe(true)
  // 内容真的到了盘上,且逐字节正确(第三方 shasum,不是被测代码算的那个)
  expect(diskSha).toBe(SMALL_SHA)
  expect(fs.statSync(finalFile).size).toBe(SMALL_BYTES)
  // 进度事件真的发生过(否则「没泄漏」只是因为「什么都没发」)
  expect(sent.length).toBeGreaterThan(0)
  expect(new Set(sent.map((s) => s.channel))).toEqual(new Set(["cloud-artifact-progress"]))
  // 每一条进度事件只带计数,不带字节
  for (const s of sent) {
    expect(Object.keys(s.payload as object).sort()).toEqual(["artifactId", "bytes", "percent", "runId", "total"])
  }
  for (const [name, findings] of Object.entries(surfaces)) {
    expect({ name, findings }).toEqual({ name, findings: [] })
  }
  // manifest 真的写了(非空),否则上面那条「manifest 干净」是空断言
  expect(manifestText.length).toBeGreaterThan(100)
  expect(manifestText).toContain(ART_ID)
})

test("cell7 control: the same scan flags a poisoned progress event and a poisoned manifest", () => {
  const poisonedSend = [{ wcId: 11, channel: "cloud-artifact-progress", payload: { runId: JOB, artifactId: ART_ID, bytes: 1, token: TOKEN } }]
  const poisonedManifest = JSON.stringify({ artifacts: [{ id: ART_ID, savedPath: `artifacts/${TOKEN}.bin` }] })
  const a = scanValue(poisonedSend, secrets, "wc.send")
  const b = scanValue(poisonedManifest, secrets, "artifacts.json")
  results.cell7_control = { progress: a, manifest: b }
  expect(a.length).toBeGreaterThan(0)
  expect(b.length).toBeGreaterThan(0)
})
