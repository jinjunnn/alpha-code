// Paid, opt-in manual evidence. Never imported by a gate. POST is never retried.
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { decodeContract } from "../../../../packages/alpha-contracts-consumer/src/decode"
import { ALPHA_ENDPOINTS } from "../../../../packages/ui-mac/src/shared/alpha-config"
import { guardCloudEnvelope } from "../../../../packages/ui-mac/src/main/cloud-envelope-guard"
import { directory, prepare, sha256 } from "./prepare"

const expires = Date.parse("2026-10-16T03:39:57Z")
const cloudBase = "https://alpha-cloud.tidelabs.click"
const keyId = "ak_EtFmJbPT"
// Existing platform input samples, not invented vendor response fixtures. Sources in README.
const prompts: Record<string, string> = {
  html: "松间咖啡虚构产品介绍页。秋日桂花燕麦拿铁，桂花香、燕麦口感、轻烘焙咖啡；只作概念展示，不售卖。",
  image: "A blue square",
}

function requireFact(ok: unknown, label: string): asserts ok {
  if (!ok) throw label
}

async function main() {
  requireFact(Date.now() < expires, "test key expired")
  const installed = await Bun.file(join(directory, "install.json")).json() as Awaited<ReturnType<typeof prepare>>
  const pointer = join(homedir(), ".claude/orchestration/alpha-platform/prod-test-account/keyfile-path.txt")
  // Actual handoff file contains KEYFILE=~/..., not a bare absolute path. Never source it.
  const location = (await Bun.file(pointer).text()).trim()
  requireFact(location.startsWith("KEYFILE=~/"), "unexpected keyfile pointer format")
  const key = (await Bun.file(join(homedir(), location.slice("KEYFILE=~/".length))).text()).trim()
  requireFact(key.length > 0, "empty test key file")
  // An interrupted/failed run cannot accidentally submit another paid job on rerun.
  writeFileSync(join(directory, "live-started.json"), JSON.stringify({ startedAt: new Date().toISOString(), key_id: keyId }) + "\n", { flag: "wx" })
  const save = async (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + "\n"
    requireFact(!text.includes(key), "refusing credential in evidence")
    await Bun.write(join(directory, name), text)
  }
  const request = async (url: string, body?: unknown) => {
    requireFact(Date.now() < expires, "test key expired")
    // No redirects: the credential stays on the explicit cloud/account origins.
    return fetch(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  }
  const ledger = async () => {
    const response = await request(`${ALPHA_ENDPOINTS.account}/v1/billing/transactions?limit=500`)
    requireFact(response.ok, `ledger HTTP ${response.status}`)
    return decodeContract("LedgerPageV1", await response.json(), "account").transactions
  }
  const before = await ledger() // Establish account.read and the cursor before any paid request.
  await save("ledger-before.json", { observedAt: new Date().toISOString(), maxSeq: Math.max(0, ...before.map((entry) => entry.seq)), factCount: before.length })
  const health = await fetch(`${cloudBase}/health`, { signal: AbortSignal.timeout(30_000) })
  await save("cloud-health.json", { http: health.status, body: await health.json() })
  requireFact(health.ok, "cloud health failed")
  const records: Record<string, unknown> = {}
  for (const candidate of installed.candidates) {
    const baseline = await ledger()
    const cursor = Math.max(0, ...baseline.map((entry) => entry.seq))
    const cloud = candidate.cloud
    const values: Record<string, string> = { prompt: prompts[candidate.name]! }
    // cloud-form-box.tsx run(): same field order, trimming, optional omission and key order.
    const input = {
      ...Object.fromEntries(cloud.fixed.map((entry) => [entry.name, entry.value])),
      ...Object.fromEntries(cloud.fields.flatMap((field) => {
        const value = field.control === "select" ? (values[field.name] ?? "") : (values[field.name] ?? "").trim()
        return value ? [[field.name, value]] : []
      })),
    }
    const envelope = { autonomy: "pipeline" as const, kind: cloud.pipelineKind, input, constraints: { network: "restricted" as const } }
    // Negative bypasses the UI's disabled button, but still traverses guard and the production API.
    const negative = guardCloudEnvelope({ ...envelope, input: { ...input, prompt: "" } })
    requireFact(negative.ok, "empty prompt guard failed before server")
    const rejected = await request(`${cloudBase}/v1/cloud/jobs`, negative.envelope)
    const rejection = await rejected.json() as { code?: string }
    await save(`${candidate.name}-empty-prompt.json`, { http: rejected.status, body: rejection })
    requireFact(rejected.status === 400 && rejection.code === "pipeline_input_invalid", "empty prompt did not return 400 pipeline_input_invalid")
    const guarded = guardCloudEnvelope(envelope)
    requireFact(guarded.ok, "positive guard failed")
    const dispatchedAt = new Date().toISOString()
    await save(`${candidate.name}-request.json`, { dispatchedAt, envelope: guarded.envelope,
      promptSha256: sha256(values.prompt), idempotencyKeySha256: sha256(guarded.envelope.idempotency_key) })
    console.log(`${candidate.name}: POST once; ${dispatchedAt}`)
    const response = await request(`${cloudBase}/v1/cloud/jobs`, guarded.envelope)
    const acceptedBody = await response.json()
    await save(`${candidate.name}-accepted.json`, { http: response.status, body: acceptedBody })
    requireFact(response.ok, `positive dispatch HTTP ${response.status}; no retry`)
    const accepted = decodeContract("CloudJobAcceptedV1", acceptedBody, "cloud-http")
    console.log(`${candidate.name}: ${accepted.job_id}`)
    const deadline = Date.now() + 15 * 60_000
    const observations = []
    while (true) {
      requireFact(Date.now() < deadline, "job observation deadline; no redispatch")
      const response = await request(`${cloudBase}/v1/cloud/jobs/${accepted.job_id}`)
      requireFact(response.ok, `status HTTP ${response.status}`)
      const status = decodeContract("CloudJobStatusV1", await response.json(), "cloud-http")
      observations.push({ observedAt: new Date().toISOString(), status })
      await save(`${candidate.name}-status.json`, observations)
      if (["completed", "failed", "cancelled"].includes(status.status)) {
        console.log(`${candidate.name}: terminal ${status.status}`)
        // Read settlement even for a failed job; never dispatch the next card after failure.
        const page = await ledger()
        const facts = page.filter((entry) => entry.seq > cursor)
        await save(`${candidate.name}-ledger.json`, facts)
        requireFact(status.status === "completed", `job ${status.status}; stop, no retry`)
        break
      }
      console.log(`${candidate.name}: ${status.status} / ${status.progress.phase}`)
      await Bun.sleep(10_000)
    }
    const artifactResponse = await request(`${cloudBase}/v1/cloud/jobs/${accepted.job_id}/artifacts`)
    requireFact(artifactResponse.ok, `artifacts HTTP ${artifactResponse.status}`)
    const list = decodeContract("ArtifactListV1", await artifactResponse.json(), "artifact")
    await save(`${candidate.name}-artifacts.json`, list)
    requireFact(list.status === "completed" && list.job_id === accepted.job_id && list.artifacts.length === 1, "expected exactly one completed artifact")
    const artifacts = []
    for (const artifact of list.artifacts) {
      requireFact(artifact.provenance.producer !== "desktop" && artifact.provenance.jobId === accepted.job_id, "artifact job binding")
      requireFact(/^\/v1\/cloud\/artifacts\/[^/]+\/content$/.test(artifact.contentRef.url), "artifact content path")
      const content = await request(`${cloudBase}${artifact.contentRef.url}`)
      requireFact(content.ok, `artifact download HTTP ${content.status}`)
      const bytes = new Uint8Array(await content.arrayBuffer())
      const mime = content.headers.get("content-type")?.split(";")[0]
      const digest = sha256(bytes)
      requireFact(bytes.length > 0 && (artifact.size === undefined || bytes.length === artifact.size), "artifact byte count")
      requireFact(!artifact.sha256 || digest === artifact.sha256, "artifact SHA-256")
      requireFact(mime === (candidate.name === "html" ? "text/html" : "image/png"), "artifact MIME")
      requireFact(!Buffer.from(bytes).includes(Buffer.from(key)), "refusing credential in artifact")
      const file = `${candidate.name}-output.${candidate.name === "html" ? "html" : "png"}`
      await Bun.write(join(directory, file), bytes)
      artifacts.push({ id: artifact.id, mime, bytes: bytes.length, sha256: digest, file, downloadHttp: content.status })
    }
    // The public ledger omits job_id. Require exactly one new matching reservation in this
    // serial observation window; record that correlation explicitly rather than invent a join.
    let settled = false
    for (let poll = 0; poll < 30; poll++) {
      const page = await ledger()
      requireFact(page.length < 500 || page.at(-1)!.seq <= cursor, "ledger cursor fell outside page")
      const facts = page.filter((entry) => entry.seq > cursor)
      await save(`${candidate.name}-ledger.json`, facts)
      const reservations = facts.filter((entry) => entry.kind === "reservation_created" && entry.action_id === (candidate.name === "html" ? "tool.document_generate" : "tool.image_generate"))
      const ids = [...new Set(reservations.map((entry) => entry.reservation_id))]
      requireFact(ids.length <= 1, "ambiguous concurrent billing reservations")
      const id = ids[0]
      if (id && facts.some((entry) => entry.reservation_id === id && entry.kind === "reservation_settled")) {
        const debits = facts.filter((entry) => entry.reservation_id === id && ["usage_settled", "debt_incurred"].includes(entry.kind))
        requireFact(debits.length > 0, "settled reservation without wallet debit evidence")
        const record = { version: candidate.version, digest: candidate.digest, install: "pass", use: "pass", method: "package-install",
          verifiedAt: new Date().toISOString().slice(0, 10), key_id: keyId, job_id: accepted.job_id, status: "completed",
          dispatchedAt, terminalAt: observations.at(-1)!.observedAt, counters: observations.at(-1)!.status.counters,
          settlement: { status: "settled", charged_fen: -debits.reduce((sum, entry) => sum + entry.amount, 0), reservation_id: id,
            seq: facts.filter((entry) => entry.reservation_id === id).map((entry) => entry.seq), correlation: "unique action reservation after pre-dispatch ledger cursor", cursor },
          artifacts, negativeControls: { payload: candidate.integrityCode, emptyPromptHttp: rejected.status, emptyPromptCode: rejection.code } }
        records[candidate.packageId] = record
        await save("runtime-records.json", records)
        console.log(`${candidate.name}: pass; charged_fen=${record.settlement.charged_fen}`)
        settled = true
        break
      }
      await Bun.sleep(10_000)
    }
    requireFact(settled, "settlement not observed; stop before next card")
  }
}

await main().catch((error: unknown) => {
  // Do not print arbitrary exceptions: a fetch error may retain request headers.
  const reason = typeof error === "string" ? error : "live evidence stopped"
  console.error(`BLOCKED: ${reason}; inspect saved non-secret evidence; do not redispatch`)
  process.exitCode = 1
})
