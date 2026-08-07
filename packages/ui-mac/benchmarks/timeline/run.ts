import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { cpus, arch, platform, release, totalmem } from "node:os"
import { fileURLToPath, URL } from "node:url"
import { chromium, type CDPSession } from "playwright-core"
import { build, preview } from "vite"
import { materializeTimelineBenchmarkFixture, timelineBenchmarkFixture } from "./fixture"
import type { TimelineHistoryResult, TimelineReadyResult, TimelineStreamResult } from "./types"

type RendererMemory = {
  jsHeapUsedBytes: number
  jsHeapTotalBytes: number
  documents: number
  nodes: number
  eventListeners: number
}

type BenchmarkRun = {
  run: number
  coldOpen: TimelineReadyResult
  stream: TimelineStreamResult
  history: TimelineHistoryResult
  rendererMemory: {
    afterColdOpen: RendererMemory
    afterStreaming: RendererMemory
    afterHistoryLoad: RendererMemory
  }
  network: {
    loopbackRequests: number
    blockedExternalRequests: string[]
  }
}

const here = fileURLToPath(new URL(".", import.meta.url))
const repo = fileURLToPath(new URL("../../../..", import.meta.url))
const config = fileURLToPath(new URL("./vite.config.ts", import.meta.url))
const script = fileURLToPath(import.meta.url)
const output = process.env.ALPHA_TIMELINE_BENCH_OUTPUT ?? `/tmp/alpha-timeline-benchmark-${Date.now()}`
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()

if (dirty && process.env.ALPHA_TIMELINE_BENCH_ALLOW_DIRTY !== "1")
  throw new Error("Refusing to record a baseline from a dirty worktree")

await access(chrome).catch(() => {
  throw new Error(`Chrome executable not found: ${chrome}`)
})
const fixture = materializeTimelineBenchmarkFixture()
const fixtureSha256 = createHash("sha256").update(JSON.stringify(fixture)).digest("hex")
const childRun = process.env.ALPHA_TIMELINE_BENCH_CHILD_RUN

if (childRun) {
  const run = Number(childRun)
  const baseURL = process.env.ALPHA_TIMELINE_BENCH_CHILD_BASE_URL
  const rawPath = process.env.ALPHA_TIMELINE_BENCH_CHILD_OUTPUT
  if (![1, 2, 3].includes(run) || !baseURL || !rawPath) throw new Error("Invalid timeline benchmark child input")
  const result = await benchmarkRun(run, baseURL)
  await writeFile(rawPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`run ${run}/3 complete\n`)
  process.exit(0)
}

await mkdir(output, { recursive: true })
await build({ configFile: config, logLevel: "warn", mode: "production" })
const server = await preview({ configFile: config, logLevel: "warn" })
const baseURL = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:4175/"
const runs: BenchmarkRun[] = []
const rawRuns: { file: string; sha256: string }[] = []

try {
  for (const run of [1, 2, 3]) {
    const file = `run-${run}.json`
    const rawPath = `${output}/${file}`
    await runWorker(run, baseURL, rawPath)
    const raw = await readFile(rawPath, "utf8")
    runs.push(JSON.parse(raw) as BenchmarkRun)
    rawRuns.push({ file, sha256: createHash("sha256").update(raw).digest("hex") })
  }

  const summary = {
    schemaVersion: 1,
    measuredCommit: commit,
    dirtyWorktreeAllowed: dirty.length > 0,
    fixtureSha256,
    fixture: timelineBenchmarkFixture,
    command: `CHROME_PATH=${chrome} ALPHA_TIMELINE_BENCH_OUTPUT=<evidence>/raw bun run bench:timeline (from packages/ui-mac; three serial runs)`,
    productionBuild: "Vite production build + loopback preview",
    browser: {
      executable: chrome,
      version: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
      headless: true,
    },
    runtime: {
      bun: process.versions.bun ?? "unknown",
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    isolation: {
      serialRuns: true,
      freshWorkerProcessPerRun: true,
      freshBrowserPerRun: true,
      viewport: timelineBenchmarkFixture.viewport,
      electronStarted: false,
      credentialsUsed: false,
      realApiKeysUsed: false,
      network: "loopback-only; every non-loopback page request is aborted",
    },
    medians: {
      coldOpenMs: median(runs.map((run) => run.coldOpen.coldOpenMs)),
      streamP95RafGapMs: median(runs.map((run) => run.stream.p95RafGapMs)),
      streamMaxRafGapMs: median(runs.map((run) => run.stream.maxRafGapMs)),
      streamEstimatedFrameLossRatio: median(runs.map((run) => run.stream.estimatedFrameLossRatio)),
      streamLongTaskCount: median(runs.map((run) => run.stream.longTasks.length)),
      streamLongTaskDurationMs: median(
        runs.map((run) => run.stream.longTasks.reduce((sum, task) => sum + task.durationMs, 0)),
      ),
      scrollToTopLatencyMs: median(runs.map((run) => run.history.scrollToTopLatencyMs)),
      historyPrependLatencyMs: median(runs.map((run) => run.history.historyPrependLatencyMs)),
      rendererHeapAfterColdOpenBytes: median(runs.map((run) => run.rendererMemory.afterColdOpen.jsHeapUsedBytes)),
      rendererHeapAfterStreamingBytes: median(runs.map((run) => run.rendererMemory.afterStreaming.jsHeapUsedBytes)),
      rendererHeapAfterHistoryLoadBytes: median(runs.map((run) => run.rendererMemory.afterHistoryLoad.jsHeapUsedBytes)),
      rendererHeapHistoryDeltaBytes: median(
        runs.map(
          (run) =>
            run.rendererMemory.afterHistoryLoad.jsHeapUsedBytes - run.rendererMemory.afterStreaming.jsHeapUsedBytes,
        ),
      ),
    },
    rawRuns,
  }
  await writeFile(`${output}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${output}/summary.json\n`)
} finally {
  await server.close()
}

async function runWorker(run: number, baseURL: string, rawPath: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ALPHA_TIMELINE_BENCH_CHILD_RUN: String(run),
        ALPHA_TIMELINE_BENCH_CHILD_BASE_URL: baseURL,
        ALPHA_TIMELINE_BENCH_CHILD_OUTPUT: rawPath,
      },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Timeline benchmark run ${run} exited with ${code ?? signal ?? "unknown"}`))
    })
  })
}

async function benchmarkRun(run: number, baseURL: string): Promise<BenchmarkRun> {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--headless=new",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-first-run",
    ],
  })
  const blockedExternalRequests: string[] = []
  let loopbackRequests = 0
  let completed = false
  try {
    const context = await browser.newContext({
      viewport: {
        width: timelineBenchmarkFixture.viewport.width,
        height: timelineBenchmarkFixture.viewport.height,
      },
      deviceScaleFactor: timelineBenchmarkFixture.viewport.deviceScaleFactor,
      serviceWorkers: "block",
    })
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (url.hostname === "127.0.0.1") {
        loopbackRequests += 1
        await route.continue()
        return
      }
      blockedExternalRequests.push(route.request().url())
      await route.abort("blockedbyclient")
    })
    const page = await context.newPage()
    page.on("pageerror", (error) => process.stderr.write(`run ${run} page error: ${error.message}\n`))
    const cdp = await context.newCDPSession(page)
    await cdp.send("Network.enable")
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true })
    await cdp.send("Performance.enable")
    await phase(run, "navigation", page.goto(`${baseURL}?run=${run}`, { waitUntil: "load" }), 30_000)
    const coldOpen = await phase(
      run,
      "cold-open",
      page.evaluate(() => window.__alphaTimelineBenchmark.ready),
      30_000,
    )
    assertColdOpen(coldOpen)
    const afterColdOpen = await rendererMemory(cdp)
    const stream = await phase(
      run,
      "streaming",
      page.evaluate(
        (durationMs) => window.__alphaTimelineBenchmark.runStreaming(durationMs),
        timelineBenchmarkFixture.streamDurationMs,
      ),
      timelineBenchmarkFixture.streamDurationMs + 30_000,
    )
    assertStream(stream)
    const afterStreaming = await rendererMemory(cdp)
    const history = await phase(
      run,
      "history-load",
      page.evaluate(() => window.__alphaTimelineBenchmark.runHistoryLoad()),
      30_000,
    )
    assertHistory(history)
    const afterHistoryLoad = await rendererMemory(cdp)
    await phase(run, "context-close", context.close(), 10_000)
    const result = {
      run,
      coldOpen,
      stream,
      history,
      rendererMemory: { afterColdOpen, afterStreaming, afterHistoryLoad },
      network: { loopbackRequests, blockedExternalRequests },
    }
    completed = true
    return result
  } finally {
    try {
      await phase(run, "browser-close", browser.close(), 10_000)
    } catch (error) {
      if (completed) throw error
      process.stderr.write(`run ${run}/3 browser-close failed after primary failure: ${String(error)}\n`)
    }
  }
}

async function phase<T>(run: number, name: string, task: Promise<T>, timeoutMs: number): Promise<T> {
  process.stdout.write(`run ${run}/3 ${name} start\n`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Run ${run} ${name} exceeded ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    const result = await Promise.race([task, timeout])
    process.stdout.write(`run ${run}/3 ${name} complete\n`)
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function rendererMemory(cdp: CDPSession): Promise<RendererMemory> {
  await cdp.send("HeapProfiler.collectGarbage")
  const result = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[]
  }
  const dom = (await cdp.send("Memory.getDOMCounters")) as {
    documents: number
    nodes: number
    jsEventListeners: number
  }
  const metrics = Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]))
  return {
    jsHeapUsedBytes: metrics.JSHeapUsedSize ?? 0,
    jsHeapTotalBytes: metrics.JSHeapTotalSize ?? 0,
    documents: dom.documents,
    nodes: dom.nodes,
    eventListeners: dom.jsEventListeners,
  }
}

function assertColdOpen(result: TimelineReadyResult) {
  if (result.mountedRows !== result.expectedRows)
    throw new Error(`Cold-open row mismatch: ${result.mountedRows}/${result.expectedRows}`)
  if (result.scrollHeight <= result.clientHeight) throw new Error("Large-session fixture did not overflow the viewport")
}

function assertStream(result: TimelineStreamResult) {
  if (result.observedDurationMs < timelineBenchmarkFixture.streamDurationMs)
    throw new Error(`Streaming window was too short: ${result.observedDurationMs}ms`)
  if (result.updates < timelineBenchmarkFixture.streamDurationMs / timelineBenchmarkFixture.streamIntervalMs - 5)
    throw new Error(`Streaming updates were incomplete: ${result.updates}`)
  if (result.rafGapsMs.length === 0) throw new Error("Streaming RAF diagnostics are empty")
}

function assertHistory(result: TimelineHistoryResult) {
  if (result.rowsAfter - result.rowsBefore !== result.insertedRows)
    throw new Error(`History row mismatch: ${result.rowsBefore} -> ${result.rowsAfter}`)
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}
