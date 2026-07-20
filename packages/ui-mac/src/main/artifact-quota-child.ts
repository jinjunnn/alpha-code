import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeChunksChecked } from "./alpha-artifact-download"
import {
  finalizeArtifactWithQuota,
  initializeArtifactQuotaEnvironment,
  type ArtifactQuotaLimits,
} from "./artifact-service"

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
const waitFor = async (marker: string, reason: string) => {
  while (!existsSync(join(barrierDir, marker))) {
    if (Date.now() >= deadline) throw new Error(reason)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const uuid = `00000000-0000-4000-8000-${markerName.padStart(12, "0")}`
const initialized = await initializeArtifactQuotaEnvironment(projectDir, { volumeIsLocal: async () => true })
if (!initialized.ok) throw new Error(`artifact quota child: initialization failed (${initialized.error})`)
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
          async afterReservationCreated(reservationFile) {
            writeFileSync(join(barrierDir, `reserved-${markerName}`), reservationFile + "\n", { flag: "wx" })
            await waitFor(scenario === "ordered" ? `scan-${markerName}` : "scan", "reservation scan barrier timed out")
          },
          async afterQuotaScan() {
            writeFileSync(join(barrierDir, `scanned-${markerName}`), "scanned\n", { flag: "wx" })
            await waitFor("commit", "quota commit barrier timed out")
          },
        },
      }),
  },
)

writeFileSync(join(barrierDir, `done-${markerName}`), "done\n", { flag: "wx" })
process.stdout.write(JSON.stringify({ name, result }) + "\n")
