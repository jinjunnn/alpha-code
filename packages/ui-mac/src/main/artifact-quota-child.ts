import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeChunksChecked } from "./alpha-artifact-download"
import { finalizeArtifactWithQuota, type ArtifactQuotaLimits } from "./artifact-service"

const [projectDir, runId, name, content, barrierDir, markerName, limitsJson, deadlineText, startedAtText, scenario] =
  process.argv.slice(2)
if (
  !projectDir ||
  !runId ||
  !name ||
  content === undefined ||
  !barrierDir ||
  !markerName ||
  !limitsJson ||
  !deadlineText ||
  !startedAtText ||
  !scenario
)
  throw new Error("artifact quota child: missing arguments")

const limits = JSON.parse(limitsJson) as ArtifactQuotaLimits
const deadline = Number(deadlineText)
const startedAt = Number(startedAtText)
if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("artifact quota child: invalid deadline")
if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error("artifact quota child: invalid startedAt")
const targetPath = join(projectDir, ".alpha", "runs", runId, "artifacts", name)
const waiter = new Int32Array(new SharedArrayBuffer(4))
const waitFor = (marker: string, reason: string) => {
  while (!existsSync(join(barrierDir, marker))) {
    if (Date.now() >= deadline) throw new Error(reason)
    Atomics.wait(waiter, 0, 0, 10)
  }
}
const uuid = `00000000-0000-4000-8000-${markerName.padStart(12, "0")}`
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
        now: () => new Date(startedAt),
        testHooks: {
          reservationUuid: () => uuid,
          afterReservationCreated(reservationFile) {
            writeFileSync(join(barrierDir, `reserved-${markerName}`), reservationFile + "\n", { flag: "wx" })
            waitFor(scenario === "ordered" ? `scan-${markerName}` : "scan", "reservation scan barrier timed out")
          },
          afterQuotaScan() {
            writeFileSync(join(barrierDir, `scanned-${markerName}`), "scanned\n", { flag: "wx" })
            waitFor("commit", "quota commit barrier timed out")
          },
        },
      }),
  },
)

writeFileSync(join(barrierDir, `done-${markerName}`), "done\n", { flag: "wx" })
process.stdout.write(JSON.stringify({ name, result }) + "\n")
