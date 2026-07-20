// REQ-093/#279 —— run/project artifact quota 预约准入。真实 temp project + 真实
// `.part → fsync → reservation scan/decision → final rename`:末余额多进程、崩溃预约与脱敏错误面。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { uniquePartPath, writeChunksChecked, type ArtifactDownloadOutcome } from "./alpha-artifact-download"
import {
  artifactQuotaReservationsPath,
  ARTIFACT_QUOTA_MACHINE_ID_FILE,
  finalizeArtifactWithQuota,
  initializeArtifactQuotaEnvironment,
  type ArtifactQuotaFinalizeOptions,
  type ArtifactQuotaLimits,
} from "./artifact-service"

const RUN = "job-quota"
const OTHER_RUN = "job-other"
const SECRET = "Bearer-TOKEN-MARKER-req093"
const YIELDED_DETAIL = "artifact quota admission yielded to an earlier reservation"
const RACE_ROUNDS = Number(process.env.ARTIFACT_QUOTA_STRESS_ROUNDS ?? "1")
if (!Number.isSafeInteger(RACE_ROUNDS) || RACE_ROUNDS <= 0)
  throw new Error("ARTIFACT_QUOTA_STRESS_ROUNDS must be a positive integer")
const RACE_TEST_TIMEOUT = Math.max(20_000, RACE_ROUNDS * 1_000)
const RACE_STARTED_AT = Date.parse("2026-07-20T12:00:00.000Z")

let projectDir: string
let reservationCounter: number
let machineId: string
const artifactsDir = (runId = RUN) => join(projectDir, ".alpha", "runs", runId, "artifacts")
const target = (name: string) => join(artifactsDir(), name)

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "artifact-quota-")))
  reservationCounter = 100
  mkdirSync(artifactsDir(), { recursive: true })
  const initialized = await initializeArtifactQuotaEnvironment(projectDir, { volumeIsLocal: async () => true })
  if (!initialized.ok) throw new Error(`test setup: artifact quota initialization failed (${initialized.error})`)
  machineId = readFileSync(join(projectDir, ARTIFACT_QUOTA_MACHINE_ID_FILE), "utf8").trim()
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

function reservations(runId = RUN): string[] {
  const dir = artifactQuotaReservationsPath(projectDir, runId)
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
}

function seedReservation(
  over: Partial<{ pid: number; machineId: string; declaredBytes: number; startedAt: string; uuid: string }> = {},
  runId = RUN,
): string {
  const dir = artifactQuotaReservationsPath(projectDir, runId)
  if (!dir) throw new Error("test setup: reservation path unavailable")
  mkdirSync(dir, { recursive: true })
  const uuid = `00000000-0000-4000-8000-${String(reservationCounter++).padStart(12, "0")}`
  const record = {
    pid: process.pid,
    machineId,
    declaredBytes: 1,
    startedAt: String(RACE_STARTED_AT * 1_000),
    uuid,
    ...over,
  }
  const file = join(dir, `${record.startedAt}-${record.uuid}.json`)
  writeFileSync(file, JSON.stringify(record) + "\n", { flag: "wx" })
  return file
}

type ChildFinalizeResult = { name: string; result: ArtifactDownloadOutcome }

async function waitForBarrier(
  barrierDir: string,
  marker: string,
  deadline: number,
  children: Bun.Subprocess<"ignore", "pipe", "pipe">[],
) {
  while (!existsSync(join(barrierDir, marker)) && Date.now() < deadline) await Bun.sleep(5)
  if (existsSync(join(barrierDir, marker))) return
  children.forEach((child) => child.kill())
  throw new Error(`artifact quota barrier failed (${marker})`)
}

async function runConcurrentFinalizers(names: string[], quota: ArtifactQuotaLimits, scenario: "race" | "ordered") {
  const barrierDir = mkdtempSync(join(projectDir, "artifact-quota-barrier-"))
  const helper = join(import.meta.dir, "artifact-quota-child.ts")
  const deadline = Date.now() + 10_000
  const children = names.map((name, index) =>
    Bun.spawn(
      [
        process.execPath,
        helper,
        projectDir,
        RUN,
        name,
        "x",
        barrierDir,
        index.toString(),
        JSON.stringify(quota),
        deadline.toString(),
        RACE_STARTED_AT.toString(),
        scenario,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ),
  )

  await Promise.all(names.map((_, index) => waitForBarrier(barrierDir, `reserved-${index}`, deadline, children)))
  if (scenario === "race") {
    writeFileSync(join(barrierDir, "scan"), "scan\n", { flag: "wx" })
    await Promise.all(
      names.map(async (_, index) => {
        while (
          !existsSync(join(barrierDir, `scanned-${index}`)) &&
          !existsSync(join(barrierDir, `done-${index}`)) &&
          Date.now() < deadline
        )
          await Bun.sleep(5)
        if (existsSync(join(barrierDir, `scanned-${index}`)) || existsSync(join(barrierDir, `done-${index}`))) return
        children.forEach((child) => child.kill())
        throw new Error(`artifact quota decision barrier failed (${index})`)
      }),
    )
  }
  if (scenario === "ordered") {
    writeFileSync(join(barrierDir, "scan-0"), "scan\n", { flag: "wx" })
    await waitForBarrier(barrierDir, "scanned-0", deadline, children)
    for (const index of names
      .slice(1)
      .map((_, offset) => offset + 1)
      .reverse()) {
      writeFileSync(join(barrierDir, `scan-${index}`), "scan\n", { flag: "wx" })
      await waitForBarrier(barrierDir, `done-${index}`, deadline, children)
    }
  }

  // 证伪屏障固定在“扫描+准入判定完成”之后、“final rename”之前。
  expect(names.some((name) => existsSync(target(name)))).toBe(false)
  expect(readFileSync(join(barrierDir, "reserved-0"), "utf8").trim()).toContain("reservations")
  writeFileSync(join(barrierDir, "commit"), "commit\n", { flag: "wx" })

  const killTimer = setTimeout(() => children.forEach((child) => child.kill()), Math.max(1, deadline - Date.now()))
  const [codes, stdout, stderr] = await Promise.all([
    Promise.all(children.map((child) => child.exited)),
    Promise.all(children.map((child) => new Response(child.stdout).text())),
    Promise.all(children.map((child) => new Response(child.stderr).text())),
  ])
  clearTimeout(killTimer)
  rmSync(barrierDir, { recursive: true, force: true })
  if (codes.some((code) => code !== 0))
    throw new Error(`artifact quota child failed (${codes.join(", ")}): ${stderr.join(" | ")}`)
  return stdout.map((output) => JSON.parse(output) as ChildFinalizeResult)
}

async function runLateLowerKeyFinalizers(names: [string, string], quota: ArtifactQuotaLimits) {
  const barrierDir = mkdtempSync(join(projectDir, "artifact-quota-late-lower-"))
  const helper = join(import.meta.dir, "artifact-quota-child.ts")
  const deadline = Date.now() + 10_000
  const spawn = (name: string, index: number) =>
    Bun.spawn(
      [
        process.execPath,
        helper,
        projectDir,
        RUN,
        name,
        "x",
        barrierDir,
        index.toString(),
        JSON.stringify(quota),
        deadline.toString(),
        RACE_STARTED_AT.toString(),
        "ordered",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
  const greater = spawn(names[1], 1)
  const children = [greater]
  await waitForBarrier(barrierDir, "reserved-1", deadline, children)
  writeFileSync(join(barrierDir, "scan-1"), "scan\n", { flag: "wx" })
  await waitForBarrier(barrierDir, "scanned-1", deadline, children)

  const lower = spawn(names[0], 0)
  children.push(lower)
  await waitForBarrier(barrierDir, "reserved-0", deadline, children)
  writeFileSync(join(barrierDir, "scan-0"), "scan\n", { flag: "wx" })
  await waitForBarrier(barrierDir, "scanned-0", deadline, children)
  expect(names.some((name) => existsSync(target(name)))).toBe(false)
  writeFileSync(join(barrierDir, "commit"), "commit\n", { flag: "wx" })

  const killTimer = setTimeout(() => children.forEach((child) => child.kill()), Math.max(1, deadline - Date.now()))
  const [codes, stdout, stderr] = await Promise.all([
    Promise.all(children.map((child) => child.exited)),
    Promise.all(children.map((child) => new Response(child.stdout).text())),
    Promise.all(children.map((child) => new Response(child.stderr).text())),
  ])
  clearTimeout(killTimer)
  rmSync(barrierDir, { recursive: true, force: true })
  if (codes.some((code) => code !== 0))
    throw new Error(`artifact quota late-lower child failed (${codes.join(", ")}): ${stderr.join(" | ")}`)
  return stdout.map((output) => JSON.parse(output) as ChildFinalizeResult)
}

function expectMinimumOnly(results: ChildFinalizeResult[], names: string[]) {
  expect(
    results.find((entry) => entry.name === names[0])?.result.ok,
    `minimum reservation failed: ${JSON.stringify(results)}`,
  ).toBe(true)
  results
    .filter((entry) => entry.name !== names[0])
    .forEach((entry) => expect(entry.result).toEqual({ ok: false, error: "over-limit", detail: YIELDED_DETAIL }))
  expect(names.map((name) => existsSync(target(name))).filter(Boolean)).toHaveLength(1)
  expect(reservations()).toEqual([])
  expect(stagingResidue()).toEqual([])
}

describe("finalizeArtifactWithQuota", () => {
  test("machine identity persists in userData and the real local temp volume is accepted", async () => {
    const initialized = await initializeArtifactQuotaEnvironment(projectDir)

    expect(initialized).toEqual({ ok: true })
    expect(readFileSync(join(projectDir, ARTIFACT_QUOTA_MACHINE_ID_FILE), "utf8").trim()).toBe(machineId)
  })

  test("production mount parsing accepts only the APFS and HFS local-type whitelist", async () => {
    for (const fileSystemType of ["apfs", "hfs"]) {
      const initialized = await initializeArtifactQuotaEnvironment(projectDir, {
        testHooks: {
          mountTable: async () => `/dev/disk-test on ${projectDir} (${fileSystemType}, journaled)\n`,
        },
      })

      expect(initialized).toEqual({ ok: true })
    }
  })

  test("production mount parsing rejects FUSE and network types even when they claim local", async () => {
    for (const fileSystemType of ["macfuse", "osxfuse", "fuse.sshfs", "nfs", "smbfs", "afpfs", "webdav"]) {
      const initialized = await initializeArtifactQuotaEnvironment(projectDir, {
        testHooks: {
          mountTable: async () =>
            `/dev/disk-root on / (apfs, local)\nremote on ${projectDir} (${fileSystemType}, local, automounted)\n`,
        },
      })

      expect(initialized).toEqual({
        ok: false,
        error: "unsupported-filesystem",
        detail: "artifact quota requires a local filesystem",
      })
    }
  })

  test("production mount parsing rejects an unknown type at the owning mount point", async () => {
    const initialized = await initializeArtifactQuotaEnvironment(projectDir, {
      testHooks: {
        mountTable: async () =>
          `/dev/disk-root on / (apfs, local)\nunknown on ${projectDir} (futurefs, local, journaled)\n`,
      },
    })

    expect(initialized).toEqual({
      ok: false,
      error: "unsupported-filesystem",
      detail: "artifact quota requires a local filesystem",
    })
  })

  test("mount command failure and timeout fail closed with the stable disk error", async () => {
    const failed = await initializeArtifactQuotaEnvironment(projectDir, {
      testHooks: { mountTable: async () => null },
    })
    expect(failed).toEqual({
      ok: false,
      error: "disk",
      detail: "artifact quota admission unavailable (filesystem locality unavailable)",
    })

    const timedOut = await initializeArtifactQuotaEnvironment(projectDir, {
      testHooks: {
        mountTable: () => new Promise(() => {}),
        volumeDetectionTimeoutMs: 5,
      },
    })
    expect(timedOut).toEqual({
      ok: false,
      error: "disk",
      detail: "artifact quota admission unavailable (filesystem locality unavailable)",
    })
  })

  test("under both run and project limits admits before final rename and removes its reservation", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const result = await write("admitted.bin", "12345", { limits: limits() })

    expect(result.ok).toBe(true)
    expect(readFileSync(target("admitted.bin"), "utf8")).toBe("12345")
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("replacement admission never subtracts a pre-scan target snapshot", async () => {
    writeFileSync(target("replace.bin"), "12345")
    writeFileSync(target("other.bin"), "12345")
    const result = await write("replace.bin", "x", { limits: limits({ runMaxCount: 10 }) })

    expect(result).toEqual({
      ok: false,
      error: "over-limit",
      detail: "artifact quota exceeded (run bytes: next 11, limit 10)",
    })
    expect(readFileSync(target("replace.bin"), "utf8")).toBe("12345")
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("run byte and count limits fail closed with no final file, reservation, or staging residue", async () => {
    writeFileSync(target("existing.bin"), "12345678")
    const bytes = await write("run-bytes.bin", "123", { limits: limits() })
    expect(bytes).toMatchObject({ ok: false, error: "over-limit" })
    expect(String((bytes as { detail?: string }).detail)).toContain("run bytes")

    const count = await write("run-count.bin", "1", { limits: limits({ runMaxBytes: 100, runMaxCount: 1 }) })
    expect(count).toMatchObject({ ok: false, error: "over-limit" })
    expect(String((count as { detail?: string }).detail)).toContain("run artifact count")
    expect(existsSync(target("run-bytes.bin"))).toBe(false)
    expect(existsSync(target("run-count.bin"))).toBe(false)
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("project limit includes committed bytes and reservations from other runs", async () => {
    mkdirSync(artifactsDir(OTHER_RUN), { recursive: true })
    writeFileSync(join(artifactsDir(OTHER_RUN), "other.bin"), "12345678")
    seedReservation({ declaredBytes: 1 }, OTHER_RUN)
    const result = await write("project.bin", "12", {
      limits: limits({ runMaxBytes: 100, projectMaxBytes: 10 }),
      now: () => new Date(RACE_STARTED_AT + 1_000),
      pidAlive: () => true,
    })

    expect(result).toEqual({ ok: false, error: "over-limit", detail: YIELDED_DETAIL })
    expect(existsSync(target("project.bin"))).toBe(false)
    expect(reservations(OTHER_RUN)).toHaveLength(1)
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test(
    "two Bun processes racing for the final byte admit exactly the minimum key",
    async () => {
      writeFileSync(target("existing.bin"), "1234")
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const names = [`racer-a-${round}.bin`, `racer-b-${round}.bin`]
        const results = await runConcurrentFinalizers(names, limits({ runMaxBytes: 5, projectMaxBytes: 5 }), "race")

        expectMinimumOnly(results, names)
        names.forEach((name) => rmSync(target(name), { force: true }))
      }
    },
    RACE_TEST_TIMEOUT,
  )

  test(
    "three-process interleaving admits no pair and the minimum key progresses",
    async () => {
      writeFileSync(target("existing.bin"), "1234")
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const names = [`triple-a-${round}.bin`, `triple-b-${round}.bin`, `triple-c-${round}.bin`]
        const results = await runConcurrentFinalizers(names, limits({ runMaxBytes: 5, projectMaxBytes: 5 }), "ordered")

        expectMinimumOnly(results, names)
        names.forEach((name) => rmSync(target(name), { force: true }))
      }
    },
    RACE_TEST_TIMEOUT,
  )

  test("a lower key published after a greater key's decision cannot double-admit", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const names: [string, string] = ["late-lower.bin", "already-decided.bin"]
    const results = await runLateLowerKeyFinalizers(names, limits({ runMaxBytes: 5, projectMaxBytes: 5 }))

    expect(results.find((entry) => entry.name === names[1])?.result.ok).toBe(true)
    expect(results.find((entry) => entry.name === names[0])?.result).toEqual({
      ok: false,
      error: "over-limit",
      detail: "artifact quota exceeded (run bytes: next 6, limit 5)",
    })
    expect(names.map((name) => existsSync(target(name)))).toEqual([false, true])
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("a crashed reservation stays conservatively charged until same-machine PID death is conclusive", async () => {
    writeFileSync(target("existing.bin"), "1234")
    writeFileSync(uniquePartPath(target("orphan.bin")), "orphan staging is excluded")
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    const stale = seedReservation({ pid: owner.pid })

    const live = await write("live-owner.bin", "x", {
      limits: limits({ runMaxBytes: 5, projectMaxBytes: 5 }),
      now: () => new Date(RACE_STARTED_AT + 1_000),
    })
    expect(live).toEqual({ ok: false, error: "over-limit", detail: YIELDED_DETAIL })
    expect(existsSync(stale)).toBe(true)

    owner.kill()
    await owner.exited
    const indeterminate = await write("unknown-owner.bin", "x", {
      limits: limits({ runMaxBytes: 5, projectMaxBytes: 5 }),
      now: () => new Date(RACE_STARTED_AT + 2_000),
      pidAlive: () => undefined,
    })
    expect(indeterminate).toEqual({ ok: false, error: "over-limit", detail: YIELDED_DETAIL })
    expect(existsSync(stale)).toBe(true)

    const cleaned = await write("dead-owner.bin", "x", {
      limits: limits({ runMaxBytes: 5, projectMaxBytes: 5 }),
      now: () => new Date(RACE_STARTED_AT + 3_000),
    })
    expect(cleaned).toEqual({ ok: false, error: "over-limit", detail: YIELDED_DETAIL })
    expect(existsSync(stale)).toBe(false)
    const retried = await write("dead-owner.bin", "x", {
      limits: limits({ runMaxBytes: 5, projectMaxBytes: 5 }),
      now: () => new Date(RACE_STARTED_AT + 4_000),
    })
    expect(retried.ok).toBe(true)
    expect(existsSync(target("dead-owner.bin"))).toBe(true)
    expect(reservations()).toEqual([])
  })

  test("foreign-machine reservations are never cleaned even when their PID probe says dead", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const foreign = seedReservation({
      pid: 999_999,
      machineId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    })
    const result = await write("foreign-owner.bin", "x", {
      limits: limits({ runMaxBytes: 5, projectMaxBytes: 5 }),
      now: () => new Date(RACE_STARTED_AT + 1_000),
      pidAlive: () => false,
    })

    expect(result).toEqual({ ok: false, error: "over-limit", detail: YIELDED_DETAIL })
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(target("foreign-owner.bin"))).toBe(false)
  })

  test("mistaken peer cleanup is harmless because the owner rechecks its reservation before rename", async () => {
    let scanned!: () => void
    let resume!: () => void
    const reachedScan = new Promise<void>((resolve) => (scanned = resolve))
    const resumeCommit = new Promise<void>((resolve) => (resume = resolve))
    const victim = write("victim.bin", "v", {
      limits: limits({ runMaxBytes: 100, projectMaxBytes: 100 }),
      now: () => new Date(RACE_STARTED_AT),
      testHooks: {
        async afterQuotaScan() {
          scanned()
          await resumeCommit
        },
      },
    })
    await reachedScan

    const cleaner = await write("cleaner.bin", "c", {
      limits: limits({ runMaxBytes: 100, projectMaxBytes: 100 }),
      now: () => new Date(RACE_STARTED_AT + 1_000),
      pidAlive: () => false,
    })
    expect(cleaner.ok).toBe(true)
    resume()
    const result = await victim

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (own reservation changed)",
    })
    expect(existsSync(target("victim.bin"))).toBe(false)
    expect(existsSync(target("cleaner.bin"))).toBe(true)
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("reservation content drift is retryable and the changed path is not unlinked as owned", async () => {
    let reservationFile = ""
    const result = await write("changed-reservation.bin", "x", {
      limits: limits(),
      testHooks: {
        afterReservationCreated(file) {
          reservationFile = file
        },
        afterQuotaScan() {
          appendFileSync(reservationFile, " ")
        },
      },
    })

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (own reservation changed)",
    })
    expect(existsSync(reservationFile)).toBe(true)
    expect(existsSync(target("changed-reservation.bin"))).toBe(false)
    expect(stagingResidue()).toEqual([])
  })

  test("staged growth after reservation is rejected at the rename boundary", async () => {
    const result = await write("growing.bin", "x", {
      limits: limits(),
      testHooks: {
        afterQuotaScan() {
          const [part] = stagingResidue()
          if (!part) throw new Error("test setup: staged file missing")
          appendFileSync(join(artifactsDir(), part), "growth")
        },
      },
    })

    expect(result).toEqual({
      ok: false,
      error: "staging-changed",
      detail: "artifact staging identity or byte count changed",
    })
    expect(existsSync(target("growing.bin"))).toBe(false)
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("same-sized staged inode replacement is rejected at the rename boundary", async () => {
    const result = await write("replaced-stage.bin", "x", {
      limits: limits(),
      testHooks: {
        afterQuotaScan() {
          const [part] = stagingResidue()
          if (!part) throw new Error("test setup: staged file missing")
          const staged = join(artifactsDir(), part)
          const replacement = `${staged}.replacement`
          writeFileSync(replacement, "y")
          renameSync(replacement, staged)
        },
      },
    })

    expect(result).toEqual({
      ok: false,
      error: "staging-changed",
      detail: "artifact staging identity or byte count changed",
    })
    expect(existsSync(target("replaced-stage.bin"))).toBe(false)
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("non-local artifact volumes fail closed with a stable error code", async () => {
    const initialized = await initializeArtifactQuotaEnvironment(projectDir, {
      volumeIsLocal: async (root) => !root.includes(`${join(".alpha", "runs")}`),
    })
    expect(initialized.ok).toBe(true)
    const result = await write("remote.bin", "x", { limits: limits() })

    expect(result).toEqual({
      ok: false,
      error: "unsupported-filesystem",
      detail: "artifact quota requires a local filesystem",
    })
    expect(existsSync(target("remote.bin"))).toBe(false)
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })

  test("reservation convergence has deadline and round bounds without blocking the event loop", async () => {
    seedReservation({
      declaredBytes: 1,
      startedAt: String((RACE_STARTED_AT + 1_000) * 1_000),
    })
    let timerFired = false
    setTimeout(() => (timerFired = true), 0)
    const result = await write("bounded-wait.bin", "x", {
      limits: limits({ runMaxBytes: 1, projectMaxBytes: 1 }),
      now: () => new Date(RACE_STARTED_AT),
      pidAlive: () => true,
      testHooks: { waitPolicy: { deadlineMs: 100, maxRounds: 3, intervalMs: 5 } },
    })

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (reservation convergence round limit reached)",
    })
    expect(timerFired).toBe(true)
    expect(existsSync(target("bounded-wait.bin"))).toBe(false)
    expect(reservations()).toHaveLength(1)
    expect(stagingResidue()).toEqual([])
  })

  test("reservation convergence deadline returns the stable retryable error", async () => {
    seedReservation({
      declaredBytes: 1,
      startedAt: String((RACE_STARTED_AT + 1_000) * 1_000),
    })
    const result = await write("deadline.bin", "x", {
      limits: limits({ runMaxBytes: 1, projectMaxBytes: 1 }),
      now: () => new Date(RACE_STARTED_AT),
      pidAlive: () => true,
      testHooks: { waitPolicy: { deadlineMs: 8, maxRounds: 250, intervalMs: 5 } },
    })

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (reservation convergence timed out)",
    })
    expect(existsSync(target("deadline.bin"))).toBe(false)
    expect(reservations()).toHaveLength(1)
    expect(stagingResidue()).toEqual([])
  })

  test("a slow wait scan obeys the global deadline while the event loop keeps turning", async () => {
    Array.from({ length: 48 }, (_, index) => writeFileSync(target(`slow-${index}.bin`), "x"))
    seedReservation({
      declaredBytes: 1,
      startedAt: String((RACE_STARTED_AT + 1_000) * 1_000),
    })
    let slowScan = false
    let eventLoopTicks = 0
    let yieldedChunks = 0
    const ticker = setInterval(() => (eventLoopTicks += 1), 1)
    const startedAt = Date.now()
    const result = await write("slow-deadline.bin", "x", {
      limits: limits({ runMaxBytes: 49, runMaxCount: 100, projectMaxBytes: 49 }),
      now: () => new Date(RACE_STARTED_AT),
      pidAlive: () => true,
      testHooks: {
        afterQuotaScan() {
          slowScan = true
        },
        waitPolicy: { deadlineMs: 20, maxRounds: 250, intervalMs: 1 },
        scanPolicy: { timeoutMs: 100, maxEntries: 1_000, yieldEvery: 1 },
        async beforeScanEntry() {
          if (slowScan) await Bun.sleep(2)
        },
        afterScanYield() {
          if (slowScan) yieldedChunks += 1
        },
      },
    })
    clearInterval(ticker)

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (reservation convergence timed out)",
    })
    expect(Date.now() - startedAt).toBeLessThan(150)
    expect(eventLoopTicks).toBeGreaterThan(0)
    expect(yieldedChunks).toBeGreaterThan(0)
    expect(existsSync(target("slow-deadline.bin"))).toBe(false)
    expect(reservations()).toHaveLength(1)
    expect(stagingResidue()).toEqual([])
  })

  test("an individual wait scan timeout returns the stable retryable error before the global deadline", async () => {
    Array.from({ length: 24 }, (_, index) => writeFileSync(target(`scan-timeout-${index}.bin`), "x"))
    seedReservation({
      declaredBytes: 1,
      startedAt: String((RACE_STARTED_AT + 1_000) * 1_000),
    })
    let slowScan = false
    const result = await write("scan-timeout.bin", "x", {
      limits: limits({ runMaxBytes: 25, runMaxCount: 100, projectMaxBytes: 25 }),
      now: () => new Date(RACE_STARTED_AT),
      pidAlive: () => true,
      testHooks: {
        afterQuotaScan() {
          slowScan = true
        },
        waitPolicy: { deadlineMs: 100, maxRounds: 250, intervalMs: 1 },
        scanPolicy: { timeoutMs: 10, maxEntries: 1_000, yieldEvery: 1 },
        async beforeScanEntry() {
          if (slowScan) await Bun.sleep(3)
        },
      },
    })

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (quota scan timed out)",
    })
    expect(existsSync(target("scan-timeout.bin"))).toBe(false)
    expect(reservations()).toHaveLength(1)
    expect(stagingResidue()).toEqual([])
  })

  test("a wait scan entry cap returns the stable retryable error", async () => {
    seedReservation({
      declaredBytes: 1,
      startedAt: String((RACE_STARTED_AT + 1_000) * 1_000),
    })
    const result = await write("scan-entry-cap.bin", "x", {
      limits: limits({ runMaxBytes: 1, projectMaxBytes: 1 }),
      now: () => new Date(RACE_STARTED_AT),
      pidAlive: () => true,
      testHooks: {
        afterQuotaScan() {
          Array.from({ length: 8 }, (_, index) => writeFileSync(target(`late-${index}.bin`), "x"))
        },
        waitPolicy: { deadlineMs: 100, maxRounds: 250, intervalMs: 1 },
        scanPolicy: { timeoutMs: 100, maxEntries: 5, yieldEvery: 1 },
      },
    })

    expect(result).toEqual({
      ok: false,
      error: "retryable",
      detail: "artifact quota admission retry required (quota scan entry limit reached)",
    })
    expect(existsSync(target("scan-entry-cap.bin"))).toBe(false)
    expect(reservations()).toHaveLength(1)
    expect(stagingResidue()).toEqual([])
  })

  test("malformed reservations fail closed and are not mutated", async () => {
    const dir = artifactQuotaReservationsPath(projectDir, RUN)
    if (!dir) throw new Error("test setup: reservation path unavailable")
    mkdirSync(dir, { recursive: true })
    const malformed = join(dir, "0000000000000000-00000000-0000-4000-8000-000000000999.json")
    writeFileSync(malformed, "{ malformed reservation")
    const result = await write("malformed.bin", "x", { limits: limits() })

    expect(result).toEqual({
      ok: false,
      error: "disk",
      detail: "artifact quota admission unavailable (committed usage unavailable)",
    })
    expect(readFileSync(malformed, "utf8")).toBe("{ malformed reservation")
    expect(existsSync(target("malformed.bin"))).toBe(false)
    expect(reservations()).toEqual([malformed.split("/").at(-1)!])
    expect(stagingResidue()).toEqual([])
  })

  test("over-limit error is visible but omits paths and hostile metadata", async () => {
    writeFileSync(target("existing.bin"), "1234567890")
    const result = await write(`${SECRET}.bin`, "x", { limits: limits() })
    expect(result).toMatchObject({ ok: false, error: "over-limit" })
    if (result.ok) return
    expect(result.detail).toBe("artifact quota exceeded (run bytes: next 11, limit 10)")
    expect(result.detail).not.toContain(projectDir)
    expect(result.detail).not.toContain(SECRET)
    expect(result.detail.toLowerCase()).not.toContain("bearer")
    expect(reservations()).toEqual([])
    expect(stagingResidue()).toEqual([])
  })
})
