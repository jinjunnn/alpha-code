// alpha-code#402 格 6 的 envelope 半场 —— 非流式控制面在**分配/序列化/持久化之前**有硬上限。
//
// 两个上限,两条真路径:
//   · 上行 dispatch envelope 256 KiB —— 生产 guardCloudEnvelope(cloud-ipc 的 cloud-dispatch 走它);
//   · 下行非流式 JSON 512 KiB —— 生产 decodeJsonContract(cloud-status / cloud-artifacts 走它)。
//
// 期望值取自**独立契约文件** vendor/alpha-platform/contracts/v1/limits.json,不 import 生产常量:
// 代码与常量一起改错会一起自洽(ap#197 实测过),锚点必须在被测对象之外。
// 每个上限都测 **恰好** 与 **恰好 + 1** 两侧 —— 只测 +1,一个「写死 max」的实现会全绿。
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { electronStub, handlers } from "./electron-stub"
import { startOrigin } from "./harness"

const REPO = path.resolve(import.meta.dir, "../../../..")
const MAIN = path.join(REPO, "packages/ui-mac/src/main")
const FIXTURES = process.env.ALPHA_402_FIXTURES!
const OUT = process.env.ALPHA_402_OUT!
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"

/** 独立锚点:限额契约文件本身(与被测代码不同源)。 */
const limits = JSON.parse(
  fs.readFileSync(
    path.join(REPO, "packages/alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/limits.json"),
    "utf8",
  ),
) as { CONTROL_ENVELOPE_MAX_BYTES: number; NON_STREAMING_PAYLOAD_MAX_BYTES: number }

mock.module("electron", () => electronStub)
mock.module(`${MAIN}/logging`, () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}))
mock.module(`${MAIN}/alpha-auth`, () => ({
  getAccessToken: () => TOKEN,
  getAccessTokenIdentity: () => ({ ok: true, token: TOKEN }),
}))

let origin: Awaited<ReturnType<typeof startOrigin>>
let guardCloudEnvelope: (e: unknown, d?: { id?: () => string }) => { ok: boolean; error?: string }
const results: Record<string, unknown> = { limitsFromContractFile: limits }

beforeAll(async () => {
  origin = await startOrigin(path.join(import.meta.dir, "origin-raw.ts"), FIXTURES)
  process.env.ALPHA_CLOUD_URL = origin.base
  const mod = await import(`${MAIN}/cloud-ipc`)
  mod.registerCloudIpcHandlers()
  const guard = await import(`${MAIN}/cloud-envelope-guard`)
  guardCloudEnvelope = guard.guardCloudEnvelope
})

/** 夹具里的填充串长达 256 KiB;进仓的是它的长度,不是那 26 万个 `d`。数值判据在同一份文件里。 */
function elideLongStrings(v: unknown): unknown {
  if (typeof v === "string") return v.length > 256 ? { __elided__: `'${v[0]}' x ${v.length}` } : v
  if (Array.isArray(v)) return v.map(elideLongStrings)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, elideLongStrings(x)]))
  return v
}

afterAll(() => {
  origin.stop()
  fs.writeFileSync(path.join(OUT, "cell6-envelope.json"), `${JSON.stringify(elideLongStrings(results), null, 2)}\n`)
})

async function canned(pathname: string, status: number, body: string) {
  await fetch(`${origin.base}/__canned`, { method: "POST", body: JSON.stringify({ path: pathname, status, body }) })
}

/** 造一个**逐字节精确**为 targetBytes 的合法 CloudJobStatusV1(用无约束的 result 字段吸收长度)。 */
function statusOfExactly(jobId: string, targetBytes: number): string {
  const build = (padLen: number) =>
    JSON.stringify({
      schema_version: 1,
      job_id: jobId,
      status: "completed",
      autonomy: "pipeline",
      progress: { phase: "completed" },
      artifact_ids: [],
      result: { pad: "x".repeat(padLen) },
      error: null,
    })
  let pad = targetBytes - Buffer.byteLength(build(0), "utf8")
  let text = build(pad)
  // 长度全是 ASCII,一次就该命中;循环只是兜底。
  for (let i = 0; i < 5 && Buffer.byteLength(text, "utf8") !== targetBytes; i++) {
    pad += targetBytes - Buffer.byteLength(text, "utf8")
    text = build(pad)
  }
  return text
}

// ---------------------------------------------------------------------------
test("C6.E1 下行非流式 JSON:恰好 512 KiB 放行,512 KiB + 1 拒(两侧都测)", async () => {
  const cap = limits.NON_STREAMING_PAYLOAD_MAX_BYTES
  expect(cap).toBe(524288) // 独立字面量交叉核对:契约文件真的是 512 KiB

  const exactJob = "job_env_exact"
  const overJob = "job_env_over"
  const exact = statusOfExactly(exactJob, cap)
  const over = statusOfExactly(overJob, cap + 1)
  expect(Buffer.byteLength(exact, "utf8")).toBe(cap)
  expect(Buffer.byteLength(over, "utf8")).toBe(cap + 1)

  await canned(`/v1/cloud/jobs/${exactJob}`, 200, exact)
  await canned(`/v1/cloud/jobs/${overJob}`, 200, over)

  const atCap = (await handlers.get("cloud-status")!({} as never, exactJob)) as Record<string, unknown>
  const overCap = (await handlers.get("cloud-status")!({} as never, overJob)) as Record<string, unknown>

  results.c6_e1 = {
    cap,
    exactBytes: Buffer.byteLength(exact, "utf8"),
    overBytes: Buffer.byteLength(over, "utf8"),
    atCap: { keys: Object.keys(atCap), job_id: atCap.job_id, error: atCap.error },
    overCap,
  }
  expect(atCap.job_id).toBe(exactJob) // 恰好等于上限 → 正常解码
  expect(overCap).toEqual({ error: "contract-incompatible" }) // 上限 + 1 → fail closed
})

test("C6.E2 上行 dispatch envelope:恰好 256 KiB 放行,256 KiB + 1 拒(以真正会发出的序列化形态计量)", async () => {
  const cap = limits.CONTROL_ENVELOPE_MAX_BYTES
  expect(cap).toBe(262144)

  const fixedId = () => "00000000-0000-4000-8000-000000000000"
  const build = (padLen: number) => ({
    kind: "code-review",
    autonomy: "pipeline" as const,
    input: { diff: "d".repeat(padLen) },
  })
  // guard 会补 schema_version / artifact_policy / idempotency_key,所以「多大才恰好」必须
  // 按 guard 真正序列化的那个对象反推,而不是按调用方给的对象。
  const serializedOf = (padLen: number) =>
    Buffer.byteLength(
      JSON.stringify({
        schema_version: 1,
        artifact_policy: { delivery: "descriptor_only" },
        idempotency_key: fixedId(),
        ...build(padLen),
      }),
      "utf8",
    )
  let pad = cap - serializedOf(0)
  for (let i = 0; i < 5 && serializedOf(pad) !== cap; i++) pad += cap - serializedOf(pad)

  const atCap = guardCloudEnvelope(build(pad), { id: fixedId })
  const overCap = guardCloudEnvelope(build(pad + 1), { id: fixedId })
  results.c6_e2 = {
    cap,
    padAtCap: pad,
    serializedAtCap: serializedOf(pad),
    serializedOverCap: serializedOf(pad + 1),
    atCap,
    overCap,
  }
  expect(serializedOf(pad)).toBe(cap)
  expect(atCap.ok).toBe(true)
  expect(overCap.ok).toBe(false)
  expect(overCap.error).toBe(
    `envelope-too-large: ${cap + 1} bytes > ${cap}(diff-only 优先,勿传全库)`,
  )
})

test("C6.E3 反向标定:把上限当成「≥」还是「>」会改变哪一侧?两侧各差一个字节都必须给出不同答案", () => {
  const cap = limits.CONTROL_ENVELOPE_MAX_BYTES
  const fixedId = () => "00000000-0000-4000-8000-000000000000"
  const build = (padLen: number) => ({ kind: "k", autonomy: "pipeline" as const, input: { diff: "d".repeat(padLen) } })
  const serializedOf = (padLen: number) =>
    Buffer.byteLength(
      JSON.stringify({ schema_version: 1, artifact_policy: { delivery: "descriptor_only" }, idempotency_key: fixedId(), ...build(padLen) }),
      "utf8",
    )
  let pad = cap - serializedOf(0)
  for (let i = 0; i < 5 && serializedOf(pad) !== cap; i++) pad += cap - serializedOf(pad)
  const answers = [-1, 0, 1].map((d) => ({
    bytes: serializedOf(pad + d),
    ok: guardCloudEnvelope(build(pad + d), { id: fixedId }).ok,
  }))
  results.c6_e3 = answers
  expect(answers.map((a) => a.ok)).toEqual([true, true, false])
})
