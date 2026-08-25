// alpha-code#402 —— 在**出货运行时**上测传输内存。
//
// 为什么不在 bun 上判 AC2:桌面 main process 跑的是 Electron 的 Node(undici fetch),
// 不是 bun。用 bun 的 fetch 量出来的峰值,量的是 bun。本文件用 `bun build --target=node`
// 打成一个 JS,分别在 `node` 与 `ELECTRON_RUN_AS_NODE=1 electron` 下跑同一份生产代码。
//
// 被测入口是生产的 downloadArtifactToFile + finalizeArtifactWithQuota(两者都 electron-free)。
// 用法:node bundle.mjs <mode> <fileName> <originBase> <fixtureDir> <projectDir> <runId>
//   mode = stream | stream-slow | buffer
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { downloadArtifactToFile } from "../../../../packages/ui-mac/src/main/alpha-artifact-download"
import {
  finalizeArtifactWithQuota,
  initializeArtifactQuotaEnvironment,
} from "../../../../packages/ui-mac/src/main/artifact-service"
import { ensureAlphaScaffold, safeResolveInAlpha } from "../../../../packages/ui-mac/src/main/alpha-workdir"

const [mode, fileName, originBase, fixtureDir, projectDir, runId, delayMsRaw, chunkRaw] = process.argv.slice(2)
/** 限速臂:origin 每块之间 sleep,模拟真实网络(loopback 满速 ~500 MB/s 不是「正常流」)。 */
const delayMs = delayMsRaw ?? "0"
const chunkBytes = chunkRaw ?? "65536"
/** gc 压力臂:采样时强制 full GC —— 分辨「持有 N 字节」与「攒了 N 字节垃圾」。 */
const gcPressure = mode.includes("gc")
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"
const size = fs.statSync(path.join(fixtureDir, fileName)).size

const seg = (params: Record<string, string>) =>
  `/v1/cloud/artifacts/${Object.entries(params)
    .map(([k, v]) => `${k}_${v}`)
    .join("--")}/content`

// ELECTRON_RUN_AS_NODE 不接受 --js-flags,NODE_OPTIONS 也不许带 --expose-gc。
// 用 v8.setFlagsFromString + vm 拿到 gc 句柄 —— node 与 electron 上是同一条路。
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
const timeline: [number, number][] = []
let t0 = 0
let sampler: NodeJS.Timeout | undefined
const start = () => {
  t0 = Date.now()
  peak = rss()
  samples = 1
  timeline.push([0, peak])
  sampler = setInterval(() => {
    samples++
    if (gcPressure) forceGc()
    const now = rss()
    if (now > peak) peak = now
    if (timeline.length < 8000) timeline.push([Date.now() - t0, now])
  }, 2)
}
const stop = () => {
  if (sampler) clearInterval(sampler)
}

/** 慢消费者:每收到一条进度回调就**阻塞**主线程 8ms(生产支持的注入点,不改生产代码)。 */
function busyWait(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* 占住事件循环 -- 这正是「消费者慢」的意思 */
  }
}

async function main() {
  ensureAlphaScaffold(projectDir)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-402-nud-"))
  const init = await initializeArtifactQuotaEnvironment(userData)
  if (!init.ok) throw new Error(`quota env init failed: ${JSON.stringify(init)}`)
  const artifactsDir = safeResolveInAlpha(projectDir, "runs", runId, "artifacts")!
  fs.mkdirSync(artifactsDir, { recursive: true })
  const targetPath = path.join(artifactsDir, "big.bin")

  const descriptor = {
    schemaVersion: 1,
    id: `art_${runId}_0_ab12cd34`,
    source: "cloud",
    name: "big.bin",
    size,
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: seg({ file: fileName, probe: mode, delayMs, chunk: chunkBytes }), auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: runId },
  }

  // 预热:先真跑一遍 1 KiB,让 ajv/undici/fs 全部 fault-in。
  const warmRun = `${runId}warm`
  const warmDir = safeResolveInAlpha(projectDir, "runs", warmRun, "artifacts")!
  fs.mkdirSync(warmDir, { recursive: true })
  await downloadArtifactToFile(
    {
      artifact: {
        ...descriptor,
        id: `art_${warmRun}_0_ab12cd34`,
        name: "warm.bin",
        size: 1024,
        contentRef: { kind: "http-stream", url: seg({ file: "tiny.bin", probe: "warm" }), auth: "bearer" },
        provenance: { producer: "pipeline", jobId: warmRun },
      },
      targetPath: path.join(warmDir, "warm.bin"),
    },
    { token: TOKEN, base: originBase, finalize: (i) => finalizeArtifactWithQuota(projectDir, warmRun, i) },
  )
  forceGc()
  await new Promise((r) => setTimeout(r, 250))
  forceGc()
  const baseline = rss()

  let sha = ""
  let outcome: unknown
  const progressAt: [number, number][] = []
  const started = Date.now()
  start()
  if (mode === "buffer") {
    const res = await fetch(`${originBase}${seg({ file: fileName, probe: mode, delayMs, chunk: chunkBytes })}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(targetPath, buf)
    const { createHash } = await import("node:crypto")
    sha = createHash("sha256").update(buf).digest("hex")
    outcome = { ok: true, bytes: buf.byteLength, path: targetPath }
  } else {
    outcome = await downloadArtifactToFile(
      {
        artifact: descriptor,
        targetPath,
        onProgress: (p) => {
          progressAt.push([Date.now() - t0, p.bytes])
          if (mode === "stream-slow") busyWait(8)
        },
      },
      { token: TOKEN, base: originBase, finalize: (i) => finalizeArtifactWithQuota(projectDir, runId, i) },
    )
    sha = (outcome as { sha256?: string }).sha256 ?? ""
  }
  stop()
  const elapsedMs = Date.now() - started
  const diskSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : null

  process.stdout.write(
    `${JSON.stringify({
      runtime: process.versions.electron
        ? `electron ${process.versions.electron} / node ${process.versions.node}`
        : `node ${process.versions.node}`,
      mode,
      delayMs,
      chunkBytes,
      gcPressure,
      gcAvailable: !!gcHandle,
      fileName,
      size,
      baseline,
      peak,
      deltaBytes: peak - baseline,
      deltaMiB: Number(((peak - baseline) / 1048576).toFixed(2)),
      samples,
      elapsedMs,
      sha,
      diskSize,
      outcome,
      progressCount: progressAt.length,
      rssTimeline: timeline,
    })}\n`,
  )
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
