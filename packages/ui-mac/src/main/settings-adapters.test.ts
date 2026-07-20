import { describe, expect, test } from "bun:test"
import type { CasGcRoundInput, CasGcRoundSummary } from "./ext-cas-gc"
import type { CasGcSchedulerConfig } from "./ext-cas-gc-scheduler"
import { createExtensionStorageAdapter, createSettingsAdapter, type SettingsStore } from "./settings-adapters"
import { ALPHA_SETTINGS_DEFAULTS, type AlphaSettings } from "../shared/settings-adapters"
import { RENDERER_SETTINGS_KEY } from "./store-keys"

class MemorySettingsStore implements SettingsStore {
  raw: unknown
  sets = 0
  getError: Error | undefined
  setError: Error | undefined
  writeBeforeError = false

  constructor(raw?: unknown) {
    this.raw = raw
  }

  get(key: string) {
    expect(key).toBe(RENDERER_SETTINGS_KEY)
    if (this.getError) throw this.getError
    return this.raw
  }

  set(key: string, value: string) {
    expect(key).toBe(RENDERER_SETTINGS_KEY)
    this.sets++
    if (this.writeBeforeError) this.raw = value
    if (this.setError) throw this.setError
    this.raw = value
  }
}

const settings = (): AlphaSettings => structuredClone(ALPHA_SETTINGS_DEFAULTS)

describe("Settings typed adapter", () => {
  test("read returns defaults for an empty authority and normalizes the existing partial alpha seed", () => {
    const empty = createSettingsAdapter(new MemorySettingsStore()).read()
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.value).toEqual(ALPHA_SETTINGS_DEFAULTS)

    const seeded = createSettingsAdapter(
      new MemorySettingsStore(JSON.stringify({ general: { newLayoutDesigns: true, showCustomAgents: true } })),
    ).read()
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    expect(seeded.value.general.newLayoutDesigns).toBe(true)
    expect(seeded.value.general.showCustomAgents).toBe(true)
    expect(seeded.value.appearance.fontSize).toBe(14)
  })

  test("validate accepts the complete schema and rejects wrong types, unknown fields and unsafe keybind keys", () => {
    const adapter = createSettingsAdapter(new MemorySettingsStore())
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

  test("save persists a validated value and a new adapter instance reads the restart authority", () => {
    const store = new MemorySettingsStore()
    const first = createSettingsAdapter(store)
    const read = first.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.notifications.errors = true
    const saved = first.write({ value: next, expectedRevision: read.revision })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.changed).toBe(true)
    expect(store.sets).toBe(1)

    const restarted = createSettingsAdapter(store).read()
    expect(restarted.ok).toBe(true)
    if (restarted.ok) {
      expect(restarted.value.notifications.errors).toBe(true)
      expect(restarted.revision).toBe(saved.revision)
    }
  })

  test("an exact repeated submission is idempotent even with the original revision", () => {
    const store = new MemorySettingsStore()
    const adapter = createSettingsAdapter(store)
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
    expect(store.sets).toBe(1)
  })

  test("a stale conflicting submission is refused with the current authoritative value", () => {
    const store = new MemorySettingsStore()
    const adapter = createSettingsAdapter(store)
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
    expect(store.sets).toBe(1)
  })

  test("invalid input never writes", () => {
    const store = new MemorySettingsStore()
    const result = createSettingsAdapter(store).write({
      value: { ...settings(), notifications: { agent: true, permissions: true, errors: "yes" } },
      expectedRevision: "s1:" + "0".repeat(64),
    })
    expect(result).toEqual({ ok: false, code: "invalid-input" })
    expect(store.sets).toBe(0)
  })

  test("a malformed write envelope returns only invalid-input", () => {
    const store = new MemorySettingsStore()
    expect(createSettingsAdapter(store).write(null)).toEqual({ ok: false, code: "invalid-input" })
    expect(
      createSettingsAdapter(store).write({
        value: settings(),
        expectedRevision: "s1:".padEnd(67, "0"),
        secret: "do-not-leak",
      }),
    ).toEqual({ ok: false, code: "invalid-input" })
    expect(store.sets).toBe(0)
  })

  test("write failure returns the prior authority and redacts raw exception, path and secret", () => {
    const store = new MemorySettingsStore()
    const adapter = createSettingsAdapter(store)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    store.setError = new Error("EACCES /Users/alice/.config token=super-secret")
    const next = settings()
    next.general.releaseNotes = false
    const result = adapter.write({ value: next, expectedRevision: read.revision })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("write-failed")
    expect(result.authoritative?.value.general.releaseNotes).toBe(true)
    expect(JSON.stringify(result)).not.toContain("/Users/")
    expect(JSON.stringify(result)).not.toContain("super-secret")
    expect(JSON.stringify(result)).not.toContain("EACCES")
  })

  test("a backend that commits before throwing reconciles to authoritative success", () => {
    const store = new MemorySettingsStore()
    const adapter = createSettingsAdapter(store)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    store.writeBeforeError = true
    store.setError = new Error("late flush error")
    const next = settings()
    next.sounds.agentEnabled = false
    const result = adapter.write({ value: next, expectedRevision: read.revision })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sounds.agentEnabled).toBe(false)
  })

  test("an invalid authority can be repaired only with the revision returned by read", () => {
    const store = new MemorySettingsStore('{"general":{"showSearch":"/Users/alice/secret"}}')
    const adapter = createSettingsAdapter(store)
    const read = adapter.read()
    expect(read.ok).toBe(false)
    if (read.ok || read.code !== "authority-invalid") return
    expect(JSON.stringify(read)).not.toContain("/Users/")
    const repaired = adapter.write({ value: settings(), expectedRevision: read.revision })
    expect(repaired.ok).toBe(true)
    expect(createSettingsAdapter(store).read().ok).toBe(true)
  })

  test("read exceptions return only a stable redacted code", () => {
    const store = new MemorySettingsStore()
    store.getError = new Error("broken /home/alice/settings token=hunter2")
    const result = createSettingsAdapter(store).read()
    expect(result).toEqual({ ok: false, code: "read-failed" })
    expect(JSON.stringify(result)).not.toContain("/home/")
    expect(JSON.stringify(result)).not.toContain("hunter2")
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
