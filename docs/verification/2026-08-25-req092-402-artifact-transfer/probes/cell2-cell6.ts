// alpha-code#402 格 2(100 MiB 正常流:摘要 + 峰值 RSS ≤ 32 MiB)与格 6 的内存半场
// (慢消费者 / 内存不随文件大小线性增长)。
//
// 三条纪律,缺一条这份数字就不可信:
//  ① **在出货运行时上量**。桌面 main 跑 Electron 的 Node(undici),不是 bun。
//     bun 的 fetch 与 undici 的读前缓冲不是一回事,用 bun 量出来的峰值量的是 bun。
//     本文件同时跑 node 与 `ELECTRON_RUN_AS_NODE=1 electron`,并把两者都记下来。
//  ② **一臂一进程**。RSS 是进程级高水位,同进程连跑第二臂的 baseline 里含着第一臂的峰值,
//     偏差方向恰好是「更好看」。
//  ③ **先证明尺子量得出已知的坏**:buffer 臂(整包 arrayBuffer 后落盘)必须超顶;
//     它的摘要与落盘字节**完全正确** —— 也就是说,只有内存曲线能把它和生产路径分开。
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { originStats, shasumOf, startOrigin } from "./harness"

const FIXTURES = process.env.ALPHA_402_FIXTURES!
const OUT = process.env.ALPHA_402_OUT!
const REPO = path.resolve(import.meta.dir, "../../../..")
const BUNDLE = "/tmp/alpha402-node-arm.mjs"
const ELECTRON = path.join(REPO, "packages/ui-mac/node_modules/.bin/electron")

/** 父需求 alpha-work#1 AC2 原文:「传输额外峰值内存不超过 32 MiB」。独立字面量,不 import 生产常量。 */
const AC2_PEAK_CEILING_BYTES = 32 * 1024 * 1024

const origin = await startOrigin(path.join(import.meta.dir, "origin-raw.ts"), FIXTURES)

type Arm = {
  runtime: "node" | "electron"
  mode: string
  file: string
  delayMs?: number
  chunk?: number
  label: string
}

let seq = 0
function run(a: Arm) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-402-rt-"))
  const runId = `job_rt${(seq++).toString(36)}x`
  const args = [BUNDLE, a.mode, a.file, origin.base, FIXTURES, project, runId, String(a.delayMs ?? 0), String(a.chunk ?? 65536)]
  // ELECTRON_RUN_AS_NODE 不接受 --js-flags;gc 句柄在 arm 内部用 v8.setFlagsFromString 自取。
  const cmd = a.runtime === "node" ? process.env.ALPHA_402_NODE ?? "node" : ELECTRON
  const argv = a.runtime === "node" ? ["--expose-gc", ...args] : [...args]
  const r = spawnSync(cmd, argv, {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900_000,
  })
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop()
  if (r.status !== 0 || !line) {
    fs.rmSync(project, { recursive: true, force: true })
    // 失败也要留痕,不能让一条臂把整轮测量炸掉(炸掉之后重跑 = 又一轮机器时间)。
    return { label: a.label, failed: true, exit: r.status, stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-3000), rssTimeline: [] as [number, number][] }
  }
  const parsed = JSON.parse(line) as Record<string, unknown>
  const outPath = (parsed.outcome as { path?: string })?.path
  const diskSha = outPath && fs.existsSync(outPath) ? shasumOf(outPath) : null
  const tl = parsed.rssTimeline as [number, number][]
  const peakAtMs = tl.length ? tl.reduce((m, x) => (x[1] > m[1] ? x : m), tl[0])[0] : null
  delete parsed.rssTimeline
  fs.rmSync(project, { recursive: true, force: true })
  return { label: a.label, ...parsed, diskSha, peakAtMs, rssTimeline: tl }
}

const expected = Object.fromEntries(
  ["tiny.bin", "m25.bin", "m50.bin", "big100.bin"].map((f) => [f, shasumOf(path.join(FIXTURES, f))]),
)

const arms: Arm[] = []
for (const runtime of ["node", "electron"] as const) {
  arms.push({ runtime, mode: "buffer", file: "big100.bin", label: `${runtime}/known-bad-buffer/100MiB` })
  arms.push({ runtime, mode: "stream", file: "m25.bin", label: `${runtime}/stream/25MiB` })
  arms.push({ runtime, mode: "stream", file: "m50.bin", label: `${runtime}/stream/50MiB` })
  for (let i = 1; i <= 3; i++)
    arms.push({ runtime, mode: "stream", file: "big100.bin", label: `${runtime}/stream/100MiB#${i}` })
  arms.push({ runtime, mode: "stream-gc", file: "big100.bin", label: `${runtime}/stream+forced-gc/100MiB` })
  // 限速臂:每 64 KiB 间隔 2ms ≈ 30 MB/s,对得上真实宽带,而不是 loopback 的 ~500 MB/s。
  arms.push({ runtime, mode: "stream", file: "big100.bin", delayMs: 2, label: `${runtime}/stream@~30MB-s/100MiB` })
  arms.push({ runtime, mode: "stream", file: "big100.bin", delayMs: 8, label: `${runtime}/stream@~8MB-s/100MiB` })
  // 格 6 慢消费者:生产者满速,消费者每条进度回调阻塞 8ms。
  arms.push({ runtime, mode: "stream-slow", file: "big100.bin", label: `${runtime}/slow-consumer/100MiB` })
  arms.push({ runtime, mode: "stream-slow", file: "m25.bin", label: `${runtime}/slow-consumer/25MiB` })
}

const rows = arms.map(run)
const stats = await originStats(origin, "stream")
origin.stop()

const slim = rows.map((r) => {
  const { rssTimeline, ...rest } = r as Record<string, unknown> & { rssTimeline: [number, number][] }
  return rest
})

const okRows = rows.filter((r) => !(r as { failed?: boolean }).failed)
const digestOk = okRows.every((r) => {
  const exp = expected[r.fileName as string]
  return r.sha === exp && (r.diskSha === null || r.diskSha === exp)
})

const byLabel = Object.fromEntries(rows.map((r) => [r.label as string, r]))
const verdict = {
  ceilingBytes: AC2_PEAK_CEILING_BYTES,
  all_arms_digest_correct: digestOk,
  failed_arms: rows.filter((r) => (r as { failed?: boolean }).failed).map((r) => r.label),
  known_bad_over_ceiling: ["node", "electron"].every(
    (rt) => ((byLabel[`${rt}/known-bad-buffer/100MiB`]?.deltaBytes as number) ?? 0) > AC2_PEAK_CEILING_BYTES,
  ),
  gc_available: Object.fromEntries(okRows.map((r) => [r.label as string, r.gcAvailable])),
  peak_delta_MiB: Object.fromEntries(okRows.map((r) => [r.label as string, r.deltaMiB])),
  elapsed_ms: Object.fromEntries(okRows.map((r) => [r.label as string, r.elapsedMs])),
  under_ceiling: Object.fromEntries(
    okRows.map((r) => [r.label as string, (r.deltaBytes as number) <= AC2_PEAK_CEILING_BYTES]),
  ),
}

fs.writeFileSync(path.join(OUT, "cell2-cell6-runtime.json"), `${JSON.stringify({ expected, originStats: stats, rows: slim }, null, 2)}\n`)
// 时间线抽稀到每臂 <=300 点(**峰值点强制保留**)。原始采样每 2–4 ms,慢臂上万点 ⇒ 近 1 MB
// JSON 进仓,而复现曲线形状只要几百点。抽稀后仍能读出「峰值落在流式段」「25/50/100 MiB 的平台化」。
const decimate = (tl: [number, number][]) => {
  if (tl.length <= 300) return tl
  const step = tl.length / 300
  const keep = new Set<number>()
  for (let i = 0; i < 300; i++) keep.add(Math.floor(i * step))
  keep.add(tl.length - 1)
  let peak = 0
  for (let i = 1; i < tl.length; i++) if (tl[i][1] > tl[peak][1]) peak = i
  keep.add(peak)
  return [...keep].sort((a, b) => a - b).map((i) => tl[i])
}
fs.writeFileSync(
  path.join(OUT, "cell2-cell6-timelines.json"),
  `${JSON.stringify(
    rows.map((r) => ({
      label: r.label,
      originalSamples: (r.rssTimeline as [number, number][]).length,
      keptSamples: decimate(r.rssTimeline as [number, number][]).length,
      note: "uniform decimation to <=300 points; the peak sample is always kept",
      rssTimeline: decimate(r.rssTimeline as [number, number][]),
    })),
    null,
    2,
  )}\n`,
)
fs.writeFileSync(path.join(OUT, "cell2-cell6-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`)
console.log(JSON.stringify(verdict, null, 2))
