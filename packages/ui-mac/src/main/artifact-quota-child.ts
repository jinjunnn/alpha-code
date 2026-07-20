import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeChunksChecked } from "./alpha-artifact-download"
import { finalizeArtifactWithQuota, type ArtifactQuotaLimits } from "./artifact-service"

const [projectDir, runId, name, content, barrierDir, markerName, limitsJson, deadlineText, deadPidText, scenario] = process.argv.slice(2)
if (!projectDir || !runId || !name || content === undefined || !barrierDir || !markerName || !limitsJson || !deadlineText)
  throw new Error("artifact quota child: missing arguments")

const limits = JSON.parse(limitsJson) as ArtifactQuotaLimits
const deadline = Number(deadlineText)
if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("artifact quota child: invalid deadline")
const deadPid = deadPidText ? Number(deadPidText) : undefined
if (deadPid !== undefined && (!Number.isInteger(deadPid) || deadPid <= 0))
  throw new Error("artifact quota child: invalid dead PID")
const targetPath = join(projectDir, ".alpha", "runs", runId, "artifacts", name)
const waiter = new Int32Array(new SharedArrayBuffer(4))
const waitFor = (marker: string, reason: string) => {
  while (!existsSync(join(barrierDir, marker))) {
    if (Date.now() >= deadline) throw new Error(reason)
    Atomics.wait(waiter, 0, 0, 10)
  }
}
const result = await writeChunksChecked(
  (async function* () {
    yield Buffer.from(content)
  })(),
  {
    targetPath,
    maxBytes: 100,
    expectedSize: Buffer.byteLength(content),
    via: "stream",
    finalize: (input) =>
      finalizeArtifactWithQuota(projectDir, runId, input, {
        limits,
        ...(deadPid !== undefined ? { pidAlive: (pid: number) => (pid === deadPid ? false : undefined) } : {}),
        testHooks: {
          ...(scenario === "displacement"
            ? {
                afterStaleLockRevalidate() {
                  writeFileSync(join(barrierDir, `revalidated-${markerName}`), "revalidated\n", { flag: "wx" })
                  waitFor(`archive-${markerName}`, "stale archive barrier timed out")
                },
              }
            : {}),
          afterQuotaScan() {
            writeFileSync(join(barrierDir, `scanned-${markerName}`), "scanned\n", { flag: "wx" })
            waitFor(scenario === "displacement" ? `commit-${markerName}` : "commit", "quota scan barrier timed out")
          },
        },
      }),
  },
)

writeFileSync(join(barrierDir, `done-${markerName}`), "done\n", { flag: "wx" })
process.stdout.write(JSON.stringify({ name, result }) + "\n")
