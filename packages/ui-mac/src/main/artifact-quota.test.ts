// REQ-093/#279 —— run/project artifact quota 原子准入。真实 temp project + 真实
// `.part → fsync → project lock 内核算/rename`:正反例、末余额并发、崩溃锁/孤儿 staging 恢复、脱敏错误面。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostname, tmpdir } from "node:os"
import { uniquePartPath, writeChunksChecked, type ArtifactDownloadOutcome } from "./alpha-artifact-download"
import {
  ARTIFACT_QUOTA_LOCK_FILE,
  artifactQuotaLockPath,
  finalizeArtifactWithQuota,
  type ArtifactQuotaFinalizeOptions,
  type ArtifactQuotaLimits,
} from "./artifact-service"

const RUN = "job-quota"
const OTHER_RUN = "job-other"
const SECRET = "Bearer-TOKEN-MARKER-req093"
const LOCK_BUSY_DETAIL = "artifact quota admission unavailable (project lock busy)"

let projectDir: string
const artifactsDir = (runId = RUN) => join(projectDir, ".alpha", "runs", runId, "artifacts")
const target = (name: string) => join(artifactsDir(), name)

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "artifact-quota-")))
  mkdirSync(artifactsDir(), { recursive: true })
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function limits(over: Partial<ArtifactQuotaLimits> = {}): ArtifactQuotaLimits {
  return { runMaxBytes: 10, runMaxCount: 10, projectMaxBytes: 20, ...over }
}

function finalize(opts: ArtifactQuotaFinalizeOptions = {}) {
  return (input: Parameters<typeof finalizeArtifactWithQuota>[2]) =>
    finalizeArtifactWithQuota(projectDir, RUN, input, opts)
}

async function write(name: string, content: string, opts: ArtifactQuotaFinalizeOptions = {}) {
  return writeChunksChecked(
    (async function* () {
      yield Buffer.from(content)
    })(),
    {
      targetPath: target(name),
      maxBytes: 100,
      expectedSize: Buffer.byteLength(content),
      via: "stream",
      finalize: finalize(opts),
    },
  )
}

function stagingResidue(): string[] {
  return readdirSync(artifactsDir()).filter((name) => name.endsWith(".part"))
}

function writeProjectLock(
  over: Partial<{ pid: number; hostname: string; nonce: string; acquiredAt: string }> = {},
): string {
  const lock = artifactQuotaLockPath(projectDir)
  if (!lock) throw new Error("test setup: project lock path unavailable")
  writeFileSync(
    lock,
    JSON.stringify({
      v: 1,
      pid: process.pid,
      hostname: hostname(),
      nonce: "test-project-lock",
      acquiredAt: "2026-07-20T12:00:00.000Z",
      ...over,
    }),
  )
  return lock
}

type ChildFinalizeResult = { name: string; result: ArtifactDownloadOutcome }

async function runConcurrentFinalizers(names: [string, string], quota: ArtifactQuotaLimits, deadPid?: number) {
  const barrierDir = join(projectDir, "artifact-quota-barrier")
  mkdirSync(barrierDir)
  const helper = join(import.meta.dir, "artifact-quota-child.ts")
  const children = names.map((name, index) =>
    Bun.spawn(
      [
        process.execPath,
        helper,
        projectDir,
        RUN,
        name,
        index === 0 ? "a" : "b",
        barrierDir,
        `ready-${index}`,
        JSON.stringify(quota),
        deadPid?.toString() ?? "",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ),
  )
  const ready = children.map((_, index) => join(barrierDir, `ready-${index}`))
  const barrierDeadline = Date.now() + 5_000
  while (!ready.every(existsSync) && Date.now() < barrierDeadline) await Bun.sleep(10)
  const barrierReady = ready.every(existsSync)
  if (barrierReady) writeFileSync(join(barrierDir, "start"), "start\n", { flag: "wx" })
  if (!barrierReady) children.forEach((child) => child.kill())

  const killTimer = setTimeout(() => children.forEach((child) => child.kill()), 5_000)
  const [codes, stdout, stderr] = await Promise.all([
    Promise.all(children.map((child) => child.exited)),
    Promise.all(children.map((child) => new Response(child.stdout).text())),
    Promise.all(children.map((child) => new Response(child.stderr).text())),
  ])
  clearTimeout(killTimer)
  if (!barrierReady) throw new Error(`child start barrier failed: ${stderr.join(" | ")}`)
  if (codes.some((code) => code !== 0))
    throw new Error(`artifact quota child failed (${codes.join(", ")}): ${stderr.join(" | ")}`)
  return stdout.map((output) => JSON.parse(output) as ChildFinalizeResult)
}

function expectSingleAdmission(results: ChildFinalizeResult[], names: [string, string]) {
  const admitted = results.filter((entry) => entry.result.ok)
  const refused = results.filter((entry) => !entry.result.ok)
  expect(admitted).toHaveLength(1)
  expect(refused).toHaveLength(1)
  const failure = refused[0]!.result
  if (failure.ok) throw new Error("unreachable")
  const expectedFailure = failure.error === "over-limit" || (failure.error === "disk" && failure.detail === LOCK_BUSY_DETAIL)
  expect(expectedFailure).toBe(true)
  expect(names.map((name) => existsSync(target(name))).filter(Boolean)).toHaveLength(1)
  expect(stagingResidue()).toEqual([])
}

describe("finalizeArtifactWithQuota", () => {
  test("under both run and project limits admits before final rename", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const result = await write("admitted.bin", "12345", { limits: limits() })

    expect(result.ok).toBe(true)
    expect(readFileSync(target("admitted.bin"), "utf8")).toBe("12345")
    expect(stagingResidue()).toEqual([])
  })

  test("run byte and count limits fail closed with no final file or staging residue", async () => {
    writeFileSync(target("existing.bin"), "12345678")
    const bytes = await write("run-bytes.bin", "123", { limits: limits() })
    expect(bytes).toMatchObject({ ok: false, error: "over-limit" })
    expect(String((bytes as { detail?: string }).detail)).toContain("run bytes")
    expect(existsSync(target("run-bytes.bin"))).toBe(false)

    const count = await write("run-count.bin", "1", { limits: limits({ runMaxBytes: 100, runMaxCount: 1 }) })
    expect(count).toMatchObject({ ok: false, error: "over-limit" })
    expect(String((count as { detail?: string }).detail)).toContain("run artifact count")
    expect(existsSync(target("run-count.bin"))).toBe(false)
    expect(stagingResidue()).toEqual([])
  })

  test("project limit includes committed bytes from other runs", async () => {
    mkdirSync(artifactsDir(OTHER_RUN), { recursive: true })
    writeFileSync(join(artifactsDir(OTHER_RUN), "other.bin"), "12345678")
    const result = await write("project.bin", "123", {
      limits: limits({ runMaxBytes: 100, projectMaxBytes: 10 }),
    })

    expect(result).toMatchObject({ ok: false, error: "over-limit" })
    expect(String((result as { detail?: string }).detail)).toContain("project bytes")
    expect(existsSync(target("project.bin"))).toBe(false)
    expect(stagingResidue()).toEqual([])
  })

  test("two Bun processes racing for the final byte admit exactly one", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const names: [string, string] = ["racer-a.bin", "racer-b.bin"]
    const results = await runConcurrentFinalizers(names, limits({ runMaxBytes: 5, projectMaxBytes: 5 }))

    expectSingleAdmission(results, names)
  }, 15_000)

  test("a lock older than fifteen minutes stays busy while its local PID is alive", async () => {
    const lock = writeProjectLock({ acquiredAt: "2026-07-20T12:00:00.000Z" })
    const result = await write("live-holder.bin", "x", {
      limits: limits(),
      now: () => new Date("2026-07-20T12:16:00.000Z"),
    })

    expect(result).toEqual({ ok: false, error: "disk", detail: LOCK_BUSY_DETAIL })
    expect(existsSync(lock)).toBe(true)
    expect(existsSync(target("live-holder.bin"))).toBe(false)
    expect(stagingResidue()).toEqual([])
  })

  test("foreign-host and malformed locks fail closed instead of being reclaimed by age", async () => {
    const lock = writeProjectLock({ hostname: `${hostname()}-foreign`, acquiredAt: "2020-01-01T00:00:00.000Z" })
    const foreign = await write("foreign-holder.bin", "x", { limits: limits(), pidAlive: () => false })
    expect(foreign).toEqual({ ok: false, error: "disk", detail: LOCK_BUSY_DETAIL })

    writeFileSync(lock, "{ malformed lock")
    utimesSync(lock, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"))
    const malformed = await write("malformed-holder.bin", "x", { limits: limits(), pidAlive: () => false })
    expect(malformed).toEqual({ ok: false, error: "disk", detail: LOCK_BUSY_DETAIL })
    expect(stagingResidue()).toEqual([])
  })

  test("crashed reservation lock is reclaimed and orphan staging bytes do not leak quota", async () => {
    const orphanTarget = target("orphan.bin")
    writeFileSync(uniquePartPath(orphanTarget), "stale bytes larger than the whole quota")
    const lock = writeProjectLock({ pid: 999_999, nonce: "crashed-reservation" })
    expect(lock).toBe(join(projectDir, ".alpha", ARTIFACT_QUOTA_LOCK_FILE))

    const result = await write("recovered.bin", "x", {
      limits: limits({ runMaxBytes: 1, projectMaxBytes: 1 }),
      now: () => new Date("2026-07-20T12:00:01.000Z"),
      pidAlive: () => false,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(target("recovered.bin"))).toBe(true)
    expect(existsSync(lock)).toBe(false)
    expect(readdirSync(join(projectDir, ".alpha", "artifact-quota-stale"))).toHaveLength(1)
  })

  test("two Bun processes reclaiming one dead lock allow only one takeover", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const deadPid = 999_999
    const lock = writeProjectLock({ pid: deadPid, nonce: "dead-before-race" })
    const names: [string, string] = ["stale-racer-a.bin", "stale-racer-b.bin"]
    const results = await runConcurrentFinalizers(names, limits({ runMaxBytes: 5, projectMaxBytes: 5 }), deadPid)

    expectSingleAdmission(results, names)
    expect(existsSync(lock)).toBe(false)
    expect(readdirSync(join(projectDir, ".alpha", "artifact-quota-stale"))).toHaveLength(1)
  }, 15_000)

  test("over-limit error is visible but omits paths and hostile metadata", async () => {
    writeFileSync(target("existing.bin"), "1234567890")
    const result = await write(`${SECRET}.bin`, "x", { limits: limits() })
    expect(result).toMatchObject({ ok: false, error: "over-limit" })
    if (result.ok) return
    expect(result.detail).toBe("artifact quota exceeded (run bytes: next 11, limit 10)")
    expect(result.detail).not.toContain(projectDir)
    expect(result.detail).not.toContain(SECRET)
    expect(result.detail.toLowerCase()).not.toContain("bearer")
    expect(stagingResidue()).toEqual([])
  })
})
