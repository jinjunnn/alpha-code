import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { CasGcRoundInput, CasGcRoundSummary } from "./ext-cas-gc"
import type { CasGcSchedulerConfig } from "./ext-cas-gc-scheduler"
import { createExtensionStorageAdapter, createSettingsAdapter } from "./settings-adapters"
import { ALPHA_SETTINGS_DEFAULTS, type AlphaSettings } from "../shared/settings-adapters"
import { RENDERER_SETTINGS_KEY } from "./store-keys"

const settings = (): AlphaSettings => structuredClone(ALPHA_SETTINGS_DEFAULTS)
const childModule = new URL("./settings-adapters.ts", import.meta.url).href
const childSource = `
const { createSettingsAdapter } = await import(${JSON.stringify(childModule)})
const file = process.env.REQ090_SETTINGS_FILE
const mode = process.env.REQ090_SETTINGS_MODE
if (!file || !mode) throw new Error("missing child input")
const adapter = createSettingsAdapter(file, {
  onCommitPoint(point) {
    if (point === process.env.REQ090_CRASH_POINT) process.kill(process.pid, "SIGKILL")
  },
})
if (mode === "read") console.log(JSON.stringify(adapter.read()))
if (mode === "write") {
  const value = JSON.parse(process.env.REQ090_SETTINGS_VALUE ?? "null")
  console.log(JSON.stringify(adapter.write({ value, expectedRevision: process.env.REQ090_SETTINGS_REVISION })))
}
`

function runSettingsChild(
  file: string,
  mode: "read" | "write",
  input?: { value: AlphaSettings; revision: string; crashPoint?: "file-synced" | "renamed" },
) {
  return Bun.spawnSync({
    cmd: [process.execPath, "--eval", childSource],
    env: {
      ...process.env,
      REQ090_SETTINGS_FILE: file,
      REQ090_SETTINGS_MODE: mode,
      ...(input
        ? {
            REQ090_SETTINGS_VALUE: JSON.stringify(input.value),
            REQ090_SETTINGS_REVISION: input.revision,
            ...(input.crashPoint ? { REQ090_CRASH_POINT: input.crashPoint } : {}),
          }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function readInChild(file: string) {
  const child = runSettingsChild(file, "read")
  expect(child.exitCode).toBe(0)
  expect(new TextDecoder().decode(child.stderr)).toBe("")
  return JSON.parse(new TextDecoder().decode(child.stdout)) as ReturnType<ReturnType<typeof createSettingsAdapter>["read"]>
}

function writeAuthority(file: string, raw: unknown, extra: Record<string, unknown> = {}) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...extra, [RENDERER_SETTINGS_KEY]: raw }, null, "\t"))
}

function readDocument(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

describe("Settings typed adapter", () => {
  let userData: string
  let file: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "req090-settings-"))
    file = join(userData, "default.dat")
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  test("read returns defaults for an empty authority and normalizes the existing partial alpha seed", () => {
    const empty = createSettingsAdapter(file).read()
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.value).toEqual(ALPHA_SETTINGS_DEFAULTS)

    writeAuthority(file, JSON.stringify({ general: { newLayoutDesigns: true, showCustomAgents: true } }))
    const seeded = createSettingsAdapter(file).read()
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    expect(seeded.value.general.newLayoutDesigns).toBe(true)
    expect(seeded.value.general.showCustomAgents).toBe(true)
    expect(seeded.value.appearance.fontSize).toBe(14)
  })

  test("validate accepts the complete schema and rejects wrong types, unknown fields and unsafe keybind keys", () => {
    const adapter = createSettingsAdapter(file)
    expect(adapter.validate(settings())).toEqual({ ok: true })
    expect(adapter.validate({ ...settings(), appearance: { ...settings().appearance, fontSize: "14" } })).toEqual({
      ok: false,
      code: "invalid-input",
    })
    expect(adapter.validate({ ...settings(), secret: "must-not-become-a-setting" })).toEqual({
      ok: false,
      code: "invalid-input",
    })
    expect(adapter.validate({ ...settings(), keybinds: { constructor: "cmd+k" } })).toEqual({
      ok: false,
      code: "invalid-input",
    })
  })

  test("save is durable before success and a child process reopens the authoritative value", () => {
    writeAuthority(file, undefined, { unrelated: { preserved: true } })
    const first = createSettingsAdapter(file)
    const read = first.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.notifications.errors = true
    const saved = first.write({ value: next, expectedRevision: read.revision })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.changed).toBe(true)
    expect(readDocument(file).unrelated).toEqual({ preserved: true })

    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (restarted.ok) {
      expect(restarted.value.notifications.errors).toBe(true)
      expect(restarted.revision).toBe(saved.revision)
    }
  })

  test("an exact repeated submission is idempotent even with the original revision", () => {
    let commits = 0
    const adapter = createSettingsAdapter(file, {
      onCommitPoint: (point) => {
        if (point === "file-synced") commits++
      },
    })
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.general.showSearch = true
    const first = adapter.write({ value: next, expectedRevision: read.revision })
    const replay = adapter.write({ value: next, expectedRevision: read.revision })
    expect(first.ok).toBe(true)
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.changed).toBe(false)
    expect(commits).toBe(1)
  })

  test("a stale conflicting submission is refused with the current authoritative value", () => {
    let commits = 0
    const adapter = createSettingsAdapter(file, {
      onCommitPoint: (point) => {
        if (point === "file-synced") commits++
      },
    })
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const first = settings()
    first.general.showStatus = true
    expect(adapter.write({ value: first, expectedRevision: read.revision }).ok).toBe(true)
    const conflicting = settings()
    conflicting.general.showFileTree = true
    const result = adapter.write({ value: conflicting, expectedRevision: read.revision })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("revision-conflict")
    expect(result.authoritative?.value.general.showStatus).toBe(true)
    expect(commits).toBe(1)
  })

  test("invalid input never writes", () => {
    const result = createSettingsAdapter(file).write({
      value: { ...settings(), notifications: { agent: true, permissions: true, errors: "yes" } },
      expectedRevision: "s1:" + "0".repeat(64),
    })
    expect(result).toEqual({ ok: false, code: "invalid-input" })
    expect(existsSync(file)).toBe(false)
  })

  test("a malformed write envelope returns only invalid-input", () => {
    expect(createSettingsAdapter(file).write(null)).toEqual({ ok: false, code: "invalid-input" })
    expect(
      createSettingsAdapter(file).write({
        value: settings(),
        expectedRevision: "s1:".padEnd(67, "0"),
        secret: "do-not-leak",
      }),
    ).toEqual({ ok: false, code: "invalid-input" })
    expect(existsSync(file)).toBe(false)
  })

  test("a real rename failure is fail-closed with the old restart authority and no direct-write fallback", () => {
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const old = settings()
    old.general.releaseNotes = false
    const initial = adapter.write({ value: old, expectedRevision: read.revision })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const next = settings()
    next.general.showTerminal = true
    const failing = createSettingsAdapter(file, {
      onCommitPoint: (point, temporaryFile) => {
        if (point !== "file-synced") return
        expect(dirname(temporaryFile)).toBe(dirname(file))
        unlinkSync(temporaryFile)
      },
    })
    const result = failing.write({ value: next, expectedRevision: initial.revision })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("write-failed")
    expect(result.authoritative?.value).toEqual(old)
    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (restarted.ok) expect(restarted.value).toEqual(old)
    expect(readDocument(file)[RENDERER_SETTINGS_KEY]).toBe(JSON.stringify(old))
  })

  test("a real parent-directory fsync failure after rename never reports success", () => {
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const old = settings()
    old.general.showStatus = true
    const initial = adapter.write({ value: old, expectedRevision: read.revision })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return

    const movedUserData = `${userData}-during-directory-fsync`
    const next = settings()
    next.general.showTerminal = true
    const failing = createSettingsAdapter(file, {
      onCommitPoint: (point) => {
        if (point === "renamed") renameSync(userData, movedUserData)
      },
    })
    const result = failing.write({ value: next, expectedRevision: initial.revision })
    renameSync(movedUserData, userData)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("write-failed")

    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (restarted.ok) expect(restarted.value).toEqual(next)
    expect(() => readDocument(file)).not.toThrow()
  })

  test.each([
    ["file-synced", "old"],
    ["renamed", "old-or-new"],
  ] as const)("crash at %s never reports success or leaves a corrupt authority", (crashPoint, expected) => {
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const old = settings()
    old.general.showStatus = true
    const initial = adapter.write({ value: old, expectedRevision: read.revision })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const next = settings()
    next.sounds.agentEnabled = false
    const child = runSettingsChild(file, "write", { value: next, revision: initial.revision, crashPoint })
    expect(child.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(child.stdout)).toBe("")

    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (!restarted.ok) return
    if (expected === "old") expect(restarted.value).toEqual(old)
    if (expected === "old-or-new") expect([old, next]).toContainEqual(restarted.value)
    expect(() => readDocument(file)).not.toThrow()
    readdirSync(userData)
      .filter((entry) => entry.includes(".tmp-"))
      .forEach((entry) => expect(() => JSON.parse(readFileSync(join(userData, entry), "utf8"))).not.toThrow())
  })

  test("an invalid authority can be repaired only with the revision returned by read", () => {
    writeAuthority(file, '{"general":{"showSearch":"/Users/alice/secret"}}')
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(false)
    if (read.ok || read.code !== "authority-invalid") return
    expect(JSON.stringify(read)).not.toContain("/Users/")
    const repaired = adapter.write({ value: settings(), expectedRevision: read.revision })
    expect(repaired.ok).toBe(true)
    expect(readInChild(file).ok).toBe(true)
  })

  test("real file read failures return only a stable redacted code", () => {
    mkdirSync(file)
    const result = createSettingsAdapter(file).read()
    expect(result).toEqual({ ok: false, code: "read-failed" })
    expect(JSON.stringify(result)).not.toContain(userData)
  })
})

const gcConfig: CasGcSchedulerConfig = {
  casBaseRoot: "/alpha",
  envRoots: ["/alpha/env/dev", "/alpha/env/prod", "/alpha/env/beta"],
  seedLockPaths: ["/app/seed.lock.json"],
  graceMs: 21_600_000,
  dryRun: false,
  initialDelayMs: 300_000,
  intervalMs: 86_400_000,
}

const summary = (overrides: Partial<CasGcRoundSummary> = {}): CasGcRoundSummary => ({
  ok: true,
  dryRun: true,
  marked: 7,
  blobsTotal: 11,
  sweepableCount: 4,
  sweptCount: 0,
  keptByGrace: 2,
  warningCount: 1,
  ...overrides,
})

describe("extension storage typed adapter", () => {
  test("inspect uses dry-run and returns the exact aggregate whitelist", async () => {
    const inputs: CasGcRoundInput[] = []
    const adapter = createExtensionStorageAdapter(gcConfig, (input) => {
      inputs.push(input)
      return Promise.resolve({
        ...summary(),
        digest: "a".repeat(64),
        swept: ["/alpha/cas/v1/sha256/aa/secret"],
        warnings: ["secret warning detail"],
      } as CasGcRoundSummary & { digest: string; swept: string[]; warnings: string[] })
    })
    expect(adapter.snapshot()).toEqual({ state: "not-run", result: null })
    const result = await adapter.inspect()
    expect(inputs).toEqual([
      {
        casBaseRoot: gcConfig.casBaseRoot,
        envRoots: gcConfig.envRoots,
        seedLockPaths: gcConfig.seedLockPaths,
        graceMs: gcConfig.graceMs,
        dryRun: true,
      },
    ])
    expect(Object.keys(result).sort()).toEqual(
      ["code", "blobsTotal", "sweepableCount", "sweptCount", "keptByGrace", "warningCount"].sort(),
    )
    expect(result).toEqual({
      code: "ok",
      blobsTotal: 11,
      sweepableCount: 4,
      sweptCount: 0,
      keptByGrace: 2,
      warningCount: 1,
    })
    expect(JSON.stringify(result)).not.toContain("digest")
    expect(JSON.stringify(result)).not.toContain("/alpha/")
    expect(JSON.stringify(result)).not.toContain("warnings")
    expect(JSON.stringify(result)).not.toContain("marked")
    expect(JSON.stringify(result)).not.toContain("dryRun")
    expect(adapter.snapshot()).toEqual({ state: "ready", result })
  })

  test("collect uses the same worker with dryRun=false and reports only aggregate deletion count", async () => {
    const inputs: CasGcRoundInput[] = []
    const adapter = createExtensionStorageAdapter(gcConfig, (input) => {
      inputs.push(input)
      return Promise.resolve(summary({ dryRun: false, sweptCount: 4 }))
    })
    const result = await adapter.collect()
    expect(inputs[0]?.dryRun).toBe(false)
    expect(result).toEqual({
      code: "ok",
      blobsTotal: 11,
      sweepableCount: 4,
      sweptCount: 4,
      keptByGrace: 2,
      warningCount: 1,
    })
  })

  test("GC reasons map to stable codes without leaking reason, path or secret", async () => {
    const failed = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "seed lock invalid /Users/alice/token-secret" })),
    )
    const failedResult = await failed.inspect()
    expect(failedResult.code).toBe("fail-closed")
    expect(JSON.stringify(failedResult)).not.toContain("/Users/")
    expect(JSON.stringify(failedResult)).not.toContain("token-secret")

    const busy = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "CAS lock busy: held by /home/alice" })),
    )
    expect((await busy.collect()).code).toBe("busy")

    const transactionBusy = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "transaction in flight at /x — GC skipped (mutual exclusion)" })),
    )
    expect((await transactionBusy.collect()).code).toBe("busy")

    const misleadingPath = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "seed identity invalid at /Users/lock busy/root" })),
    )
    expect((await misleadingPath.inspect()).code).toBe("fail-closed")
  })

  test("worker failure returns a stable zeroed result", async () => {
    const adapter = createExtensionStorageAdapter(gcConfig, () =>
      Promise.reject(new Error("worker crashed at /Users/alice token=secret")),
    )
    const result = await adapter.inspect()
    expect(result).toEqual({
      code: "worker-failed",
      blobsTotal: 0,
      sweepableCount: 0,
      sweptCount: 0,
      keptByGrace: 0,
      warningCount: 0,
    })
    expect(JSON.stringify(result)).not.toContain("/Users/")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("snapshot exposes running state and a concurrent trigger gets busy without spawning another round", async () => {
    let finish: ((value: CasGcRoundSummary) => void) | undefined
    let rounds = 0
    const adapter = createExtensionStorageAdapter(gcConfig, () => {
      rounds++
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const inspecting = adapter.inspect()
    expect(adapter.snapshot()).toEqual({ state: "checking", result: null })
    expect((await adapter.collect()).code).toBe("busy")
    expect(rounds).toBe(1)
    finish?.(summary())
    expect((await inspecting).code).toBe("ok")
    expect(adapter.snapshot().state).toBe("ready")
  })
})
