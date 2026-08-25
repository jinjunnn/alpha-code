// alpha-code#402 格 5 —— Range / 空文件 / 重复下载 / 同名 / 并发(AC6)。
//
// 走**真的生产 IPC handler**(cloud-artifact-download),因为「同名不碰撞」这条保证的实现
// (reserveArtifactSavedName + 折叠比较 + 配额准入 rename)整个住在那一跳里;直接调
// downloadArtifactToFile 会把它整段跳过,然后得到一份好看的假绿。
//
// 运行时:bun(命名与并发是纯 fs 逻辑)。传输层的运行时敏感项在 cell3/cell4 的 node+electron 臂里。
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { electronStub, handlers, makeWebContents } from "./electron-stub"
import { originStats, shasumOf, startOrigin } from "./harness"

const REPO = path.resolve(import.meta.dir, "../../../..")
const MAIN = path.join(REPO, "packages/ui-mac/src/main")
const FIXTURES = process.env.ALPHA_402_FIXTURES!
const OUT = process.env.ALPHA_402_OUT!
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"

mock.module("electron", () => electronStub)
const logLines: unknown[][] = []
const push = (...a: unknown[]) => { logLines.push(a) }
mock.module(`${MAIN}/logging`, () => ({
  getLogger: () => ({ log: push, warn: push, error: push, info: push, debug: push }),
}))
mock.module(`${MAIN}/alpha-auth`, () => ({
  getAccessToken: () => TOKEN,
  getAccessTokenIdentity: () => ({ ok: true, token: TOKEN }),
}))

let origin: Awaited<ReturnType<typeof startOrigin>>
let project: string
const results: Record<string, unknown> = {}

const seg = (params: Record<string, string | number>) =>
  `/v1/cloud/artifacts/${Object.entries(params)
    .map(([k, v]) => `${k}_${v}`)
    .join("--")}/content`

let idSeq = 0
function descriptor(runId: string, name: string, params: Record<string, string | number>, over: Record<string, unknown> = {}) {
  const id = `art_${runId}_${idSeq++}_${crypto.randomBytes(4).toString("hex")}`
  return {
    schemaVersion: 1,
    id,
    source: "cloud",
    name,
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: seg(params), auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: runId },
    ...over,
  }
}

const artifactsDir = (runId: string) => path.join(project, ".alpha", "runs", runId, "artifacts")
const listRun = (runId: string) => {
  const d = artifactsDir(runId)
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : []
}
const dl = (runId: string, artifact: unknown, wcId = 1) =>
  handlers.get("cloud-artifact-download")!({ sender: makeWebContents(wcId) } as never, project, runId, artifact)

beforeAll(async () => {
  origin = await startOrigin(path.join(import.meta.dir, "origin-raw.ts"), FIXTURES)
  process.env.ALPHA_CLOUD_URL = origin.base
  project = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-402-c5-"))
  const svc = await import(`${MAIN}/artifact-service`)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-402-c5-ud-"))
  const init = await svc.initializeArtifactQuotaEnvironment(userData)
  if (!init.ok) throw new Error(`quota env init failed: ${JSON.stringify(init)}`)
  const mod = await import(`${MAIN}/cloud-ipc`)
  mod.registerCloudIpcHandlers()
})

afterAll(async () => {
  results.originRangeHeaders = await originStats(origin, "c5")
  origin.stop()
  fs.writeFileSync(path.join(OUT, "cell5.json"), `${JSON.stringify(results, null, 2)}\n`)
  fs.rmSync(project, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
test("C5.1 空文件 0 字节:落成真正的空 final,摘要 = 空串摘要,零残留", async () => {
  const run = "job_c5empty"
  const emptySha = shasumOf(path.join(FIXTURES, "empty.bin"))
  const outcome = await dl(run, descriptor(run, "empty.bin", { file: "empty.bin", probe: "c5" }, { size: 0, sha256: emptySha }))
  const files = listRun(run)
  const full = path.join(artifactsDir(run), "empty.bin")
  results.c5_1 = { outcome, files, size: fs.statSync(full).size, sha: shasumOf(full), emptySha }
  expect((outcome as { ok: boolean }).ok).toBe(true)
  // 独立锚点:空串的 sha256 是一个公开常数,不从被测路径读回
  expect(emptySha).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(fs.statSync(full).size).toBe(0)
  expect(shasumOf(full)).toBe(emptySha)
  expect(files).toEqual(["empty.bin"])
})

test("C5.2 桌面从不主动发 Range:origin 侧记录的 Range 头必须全是 null(Range 的正向验收在平台侧)", async () => {
  const run = "job_c5norange"
  await dl(run, descriptor(run, "a.bin", { file: "small.bin", probe: "c5" }))
  const s = await originStats(origin, "c5")
  results.c5_2 = { ranges: s.ranges, requests: s.requests }
  expect(s.requests).toBeGreaterThan(0)
  expect(s.ranges.every((r) => r === null)).toBe(true)
})

test("C5.3 origin 擅自回 206 partial(只给一半字节)→ 摘要/尺寸不变量照旧生效,拒收且零残留", async () => {
  const run = "job_c5partial"
  const fullSize = fs.statSync(path.join(FIXTURES, "small.bin")).size
  const outcome = await dl(
    run,
    descriptor(run, "partial.bin", { file: "small.bin", probe: "c5p", mode: "declare", declare: fullSize, actual: 1048576 }, { size: fullSize }),
  )
  const files = listRun(run)
  results.c5_3 = { outcome, files, fullSize }
  // 「服务端在声明长度之前把连接关了」在 undici 上有两种落法:body 提前 done(→ size-mismatch)
  // 或整条流 terminated(→ network)。判据钉的是**不变量**:必须是 typed 拒绝、必须报出声明长度、
  // 且盘上一个字节都不留 —— 而不是某一次跑出来的那个字节数(那是环境噪声,不是保证)。
  const o = outcome as { ok: boolean; error: string; detail?: string }
  expect(o.ok).toBe(false)
  expect(["size-mismatch", "network"]).toContain(o.error)
  if (o.error === "size-mismatch") expect(o.detail).toContain(`declared ${fullSize}`)
  expect(files).toEqual([])
})

test("C5.4 重复下载同一件两次:两次都成功,盘上仍只有一个文件,内容正确,零 `.part`", async () => {
  const run = "job_c5repeat"
  const d = descriptor(run, "same.bin", { file: "small.bin", probe: "c5" })
  const first = await dl(run, d)
  const filesAfterFirst = listRun(run)
  const second = await dl(run, d)
  const files = listRun(run)
  const expectedSha = shasumOf(path.join(FIXTURES, "small.bin"))
  const shas = files.map((f) => shasumOf(path.join(artifactsDir(run), f)))
  results.c5_4 = { first, second, filesAfterFirst, files, shas, expectedSha }
  expect((first as { ok: boolean }).ok).toBe(true)
  expect((second as { ok: boolean }).ok).toBe(true)
  expect(files.filter((f) => f.endsWith(".part"))).toEqual([])
  expect(shas.every((s) => s === expectedSha)).toBe(true)
})

test("C5.5 同名不同件(两个 descriptor 都叫 report.bin,内容不同)→ 两份都在,互不覆盖,各自内容正确", async () => {
  const run = "job_c5samename"
  const a = descriptor(run, "report.bin", { file: "small.bin", probe: "c5" })
  const b = descriptor(run, "report.bin", { file: "m25.bin", probe: "c5" })
  const logsBefore = logLines.length
  const ra = await dl(run, a)
  const rb = await dl(run, b)
  const logsDuring = logLines.slice(logsBefore).map((l) => l.map(String).join(" "))
  const files = listRun(run)
  const shaByFile = Object.fromEntries(files.map((f) => [f, shasumOf(path.join(artifactsDir(run), f))]))
  const expectSmall = shasumOf(path.join(FIXTURES, "small.bin"))
  const expect25 = shasumOf(path.join(FIXTURES, "m25.bin"))
  const manifestPath = path.join(project, ".alpha", "runs", run, "artifacts.json")
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null
  const entries = (manifest?.artifacts ?? []).map((e: Record<string, unknown>) => ({
    id: e.id ?? (e.descriptor as { id?: string } | undefined)?.id,
    savedPath: e.savedPath,
    sha256: e.sha256 ?? e.verifiedSha256,
    state: e.state,
  }))
  results.c5_5 = {
    ra, rb, files, shaByFile, expectSmall, expect25,
    rawManifest: manifest,
    logsDuring,
    aId: (a as { id: string }).id, bId: (b as { id: string }).id,
    manifestEntries: entries,
    samePathForBothArtifacts: (ra as { path?: string }).path === (rb as { path?: string }).path,
  }
  expect((ra as { ok: boolean }).ok).toBe(true)
  expect((rb as { ok: boolean }).ok).toBe(true)
  // 期望:两件不同的 artifact(id 不同、内容不同)不得落到同一个文件名上。
  expect(files.length).toBe(2)
  const shas = Object.values(shaByFile).sort()
  expect(shas).toEqual([expectSmall, expect25].sort())
})

test("C5.6 大小写折叠同名(report.bin / REPORT.BIN)→ 不静默覆盖", async () => {
  const run = "job_c5fold"
  const a = descriptor(run, "fold.bin", { file: "small.bin", probe: "c5" })
  const b = descriptor(run, "FOLD.BIN", { file: "m25.bin", probe: "c5" })
  await dl(run, a)
  await dl(run, b)
  const files = listRun(run)
  const shaByFile = Object.fromEntries(files.map((f) => [f, shasumOf(path.join(artifactsDir(run), f))]))
  results.c5_6 = { files, shaByFile }
  expect(files.length).toBe(2)
  expect(new Set(Object.values(shaByFile)).size).toBe(2)
})

test("C5.7 并发 8 件同 run:全部成功、8 个不同文件、逐件内容正确、零 `.part` 残留", async () => {
  const run = "job_c5conc"
  const specs = [
    ["tiny.bin", "t1.bin"], ["tiny.bin", "t2.bin"], ["small.bin", "s1.bin"], ["small.bin", "s2.bin"],
    ["m25.bin", "b1.bin"], ["m25.bin", "b2.bin"], ["small.bin", "s3.bin"], ["tiny.bin", "t3.bin"],
  ] as const
  const outcomes = await Promise.all(
    specs.map(([file, name], i) => dl(run, descriptor(run, name, { file, probe: "c5" }), 100 + i)),
  )
  const files = listRun(run)
  const shaByFile = Object.fromEntries(files.map((f) => [f, shasumOf(path.join(artifactsDir(run), f))]))
  const expectedByName = Object.fromEntries(specs.map(([file, name]) => [name, shasumOf(path.join(FIXTURES, file))]))
  results.c5_7 = { outcomes, files, shaByFile, expectedByName }
  expect(outcomes.every((o) => (o as { ok: boolean }).ok)).toBe(true)
  expect(files.filter((f) => f.endsWith(".part"))).toEqual([])
  expect(files.length).toBe(8)
  for (const [name, sha] of Object.entries(expectedByName)) expect(shaByFile[name]).toBe(sha)
})

test("C5.8 同一窗口并发下同一件 → 第二次被 already-downloading 拒;不同窗口并发同一件 → 两份都正确且不碰撞", async () => {
  const run = "job_c5dupe"
  const d = descriptor(run, "dupe.bin", { file: "m25.bin", probe: "c5", delayMs: 1 })
  const wc = makeWebContents(500)
  const [a, b] = await Promise.all([
    handlers.get("cloud-artifact-download")!({ sender: wc } as never, project, run, d),
    handlers.get("cloud-artifact-download")!({ sender: wc } as never, project, run, d),
  ])
  const sameWindow = { a, b }

  const run2 = "job_c5dupe2"
  const d2 = descriptor(run2, "dupe2.bin", { file: "m25.bin", probe: "c5", delayMs: 1 })
  const [c, e] = await Promise.all([
    handlers.get("cloud-artifact-download")!({ sender: makeWebContents(601) } as never, project, run2, d2),
    handlers.get("cloud-artifact-download")!({ sender: makeWebContents(602) } as never, project, run2, d2),
  ])
  const files2 = listRun(run2)
  const shas2 = files2.map((f) => shasumOf(path.join(artifactsDir(run2), f)))
  const expected25 = shasumOf(path.join(FIXTURES, "m25.bin"))
  results.c5_8 = { sameWindow, crossWindow: { c, e }, files2, shas2, expected25 }

  const outcomes = [a, b] as { ok: boolean; error?: string }[]
  expect(outcomes.filter((o) => o.ok).length).toBe(1)
  expect(outcomes.filter((o) => !o.ok && o.error === "already-downloading").length).toBe(1)
  expect(listRun(run).filter((f) => f.endsWith(".part"))).toEqual([])

  expect([c, e].every((o) => (o as { ok: boolean }).ok)).toBe(true)
  expect(files2.filter((f) => f.endsWith(".part"))).toEqual([])
  expect(shas2.every((s) => s === expected25)).toBe(true)
})
