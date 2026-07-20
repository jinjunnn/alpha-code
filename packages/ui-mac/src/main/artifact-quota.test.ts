// REQ-093/#279 —— run/project artifact quota 原子准入。真实 temp project + 真实
// `.part → fsync → project lock 内核算/rename`:正反例、末余额并发、崩溃锁/孤儿 staging 恢复、脱敏错误面。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostname, tmpdir } from "node:os"
import { uniquePartPath, writeChunksChecked } from "./alpha-artifact-download"
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

  test("two concurrent writers racing for the final byte admit exactly one", async () => {
    writeFileSync(target("existing.bin"), "1234")
    const quota = { limits: limits({ runMaxBytes: 5, projectMaxBytes: 5 }) }
    const results = await Promise.all([write("racer-a.bin", "a", quota), write("racer-b.bin", "b", quota)])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.error === "over-limit")).toHaveLength(1)
    expect([existsSync(target("racer-a.bin")), existsSync(target("racer-b.bin"))].filter(Boolean)).toHaveLength(1)
    expect(stagingResidue()).toEqual([])
  })

  test("crashed reservation lock is reclaimed and orphan staging bytes do not leak quota", async () => {
    const orphanTarget = target("orphan.bin")
    writeFileSync(uniquePartPath(orphanTarget), "stale bytes larger than the whole quota")
    const lock = artifactQuotaLockPath(projectDir)
    expect(lock).toBe(join(projectDir, ".alpha", ARTIFACT_QUOTA_LOCK_FILE))
    writeFileSync(
      lock!,
      JSON.stringify({
        v: 1,
        pid: 999_999,
        hostname: hostname(),
        nonce: "crashed-reservation",
        acquiredAt: "2026-07-20T12:00:00.000Z",
      }),
    )

    const result = await write("recovered.bin", "x", {
      limits: limits({ runMaxBytes: 1, projectMaxBytes: 1 }),
      now: () => new Date("2026-07-20T12:00:01.000Z"),
      pidAlive: () => false,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(target("recovered.bin"))).toBe(true)
    expect(existsSync(lock!)).toBe(false)
    expect(readdirSync(join(projectDir, ".alpha", "artifact-quota-stale"))).toHaveLength(1)
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
    expect(stagingResidue()).toEqual([])
  })
})
