// #1114 —— 内存闸的测量臂:**一臂一进程**,在出货运行时(ELECTRON_RUN_AS_NODE=1 electron)里
// 跑一次生产路径的 100 MiB artifact 下载,报告 `peak(RSS) − baseline(RSS)`。
//
// 量法逐字固化自 #402 取证(docs/verification/2026-08-25-req092-402-artifact-transfer/,
// probes/node-arm.ts),因为那一轮已经付过学费:
//   · bun 上同一份生产代码量出 +249~393 MiB(Electron 上 +84),差 3~4 倍 —— 用 bun 判的是 bun;
//   · RSS 是进程级高水位,同进程连跑第二臂的 baseline 里含着第一臂的峰值,偏差方向恰好更好看;
//   · `ELECTRON_RUN_AS_NODE` 不接受 `--js-flags=--expose-gc`(实测 bad option),gc 句柄只能走
//     v8.setFlagsFromString + vm.runInNewContext,node 与 electron 同一条路。
//
// 被测入口 = 生产的 downloadArtifactToFile + finalizeArtifactWithQuota(经 bun build --target=node
// 打包,见 run.ts)。mode:
//   stream     —— 生产路径,不动采样器(AC2-b 驻留高水位臂);
//   stream-gc  —— 生产路径,采样时每 2ms 强制 full GC(AC2-a 活内存臂);
//   buffer     —— **已知的坏**:整包 arrayBuffer() 后落盘(闸的固定反例;#402 实测 +140.34 MiB,
//                 其摘要与落盘字节完全正确 —— 只有内存曲线能把它与生产路径分开)。
//
// 输出:stdout 一行 JSON。所有「测得像不像话」的判定(runtime/pid/采样条数/结局完整性)在
// run.ts 里做 —— 臂只报事实,不下结论。
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { downloadArtifactToFile } from "../../packages/ui-mac/src/main/alpha-artifact-download"
import {
  finalizeArtifactWithQuota,
  initializeArtifactQuotaEnvironment,
} from "../../packages/ui-mac/src/main/artifact-service"
import { ensureAlphaScaffold, safeResolveInAlpha } from "../../packages/ui-mac/src/main/alpha-workdir"

const [mode, originBase, fixtureFile, fixtureSha, fixtureSizeRaw, warmupFile] = process.argv.slice(2)
if (!mode || !originBase || !fixtureFile || !fixtureSha || !fixtureSizeRaw || !warmupFile) {
  console.error("usage: arm.mjs <stream|stream-gc|buffer> <originBase> <fixtureFile> <fixtureSha256> <fixtureSize> <warmupFile>")
  process.exit(2)
}
const fixtureSize = Number(fixtureSizeRaw)
const gcPressure = mode === "stream-gc"
const TOKEN = "GATE-TOKEN-1114-2b8e6f01-DO-NOT-LEAK"

// 平台契约不允许 query,参数走路径段(origin-raw 的既有路由形态)。
const seg = (params: Record<string, string>) =>
  `/v1/cloud/artifacts/${Object.entries(params)
    .map(([k, v]) => `${k}_${v}`)
    .join("--")}/content`

// gc 句柄:--expose-gc 在 ELECTRON_RUN_AS_NODE 下给不进来,自取。
let gcHandle: (() => void) | undefined = typeof global.gc === "function" ? (global.gc as () => void) : undefined
if (!gcHandle) {
  try {
    const v8 = require("node:v8") as typeof import("node:v8")
    const vm = require("node:vm") as typeof import("node:vm")
    v8.setFlagsFromString("--expose-gc")
    gcHandle = vm.runInNewContext("gc") as () => void
    v8.setFlagsFromString("--no-expose-gc")
  } catch {
    gcHandle = undefined
  }
}
const forceGc = () => gcHandle?.()

const rss = () => process.memoryUsage().rss
let peak = 0
let samples = 0
let sampler: NodeJS.Timeout | undefined
const startSampling = () => {
  peak = rss()
  samples = 1
  sampler = setInterval(() => {
    samples++
    if (gcPressure) forceGc()
    const now = rss()
    if (now > peak) peak = now
  }, 2)
}
const stopSampling = () => {
  if (sampler) clearInterval(sampler)
}

async function main() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1114-proj-"))
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1114-ud-"))
  try {
    ensureAlphaScaffold(projectDir)
    const init = await initializeArtifactQuotaEnvironment(userData)
    if (!init.ok) throw new Error(`quota env init failed: ${JSON.stringify(init)}`)
    const runId = "job_memgate01"
    const artifactsDir = safeResolveInAlpha(projectDir, "runs", runId, "artifacts")!
    fs.mkdirSync(artifactsDir, { recursive: true })
    const targetPath = path.join(artifactsDir, "big.bin")

    const descriptor = (over: Record<string, unknown>) => ({
      schemaVersion: 1,
      source: "cloud",
      trust: "sandboxed",
      role: "primary",
      verification: { status: "unverified" },
      provenance: { producer: "pipeline", jobId: runId },
      ...over,
    })

    // 预热:真跑一遍 1 KiB,把 ajv/undici/fs 全部 fault-in,再取 baseline。
    const warmDir = safeResolveInAlpha(projectDir, "runs", "job_memgatewarm", "artifacts")!
    fs.mkdirSync(warmDir, { recursive: true })
    const warm = await downloadArtifactToFile(
      {
        artifact: descriptor({
          id: "art_job_memgatewarm_0_ab12cd34",
          name: "warm.bin",
          size: 1024,
          contentRef: { kind: "http-stream", url: seg({ file: warmupFile, probe: "warm" }), auth: "bearer" },
          provenance: { producer: "pipeline", jobId: "job_memgatewarm" },
        }),
        targetPath: path.join(warmDir, "warm.bin"),
      },
      { token: TOKEN, base: originBase, finalize: (i) => finalizeArtifactWithQuota(projectDir, "job_memgatewarm", i) },
    )
    if (!warm.ok) throw new Error(`warmup download failed: ${JSON.stringify(warm)}`)
    forceGc()
    await new Promise((r) => setTimeout(r, 250))
    forceGc()
    const baseline = rss()

    let outcome: unknown
    let sha = ""
    const started = Date.now()
    startSampling()
    if (mode === "buffer") {
      // 已知的坏:整包读进内存再落盘。摘要与字节都正确 —— 这正是它可怕的地方。
      const res = await fetch(`${originBase}${seg({ file: fixtureFile, probe: "buffer" })}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(targetPath, buf)
      sha = crypto.createHash("sha256").update(buf).digest("hex")
      outcome = { ok: true, bytes: buf.byteLength, path: targetPath }
    } else {
      outcome = await downloadArtifactToFile(
        {
          artifact: descriptor({
            id: "art_job_memgate01_0_ab12cd34",
            name: "big.bin",
            size: fixtureSize,
            sha256: fixtureSha,
            contentRef: { kind: "http-stream", url: seg({ file: fixtureFile, probe: mode }), auth: "bearer" },
          }),
          targetPath,
        },
        { token: TOKEN, base: originBase, finalize: (i) => finalizeArtifactWithQuota(projectDir, runId, i) },
      )
      sha = (outcome as { sha256?: string }).sha256 ?? ""
    }
    stopSampling()
    const elapsedMs = Date.now() - started
    const diskSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : null

    process.stdout.write(
      `${JSON.stringify({
        pid: process.pid,
        electronVersion: process.versions.electron ?? null,
        nodeVersion: process.versions.node,
        mode,
        gcPressure,
        gcAvailable: !!gcHandle,
        baseline,
        peak,
        deltaBytes: peak - baseline,
        deltaMiB: Number(((peak - baseline) / 1048576).toFixed(2)),
        samples,
        elapsedMs,
        sha,
        diskSize,
        outcome,
      })}\n`,
    )
  } finally {
    stopSampling()
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(userData, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
