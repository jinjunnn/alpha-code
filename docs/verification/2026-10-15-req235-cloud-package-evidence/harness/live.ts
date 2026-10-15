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
  // Authorized continuation: HTML is read-only; the image marker prevents a second paid POST.
  const save = async (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + "\n"
    requireFact(!text.includes(key), "refusing credential in evidence")
    await Bun.write(join(directory, name), text)
  }
  const request = async (url: string, body?: unknown) => {
    requireFact(Date.now() < expires, "test key expired")
    return fetch(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  }
  const ledger = async () => {
    const response = await request(`${ALPHA_ENDPOINTS.account}/v1/billing/transactions?limit=500`)
    requireFact(response.ok, `ledger HTTP ${response.status}`)
    return decodeContract("LedgerPageV1", await response.json(), "account").transactions
  }
  const records = await Bun.file(join(directory, "runtime-records.json")).json() as Record<string, Record<string, unknown>>
  for (const candidate of installed.candidates) {
    const previous = records[candidate.packageId]!
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
    const resumed = candidate.name === "image" && await Bun.file(join(directory, "image-accepted.json")).exists()
    const baseline = candidate.name === "image" && !resumed ? await ledger() : []
    const cursor = candidate.name === "html" ? 1564 : resumed
      ? (await Bun.file(join(directory, "image-ledger-before.json")).json() as { maxSeq: number }).maxSeq
      : Math.max(0, ...baseline.map((entry) => entry.seq))
    let jobId = "job_0493627afea0"
    if (resumed) {
      const saved = await Bun.file(join(directory, "image-accepted.json")).json() as { body: unknown }
      jobId = decodeContract("CloudJobAcceptedV1", saved.body, "cloud-http").job_id
    }
    if (candidate.name === "image" && !resumed) {
      const guarded = guardCloudEnvelope(envelope)
      requireFact(guarded.ok, "positive guard failed")
      const dispatchedAt = new Date().toISOString()
      writeFileSync(join(directory, "image-dispatch-started.json"), JSON.stringify({ dispatchedAt, key_id: keyId, cursor }) + "\n", { flag: "wx" })
      await save("image-ledger-before.json", { observedAt: dispatchedAt, maxSeq: cursor, factCount: baseline.length })
      await save("image-request.json", { dispatchedAt, envelope: guarded.envelope,
        promptSha256: sha256(values.prompt), idempotencyKeySha256: sha256(guarded.envelope.idempotency_key) })
      console.log(`image: POST once; ${dispatchedAt}`)
      const response = await request(`${cloudBase}/v1/cloud/jobs`, guarded.envelope)
      const body = await response.json()
      await save("image-accepted.json", { http: response.status, body })
      requireFact(response.ok, `positive dispatch HTTP ${response.status}; no retry`)
      jobId = decodeContract("CloudJobAcceptedV1", body, "cloud-http").job_id
      previous.dispatchedAt = dispatchedAt
    }
    const startedAt = new Date().toISOString()
    const deadline = (candidate.name === "image" ? Date.parse(String(previous.dispatchedAt)) : Date.now()) + 15 * 60_000
    const observations = []
    const billing = []
    let settlement: Record<string, unknown> = { status: "not-observed", charged_fen: null, cursor }
    let completed = false
    while (true) {
      const response = await request(`${cloudBase}/v1/cloud/jobs/${jobId}`)
      requireFact(response.ok, `status HTTP ${response.status}`)
      const body = await response.json()
      const status = decodeContract("CloudJobStatusV1", body, "cloud-http")
      const observedAt = new Date().toISOString()
      observations.push({ observedAt, http: response.status, body })
      await save(`${candidate.name}-followup-status.json`, observations)
      completed = status.status === "completed"
      if (["completed", "failed", "cancelled"].includes(status.status)) {
        // SSE can stay open even after completion. Save received bytes and a bounded-read outcome.
        if (!await Bun.file(join(directory, `${candidate.name}-events.json`)).exists()) {
          const chunks: string[] = []
          let http = 0
          let readError: string | null = null
          try {
            const events = await request(`${cloudBase}/v1/cloud/jobs/${jobId}/events`)
            http = events.status
            requireFact(events.ok && events.body, `events HTTP ${events.status}`)
            const reader = events.body.getReader()
            const decoder = new TextDecoder()
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              chunks.push(decoder.decode(chunk.value, { stream: true }))
              if (/event: job\.(completed|failed|cancelled)/.test(chunks.join(""))) {
                await reader.cancel()
                break
              }
            }
          } catch (error: unknown) {
            readError = error instanceof Error ? error.name : "events read failed"
          }
          await save(`${candidate.name}-events.json`, { observedAt, http, body: chunks.join(""), readError })
        }
        const artifacts = await request(`${cloudBase}/v1/cloud/jobs/${jobId}/artifacts`)
        requireFact(artifacts.ok, `artifacts HTTP ${artifacts.status}`)
        await save(`${candidate.name}-followup-artifacts.json`, { observedAt, http: artifacts.status, body: await artifacts.json() })
      }
      const page = await ledger()
      requireFact(page.length < 500 || Math.min(...page.map((entry) => entry.seq)) <= cursor, "ledger cursor fell outside page")
      const facts = page.filter((entry) => entry.seq > cursor)
      const ids = [...new Set(facts.filter((entry) => entry.kind === "reservation_created" &&
        entry.action_id === (candidate.name === "html" ? "tool.document_generate" : "tool.image_generate")).map((entry) => entry.reservation_id))]
      requireFact(ids.length <= 1, "ambiguous concurrent billing reservations")
      const id = candidate.name === "html" ? "db89265d-e617-4cc5-ba05-6d7c7f87a406" : ids[0]
      requireFact(candidate.name !== "html" || ids.length === 0 || ids[0] === id, "HTML reservation mismatch")
      const matching = facts.filter((entry) => entry.reservation_id === id)
      billing.push({ observedAt: new Date().toISOString(), facts: matching })
      await save(`${candidate.name}-followup-ledger.json`, billing)
      const settled = matching.some((entry) => entry.kind === "reservation_settled")
      const debits = matching.filter((entry) => ["usage_settled", "debt_incurred"].includes(entry.kind))
      requireFact(!settled || debits.length > 0, "settled reservation without debit evidence")
      settlement = { status: settled ? "settled" : "not-observed",
        charged_fen: settled ? -debits.reduce((sum, entry) => sum + entry.amount, 0) : null,
        reservation_id: id ?? null, cursor, seq: matching.map((entry) => entry.seq),
        lastObservedAt: billing.at(-1)!.observedAt, correlation: "unique action reservation after pre-dispatch ledger cursor" }
      records[candidate.packageId] = { ...previous, job_id: jobId, status: status.status, settlement,
        ...(completed ? { terminalObservedAt: previous.terminalObservedAt ?? observedAt } : {}) }
      await save("runtime-records.json", records)
      console.log(`${candidate.name}: ${jobId}; ${status.status}; charged_fen=${settlement.charged_fen}`)
      requireFact(!["failed", "cancelled"].includes(status.status), `job ${status.status}; stop, no retry`)
      if (completed && settled) break
      if (Date.now() >= deadline) break
      await Bun.sleep(Math.min(30_000, deadline - Date.now()))
    }
    await save(`${candidate.name}-observation-window.json`, { startedAt, finishedAt: new Date().toISOString(), intervalMs: 30_000,
      maximumMs: 900_000, lastStatus: observations.at(-1), settlement })
    requireFact(completed, "job not completed within 15 minutes; no redispatch")
    if (candidate.name === "image") {
      const response = await request(`${cloudBase}/v1/cloud/jobs/${jobId}/artifacts`)
      requireFact(response.ok, `artifacts HTTP ${response.status}`)
      const list = decodeContract("ArtifactListV1", await response.json(), "artifact")
      await save("image-artifacts.json", list)
      requireFact(list.status === "completed" && list.job_id === jobId && list.artifacts.length === 1, "expected exactly one completed artifact")
      const artifact = list.artifacts[0]!
      requireFact(artifact.provenance.producer !== "desktop" && artifact.provenance.jobId === jobId, "artifact job binding")
      requireFact(/^\/v1\/cloud\/artifacts\/[^/]+\/content$/.test(artifact.contentRef.url), "artifact content path")
      const content = await request(`${cloudBase}${artifact.contentRef.url}`)
      requireFact(content.ok, `artifact download HTTP ${content.status}`)
      const bytes = new Uint8Array(await content.arrayBuffer())
      const mime = content.headers.get("content-type")?.split(";")[0]
      const digest = sha256(bytes)
      requireFact(bytes.length > 0 && (artifact.size === undefined || bytes.length === artifact.size), "artifact byte count")
      requireFact(!artifact.sha256 || digest === artifact.sha256, "artifact SHA-256")
      requireFact(mime === "image/png", "artifact MIME")
      requireFact(!Buffer.from(bytes).includes(Buffer.from(key)), "refusing credential in artifact")
      await Bun.write(join(directory, "image-output.png"), bytes)
      records[candidate.packageId]!.artifacts = [{ id: artifact.id, mime, bytes: bytes.length, sha256: digest, downloadHttp: content.status }]
      await save("runtime-records.json", records)
      // Authorized image negative follows the successful paid job and artifact download.
      const negative = guardCloudEnvelope({ ...envelope, input: { ...input, prompt: "" } })
      requireFact(negative.ok, "empty prompt guard failed before server")
      const rejected = await request(`${cloudBase}/v1/cloud/jobs`, negative.envelope)
      const rejection = await rejected.json() as { code?: string }
      await save("image-empty-prompt.json", { http: rejected.status, body: rejection })
      requireFact(rejected.status === 400 && rejection.code === "pipeline_input_invalid", "empty prompt did not return 400 pipeline_input_invalid")
      records[candidate.packageId]!.negativeControls = { payload: candidate.integrityCode, emptyPromptHttp: rejected.status, emptyPromptCode: rejection.code }
    }
    const record = records[candidate.packageId]!
    record.use = settlement.status === "settled" ? "pass" : "pending"
    if (record.use === "pass") {
      delete record.pending
      record.verifiedAt = new Date().toISOString().slice(0, 10)
    } else {
      record.pending = "Completed and downloaded; no final settlement in job/events/artifacts or account ledger within the 15-minute follow-up window. See observation-window and followup-ledger."
    }
    await save("runtime-records.json", records)
  }
}

await main().catch((error: unknown) => {
  // Do not print arbitrary exceptions: a fetch error may retain request headers.
  const reason = typeof error === "string" ? error : "live evidence stopped"
  console.error(`BLOCKED: ${reason}; inspect saved non-secret evidence; do not redispatch`)
  process.exitCode = 1
})
