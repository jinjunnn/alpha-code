import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeChunksChecked } from "./alpha-artifact-download"
import { finalizeArtifactWithQuota, type ArtifactQuotaLimits } from "./artifact-service"

const [projectDir, runId, name, content, barrierDir, readyName, limitsJson, deadPidText] = process.argv.slice(2)
if (!projectDir || !runId || !name || content === undefined || !barrierDir || !readyName || !limitsJson)
  throw new Error("artifact quota child: missing arguments")

const limits = JSON.parse(limitsJson) as ArtifactQuotaLimits
const deadPid = deadPidText ? Number(deadPidText) : undefined
if (deadPid !== undefined && (!Number.isInteger(deadPid) || deadPid <= 0))
  throw new Error("artifact quota child: invalid dead PID")
const targetPath = join(projectDir, ".alpha", "runs", runId, "artifacts", name)
const waiter = new Int32Array(new SharedArrayBuffer(4))
const result = await writeChunksChecked(
  (async function* () {
    yield Buffer.from(content)
  })(),
  {
    targetPath,
    maxBytes: 100,
    expectedSize: Buffer.byteLength(content),
    via: "stream",
    finalize: (input) => {
      writeFileSync(join(barrierDir, readyName), "ready\n", { flag: "wx" })
      const deadline = Date.now() + 5_000
      while (!existsSync(join(barrierDir, "start"))) {
        if (Date.now() >= deadline) return { ok: false, error: "disk", detail: "child start barrier timed out" }
        Atomics.wait(waiter, 0, 0, 10)
      }
      return finalizeArtifactWithQuota(projectDir, runId, input, {
        limits,
        ...(deadPid !== undefined ? { pidAlive: (pid: number) => (pid === deadPid ? false : undefined) } : {}),
      })
    },
  },
)

process.stdout.write(JSON.stringify({ name, result }) + "\n")
